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
 *
 * Injection gating (spec section 14): optional `fired` mask (0/1 per cycle,
 * computed by simulate() from |e_ZC_hw| <= inj_gate_threshold_cycles when
 * inj_gate_mode == 'threshold').  A non-fired cycle applies NO phase kick
 * (Delta_theta = 0; theta keeps accumulating detuning/noise); e_inj is still
 * recorded as the error a pulse would have seen, and PRNG stream consumption
 * is identical with or without gating.
 *
 * PLL loop co-simulation (spec section 14.1) [ASSUMPTION], loop_mode == 'pi':
 * behavioral type-II PI loop; the PD samples the residual phase BEFORE the
 * injection kick:
 *
 *     theta_minus[k] = theta_plus[k-1] + (2*pi*Delta_f*T_ref + u_loop[k])
 *                      + w_vco[k]
 *     pd_e[k]        = wrapRadians(theta_minus[k])
 *     u_loop[0] = 0;  u_loop[k+1] = u_loop[k] - loop_ki * pd_e[k]
 *     theta_plus[k]  = wrapRadians(theta_minus[k] - loop_kp*pd_e[k]
 *                                  + Delta_theta[k])
 *
 * The injection kick is unchanged (same e_inj formula, gating, PRNG draws)
 * and is applied after the proportional kick (summed in the same wrap).
 * loop_mode == 'off' keeps the section-14 recursion bit-identical
 * (u_loop == 0, no proportional kick); pd_e is still recorded as the error
 * the PD would observe.
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
  u_loop: Float64Array;
  pd_e: Float64Array;
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
 * fired: optional 0/1 per-cycle gating mask; cycles with fired == 0 apply
 * no phase kick (Delta_theta = 0).  null means every cycle fires.
 * Returns theta arrays (rad) and e_ZC_total (cycles) = e_inj / (2*pi).
 */
export function runDynamics(
  cfg: SimConfig,
  eZcHwCycles: ArrayLike<number>,
  streams: Streams,
  fired: ArrayLike<number> | null = null,
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
  const uLoopArr = new Float64Array(n);
  const pdE = new Float64Array(n);

  const sVw = streams.vco_w;
  const sRw = streams.vco_rw;
  const sRef = streams.ref;
  const sPulse = streams.pulse;

  const loopPi = cfg.loop_mode === 'pi';
  let tpPrev = 0.0;
  let rw = 0.0;
  let uLoop = 0.0;
  for (let k = 0; k < n; k++) {
    let w = 0.0;
    if (cfg.sigma_vco_w_rad > 0.0 && sVw !== undefined) {
      w += cfg.sigma_vco_w_rad * sVw.gauss();
    }
    if (cfg.sigma_vco_rw_rad > 0.0 && sRw !== undefined) {
      rw += cfg.sigma_vco_rw_rad * sRw.gauss();
      w += rw;
    }
    const tm = loopPi ? tpPrev + a + uLoop + w : tpPrev + a + w;
    const pd = wrapRadians(tm); // behavioral PD, before any kick (section 14.1)
    let epsRand = 0.0;
    if (cfg.sigma_ref_s > 0.0 && sRef !== undefined) {
      epsRand += (twoPi * (cfg.sigma_ref_s * sRef.gauss())) / tVco;
    }
    if (cfg.sigma_pulse_s > 0.0 && sPulse !== undefined) {
      epsRand += (twoPi * (cfg.sigma_pulse_s * sPulse.gauss())) / tVco;
    }
    const e = wrapRadians(tm + epsilonHw[k] + epsRand);
    const dth =
      fired !== null && fired[k] === 0
        ? 0.0 // gated out: no phase kick this cycle
        : deltaTheta(cfg.inj_model, cfg.k_inj, e, lutE, lutD);
    const tp = loopPi ? wrapRadians(tm - cfg.loop_kp * pd + dth) : wrapRadians(tm + dth);

    thetaMinus[k] = tm;
    eInj[k] = e;
    dTheta[k] = dth;
    thetaPlus[k] = tp;
    eZcTotal[k] = e / twoPi;
    uLoopArr[k] = uLoop;
    pdE[k] = pd;
    tpPrev = tp;
    if (loopPi) {
      uLoop = uLoop - cfg.loop_ki * pd;
    }
  }

  return {
    theta_minus: thetaMinus,
    epsilon_hw: epsilonHw,
    e_inj: eInj,
    delta_theta: dTheta,
    theta_plus: thetaPlus,
    e_ZC_total: eZcTotal,
    u_loop: uLoopArr,
    pd_e: pdE,
  };
}
