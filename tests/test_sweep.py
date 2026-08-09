"""Acceptance Test 8: N sweep 3.00 .. 3.25 step 0.005 — monotonic edges,
legal codes, legal n_integer."""

import numpy as np
import pytest

from model.python.config import SimConfig
from model.python.simulate import simulate

NS = [3.0 + 0.005 * i for i in range(51)]  # 3.000 .. 3.250


def _check(res, allowed_nint):
    d = res.data
    a_fb = d["A_FB"]
    assert np.all(np.diff(a_fb) > 0), "edges must be monotonic"
    assert np.all((d["R_FB"] >= 0) & (d["R_FB"] < 256))
    assert np.all((d["m_FB"] >= 0) & (d["m_FB"] < 4))
    assert np.all((d["c_FB"] >= 0) & (d["c_FB"] < 64))
    assert np.all((d["R_INJ"] >= 0) & (d["R_INJ"] < 256))
    assert np.all((d["j_INJ"] >= 0) & (d["j_INJ"] < 8))
    assert np.all((d["c_INJ"] >= 0) & (d["c_INJ"] < 64))
    n_int = d["n_int"][:-1]  # last entry is padding
    assert set(np.unique(n_int).tolist()) <= allowed_nint, \
        f"illegal n_int values: {sorted(set(np.unique(n_int).tolist()) - allowed_nint)}"


@pytest.mark.parametrize("quant,allowed", [
    ("nearest", {3, 4}),
    ("floor", {3, 4}),
    # DSM quantizers: {2,3,4}; 2 only for alpha < ~3/256, 5 unreachable
    # for N in [3, 3.25] (MODEL_SPEC section 4); measured set for mash111
    # is also {2,3,4} — NOT wider than mash11 (empirically verified over
    # a 0.001-step N grid, 512 cycles)
    ("ef1", {2, 3, 4}),
    ("mash11", {2, 3, 4}),
    ("mash111", {2, 3, 4}),
])
def test_n_sweep(quant, allowed):
    for n_div in NS:
        res = simulate(SimConfig(n_div=n_div, quantizer=quant, n_cycles=512))
        _check(res, allowed)


# --- actuator_mode='dsm_only' (MODEL_SPEC section 7.1): quantization at
# integer-cycle granularity widens n_int per quantizer order (measured):
#   nearest/floor -> {3,4};  ef1 -> {2,3,4,5}
# mash11/mash111 in dsm_only at N in (3, 3.25) mostly violate divider
# legality (instantaneous ratio 0 -> duplicate edge) and are covered by
# test_dsm_only_mash_illegal_at_small_integer_part below.
@pytest.mark.parametrize("quant,allowed", [
    ("nearest", {3, 4}),
    ("floor", {3, 4}),
    ("ef1", {2, 3, 4, 5}),
])
def test_n_sweep_dsm_only(quant, allowed):
    for n_div in NS:
        res = simulate(SimConfig(n_div=n_div, quantizer=quant, n_cycles=512,
                                 actuator_mode="dsm_only"))
        _check_dsm_only(res, allowed)


def _check_dsm_only(res, allowed_nint):
    d = res.data
    assert np.all(np.diff(d["A_FB"]) > 0), "edges must be monotonic"
    assert np.all(d["A_FB"] % 256 == 0), "dsm_only A_FB must be whole cycles"
    for col in ("R_FB", "m_FB", "c_FB", "R_INJ", "j_INJ", "c_INJ"):
        assert np.all(d[col] == 0), f"dsm_only requires {col} == 0"
    n_int = d["n_int"][:-1]
    assert set(np.unique(n_int).tolist()) <= allowed_nint, \
        f"illegal n_int values: {sorted(set(np.unique(n_int).tolist()) - allowed_nint)}"


@pytest.mark.parametrize("quant", ["mash11", "mash111"])
def test_dsm_only_mash_illegal_at_small_integer_part(quant):
    """MASH order >= 2 modulating an N=3.13 integer divider drives the
    instantaneous divide ratio to 0 (duplicate edge) — the model's edge
    monotonicity assertion must fire (documented, section 7.1)."""
    with pytest.raises(AssertionError, match="monotonic"):
        simulate(SimConfig(n_div=3.13, quantizer=quant,
                           actuator_mode="dsm_only", n_cycles=512))
