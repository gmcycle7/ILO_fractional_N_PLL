/**
 * Acceptance Test 4: the 0.3-LSB canonical example (MODEL_SPEC section 6).
 * Mirror of tests/test_quantizers.py.
 */

import { describe, expect, it } from 'vitest';
import { ErrorFeedbackFirstOrder, Mash11, Mash111, makeQuantizer } from '../quantizers';

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
    // first four cycles of the period-10 carry pattern 0,0,0,1,0,0,1,0,0,1
    // (3 carries per 10 beats, carry rate 0.3): -0.3,-0.3,-0.3,+0.7
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

  it('mash111 first outputs match the hand-computed sequence (== Python)', () => {
    // u[k] = 3k + 0.25 (binary-exact quarters): hand-evaluated section 6
    // item 6 recursion; identical to model/python/mash111.py output.
    const q = new Mash111();
    const outs: number[] = [];
    for (let k = 0; k < 8; k++) {
      outs.push(q.quantize(3 * k + 0.25));
    }
    expect(outs).toEqual([0, 4, 5, 11, 10, 18, 16, 22]);
  });

  it('mash111 follows the spec recursion exactly', () => {
    const q = new Mash111();
    let acc1 = 0.0;
    let acc2 = 0.0;
    let acc3 = 0.0;
    let c2Prev = 0;
    let c3Prev = 0;
    let c3Prev2 = 0;
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
      acc3 += acc2;
      const c3 = Math.floor(acc3);
      acc3 -= c3;
      const yRef = m + c1 + (c2 - c2Prev) + (c3 - 2 * c3Prev + c3Prev2);
      c2Prev = c2;
      c3Prev2 = c3Prev;
      c3Prev = c3;
      expect(q.quantize(u)).toBe(yRef);
    }
  });

  it('mash111 long-term mean error -> 0 with larger peaks', () => {
    const q = new Mash111();
    const errs: number[] = [];
    for (let k = 0; k < 2000; k++) {
      const u = 5 * k + 0.3;
      errs.push(q.quantize(u) - u);
    }
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    expect(Math.abs(mean)).toBeLessThan(1e-2);
    expect(Math.max(...errs.map(Math.abs))).toBeGreaterThan(0.7);
  });

  it("makeQuantizer('mash111') returns a fresh Mash111", () => {
    const q = makeQuantizer('mash111');
    expect(q).toBeInstanceOf(Mash111);
    expect(q.state).toBe(0.0);
  });

  it('truncate equals floor for non-negative inputs', () => {
    const qt = makeQuantizer('truncate');
    const qf = makeQuantizer('floor');
    for (const u of [0.0, 0.3, 5.99, 123.456]) {
      expect(qt.quantize(u)).toBe(qf.quantize(u));
    }
  });
});
