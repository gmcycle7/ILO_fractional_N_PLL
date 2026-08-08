"""Top-level simulation engine.

Runs the full chain per MODEL_SPEC.md:
ideal trajectory (section 3) -> feedback quantize/decode (sections 4, 6) ->
injection mode + tap/DTC decode (sections 7, 8) -> latency pipeline
(section 13) -> analog layers (section 10) -> injection dynamics (section 14).

All per-cycle quantities are float64 / int64 numpy arrays in ``SimResult``.
Error conventions (section 16):
    e_abs  : actual - ideal (single-side absolute)
    e_pair : FB + INJ - integer cycle (pairwise relative)
    e_ZC   : VCO actual phase at pulse - desired zero crossing
"""

import io
from dataclasses import dataclass, field

import numpy as np

from .config import SimConfig
from . import measurements as meas
from .dtc_model import make_dtc
from .feedback_scheduler import run_feedback, u_fb_analog
from .injection_dynamics import run_dynamics
from .injection_scheduler import run_injection, e_pair
from .latency_pipeline import apply_latency
from .noise_models import make_all_streams
from .phase_accumulator import s_ideal as s_ideal_fn
from .phase_math import wrap01_arr, wrap_cycles_arr
from .tap_model import pmux_table, tap_table

#: canonical column order of SimResult.data
COLUMNS = [
    "k", "s_ideal", "x_ideal", "A_ideal", "A_FB", "I_FB", "R_FB", "m_FB",
    "c_FB", "n_int", "u_FB_ideal", "u_FB_digital", "u_FB_analog", "e_FB_abs",
    "dsm_state", "dsm_out", "u_INJ_ideal", "R_INJ", "j_INJ", "c_INJ",
    "u_INJ_digital", "u_INJ_analog", "e_INJ_abs", "e_pair_digital",
    "e_pair_analog", "e_ZC_hw", "theta_minus", "e_inj", "delta_theta",
    "theta_plus", "e_ZC_total", "seq_id", "k_computed", "k_applied",
]

_INT_COLUMNS = {"k", "A_FB", "I_FB", "R_FB", "m_FB", "c_FB", "n_int",
                "dsm_out", "R_INJ", "j_INJ", "c_INJ", "seq_id", "k_computed",
                "k_applied"}

_SUMMARY_SIGNALS = ["e_FB_abs", "e_INJ_abs", "e_pair_digital",
                    "e_pair_analog", "e_ZC_hw", "e_ZC_total"]


@dataclass
class SimResult:
    config: SimConfig
    t_vco_s: float
    t_ref_s: float
    g: int
    data: dict = field(default_factory=dict)
    columns: list = field(default_factory=lambda: list(COLUMNS))
    metadata: list = field(default_factory=list)  # per-cycle latency metadata

    def to_rows(self):
        """List of per-cycle rows (Python natives) in ``columns`` order."""
        rows = []
        n = len(self.data["k"])
        cols = [self.data[c] for c in self.columns]
        for i in range(n):
            row = []
            for name, col in zip(self.columns, cols):
                v = col[i]
                row.append(int(v) if name in _INT_COLUMNS else float(v))
            rows.append(row)
        return rows

    def to_csv(self, path_or_buf, columns=None):
        cols = columns or self.columns
        close = False
        if isinstance(path_or_buf, (str, bytes)):
            f = open(path_or_buf, "w")
            close = True
        else:
            f = path_or_buf
        try:
            f.write(",".join(cols) + "\n")
            n = len(self.data["k"])
            arrays = [self.data[c] for c in cols]
            for i in range(n):
                parts = []
                for name, a in zip(cols, arrays):
                    v = a[i]
                    parts.append(str(int(v)) if name in _INT_COLUMNS else repr(float(v)))
                f.write(",".join(parts) + "\n")
        finally:
            if close:
                f.close()

    def to_csv_string(self, columns=None) -> str:
        buf = io.StringIO()
        self.to_csv(buf, columns=columns)
        return buf.getvalue()

    def summary(self) -> dict:
        """rms / peak-to-peak / mean of the key error signals in cycles,
        femtoseconds, and degrees."""
        out = {}
        fs_per_cycle = self.t_vco_s / 1e-15
        for name in _SUMMARY_SIGNALS:
            x = self.data[name]
            out[name] = {
                "rms_cycles": meas.rms(x),
                "p2p_cycles": meas.peak_to_peak(x),
                "mean_cycles": meas.mean(x),
                "rms_fs": meas.rms(x) * fs_per_cycle,
                "p2p_fs": meas.peak_to_peak(x) * fs_per_cycle,
                "mean_fs": meas.mean(x) * fs_per_cycle,
                "rms_deg": meas.rms(x) * 360.0,
                "p2p_deg": meas.peak_to_peak(x) * 360.0,
                "mean_deg": meas.mean(x) * 360.0,
            }
        out["t_vco_s"] = self.t_vco_s
        out["t_ref_s"] = self.t_ref_s
        out["f_vco_hz"] = 1.0 / self.t_vco_s
        return out


def simulate(cfg: SimConfig) -> SimResult:
    """Run the golden behavioral model for cfg.n_cycles reference cycles."""
    g = cfg.g
    n = cfg.n_cycles
    streams = make_all_streams(cfg.seed)

    # --- ideal trajectory (section 3; multiplication, not accumulation) ---
    ks = np.arange(n, dtype=np.int64)
    s_id = s_ideal_fn(n, cfg.n_div, cfg.s0)
    x_id = wrap01_arr(s_id)
    a_id = g * s_id

    # --- analog element models (frozen per instance) ---
    dtc_fb = make_dtc(cfg, "fb", streams)
    dtc_inj = make_dtc(cfg, "inj", streams)
    tap_tbl = tap_table(cfg.n_tap, cfg.tap_mismatch_cycles)
    pmux_tbl = pmux_table(cfg.n_pmux, cfg.pmux_mismatch_cycles)

    # --- computed-domain command streams ---
    fb = run_feedback(cfg, a_id, s_id, dither_stream=streams["dither_fb"])
    inj = run_injection(cfg, x_id, fb["R_FB"], dtc_inj, tap_tbl,
                        dither_stream=streams["dither_inj"])

    # --- latency pipeline (section 13) ---
    lat = apply_latency(cfg, n, lat_stream=streams["lat"])
    idx = lat["idx"]

    # --- applied-domain quantities (errors vs the CURRENT ideal state) ---
    s_fb_act = fb["s_FB_actual"][idx]
    e_fb_abs = wrap_cycles_arr(s_fb_act - s_id)
    u_fb_dig = fb["u_FB_digital"][idx]
    u_fb_an = u_fb_analog(cfg, fb["m_FB"][idx], fb["c_FB"][idx], dtc_fb, pmux_tbl)

    u_inj_ideal_now = wrap01_arr(cfg.z0_cycles - x_id)
    u_inj_dig = inj["u_INJ_digital"][idx]
    u_inj_an = inj["u_INJ_analog"][idx]
    e_inj_abs = wrap_cycles_arr(u_inj_dig - u_inj_ideal_now)

    e_pair_dig = e_pair(u_fb_dig, u_inj_dig, cfg.r_zero, g)
    e_pair_an = e_pair(u_fb_an, u_inj_an, cfg.r_zero, g)

    # deterministic hardware zero-crossing error (sections 5.1, 14)
    e_zc_hw = wrap_cycles_arr(x_id + u_inj_an - cfg.z0_cycles)

    # applied-domain divider command n_int (padded to n with last value)
    i_applied = fb["I_FB"][idx]
    if n > 1:
        n_int = np.concatenate([np.diff(i_applied), np.diff(i_applied)[-1:]])
    else:
        n_int = np.zeros(1, dtype=np.int64)

    # --- injection dynamics (section 14) ---
    dyn = run_dynamics(cfg, e_zc_hw, streams)

    data = {
        "k": ks,
        "s_ideal": s_id,
        "x_ideal": x_id,
        "A_ideal": a_id,
        "A_FB": fb["A_FB"][idx],
        "I_FB": i_applied,
        "R_FB": fb["R_FB"][idx],
        "m_FB": fb["m_FB"][idx],
        "c_FB": fb["c_FB"][idx],
        "n_int": n_int,
        "u_FB_ideal": x_id,
        "u_FB_digital": u_fb_dig,
        "u_FB_analog": u_fb_an,
        "e_FB_abs": e_fb_abs,
        "dsm_state": fb["dsm_state"][idx],
        "dsm_out": fb["dsm_out"][idx],
        "u_INJ_ideal": u_inj_ideal_now,
        "R_INJ": inj["R_INJ"][idx],
        "j_INJ": inj["j_INJ"][idx],
        "c_INJ": inj["c_INJ"][idx],
        "u_INJ_digital": u_inj_dig,
        "u_INJ_analog": u_inj_an,
        "e_INJ_abs": e_inj_abs,
        "e_pair_digital": e_pair_dig,
        "e_pair_analog": e_pair_an,
        "e_ZC_hw": e_zc_hw,
        "theta_minus": dyn["theta_minus"],
        "e_inj": dyn["e_inj"],
        "delta_theta": dyn["delta_theta"],
        "theta_plus": dyn["theta_plus"],
        "e_ZC_total": dyn["e_ZC_total"],
        "seq_id": lat["seq_id"],
        "k_computed": lat["k_computed"],
        "k_applied": lat["k_applied"],
    }

    return SimResult(config=cfg, t_vco_s=cfg.t_vco_s, t_ref_s=cfg.t_ref_s,
                     g=g, data=data, metadata=lat["metadata"])
