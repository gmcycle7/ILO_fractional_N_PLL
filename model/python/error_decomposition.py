"""Error decomposition per MODEL_SPEC.md section 16.

Runs a baseline (all-ideal analog / no latency / no noise, digital
quantization kept) and re-runs with each nonideality term enabled alone;
each term's contribution is the rms of the per-cycle delta of e_ZC_total
relative to the baseline.  The jointly-simulated total is also reported.

Additivity is APPROXIMATE (linear regime only, spec [APPROX]) — the report
includes both the individual contributions and the joint total so the
difference is visible.
"""

import numpy as np

from . import measurements as meas
from .simulate import simulate

# term name -> config fields it carries over from the full config
_TERMS = {
    "tap_mismatch": ["tap_mismatch_cycles"],
    "pmux_mismatch": ["pmux_mismatch_cycles"],
    "dtc_gain": ["dtc_fb_gain", "dtc_inj_gain"],
    "dtc_offset": ["dtc_fb_offset_cycles", "dtc_inj_offset_cycles"],
    "dtc_inl": ["inl_sin_amp_cycles", "inl_poly", "inl_lut"],
    "dtc_dnl": ["dnl_sigma_lsb"],
    "route": ["route_fb_cycles", "route_inj_cycles"],
    "ref_jitter": ["sigma_ref_s"],
    "vco_noise": ["sigma_vco_w_rad", "sigma_vco_rw_rad"],
    "pulse_noise": ["sigma_pulse_s"],
    "latency": ["latency_cycles", "lookahead", "p_late"],
}

_IDEAL = {
    "tap_mismatch_cycles": None,   # filled per-config (length n_tap)
    "pmux_mismatch_cycles": None,
    "dtc_fb_gain": 1.0,
    "dtc_inj_gain": 1.0,
    "dtc_fb_offset_cycles": 0.0,
    "dtc_inj_offset_cycles": 0.0,
    "inl_sin_amp_cycles": 0.0,
    "inl_poly": [0.0, 0.0],
    "inl_lut": None,
    "dnl_sigma_lsb": 0.0,
    "route_fb_cycles": 0.0,
    "route_inj_cycles": 0.0,
    "sigma_ref_s": 0.0,
    "sigma_vco_w_rad": 0.0,
    "sigma_vco_rw_rad": 0.0,
    "sigma_pulse_s": 0.0,
    "latency_cycles": 0,
    "lookahead": True,
    "p_late": 0.0,
}


def _ideal_overrides(cfg):
    d = dict(_IDEAL)
    d["tap_mismatch_cycles"] = [0.0] * cfg.n_tap
    d["pmux_mismatch_cycles"] = [0.0] * cfg.n_pmux
    return d


def decompose(cfg, signal: str = "e_ZC_total") -> dict:
    """Per-term error decomposition of ``signal`` (default e_ZC_total).

    Returns dict with:
        baseline_rms_cycles      : rms with all nonidealities off
        contributions            : {term: rms of (e_term - e_baseline)}
        sum_of_contributions_rms : rss of the individual contributions
        joint_total_rms_cycles   : rms of (e_full - e_baseline), jointly run
        additivity_gap_cycles    : joint - rss (additivity is approximate)
    """
    ideal = _ideal_overrides(cfg)
    base_cfg = cfg.replace(**ideal)
    base = simulate(base_cfg).data[signal]

    contributions = {}
    full_dict = cfg.to_dict()
    for term, fields_ in _TERMS.items():
        over = dict(ideal)
        for f in fields_:
            over[f] = full_dict[f]
        term_cfg = cfg.replace(**over)
        x = simulate(term_cfg).data[signal]
        contributions[term] = meas.rms(np.asarray(x) - np.asarray(base))

    joint = simulate(cfg).data[signal]
    joint_rms = meas.rms(np.asarray(joint) - np.asarray(base))
    rss = float(np.sqrt(sum(v * v for v in contributions.values())))

    return {
        "signal": signal,
        "baseline_rms_cycles": meas.rms(base),
        "contributions": contributions,
        "sum_of_contributions_rms": rss,
        "joint_total_rms_cycles": joint_rms,
        "additivity_gap_cycles": joint_rms - rss,
    }
