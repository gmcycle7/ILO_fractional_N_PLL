/**
 * Tests 15-17: actuator_mode='dsm_only' invariants (MODEL_SPEC section 7.1)
 * and injection gating behavior (section 14).
 * Mirror of tests/test_actuator_gating.py.
 */

import { describe, expect, it } from 'vitest';
import type { SimConfig } from '../config';
import { fromPartial } from '../config';
import { simulate } from '../simulate';

const GATED: Partial<SimConfig> = {
  n_div: 3.13,
  quantizer: 'ef1',
  actuator_mode: 'dsm_only',
  inj_gate_mode: 'threshold',
  inj_model: 'sin',
  k_inj: 0.4,
  delta_f_hz: 1e6,
  sigma_vco_w_rad: 0.02,
};

function rmsTail(x: Float64Array, tail: number): number {
  let s = 0;
  for (let i = x.length - tail; i < x.length; i++) {
    s += x[i] * x[i];
  }
  return Math.sqrt(s / tail);
}

describe("actuator_mode='dsm_only' invariants (section 7.1)", () => {
  for (const quant of ['nearest', 'floor', 'ef1'] as const) {
    it(`${quant}: R_FB/m_FB/c_FB/R_INJ/j_INJ/c_INJ all 0, whole-cycle A_FB`, () => {
      const res = simulate(
        fromPartial({ n_div: 3.13, quantizer: quant, actuator_mode: 'dsm_only' }),
      );
      const d = res.data;
      const n = d.k.length;
      for (let k = 0; k < n; k++) {
        expect(d.A_FB[k] % res.g).toBe(0);
        expect(d.R_FB[k]).toBe(0);
        expect(d.m_FB[k]).toBe(0);
        expect(d.c_FB[k]).toBe(0);
        expect(d.R_INJ[k]).toBe(0);
        expect(d.j_INJ[k]).toBe(0);
        expect(d.c_INJ[k]).toBe(0);
        expect(d.u_FB_digital[k]).toBe(0);
        expect(d.u_INJ_digital[k]).toBe(0);
        expect(d.u_INJ_analog[k]).toBe(0); // ideal analog: tap0 + DTC(0)
        expect(d.e_pair_digital[k]).toBe(0);
        // dsm_out is the integer cycle count Q(A_ideal / G)
        expect(d.dsm_out[k] * res.g).toBe(d.A_FB[k]);
      }
      for (let k = 1; k < n; k++) {
        expect(d.A_FB[k] - d.A_FB[k - 1]).toBeGreaterThan(0);
      }
    });
  }

  it('e_ZC_hw = wrapCycles(x_ideal) sweeps up to +-0.5 cycle', () => {
    const res = simulate(
      fromPartial({ n_div: 3.13, quantizer: 'ef1', actuator_mode: 'dsm_only' }),
    );
    const d = res.data;
    let peak = 0;
    for (let k = 0; k < d.k.length; k++) {
      let expected = d.x_ideal[k] - Math.floor(d.x_ideal[k]);
      if (expected > 0.5) expected -= 1.0;
      expect(Math.abs(d.e_ZC_hw[k] - expected)).toBeLessThanOrEqual(1e-12);
      peak = Math.max(peak, Math.abs(d.e_ZC_hw[k]));
      expect(d.e_ZC_hw[k]).toBeLessThanOrEqual(0.5);
    }
    expect(peak).toBeGreaterThan(0.49); // actually sweeps the range
  });
});

describe('injection gating (section 14)', () => {
  it("inj_fired convention: all 0 when inj_model == 'none'", () => {
    const res = simulate(fromPartial({ n_div: 3.13 }));
    for (let k = 0; k < res.data.k.length; k++) {
      expect(res.data.inj_fired[k]).toBe(0);
    }
    const res2 = simulate(fromPartial({ n_div: 3.13, inj_gate_mode: 'threshold' }));
    for (let k = 0; k < res2.data.k.length; k++) {
      expect(res2.data.inj_fired[k]).toBe(0);
    }
  });

  it("inj_fired convention: all 1 when inj_model != 'none' and gate off", () => {
    const res = simulate(fromPartial({ n_div: 3.13, inj_model: 'sin', k_inj: 0.3 }));
    for (let k = 0; k < res.data.k.length; k++) {
      expect(res.data.inj_fired[k]).toBe(1);
    }
  });

  it('fired mask matches |e_ZC_hw| <= threshold; no kick when not fired', () => {
    const res = simulate(fromPartial(GATED));
    const d = res.data;
    const thr = res.config.inj_gate_threshold_cycles;
    expect(thr).toBe(0.0625);
    let fired = 0;
    let kicked = 0;
    for (let k = 0; k < d.k.length; k++) {
      const expected = Math.abs(d.e_ZC_hw[k]) <= thr ? 1 : 0;
      expect(d.inj_fired[k]).toBe(expected);
      if (expected === 1) {
        fired += 1;
        if (d.delta_theta[k] !== 0) kicked += 1;
      } else {
        expect(d.delta_theta[k]).toBe(0); // no phase kick when gated out
      }
    }
    expect(fired).toBeGreaterThan(0);
    expect(fired).toBeLessThan(d.k.length); // gate selects a strict subset
    expect(kicked).toBeGreaterThan(0);
  });

  it('gating restores a bounded dsm_only lock (exp21 story)', () => {
    const ungated = simulate(fromPartial({ ...GATED, inj_gate_mode: 'off' }));
    const gated = simulate(fromPartial(GATED));
    const rmsUn = rmsTail(ungated.data.theta_plus, 256);
    const rmsGt = rmsTail(gated.data.theta_plus, 256);
    expect(rmsGt).toBeLessThan(0.2);
    expect(rmsUn).toBeGreaterThan(1.0);
    expect(rmsGt).toBeLessThan(rmsUn / 5.0);
  });
});
