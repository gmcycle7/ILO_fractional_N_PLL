/**
 * Injection scheduler: architecture modes A/B/C/D and tap+DTC decode.
 *
 * Contract: MODEL_SPEC.md sections 5, 7, 8 [EXACT].
 * Mirror of model/python/injection_scheduler.py.
 *
 *     u_INJ_ideal[k] = wrap01(z0 - x_nominal[k])
 *
 * Modes (feedback always A_FB = Q_FB(A_ideal)):
 *     A: R_INJ = Q_INJ(G * u_INJ_ideal) mod G, independent instance of the
 *        same quantizer type (independent error state; dither 'dither_inj').
 *     B: same as A but both sides are DSM-type quantizers with their own
 *        state/stream ("not recommended"; code path identical to A — the
 *        mode label documents intent; cfg.quantizer should be ef1/mash11).
 *     C: shared high-resolution master state P[k] = A_ideal[k]; u_INJ_ideal
 *        derived from it, then quantized by an independent instance.
 *     D (default): quantize once + modular reverse:
 *        R_INJ = (R_zero - R_FB) mod 256  ->  e_pair_digital == 0 exactly.
 *
 * Independent DSM state (spec section 7, modes A/B/C): when the quantizer is
 * a stateful DSM type the injection-side instance is seeded with a DISTINCT
 * deterministic initial state drawn from the 'dsm_inj' PRNG stream
 * (section 12, offset 10):
 *     ef1     -> e0 = one uniform draw
 *     mash11  -> acc1, acc2 = two uniform draws (c2_prev stays 0)
 *     mash111 -> acc1, acc2, acc3 = three uniform draws (in that order;
 *                c2_prev, c3_prev, c3_prev2 stay 0)
 * nearest/floor/truncate are stateless and unaffected.
 *
 * Actuator mode 'dsm_only' (spec section 7.1): the fractional injection
 * actuator is absent — R_INJ = 0, tap j = 0, c_INJ = 0 on every cycle
 * (regardless of arch_mode; no 'dsm_inj' draws are consumed).
 *
 * Actuator mode 'qnc' (spec section 7.2): the injection side is ALWAYS the
 * modular reverse of the cancellation-DTC code,
 * R_INJ = (R_zero - R_FB) mod G, regardless of arch_mode (no 'dsm_inj'
 * draws are consumed); tap/DTC decode proceeds as usual.
 *
 * Mappings (input digital code R_INJ; target u_target = R_INJ/G):
 *     naive      : j = floor(R/32), c = R mod 32   (lower half of DTC range)
 *     nearest    : argmin over j in 0..7, c in 0..63 of
 *                  |wrapCycles(u_target - (j/8 + c/256))|, tie-break smaller
 *                  c then smaller j (candidates enumerated c-major so the
 *                  first-minimum rule implements the tie-break exactly)
 *     calibrated : argmin using actual tap + DTC + route models.
 *
 * [Resolved ambiguity: spec section 8 allows the mapping input to be either
 * the digital code R_INJ or a real target; this model always uses the digital
 * command target u_target = R_INJ/G so the R_INJ produced by the architecture
 * mode remains the single command word.  e_INJ_abs is still measured against
 * the real u_INJ_ideal.]
 */

import type { SimConfig } from './config';
import { configG } from './config';
import type { DTCModel } from './dtcModel';
import { pymod, wrap01, wrapCycles, wrapCyclesArr } from './phaseMath';
import { ErrorFeedbackFirstOrder, Mash11, Mash111, makeQuantizer } from './quantizers';
import type { Mulberry32 } from './rng';

export interface InjectionResult {
  u_INJ_ideal: Float64Array;
  R_INJ: Float64Array;
  j_INJ: Float64Array;
  c_INJ: Float64Array;
  u_INJ_digital: Float64Array;
  u_INJ_analog: Float64Array;
}

/** Ideal normalized injection command: wrap01(z0 - x_nominal). */
export function uInjIdeal(xNominal: ArrayLike<number>, z0: number): Float64Array {
  const out = new Float64Array(xNominal.length);
  for (let k = 0; k < xNominal.length; k++) {
    out[k] = wrap01(z0 - xNominal[k]);
  }
  return out;
}

/** Candidate (j, c) list in c-major order with phase values (cycles). */
function candidates(
  cfg: SimConfig,
  dtcInj: DTCModel,
  tapTbl: ArrayLike<number>,
  calibrated: boolean,
): { js: Int32Array; cs: Int32Array; us: Float64Array } {
  const nDtc = 1 << cfg.b_dtc;
  const g = configG(cfg);
  const total = nDtc * cfg.n_tap;
  const js = new Int32Array(total);
  const cs = new Int32Array(total);
  const us = new Float64Array(total);
  let i = 0;
  for (let c = 0; c < nDtc; c++) {
    for (let j = 0; j < cfg.n_tap; j++) {
      cs[i] = c;
      js[i] = j;
      if (calibrated) {
        us[i] = tapTbl[j] + dtcInj.delayCycles(c) + cfg.route_inj_cycles;
      } else {
        us[i] = j / cfg.n_tap + c / g;
      }
      i += 1;
    }
  }
  return { js, cs, us };
}

/** Produce injection command stream (computed-domain, pre-latency). */
export function runInjection(
  cfg: SimConfig,
  xNominal: ArrayLike<number>,
  rFb: ArrayLike<number>,
  dtcInj: DTCModel,
  tapTbl: ArrayLike<number>,
  ditherStream: Mulberry32 | null = null,
  dsmStream: Mulberry32 | null = null,
): InjectionResult {
  const g = configG(cfg);
  const n = xNominal.length;
  const tapStep = Math.floor(g / cfg.n_tap); // 32 LSB

  const uIdeal = uInjIdeal(xNominal, cfg.z0_cycles);

  // --- actuator mode 'dsm_only' (spec section 7.1): no fractional actuator
  if (cfg.actuator_mode === 'dsm_only') {
    const uInjAnalogConst = tapTbl[0] + dtcInj.delayCycles(0) + cfg.route_inj_cycles;
    const uInjAnalog = new Float64Array(n).fill(uInjAnalogConst);
    return {
      u_INJ_ideal: uIdeal,
      R_INJ: new Float64Array(n),
      j_INJ: new Float64Array(n),
      c_INJ: new Float64Array(n),
      u_INJ_digital: new Float64Array(n),
      u_INJ_analog: uInjAnalog,
    };
  }

  // --- R_INJ per architecture mode ---
  // ('qnc', spec section 7.2: always the modular reverse of the
  // cancellation-DTC code, regardless of arch_mode)
  const rInj = new Float64Array(n);
  if (cfg.arch_mode === 'D' || cfg.actuator_mode === 'qnc') {
    for (let k = 0; k < n; k++) {
      rInj[k] = pymod(cfg.r_zero - rFb[k], g);
    }
  } else {
    // A, B, C: independent quantizer instance on G * u_INJ_ideal
    const q = makeQuantizer(cfg.quantizer);
    // distinct deterministic DSM state per spec section 7 ('dsm_inj' stream)
    if (dsmStream !== null) {
      if (cfg.quantizer === 'ef1') {
        (q as ErrorFeedbackFirstOrder).seedState(dsmStream.next());
      } else if (cfg.quantizer === 'mash11') {
        const acc1 = dsmStream.next();
        const acc2 = dsmStream.next();
        (q as Mash11).seedState(acc1, acc2);
      } else if (cfg.quantizer === 'mash111') {
        const acc1 = dsmStream.next();
        const acc2 = dsmStream.next();
        const acc3 = dsmStream.next();
        (q as Mash111).seedState(acc1, acc2, acc3);
      }
    }
    const useDither = cfg.dither_amp_lsb > 0.0 && ditherStream !== null;
    for (let k = 0; k < n; k++) {
      let u = g * uIdeal[k];
      if (useDither && ditherStream !== null) {
        u += cfg.dither_amp_lsb * (ditherStream.next() + ditherStream.next() - 1.0);
      }
      rInj[k] = pymod(q.quantize(u), g);
    }
  }

  // --- tap + DTC decode ---
  const jInj = new Float64Array(n);
  const cInj = new Float64Array(n);
  if (cfg.inj_mapping === 'naive') {
    for (let k = 0; k < n; k++) {
      jInj[k] = Math.floor(rInj[k] / tapStep);
      cInj[k] = pymod(rInj[k], tapStep);
    }
  } else {
    const calibrated = cfg.inj_mapping === 'calibrated';
    const { js, cs, us } = candidates(cfg, dtcInj, tapTbl, calibrated);
    for (let k = 0; k < n; k++) {
      const target = rInj[k] / g;
      // first minimum -> smaller c, then smaller j (c-major enumeration)
      let best = 0;
      let bestErr = Math.abs(wrapCycles(target - us[0]));
      for (let i = 1; i < us.length; i++) {
        const err = Math.abs(wrapCycles(target - us[i]));
        if (err < bestErr) {
          bestErr = err;
          best = i;
        }
      }
      jInj[k] = js[best];
      cInj[k] = cs[best];
    }
  }

  const uInjDigital = new Float64Array(n);
  const uInjAnalog = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    uInjDigital[k] = pymod(tapStep * jInj[k] + cInj[k], g) / g;
    uInjAnalog[k] = tapTbl[jInj[k]] + dtcInj.delayCycles(cInj[k]) + cfg.route_inj_cycles;
  }

  return {
    u_INJ_ideal: uIdeal,
    R_INJ: rInj,
    j_INJ: jInj,
    c_INJ: cInj,
    u_INJ_digital: uInjDigital,
    u_INJ_analog: uInjAnalog,
  };
}

/**
 * Pairwise reverse error (digital or analog layer, spec section 7):
 *
 * e_pair = wrapCycles(u_FB_actual + u_INJ_actual - u_zero_offset)
 * u_zero_offset = R_zero / G
 */
export function ePair(
  uFb: ArrayLike<number>,
  uInj: ArrayLike<number>,
  rZero: number,
  g: number,
): Float64Array {
  const tmp = new Float64Array(uFb.length);
  for (let k = 0; k < uFb.length; k++) {
    tmp[k] = uFb[k] + uInj[k] - rZero / g;
  }
  return wrapCyclesArr(tmp);
}
