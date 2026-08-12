/**
 * Acceptance Test 19: PLL loop co-simulation (MODEL_SPEC section 14.1).
 * Mirror of tests/test_loop.py.
 */

import { describe, expect, it } from 'vitest';
import type { SimConfig } from '../config';
import { defaultConfig, fromPartial } from '../config';
import { lockCondition } from '../injectionDynamics';
import { wrapRadians } from '../phaseMath';
import { simulate } from '../simulate';

const F_REF = 4e9;
const T_REF = 1.0 / F_REF;
const TWO_PI = 2.0 * Math.PI;

// exp23 shared parameters: 250 MHz detuning is OUTSIDE the sin lock range
// (|2*pi*df*T_ref| = 0.3927 rad > k_inj = 0.3)
const DF_OUT = 250e6;
const EXP23: Partial<SimConfig> = {
  n_div: 3.13,
  sigma_vco_w_rad: 0.02,
  delta_f_hz: DF_OUT,
};

function rmsTail(x: ArrayLike<number>, count: number): number {
  let s = 0;
  for (let i = x.length - count; i < x.length; i++) {
    s += x[i] * x[i];
  }
  return Math.sqrt(s / count);
}

function meanTail(x: ArrayLike<number>, count: number): number {
  let s = 0;
  for (let i = x.length - count; i < x.length; i++) {
    s += x[i];
  }
  return s / count;
}

describe('PLL loop co-simulation (Test 19)', () => {
  it('loop-only pd_e mean goes to zero (1 MHz, noiseless)', () => {
    const res = simulate(
      fromPartial({ n_div: 3.13, loop_mode: 'pi', inj_model: 'none', delta_f_hz: 1e6 }),
    );
    expect(Math.abs(meanTail(res.data.pd_e, 128))).toBeLessThan(1e-4);
  });

  it('u_loop steady mean matches -2*pi*delta_f*T_ref (sign verified)', () => {
    const res = simulate(
      fromPartial({
        n_div: 3.13,
        loop_mode: 'pi',
        inj_model: 'none',
        delta_f_hz: DF_OUT,
        n_cycles: 1024,
      }),
    );
    const a = TWO_PI * DF_OUT * T_REF;
    const uMean = meanTail(res.data.u_loop, 64);
    expect(Math.abs(uMean - -a) / a).toBeLessThan(1e-3);
    expect(uMean).toBeLessThan(0.0); // correction opposes positive detuning
  });

  it('both-mode tail rms is below injection-only at the exp23 config', () => {
    expect(lockCondition(0.3, DF_OUT, F_REF)).toBe(false);
    const injOnly = simulate(fromPartial({ ...EXP23, inj_model: 'sin', k_inj: 0.3 }));
    const both = simulate(fromPartial({ ...EXP23, inj_model: 'sin', k_inj: 0.3, loop_mode: 'pi' }));
    // injection alone slips (unlocked ~1.8 rad rms); loop + injection locks
    expect(rmsTail(both.data.e_inj, 256)).toBeLessThan(0.1 * rmsTail(injOnly.data.e_inj, 256));
    expect(rmsTail(both.data.theta_plus, 256)).toBeLessThan(rmsTail(injOnly.data.theta_plus, 256));
  });

  it('loop extends range and injection kills per-cycle jitter', () => {
    const loopOnly = simulate(fromPartial({ ...EXP23, inj_model: 'none', loop_mode: 'pi' }));
    const both = simulate(fromPartial({ ...EXP23, inj_model: 'sin', k_inj: 0.3, loop_mode: 'pi' }));
    expect(Math.abs(meanTail(loopOnly.data.pd_e, 256))).toBeLessThan(0.01);
    expect(Math.abs(meanTail(both.data.pd_e, 256))).toBeLessThan(0.02);
    expect(rmsTail(both.data.theta_plus, 256)).toBeLessThan(rmsTail(loopOnly.data.theta_plus, 256));
  });

  it('a static route offset is integrated into a VCO phase shift (exp23d)', () => {
    const eps = TWO_PI * 0.01;
    const a = TWO_PI * DF_OUT * T_REF;
    const res = simulate(
      fromPartial({
        ...EXP23,
        inj_model: 'sin',
        k_inj: 0.3,
        loop_mode: 'pi',
        route_inj_cycles: 0.01,
        n_cycles: 1024,
      }),
    );
    expect(Math.abs(meanTail(res.data.e_inj, 256) - eps)).toBeLessThan(0.02);
    expect(Math.abs(meanTail(res.data.theta_plus, 256) - -0.3 * Math.sin(eps))).toBeLessThan(0.02);
    const uEnd = res.data.u_loop[res.data.u_loop.length - 1];
    expect(Math.abs(uEnd - (-a + 0.3 * Math.sin(eps)))).toBeLessThan(0.005);
  });

  it('loop off records pd_e but does not act', () => {
    const res = simulate(
      fromPartial({
        n_div: 3.13,
        inj_model: 'sin',
        k_inj: 0.3,
        delta_f_hz: 1e6,
        sigma_vco_w_rad: 0.01,
      }),
    );
    for (const v of res.data.u_loop) {
      expect(v === 0.0).toBe(true);
    }
    for (let k = 0; k < res.data.pd_e.length; k++) {
      expect(res.data.pd_e[k]).toBe(wrapRadians(res.data.theta_minus[k]));
    }
  });

  it('loop config defaults and validation mirror Python', () => {
    const cfg = defaultConfig();
    expect(cfg.loop_mode).toBe('off');
    expect(cfg.loop_kp).toBe(0.05);
    expect(cfg.loop_ki).toBe(0.005);
    expect(fromPartial({ loop_mode: 'pi' }).loop_mode).toBe('pi');
    expect(() => fromPartial({ loop_mode: 'bogus' as SimConfig['loop_mode'] })).toThrow();
  });
});
