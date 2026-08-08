/**
 * MODEL_SPEC section 12: mulberry32 bit-exact PRNG.
 * Mirror of tests/test_prng.py — the five hardcoded values are the pinned
 * cross-language reference constants (mulberry32 seeded with 12345).
 */

import { describe, expect, it } from 'vitest';
import { Mulberry32, STREAM_OFFSETS, makeAllStreams, makeStream } from '../rng';

// first 5 outputs of mulberry32(12345) — cross-language reference constants
const MULBERRY32_12345_FIRST5 = [
  0.9797282677609473,
  0.3067522644996643,
  0.484205421525985,
  0.817934412509203,
  0.5094283693470061,
];

describe('mulberry32 (spec section 12)', () => {
  it('reproduces the 5 pinned outputs for seed 12345 bit-exactly', () => {
    const r = new Mulberry32(12345);
    for (const expected of MULBERRY32_12345_FIRST5) {
      expect(r.next()).toBe(expected); // bit-exact
    }
  });

  it('uniform outputs stay in [0, 1)', () => {
    const r = new Mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const u = r.next();
      expect(u).toBeGreaterThanOrEqual(0.0);
      expect(u).toBeLessThan(1.0);
    }
  });

  it('named stream offsets match the spec table', () => {
    expect(STREAM_OFFSETS).toEqual({
      ref: 1,
      vco_w: 2,
      vco_rw: 3,
      dither_fb: 4,
      dither_inj: 5,
      dnl_fb: 6,
      dnl_inj: 7,
      lat: 8,
      pulse: 9,
    });
    // stream seed = base_seed + offset
    const s = makeStream('ref', 12345);
    expect(s.next()).toBe(new Mulberry32(12346).next());
    const streams = makeAllStreams(12345);
    expect(streams.pulse.next()).toBe(new Mulberry32(12345 + 9).next());
  });

  it('gaussian pairs are deterministic and cached (Box-Muller)', () => {
    const a = new Mulberry32(777);
    const b = new Mulberry32(777);
    // two gauss() calls consume exactly two uniforms (pair generation)
    const g0 = a.gauss();
    const g1 = a.gauss();
    const u1 = b.next();
    const u2 = b.next();
    const r = Math.sqrt(-2 * Math.log(u1));
    expect(g0).toBe(r * Math.cos(2 * Math.PI * u2));
    expect(g1).toBe(r * Math.sin(2 * Math.PI * u2));
    // deterministic across instances
    const d = new Mulberry32(999);
    const e = new Mulberry32(999);
    for (let i = 0; i < 6; i++) {
      expect(d.gauss()).toBe(e.gauss());
    }
  });
});
