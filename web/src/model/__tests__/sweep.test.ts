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
    // DSM quantizers: {2,3,4}; 2 only for alpha < ~3/256, 5 unreachable
    // for N in [3, 3.25] (MODEL_SPEC section 4); measured set for mash111
    // is also {2,3,4} — NOT wider than mash11
    ['ef1', new Set([2, 3, 4])],
    ['mash11', new Set([2, 3, 4])],
    ['mash111', new Set([2, 3, 4])],
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

describe('N sweep legality, dsm_only actuator (section 7.1)', () => {
  // measured (mirror of tests/test_sweep.py): nearest/floor {3,4};
  // ef1 {2,3,4,5}.  mash11/mash111 violate divider legality at N=3.13
  // (instantaneous ratio 0 -> duplicate edge) and must throw.
  const cases: Array<[Quantizer, Set<number>]> = [
    ['nearest', new Set([3, 4])],
    ['floor', new Set([3, 4])],
    ['ef1', new Set([2, 3, 4, 5])],
  ];
  for (const [quant, allowed] of cases) {
    it(`dsm_only quantizer '${quant}' stays legal over N in [3, 3.25]`, () => {
      for (const nDiv of NS) {
        const res = simulate(
          fromPartial({
            n_div: nDiv,
            quantizer: quant,
            n_cycles: 512,
            actuator_mode: 'dsm_only',
          }),
        );
        const d = res.data;
        for (let k = 1; k < d.k.length; k++) {
          expect(d.A_FB[k] - d.A_FB[k - 1]).toBeGreaterThan(0);
        }
        for (let k = 0; k < d.k.length; k++) {
          expect(d.A_FB[k] % 256).toBe(0); // whole cycles only
          expect(d.R_FB[k]).toBe(0);
          expect(d.R_INJ[k]).toBe(0);
        }
        for (let k = 0; k < d.k.length - 1; k++) {
          expect(allowed.has(d.n_int[k])).toBe(true);
        }
      }
    });
  }

  for (const quant of ['mash11', 'mash111'] as Quantizer[]) {
    it(`dsm_only '${quant}' at N=3.13 throws (duplicate edge, documented)`, () => {
      expect(() =>
        simulate(
          fromPartial({
            n_div: 3.13,
            quantizer: quant,
            n_cycles: 512,
            actuator_mode: 'dsm_only',
          }),
        ),
      ).toThrow(/monotonic/);
    });
  }
});
