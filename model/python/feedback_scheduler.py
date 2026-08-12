"""Feedback path scheduler: /3-/4 + 4-phase PMUX + 6-bit DTC.

Contract: MODEL_SPEC.md sections 4, 6 [EXACT].

    A_FB[k] = Q_FB(A_ideal[k])            (non-negative integer)
    I_FB[k] = floor(A_FB[k] / G)
    R_FB[k] = A_FB[k] mod G
    m_FB[k] = floor(R_FB[k] / 64)
    c_FB[k] = R_FB[k] mod 64
    n_integer[k] = I_FB[k+1] - I_FB[k]
    u_FB_digital[k] = R_FB[k] / G
    e_FB_abs[k] = wrapCycles(A_FB[k]/G - s_ideal[k])
"""

import math

import numpy as np

from .dsm_first_order import ErrorFeedbackFirstOrder
from .mash11 import Mash11
from .mash111 import Mash111
from .phase_math import q_nearest, wrap01, wrap_cycles_arr


class _Floor:
    state = 0.0

    def quantize(self, u: float) -> int:
        return math.floor(u)


class _Nearest:
    state = 0.0

    def quantize(self, u: float) -> int:
        return math.floor(u + 0.5)


class _Truncate:
    """Truncation: identical to floor for non-negative inputs (spec item 3)."""
    state = 0.0

    def quantize(self, u: float) -> int:
        return math.floor(u)


def make_quantizer(name: str):
    """Fresh (independent-state) quantizer instance."""
    if name == "floor":
        return _Floor()
    if name == "nearest":
        return _Nearest()
    if name == "truncate":
        return _Truncate()
    if name == "ef1":
        return ErrorFeedbackFirstOrder()
    if name == "mash11":
        return Mash11()
    if name == "mash111":
        return Mash111()
    raise ValueError(f"unknown quantizer '{name}'")


def run_feedback(cfg, a_ideal: np.ndarray, s_ideal: np.ndarray,
                 dither_stream=None) -> dict:
    """Quantize the ideal fine-code trajectory and decode divider commands.

    Optional triangular dither (spec section 6 item 7):
        u' = u + d_amp * (U1 + U2 - 1),  U from the 'dither_fb' stream
    (d_amp is in quantizer-LSB units: 1 fine LSB in 'full' actuator mode,
    1 VCO cycle in 'dsm_only' and 'qnc').

    Actuator modes (spec sections 7.1, 7.2):
        full     : A_FB = Q(A_ideal)          (fine 1/G-cycle quantization)
        dsm_only : A_FB = Q(A_ideal / G) * G  (classic divider-modulating DSM;
                   quantizer operates at INTEGER-CYCLE granularity, so
                   R_FB = m_FB = c_FB = 0 always; dsm_out is the integer
                   cycle count Q(A_ideal / G))
        qnc      : divider quantizes at INTEGER-CYCLE granularity exactly as
                   in dsm_only (y = Q(A_ideal / G)); a cancellation DTC is
                   fed the accumulated sub-cycle residue
                       r[k]    = s_ideal[k] - y[k]
                       code[k] = clamp(qNearest(wrap01(r[k]) * G * qnc_gain),
                                       0, G - 1)
                       A_FB[k] = y[k] * G + code[k]
                   so R_FB = code (decoded to m/c as usual); dsm_out is
                   still the integer cycle count y.

    Returns computed-domain (pre-latency) arrays; assertions per section 4.
    """
    g = cfg.g
    n_dtc = 1 << cfg.b_dtc
    n = len(a_ideal)
    q = make_quantizer(cfg.quantizer)
    dsm_only = cfg.actuator_mode == "dsm_only"
    qnc = cfg.actuator_mode == "qnc"
    integer_cycle = dsm_only or qnc

    a_fb = np.empty(n, dtype=np.int64)
    dsm_state = np.empty(n, dtype=np.float64)
    dsm_out = np.empty(n, dtype=np.int64)

    use_dither = cfg.dither_amp_lsb > 0.0 and dither_stream is not None
    for k in range(n):
        u = float(a_ideal[k]) / g if integer_cycle else float(a_ideal[k])
        if use_dither:
            u += cfg.dither_amp_lsb * (dither_stream.next() + dither_stream.next() - 1.0)
        y = q.quantize(u)
        if qnc:
            r = float(s_ideal[k]) - y  # accumulated sub-cycle residue (cycles)
            code = q_nearest(wrap01(r) * g * cfg.qnc_gain)
            if code < 0:
                code = 0
            elif code > g - 1:
                code = g - 1
            a_fb[k] = y * g + code
        else:
            a_fb[k] = y * g if dsm_only else y
        dsm_out[k] = y
        dsm_state[k] = q.state

    # --- assertions (MODEL_SPEC section 4) ---
    d = np.diff(a_fb)
    assert np.all(d > 0), "A_FB must be strictly monotonic (no duplicate/backward edges)"
    i_fb = a_fb // g
    r_fb = a_fb % g
    m_fb = r_fb // n_dtc
    c_fb = r_fb % n_dtc
    assert np.all((r_fb >= 0) & (r_fb < g)), "R_FB out of range"
    assert np.all((m_fb >= 0) & (m_fb < cfg.n_pmux)), "m_FB out of range"
    assert np.all((c_fb >= 0) & (c_fb < n_dtc)), "c_FB out of range"

    n_int = i_fb[1:] - i_fb[:-1]
    assert np.all(n_int >= 0), "n_integer must be non-negative (PMUX wrap legality)"
    # pad to length n with the last value (task contract)
    n_int_padded = np.concatenate([n_int, n_int[-1:]]) if n > 1 else np.zeros(1, dtype=np.int64)

    s_fb_actual = a_fb / g
    e_fb_abs = wrap_cycles_arr(s_fb_actual - s_ideal)
    u_fb_digital = r_fb / g

    return {
        "A_FB": a_fb,
        "I_FB": i_fb,
        "R_FB": r_fb,
        "m_FB": m_fb,
        "c_FB": c_fb,
        "n_int": n_int_padded,
        "s_FB_actual": s_fb_actual,
        "u_FB_digital": u_fb_digital,
        "e_FB_abs": e_fb_abs,
        "dsm_state": dsm_state,
        "dsm_out": dsm_out,
    }


def u_fb_analog(cfg, m_fb: np.ndarray, c_fb: np.ndarray, dtc_fb, pmux_tbl) -> np.ndarray:
    """Analog-layer feedback fractional position (cycles):

    u_FB_analog = pmux_actual(m) + dtc_fb_actual(c) + route_FB
    """
    return pmux_tbl[m_fb] + dtc_fb.delay_cycles(c_fb) + cfg.route_fb_cycles


def lms_qnc_step(gain: float, mu: float, e: float, r: float) -> float:
    """One LMS adaptation step for the QNC cancellation-DTC gain
    (spec section 7.2; pure and deterministic, used by the Ch11 LMS demo):

        gain' = gain - mu * e * r

    e is the observed timing error (cycles), r the DTC-commanded residue.
    Evaluation order is left-to-right ((mu * e) * r) in both languages so the
    float64 result is bit-identical with the TS mirror ``lmsQncStep``.
    """
    return gain - mu * e * r
