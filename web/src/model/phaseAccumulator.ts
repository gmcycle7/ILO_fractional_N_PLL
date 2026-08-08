/**
 * Ideal fractional phase trajectory.
 *
 * Contract: MODEL_SPEC.md section 3 [EXACT].
 * Mirror of model/python/phase_accumulator.py.
 *
 * s_ideal[k] = s0 + k*N computed by MULTIPLICATION (never by accumulation) so
 * float64 results are bit-identical between Python and TypeScript.
 */

import { wrap01Arr } from './phaseMath';

/**
 * Absolute VCO phase coordinate at reference edge k (cycles).
 *
 * s_ideal[k] = s0 + k * N   (multiplication, not accumulation)
 */
export function sIdeal(nCycles: number, nDiv: number, s0: number = 0.0): Float64Array {
  const out = new Float64Array(nCycles);
  for (let k = 0; k < nCycles; k++) {
    out[k] = s0 + k * nDiv;
  }
  return out;
}

/** Fractional phase state x_ideal[k] = wrap01(s_ideal[k]). */
export function xIdeal(nCycles: number, nDiv: number, s0: number = 0.0): Float64Array {
  return wrap01Arr(sIdeal(nCycles, nDiv, s0));
}

/** High-resolution ideal fine code A_ideal[k] = G * s_ideal[k] (real). */
export function aIdeal(
  nCycles: number,
  nDiv: number,
  s0: number = 0.0,
  g: number = 256,
): Float64Array {
  const s = sIdeal(nCycles, nDiv, s0);
  const out = new Float64Array(nCycles);
  for (let k = 0; k < nCycles; k++) {
    out[k] = g * s[k];
  }
  return out;
}
