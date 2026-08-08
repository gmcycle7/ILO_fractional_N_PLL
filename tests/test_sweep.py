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
    ("ef1", {2, 3, 4, 5}),
    ("mash11", {2, 3, 4, 5}),
])
def test_n_sweep(quant, allowed):
    for n_div in NS:
        res = simulate(SimConfig(n_div=n_div, quantizer=quant, n_cycles=512))
        _check(res, allowed)
