"""Acceptance Tests 2, 3, 13: mode D modular-reverse identity, the u=0.337
canonical example, and shared vs independent pair-error behavior."""

import numpy as np
import pytest

from model.python.config import SimConfig
from model.python.phase_math import q_nearest, wrap01, wrap_cycles
from model.python.simulate import simulate

ALL_QUANTIZERS = ["floor", "nearest", "truncate", "ef1", "mash11"]


@pytest.mark.parametrize("quant", ALL_QUANTIZERS)
def test_mode_d_identity_all_quantizers(quant):
    """Test 2 + Test 13 (shared half): R_INJ = (-R_FB) mod 256 and
    e_pair_digital == 0 exactly for every cycle and every quantizer."""
    res = simulate(SimConfig(n_div=3.13, quantizer=quant, arch_mode="D"))
    d = res.data
    assert np.array_equal(d["R_INJ"], (-d["R_FB"]) % 256)
    assert np.array_equal((d["R_FB"] + d["R_INJ"]) % 256,
                          np.zeros(len(d["k"]), dtype=np.int64))
    # exact zero, not approx
    assert np.all(d["e_pair_digital"] == 0.0)


def test_mode_b_pair_error_nonzero():
    """Test 13 (independent half): independent DSMs break the cycle-by-cycle
    reverse relation."""
    res = simulate(SimConfig(n_div=3.13, quantizer="ef1", arch_mode="B"))
    assert np.max(np.abs(res.data["e_pair_digital"])) > 0.0


def test_u0337_canonical_example_standalone():
    """Test 3 (MODEL_SPEC section 9), N=3.125 constants (T_vco = 80 ps)."""
    t_vco = 80e-12
    g = 256
    u_fb_ideal = 0.337
    fine = g * u_fb_ideal
    assert fine == pytest.approx(86.272, abs=1e-9)
    r_fb = q_nearest(fine)
    assert r_fb == 86
    u_fb_actual = r_fb / g
    assert u_fb_actual == 0.3359375
    e_fb = wrap_cycles(u_fb_actual - u_fb_ideal)
    assert e_fb == pytest.approx(-0.0010625, abs=1e-12)
    assert e_fb * t_vco / 1e-15 == pytest.approx(-85.0, abs=1e-3)  # -85 fs
    r_inj = (0 - r_fb) % g
    assert r_inj == 170
    u_inj_actual = r_inj / g
    assert u_inj_actual == 0.6640625
    u_inj_ideal = wrap01(0.0 - u_fb_ideal)
    assert u_inj_ideal == pytest.approx(0.663, abs=1e-12)
    e_inj = wrap_cycles(u_inj_actual - u_inj_ideal)
    assert e_inj == pytest.approx(+0.0010625, abs=1e-12)
    assert e_inj * t_vco / 1e-15 == pytest.approx(+85.0, abs=1e-3)  # +85 fs
    # pair digitally exact reverse
    assert u_fb_actual + u_inj_actual == 1.0
    assert wrap_cycles(u_fb_actual + u_inj_actual - 0.0) == 0.0


def test_u0337_in_simulation():
    """Same numbers reproduced by the full engine (x_ideal[1]=0.337 with
    N=3.337)."""
    res = simulate(SimConfig(n_div=3.337, quantizer="nearest", arch_mode="D"))
    d = res.data
    assert d["R_FB"][1] == 86
    assert d["R_INJ"][1] == 170
    assert d["u_FB_digital"][1] == 0.3359375
    assert d["u_INJ_digital"][1] == 0.6640625
    assert d["e_FB_abs"][1] == pytest.approx(-0.0010625, abs=1e-12)
    assert d["e_INJ_abs"][1] == pytest.approx(+0.0010625, abs=1e-12)
    assert d["e_pair_digital"][1] == 0.0


def test_on_grid_exactness():
    """Section 4 assertion: on-grid alpha (N=3.125) must be exact."""
    for n in (3.0, 3.125, 3.25):
        res = simulate(SimConfig(n_div=n, quantizer="nearest"))
        assert np.all(res.data["e_FB_abs"] == 0.0)
        assert np.all(res.data["e_pair_digital"] == 0.0)
        assert np.all(res.data["e_ZC_hw"] == 0.0)
