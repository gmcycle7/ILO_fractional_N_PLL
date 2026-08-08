/**
 * VCO injection dynamics: one injection per reference cycle.
 *
 * Contract: MODEL_SPEC.md section 14 [ASSUMPTION/APPROX].
 * Mirror of model/python/injection_dynamics.py.
 *
 * Residual phase theta (rad; deterministic trajectory removed):
 *
 *     theta_minus[k] = theta_plus[k-1] + 2*pi*Delta_f*T_ref + w_vco[k]
 *     epsilon_hw[k]  = 2*pi * e_ZC_hardware[k]   (deterministic scheduling)
 *     e_inj[k]       = wrapRadians(theta_minus[k] + epsilon_hw[k] + eps_rand)
 *
 * Injection response models:
 *     none   : Delta_theta = 0
 *     reset  : Delta_theta = -e_inj                  (ideal upper bound)
 *     linear : Delta_theta = -K_inj * e_inj
 *     sin    : Delta_theta = -K_inj * sin(e_inj)
 *     lut    : Delta_theta = interp(pdr_lut, e_inj)  (linear interp, clamped)
 *
 *     theta_plus[k] = wrapRadians(theta_minus[k] + Delta_theta[k])
 *
 * Noise terms [resolved ambiguity]:
 *     w_vco[k] = sigma_vco_w * g_w[k]  +  rw[k],
 *     rw[k] = rw[k-1] + sigma_vco_rw * g_rw[k]   (accumulated random walk)
 *     eps_rand[k] = 2*pi*(ref_jitter[k] + pulse_jitter[k]) / T_vco
 *     (draws happen only when the corresponding sigma > 0 so noiseless
 *     configs consume no stream values.)
 *
 * Sinusoidal fixed point / lock [APPROX]:
 *     K_inj * sin(theta_ss) = 2*pi*Delta_f*T_ref
 *     lock condition:  |2*pi*Delta_f*T_ref| <= K_inj
 *     stable solution: cos(theta_ss) > 0  ->  theta_ss = asin(a / K_inj)
 */

import type { SimConfig } from './config';
import { configTRefS, configTVcoS } from './config';
import { wrapRadians } from './phaseMath';
import type { Streams } from './rng';

export interface DynamicsResult {
  theta_minus: Float64Array;
  epsilon_hw: Float64Array;
  e_inj: Float64Array;
  delta_theta: Float64Array;
  theta_plus: Float64Array;
  e_ZC_total: Float64Array;
}

/** |2*pi*Delta_f*T_ref| <= K_inj (sinusoidal map lock range). */
export function lockCondition(kInj: number, deltaFHz: number, fRefHz: number): boolean {
  const a = (2.0 * Math.PI * deltaFHz) / fRefHz;
  return Math.abs(a) <= kInj;
}

/**
 * Stable steady-state e_inj for the sinusoidal map (rad), or null if outside
 * the lock range: theta_ss = asin(2*pi*Delta_f*T_ref / K_inj).
 */
export function sinFixedPointRad(kInj: number, deltaFHz: number, fRefHz: number): number | null {
  const a = (2.0 * Math.PI * deltaFHz) / fRefHz;
  if (kInj <= 0.0 || Math.abs(a) > kInj) {
    return null;
  }
  return Math.asin(a / kInj);
}

/** np.interp equivalent: linear interpolation, clamped at both ends. */
function interpClamped(e: number, xs: Float64Array, ys: Float64Array): number {
  const n = xs.length;
  if (e <= xs[0]) return ys[0];
  if (e >= xs[n - 1]) return ys[n - 1];
  // binary search for the right interval
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= e) lo = mid;
    else hi = mid;
  }
  const t = (e - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

function deltaTheta(
  model: SimConfig['inj_model'],
  kInj: number,
  e: number,
  lutE: Float64Array | null,
  lutD: Float64Array | null,
): number {
  switch (model) {
    case 'none':
      return 0.0;
    case 'reset':
      return -e;
    case 'linear':
      return -kInj * e;
    case 'sin':
      return -kInj * Math.sin(e);
    case 'lut':
      return interpClamped(e, lutE as Float64Array, lutD as Float64Array);
    default:
      throw new Error(`unknown inj_model '${model as string}'`);
  }
}

/**
 * Run the per-reference-cycle injection phase map.
 *
 * eZcHwCycles: deterministic hardware zero-crossing error (cycles).
 * Returns theta arrays (rad) and e_ZC_total (cycles) = e_inj / (2*pi).
 */
export function runDynamics(
  cfg: SimConfig,
  eZcHwCycles: ArrayLike<number>,
  streams: Streams,
): DynamicsResult {
  const n = eZcHwCycles.length;
  const twoPi = 2.0 * Math.PI;
  const tRef = configTRefS(cfg);
  const tVco = configTVcoS(cfg);
  const a = twoPi * cfg.delta_f_hz * tRef;

  let lutE: Float64Array | null = null;
  let lutD: Float64Array | null = null;
  if (cfg.inj_model === 'lut') {
    if (!cfg.pdr_lut || cfg.pdr_lut.length === 0) {
      throw new Error("inj_model='lut' requires pdr_lut");
    }
    // Python: sorted tuples (e, d) — sort by e, then by d
    const pts = cfg.pdr_lut
      .map((p) => [p[0], p[1]] as [number, number])
      .sort((p, q) => (p[0] - q[0] !== 0 ? p[0] - q[0] : p[1] - q[1]));
    lutE = new Float64Array(pts.map((p) => p[0]));
    lutD = new Float64Array(pts.map((p) => p[1]));
  }

  const thetaMinus = new Float64Array(n);
  const epsilonHw = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    epsilonHw[k] = twoPi * eZcHwCycles[k];
  }
  const eInj = new Float64Array(n);
  const dTheta = new Float64Array(n);
  const thetaPlus = new Float64Array(n);
  const eZcTotal = new Float64Array(n);

  const sVw = streams.vco_w;
  const sRw = streams.vco_rw;
  const sRef = streams.ref;
  const sPulse = streams.pulse;

  let tpPrev = 0.0;
  let rw = 0.0;
  for (let k = 0; k < n; k++) {
    let w = 0.0;
    if (cfg.sigma_vco_w_rad > 0.0 && sVw !== undefined) {
      w += cfg.sigma_vco_w_rad * sVw.gauss();
    }
    if (cfg.sigma_vco_rw_rad > 0.0 && sRw !== undefined) {
      rw += cfg.sigma_vco_rw_rad * sRw.gauss();
      w += rw;
    }
    const tm = tpPrev + a + w;
    let epsRand = 0.0;
    if (cfg.sigma_ref_s > 0.0 && sRef !== undefined) {
      epsRand += (twoPi * (cfg.sigma_ref_s * sRef.gauss())) / tVco;
    }
    if (cfg.sigma_pulse_s > 0.0 && sPulse !== undefined) {
      epsRand += (twoPi * (cfg.sigma_pulse_s * sPulse.gauss())) / tVco;
    }
    const e = wrapRadians(tm + epsilonHw[k] + epsRand);
    const dth = deltaTheta(cfg.inj_model, cfg.k_inj, e, lutE, lutD);
    const tp = wrapRadians(tm + dth);

    thetaMinus[k] = tm;
    eInj[k] = e;
    dTheta[k] = dth;
    thetaPlus[k] = tp;
    eZcTotal[k] = e / twoPi;
    tpPrev = tp;
  }

  return {
    theta_minus: thetaMinus,
    epsilon_hw: epsilonHw,
    e_inj: eInj,
    delta_theta: dTheta,
    theta_plus: thetaPlus,
    e_ZC_total: eZcTotal,
  };
}
