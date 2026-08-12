/**
 * Test 18: actuator_mode='qnc' (MODEL_SPEC section 7.2) — integer-cycle
 * divider quantization + cancellation DTC fed the accumulated sub-cycle
 * residue, injection = modular reverse of the cancellation code.
 * Mirror of tests/test_qnc.py; pinned numbers cross-checked against the
 * Python golden model (N=3.13, 512 cycles).
 */

import { describe, expect, it } from 'vitest';
import { fromPartial } from '../config';
import { lmsQncStep } from '../feedbackScheduler';
import { pymod } from '../phaseMath';
import { simulate } from '../simulate';

function maxAbs(x: Float64Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > m) m = a;
  }
  return m;
}

describe("actuator_mode='qnc' (section 7.2)", () => {
  it('qnc_gain=1 + nearest: feedback timing equivalent to full within 1 LSB', () => {
    const res = simulate(
      fromPartial({ n_div: 3.13, quantizer: 'nearest', actuator_mode: 'qnc' }),
    );
    const peak = maxAbs(res.data.e_FB_abs);
    expect(peak).toBeLessThanOrEqual(1 / 512 + 1 / 256);
    // pinned Python golden value
    expect(peak).toBeCloseTo(0.001875000000154614, 15);
    // identical peak to the full actuator on the same grid
    const full = simulate(fromPartial({ n_div: 3.13, quantizer: 'nearest' }));
    expect(peak).toBeCloseTo(maxAbs(full.data.e_FB_abs), 15);
  });

  it('qnc_gain=1 + ef1 also stays within the bound (monotonic edges)', () => {
    const res = simulate(
      fromPartial({ n_div: 3.13, quantizer: 'ef1', actuator_mode: 'qnc' }),
    );
    expect(maxAbs(res.data.e_FB_abs)).toBeLessThanOrEqual(1 / 512 + 1 / 256);
  });

  it('qnc_gain=0.98: code-dependent residual appears (max 0.02125 cycles)', () => {
    const res = simulate(
      fromPartial({
        n_div: 3.13,
        quantizer: 'nearest',
        actuator_mode: 'qnc',
        qnc_gain: 0.98,
      }),
    );
    const e = res.data.e_FB_abs;
    const peak = maxAbs(e);
    expect(peak).toBeGreaterThan(1 / 512 + 1 / 256);
    expect(peak).toBeCloseTo(0.021250000000009095, 12);
    let over = 0;
    for (let k = 0; k < e.length; k++) {
      if (Math.abs(e[k]) > 1 / 512) over += 1;
    }
    expect(over).toBe(444); // Python golden count
  });

  it('mode-D modular-reverse identity holds in qnc mode', () => {
    for (const quant of ['nearest', 'ef1'] as const) {
      const res = simulate(
        fromPartial({ n_div: 3.13, quantizer: quant, actuator_mode: 'qnc', arch_mode: 'D' }),
      );
      const d = res.data;
      let maxRfb = 0;
      for (let k = 0; k < d.k.length; k++) {
        expect(d.R_INJ[k]).toBe(pymod(-d.R_FB[k], 256));
        expect(d.e_pair_digital[k]).toBe(0);
        if (d.R_FB[k] > maxRfb) maxRfb = d.R_FB[k];
      }
      expect(maxRfb).toBeGreaterThan(0); // cancellation DTC is exercised
    }
  });

  it('reverse holds regardless of arch_mode in qnc', () => {
    for (const mode of ['A', 'B', 'C'] as const) {
      const res = simulate(
        fromPartial({
          n_div: 3.13,
          quantizer: 'nearest',
          actuator_mode: 'qnc',
          arch_mode: mode,
        }),
      );
      const d = res.data;
      for (let k = 0; k < d.k.length; k++) {
        expect(d.R_INJ[k]).toBe(pymod(-d.R_FB[k], 256));
        expect(d.e_pair_digital[k]).toBe(0);
      }
    }
  });

  it('structure invariants + Python golden R_FB cross-check (16 cycles)', () => {
    const res = simulate(
      fromPartial({
        n_div: 3.13,
        quantizer: 'nearest',
        actuator_mode: 'qnc',
        n_cycles: 16,
      }),
    );
    const d = res.data;
    // Python golden model output for the identical config
    const goldenRfb = [0, 33, 67, 100, 133, 166, 200, 233, 10, 44, 77, 110, 143, 177, 210, 243];
    const goldenAfb = [0, 801, 1603, 2404, 3461, 4262, 5064, 5865];
    for (let k = 0; k < 16; k++) {
      expect(d.R_FB[k]).toBe(goldenRfb[k]);
      expect(d.A_FB[k]).toBe(d.dsm_out[k] * res.g + d.R_FB[k]);
      expect(d.R_FB[k]).toBeGreaterThanOrEqual(0);
      expect(d.R_FB[k]).toBeLessThanOrEqual(res.g - 1);
    }
    for (let k = 0; k < 8; k++) {
      expect(d.A_FB[k]).toBe(goldenAfb[k]);
    }
    for (let k = 1; k < 16; k++) {
      expect(d.A_FB[k] - d.A_FB[k - 1]).toBeGreaterThan(0);
    }
  });

  it('dsm_only untouched by the qnc addition', () => {
    const res = simulate(
      fromPartial({ n_div: 3.13, quantizer: 'ef1', actuator_mode: 'dsm_only' }),
    );
    const d = res.data;
    for (let k = 0; k < d.k.length; k++) {
      expect(d.A_FB[k] % res.g).toBe(0);
      expect(d.R_FB[k]).toBe(0);
      expect(d.R_INJ[k]).toBe(0);
    }
  });

  it('lmsQncStep(gain, mu, e, r) = gain - mu*e*r (pure, deterministic)', () => {
    expect(lmsQncStep(1.0, 0.1, 0.5, 0.2)).toBe(0.99);
    expect(lmsQncStep(1.0, 0.0, 0.5, 0.2)).toBe(1.0);
    expect(lmsQncStep(0.98, 0.25, -0.5, 0.5)).toBe(0.98 - 0.25 * -0.5 * 0.5);
  });
});
