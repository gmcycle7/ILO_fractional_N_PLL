/**
 * Top-level simulation engine.
 *
 * Contract: mirror of model/python/simulate.py; runs the full chain per
 * MODEL_SPEC.md: ideal trajectory (section 3) -> feedback quantize/decode
 * (sections 4, 6) -> injection mode + tap/DTC decode (sections 7, 8) ->
 * latency pipeline (section 13) -> analog layers (section 10) -> injection
 * dynamics (section 14).
 *
 * All per-cycle quantities are float64 columns in SimResult.data, keyed by
 * the exact same column names as the Python SimResult (integer-valued
 * columns hold exact integers in float64).
 * Error conventions (section 16):
 *     e_abs  : actual - ideal (single-side absolute)
 *     e_pair : FB + INJ - integer cycle (pairwise relative)
 *     e_ZC   : VCO actual phase at pulse - desired zero crossing
 */

import type { SimConfig } from './config';
import { configG, configTRefS, configTVcoS } from './config';
import { makeDtc } from './dtcModel';
import { runFeedback, uFbAnalog } from './feedbackScheduler';
import { runDynamics } from './injectionDynamics';
import { ePair, runInjection } from './injectionScheduler';
import type { LatencyMetadata } from './latencyPipeline';
import { applyLatency } from './latencyPipeline';
import * as meas from './measurements';
import { sIdeal as sIdealFn } from './phaseAccumulator';
import { wrap01, wrapCycles } from './phaseMath';
import { makeAllStreams } from './rng';
import { pmuxTable, tapTable } from './tapModel';

/** canonical column order of SimResult.data (identical to Python COLUMNS) */
export const COLUMNS = [
  'k',
  's_ideal',
  'x_ideal',
  'A_ideal',
  'A_FB',
  'I_FB',
  'R_FB',
  'm_FB',
  'c_FB',
  'n_int',
  'u_FB_ideal',
  'u_FB_digital',
  'u_FB_analog',
  'e_FB_abs',
  'dsm_state',
  'dsm_out',
  'u_INJ_ideal',
  'R_INJ',
  'j_INJ',
  'c_INJ',
  'u_INJ_digital',
  'u_INJ_analog',
  'e_INJ_abs',
  'e_pair_digital',
  'e_pair_analog',
  'e_ZC_hw',
  'theta_minus',
  'e_inj',
  'delta_theta',
  'theta_plus',
  'e_ZC_total',
  'seq_id',
  'k_computed',
  'k_applied',
] as const;

export type ColumnName = (typeof COLUMNS)[number];

export const INT_COLUMNS: ReadonlySet<string> = new Set([
  'k',
  'A_FB',
  'I_FB',
  'R_FB',
  'm_FB',
  'c_FB',
  'n_int',
  'dsm_out',
  'R_INJ',
  'j_INJ',
  'c_INJ',
  'seq_id',
  'k_computed',
  'k_applied',
]);

const SUMMARY_SIGNALS = [
  'e_FB_abs',
  'e_INJ_abs',
  'e_pair_digital',
  'e_pair_analog',
  'e_ZC_hw',
  'e_ZC_total',
] as const;

export interface SignalSummary {
  rms_cycles: number;
  p2p_cycles: number;
  mean_cycles: number;
  rms_fs: number;
  p2p_fs: number;
  mean_fs: number;
  rms_deg: number;
  p2p_deg: number;
  mean_deg: number;
}

export interface SimSummary {
  e_FB_abs: SignalSummary;
  e_INJ_abs: SignalSummary;
  e_pair_digital: SignalSummary;
  e_pair_analog: SignalSummary;
  e_ZC_hw: SignalSummary;
  e_ZC_total: SignalSummary;
  t_vco_s: number;
  t_ref_s: number;
  f_vco_hz: number;
}

export interface SimResult {
  config: SimConfig;
  t_vco_s: number;
  t_ref_s: number;
  g: number;
  data: Record<ColumnName, Float64Array>;
  columns: ColumnName[];
  metadata: LatencyMetadata[]; // per-cycle latency metadata
}

/** List of per-cycle rows (plain numbers) in `columns` order. */
export function toRows(res: SimResult): number[][] {
  const n = res.data.k.length;
  const cols = res.columns.map((c) => res.data[c]);
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    rows.push(cols.map((col) => col[i]));
  }
  return rows;
}

/** rms / peak-to-peak / mean of the key error signals (mirror of summary). */
export function summary(res: SimResult): SimSummary {
  const fsPerCycle = res.t_vco_s / 1e-15;
  const out: Record<string, SignalSummary | number> = {};
  for (const name of SUMMARY_SIGNALS) {
    const x = res.data[name];
    out[name] = {
      rms_cycles: meas.rms(x),
      p2p_cycles: meas.peakToPeak(x),
      mean_cycles: meas.mean(x),
      rms_fs: meas.rms(x) * fsPerCycle,
      p2p_fs: meas.peakToPeak(x) * fsPerCycle,
      mean_fs: meas.mean(x) * fsPerCycle,
      rms_deg: meas.rms(x) * 360.0,
      p2p_deg: meas.peakToPeak(x) * 360.0,
      mean_deg: meas.mean(x) * 360.0,
    };
  }
  out.t_vco_s = res.t_vco_s;
  out.t_ref_s = res.t_ref_s;
  out.f_vco_hz = 1.0 / res.t_vco_s;
  return out as unknown as SimSummary;
}

function gather(src: ArrayLike<number>, idx: ArrayLike<number>): Float64Array {
  const out = new Float64Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    out[i] = src[idx[i]];
  }
  return out;
}

/** Run the golden behavioral model for cfg.n_cycles reference cycles. */
export function simulate(cfg: SimConfig): SimResult {
  const g = configG(cfg);
  const n = cfg.n_cycles;
  const streams = makeAllStreams(cfg.seed);

  // --- ideal trajectory (section 3; multiplication, not accumulation) ---
  const ks = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    ks[k] = k;
  }
  const sId = sIdealFn(n, cfg.n_div, cfg.s0);
  const xId = new Float64Array(n);
  const aId = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    xId[k] = wrap01(sId[k]);
    aId[k] = g * sId[k];
  }

  // --- analog element models (frozen per instance) ---
  const dtcFb = makeDtc(cfg, 'fb', streams);
  const dtcInj = makeDtc(cfg, 'inj', streams);
  const tapTbl = tapTable(cfg.n_tap, cfg.tap_mismatch_cycles);
  const pmuxTbl = pmuxTable(cfg.n_pmux, cfg.pmux_mismatch_cycles);

  // --- computed-domain command streams ---
  const fb = runFeedback(cfg, aId, sId, streams.dither_fb);
  const inj = runInjection(cfg, xId, fb.R_FB, dtcInj, tapTbl, streams.dither_inj);

  // --- latency pipeline (section 13) ---
  const lat = applyLatency(cfg, n, streams.lat);
  const idx = lat.idx;

  // --- applied-domain quantities (errors vs the CURRENT ideal state) ---
  const sFbAct = gather(fb.s_FB_actual, idx);
  const eFbAbs = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    eFbAbs[k] = wrapCycles(sFbAct[k] - sId[k]);
  }
  const uFbDig = gather(fb.u_FB_digital, idx);
  const uFbAn = uFbAnalog(cfg, gather(fb.m_FB, idx), gather(fb.c_FB, idx), dtcFb, pmuxTbl);

  const uInjIdealNow = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    uInjIdealNow[k] = wrap01(cfg.z0_cycles - xId[k]);
  }
  const uInjDig = gather(inj.u_INJ_digital, idx);
  const uInjAn = gather(inj.u_INJ_analog, idx);
  const eInjAbs = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    eInjAbs[k] = wrapCycles(uInjDig[k] - uInjIdealNow[k]);
  }

  const ePairDig = ePair(uFbDig, uInjDig, cfg.r_zero, g);
  const ePairAn = ePair(uFbAn, uInjAn, cfg.r_zero, g);

  // deterministic hardware zero-crossing error (sections 5.1, 14)
  const eZcHw = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    eZcHw[k] = wrapCycles(xId[k] + uInjAn[k] - cfg.z0_cycles);
  }

  // applied-domain divider command n_int (padded to n with last value)
  const iApplied = gather(fb.I_FB, idx);
  const nInt = new Float64Array(Math.max(n, 1));
  if (n > 1) {
    for (let k = 0; k < n - 1; k++) {
      nInt[k] = iApplied[k + 1] - iApplied[k];
    }
    nInt[n - 1] = nInt[n - 2];
  }

  // --- injection dynamics (section 14) ---
  const dyn = runDynamics(cfg, eZcHw, streams);

  const toF64 = (a: ArrayLike<number>): Float64Array => Float64Array.from(a as ArrayLike<number>);

  const data: Record<ColumnName, Float64Array> = {
    k: ks,
    s_ideal: sId,
    x_ideal: xId,
    A_ideal: aId,
    A_FB: gather(fb.A_FB, idx),
    I_FB: iApplied,
    R_FB: gather(fb.R_FB, idx),
    m_FB: gather(fb.m_FB, idx),
    c_FB: gather(fb.c_FB, idx),
    n_int: nInt,
    u_FB_ideal: xId,
    u_FB_digital: uFbDig,
    u_FB_analog: uFbAn,
    e_FB_abs: eFbAbs,
    dsm_state: gather(fb.dsm_state, idx),
    dsm_out: gather(fb.dsm_out, idx),
    u_INJ_ideal: uInjIdealNow,
    R_INJ: gather(inj.R_INJ, idx),
    j_INJ: gather(inj.j_INJ, idx),
    c_INJ: gather(inj.c_INJ, idx),
    u_INJ_digital: uInjDig,
    u_INJ_analog: uInjAn,
    e_INJ_abs: eInjAbs,
    e_pair_digital: ePairDig,
    e_pair_analog: ePairAn,
    e_ZC_hw: eZcHw,
    theta_minus: dyn.theta_minus,
    e_inj: dyn.e_inj,
    delta_theta: dyn.delta_theta,
    theta_plus: dyn.theta_plus,
    e_ZC_total: dyn.e_ZC_total,
    seq_id: toF64(lat.seq_id),
    k_computed: toF64(lat.k_computed),
    k_applied: toF64(lat.k_applied),
  };

  return {
    config: cfg,
    t_vco_s: configTVcoS(cfg),
    t_ref_s: configTRefS(cfg),
    g,
    data,
    columns: [...COLUMNS],
    metadata: lat.metadata,
  };
}
