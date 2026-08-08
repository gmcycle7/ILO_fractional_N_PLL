/**
 * Acceptance Test 5: alpha=0.13, L=1 latency bug -> 46.8 degrees.
 * Mirror of tests/test_latency.py.
 */

import { describe, expect, it } from 'vitest';
import { fromPartial } from '../config';
import { cyclesToDegrees, wrapCycles } from '../phaseMath';
import { simulate } from '../simulate';

const HALF_LSB_DEG = 0.703125;

describe('latency and look-ahead (Test 5)', () => {
  it('canonical formula: wrapCycles(L*alpha) = 0.13 cycle = 46.8 deg', () => {
    expect(Math.abs(cyclesToDegrees(wrapCycles(1 * 0.13)) - 46.8)).toBeLessThan(1e-9);
  });

  it('latency bug (L=1, no look-ahead) leaves ~46.8 deg error', () => {
    const res = simulate(
      fromPartial({ n_div: 3.13, latency_cycles: 1, lookahead: false, quantizer: 'nearest' }),
    );
    const e = res.data.e_FB_abs;
    const eDeg: number[] = [];
    for (let k = 2; k < e.length; k++) {
      eDeg.push(Math.abs(e[k]) * 360.0); // skip start-up padding
    }
    // stale-state error 46.8 deg, modulated by <= half-LSB quantization
    for (const v of eDeg) {
      expect(Math.abs(v - 46.8)).toBeLessThanOrEqual(HALF_LSB_DEG + 1e-9);
    }
    const meanDeg = eDeg.reduce((a, b) => a + b, 0) / eDeg.length;
    expect(Math.abs(meanDeg - 46.8)).toBeLessThan(0.75);
    // far larger than half-LSB (66.6x)
    expect(meanDeg / HALF_LSB_DEG).toBeGreaterThan(60);
  });

  it('look-ahead removes the latency error (quantization only)', () => {
    const res = simulate(
      fromPartial({ n_div: 3.13, latency_cycles: 1, lookahead: true, quantizer: 'nearest' }),
    );
    let maxDeg = 0;
    for (const v of res.data.e_FB_abs) {
      maxDeg = Math.max(maxDeg, Math.abs(v) * 360.0);
    }
    expect(maxDeg).toBeLessThanOrEqual(HALF_LSB_DEG + 1e-9);
  });

  it('metadata bookkeeping', () => {
    const n = 16;
    const bug = simulate(
      fromPartial({ n_div: 3.13, n_cycles: n, latency_cycles: 1, lookahead: false }),
    );
    let d = bug.data;
    for (let k = 0; k < n; k++) {
      expect(d.k_applied[k]).toBe(k);
      expect(d.k_computed[k]).toBe(Math.max(k - 1, 0));
      expect(d.seq_id[k]).toBe(Math.max(k - 1, 0));
    }
    const ok = simulate(
      fromPartial({ n_div: 3.13, n_cycles: n, latency_cycles: 1, lookahead: true }),
    );
    d = ok.data;
    for (let k = 0; k < n; k++) {
      expect(d.k_computed[k]).toBe(Math.max(k - 1, 0));
      expect(d.seq_id[k]).toBe(k); // state of k applied at k
    }
    expect(ok.metadata.length).toBe(n);
    expect(Object.keys(ok.metadata[3]).sort()).toEqual([
      'k_applied',
      'k_computed',
      'k_intended',
      'seq_id',
    ]);
  });
});
