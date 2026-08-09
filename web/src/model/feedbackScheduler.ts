/**
 * Feedback path scheduler: /3-/4 + 4-phase PMUX + 6-bit DTC.
 *
 * Contract: MODEL_SPEC.md sections 4, 6 [EXACT].
 * Mirror of model/python/feedback_scheduler.py.
 *
 *     A_FB[k] = Q_FB(A_ideal[k])            (non-negative integer)
 *     I_FB[k] = floor(A_FB[k] / G)
 *     R_FB[k] = A_FB[k] mod G
 *     m_FB[k] = floor(R_FB[k] / 64)
 *     c_FB[k] = R_FB[k] mod 64
 *     n_integer[k] = I_FB[k+1] - I_FB[k]
 *     u_FB_digital[k] = R_FB[k] / G
 *     e_FB_abs[k] = wrapCycles(A_FB[k]/G - s_ideal[k])
 */

import type { SimConfig } from './config';
import { configG } from './config';
import type { DTCModel } from './dtcModel';
import { wrapCycles, pymod } from './phaseMath';
import { makeQuantizer } from './quantizers';
import type { Mulberry32 } from './rng';

export interface FeedbackResult {
  A_FB: Float64Array;
  I_FB: Float64Array;
  R_FB: Float64Array;
  m_FB: Float64Array;
  c_FB: Float64Array;
  n_int: Float64Array;
  s_FB_actual: Float64Array;
  u_FB_digital: Float64Array;
  e_FB_abs: Float64Array;
  dsm_state: Float64Array;
  dsm_out: Float64Array;
}

/**
 * Quantize the ideal fine-code trajectory and decode divider commands.
 *
 * Optional triangular dither (spec section 6 item 7):
 *     u' = u + d_amp * (U1 + U2 - 1),  U from the 'dither_fb' stream
 * (d_amp is in quantizer-LSB units: 1 fine LSB in 'full' actuator mode,
 * 1 VCO cycle in 'dsm_only').
 *
 * Actuator modes (spec section 7.1):
 *     full     : A_FB = Q(A_ideal)          (fine 1/G-cycle quantization)
 *     dsm_only : A_FB = Q(A_ideal / G) * G  (classic divider-modulating DSM;
 *                quantizer operates at INTEGER-CYCLE granularity, so
 *                R_FB = m_FB = c_FB = 0 always; dsm_out is the integer
 *                cycle count Q(A_ideal / G))
 *
 * Returns computed-domain (pre-latency) arrays; assertions per section 4.
 */
export function runFeedback(
  cfg: SimConfig,
  aIdealArr: ArrayLike<number>,
  sIdealArr: ArrayLike<number>,
  ditherStream: Mulberry32 | null = null,
): FeedbackResult {
  const g = configG(cfg);
  const nDtc = 1 << cfg.b_dtc;
  const n = aIdealArr.length;
  const q = makeQuantizer(cfg.quantizer);
  const dsmOnly = cfg.actuator_mode === 'dsm_only';

  const aFb = new Float64Array(n);
  const dsmState = new Float64Array(n);
  const dsmOut = new Float64Array(n);

  const useDither = cfg.dither_amp_lsb > 0.0 && ditherStream !== null;
  for (let k = 0; k < n; k++) {
    let u = dsmOnly ? aIdealArr[k] / g : aIdealArr[k];
    if (useDither && ditherStream !== null) {
      u += cfg.dither_amp_lsb * (ditherStream.next() + ditherStream.next() - 1.0);
    }
    const y = q.quantize(u);
    aFb[k] = dsmOnly ? y * g : y;
    dsmOut[k] = y;
    dsmState[k] = q.state;
  }

  // --- assertions (MODEL_SPEC section 4) ---
  for (let k = 1; k < n; k++) {
    if (!(aFb[k] - aFb[k - 1] > 0)) {
      throw new Error('A_FB must be strictly monotonic (no duplicate/backward edges)');
    }
  }
  const iFb = new Float64Array(n);
  const rFb = new Float64Array(n);
  const mFb = new Float64Array(n);
  const cFb = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    iFb[k] = Math.floor(aFb[k] / g);
    rFb[k] = pymod(aFb[k], g);
    mFb[k] = Math.floor(rFb[k] / nDtc);
    cFb[k] = pymod(rFb[k], nDtc);
    if (!(rFb[k] >= 0 && rFb[k] < g)) throw new Error('R_FB out of range');
    if (!(mFb[k] >= 0 && mFb[k] < cfg.n_pmux)) throw new Error('m_FB out of range');
    if (!(cFb[k] >= 0 && cFb[k] < nDtc)) throw new Error('c_FB out of range');
  }

  const nIntPadded = new Float64Array(Math.max(n, 1));
  if (n > 1) {
    for (let k = 0; k < n - 1; k++) {
      const d = iFb[k + 1] - iFb[k];
      if (!(d >= 0)) {
        throw new Error('n_integer must be non-negative (PMUX wrap legality)');
      }
      nIntPadded[k] = d;
    }
    nIntPadded[n - 1] = nIntPadded[n - 2]; // pad with the last value
  }

  const sFbActual = new Float64Array(n);
  const eFbAbs = new Float64Array(n);
  const uFbDigital = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    sFbActual[k] = aFb[k] / g;
    eFbAbs[k] = wrapCycles(sFbActual[k] - sIdealArr[k]);
    uFbDigital[k] = rFb[k] / g;
  }

  return {
    A_FB: aFb,
    I_FB: iFb,
    R_FB: rFb,
    m_FB: mFb,
    c_FB: cFb,
    n_int: nIntPadded,
    s_FB_actual: sFbActual,
    u_FB_digital: uFbDigital,
    e_FB_abs: eFbAbs,
    dsm_state: dsmState,
    dsm_out: dsmOut,
  };
}

/**
 * Analog-layer feedback fractional position (cycles):
 *
 * u_FB_analog = pmux_actual(m) + dtc_fb_actual(c) + route_FB
 */
export function uFbAnalog(
  cfg: SimConfig,
  mFb: ArrayLike<number>,
  cFb: ArrayLike<number>,
  dtcFb: DTCModel,
  pmuxTbl: ArrayLike<number>,
): Float64Array {
  const n = mFb.length;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    out[k] = pmuxTbl[mFb[k]] + dtcFb.delayCycles(cFb[k]) + cfg.route_fb_cycles;
  }
  return out;
}
