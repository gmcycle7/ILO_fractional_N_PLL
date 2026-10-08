/**
 * Redundancy-based dynamic element matching (DEM) for the injection tap/DTC
 * mapping: inj_mapping='redundant_random' (MODEL_SPEC section 8 item 4,
 * acceptance test 20; experiment exp24).  Mirror of
 * tests/test_redundant_dem.py.
 *
 * Tap spacing is 32 LSB and the injection DTC spans 64 LSB, so every R_INJ
 * has two phase-equivalent representations:
 *     naive       (j0, c0)             = (floor(R/32), R mod 32)
 *     alternative ((j0 - 1) mod 8, c0 + 32)
 * 'redundant_random' draws ONE uniform per cycle from the 'map_inj' stream
 * (offset 11) and picks the alternative iff u < map_rand_p.
 */

import { describe, expect, it } from 'vitest';
import type { ArchMode, Quantizer, SimConfig } from '../config';
import { fromPartial, replaceConfig } from '../config';
import { makeDtc } from '../dtcModel';
import { PRESETS, presetConfigs } from '../experiments';
import { runInjection } from '../injectionScheduler';
import { detectSpurs, mean, periodogramPsd, rms } from '../measurements';
import { Mulberry32, makeAllStreams } from '../rng';
import type { ColumnName } from '../simulate';
import { simulate } from '../simulate';
import { tapTable } from '../tapModel';

const NS = [3.0, 3.005, 3.125, 3.13, 3.2, 3.22265625, 3.249];
const PS = [0.0, 0.25, 0.5, 0.75, 1.0];

// exp24 mismatch (fixed literal list, cycles) + 1% injection DTC gain
const TAP = [0.0032, -0.0027, 0.0011, -0.0038, 0.003, -0.0013, 0.0035, -0.0024];
const MISMATCH: Partial<SimConfig> = { tap_mismatch_cycles: TAP, dtc_inj_gain: 1.01 };

// columns that only depend on the digital command words
const DIGITAL_COLS: ColumnName[] = [
  'A_FB',
  'R_FB',
  'm_FB',
  'c_FB',
  'n_int',
  'R_INJ',
  'u_FB_digital',
  'u_INJ_digital',
  'e_FB_abs',
  'e_INJ_abs',
  'e_pair_digital',
];

function dem(p: number, kw: Partial<SimConfig> = {}): SimConfig {
  return fromPartial({ ...kw, inj_mapping: 'redundant_random', map_rand_p: p });
}

function naive(kw: Partial<SimConfig> = {}): SimConfig {
  return fromPartial({ ...kw, inj_mapping: 'naive' });
}

function sameArray(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function countAlt(c: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < c.length; i++) {
    if (c[i] >= 32) n += 1;
  }
  return n;
}

describe('redundant_random mapping: phase equivalence', () => {
  it('ideal analog: u_INJ_digital and e_ZC_hw identical to naive for any p', () => {
    for (const nDiv of NS) {
      const a = simulate(naive({ n_div: nDiv })).data;
      for (const p of PS) {
        const b = simulate(dem(p, { n_div: nDiv })).data;
        expect(sameArray(a.u_INJ_digital, b.u_INJ_digital), `u_INJ_digital N=${nDiv} p=${p}`).toBe(
          true,
        );
        expect(sameArray(a.e_ZC_hw, b.e_ZC_hw), `e_ZC_hw N=${nDiv} p=${p}`).toBe(true);
        expect(sameArray(a.e_pair_analog, b.e_pair_analog)).toBe(true);
        for (const col of DIGITAL_COLS) {
          expect(sameArray(a[col], b[col]), `${col} N=${nDiv} p=${p}`).toBe(true);
        }
        // the analog command differs at most by a whole cycle (tap 0 -> tap 7)
        for (let k = 0; k < a.k.length; k++) {
          const d = b.u_INJ_analog[k] - a.u_INJ_analog[k];
          if (!(d === 0.0 || d === 1.0)) {
            expect.fail(`u_INJ_analog diff ${d} at N=${nDiv} p=${p} k=${k}`);
          }
        }
        // the DEM really switches representation: the alternative (c >= 32)
        // is taken on some cycles iff p > 0, and the naive one on some iff p < 1
        const nAlt = countAlt(b.c_INJ);
        expect(nAlt > 0, `alternative taken N=${nDiv} p=${p}`).toBe(p > 0);
        expect(nAlt < b.k.length, `naive taken N=${nDiv} p=${p}`).toBe(p < 1);
      }
    }
  });

  it('all arch modes: the digital layer never sees the DEM choice', () => {
    const cases: [ArchMode, Quantizer][] = [
      ['A', 'nearest'],
      ['B', 'ef1'],
      ['C', 'mash11'],
      ['D', 'mash111'],
    ];
    for (const [arch, quant] of cases) {
      const kw: Partial<SimConfig> = { n_div: 3.13, arch_mode: arch, quantizer: quant, ...MISMATCH };
      const a = simulate(naive(kw)).data;
      const b = simulate(dem(0.5, kw)).data;
      for (const col of DIGITAL_COLS) {
        expect(sameArray(a[col], b[col]), `${col} mode ${arch}`).toBe(true);
      }
      for (let k = 0; k < b.k.length; k++) {
        if ((32 * b.j_INJ[k] + b.c_INJ[k]) % 256 !== b.R_INJ[k]) {
          expect.fail(`mode ${arch} k=${k}: (32j+c) mod 256 != R_INJ`);
        }
      }
      // ... but the analog layer does (mismatch makes the two differ)
      expect(sameArray(a.e_ZC_hw, b.e_ZC_hw)).toBe(false);
    }
  });

  it('qnc decodes as usual; dsm_only has no decode', () => {
    const qnc: Partial<SimConfig> = { n_div: 3.13, actuator_mode: 'qnc' };
    const a = simulate(naive(qnc)).data;
    const b = simulate(dem(0.5, qnc)).data;
    expect(sameArray(a.u_INJ_digital, b.u_INJ_digital)).toBe(true);
    expect(sameArray(a.e_ZC_hw, b.e_ZC_hw)).toBe(true);
    expect(countAlt(b.c_INJ)).toBeGreaterThan(0);

    const dsm: Partial<SimConfig> = { n_div: 3.13, actuator_mode: 'dsm_only', quantizer: 'ef1' };
    const c = simulate(naive(dsm)).data;
    const d = simulate(dem(1.0, dsm)).data;
    expect(d.j_INJ.every((v) => v === 0)).toBe(true);
    expect(d.c_INJ.every((v) => v === 0)).toBe(true);
    expect(sameArray(c.e_ZC_hw, d.e_ZC_hw)).toBe(true);
  });
});

describe('redundant_random mapping: p = 0 / p = 1 limits and legality', () => {
  it('p = 0 reproduces naive exactly (every column, with mismatch)', () => {
    for (const nDiv of NS) {
      const a = simulate(naive({ n_div: nDiv, ...MISMATCH }));
      const b = simulate(dem(0.0, { n_div: nDiv, ...MISMATCH }));
      for (const col of a.columns) {
        expect(sameArray(a.data[col], b.data[col]), `${col} N=${nDiv}`).toBe(true);
      }
    }
  });

  it('p = 1 always picks the alternative (j0-1 mod 8, c0+32)', () => {
    for (const nDiv of NS) {
      const a = simulate(naive({ n_div: nDiv })).data;
      const b = simulate(dem(1.0, { n_div: nDiv })).data;
      for (let k = 0; k < a.k.length; k++) {
        const jAlt = (a.j_INJ[k] + 7) % 8;
        if (b.j_INJ[k] !== jAlt || b.c_INJ[k] !== a.c_INJ[k] + 32) {
          expect.fail(`N=${nDiv} k=${k}: (${b.j_INJ[k]}, ${b.c_INJ[k]}) is not the alternative`);
        }
        if (b.c_INJ[k] < 32 || b.c_INJ[k] > 63) {
          expect.fail(`N=${nDiv} k=${k}: c=${b.c_INJ[k]} outside 32..63`);
        }
      }
    }
  });

  it('codes always legal (j in 0..7, c in 0..63) over the N sweep', () => {
    const quants: Quantizer[] = ['nearest', 'floor', 'ef1', 'mash11', 'mash111'];
    for (const quant of quants) {
      for (let i = 0; i <= 50; i++) {
        const nDiv = 3.0 + 0.005 * i;
        for (const p of [0.0, 0.5, 1.0]) {
          const d = simulate(dem(p, { n_div: nDiv, quantizer: quant })).data;
          for (let k = 0; k < d.k.length; k++) {
            const j = d.j_INJ[k];
            const c = d.c_INJ[k];
            if (!(j >= 0 && j <= 7 && c >= 0 && c <= 63 && (32 * j + c) % 256 === d.R_INJ[k])) {
              expect.fail(`${quant} N=${nDiv} p=${p} k=${k}: illegal (j, c) = (${j}, ${c})`);
            }
          }
        }
      }
    }
  });
});

describe("redundant_random mapping: 'map_inj' PRNG contract", () => {
  it("cycle k picks the alternative iff the k-th 'map_inj' draw < map_rand_p", () => {
    const cases: [number, number][] = [
      [12345, 0.5],
      [777, 0.25],
      [1, 0.9],
    ];
    for (const [seed, p] of cases) {
      const d = simulate(dem(p, { n_div: 3.13, seed })).data;
      const rng = new Mulberry32(seed + 11);
      for (let k = 0; k < d.k.length; k++) {
        const expectAlt = rng.next() < p;
        if (d.c_INJ[k] >= 32 !== expectAlt) {
          expect.fail(`seed ${seed} p=${p} k=${k}: choice does not follow the stream`);
        }
      }
    }
    // p = 0.5, seed 12345, 512 cycles: both representations are used
    const d = simulate(dem(0.5, { n_div: 3.13 })).data;
    expect(countAlt(d.c_INJ)).toBe(266); // measured; 52% of 512
  });

  it('is deterministic and seed-dependent', () => {
    const cfg = dem(0.5, { n_div: 3.13, ...MISMATCH });
    const a = simulate(cfg);
    const b = simulate(cfg);
    for (const col of a.columns) {
      expect(sameArray(a.data[col], b.data[col]), col).toBe(true);
    }
    // a different base seed changes the DEM choice sequence
    const c = simulate(replaceConfig(cfg, { seed: 54321 }));
    expect(sameArray(a.data.c_INJ, c.data.c_INJ)).toBe(false);
    expect(sameArray(a.data.R_INJ, c.data.R_INJ)).toBe(true);
  });

  it('consumes exactly one draw per cycle, also for p = 0 and p = 1', () => {
    for (const p of [0.0, 0.5, 1.0]) {
      const cfg = dem(p, { n_div: 3.13, n_cycles: 100 });
      const streams = makeAllStreams(cfg.seed);
      const dtcInj = makeDtc(cfg, 'inj', streams);
      const x = new Float64Array(cfg.n_cycles);
      const rFb = new Float64Array(cfg.n_cycles);
      for (let k = 0; k < cfg.n_cycles; k++) {
        x[k] = (k * cfg.n_div) % 1.0;
        rFb[k] = (k * 57) % 256;
      }
      runInjection(
        cfg,
        x,
        rFb,
        dtcInj,
        tapTable(cfg.n_tap),
        streams.dither_inj,
        streams.dsm_inj,
        streams.map_inj,
      );
      const ref = new Mulberry32(cfg.seed + 11);
      for (let k = 0; k < cfg.n_cycles; k++) {
        ref.next();
      }
      expect(streams.map_inj.next()).toBe(ref.next());
      // no other stream is touched by the mapping
      expect(streams.dsm_inj.next()).toBe(new Mulberry32(cfg.seed + 10).next());
      expect(streams.dither_inj.next()).toBe(new Mulberry32(cfg.seed + 5).next());
    }
  });

  it("runInjection without mapStream builds 'map_inj' from cfg.seed", () => {
    const cfg = dem(0.5, { n_div: 3.13, n_cycles: 64 });
    const streams = makeAllStreams(cfg.seed);
    const dtcInj = makeDtc(cfg, 'inj', streams);
    const x = new Float64Array(cfg.n_cycles);
    const rFb = new Float64Array(cfg.n_cycles);
    for (let k = 0; k < cfg.n_cycles; k++) {
      x[k] = (k * cfg.n_div) % 1.0;
      rFb[k] = (k * 57) % 256;
    }
    const a = runInjection(cfg, x, rFb, dtcInj, tapTable(cfg.n_tap));
    const b = runInjection(
      cfg,
      x,
      rFb,
      dtcInj,
      tapTable(cfg.n_tap),
      null,
      null,
      new Mulberry32(cfg.seed + 11),
    );
    expect(sameArray(a.j_INJ, b.j_INJ)).toBe(true);
    expect(sameArray(a.c_INJ, b.c_INJ)).toBe(true);
  });
});

describe('redundant_random mapping: config', () => {
  it('validates map_rand_p and the redundancy requirement', () => {
    expect(fromPartial().map_rand_p).toBe(0.5);
    expect(() => fromPartial({ map_rand_p: -0.1 })).toThrow();
    expect(() => fromPartial({ map_rand_p: 1.5 })).toThrow();
    expect(() => fromPartial({ map_rand_p: Number.NaN })).toThrow();
    // 4 taps -> tap step 64 LSB: the 64-LSB DTC cannot hold c0 + 64
    expect(() =>
      fromPartial({
        inj_mapping: 'redundant_random',
        n_tap: 4,
        tap_mismatch_cycles: [0, 0, 0, 0],
      }),
    ).toThrow();
    expect(dem(0.25).map_rand_p).toBe(0.25);
  });
});

// --- exp24: measured numbers quoted in expected_result ----------------------

interface Exp24Metrics {
  rmsFs: number;
  peakFs: number;
  meanFs: number;
  acRmsFs: number;
  nSpurs: number;
  topF: number;
  topDb: number;
  floorDb: number;
  l437: number;
  l875: number;
  l890: number;
  nAlt: number;
  maxEFb: number;
}

function exp24Metrics(cfg: SimConfig): Exp24Metrics {
  const res = simulate(cfg);
  const e = res.data.e_ZC_hw;
  const fsPerCycle = res.t_vco_s / 1e-15;
  const phi = new Float64Array(e.length);
  let peak = 0.0;
  for (let k = 0; k < e.length; k++) {
    phi[k] = 2.0 * Math.PI * e[k];
    peak = Math.max(peak, Math.abs(e[k]));
  }
  const { freqsHz, psd } = periodogramPsd(phi, cfg.f_ref_hz);
  const pDb = Array.from(psd, (v) => 10.0 * Math.log10(Math.max(v, Number.MIN_VALUE)));
  const sorted = [...pDb].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  const floorDb = sorted.length % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
  // the periodic cases (a)/(c) have a numerically-zero median floor, so
  // detectSpurs may also return FFT round-off peaks (below -400 dB, FFT
  // implementation dependent); real spurs are counted above -200 dB
  const spurs = detectSpurs(freqsHz, psd).filter((s) => s.psdDb > -200.0);
  const df = freqsHz[1] - freqsHz[0];
  const level = (fHz: number): number => pDb[Math.floor(fHz / df + 0.5)];
  const m = mean(e);
  let acc = 0.0;
  let maxEFb = 0.0;
  for (let k = 0; k < e.length; k++) {
    acc += (e[k] - m) * (e[k] - m);
    maxEFb = Math.max(maxEFb, Math.abs(res.data.e_FB_abs[k]));
  }
  return {
    rmsFs: rms(e) * fsPerCycle,
    peakFs: peak * fsPerCycle,
    meanFs: m * fsPerCycle,
    acRmsFs: Math.sqrt(acc / e.length) * fsPerCycle,
    nSpurs: spurs.length,
    topF: spurs[0].freqHz,
    topDb: spurs[0].psdDb,
    floorDb,
    l437: level(437.5e6),
    l875: level(875e6),
    l890: level(890.625e6),
    nAlt: countAlt(res.data.c_INJ),
    maxEFb,
  };
}

function near(got: number, want: number, tol: number = 0.05): void {
  expect(Math.abs(got - want), `got ${got}, want ${want} +- ${tol}`).toBeLessThanOrEqual(tol);
}

describe('exp24: naive vs redundant_random vs calibrated (measured)', () => {
  it('reproduces the numbers written in expected_result', () => {
    const cfgs = presetConfigs(PRESETS.exp24);
    expect(cfgs.map((c) => c.inj_mapping)).toEqual(['naive', 'redundant_random', 'calibrated']);
    for (const c of cfgs) {
      expect(c.n_div).toBe(3.22265625);
      expect(c.n_cycles).toBe(2048);
      expect((c.n_div - 3.0) * 256.0).toBe(57.0); // on-grid: alpha*G = 57
      expect(c.tap_mismatch_cycles).toEqual(TAP);
      expect(c.dtc_inj_gain).toBe(1.01);
    }
    const tapRmsDeg = 360.0 * Math.sqrt(TAP.reduce((s, t) => s + t * t, 0) / 8.0);
    near(tapRmsDeg, 1.0012, 1e-4);

    const [a, b, c] = cfgs.map(exp24Metrics);
    // quantization error identically zero -> e_ZC_hw is pure mismatch error
    expect(a.maxEFb).toBe(0.0);
    expect(b.maxEFb).toBe(0.0);

    // (a) naive: purely periodic (period 256) -> all 127 harmonics, no floor
    near(a.rmsFs, 223.8);
    near(a.peakFs, 365.45);
    near(a.meanFs, 52.79);
    near(a.acRmsFs, 217.48);
    expect(a.nSpurs).toBe(127);
    expect(a.topF).toBe(437.5e6);
    near(a.topDb, -101.23);
    near(a.l890, -111.14);
    near(a.l875, -119.71);
    expect(a.floorDb).toBeLessThan(-400.0); // numerical zero

    // (b) DEM p=0.5: spurs -> floor, but rms and peak get LARGER
    expect(b.nAlt).toBe(1084);
    near(b.rmsFs, 246.14);
    near(b.peakFs, 462.42);
    near(b.meanFs, 105.28);
    near(b.acRmsFs, 222.49);
    expect(b.rmsFs).toBeGreaterThan(a.rmsFs);
    expect(b.peakFs).toBeGreaterThan(a.peakFs);
    expect(b.nSpurs).toBe(2);
    expect(b.topF).toBe(890.625e6);
    near(b.topDb, -111.0);
    near(b.l437, -126.37);
    near(b.l875, -118.66);
    near(b.floorDb, -129.86);
    // strongest-spur reduction 9.8 dB; the fundamental itself is NOT reduced
    near(a.topDb - b.topDb, 9.77);
    expect(Math.abs(b.l890 - a.l890)).toBeLessThan(0.5);
    near(b.topDb - b.floorDb, 18.86);

    // (c) calibrated: smaller error, still periodic (no floor)
    near(c.rmsFs, 60.28);
    near(c.peakFs, 124.0);
    near(c.meanFs, 3.57);
    expect(c.nSpurs).toBe(127);
    expect(c.topF).toBe(437.5e6);
    near(c.topDb, -116.27);
    near(c.l890, -124.54);
    near(a.topDb - c.topDb, 15.04);
    expect(c.floorDb).toBeLessThan(-400.0);
  });

  it('exp24 strings and configs match the Python preset (spot check)', () => {
    const e = PRESETS.exp24;
    expect(e.name_en).toBe('Redundancy DEM: naive vs redundant_random vs calibrated');
    expect(e.expected_result.startsWith('All measured on e_ZC_hw, 2048 cycles, seed 12345')).toBe(
      true,
    );
    expect(e.expected_result.endsWith('but it requires knowing the mismatch.')).toBe(true);
    expect(presetConfigs(e)[1].map_rand_p).toBe(0.5);
  });
});
