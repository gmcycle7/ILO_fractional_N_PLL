/**
 * Preset catalogue invariants (MODEL_SPEC §1 preset table).
 *
 * The period P quoted in every hint is the period of the feedback quantization
 * error sequence at the DTC grid. Rather than trusting the closed form
 * (α = p/q reduced, P = q / gcd(q, G)), this test re-derives P numerically from
 * the MODEL_SPEC §3/§4 definitions and checks it against the documented value.
 */

import { describe, expect, it } from 'vitest';
import {
  N_DIV_ALL_PRESETS,
  N_DIV_MAX,
  N_DIV_MIN,
  N_DIV_PRESETS,
  N_DIV_PRESET_GROUPS,
  findNDivPreset,
} from './globalParams';

const G = 256;

/** MODEL_SPEC §2: half-up, never the language built-in. */
const qNearest = (x: number) => Math.floor(x + 0.5);
const wrapCycles = (x: number) => {
  const y = x - Math.floor(x);
  return y > 0.5 ? y - 1 : y;
};

/** e_FB_abs[k] in LSB units, from s_ideal[k] = k*N computed by multiplication. */
function errorSeq(n: number, k: number): number[] {
  const out = new Array<number>(k);
  for (let i = 0; i < k; i += 1) {
    const s = i * n;
    out[i] = wrapCycles(qNearest(G * s) / G - s) * G;
  }
  return out;
}

/** Smallest P such that e[i] === e[i+P] for all sampled i, or null if none. */
function errorPeriod(seq: number[], tol = 1e-6): number | null {
  const n = seq.length;
  for (let p = 1; p <= Math.floor(n / 3); p += 1) {
    let ok = true;
    for (let i = 0; i + p < n; i += 1) {
      if (Math.abs(seq[i] - seq[i + p]) > tol) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
  }
  return null;
}

/** [N, expected P at the DTC grid (null = aperiodic within the window)]. */
const EXPECTED_PERIOD: Array<[number, number | null]> = [
  [3.0, 1],
  [3.125, 1],
  [3.13, 25],
  [3.1375, 5],
  [3.25, 1],
  [3.126953125, 2],
  [3.1259765625, 4],
  [3.125390625, 10],
  [3.1250390625, 100],
  [3.2, 5],
  [3.22265625, 1],
  [3.001, 125],
  [3.1545084971874737, null],
];

describe('N preset catalogue', () => {
  it('group 0 (基本) mirrors the flat N_DIV_PRESETS export exactly', () => {
    expect(N_DIV_PRESET_GROUPS[0].label).toBe('基本');
    expect(N_DIV_PRESET_GROUPS[0].values.map((p) => p.n)).toEqual(N_DIV_PRESETS);
    // labels must stay byte-identical to what the TopBar buttons rendered before.
    expect(N_DIV_PRESET_GROUPS[0].values.map((p) => p.label)).toEqual(N_DIV_PRESETS.map(String));
  });

  it('has the three documented groups', () => {
    expect(N_DIV_PRESET_GROUPS.map((g) => g.label)).toEqual(['基本', 'sub-LSB 階梯', '特殊']);
    expect(N_DIV_ALL_PRESETS).toHaveLength(13);
  });

  it('pins the exact float64 preset values', () => {
    expect(N_DIV_ALL_PRESETS.map((p) => p.n)).toEqual([
      3.0, 3.125, 3.13, 3.1375, 3.25, 3.126953125, 3.1259765625, 3.125390625, 3.1250390625, 3.2,
      3.22265625, 3.001, 3.1545084971874737,
    ]);
  });

  it('F8 is the float64 nearest double to 3 + 0.25/φ', () => {
    const phi = (1 + Math.sqrt(5)) / 2;
    expect(findNDivPreset(3.1545084971874737)?.n).toBe(3 + 0.25 / phi);
  });

  it('every preset is unique, in range, and has a non-empty hint', () => {
    const ns = N_DIV_ALL_PRESETS.map((p) => p.n);
    expect(new Set(ns).size).toBe(ns.length);
    const labels = N_DIV_ALL_PRESETS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const p of N_DIV_ALL_PRESETS) {
      expect(p.n).toBeGreaterThanOrEqual(N_DIV_MIN);
      expect(p.n).toBeLessThanOrEqual(N_DIV_MAX);
      expect(p.hint.length).toBeGreaterThan(0);
      expect(findNDivPreset(p.n)).toBe(p);
    }
  });

  it('the documented period P matches the simulated quantization-error period', () => {
    expect(EXPECTED_PERIOD.map(([n]) => n)).toEqual(N_DIV_ALL_PRESETS.map((p) => p.n));
    for (const [n, expected] of EXPECTED_PERIOD) {
      expect(errorPeriod(errorSeq(n, 1200))).toBe(expected);
    }
  });

  it('on-grid presets (P = 1) have identically zero feedback error', () => {
    for (const n of [3.0, 3.125, 3.25, 3.22265625]) {
      expect(Math.max(...errorSeq(n, 512).map(Math.abs))).toBe(0);
    }
  });

  it('F1 is an exact half-LSB tie broken upward by qNearest', () => {
    // α·G = 32.5 exactly ⇒ odd k lands on x.5 and half-up rounding pushes it up.
    expect((3.126953125 - 3) * G).toBe(32.5);
    const e = errorSeq(3.126953125, 8);
    expect(e.map((v) => Number(v.toFixed(6)))).toEqual([0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5]);
  });
});
