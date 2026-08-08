/**
 * The 20 canonical numerical experiments.
 * Mirror of model/python/experiments.py — SAME ids and configs.
 *
 * Each entry: id, name_zh, name_en, description, config (single SimConfig)
 * or configs (list, for comparisons), expected_result.
 *
 * Preset alias 'n3p13_shared_reverse' = exp06-style config
 * (N=3.13, mode D, nearest, L=1, lookahead).
 */

import type { SimConfig } from './config';
import { fromPartial } from './config';

const ALPHA_0P3 = 3.0 + 32.3 / 256.0; // frac fine code offset 0.3 LSB (base 32)
const DEG = 1.0 / 360.0; // 1 degree in cycles

function mk(kw: Partial<SimConfig>): SimConfig {
  return fromPartial(kw);
}

export interface Experiment {
  id: string;
  name_zh: string;
  name_en: string;
  description: string;
  config?: SimConfig;
  configs?: SimConfig[];
  expected_result: string;
}

export const EXPERIMENTS: Experiment[] = [
  {
    id: 'exp01',
    name_zh: '格點上 N=3.000',
    name_en: 'On-grid N=3.000',
    description:
      'Integer N: trajectory lands exactly on the phase grid; ' +
      'all scheduler errors are identically zero.',
    config: mk({ n_div: 3.0 }),
    expected_result: 'e_FB_abs == 0, e_INJ_abs == 0, e_pair == 0; static codes.',
  },
  {
    id: 'exp02',
    name_zh: 'N=3.125 每拍 45 度旋轉',
    name_en: 'N=3.125 45-degree rotation',
    description:
      'alpha=1/8: injection tap rotates backward exactly one ' +
      'tap (45 deg) per reference cycle; on-grid so exact.',
    config: mk({ n_div: 3.125 }),
    expected_result: 'e_FB_abs == 0; j_INJ steps -1 tap/cycle; e_pair == 0.',
  },
  {
    id: 'exp03',
    name_zh: 'N=3.130 nearest 量化',
    name_en: 'N=3.130 nearest quantizer',
    description:
      'Off-grid alpha=0.13 with half-up nearest quantizer; ' +
      'bounded +/-0.5 LSB scheduling error.',
    config: mk({ n_div: 3.13, quantizer: 'nearest' }),
    expected_result: '|e_FB_abs| <= 0.5 LSB = 156.25 fs; e_pair_digital == 0 (mode D).',
  },
  {
    id: 'exp04',
    name_zh: 'N=3.130 共享相位狀態 (mode C)',
    name_en: 'N=3.130 shared phase state (mode C)',
    description:
      'Both paths derive from the shared master accumulator ' +
      'A_ideal but quantize independently.',
    config: mk({ n_div: 3.13, arch_mode: 'C' }),
    expected_result:
      'Average behavior correct; pair error can be nonzero ' +
      '(independent quantizers), unlike mode D.',
  },
  {
    id: 'exp05',
    name_zh: 'N=3.130 獨立 DSM (mode B)',
    name_en: 'N=3.130 independent DSMs (mode B)',
    description:
      'Two independent ef1 DSMs (own state) for FB and INJ; ' +
      'correct on average, wrong cycle-by-cycle reverse.',
    config: mk({ n_div: 3.13, arch_mode: 'B', quantizer: 'ef1' }),
    expected_result: 'e_pair_digital nonzero on many cycles (not recommended).',
  },
  {
    id: 'exp06',
    name_zh: 'N=3.130 一次量化模組化反向 (mode D)',
    name_en: 'N=3.130 quantize-once modular reverse (mode D)',
    description:
      'Recommended architecture: R_INJ=(R_zero-R_FB) mod 256, ' +
      'with L=1 look-ahead pipeline.',
    config: mk({
      n_div: 3.13,
      arch_mode: 'D',
      quantizer: 'nearest',
      latency_cycles: 1,
      lookahead: true,
    }),
    expected_result:
      'e_pair_digital == 0 exactly for every cycle; look-ahead removes the latency error.',
  },
  {
    id: 'exp07',
    name_zh: '0.3-LSB 固定捨入 (nearest)',
    name_en: '0.3-LSB fixed rounding',
    description:
      'alpha = 32.3/256 puts the fine-code fractional offset ' +
      'on a 0.3-LSB grid; nearest rounding leaves a ' +
      'deterministic sub-LSB error pattern.',
    config: mk({ n_div: ALPHA_0P3, quantizer: 'nearest' }),
    expected_result:
      '|e_FB_abs| <= 0.5 LSB, deterministic periodic pattern ' +
      'from the 0.3-LSB grid offset (spur, not noise).',
  },
  {
    id: 'exp08',
    name_zh: '0.3-LSB ef1 DSM',
    name_en: '0.3-LSB ef1 DSM',
    description:
      'Same 0.3-LSB grid offset with first-order error-feedback ' +
      'DSM: long-term mean error -> 0, larger instantaneous peaks.',
    config: mk({ n_div: ALPHA_0P3, quantizer: 'ef1' }),
    expected_result:
      'mean(e_FB_abs) -> 0; instantaneous error peaks grow to ' +
      '~1 LSB (noise shaping trades DC for peaks).',
  },
  {
    id: 'exp09',
    name_zh: '共享 vs 獨立 phase DSM',
    name_en: 'Shared vs independent phase DSM',
    description:
      'Mode D (quantize once, shared code) vs mode B ' + '(independent DSMs), both ef1, N=3.13.',
    configs: [
      mk({ n_div: 3.13, arch_mode: 'D', quantizer: 'ef1' }),
      mk({ n_div: 3.13, arch_mode: 'B', quantizer: 'ef1' }),
    ],
    expected_result:
      'Mode D: e_pair_digital == 0; mode B: e_pair_digital != 0 on many cycles (Test 13).',
  },
  {
    id: 'exp10',
    name_zh: 'latency bug L=1 無 look-ahead (alpha=0.13)',
    name_en: 'Latency bug L=1 no lookahead alpha=0.13',
    description: 'Command computed at k applied at k+1 without look-ahead: ' + 'stale phase state.',
    config: mk({ n_div: 3.13, latency_cycles: 1, lookahead: false }),
    expected_result:
      'Phase error wrapCycles(L*alpha) = 0.13 cycle = 46.8 deg ' + '(66.6x half-LSB).',
  },
  {
    id: 'exp11',
    name_zh: 'look-ahead 修正',
    name_en: 'Lookahead correction',
    description: 'Same L=1 pipeline with correct look-ahead x[k+L] = ' + 'wrap01(x[k] + L*alpha).',
    config: mk({ n_div: 3.13, latency_cycles: 1, lookahead: true }),
    expected_result: 'Latency error removed; only quantization error remains ' + '(<= half-LSB).',
  },
  {
    id: 'exp12',
    name_zh: '1 度 tap mismatch',
    name_en: '1-degree tap mismatch',
    description:
      'All 8 injection taps offset by +1 deg (1/360 cycle) at ' + 'N=3.125 (T_vco=80 ps).',
    config: mk({ n_div: 3.125, tap_mismatch_cycles: new Array<number>(8).fill(DEG) }),
    expected_result: 'Static e_ZC_hw = 222.22 fs = 0.711 LSB > half-LSB ' + '156.25 fs (Test 6).',
  },
  {
    id: 'exp13',
    name_zh: '1% DTC gain mismatch',
    name_en: '1 percent DTC gain mismatch',
    description:
      'FB DTC gain 1.00, INJ DTC gain 1.01 at N=3.125 ' + '(DTC full range T_vco/4 = 20 ps).',
    config: mk({ n_div: 3.125, dtc_fb_gain: 1.0, dtc_inj_gain: 1.01 }),
    expected_result:
      'Code-dependent error up to ~200 fs at full range ' + '(0.64 LSB), > half-LSB (Test 7).',
  },
  {
    id: 'exp14',
    name_zh: 'DTC 正弦 INL',
    name_en: 'DTC sinusoidal INL',
    description:
      'Sinusoidal INL inl_a*sin(2*pi*c/64) with amplitude ' + '0.5 LSB on both DTCs, N=3.13.',
    config: mk({ n_div: 3.13, inl_sin_amp_cycles: 0.5 / 256.0 }),
    expected_result:
      'Code-periodic deterministic error -> fractional spurs ' + 'in the e_ZC spectrum.',
  },
  {
    id: 'exp15',
    name_zh: '弱 vs 強 injection (K=0.05 vs 0.6)',
    name_en: 'Weak vs strong injection (k_inj 0.05 vs 0.6)',
    description:
      'Sinusoidal injection map with 1 MHz detuning and VCO ' + 'white noise; K_inj = 0.05 vs 0.6.',
    configs: [
      mk({
        n_div: 3.125,
        inj_model: 'sin',
        k_inj: 0.05,
        delta_f_hz: 1e6,
        sigma_vco_w_rad: 0.01,
      }),
      mk({
        n_div: 3.125,
        inj_model: 'sin',
        k_inj: 0.6,
        delta_f_hz: 1e6,
        sigma_vco_w_rad: 0.01,
      }),
    ],
    expected_result:
      'Larger K_inj: faster convergence and smaller ' + 'steady-state residual rms (Test 14).',
  },
  {
    id: 'exp16',
    name_zh: '固定 vs 週期 vs 隨機誤差',
    name_en: 'Fixed vs periodic vs random error',
    description:
      'Fixed route offset (2 LSB) vs periodic quantization ' +
      'error (N=3.13) vs random reference jitter (100 fs rms), ' +
      'all through a linear injection map.',
    configs: [
      mk({
        n_div: 3.125,
        route_inj_cycles: 2.0 / 256.0,
        inj_model: 'linear',
        k_inj: 0.3,
      }),
      mk({ n_div: 3.13, quantizer: 'nearest', inj_model: 'linear', k_inj: 0.3 }),
      mk({ n_div: 3.125, sigma_ref_s: 100e-15, inj_model: 'linear', k_inj: 0.3 }),
    ],
    expected_result:
      'Fixed -> static phase offset; periodic -> ' +
      'deterministic spur; random -> phase-noise floor ' +
      '(spec section 15).',
  },
  {
    id: 'exp17',
    name_zh: '無 vs 理想 vs 現實 injection',
    name_en: 'No vs ideal vs realistic injection',
    description:
      'inj_model none vs reset vs sin (K=0.3) with 1 MHz ' +
      'detuning and VCO white noise, N=3.13.',
    configs: [
      mk({ n_div: 3.13, inj_model: 'none', delta_f_hz: 1e6, sigma_vco_w_rad: 0.02 }),
      mk({ n_div: 3.13, inj_model: 'reset', delta_f_hz: 1e6, sigma_vco_w_rad: 0.02 }),
      mk({
        n_div: 3.13,
        inj_model: 'sin',
        k_inj: 0.3,
        delta_f_hz: 1e6,
        sigma_vco_w_rad: 0.02,
      }),
    ],
    expected_result:
      'none: unbounded ramp/random walk; reset: residual = ' +
      'per-cycle error only; sin: bounded residual near ' +
      'asin fixed point.',
  },
  {
    id: 'exp18',
    name_zh: 'normalized vs fixed-time DTC 12-13 GHz 掃描',
    name_en: 'Normalized vs fixed-time DTC sweep 12-13 GHz',
    description:
      'N in {3.0, 3.125, 3.25} (12/12.5/13 GHz) with ' + 'normalized vs fixed-time (312.5 fs) DTC LSB.',
    configs: [
      mk({ n_div: 3.0, dtc_mode: 'normalized' }),
      mk({ n_div: 3.0, dtc_mode: 'fixed_time' }),
      mk({ n_div: 3.125, dtc_mode: 'normalized' }),
      mk({ n_div: 3.125, dtc_mode: 'fixed_time' }),
      mk({ n_div: 3.25, dtc_mode: 'normalized' }),
      mk({ n_div: 3.25, dtc_mode: 'fixed_time' }),
    ],
    expected_result:
      'normalized: phase LSB constant 1.40625 deg; ' +
      'fixed_time: phase LSB scales with f_vco ' +
      '(325.5/312.5/300.5 fs table, spec section 11).',
  },
  {
    id: 'exp19',
    name_zh: 'naive vs calibrated mapping(含 mismatch)',
    name_en: 'Naive vs calibrated mapping with mismatch',
    description:
      'Per-tap mismatch (+/-1 deg pattern) + 1% INJ DTC gain; ' +
      'naive floor decode vs calibrated joint (j,c) ' +
      'optimization, N=3.13.',
    configs: [
      mk({
        n_div: 3.13,
        inj_mapping: 'naive',
        dtc_inj_gain: 1.01,
        tap_mismatch_cycles: [0.0, DEG, -DEG, 0.5 * DEG, -0.5 * DEG, DEG, -DEG, 0.5 * DEG],
      }),
      mk({
        n_div: 3.13,
        inj_mapping: 'calibrated',
        dtc_inj_gain: 1.01,
        tap_mismatch_cycles: [0.0, DEG, -DEG, 0.5 * DEG, -0.5 * DEG, DEG, -DEG, 0.5 * DEG],
      }),
    ],
    expected_result:
      'Calibrated mapping reduces rms analog injection ' +
      'placement error vs naive (uses redundancy).',
  },
  {
    id: 'exp20',
    name_zh: 'DSM 位元流 vs 累積相位狀態',
    name_en: 'DSM-bit-only vs accumulated state',
    description:
      'Mode D quantizes the accumulated absolute code once ' +
      '(shared); mode A re-quantizes the wrapped per-cycle ' +
      'target with an independent ef1 state (bit-stream view).',
    configs: [
      mk({ n_div: 3.13, arch_mode: 'D', quantizer: 'ef1' }),
      mk({ n_div: 3.13, arch_mode: 'A', quantizer: 'ef1' }),
    ],
    expected_result:
      'Accumulated/shared state keeps the exact modular ' +
      'reverse pairing; bit-only independent state does not.',
  },
];

/** id -> experiment (plus the alias preset) */
export const PRESETS: Record<string, Experiment> = {};
for (const e of EXPERIMENTS) {
  PRESETS[e.id] = e;
}
PRESETS['n3p13_shared_reverse'] = {
  id: 'n3p13_shared_reverse',
  name_zh: 'N=3.13 共享反向碼 preset',
  name_en: 'N=3.13 shared reverse-code preset',
  description:
    'Alias of the exp06-style recommended configuration: ' +
    'N=3.13, mode D, nearest, L=1 with look-ahead.',
  config: mk({
    n_div: 3.13,
    arch_mode: 'D',
    quantizer: 'nearest',
    latency_cycles: 1,
    lookahead: true,
  }),
  expected_result: 'e_pair_digital == 0 exactly; latency fully compensated.',
};

export function getPreset(presetId: string): Experiment {
  const p = PRESETS[presetId];
  if (p === undefined) {
    throw new Error(`unknown preset '${presetId}'`);
  }
  return p;
}

/** Normalized list of configs for a preset (single or comparison). */
export function presetConfigs(preset: Experiment): SimConfig[] {
  if (preset.configs !== undefined) {
    return [...preset.configs];
  }
  return [preset.config as SimConfig];
}
