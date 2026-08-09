/**
 * Simulation configuration.
 *
 * Contract: MODEL_SPEC.md sections 1, 6, 7, 8, 10, 11, 13, 14 and
 * ASSUMPTIONS.md.  Mirror of model/python/config.py.  Field names are the
 * exact snake_case names of the Python dataclass so the JSON test-vector
 * configs (MODEL_SPEC section 18) round-trip without translation.
 */

export type Quantizer = 'floor' | 'nearest' | 'truncate' | 'ef1' | 'mash11' | 'mash111';
export type ArchMode = 'A' | 'B' | 'C' | 'D';
export type InjMapping = 'naive' | 'nearest' | 'calibrated';
export type DtcModeName = 'normalized' | 'fixed_time';
export type InjModel = 'none' | 'reset' | 'linear' | 'sin' | 'lut';
export type ActuatorMode = 'full' | 'dsm_only';
export type InjGateMode = 'off' | 'threshold';

const QUANTIZERS: readonly string[] = ['floor', 'nearest', 'truncate', 'ef1', 'mash11', 'mash111'];
const ARCH_MODES: readonly string[] = ['A', 'B', 'C', 'D'];
const INJ_MAPPINGS: readonly string[] = ['naive', 'nearest', 'calibrated'];
const DTC_MODES: readonly string[] = ['normalized', 'fixed_time'];
const INJ_MODELS: readonly string[] = ['none', 'reset', 'linear', 'sin', 'lut'];
const ACTUATOR_MODES: readonly string[] = ['full', 'dsm_only'];
const INJ_GATE_MODES: readonly string[] = ['off', 'threshold'];

export interface SimConfig {
  // --- core system (MODEL_SPEC section 1) ---
  f_ref_hz: number; // reference frequency [ASSUMPTION A1]
  n_div: number; // fractional divide ratio N = 3 + alpha
  n_cycles: number; // number of reference cycles simulated
  s0: number; // initial absolute phase coordinate (cycles)
  b_dtc: number; // DTC bits (both paths)
  n_tap: number; // injection taps (45 deg spacing) [A2]
  n_pmux: number; // feedback PMUX phases [A3]
  z0_cycles: number; // desired injection zero-crossing phase [A5]
  r_zero: number; // modular-reverse digital zero offset [A6]

  // --- digital scheduler ---
  quantizer: Quantizer; // floor|nearest|truncate|ef1|mash11|mash111 [B5]
  dither_amp_lsb: number; // triangular dither amplitude (quantizer LSB), pre-quantize
  arch_mode: ArchMode; // A|B|C|D (section 7; D = quantize once + modular reverse)
  actuator_mode: ActuatorMode; // full|dsm_only (section 7.1)
  inj_mapping: InjMapping; // naive|nearest|calibrated (section 8)
  dtc_mode: DtcModeName; // normalized|fixed_time (section 11)
  dtc_lsb_fs: number; // fixed_time DTC LSB in fs [B2]
  latency_cycles: number; // fixed digital latency L (reference cycles) [B3]
  lookahead: boolean; // true = correct look-ahead; false = bug mode (section 13)
  seed: number; // base PRNG seed (section 12)

  // --- analog nonidealities (section 10, all cycles unless noted) ---
  tap_mismatch_cycles: number[];
  pmux_mismatch_cycles: number[];
  dtc_fb_gain: number;
  dtc_inj_gain: number;
  dtc_fb_offset_cycles: number;
  dtc_inj_offset_cycles: number;
  inl_sin_amp_cycles: number; // inl_a * sin(2*pi*c/64)
  inl_poly: number[]; // [p2, p3]
  inl_lut: number[] | null; // 64-entry LUT (cycles)
  dnl_sigma_lsb: number; // per-code random step (frozen)
  route_fb_cycles: number;
  route_inj_cycles: number;
  sigma_ref_s: number; // reference jitter rms (seconds)
  sigma_vco_w_rad: number; // VCO white phase step per ref cycle (rad)
  sigma_vco_rw_rad: number; // VCO random-walk (rad/sqrt(cycle))
  p_late: number; // probability of +1 cycle random latency
  sigma_pulse_s: number; // injection pulse timing noise (seconds)

  // --- injection dynamics (section 14) ---
  inj_model: InjModel; // none|reset|linear|sin|lut
  k_inj: number; // lumped injection strength, [0, 1]
  delta_f_hz: number; // VCO free-running detuning vs N*f_ref
  pdr_lut: number[][] | null; // [[e_rad, dtheta_rad], ...]
  inj_gate_mode: InjGateMode; // off|threshold (section 14 gating)
  inj_gate_threshold_cycles: number; // fire iff |e_ZC_hw| <= threshold
}

/** Spec defaults (identical to the Python dataclass defaults). */
export function defaultConfig(): SimConfig {
  return {
    f_ref_hz: 4e9,
    n_div: 3.125,
    n_cycles: 512,
    s0: 0.0,
    b_dtc: 6,
    n_tap: 8,
    n_pmux: 4,
    z0_cycles: 0.0,
    r_zero: 0,
    quantizer: 'nearest',
    dither_amp_lsb: 0.0,
    arch_mode: 'D',
    actuator_mode: 'full',
    inj_mapping: 'naive',
    dtc_mode: 'normalized',
    dtc_lsb_fs: 312.5,
    latency_cycles: 0,
    lookahead: true,
    seed: 12345,
    tap_mismatch_cycles: [0, 0, 0, 0, 0, 0, 0, 0],
    pmux_mismatch_cycles: [0, 0, 0, 0],
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
    p_late: 0.0,
    sigma_pulse_s: 0.0,
    inj_model: 'none',
    k_inj: 0.3,
    delta_f_hz: 0.0,
    pdr_lut: null,
    inj_gate_mode: 'off',
    inj_gate_threshold_cycles: 0.0625,
  };
}

/** Validation identical to SimConfig.__post_init__ in Python. */
export function validateConfig(cfg: SimConfig): SimConfig {
  if (!QUANTIZERS.includes(cfg.quantizer)) {
    throw new Error(`quantizer must be one of ${QUANTIZERS.join(', ')}`);
  }
  if (!ARCH_MODES.includes(cfg.arch_mode)) {
    throw new Error(`arch_mode must be one of ${ARCH_MODES.join(', ')}`);
  }
  if (!INJ_MAPPINGS.includes(cfg.inj_mapping)) {
    throw new Error(`inj_mapping must be one of ${INJ_MAPPINGS.join(', ')}`);
  }
  if (!DTC_MODES.includes(cfg.dtc_mode)) {
    throw new Error(`dtc_mode must be one of ${DTC_MODES.join(', ')}`);
  }
  if (!INJ_MODELS.includes(cfg.inj_model)) {
    throw new Error(`inj_model must be one of ${INJ_MODELS.join(', ')}`);
  }
  if (!ACTUATOR_MODES.includes(cfg.actuator_mode)) {
    throw new Error(`actuator_mode must be one of ${ACTUATOR_MODES.join(', ')}`);
  }
  if (!INJ_GATE_MODES.includes(cfg.inj_gate_mode)) {
    throw new Error(`inj_gate_mode must be one of ${INJ_GATE_MODES.join(', ')}`);
  }
  if (cfg.tap_mismatch_cycles.length !== cfg.n_tap) {
    throw new Error('tap_mismatch_cycles must have n_tap entries');
  }
  if (cfg.pmux_mismatch_cycles.length !== cfg.n_pmux) {
    throw new Error('pmux_mismatch_cycles must have n_pmux entries');
  }
  if (cfg.inl_lut !== null && cfg.inl_lut.length !== 1 << cfg.b_dtc) {
    throw new Error('inl_lut must have 2^b_dtc entries');
  }
  return cfg;
}

/**
 * Build a validated SimConfig from a partial override of the defaults.
 * Unknown keys are ignored (mirror of SimConfig.from_dict).
 */
export function fromPartial(partial: Partial<SimConfig> = {}): SimConfig {
  const base = defaultConfig() as unknown as Record<string, unknown>;
  const src = partial as Record<string, unknown>;
  for (const key of Object.keys(base)) {
    if (key in src && src[key] !== undefined) {
      base[key] = src[key];
    }
  }
  const cfg = base as unknown as SimConfig;
  // deep-copy mutable arrays so callers can share partials safely
  cfg.tap_mismatch_cycles = [...cfg.tap_mismatch_cycles];
  cfg.pmux_mismatch_cycles = [...cfg.pmux_mismatch_cycles];
  cfg.inl_poly = [...cfg.inl_poly];
  cfg.inl_lut = cfg.inl_lut === null ? null : [...cfg.inl_lut];
  cfg.pdr_lut = cfg.pdr_lut === null ? null : cfg.pdr_lut.map((p) => [...p]);
  return validateConfig(cfg);
}

/** Mirror of SimConfig.replace(**kw). */
export function replaceConfig(cfg: SimConfig, overrides: Partial<SimConfig>): SimConfig {
  return fromPartial({ ...cfg, ...overrides });
}

// --- derived quantities (Python @property mirrors) ---

/** Fine phase units per T_vco: G = n_pmux * 2^b_dtc (default 256). */
export function configG(cfg: SimConfig): number {
  return cfg.n_pmux * (1 << cfg.b_dtc);
}

/** Fractional part of N (Python: n_div - int(n_div)). */
export function configAlpha(cfg: SimConfig): number {
  return cfg.n_div - Math.trunc(cfg.n_div);
}

export function configTRefS(cfg: SimConfig): number {
  return 1.0 / cfg.f_ref_hz;
}

export function configTVcoS(cfg: SimConfig): number {
  return 1.0 / (cfg.n_div * cfg.f_ref_hz);
}
