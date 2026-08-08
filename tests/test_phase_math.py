"""MODEL_SPEC section 2 wrap/quantize primitives."""

import math

import numpy as np
import pytest

from model.python import phase_math as pm


def test_wrap01():
    assert pm.wrap01(0.0) == 0.0
    assert pm.wrap01(1.0) == 0.0
    assert pm.wrap01(3.13) == pytest.approx(0.13)
    assert pm.wrap01(-0.25) == 0.75
    assert 0.0 <= pm.wrap01(123.456) < 1.0


def test_wrap_cycles_range_and_values():
    # range (-0.5, 0.5]
    assert pm.wrap_cycles(0.5) == 0.5
    assert pm.wrap_cycles(0.5000000001) == pytest.approx(-0.4999999999)
    assert pm.wrap_cycles(1.0) == 0.0
    assert pm.wrap_cycles(-3.13) == pytest.approx(-0.13)
    assert pm.wrap_cycles(0.87) == pytest.approx(-0.13)
    assert pm.wrap_cycles(0.13) == pytest.approx(0.13)


def test_wrap_radians():
    assert pm.wrap_radians(math.pi) == pytest.approx(math.pi)
    assert pm.wrap_radians(3 * math.pi) == pytest.approx(math.pi)
    assert pm.wrap_radians(-0.1) == pytest.approx(-0.1)
    assert pm.wrap_radians(2 * math.pi) == pytest.approx(0.0, abs=1e-15)


def test_conversions():
    assert pm.cycles_to_time(0.5, 80e-12) == 40e-12
    assert pm.cycles_to_degrees(0.13) == pytest.approx(46.8)
    assert pm.cycles_to_radians(1.0) == pytest.approx(2 * math.pi)
    assert pm.time_to_cycles(40e-12, 80e-12) == 0.5


def test_q_nearest_is_half_up_not_bankers():
    # q_nearest(x) = floor(x + 0.5): half-up in both Python and JS.
    assert pm.q_nearest(2.5) == 3      # Python round(2.5) == 2 (bankers) - forbidden
    assert pm.q_nearest(3.5) == 4
    assert pm.q_nearest(-0.5) == 0
    assert pm.q_nearest(-1.5) == -1
    assert pm.q_nearest(0.49999) == 0
    assert pm.q_nearest(86.272) == 86
    assert isinstance(pm.q_nearest(2.5), int)


def test_q_floor():
    assert pm.q_floor(2.9) == 2
    assert pm.q_floor(-0.1) == -1
    assert pm.q_floor(3.0) == 3


def test_array_versions_match_scalar():
    xs = np.array([-3.13, -0.5, 0.0, 0.13, 0.5, 0.87, 1.0, 2.75])
    for x, w0, wc in zip(xs, pm.wrap01_arr(xs), pm.wrap_cycles_arr(xs)):
        assert w0 == pm.wrap01(float(x))
        assert wc == pm.wrap_cycles(float(x))
