"""Simulation configuration.

Contract: MODEL_SPEC.md sections 1, 6, 7, 8, 10, 11, 13, 14 and ASSUMPTIONS.md.
All defaults are the spec defaults.  ``from_dict``/``to_dict`` round-trip
through JSON (used by the test-vector schema, section 18).
"""

from dataclasses import dataclass, field, fields, asdict
from typing import Optional, List

_QUANTIZERS = ("floor", "nearest", "truncate", "ef1", "mash11", "mash111")
_ARCH_MODES = ("A", "B", "C", "D")
_INJ_MAPPINGS = ("naive", "nearest", "calibrated")
_DTC_MODES = ("normalized", "fixed_time")
_INJ_MODELS = ("none", "reset", "linear", "sin", "lut")
_ACTUATOR_MODES = ("full", "dsm_only", "qnc")
_INJ_GATE_MODES = ("off", "threshold")
_LOOP_MODES = ("off", "pi")

#: fields added after the schema-v1 test vectors were committed; they are
#: omitted from to_dict() when they hold their defaults so every committed
#: schema-v1 vector JSON stays byte-identical (from_dict fills the defaults
#: back in, so the round-trip is still exact).
_SCHEMA_V2_FIELDS = ("actuator_mode", "inj_gate_mode",
                     "inj_gate_threshold_cycles")

#: fields added after the schema-v2 test vectors were committed; same
#: omit-at-default serialization rule (keeps v1 AND v2 vectors byte-identical).
_SCHEMA_V3_FIELDS = ("qnc_gain",)

#: PLL loop co-simulation fields (MODEL_SPEC section 14.1); same
#: omit-at-default serialization rule as the schema-v2/v3 fields.
_SCHEMA_V4_FIELDS = ("loop_mode", "loop_kp", "loop_ki")

_OMIT_DEFAULT_FIELDS = _SCHEMA_V2_FIELDS + _SCHEMA_V3_FIELDS + _SCHEMA_V4_FIELDS


@dataclass
class SimConfig:
    # --- core system (MODEL_SPEC section 1) ---
    f_ref_hz: float = 4e9          # reference frequency [ASSUMPTION A1]
    n_div: float = 3.125           # fractional divide ratio N = 3 + alpha
    n_cycles: int = 512            # number of reference cycles simulated
    s0: float = 0.0                # initial absolute phase coordinate (cycles)
    b_dtc: int = 6                 # DTC bits (both paths)
    n_tap: int = 8                 # injection taps (45 deg spacing) [A2]
    n_pmux: int = 4                # feedback PMUX phases [A3]
    z0_cycles: float = 0.0         # desired injection zero-crossing phase [A5]
    r_zero: int = 0                # modular-reverse digital zero offset [A6]

    # --- digital scheduler ---
    quantizer: str = "nearest"     # floor|nearest|truncate|ef1|mash11|mash111 [B5]
    dither_amp_lsb: float = 0.0    # triangular dither amplitude (quantizer LSB), pre-quantize
    arch_mode: str = "D"           # A|B|C|D (section 7; D = quantize once + modular reverse)
    actuator_mode: str = "full"    # full|dsm_only|qnc (sections 7.1, 7.2;
                                   # dsm_only = classic divider-modulating DSM,
                                   # integer-cycle quantization, no fractional
                                   # actuator; qnc = dsm_only divider + DTC
                                   # quantization-noise cancellation)
    qnc_gain: float = 1.0          # QNC cancellation-DTC gain (section 7.2;
                                   # only used when actuator_mode == 'qnc')
    inj_mapping: str = "naive"     # naive|nearest|calibrated (section 8)
    dtc_mode: str = "normalized"   # normalized|fixed_time (section 11)
    dtc_lsb_fs: float = 312.5      # fixed_time DTC LSB in fs [B2]
    latency_cycles: int = 0        # fixed digital latency L (reference cycles) [B3]
    lookahead: bool = True         # True = correct look-ahead; False = bug mode (section 13)
    seed: int = 12345              # base PRNG seed (section 12)

    # --- analog nonidealities (section 10, all cycles unless noted) ---
    tap_mismatch_cycles: List[float] = field(default_factory=lambda: [0.0] * 8)
    pmux_mismatch_cycles: List[float] = field(default_factory=lambda: [0.0] * 4)
    dtc_fb_gain: float = 1.0
    dtc_inj_gain: float = 1.0
    dtc_fb_offset_cycles: float = 0.0
    dtc_inj_offset_cycles: float = 0.0
    inl_sin_amp_cycles: float = 0.0            # inl_a * sin(2*pi*c/64)
    inl_poly: List[float] = field(default_factory=lambda: [0.0, 0.0])  # [p2, p3]
    inl_lut: Optional[List[float]] = None       # 64-entry LUT (cycles)
    dnl_sigma_lsb: float = 0.0                  # per-code random step (frozen)
    route_fb_cycles: float = 0.0
    route_inj_cycles: float = 0.0
    sigma_ref_s: float = 0.0                    # reference jitter rms (seconds)
    sigma_vco_w_rad: float = 0.0                # VCO white phase step per ref cycle (rad)
    sigma_vco_rw_rad: float = 0.0               # VCO random-walk (rad/sqrt(cycle))
    p_late: float = 0.0                         # probability of +1 cycle random latency
    sigma_pulse_s: float = 0.0                  # injection pulse timing noise (seconds)

    # --- injection dynamics (section 14) ---
    inj_model: str = "none"        # none|reset|linear|sin|lut
    k_inj: float = 0.3             # lumped injection strength, [0, 1]
    delta_f_hz: float = 0.0        # VCO free-running detuning vs N*f_ref
    pdr_lut: Optional[List[List[float]]] = None  # [[e_rad, dtheta_rad], ...]
    inj_gate_mode: str = "off"     # off|threshold (section 14 gating)
    inj_gate_threshold_cycles: float = 0.0625  # fire iff |e_ZC_hw| <= threshold

    # --- PLL loop co-simulation (section 14.1) ---
    loop_mode: str = "off"         # off|pi (behavioral type-II PI loop) [B8]
    loop_kp: float = 0.05          # proportional gain (dimensionless)
    loop_ki: float = 0.005         # integral gain (dimensionless)

    # ------------------------------------------------------------------
    def __post_init__(self):
        if self.quantizer not in _QUANTIZERS:
            raise ValueError(f"quantizer must be one of {_QUANTIZERS}")
        if self.arch_mode not in _ARCH_MODES:
            raise ValueError(f"arch_mode must be one of {_ARCH_MODES}")
        if self.inj_mapping not in _INJ_MAPPINGS:
            raise ValueError(f"inj_mapping must be one of {_INJ_MAPPINGS}")
        if self.dtc_mode not in _DTC_MODES:
            raise ValueError(f"dtc_mode must be one of {_DTC_MODES}")
        if self.inj_model not in _INJ_MODELS:
            raise ValueError(f"inj_model must be one of {_INJ_MODELS}")
        if self.actuator_mode not in _ACTUATOR_MODES:
            raise ValueError(f"actuator_mode must be one of {_ACTUATOR_MODES}")
        if self.inj_gate_mode not in _INJ_GATE_MODES:
            raise ValueError(f"inj_gate_mode must be one of {_INJ_GATE_MODES}")
        if self.loop_mode not in _LOOP_MODES:
            raise ValueError(f"loop_mode must be one of {_LOOP_MODES}")
        if len(self.tap_mismatch_cycles) != self.n_tap:
            raise ValueError("tap_mismatch_cycles must have n_tap entries")
        if len(self.pmux_mismatch_cycles) != self.n_pmux:
            raise ValueError("pmux_mismatch_cycles must have n_pmux entries")
        if self.inl_lut is not None and len(self.inl_lut) != (1 << self.b_dtc):
            raise ValueError("inl_lut must have 2^b_dtc entries")

    # --- derived quantities ---
    @property
    def g(self) -> int:
        """Fine phase units per T_vco: G = n_pmux * 2^b_dtc (default 256)."""
        return self.n_pmux * (1 << self.b_dtc)

    @property
    def alpha(self) -> float:
        """Fractional part of N."""
        return self.n_div - int(self.n_div)

    @property
    def t_ref_s(self) -> float:
        return 1.0 / self.f_ref_hz

    @property
    def t_vco_s(self) -> float:
        return 1.0 / (self.n_div * self.f_ref_hz)

    # --- JSON round-trip ---
    def to_dict(self) -> dict:
        """Full config dict, minus schema-v2/v3/v4 fields at their default
        values (keeps the committed earlier-schema test vectors byte-identical;
        ``from_dict`` restores the defaults so the round-trip is exact)."""
        d = asdict(self)
        defaults = _OMIT_DEFAULT_DEFAULTS
        for name in _OMIT_DEFAULT_FIELDS:
            if d[name] == defaults[name]:
                del d[name]
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "SimConfig":
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in names})

    def replace(self, **kw) -> "SimConfig":
        d = self.to_dict()
        d.update(kw)
        return SimConfig.from_dict(d)


#: default values of the schema-v2/v3/v4 fields (see _OMIT_DEFAULT_FIELDS / to_dict)
_OMIT_DEFAULT_DEFAULTS = {f.name: f.default for f in fields(SimConfig)
                          if f.name in _OMIT_DEFAULT_FIELDS}
