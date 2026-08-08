"""Acceptance Tests 6, 7: 1-degree tap mismatch (222.22 fs) and 1% DTC gain
mismatch (200 fs) at T_vco = 80 ps."""

import numpy as np
import pytest

from model.python.config import SimConfig
from model.python.dtc_model import DTCModel
from model.python.phase_math import cycles_to_time
from model.python.simulate import simulate
from model.python.tap_model import tap_actual

T_VCO = 80e-12  # N = 3.125
HALF_LSB_FS = 156.25


def test_1deg_tap_mismatch_222fs():
    # 1 deg = 80 ps / 360 = 222.22... fs ~= 0.711 LSB
    err_s = cycles_to_time(1.0 / 360.0, T_VCO)
    assert err_s / 1e-15 == pytest.approx(222.2222222222, rel=1e-9)
    # tap model places tap j at j/8 + delta
    assert tap_actual(3, 8, [1.0 / 360.0] * 8) == pytest.approx(3 / 8 + 1 / 360.0)
    # larger than half-LSB (156.25 fs)  [INFERENCE in spec]
    assert err_s / 1e-15 > HALF_LSB_FS
    assert err_s / 1e-15 / (312.5) == pytest.approx(0.7111111, abs=1e-4)  # LSB


def test_1deg_tap_mismatch_in_simulation():
    cfg = SimConfig(n_div=3.125, tap_mismatch_cycles=[1.0 / 360.0] * 8)
    res = simulate(cfg)
    e_zc_fs = res.data["e_ZC_hw"] * res.t_vco_s / 1e-15
    # on-grid N: only the static tap offset remains
    assert np.all(np.abs(e_zc_fs - 222.2222222222) < 1e-6)


def test_1pct_dtc_gain_200fs():
    # DTC full range = T_vco/4 = 20 ps; 1% gain error -> max 200 fs
    full_range = T_VCO / 4
    assert full_range == pytest.approx(20e-12)
    max_err_s = 0.01 * full_range
    assert max_err_s / 1e-15 == pytest.approx(200.0, rel=1e-12)
    assert max_err_s / 1e-15 > HALF_LSB_FS
    assert max_err_s / 1e-15 / 312.5 == pytest.approx(0.64, abs=1e-12)  # LSB


def test_1pct_gain_dtc_model_per_code():
    dtc = DTCModel(n_codes=64, lsb_cycles=1 / 256, gain=1.01)
    ideal = np.arange(64) / 256
    err_cycles = dtc.table - ideal
    # error grows linearly with code; at c=63: 0.01*63/256 cycles = 196.875 fs
    assert err_cycles[0] == 0.0
    assert err_cycles[63] == pytest.approx(0.01 * 63 / 256, abs=1e-15)
    assert cycles_to_time(err_cycles[63], T_VCO) / 1e-15 == pytest.approx(196.875, abs=1e-6)


def test_gain_mismatch_in_simulation():
    # N=3.13 exercises the full injection DTC code range (N=3.125 uses only
    # multiples of 32 LSB, where the naive-mapping DTC code is always 0)
    cfg = SimConfig(n_div=3.13, dtc_fb_gain=1.0, dtc_inj_gain=1.01)
    res = simulate(cfg)
    e_pair_fs = np.abs(res.data["e_pair_analog"]) * res.t_vco_s / 1e-15
    # code-dependent: bounded by 200 fs, nonzero for nonzero DTC codes
    assert np.max(e_pair_fs) <= 200.0 + 1e-6
    assert np.max(e_pair_fs) > 0.0
    nonzero_c = res.data["c_INJ"] > 0
    assert np.any(np.abs(res.data["e_pair_analog"][nonzero_c]) > 0.0)


def test_dnl_frozen_per_instance():
    from model.python.noise_models import Mulberry32
    a = DTCModel(n_codes=64, lsb_cycles=1 / 256, dnl_sigma_lsb=0.1,
                 dnl_stream=Mulberry32(42))
    b = DTCModel(n_codes=64, lsb_cycles=1 / 256, dnl_sigma_lsb=0.1,
                 dnl_stream=Mulberry32(42))
    assert np.array_equal(a.table, b.table)
    assert a.dnl_cum_lsb[0] == 0.0
    assert np.any(a.dnl_cum_lsb != 0.0)
