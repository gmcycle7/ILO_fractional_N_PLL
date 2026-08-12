"""Test 18: actuator_mode='qnc' (MODEL_SPEC section 7.2) — integer-cycle
divider quantization + cancellation DTC fed the accumulated sub-cycle
residue, injection = modular reverse of the cancellation code."""

import numpy as np
import pytest

from model.python.config import SimConfig
from model.python.feedback_scheduler import lms_qnc_step
from model.python.simulate import simulate


def test_qnc_gain1_equivalent_to_full_within_1lsb():
    """qnc_gain=1.0 + nearest quantizer: feedback timing equivalent to the
    full actuator within 1 LSB — max|e_FB_abs| <= 1/512 + 1/256 at N=3.13.

    (Measured: 0.001875000000154614 cycles, identical to the full-actuator
    peak for the same config.)"""
    res = simulate(SimConfig(n_div=3.13, quantizer="nearest",
                             actuator_mode="qnc"))
    peak = float(np.max(np.abs(res.data["e_FB_abs"])))
    assert peak <= 1.0 / 512.0 + 1.0 / 256.0
    assert peak == pytest.approx(0.001875000000154614, abs=1e-15)
    # same peak as the full actuator (nearest, same grid)
    full = simulate(SimConfig(n_div=3.13, quantizer="nearest"))
    assert peak == pytest.approx(
        float(np.max(np.abs(full.data["e_FB_abs"]))), abs=1e-15)


def test_qnc_gain1_ef1_also_within_bound():
    """The cancellation DTC absorbs the coarse residue for DSM divider
    quantizers too (ef1 at N=3.13 stays monotonic and within the bound)."""
    res = simulate(SimConfig(n_div=3.13, quantizer="ef1",
                             actuator_mode="qnc"))
    peak = float(np.max(np.abs(res.data["e_FB_abs"])))
    assert peak <= 1.0 / 512.0 + 1.0 / 256.0


def test_qnc_gain_098_code_dependent_residual():
    """qnc_gain=0.98: a code-dependent residual appears — measured
    max|e_FB_abs| = 0.02125 cycles (5.44 fine LSB) at N=3.13, nearest,
    512 cycles; 444/512 cycles exceed the half-LSB bound."""
    res = simulate(SimConfig(n_div=3.13, quantizer="nearest",
                             actuator_mode="qnc", qnc_gain=0.98))
    e = np.abs(res.data["e_FB_abs"])
    peak = float(np.max(e))
    assert peak > 1.0 / 512.0 + 1.0 / 256.0  # beyond the gain-1 bound
    assert peak == pytest.approx(0.021250000000009095, abs=1e-12)
    assert int(np.sum(e > 1.0 / 512.0)) == 444


def test_qnc_mode_d_reverse_identity():
    """Mode-D modular-reverse identity holds in qnc mode:
    R_INJ = (R_zero - R_FB) mod 256 and e_pair_digital == 0 exactly."""
    for quant in ("nearest", "ef1"):
        res = simulate(SimConfig(n_div=3.13, quantizer=quant,
                                 actuator_mode="qnc", arch_mode="D"))
        d = res.data
        assert np.array_equal(d["R_INJ"], (-d["R_FB"]) % 256)
        assert np.all(d["e_pair_digital"] == 0.0)
        assert int(np.max(d["R_FB"])) > 0  # cancellation DTC is exercised


def test_qnc_reverse_regardless_of_arch_mode():
    """In qnc mode the injection side is ALWAYS the modular reverse of the
    cancellation code (spec section 7.2), whatever arch_mode says."""
    for mode in ("A", "B", "C"):
        res = simulate(SimConfig(n_div=3.13, quantizer="nearest",
                                 actuator_mode="qnc", arch_mode=mode))
        d = res.data
        assert np.array_equal(d["R_INJ"], (-d["R_FB"]) % 256)
        assert np.all(d["e_pair_digital"] == 0.0)


def test_qnc_structure_invariants():
    """A_FB = dsm_out * G + R_FB with 0 <= R_FB <= G-1; edges monotonic."""
    res = simulate(SimConfig(n_div=3.13, quantizer="nearest",
                             actuator_mode="qnc"))
    d = res.data
    assert np.array_equal(d["A_FB"], d["dsm_out"] * res.g + d["R_FB"])
    assert np.all((d["R_FB"] >= 0) & (d["R_FB"] <= res.g - 1))
    assert np.all(np.diff(d["A_FB"]) > 0)


def test_qnc_dsm_only_untouched():
    """dsm_only behavior is unchanged by the qnc addition."""
    res = simulate(SimConfig(n_div=3.13, quantizer="ef1",
                             actuator_mode="dsm_only"))
    d = res.data
    assert np.all(d["A_FB"] % res.g == 0)
    assert np.all(d["R_FB"] == 0)
    assert np.all(d["R_INJ"] == 0)


def test_qnc_gain_serialization():
    """qnc_gain omitted from to_dict() at its default (committed-vector
    byte-identity), serialized and round-tripped when non-default."""
    assert "qnc_gain" not in SimConfig().to_dict()
    cfg = SimConfig(actuator_mode="qnc", qnc_gain=0.98)
    d = cfg.to_dict()
    assert d["qnc_gain"] == 0.98
    assert SimConfig.from_dict(d) == cfg


def test_lms_qnc_step_pure_helper():
    """lms_qnc_step(gain, mu, e, r) = gain - mu*e*r (exact float64,
    left-to-right evaluation; deterministic)."""
    assert lms_qnc_step(1.0, 0.1, 0.5, 0.2) == 0.99
    assert lms_qnc_step(1.0, 0.0, 0.5, 0.2) == 1.0
    assert lms_qnc_step(0.98, 0.25, -0.5, 0.5) == 0.98 - 0.25 * -0.5 * 0.5
