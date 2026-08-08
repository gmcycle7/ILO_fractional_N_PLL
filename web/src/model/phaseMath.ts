/**
 * Wrap conventions and quantization primitives.
 *
 * Contract: MODEL_SPEC.md section 2 [EXACT].
 * Mirror of model/python/phase_math.py.
 *
 * These helpers MUST be implemented identically (character-for-character
 * semantics) in Python and TypeScript.  The language built-in round() is
 * FORBIDDEN (Python uses banker's rounding, JS half-up); qNearest is defined
 * as floor(x + 0.5) so both languages agree bit-for-bit.
 */

export const TWO_PI = 2.0 * Math.PI;

/** x - floor(x)  ->  [0, 1). */
export function wrap01(x: number): number {
  return x - Math.floor(x);
}

/** y = x - floor(x); if y > 0.5: y -= 1  ->  (-0.5, 0.5]. */
export function wrapCycles(x: number): number {
  let y = x - Math.floor(x);
  if (y > 0.5) {
    y -= 1.0;
  }
  return y;
}

/** 2*pi * wrapCycles(t / (2*pi))  ->  (-pi, pi]. */
export function wrapRadians(t: number): number {
  return TWO_PI * wrapCycles(t / TWO_PI);
}

/** cycles -> seconds. */
export function cyclesToTime(x: number, tVco: number): number {
  return x * tVco;
}

/** cycles -> degrees (1 cycle = 360 deg). */
export function cyclesToDegrees(x: number): number {
  return 360.0 * x;
}

/** cycles -> radians (1 cycle = 2*pi rad). */
export function cyclesToRadians(x: number): number {
  return TWO_PI * x;
}

/** seconds -> cycles. */
export function timeToCycles(t: number, tVco: number): number {
  return t / tVco;
}

/** floor quantizer. */
export function qFloor(x: number): number {
  return Math.floor(x);
}

/**
 * Half-up nearest quantizer: floor(x + 0.5).
 *
 * NEVER use a language round() (Python round is banker's rounding) —
 * qNearest(2.5) === 3 in both languages.
 */
export function qNearest(x: number): number {
  return Math.floor(x + 0.5);
}

// ---------------------------------------------------------------------------
// array versions (identical semantics, float64) — mirror *_arr in Python
// ---------------------------------------------------------------------------

export function wrap01Arr(x: ArrayLike<number>): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    out[i] = x[i] - Math.floor(x[i]);
  }
  return out;
}

export function wrapCyclesArr(x: ArrayLike<number>): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let y = x[i] - Math.floor(x[i]);
    if (y > 0.5) {
      y -= 1.0;
    }
    out[i] = y;
  }
  return out;
}

export function wrapRadiansArr(t: ArrayLike<number>): Float64Array {
  const out = new Float64Array(t.length);
  for (let i = 0; i < t.length; i++) {
    out[i] = TWO_PI * wrapCycles(t[i] / TWO_PI);
  }
  return out;
}

/**
 * Python-semantics modulo: result has the sign of the (positive) modulus.
 * Used wherever the Python model writes `x % g` on possibly negative x.
 */
export function pymod(x: number, m: number): number {
  return ((x % m) + m) % m;
}
