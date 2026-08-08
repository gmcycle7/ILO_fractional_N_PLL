/**
 * Acceptance Test 4: the 0.3-LSB canonical example (MODEL_SPEC section 6).
 * Mirror of tests/test_quantizers.py.
 */

import { describe, expect, it } from 'vitest';
import { ErrorFeedbackFirstOrder, Mash11, makeQuantizer } from '../quantizers';

describe('quantizers (Test 4)', () => {
  it('nearest gives constant -0.3 LSB error for u = m + 0.3', () => {
    const q = makeQuantizer('nearest');
    for (let k = 0; k < 100; k++) {
      const u = 7 * k + 0.3;
      const y = q.quantize(u);
      expect(Math.abs(y - u - -0.3)).toBeLessThan(1e-9);
    }
  });

  it('ef1 0.3-LSB canonical: errors in {-0.3, +0.7}, mean -> 0', () => {
    const q = new ErrorFeedbackFirstOrder();
    const errs: number[] = [];
    for (let k = 0; k < 2000; k++) {
      const u = 5 * k + 0.3; // u[k] = m[k] + 0.3
      const y = q.quantize(u);
      errs.push(y - u);
    }
    // instantaneous error is either -0.3 or +0.7 LSB
    for (const e of errs) {
      expect(Math.abs(e + 0.3) < 1e-9 || Math.abs(e - 0.7) < 1e-9).toBe(true);
    }
    // peak |error| grows from 0.3 to 0.7
    const maxAbs = Math.max(...errs.map(Math.abs));
    expect(Math.abs(maxAbs - 0.7)).toBeLessThan(1e-9);
    // first cycles follow the 0,0,0,1 pattern: -0.3,-0.3,-0.3,+0.7
    expect(Math.abs(errs[0] + 0.3)).toBeLessThan(1e-9);
    expect(Math.abs(errs[1] + 0.3)).toBeLessThan(1e-9);
    expect(Math.abs(errs[2] + 0.3)).toBeLessThan(1e-9);
    expect(Math.abs(errs[3] - 0.7)).toBeLessThan(1e-9);
    // long-term mean -> 0 within 1e-3
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    expect(Math.abs(mean)).toBeLessThan(1e-3);
  });

  it('ef1 state stays in [0, 1)', () => {
    const q = new ErrorFeedbackFirstOrder();
    for (let k = 0; k < 500; k++) {
      q.quantize(k * 3.13 + 0.123);
      expect(q.state).toBeGreaterThanOrEqual(0.0);
      expect(q.state).toBeLessThan(1.0);
    }
  });

  it('mash11 follows the spec recursion exactly', () => {
    const q = new Mash11();
    let acc1 = 0.0;
    let acc2 = 0.0;
    let c2Prev = 0;
    for (let k = 0; k < 500; k++) {
      const u = k * 3.13 * 256;
      const m = Math.floor(u);
      const f = u - m;
      acc1 += f;
      const c1 = Math.floor(acc1);
      acc1 -= c1;
      acc2 += acc1;
      const c2 = Math.floor(acc2);
      acc2 -= c2;
      const yRef = m + c1 + (c2 - c2Prev);
      c2Prev = c2;
      expect(q.quantize(u)).toBe(yRef);
    }
  });

  it('truncate equals floor for non-negative inputs', () => {
    const qt = makeQuantizer('truncate');
    const qf = makeQuantizer('floor');
    for (const u of [0.0, 0.3, 5.99, 123.456]) {
      expect(qt.quantize(u)).toBe(qf.quantize(u));
    }
  });
});
