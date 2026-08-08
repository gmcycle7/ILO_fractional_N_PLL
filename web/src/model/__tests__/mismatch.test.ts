/**
 * Acceptance Tests 6, 7: 1-degree tap mismatch (222.22 fs) and 1% DTC gain
 * mismatch (200 fs) at T_vco = 80 ps.  Mirror of tests/test_mismatch.py.
 */

import { describe, expect, it } from 'vitest';
import { fromPartial } from '../config';
import { DTCModel } from '../dtcModel';
import { cyclesToTime } from '../phaseMath';
import { Mulberry32 } from '../rng';
import { simulate } from '../simulate';
import { tapActual } from '../tapModel';

const T_VCO = 80e-12; // N = 3.125
const HALF_LSB_FS = 156.25;

describe('tap and DTC mismatch (Tests 6, 7)', () => {
  it('1 deg tap mismatch = 222.22 fs = 0.711 LSB > half-LSB', () => {
    // 1 deg = 80 ps / 360 = 222.22... fs ~= 0.711 LSB
    const errS = cyclesToTime(1.0 / 360.0, T_VCO);
    expect(Math.abs(errS / 1e-15 - 222.2222222222) / 222.2222222222).toBeLessThan(1e-9);
    // tap model places tap j at j/8 + delta
    const deltas = new Array<number>(8).fill(1.0 / 360.0);
    expect(tapActual(3, 8, deltas)).toBeCloseTo(3 / 8 + 1 / 360.0, 15);
    // larger than half-LSB (156.25 fs)  [INFERENCE in spec]
    expect(errS / 1e-15).toBeGreaterThan(HALF_LSB_FS);
    expect(Math.abs(errS / 1e-15 / 312.5 - 0.7111111)).toBeLessThan(1e-4); // LSB
  });

  it('1 deg tap mismatch in simulation: static 222.22 fs e_ZC_hw', () => {
    const cfg = fromPartial({
      n_div: 3.125,
      tap_mismatch_cycles: new Array<number>(8).fill(1.0 / 360.0),
    });
    const res = simulate(cfg);
    for (const v of res.data.e_ZC_hw) {
      const fs = (v * res.t_vco_s) / 1e-15;
      // on-grid N: only the static tap offset remains
      expect(Math.abs(fs - 222.2222222222)).toBeLessThan(1e-6);
    }
  });

  it('1% DTC gain over 20 ps full range = 200 fs = 0.64 LSB', () => {
    // DTC full range = T_vco/4 = 20 ps; 1% gain error -> max 200 fs
    const fullRange = T_VCO / 4;
    expect(fullRange).toBeCloseTo(20e-12, 20);
    const maxErrS = 0.01 * fullRange;
    expect(Math.abs(maxErrS / 1e-15 - 200.0) / 200.0).toBeLessThan(1e-12);
    expect(maxErrS / 1e-15).toBeGreaterThan(HALF_LSB_FS);
    expect(Math.abs(maxErrS / 1e-15 / 312.5 - 0.64)).toBeLessThan(1e-12); // LSB
  });

  it('1% gain DTC model per-code error grows linearly', () => {
    const dtc = new DTCModel({ nCodes: 64, lsbCycles: 1 / 256, gain: 1.01 });
    const err0 = dtc.table[0] - 0 / 256;
    const err63 = dtc.table[63] - 63 / 256;
    expect(err0).toBe(0.0);
    expect(Math.abs(err63 - (0.01 * 63) / 256)).toBeLessThan(1e-15);
    // at c=63: 0.01*63/256 cycles = 196.875 fs
    expect(Math.abs(cyclesToTime(err63, T_VCO) / 1e-15 - 196.875)).toBeLessThan(1e-6);
  });

  it('gain mismatch in simulation is code-dependent and bounded by 200 fs', () => {
    // N=3.13 exercises the full injection DTC code range
    const cfg = fromPartial({ n_div: 3.13, dtc_fb_gain: 1.0, dtc_inj_gain: 1.01 });
    const res = simulate(cfg);
    let maxFs = 0;
    for (const v of res.data.e_pair_analog) {
      maxFs = Math.max(maxFs, (Math.abs(v) * res.t_vco_s) / 1e-15);
    }
    expect(maxFs).toBeLessThanOrEqual(200.0 + 1e-6);
    expect(maxFs).toBeGreaterThan(0.0);
    let anyNonzeroAtNonzeroCode = false;
    for (let k = 0; k < res.data.k.length; k++) {
      if (res.data.c_INJ[k] > 0 && Math.abs(res.data.e_pair_analog[k]) > 0.0) {
        anyNonzeroAtNonzeroCode = true;
      }
    }
    expect(anyNonzeroAtNonzeroCode).toBe(true);
  });

  it('DNL is frozen per instance (same stream seed -> same table)', () => {
    const a = new DTCModel({
      nCodes: 64,
      lsbCycles: 1 / 256,
      dnlSigmaLsb: 0.1,
      dnlStream: new Mulberry32(42),
    });
    const b = new DTCModel({
      nCodes: 64,
      lsbCycles: 1 / 256,
      dnlSigmaLsb: 0.1,
      dnlStream: new Mulberry32(42),
    });
    expect(Array.from(a.table)).toEqual(Array.from(b.table));
    expect(a.dnlCumLsb[0]).toBe(0.0);
    expect(a.dnlCumLsb.some((v) => v !== 0.0)).toBe(true);
  });
});
