"""VCO injection dynamics: one injection per reference cycle.

Contract: MODEL_SPEC.md section 14 [ASSUMPTION/APPROX].

Residual phase theta (rad; deterministic trajectory removed):

    theta_minus[k] = theta_plus[k-1] + 2*pi*Delta_f*T_ref + w_vco[k]
    epsilon_hw[k]  = 2*pi * e_ZC_hardware[k]     (deterministic scheduling err)
    e_inj[k]       = wrapRadians(theta_minus[k] + epsilon_hw[k] + eps_rand[k])

Injection response models:
    none   : Delta_theta = 0
    reset  : Delta_theta = -e_inj                  (ideal upper bound)
    linear : Delta_theta = -K_inj * e_inj
    sin    : Delta_theta = -K_inj * sin(e_inj)
    lut    : Delta_theta = interp(pdr_lut, e_inj)  (linear interp, clamped)

    theta_plus[k] = wrapRadians(theta_minus[k] + Delta_theta[k])

Noise terms [resolved ambiguity]:
    w_vco[k] = sigma_vco_w * g_w[k]  +  rw[k],
    rw[k] = rw[k-1] + sigma_vco_rw * g_rw[k]   (accumulated random walk)
    eps_rand[k] = 2*pi*(ref_jitter[k] + pulse_jitter[k]) / T_vco
    (reference / pulse timing noise moves the pulse position, streams
    'ref' / 'pulse'; draws happen only when the corresponding sigma > 0 so
    noiseless configs consume no stream values.)

Sinusoidal fixed point / lock [APPROX]:
    K_inj * sin(theta_ss) = 2*pi*Delta_f*T_ref
    lock condition:  |2*pi*Delta_f*T_ref| <= K_inj
    stable solution: cos(theta_ss) > 0  ->  theta_ss = asin(a / K_inj)

Injection gating (spec section 14): optional ``fired`` mask (0/1 per cycle,
computed by simulate() from |e_ZC_hw| <= inj_gate_threshold_cycles when
inj_gate_mode == 'threshold').  A non-fired cycle applies NO phase kick
(Delta_theta = 0; theta keeps accumulating detuning/noise); e_inj is still
recorded as the error a pulse would have seen, and PRNG stream consumption
is identical with or without gating.

PLL loop co-simulation (spec section 14.1) [ASSUMPTION], loop_mode == 'pi':
behavioral type-II PI loop; the PD samples the residual phase BEFORE the
injection kick:

    theta_minus[k] = theta_plus[k-1] + (2*pi*Delta_f*T_ref + u_loop[k])
                     + w_vco[k]
    pd_e[k]        = wrapRadians(theta_minus[k])
    u_loop[0] = 0;  u_loop[k+1] = u_loop[k] - loop_ki * pd_e[k]
    theta_plus[k]  = wrapRadians(theta_minus[k] - loop_kp*pd_e[k]
                                 + Delta_theta[k])

The injection kick is unchanged (same e_inj formula, gating, PRNG draws)
and is applied after the proportional kick (summed in the same wrap).
loop_mode == 'off' keeps the section-14 recursion bit-identical
(u_loop == 0, no proportional kick); pd_e is still recorded as the error
the PD would observe.
"""

import math

import numpy as np

from .phase_math import wrap_radians


def lock_condition(k_inj: float, delta_f_hz: float, f_ref_hz: float) -> bool:
    """|2*pi*Delta_f*T_ref| <= K_inj (sinusoidal map lock range)."""
    a = 2.0 * math.pi * delta_f_hz / f_ref_hz
    return abs(a) <= k_inj


def sin_fixed_point_rad(k_inj: float, delta_f_hz: float, f_ref_hz: float):
    """Stable steady-state e_inj for the sinusoidal map (rad), or None if
    outside the lock range: theta_ss = asin(2*pi*Delta_f*T_ref / K_inj)."""
    a = 2.0 * math.pi * delta_f_hz / f_ref_hz
    if k_inj <= 0.0 or abs(a) > k_inj:
        return None
    return math.asin(a / k_inj)


def _delta_theta(model: str, k_inj: float, e: float, lut_e, lut_d) -> float:
    if model == "none":
        return 0.0
    if model == "reset":
        return -e
    if model == "linear":
        return -k_inj * e
    if model == "sin":
        return -k_inj * math.sin(e)
    if model == "lut":
        return float(np.interp(e, lut_e, lut_d))  # np.interp clamps at ends
    raise ValueError(f"unknown inj_model '{model}'")


def run_dynamics(cfg, e_zc_hw_cycles: np.ndarray, streams: dict,
                 fired=None) -> dict:
    """Run the per-reference-cycle injection phase map.

    e_zc_hw_cycles: deterministic hardware zero-crossing error (cycles).
    fired: optional 0/1 per-cycle gating mask; cycles with fired == 0 apply
    no phase kick (Delta_theta = 0).  None means every cycle fires.
    Returns theta arrays (rad) and e_ZC_total (cycles) = e_inj / (2*pi).
    """
    n = len(e_zc_hw_cycles)
    two_pi = 2.0 * math.pi
    t_ref = cfg.t_ref_s
    t_vco = cfg.t_vco_s
    a = two_pi * cfg.delta_f_hz * t_ref

    lut_e = lut_d = None
    if cfg.inj_model == "lut":
        if not cfg.pdr_lut:
            raise ValueError("inj_model='lut' requires pdr_lut")
        pts = sorted((float(p[0]), float(p[1])) for p in cfg.pdr_lut)
        lut_e = np.array([p[0] for p in pts])
        lut_d = np.array([p[1] for p in pts])

    theta_minus = np.empty(n)
    epsilon_hw = two_pi * np.asarray(e_zc_hw_cycles, dtype=np.float64)
    e_inj = np.empty(n)
    delta_theta = np.empty(n)
    theta_plus = np.empty(n)
    u_loop_arr = np.empty(n)
    pd_e = np.empty(n)

    s_vw = streams.get("vco_w")
    s_rw = streams.get("vco_rw")
    s_ref = streams.get("ref")
    s_pulse = streams.get("pulse")

    loop_pi = cfg.loop_mode == "pi"
    tp_prev = 0.0
    rw = 0.0
    u_loop = 0.0
    for k in range(n):
        w = 0.0
        if cfg.sigma_vco_w_rad > 0.0 and s_vw is not None:
            w += cfg.sigma_vco_w_rad * s_vw.gauss()
        if cfg.sigma_vco_rw_rad > 0.0 and s_rw is not None:
            rw += cfg.sigma_vco_rw_rad * s_rw.gauss()
            w += rw
        if loop_pi:
            tm = tp_prev + a + u_loop + w
        else:
            tm = tp_prev + a + w
        pd = wrap_radians(tm)   # behavioral PD, before any kick (section 14.1)
        eps_rand = 0.0
        if cfg.sigma_ref_s > 0.0 and s_ref is not None:
            eps_rand += two_pi * (cfg.sigma_ref_s * s_ref.gauss()) / t_vco
        if cfg.sigma_pulse_s > 0.0 and s_pulse is not None:
            eps_rand += two_pi * (cfg.sigma_pulse_s * s_pulse.gauss()) / t_vco
        e = wrap_radians(tm + epsilon_hw[k] + eps_rand)
        if fired is not None and fired[k] == 0:
            dth = 0.0   # gated out: no phase kick this cycle
        else:
            dth = _delta_theta(cfg.inj_model, cfg.k_inj, e, lut_e, lut_d)
        if loop_pi:
            tp = wrap_radians(tm - cfg.loop_kp * pd + dth)
        else:
            tp = wrap_radians(tm + dth)

        theta_minus[k] = tm
        e_inj[k] = e
        delta_theta[k] = dth
        theta_plus[k] = tp
        u_loop_arr[k] = u_loop
        pd_e[k] = pd
        tp_prev = tp
        if loop_pi:
            u_loop = u_loop - cfg.loop_ki * pd

    return {
        "theta_minus": theta_minus,
        "epsilon_hw": epsilon_hw,
        "e_inj": e_inj,
        "delta_theta": delta_theta,
        "theta_plus": theta_plus,
        "e_ZC_total": e_inj / two_pi,   # cycles
        "u_loop": u_loop_arr,
        "pd_e": pd_e,
    }
