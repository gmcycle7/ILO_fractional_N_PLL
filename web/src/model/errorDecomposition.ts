/**
 * Error decomposition per MODEL_SPEC.md section 16.
 * Mirror of model/python/error_decomposition.py.
 *
 * Runs a baseline (all-ideal analog / no latency / no noise, digital
 * quantization kept) and re-runs with each nonideality term enabled alone;
 * each term's contribution is the rms of the per-cycle delta of e_ZC_total
 * relative to the baseline.  The jointly-simulated total is also reported.
 *
 * Additivity is APPROXIMATE (linear regime only, spec [APPROX]) — the report
 * includes both the individual contributions and the joint total so the
 * difference is visible.
 */

import type { SimConfig } from './config';
import { replaceConfig } from './config';
import * as meas from './measurements';
import type { ColumnName } from './simulate';
import { simulate } from './simulate';

/** term name -> config fields it carries over from the full config */
const TERMS: Record<string, (keyof SimConfig)[]> = {
  tap_mismatch: ['tap_mismatch_cycles'],
  pmux_mismatch: ['pmux_mismatch_cycles'],
  dtc_gain: ['dtc_fb_gain', 'dtc_inj_gain'],
  dtc_offset: ['dtc_fb_offset_cycles', 'dtc_inj_offset_cycles'],
  dtc_inl: ['inl_sin_amp_cycles', 'inl_poly', 'inl_lut'],
  dtc_dnl: ['dnl_sigma_lsb'],
  route: ['route_fb_cycles', 'route_inj_cycles'],
  ref_jitter: ['sigma_ref_s'],
  vco_noise: ['sigma_vco_w_rad', 'sigma_vco_rw_rad'],
  pulse_noise: ['sigma_pulse_s'],
  latency: ['latency_cycles', 'lookahead', 'p_late'],
};

function idealOverrides(cfg: SimConfig): Partial<SimConfig> {
  return {
    tap_mismatch_cycles: new Array<number>(cfg.n_tap).fill(0.0),
    pmux_mismatch_cycles: new Array<number>(cfg.n_pmux).fill(0.0),
    dtc_fb_gain: 1.0,
    dtc_inj_gain: 1.0,
    dtc_fb_offset_cycles: 0.0,
    dtc_inj_offset_cycles: 0.0,
    inl_sin_amp_cycles: 0.0,
    inl_poly: [0.0, 0.0],
    inl_lut: null,
    dnl_sigma_lsb: 0.0,
    route_fb_cycles: 0.0,
    route_inj_cycles: 0.0,
    sigma_ref_s: 0.0,
    sigma_vco_w_rad: 0.0,
    sigma_vco_rw_rad: 0.0,
    sigma_pulse_s: 0.0,
    latency_cycles: 0,
    lookahead: true,
    p_late: 0.0,
  };
}

export interface Decomposition {
  signal: string;
  baseline_rms_cycles: number;
  contributions: Record<string, number>;
  sum_of_contributions_rms: number;
  joint_total_rms_cycles: number;
  additivity_gap_cycles: number;
}

function rmsDelta(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const d = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    d[i] = a[i] - b[i];
  }
  return meas.rms(d);
}

/** Per-term error decomposition of `signal` (default e_ZC_total). */
export function decompose(cfg: SimConfig, signal: ColumnName = 'e_ZC_total'): Decomposition {
  const ideal = idealOverrides(cfg);
  const baseCfg = replaceConfig(cfg, ideal);
  const base = simulate(baseCfg).data[signal];

  const contributions: Record<string, number> = {};
  const fullDict = cfg as unknown as Record<string, unknown>;
  for (const [term, fields] of Object.entries(TERMS)) {
    const over: Record<string, unknown> = { ...ideal };
    for (const f of fields) {
      over[f] = fullDict[f];
    }
    const termCfg = replaceConfig(cfg, over as Partial<SimConfig>);
    const x = simulate(termCfg).data[signal];
    contributions[term] = rmsDelta(x, base);
  }

  const joint = simulate(cfg).data[signal];
  const jointRms = rmsDelta(joint, base);
  let ss = 0.0;
  for (const v of Object.values(contributions)) {
    ss += v * v;
  }
  const rss = Math.sqrt(ss);

  return {
    signal,
    baseline_rms_cycles: meas.rms(base),
    contributions,
    sum_of_contributions_rms: rss,
    joint_total_rms_cycles: jointRms,
    additivity_gap_cycles: jointRms - rss,
  };
}
