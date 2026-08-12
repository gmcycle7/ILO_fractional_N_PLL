"""Acceptance Test 19: PLL loop co-simulation (MODEL_SPEC section 14.1)."""

import math

import numpy as np
import pytest

from model.python.config import SimConfig
from model.python.injection_dynamics import lock_condition
from model.python.phase_math import wrap_radians
from model.python.simulate import simulate

F_REF = 4e9
T_REF = 1.0 / F_REF
TWO_PI = 2.0 * math.pi

#: exp23 shared parameters: 250 MHz detuning is OUTSIDE the sin lock range
#: (|2*pi*df*T_ref| = 0.3927 rad > k_inj = 0.3)
DF_OUT = 250e6
EXP23 = dict(n_div=3.13, sigma_vco_w_rad=0.02, delta_f_hz=DF_OUT)


def _rms(x):
    return float(np.sqrt(np.mean(np.asarray(x) ** 2)))


def test_loop_only_pd_mean_to_zero():
    # small detuning (1 MHz), noiseless: the type-II loop nulls the static
    # PD error (integrator absorbs the detuning entirely)
    res = simulate(SimConfig(n_div=3.13, loop_mode="pi", inj_model="none",
                             delta_f_hz=1e6))
    assert abs(float(np.mean(res.data["pd_e"][-128:]))) < 1e-4


def test_u_loop_steady_mean_matches_minus_detuning():
    # loop-only pull-in works even far outside the injection lock range;
    # steady state: u_loop -> -2*pi*delta_f*T_ref (negative for df > 0)
    res = simulate(SimConfig(n_div=3.13, loop_mode="pi", inj_model="none",
                             delta_f_hz=DF_OUT, n_cycles=1024))
    a = TWO_PI * DF_OUT * T_REF
    u_mean = float(np.mean(res.data["u_loop"][-64:]))
    assert u_mean == pytest.approx(-a, rel=1e-3)
    assert u_mean < 0.0  # sign: correction opposes positive detuning


def test_both_mode_tail_rms_below_injection_only():
    # exp23 configs (b) vs (c)
    assert not lock_condition(0.3, DF_OUT, F_REF)
    inj_only = simulate(SimConfig(inj_model="sin", k_inj=0.3, **EXP23))
    both = simulate(SimConfig(inj_model="sin", k_inj=0.3, loop_mode="pi",
                              **EXP23))
    tail = slice(-256, None)
    # injection alone slips (unlocked ~1.8 rad rms); loop + injection locks
    assert _rms(both.data["e_inj"][tail]) < 0.1 * _rms(
        inj_only.data["e_inj"][tail])
    assert _rms(both.data["theta_plus"][tail]) < _rms(
        inj_only.data["theta_plus"][tail])


def test_loop_extends_range_and_injection_kills_jitter():
    # exp23 (a) loop-only vs (c) both: adding injection reduces the
    # per-cycle jitter of the locked loop
    loop_only = simulate(SimConfig(inj_model="none", loop_mode="pi", **EXP23))
    both = simulate(SimConfig(inj_model="sin", k_inj=0.3, loop_mode="pi",
                              **EXP23))
    tail = slice(-256, None)
    assert abs(float(np.mean(loop_only.data["pd_e"][tail]))) < 0.01
    assert abs(float(np.mean(both.data["pd_e"][tail]))) < 0.02
    assert _rms(both.data["theta_plus"][tail]) < _rms(
        loop_only.data["theta_plus"][tail])


def test_route_offset_integrated_into_phase_shift():
    # exp23 (d): with a 0.01-cycle injection route offset the loop keeps
    # pd_e -> 0 while e_inj -> 2*pi*0.01 and u_loop absorbs the static kick
    eps = TWO_PI * 0.01
    a = TWO_PI * DF_OUT * T_REF
    res = simulate(SimConfig(inj_model="sin", k_inj=0.3, loop_mode="pi",
                             route_inj_cycles=0.01, n_cycles=1024, **EXP23))
    tail = slice(-256, None)
    assert float(np.mean(res.data["e_inj"][tail])) == pytest.approx(
        eps, abs=0.02)
    assert float(np.mean(res.data["theta_plus"][tail])) == pytest.approx(
        -0.3 * math.sin(eps), abs=0.02)
    assert float(res.data["u_loop"][-1]) == pytest.approx(
        -a + 0.3 * math.sin(eps), abs=0.005)


def test_loop_off_records_but_does_not_act():
    res = simulate(SimConfig(n_div=3.13, inj_model="sin", k_inj=0.3,
                             delta_f_hz=1e6, sigma_vco_w_rad=0.01))
    d = res.data
    assert np.all(d["u_loop"] == 0.0)
    # pd_e is still recorded as the wrapped residual before the kick
    expect = np.array([wrap_radians(t) for t in d["theta_minus"]])
    assert np.array_equal(d["pd_e"], expect)


def test_loop_config_round_trip():
    d = SimConfig().to_dict()
    for name in ("loop_mode", "loop_kp", "loop_ki"):
        assert name not in d  # omitted at defaults (schema stability)
    cfg = SimConfig.from_dict(d)
    assert (cfg.loop_mode, cfg.loop_kp, cfg.loop_ki) == ("off", 0.05, 0.005)
    d2 = SimConfig(loop_mode="pi").to_dict()
    assert d2["loop_mode"] == "pi"
    assert SimConfig.from_dict(d2).loop_mode == "pi"
    with pytest.raises(ValueError):
        SimConfig(loop_mode="bogus")
