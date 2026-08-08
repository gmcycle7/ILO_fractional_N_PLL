"""Physical constants, unit conversions and derived quantities.

Contract: MODEL_SPEC.md sections 1, 9, 11.
Internal phase unit everywhere else in the model is VCO cycles (float64):
1 cycle = 2*pi rad = T_vco seconds = 360 degrees.
"""

# --- SI prefixes (seconds) ---
FS = 1e-15
PS = 1e-12
NS = 1e-9

# --- frequency ---
HZ = 1.0
KHZ = 1e3
MHZ = 1e6
GHZ = 1e9

# canonical defaults (MODEL_SPEC section 1)
DEFAULT_F_REF_HZ = 4e9
DEFAULT_B_DTC = 6
DEFAULT_N_TAP = 8
DEFAULT_N_PMUX = 4


def g_fine(n_pmux: int = DEFAULT_N_PMUX, b_dtc: int = DEFAULT_B_DTC) -> int:
    """Fine phase units per T_vco: G = N_PMUX * 2^B_DTC (= 256 default)."""
    return n_pmux * (1 << b_dtc)


def t_ref_s(f_ref_hz: float = DEFAULT_F_REF_HZ) -> float:
    """Reference period in seconds."""
    return 1.0 / f_ref_hz


def f_vco_hz(n_div: float, f_ref_hz: float = DEFAULT_F_REF_HZ) -> float:
    """VCO frequency f_vco = N * f_ref."""
    return n_div * f_ref_hz


def t_vco(n_div: float, f_ref_hz: float = DEFAULT_F_REF_HZ) -> float:
    """VCO period in seconds: T_vco = 1 / (N * f_ref)."""
    return 1.0 / (n_div * f_ref_hz)


# alias used throughout
t_vco_s = t_vco


def dtc_lsb_s(n_div: float, f_ref_hz: float = DEFAULT_F_REF_HZ,
              dtc_mode: str = "normalized", dtc_lsb_fs: float = 312.5,
              g: int = 256) -> float:
    """DTC LSB in seconds.

    normalized : T_vco / G   (phase LSB constant 360/G degrees)
    fixed_time : dtc_lsb_fs femtoseconds, independent of f_vco
    """
    if dtc_mode == "normalized":
        return t_vco(n_div, f_ref_hz) / g
    if dtc_mode == "fixed_time":
        return dtc_lsb_fs * FS
    raise ValueError("dtc_mode must be 'normalized' or 'fixed_time'")


def dtc_lsb_cycles(n_div: float, f_ref_hz: float = DEFAULT_F_REF_HZ,
                   dtc_mode: str = "normalized", dtc_lsb_fs: float = 312.5,
                   g: int = 256) -> float:
    """DTC LSB in VCO cycles (normalized: exactly 1/G)."""
    if dtc_mode == "normalized":
        return 1.0 / g
    if dtc_mode == "fixed_time":
        return (dtc_lsb_fs * FS) / t_vco(n_div, f_ref_hz)
    raise ValueError("dtc_mode must be 'normalized' or 'fixed_time'")


def phase_lsb_deg(g: int = 256, n_div: float | None = None,
                  f_ref_hz: float = DEFAULT_F_REF_HZ,
                  dtc_mode: str = "normalized", dtc_lsb_fs: float = 312.5) -> float:
    """Phase LSB in degrees. normalized: 360/G (=1.40625 for G=256).
    fixed_time: 360 * Delta_t / T_vco (requires n_div)."""
    if dtc_mode == "normalized":
        return 360.0 / g
    if n_div is None:
        raise ValueError("n_div required for fixed_time phase LSB")
    return 360.0 * (dtc_lsb_fs * FS) / t_vco(n_div, f_ref_hz)


def seconds_to_fs(t: float) -> float:
    return t / FS


def fs_to_seconds(t_fs: float) -> float:
    return t_fs * FS


def seconds_to_ps(t: float) -> float:
    return t / PS


def seconds_to_ns(t: float) -> float:
    return t / NS


def hz_to_ghz(f: float) -> float:
    return f / GHZ
