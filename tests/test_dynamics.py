"""Acceptance Test 14: injection dynamics trends (MODEL_SPEC section 14)."""

import math

import numpy as np
import pytest

from model.python.config import SimConfig
from model.python.injection_dynamics import lock_condition, sin_fixed_point_rad
from model.python.simulate import simulate

F_REF = 4e9
T_REF = 1.0 / F_REF
DF = 1e6  # 1 MHz detuning
A = 2 * math.pi * DF * T_REF  # per-cycle detuning phase ramp (rad)


def _run(k_inj, model="sin", noise=0.0, n_div=3.125, df=DF):
    cfg = SimConfig(n_div=n_div, inj_model=model, k_inj=k_inj, delta_f_hz=df,
                    sigma_vco_w_rad=noise)
    return simulate(cfg)


def test_k_inj_zero_no_correction():
    res = _run(k_inj=0.0)
    d = res.data
    assert np.all(d["delta_theta"] == 0.0)  # no correction at all
    # detuning ramp: theta_minus grows linearly, e_inj = wrapped ramp
    assert d["theta_minus"][100] == pytest.approx(101 * A, rel=1e-9)
    ramp_rms = np.sqrt(np.mean(d["e_inj"] ** 2))
    locked_rms = np.sqrt(np.mean(_run(0.3).data["e_inj"] ** 2))
    assert ramp_rms > 10 * locked_rms


def test_larger_k_inj_smaller_residual():
    # noise off, detuning within lock range for both gains
    assert lock_condition(0.05, DF, F_REF) and lock_condition(0.6, DF, F_REF)
    tail = slice(-128, None)
    rms_weak = np.sqrt(np.mean(_run(0.05).data["e_inj"][tail] ** 2))
    rms_strong = np.sqrt(np.mean(_run(0.6).data["e_inj"][tail] ** 2))
    assert rms_strong < rms_weak
    # steady-state values ~ asin(a/K): monotone decreasing in K
    assert rms_weak == pytest.approx(math.asin(A / 0.05), rel=1e-3)
    assert rms_strong == pytest.approx(math.asin(A / 0.6), rel=1e-3)


def test_sin_steady_state_matches_asin_fixed_point():
    res = _run(0.3, model="sin")
    ss = sin_fixed_point_rad(0.3, DF, F_REF)
    assert ss == pytest.approx(math.asin(A / 0.3), abs=1e-12)
    assert res.data["e_inj"][-1] == pytest.approx(ss, abs=1e-6)


def test_three_models_reasonable_trends():
    tail = slice(-128, None)
    e_reset = np.abs(simulate(SimConfig(n_div=3.125, inj_model="reset",
                                        delta_f_hz=DF)).data["e_inj"][tail])
    e_lin = np.abs(_run(0.3, model="linear").data["e_inj"][tail])
    e_sin = np.abs(_run(0.3, model="sin").data["e_inj"][tail])
    e_none = np.abs(_run(0.0, model="none").data["e_inj"][tail])
    # reset leaves only the per-cycle detuning step
    assert np.mean(e_reset) == pytest.approx(A, rel=1e-6)
    # linear ss residual a/K; sin ss residual asin(a/K) >= a/K; both << none
    assert np.mean(e_lin) == pytest.approx(A / 0.3, rel=1e-3)
    assert np.mean(e_sin) >= np.mean(e_lin) - 1e-12
    assert np.mean(e_none) > 10 * np.mean(e_sin)


def test_lock_condition_boundary():
    # lock iff |2*pi*df*T_ref| <= K
    k = A * 0.999
    assert not lock_condition(k, DF, F_REF)
    assert lock_condition(A * 1.001, DF, F_REF)
    assert sin_fixed_point_rad(k, DF, F_REF) is None


def test_lut_model_matches_sin_when_lut_is_sine():
    # a dense sine LUT must reproduce the sin model closely
    es = np.linspace(-math.pi, math.pi, 2001)
    lut = [[float(e), float(-0.3 * math.sin(e))] for e in es]
    cfg = SimConfig(n_div=3.125, inj_model="lut", pdr_lut=lut, k_inj=0.3,
                    delta_f_hz=DF)
    res_lut = simulate(cfg)
    res_sin = _run(0.3, model="sin")
    assert res_lut.data["e_inj"][-1] == pytest.approx(
        res_sin.data["e_inj"][-1], abs=1e-6)


def test_noise_on_still_bounded_when_locked():
    res = _run(0.3, noise=0.01)
    tail = res.data["e_inj"][-256:]
    assert np.max(np.abs(tail)) < 0.2  # bounded residual, well inside a cycle
