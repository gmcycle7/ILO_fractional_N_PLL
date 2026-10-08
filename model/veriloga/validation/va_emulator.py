"""Pure-Python transcription of the EVENT MATH of the four .va models.

PURPOSE (and limits): this is NOT a Verilog-A simulator and NOT a substitute
for Spectre. It re-executes, statement by statement in float64, what the
@(initial_step) / @(cross) blocks of ../*.va compute, at the event times the
testbenches create. check_results.py uses it to
  (1) fabricate "what a correct Spectre export should contain" for the
      --self-test (matching and deliberately corrupted results), and
  (2) show, here and without any simulator, that the .va arithmetic as
      written reproduces the committed vectors / golden model.
It cannot see simulator effects: cross() location tolerance, transition()
scheduling semantics, idtmod integration error, event ordering, parser or
elaboration errors. Those are exactly what the Spectre run validates.

Each function mirrors one module; variable names follow the .va source.
"""

import math

floor = math.floor
TWO_PI = 2.0 * math.pi


# ---------------------------------------------------------------------------
# fractional_phase_scheduler.va
# ---------------------------------------------------------------------------
def fractional_phase_scheduler(n_edges, n_int_base=3, alpha=0.13, s0=0.0,
                               b_dtc=6, q_mode=1, **_):
    """Outputs held after rising edge k = 0..n_edges-1, plus the pre-edge
    (initial_step) values under key 'init'. Values are in code units / cycles."""
    n_frac = n_int_base + alpha
    g_units = 4.0 * pow(2.0, b_dtc)
    k_real = 0.0
    e_q = 0.0

    def quantize(u_q):
        nonlocal e_q
        if q_mode == 0:
            return floor(u_q)
        if q_mode == 1:
            return floor(u_q + 0.5)
        v_q = u_q + e_q
        y_q = floor(v_q)
        e_q = v_q - y_q
        return y_q

    # @(initial_step)
    a_fb_curr = float(quantize(g_units * (s0 + 0.0 * n_frac)))
    r_fb = a_fb_curr - g_units * floor(a_fb_curr / g_units)
    init = {"n_int": float(n_int_base),
            "m_fb": float(floor(r_fb / (g_units / 4.0))),
            "c_fb": r_fb - (g_units / 4.0) * floor(r_fb / (g_units / 4.0)),
            "r_fb": r_fb, "s_ideal": s0, "x_frac": s0 - floor(s0)}
    out = {key: [] for key in init}
    for _k in range(n_edges):
        s_now = s0 + k_real * n_frac
        x_frac_val = s_now - floor(s_now)
        s_next = s0 + (k_real + 1.0) * n_frac
        a_fb_next = float(quantize(g_units * s_next))
        i_curr = floor(a_fb_curr / g_units)
        i_next = floor(a_fb_next / g_units)
        n_int_val = i_next - i_curr
        r_fb = a_fb_curr - g_units * floor(a_fb_curr / g_units)
        m_fb_val = floor(r_fb / (g_units / 4.0))
        c_fb_val = r_fb - (g_units / 4.0) * floor(r_fb / (g_units / 4.0))
        a_fb_curr = a_fb_next
        k_real = k_real + 1.0
        out["n_int"].append(float(n_int_val))
        out["m_fb"].append(float(m_fb_val))
        out["c_fb"].append(c_fb_val)
        out["r_fb"].append(r_fb)
        out["s_ideal"].append(s_now)
        out["x_frac"].append(x_frac_val)
    out["init"] = init
    return out


# ---------------------------------------------------------------------------
# reverse_injection_scheduler.va
# ---------------------------------------------------------------------------
def reverse_injection_scheduler(r_fb_samples, r_zero=0, shared_mode=1,
                                map_mode=0, lat_cycles=0, look_ahead=1,
                                n_int_base=3, alpha=0.13, s0=0.0, z0=0.0,
                                b_dtc=6, q_mode=1, e_q_init=0.0, **_):
    """r_fb_samples[k] = V(r_fb_in)/v_per_code seen at edge k (ignored when
    shared_mode = 0). Returns j, c, r (applied R_INJ), u per edge."""
    g_units = 4.0 * pow(2.0, b_dtc)
    n_frac = n_int_base + alpha
    k_real = 0.0
    e_q = e_q_init
    pipe = [r_zero - g_units * floor(r_zero / g_units)] * 9
    if shared_mode == 0 and look_ahead == 1 and q_mode == 2 and lat_cycles >= 1:
        for i in range(lat_cycles):
            s_nom = s0 + i * n_frac
            x_nom = s_nom - floor(s_nom)
            u_ideal = (z0 - x_nom) - floor(z0 - x_nom)
            v_q = g_units * u_ideal + e_q
            e_q = v_q - floor(v_q)
    out = {"j": [], "c": [], "r": [], "u": []}
    for k in range(len(r_fb_samples)):
        if shared_mode == 1:
            r_fb_smp = floor(r_fb_samples[k] + 0.5)
            if r_fb_smp < 0.0:
                r_fb_smp = 0.0
            if r_fb_smp > g_units - 1.0:
                r_fb_smp = g_units - 1.0
            r_now = (r_zero - r_fb_smp) - g_units * floor((r_zero - r_fb_smp) / g_units)
        else:
            k_eff = k_real + lat_cycles if look_ahead == 1 else k_real
            s_nom = s0 + k_eff * n_frac
            x_nom = s_nom - floor(s_nom)
            u_ideal = (z0 - x_nom) - floor(z0 - x_nom)
            u_q = g_units * u_ideal
            if q_mode == 0:
                y_q = floor(u_q)
            elif q_mode == 1:
                y_q = floor(u_q + 0.5)
            else:
                v_q = u_q + e_q
                y_q = floor(v_q)
                e_q = v_q - y_q
            r_now = y_q - g_units * floor(y_q / g_units)
        pipe = [r_now] + pipe[:8]
        r_apply = pipe[lat_cycles]
        if map_mode == 0:
            j_val = floor(r_apply / (g_units / 8.0))
            c_val = r_apply - (g_units / 8.0) * floor(r_apply / (g_units / 8.0))
        else:
            u_target = r_apply / g_units
            best_err, j_best, c_best = 2.0, 0, 0
            cc = 0
            while cc < g_units / 4.0:
                for jj in range(8):
                    u_cand = jj / 8.0 + cc / g_units
                    d_wrap = (u_target - u_cand) - floor(u_target - u_cand)
                    if d_wrap > 0.5:
                        d_wrap -= 1.0
                    if abs(d_wrap) < best_err:
                        best_err, j_best, c_best = abs(d_wrap), jj, cc
                cc += 1
            j_val, c_val = float(j_best), float(c_best)
        u_dig = ((g_units / 8.0) * j_val + c_val) / g_units
        u_dig = u_dig - floor(u_dig)
        k_real += 1.0
        out["j"].append(float(j_val))
        out["c"].append(float(c_val))
        out["r"].append(float(r_apply))
        out["u"].append(u_dig)
    return out


# ---------------------------------------------------------------------------
# dtc_nonideal_model.va
# ---------------------------------------------------------------------------
def dtc_delay(c_volts, j_volts, lsb_s=312.5e-15, gain=1.0, offset_s=0.0,
              inl_sin_amp_s=0.0, p2_s=0.0, p3_s=0.0, use_tap=0, n_codes=64,
              v_per_code=1.0, t_d_min=1.0e-15, **taps):
    """t_d [s] captured at one rising trig_in edge (the .va rise event)."""
    c_smp = floor(c_volts / v_per_code + 0.5)
    c_smp = min(max(c_smp, 0.0), n_codes - 1.0)
    tap_d = 0.0
    if use_tap == 1:
        j_smp = floor(j_volts / v_per_code + 0.5)
        j_smp = min(max(j_smp, 0.0), 7.0)
        tap_d = taps.get(f"tap{int(j_smp)}", 0.0)
    t_d = (offset_s + gain * c_smp * lsb_s
           + inl_sin_amp_s * math.sin(TWO_PI * c_smp / n_codes)
           + p2_s * pow(c_smp / (n_codes - 1.0), 2.0)
           + p3_s * pow(c_smp / (n_codes - 1.0), 3.0)
           + tap_d)
    return t_d_min if t_d < t_d_min else t_d


# ---------------------------------------------------------------------------
# pulsed_injection_phase_model.va
# ---------------------------------------------------------------------------
def pulsed_injection_phase_model(trigger_times, f0=12.5e9, delta_f=0.0,
                                 k_inj=0.3, inj_map=1, k_scale=1.0, z0=0.0,
                                 theta0=0.0, **_):
    """Kick sequence at the given trigger crossing times. phi_cyc is what
    idtmod(f0 + delta_f, 0, 1, 0) returns at t (exact integral of a constant).
    Returns e (e_inj_dbg), dth (dtheta_dbg), th (theta_dbg) per trigger [rad]."""
    theta_c = theta0 / TWO_PI
    theta_c = theta_c - floor(theta_c)
    if theta_c > 0.5:
        theta_c -= 1.0
    out = {"e": [], "dth": [], "th": []}
    for t in trigger_times:
        ph = (f0 + delta_f) * t
        phi_cyc = ph - floor(ph)
        phi_tot = phi_cyc + theta_c
        e_cyc = (phi_tot - z0) - floor(phi_tot - z0)
        if e_cyc > 0.5:
            e_cyc -= 1.0
        e_rad = TWO_PI * e_cyc
        if inj_map == 0:
            dth_rad = -(k_inj * k_scale) * e_rad
        elif inj_map == 1:
            dth_rad = -(k_inj * k_scale) * math.sin(e_rad)
        else:
            dth_rad = -e_rad
        theta_c = theta_c + dth_rad / TWO_PI
        theta_c = theta_c - floor(theta_c)
        if theta_c > 0.5:
            theta_c -= 1.0
        out["e"].append(e_rad)
        out["dth"].append(dth_rad)
        out["th"].append(theta_c * TWO_PI)
    return out
