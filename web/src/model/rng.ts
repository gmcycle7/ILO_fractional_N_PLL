/**
 * Deterministic PRNG and Gaussian generation.
 *
 * Contract: MODEL_SPEC.md section 12 [EXACT] — mulberry32, bit-identical
 * between Python and TypeScript.  Mirror of model/python/noise_models.py.
 * All arithmetic is uint32: 32-bit multiplies use Math.imul, logical shifts
 * use >>>, and every intermediate is masked back to uint32 with >>> 0
 * (matching the Python `& 0xFFFFFFFF` masking exactly).
 *
 * Named streams (seed = base_seed + offset):
 *     ref:1  vco_w:2  vco_rw:3  dither_fb:4  dither_inj:5
 *     dnl_fb:6  dnl_inj:7  lat:8  pulse:9  dsm_inj:10
 */

const TWO32 = 4294967296.0; // 2^32

export const STREAM_OFFSETS = {
  ref: 1,
  vco_w: 2,
  vco_rw: 3,
  dither_fb: 4,
  dither_inj: 5,
  dnl_fb: 6,
  dnl_inj: 7,
  lat: 8,
  pulse: 9,
  dsm_inj: 10,
} as const;

export type StreamName = keyof typeof STREAM_OFFSETS;

export type Streams = Record<StreamName, Mulberry32>;

/** mulberry32 PRNG, bit-exact per MODEL_SPEC section 12. */
export class Mulberry32 {
  private s: number;
  private gaussCache: number | null = null;

  constructor(seed: number) {
    this.s = seed >>> 0; // seed & 0xFFFFFFFF
  }

  private step(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = ((((t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0)) >>> 0) ^ t) >>> 0) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform in [0, 1) with 32-bit resolution. */
  next(): number {
    return this.step() / TWO32;
  }

  /** Raw uint32 output (next() * 2^32 as integer). */
  nextUint32(): number {
    return this.step();
  }

  /**
   * Standard normal via Box-Muller, generated in pairs (z1 cached).
   *
   * u1 = next(); if u1 == 0: u1 = 2^-32
   * u2 = next()
   * r  = sqrt(-2*ln(u1))
   * z0 = r*cos(2*pi*u2);  z1 = r*sin(2*pi*u2)
   */
  gauss(): number {
    if (this.gaussCache !== null) {
      const z = this.gaussCache;
      this.gaussCache = null;
      return z;
    }
    let u1 = this.next();
    if (u1 === 0.0) {
      u1 = 2.0 ** -32;
    }
    const u2 = this.next();
    const r = Math.sqrt(-2.0 * Math.log(u1));
    const z0 = r * Math.cos(2.0 * Math.PI * u2);
    const z1 = r * Math.sin(2.0 * Math.PI * u2);
    this.gaussCache = z1;
    return z0;
  }
}

/** Named noise stream: seed = base_seed + STREAM_OFFSETS[name]. */
export function makeStream(name: StreamName, baseSeed: number = 12345): Mulberry32 {
  if (!(name in STREAM_OFFSETS)) {
    throw new Error(`unknown stream '${name}'`);
  }
  return new Mulberry32(baseSeed + STREAM_OFFSETS[name]);
}

/** All named streams, each an independent Mulberry32 instance. */
export function makeAllStreams(baseSeed: number = 12345): Streams {
  const out = {} as Streams;
  for (const name of Object.keys(STREAM_OFFSETS) as StreamName[]) {
    out[name] = new Mulberry32(baseSeed + STREAM_OFFSETS[name]);
  }
  return out;
}
