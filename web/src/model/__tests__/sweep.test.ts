/**
 * Acceptance Test 8: N sweep 3.00 .. 3.25 step 0.005 — monotonic edges,
 * legal codes, legal n_integer.  Mirror of tests/test_sweep.py.
 */

import { describe, expect, it } from 'vitest';
import type { Quantizer } from '../config';
import { fromPartial } from '../config';
import type { SimResult } from '../simulate';
import { simulate } from '../simulate';

const NS: number[] = [];
for (let i = 0; i < 51; i++) {
  NS.push(3.0 + 0.005 * i); // 3.000 .. 3.250
}

function check(res: SimResult, allowedNint: Set<number>): void {
  const d = res.data;
  const n = d.k.length;
  for (let k = 1; k < n; k++) {
    expect(d.A_FB[k] - d.A_FB[k - 1]).toBeGreaterThan(0); // monotonic edges
  }
  for (let k = 0; k < n; k++) {
    expect(d.R_FB[k]).toBeGreaterThanOrEqual(0);
    expect(d.R_FB[k]).toBeLessThan(256);
    expect(d.m_FB[k]).toBeGreaterThanOrEqual(0);
    expect(d.m_FB[k]).toBeLessThan(4);
    expect(d.c_FB[k]).toBeGreaterThanOrEqual(0);
    expect(d.c_FB[k]).toBeLessThan(64);
    expect(d.R_INJ[k]).toBeGreaterThanOrEqual(0);
    expect(d.R_INJ[k]).toBeLessThan(256);
    expect(d.j_INJ[k]).toBeGreaterThanOrEqual(0);
    expect(d.j_INJ[k]).toBeLessThan(8);
    expect(d.c_INJ[k]).toBeGreaterThanOrEqual(0);
    expect(d.c_INJ[k]).toBeLessThan(64);
  }
  for (let k = 0; k < n - 1; k++) {
    // last entry is padding
    expect(allowedNint.has(d.n_int[k])).toBe(true);
  }
}

describe('N sweep legality (Test 8)', () => {
  const cases: Array<[Quantizer, Set<number>]> = [
    ['nearest', new Set([3, 4])],
    ['floor', new Set([3, 4])],
    ['ef1', new Set([2, 3, 4, 5])],
    ['mash11', new Set([2, 3, 4, 5])],
  ];
  for (const [quant, allowed] of cases) {
    it(`quantizer '${quant}' stays legal over N in [3, 3.25]`, () => {
      for (const nDiv of NS) {
        const res = simulate(fromPartial({ n_div: nDiv, quantizer: quant, n_cycles: 512 }));
        check(res, allowed);
      }
    });
  }
});
