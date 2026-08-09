"""Tests 15-17: actuator_mode='dsm_only' invariants (MODEL_SPEC section 7.1)
and injection gating behavior (section 14)."""

import numpy as np
import pytest

from model.python.config import SimConfig
from model.python.simulate import simulate

GATED = dict(n_div=3.13, quantizer="ef1", actuator_mode="dsm_only",
             inj_gate_mode="threshold", inj_model="sin", k_inj=0.4,
             delta_f_hz=1e6, sigma_vco_w_rad=0.02)


# ---------------------------------------------------------------- dsm_only
@pytest.mark.parametrize("quant", ["nearest", "floor", "ef1"])
def test_dsm_only_invariants(quant):
    """dsm_only: integer-cycle quantization; the fractional actuator is
    absent on both paths."""
    res = simulate(SimConfig(n_div=3.13, quantizer=quant,
                             actuator_mode="dsm_only"))
    d = res.data
    g = res.g
    assert np.all(d["A_FB"] % g == 0), "A_FB must be whole cycles"
    for col in ("R_FB", "m_FB", "c_FB", "R_INJ", "j_INJ", "c_INJ"):
        assert np.all(d[col] == 0), f"{col} must be 0 in dsm_only"
    assert np.all(d["u_FB_digital"] == 0.0)
    assert np.all(d["u_INJ_digital"] == 0.0)
    assert np.all(d["u_INJ_analog"] == 0.0)  # ideal analog: tap0 + DTC(0)
    assert np.all(d["e_pair_digital"] == 0.0)
    assert np.all(np.diff(d["A_FB"]) > 0), "edges stay monotonic"
    # dsm_out is the integer cycle count Q(A_ideal / G)
    assert np.array_equal(d["dsm_out"] * g, d["A_FB"])


def test_dsm_only_e_zc_sweeps_half_cycle():
    """With u_INJ_actual = 0 the zero-crossing error is the raw fractional
    trajectory: e_ZC_hw = wrapCycles(x_ideal) sweeps up to +-0.5 cycle."""
    res = simulate(SimConfig(n_div=3.13, quantizer="ef1",
                             actuator_mode="dsm_only"))
    d = res.data
    x = d["x_ideal"]
    expect = x - np.floor(x)
    expect[expect > 0.5] -= 1.0
    assert np.allclose(d["e_ZC_hw"], expect, atol=1e-12)
    assert np.max(np.abs(d["e_ZC_hw"])) > 0.49  # actually sweeps the range
    assert np.max(d["e_ZC_hw"]) <= 0.5


def test_dsm_only_dsm_state_matches_cycle_quantizer():
    """ef1 state operates on cycles: |e_FB_abs| can approach a full cycle."""
    res = simulate(SimConfig(n_div=3.13, quantizer="ef1",
                             actuator_mode="dsm_only"))
    peak = np.max(np.abs(res.data["e_FB_abs"]))
    assert peak > 100.0 / 256.0  # far beyond fine-actuator half-LSB


def test_full_mode_unchanged_by_new_defaults():
    """Default config (actuator full, gate off) matches a config that sets
    the new fields explicitly."""
    a = simulate(SimConfig(n_div=3.13))
    b = simulate(SimConfig(n_div=3.13, actuator_mode="full",
                           inj_gate_mode="off"))
    for col in ("A_FB", "R_FB", "R_INJ", "e_ZC_hw", "inj_fired"):
        assert np.array_equal(a.data[col], b.data[col])


# ----------------------------------------------------------------- gating
def test_inj_fired_convention_no_injection():
    """inj_model='none' -> inj_fired all 0 (documented convention)."""
    res = simulate(SimConfig(n_div=3.13))
    assert np.all(res.data["inj_fired"] == 0)
    # gating mode makes no difference when there is no injection
    res2 = simulate(SimConfig(n_div=3.13, inj_gate_mode="threshold"))
    assert np.all(res2.data["inj_fired"] == 0)


def test_inj_fired_convention_gate_off():
    """inj_model != 'none', gate off -> inj_fired all 1."""
    res = simulate(SimConfig(n_div=3.13, inj_model="sin", k_inj=0.3))
    assert np.all(res.data["inj_fired"] == 1)


def test_gating_threshold_rule_and_no_kick():
    """fired == (|e_ZC_hw| <= threshold); non-fired cycles apply no kick."""
    res = simulate(SimConfig(**GATED))
    d = res.data
    thr = res.config.inj_gate_threshold_cycles
    assert thr == 0.0625
    mask = (np.abs(d["e_ZC_hw"]) <= thr).astype(np.int64)
    assert np.array_equal(d["inj_fired"], mask)
    assert 0 < int(mask.sum()) < len(mask)  # gate actually selects a subset
    assert np.all(d["delta_theta"][d["inj_fired"] == 0] == 0.0)
    assert np.any(d["delta_theta"][d["inj_fired"] == 1] != 0.0)


def test_gating_theta_accumulates_when_not_fired():
    """Between fires, theta_plus == theta_minus (wrapped): detuning/noise
    keeps accumulating with no correction."""
    res = simulate(SimConfig(**GATED))
    d = res.data
    idle = d["inj_fired"] == 0
    tm = d["theta_minus"][idle]
    tm_wrapped = tm - np.floor(tm / (2 * np.pi) + 0.5) * 2 * np.pi
    # wrapRadians convention: (-pi, pi]
    tm_wrapped[tm_wrapped <= -np.pi] += 2 * np.pi
    assert np.allclose(d["theta_plus"][idle], tm_wrapped, atol=1e-12)


def test_gating_custom_threshold():
    res = simulate(SimConfig(**{**GATED, "inj_gate_threshold_cycles": 0.25}))
    d = res.data
    mask = (np.abs(d["e_ZC_hw"]) <= 0.25).astype(np.int64)
    assert np.array_equal(d["inj_fired"], mask)
    assert mask.sum() > simulate(SimConfig(**GATED)).data["inj_fired"].sum()


def test_gating_improves_dsm_only_lock():
    """exp21 story: ungated dsm_only injection unlocks; gating restores a
    bounded residual (measured tail rms 1.81 -> 0.10 rad, seed 12345)."""
    ungated = simulate(SimConfig(**{**GATED, "inj_gate_mode": "off"}))
    gated = simulate(SimConfig(**GATED))
    rms = lambda x: float(np.sqrt(np.mean(np.asarray(x) ** 2)))
    rms_un = rms(ungated.data["theta_plus"][-256:])
    rms_gt = rms(gated.data["theta_plus"][-256:])
    assert rms_gt < 0.2
    assert rms_un > 1.0
    assert rms_gt < rms_un / 5.0
