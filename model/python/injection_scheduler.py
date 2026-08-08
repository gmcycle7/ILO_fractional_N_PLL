"""Injection scheduler: architecture modes A/B/C/D and tap+DTC decode.

Contract: MODEL_SPEC.md sections 5, 7, 8 [EXACT].

    u_INJ_ideal[k] = wrap01(z0 - x_nominal[k])

Modes (feedback always A_FB = Q_FB(A_ideal)):
    A: R_INJ = Q_INJ(G * u_INJ_ideal) mod G, independent instance of the same
       quantizer type (independent error state; dither from 'dither_inj').
    B: same as A but both sides are DSM-type quantizers with their own
       state/stream (spec: correct on average, wrong cycle-by-cycle reverse;
       "not recommended").  The code path is identical to A — the mode label
       documents intent; cfg.quantizer should be 'ef1'/'mash11'.
    C: shared high-resolution master state P[k] = A_ideal[k]; u_INJ_ideal is
       derived from it, then quantized by an independent instance.
    D (default): quantize once + modular reverse:
       R_INJ = (R_zero - R_FB) mod 256  ->  e_pair_digital == 0 exactly.

Mappings (input digital code R_INJ; target u_target = R_INJ/G):
    naive      : j = floor(R/32), c = R mod 32   (lower half of DTC range only)
    nearest    : argmin over j in 0..7, c in 0..63 of
                 |wrapCycles(u_target - (j/8 + c/256))|, tie-break smaller c
                 then smaller j (candidates enumerated c-major so argmin's
                 first-minimum rule implements the tie-break exactly)
    calibrated : argmin using actual tap + DTC + route models.

[Resolved ambiguity: spec section 8 allows the mapping input to be either the
digital code R_INJ or a real target; this model always uses the digital
command target u_target = R_INJ/G so the R_INJ produced by the architecture
mode remains the single command word.  e_INJ_abs is still measured against
the real u_INJ_ideal.]
"""

import numpy as np

from .feedback_scheduler import make_quantizer
from .phase_math import wrap01_arr, wrap_cycles_arr


def u_inj_ideal(x_nominal: np.ndarray, z0: float) -> np.ndarray:
    """Ideal normalized injection command: wrap01(z0 - x_nominal)."""
    return wrap01_arr(z0 - x_nominal)


def _candidates(cfg, dtc_inj, tap_tbl, calibrated: bool):
    """Candidate (j, c) list in c-major order with phase values (cycles)."""
    n_dtc = 1 << cfg.b_dtc
    cs, js, us = [], [], []
    for c in range(n_dtc):
        for j in range(cfg.n_tap):
            cs.append(c)
            js.append(j)
            if calibrated:
                us.append(tap_tbl[j] + float(dtc_inj.delay_cycles(c)) + cfg.route_inj_cycles)
            else:
                us.append(j / cfg.n_tap + c / cfg.g)
    return (np.array(js, dtype=np.int64), np.array(cs, dtype=np.int64),
            np.array(us, dtype=np.float64))


def run_injection(cfg, x_nominal: np.ndarray, r_fb: np.ndarray,
                  dtc_inj, tap_tbl, dither_stream=None) -> dict:
    """Produce injection command stream (computed-domain, pre-latency)."""
    g = cfg.g
    n = len(x_nominal)
    tap_step = g // cfg.n_tap  # 32 LSB

    u_ideal = u_inj_ideal(x_nominal, cfg.z0_cycles)

    # --- R_INJ per architecture mode ---
    r_inj = np.empty(n, dtype=np.int64)
    if cfg.arch_mode == "D":
        r_inj[:] = (cfg.r_zero - r_fb) % g
    else:  # A, B, C: independent quantizer instance on G * u_INJ_ideal
        q = make_quantizer(cfg.quantizer)
        use_dither = cfg.dither_amp_lsb > 0.0 and dither_stream is not None
        for k in range(n):
            u = g * float(u_ideal[k])
            if use_dither:
                u += cfg.dither_amp_lsb * (dither_stream.next() + dither_stream.next() - 1.0)
            r_inj[k] = q.quantize(u) % g

    # --- tap + DTC decode ---
    j_inj = np.empty(n, dtype=np.int64)
    c_inj = np.empty(n, dtype=np.int64)
    if cfg.inj_mapping == "naive":
        j_inj[:] = r_inj // tap_step
        c_inj[:] = r_inj % tap_step
    else:
        calibrated = cfg.inj_mapping == "calibrated"
        js, cs, us = _candidates(cfg, dtc_inj, tap_tbl, calibrated)
        for k in range(n):
            target = r_inj[k] / g
            err = np.abs(wrap_cycles_arr(target - us))
            i = int(err.argmin())  # first minimum -> smaller c, then smaller j
            j_inj[k] = js[i]
            c_inj[k] = cs[i]

    u_inj_digital = ((tap_step * j_inj + c_inj) % g) / g
    u_inj_analog = (tap_tbl[j_inj] + dtc_inj.delay_cycles(c_inj)
                    + cfg.route_inj_cycles)

    return {
        "u_INJ_ideal": u_ideal,
        "R_INJ": r_inj,
        "j_INJ": j_inj,
        "c_INJ": c_inj,
        "u_INJ_digital": u_inj_digital,
        "u_INJ_analog": u_inj_analog,
    }


def e_pair(u_fb: np.ndarray, u_inj: np.ndarray, r_zero: int, g: int) -> np.ndarray:
    """Pairwise reverse error (digital or analog layer, spec section 7):

    e_pair = wrapCycles(u_FB_actual + u_INJ_actual - u_zero_offset)
    u_zero_offset = R_zero / G
    """
    return wrap_cycles_arr(u_fb + u_inj - r_zero / g)
