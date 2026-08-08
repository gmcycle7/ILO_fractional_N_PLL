/**
 * Acceptance Tests 2, 3, 13: mode D modular-reverse identity, the u=0.337
 * canonical example, and shared vs independent pair-error behavior.
 * Mirror of tests/test_mode_d_identity.py.
 */

import { describe, expect, it } from 'vitest';
import type { Quantizer } from '../config';
import { fromPartial } from '../config';
import { pymod, qNearest, wrap01, wrapCycles } from '../phaseMath';
import { simulate } from '../simulate';

const ALL_QUANTIZERS: Quantizer[] = ['floor', 'nearest', 'truncate', 'ef1', 'mash11'];

describe('mode D identity (Tests 2, 13)', () => {
  for (const quant of ALL_QUANTIZERS) {
    it(`R_INJ = (-R_FB) mod 256 and e_pair_digital == 0 for quantizer '${quant}'`, () => {
      const res = simulate(fromPartial({ n_div: 3.13, quantizer: quant, arch_mode: 'D' }));
      const d = res.data;
      const n = d.k.length;
      for (let k = 0; k < n; k++) {
        expect(d.R_INJ[k]).toBe(pymod(-d.R_FB[k], 256));
        expect(pymod(d.R_FB[k] + d.R_INJ[k], 256)).toBe(0);
        // exact zero, not approx
        expect(d.e_pair_digital[k]).toBe(0.0);
      }
    });
  }

  it('mode B (independent DSMs) breaks the cycle-by-cycle reverse relation', () => {
    const res = simulate(fromPartial({ n_div: 3.13, quantizer: 'ef1', arch_mode: 'B' }));
    let maxAbs = 0;
    for (const v of res.data.e_pair_digital) {
      maxAbs = Math.max(maxAbs, Math.abs(v));
    }
    expect(maxAbs).toBeGreaterThan(0.0);
  });
});

describe('u = 0.337 canonical example (Test 3, spec section 9)', () => {
  it('standalone: R_FB 86 / R_INJ 170, -/+85 fs, pair exact', () => {
    const tVco = 80e-12; // N = 3.125
    const g = 256;
    const uFbIdeal = 0.337;
    const fine = g * uFbIdeal;
    expect(Math.abs(fine - 86.272)).toBeLessThan(1e-9);
    const rFb = qNearest(fine);
    expect(rFb).toBe(86);
    const uFbActual = rFb / g;
    expect(uFbActual).toBe(0.3359375);
    const eFb = wrapCycles(uFbActual - uFbIdeal);
    expect(Math.abs(eFb - -0.0010625)).toBeLessThan(1e-12);
    expect(Math.abs((eFb * tVco) / 1e-15 - -85.0)).toBeLessThan(1e-3); // -85 fs
    const rInj = pymod(0 - rFb, g);
    expect(rInj).toBe(170);
    const uInjActual = rInj / g;
    expect(uInjActual).toBe(0.6640625);
    const uInjIdealV = wrap01(0.0 - uFbIdeal);
    expect(Math.abs(uInjIdealV - 0.663)).toBeLessThan(1e-12);
    const eInj = wrapCycles(uInjActual - uInjIdealV);
    expect(Math.abs(eInj - 0.0010625)).toBeLessThan(1e-12);
    expect(Math.abs((eInj * tVco) / 1e-15 - 85.0)).toBeLessThan(1e-3); // +85 fs
    // pair digitally exact reverse
    expect(uFbActual + uInjActual).toBe(1.0);
    expect(wrapCycles(uFbActual + uInjActual - 0.0)).toBe(0.0);
  });

  it('same numbers reproduced by the full engine (x_ideal[1]=0.337, N=3.337)', () => {
    const res = simulate(fromPartial({ n_div: 3.337, quantizer: 'nearest', arch_mode: 'D' }));
    const d = res.data;
    expect(d.R_FB[1]).toBe(86);
    expect(d.R_INJ[1]).toBe(170);
    expect(d.u_FB_digital[1]).toBe(0.3359375);
    expect(d.u_INJ_digital[1]).toBe(0.6640625);
    expect(Math.abs(d.e_FB_abs[1] - -0.0010625)).toBeLessThan(1e-12);
    expect(Math.abs(d.e_INJ_abs[1] - 0.0010625)).toBeLessThan(1e-12);
    expect(d.e_pair_digital[1]).toBe(0.0);
  });

  it('on-grid alpha (N = 3.0 / 3.125 / 3.25) is exact', () => {
    for (const n of [3.0, 3.125, 3.25]) {
      const res = simulate(fromPartial({ n_div: n, quantizer: 'nearest' }));
      for (let k = 0; k < res.data.k.length; k++) {
        expect(res.data.e_FB_abs[k]).toBe(0.0);
        expect(res.data.e_pair_digital[k]).toBe(0.0);
        expect(res.data.e_ZC_hw[k]).toBe(0.0);
      }
    }
  });
});
