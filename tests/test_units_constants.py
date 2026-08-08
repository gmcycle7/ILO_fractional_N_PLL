"""Acceptance Test 1 (MODEL_SPEC section 19): canonical constants,
plus the frequency table of section 11."""

import pytest

from model.python import units


def test_n3p125_canonical_constants():
    # N=3.125, f_ref=4 GHz -> f_vco=12.5 GHz, T_vco=80 ps
    t_vco = units.t_vco(3.125, 4e9)
    assert t_vco == pytest.approx(80e-12, abs=1e-24)
    # 1 LSB = 80 ps / 256 = 312.5 fs
    lsb = units.dtc_lsb_s(3.125, 4e9, "normalized")
    assert lsb == pytest.approx(312.5e-15, abs=1e-27)
    # phase LSB = 360/256 = 1.40625 deg; half-LSB = 0.703125 deg
    assert units.phase_lsb_deg(256) == 1.40625
    assert units.phase_lsb_deg(256) / 2 == 0.703125
    # half-LSB in time = 156.25 fs
    assert lsb / 2 == pytest.approx(156.25e-15, abs=1e-27)


def test_check_values_section1():
    assert units.f_vco_hz(3.000, 4e9) == pytest.approx(12.0e9)
    assert units.t_vco(3.000, 4e9) == pytest.approx(83.3333333333e-12, rel=1e-9)
    assert units.f_vco_hz(3.125, 4e9) == pytest.approx(12.5e9)
    assert units.t_vco(3.125, 4e9) == pytest.approx(80.0e-12, rel=1e-12)
    assert units.f_vco_hz(3.250, 4e9) == pytest.approx(13.0e9)
    assert units.t_vco(3.250, 4e9) == pytest.approx(76.923076923e-12, rel=1e-9)


def test_frequency_table_section11_normalized_lsb():
    # | N | f_vco | normalized LSB |
    for n, lsb_fs in [(3.000, 325.5208333333), (3.125, 312.5), (3.250, 300.4807692308)]:
        assert units.dtc_lsb_s(n, 4e9, "normalized") / 1e-15 == pytest.approx(lsb_fs, rel=1e-9)


def test_fixed_time_lsb():
    # fixed-time LSB independent of N
    for n in (3.0, 3.125, 3.25):
        assert units.dtc_lsb_s(n, 4e9, "fixed_time", dtc_lsb_fs=312.5) == \
            pytest.approx(312.5e-15, rel=1e-12)
    # fixed-time phase LSB scales with f_vco
    assert units.phase_lsb_deg(256, n_div=3.125, dtc_mode="fixed_time") == pytest.approx(1.40625)
    assert units.phase_lsb_deg(256, n_div=3.25, dtc_mode="fixed_time") > 1.40625


def test_g_fine():
    assert units.g_fine(4, 6) == 256
