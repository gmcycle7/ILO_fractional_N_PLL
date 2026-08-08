/**
 * Injection tap and feedback PMUX phase models.
 *
 * Contract: MODEL_SPEC.md sections 4, 5, 10 [EXACT nominal + ASSUMPTION
 * mismatch].  Mirror of model/python/tap_model.py.
 *
 *     tap_actual(j)  = j/N_TAP  + delta_tap[j]     (cycles)
 *     pmux_actual(m) = m/N_PMUX + delta_pmux[m]    (cycles)
 */

/** Actual phase of injection tap j (cycles). */
export function tapActual(
  j: number,
  nTap: number = 8,
  deltaTap: readonly number[] | null = null,
): number {
  const d = deltaTap === null ? 0.0 : deltaTap[j];
  return j / nTap + d;
}

/** Actual phase of feedback PMUX phase m (cycles). */
export function pmuxActual(
  m: number,
  nPmux: number = 4,
  deltaPmux: readonly number[] | null = null,
): number {
  const d = deltaPmux === null ? 0.0 : deltaPmux[m];
  return m / nPmux + d;
}

/** Vector of actual tap phases (cycles). */
export function tapTable(nTap: number = 8, deltaTap: readonly number[] | null = null): Float64Array {
  const out = new Float64Array(nTap);
  for (let j = 0; j < nTap; j++) {
    out[j] = j / nTap + (deltaTap === null ? 0.0 : deltaTap[j]);
  }
  return out;
}

/** Vector of actual PMUX phases (cycles). */
export function pmuxTable(
  nPmux: number = 4,
  deltaPmux: readonly number[] | null = null,
): Float64Array {
  const out = new Float64Array(nPmux);
  for (let m = 0; m < nPmux; m++) {
    out[m] = m / nPmux + (deltaPmux === null ? 0.0 : deltaPmux[m]);
  }
  return out;
}
