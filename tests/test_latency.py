"""Acceptance Test 5: alpha=0.13, L=1 latency bug -> 46.8 degrees."""

import numpy as np
import pytest

from model.python.config import SimConfig
from model.python.phase_math import cycles_to_degrees, wrap_cycles
from model.python.simulate import simulate

HALF_LSB_DEG = 0.703125


def test_canonical_formula_exact():
    # phase error = wrapCycles(L*alpha) = 0.13 cycle = 46.8 deg
    assert cycles_to_degrees(wrap_cycles(1 * 0.13)) == pytest.approx(46.8, abs=1e-9)


def test_latency_bug_46p8_deg():
    res = simulate(SimConfig(n_div=3.13, latency_cycles=1, lookahead=False,
                             quantizer="nearest"))
    e_deg = np.abs(res.data["e_FB_abs"][2:]) * 360.0  # skip start-up padding
    # stale-state error 46.8 deg, modulated by <= half-LSB quantization
    assert np.all(np.abs(e_deg - 46.8) <= HALF_LSB_DEG + 1e-9)
    assert np.mean(e_deg) == pytest.approx(46.8, abs=0.75)
    # far larger than half-LSB (66.6x)
    assert np.mean(e_deg) / HALF_LSB_DEG > 60


def test_lookahead_removes_latency_error():
    res = simulate(SimConfig(n_div=3.13, latency_cycles=1, lookahead=True,
                             quantizer="nearest"))
    e_deg = np.abs(res.data["e_FB_abs"]) * 360.0
    assert np.max(e_deg) <= HALF_LSB_DEG + 1e-9  # quantization only


def test_metadata_bookkeeping():
    n = 16
    bug = simulate(SimConfig(n_div=3.13, n_cycles=n, latency_cycles=1,
                             lookahead=False))
    d = bug.data
    assert np.array_equal(d["k_applied"], np.arange(n))
    assert np.array_equal(d["k_computed"], np.clip(np.arange(n) - 1, 0, None))
    assert np.array_equal(d["seq_id"], np.clip(np.arange(n) - 1, 0, None))
    ok = simulate(SimConfig(n_div=3.13, n_cycles=n, latency_cycles=1,
                            lookahead=True))
    d = ok.data
    assert np.array_equal(d["k_computed"], np.clip(np.arange(n) - 1, 0, None))
    assert np.array_equal(d["seq_id"], np.arange(n))  # state of k applied at k
    assert len(ok.metadata) == n
    assert set(ok.metadata[3].keys()) == {"k_computed", "k_intended",
                                          "k_applied", "seq_id"}
