"""Error decomposition per MODEL_SPEC.md section 16.

Runs a baseline (all-ideal analog / no latency / no noise, digital
quantization kept) and re-runs with each nonideality term enabled alone;
each term's contribution is the rms of the per-cycle delta of e_ZC_total
relative to the baseline.  The jointly-simulated total is also reported.

Additivity is APPROXIMATE (linear regime only, spec [APPROX]) — the report
includes both the individual contributions and the joint total so the
difference is visible.  The additivity gap is computed PER-CYCLE per spec
section 16: gap = rms((e_joint - e_base) - sum_terms(e_term - e_base));
the RSS of the contributions is kept only as a separately-named
uncorrelated-combination reference.
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
        rss_reference_rms        : rss of the individual contributions
                                   (uncorrelated-combination REFERENCE only,
                                   not the spec section 16 additivity check)
        joint_total_rms_cycles   : rms of (e_full - e_baseline), jointly run
        additivity_gap_cycles    : rms of the per-cycle linear-sum residual
                                   (e_joint - e_base) - sum_terms(e_term - e_base)
                                   (spec section 16: additivity is per-cycle
                                   linear, exact in the linear regime)
    """
    ideal = _ideal_overrides(cfg)
    base_cfg = cfg.replace(**ideal)
    base = np.asarray(simulate(base_cfg).data[signal], dtype=np.float64)

    contributions = {}
    sum_deltas = np.zeros_like(base)
    full_dict = cfg.to_dict()
    for term, fields_ in _TERMS.items():
        over = dict(ideal)
        for f in fields_:
            over[f] = full_dict[f]
        term_cfg = cfg.replace(**over)
        x = np.asarray(simulate(term_cfg).data[signal], dtype=np.float64)
        delta = x - base
        sum_deltas += delta
        contributions[term] = meas.rms(delta)

    joint = np.asarray(simulate(cfg).data[signal], dtype=np.float64)
    joint_delta = joint - base
    joint_rms = meas.rms(joint_delta)
    rss = float(np.sqrt(sum(v * v for v in contributions.values())))
    gap = meas.rms(joint_delta - sum_deltas)

    return {
        "signal": signal,
        "baseline_rms_cycles": meas.rms(base),
        "contributions": contributions,
        "rss_reference_rms": rss,
        "joint_total_rms_cycles": joint_rms,
        "additivity_gap_cycles": gap,
    }
