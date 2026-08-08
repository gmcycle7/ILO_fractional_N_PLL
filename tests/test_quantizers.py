"""Acceptance Test 4: the 0.3-LSB canonical example (MODEL_SPEC section 6)."""

import numpy as np
import pytest

from model.python.dsm_first_order import ErrorFeedbackFirstOrder
from model.python.feedback_scheduler import make_quantizer
from model.python.mash11 import Mash11


def test_nearest_constant_minus_0p3():
    # u[k] = m[k] + 0.3 -> nearest gives fixed error -0.3 LSB every cycle
    q = make_quantizer("nearest")
    for k in range(100):
        u = 7 * k + 0.3
        y = q.quantize(u)
        assert y - u == pytest.approx(-0.3, abs=1e-9)


def test_ef1_0p3_lsb_canonical():
    # ef1: errors in {-0.3, +0.7}; long-term mean -> 0 (within 1e-3 over 2000)
    q = ErrorFeedbackFirstOrder()
    errs = []
    for k in range(2000):
        u = 5 * k + 0.3          # u[k] = m[k] + 0.3
        y = q.quantize(u)
        errs.append(y - u)
    errs = np.array(errs)
    # instantaneous error is either -0.3 or +0.7 LSB
    assert np.all((np.abs(errs + 0.3) < 1e-9) | (np.abs(errs - 0.7) < 1e-9))
    # peak |error| grows from 0.3 to 0.7
    assert np.max(np.abs(errs)) == pytest.approx(0.7, abs=1e-9)
    # first cycles follow the 0,0,0,1 pattern: -0.3,-0.3,-0.3,+0.7
    assert errs[0] == pytest.approx(-0.3, abs=1e-9)
    assert errs[1] == pytest.approx(-0.3, abs=1e-9)
    assert errs[2] == pytest.approx(-0.3, abs=1e-9)
    assert errs[3] == pytest.approx(0.7, abs=1e-9)
    # long-term mean -> 0 within 1e-3
    assert abs(np.mean(errs)) < 1e-3


def test_ef1_state_in_unit_interval():
    q = ErrorFeedbackFirstOrder()
    for k in range(500):
        q.quantize(k * 3.13 + 0.123)
        assert 0.0 <= q.state < 1.0


def test_mash11_spec_recursion():
    # independent reference implementation of section 6 item 5
    q = Mash11()
    acc1 = acc2 = 0.0
    c2_prev = 0
    import math
    for k in range(500):
        u = k * 801.28 / 256 * 256  # arbitrary growing input
        u = k * 3.13 * 256
        m = math.floor(u)
        f = u - m
        acc1 += f
        c1 = math.floor(acc1)
        acc1 -= c1
        acc2 += acc1
        c2 = math.floor(acc2)
        acc2 -= c2
        y_ref = m + c1 + (c2 - c2_prev)
        c2_prev = c2
        assert q.quantize(u) == y_ref


def test_truncate_equals_floor_for_nonneg():
    qt = make_quantizer("truncate")
    qf = make_quantizer("floor")
    for u in [0.0, 0.3, 5.99, 123.456]:
        assert qt.quantize(u) == qf.quantize(u)
