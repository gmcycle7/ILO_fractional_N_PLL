"""Acceptance Test 12: PSD sample rate = f_ref (axis ends at f_ref/2),
plus basic measurement helpers."""

import math

import numpy as np
import pytest

from model.python import measurements as meas
from model.python.config import SimConfig
from model.python.simulate import simulate

F_REF = 4e9


def test_psd_axis_max_is_half_f_ref():
    res = simulate(SimConfig(n_div=3.13))
    phi = 2 * math.pi * res.data["e_ZC_total"]
    freqs, psd = meas.periodogram_psd(phi, fs=F_REF)
    assert freqs[-1] == F_REF / 2  # exact
    assert len(psd) == len(freqs)


def test_psd_power_of_2_truncation():
    x = np.random.default_rng(0).normal(size=1000)  # not a power of 2
    freqs, psd = meas.periodogram_psd(x, fs=F_REF)
    n = 2 * (len(freqs) - 1)
    assert n == 512  # truncated down to 2^9
    assert freqs[-1] == F_REF / 2


def test_psd_white_noise_integrates_to_variance():
    rng = np.random.default_rng(1)
    x = rng.normal(0, 1.0, size=4096)
    freqs, psd = meas.periodogram_psd(x, fs=F_REF)
    df = freqs[1] - freqs[0]
    assert float(np.sum(psd) * df) == pytest.approx(np.var(x), rel=0.15)


def test_tone_detection_at_expected_spur_frequency():
    # period-P sequence -> spur at (m/P)*f_ref
    n = 1024
    p = 8
    k = np.arange(n)
    x = 0.01 * np.sin(2 * math.pi * k / p)
    freqs, psd = meas.periodogram_psd(x, fs=F_REF)
    spurs = meas.detect_spurs(freqs, psd, threshold_db=20)
    assert spurs, "expected a spur"
    assert spurs[0][0] == pytest.approx(F_REF / p, rel=1e-12)


def test_basic_stats():
    x = np.array([1.0, -1.0, 1.0, -1.0])
    assert meas.rms(x) == 1.0
    assert meas.peak_to_peak(x) == 2.0
    assert meas.mean(x) == 0.0
    counts, edges = meas.histogram(x, bins=4)
    assert counts.sum() == 4


def test_dbc_conventions():
    # tone amplitude a rad -> SSB spur 20*log10(a/2) dBc
    assert meas.tone_amp_to_dbc(0.02) == pytest.approx(20 * math.log10(0.01))
    s = meas.psd_to_dbc_per_hz(np.array([2.0]))
    assert s[0] == pytest.approx(0.0)


def test_integrated_phase():
    freqs = np.linspace(0, 2e9, 513)
    psd = np.full(513, 1e-18)
    val = meas.integrated_phase(freqs, psd, 0, 2e9)
    assert val == pytest.approx(math.sqrt(1e-18 * 2e9), rel=1e-2)
