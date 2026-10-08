"""Redundancy-based dynamic element matching (DEM) for the injection tap/DTC
mapping: inj_mapping='redundant_random' (MODEL_SPEC section 8 item 4,
acceptance test 20; experiment exp24).

Tap spacing is 32 LSB and the injection DTC spans 64 LSB, so every R_INJ has
two phase-equivalent representations:
    naive       (j0, c0)             = (floor(R/32), R mod 32)
    alternative ((j0 - 1) mod 8, c0 + 32)
'redundant_random' draws ONE uniform per cycle from the 'map_inj' stream
(offset 11) and picks the alternative iff u < map_rand_p.
"""

import math

import numpy as np
import pytest

from model.python import measurements as meas
from model.python.config import SimConfig
from model.python.dtc_model import make_dtc
from model.python.experiments import PRESETS
from model.python.injection_scheduler import run_injection
from model.python.noise_models import Mulberry32, make_all_streams
from model.python.simulate import simulate
from model.python.tap_model import tap_table

NS = [3.0, 3.005, 3.125, 3.13, 3.2, 3.22265625, 3.249]
PS = [0.0, 0.25, 0.5, 0.75, 1.0]

#: exp24 mismatch (fixed literal list, cycles) + 1% injection DTC gain
TAP = [0.0032, -0.0027, 0.0011, -0.0038, 0.0030, -0.0013, 0.0035, -0.0024]
MISMATCH = dict(tap_mismatch_cycles=TAP, dtc_inj_gain=1.01)

#: columns that only depend on the digital command words
DIGITAL_COLS = ["A_FB", "R_FB", "m_FB", "c_FB", "n_int", "R_INJ",
                "u_FB_digital", "u_INJ_digital", "e_FB_abs", "e_INJ_abs",
                "e_pair_digital"]


def _dem(p, **kw):
    return SimConfig(inj_mapping="redundant_random", map_rand_p=p, **kw)


# --- phase equivalence -------------------------------------------------

@pytest.mark.parametrize("n_div", NS)
@pytest.mark.parametrize("p", PS)
def test_ideal_analog_identical_to_naive(n_div, p):
    """Ideal analog: the two representations are the same phase, so
    u_INJ_digital, e_ZC_hw and every other error column are identical to
    naive for ANY p (exact, not approx)."""
    a = simulate(SimConfig(n_div=n_div, inj_mapping="naive")).data
    b = simulate(_dem(p, n_div=n_div)).data
    assert np.array_equal(a["u_INJ_digital"], b["u_INJ_digital"])
    assert np.array_equal(a["e_ZC_hw"], b["e_ZC_hw"])
    assert np.array_equal(a["e_pair_analog"], b["e_pair_analog"])
    for col in DIGITAL_COLS:
        assert np.array_equal(a[col], b[col]), col
    # the analog command differs at most by a whole cycle (tap 0 -> tap 7)
    d = b["u_INJ_analog"] - a["u_INJ_analog"]
    assert np.all((d == 0.0) | (d == 1.0))
    # the DEM really switches representation: the alternative (c >= 32) is
    # taken on some cycles iff p > 0, and the naive one on some iff p < 1
    n_alt = int(np.sum(b["c_INJ"] >= 32))
    assert (n_alt > 0) == (p > 0.0)
    assert (n_alt < len(b["k"])) == (p < 1.0)


@pytest.mark.parametrize("arch,quant", [("A", "nearest"), ("B", "ef1"),
                                        ("C", "mash11"), ("D", "mash111")])
def test_all_arch_modes_digital_layer_unchanged(arch, quant):
    """The decode runs in every architecture mode; the digital layer never
    sees the DEM choice (also with analog mismatch present)."""
    kw = dict(n_div=3.13, arch_mode=arch, quantizer=quant, **MISMATCH)
    a = simulate(SimConfig(inj_mapping="naive", **kw)).data
    b = simulate(_dem(0.5, **kw)).data
    for col in DIGITAL_COLS:
        assert np.array_equal(a[col], b[col]), col
    assert np.array_equal((32 * b["j_INJ"] + b["c_INJ"]) % 256, b["R_INJ"])
    # ... but the analog layer does (mismatch makes the two differ)
    assert not np.array_equal(a["e_ZC_hw"], b["e_ZC_hw"])


def test_qnc_and_dsm_only_actuators():
    # qnc: decode runs as usual
    kw = dict(n_div=3.13, actuator_mode="qnc")
    a = simulate(SimConfig(inj_mapping="naive", **kw)).data
    b = simulate(_dem(0.5, **kw)).data
    assert np.array_equal(a["u_INJ_digital"], b["u_INJ_digital"])
    assert np.array_equal(a["e_ZC_hw"], b["e_ZC_hw"])
    assert np.any(b["c_INJ"] >= 32)
    # dsm_only: no fractional actuator, no decode -> codes stay 0
    kw = dict(n_div=3.13, actuator_mode="dsm_only", quantizer="ef1")
    a = simulate(SimConfig(inj_mapping="naive", **kw)).data
    b = simulate(_dem(1.0, **kw)).data
    assert np.all(b["j_INJ"] == 0) and np.all(b["c_INJ"] == 0)
    assert np.array_equal(a["e_ZC_hw"], b["e_ZC_hw"])


# --- p = 0 / p = 1 limits ----------------------------------------------

@pytest.mark.parametrize("n_div", NS)
def test_p0_reproduces_naive_exactly(n_div):
    a = simulate(SimConfig(n_div=n_div, inj_mapping="naive", **MISMATCH)).data
    b = simulate(_dem(0.0, n_div=n_div, **MISMATCH)).data
    assert set(a.keys()) == set(b.keys())
    for col in a:
        assert np.array_equal(a[col], b[col]), col


@pytest.mark.parametrize("n_div", NS)
def test_p1_always_alternative(n_div):
    a = simulate(SimConfig(n_div=n_div, inj_mapping="naive")).data
    b = simulate(_dem(1.0, n_div=n_div)).data
    assert np.array_equal(b["j_INJ"], (a["j_INJ"] - 1) % 8)
    assert np.array_equal(b["c_INJ"], a["c_INJ"] + 32)
    assert np.all(b["c_INJ"] >= 32) and np.all(b["c_INJ"] <= 63)


# --- legality ----------------------------------------------------------

@pytest.mark.parametrize("quant", ["nearest", "floor", "ef1", "mash11",
                                   "mash111"])
def test_codes_always_legal(quant):
    for i in range(0, 51):
        n_div = 3.0 + 0.005 * i
        for p in (0.0, 0.5, 1.0):
            d = simulate(_dem(p, n_div=n_div, quantizer=quant)).data
            assert np.all((d["j_INJ"] >= 0) & (d["j_INJ"] <= 7))
            assert np.all((d["c_INJ"] >= 0) & (d["c_INJ"] <= 63))
            assert np.array_equal((32 * d["j_INJ"] + d["c_INJ"]) % 256,
                                  d["R_INJ"])


# --- PRNG contract -----------------------------------------------------

def test_choice_follows_map_inj_stream():
    """Cycle k picks the alternative iff the k-th draw of the 'map_inj'
    stream (seed + 11) is < map_rand_p."""
    for seed, p in [(12345, 0.5), (777, 0.25), (1, 0.9)]:
        d = simulate(_dem(p, n_div=3.13, seed=seed)).data
        rng = Mulberry32(seed + 11)
        expect = np.array([rng.next() < p for _ in range(len(d["k"]))])
        assert np.array_equal(d["c_INJ"] >= 32, expect)
    # p = 0.5, seed 12345, 512 cycles: both representations are used
    d = simulate(_dem(0.5, n_div=3.13)).data
    n_alt = int(np.sum(d["c_INJ"] >= 32))
    assert n_alt == 266  # measured; 52% of 512


def test_deterministic_repeatability():
    cfg = _dem(0.5, n_div=3.13, **MISMATCH)
    a = simulate(cfg).data
    b = simulate(cfg).data
    for col in a:
        assert np.array_equal(a[col], b[col]), col
    # a different base seed changes the DEM choice sequence
    c = simulate(cfg.replace(seed=54321)).data
    assert not np.array_equal(a["c_INJ"], c["c_INJ"])
    assert np.array_equal(a["R_INJ"], c["R_INJ"])


@pytest.mark.parametrize("p", [0.0, 0.5, 1.0])
def test_draw_consumed_every_cycle(p):
    """Exactly one 'map_inj' draw per cycle, also for p = 0 and p = 1; no
    other stream is touched by the mapping."""
    cfg = _dem(p, n_div=3.13, n_cycles=100)
    streams = make_all_streams(cfg.seed)
    dtc_inj = make_dtc(cfg, "inj", streams)
    x = np.mod(np.arange(cfg.n_cycles) * cfg.n_div, 1.0)
    r_fb = np.arange(cfg.n_cycles, dtype=np.int64) * 57 % 256
    run_injection(cfg, x, r_fb, dtc_inj, tap_table(cfg.n_tap),
                  dither_stream=streams["dither_inj"],
                  dsm_stream=streams["dsm_inj"],
                  map_stream=streams["map_inj"])
    ref = Mulberry32(cfg.seed + 11)
    for _ in range(cfg.n_cycles):
        ref.next()
    assert streams["map_inj"].next() == ref.next()
    assert streams["dsm_inj"].next() == Mulberry32(cfg.seed + 10).next()
    assert streams["dither_inj"].next() == Mulberry32(cfg.seed + 5).next()


def test_default_stream_when_called_directly():
    """run_injection without map_stream builds 'map_inj' from cfg.seed."""
    cfg = _dem(0.5, n_div=3.13, n_cycles=64)
    streams = make_all_streams(cfg.seed)
    dtc_inj = make_dtc(cfg, "inj", streams)
    x = np.mod(np.arange(cfg.n_cycles) * cfg.n_div, 1.0)
    r_fb = np.arange(cfg.n_cycles, dtype=np.int64) * 57 % 256
    a = run_injection(cfg, x, r_fb, dtc_inj, tap_table(cfg.n_tap))
    b = run_injection(cfg, x, r_fb, dtc_inj, tap_table(cfg.n_tap),
                      map_stream=Mulberry32(cfg.seed + 11))
    assert np.array_equal(a["j_INJ"], b["j_INJ"])
    assert np.array_equal(a["c_INJ"], b["c_INJ"])


# --- config ------------------------------------------------------------

def test_config_validation_and_serialization():
    assert SimConfig().map_rand_p == 0.5
    with pytest.raises(ValueError):
        SimConfig(map_rand_p=-0.1)
    with pytest.raises(ValueError):
        SimConfig(map_rand_p=1.5)
    # 4 taps -> tap step 64 LSB: the 64-LSB DTC cannot hold c0 + 64
    with pytest.raises(ValueError):
        SimConfig(inj_mapping="redundant_random", n_tap=4,
                  tap_mismatch_cycles=[0.0] * 4)
    # omit-at-default serialization (schema stability, spec section 18)
    assert "map_rand_p" not in SimConfig().to_dict()
    assert "map_rand_p" not in _dem(0.5).to_dict()
    d = _dem(0.25).to_dict()
    assert d["map_rand_p"] == 0.25 and d["inj_mapping"] == "redundant_random"
    assert SimConfig.from_dict(d).map_rand_p == 0.25


# --- exp24: measured numbers quoted in expected_result -------------------

def _exp24_metrics(cfg):
    res = simulate(cfg)
    e = res.data["e_ZC_hw"]
    fs_per_cycle = res.t_vco_s / 1e-15
    freqs, psd = meas.periodogram_psd(2.0 * math.pi * e, fs=cfg.f_ref_hz)
    p_db = 10.0 * np.log10(np.maximum(psd, np.finfo(np.float64).tiny))
    # the periodic cases (a)/(c) have a numerically-zero median floor, so
    # detect_spurs may also return FFT round-off peaks (below -400 dB, FFT
    # implementation dependent); real spurs are counted above -200 dB
    spurs = [s for s in meas.detect_spurs(freqs, psd) if s[1] > -200.0]
    df = freqs[1] - freqs[0]

    def level(f_hz):
        return float(p_db[int(math.floor(f_hz / df + 0.5))])

    return {
        "rms_fs": meas.rms(e) * fs_per_cycle,
        "peak_fs": float(np.max(np.abs(e))) * fs_per_cycle,
        "mean_fs": meas.mean(e) * fs_per_cycle,
        "ac_rms_fs": float(np.std(e)) * fs_per_cycle,
        "n_spurs": len(spurs),
        "top_f": spurs[0][0],
        "top_db": spurs[0][1],
        "floor_db": float(np.median(p_db)),
        "l437": level(437.5e6),
        "l875": level(875e6),
        "l890": level(890.625e6),
        "n_alt": int(np.sum(res.data["c_INJ"] >= 32)),
        "max_e_fb": float(np.max(np.abs(res.data["e_FB_abs"]))),
    }


def test_exp24_measured_numbers():
    """exp24 (naive vs redundant_random p=0.5 vs calibrated) — the numbers
    written in expected_result, measured (seed 12345, 2048 cycles)."""
    cfgs = PRESETS["exp24"]["configs"]
    assert [c.inj_mapping for c in cfgs] == ["naive", "redundant_random",
                                             "calibrated"]
    for c in cfgs:
        assert c.n_div == 3.22265625 and c.n_cycles == 2048
        assert (c.n_div - 3.0) * 256.0 == 57.0  # on-grid: alpha*G = 57
        assert c.tap_mismatch_cycles == TAP and c.dtc_inj_gain == 1.01
    tap_rms_deg = 360.0 * math.sqrt(sum(t * t for t in TAP) / 8.0)
    assert tap_rms_deg == pytest.approx(1.0012, abs=1e-4)

    a, b, c = (_exp24_metrics(cfg) for cfg in cfgs)
    # quantization error identically zero -> e_ZC_hw is pure mismatch error
    assert a["max_e_fb"] == 0.0 and b["max_e_fb"] == 0.0

    # (a) naive: purely periodic (period 256) -> all 127 harmonics, no floor
    assert a["rms_fs"] == pytest.approx(223.80, abs=0.05)
    assert a["peak_fs"] == pytest.approx(365.45, abs=0.05)
    assert a["mean_fs"] == pytest.approx(52.79, abs=0.05)
    assert a["ac_rms_fs"] == pytest.approx(217.48, abs=0.05)
    assert a["n_spurs"] == 127
    assert a["top_f"] == 437.5e6
    assert a["top_db"] == pytest.approx(-101.23, abs=0.05)
    assert a["l890"] == pytest.approx(-111.14, abs=0.05)
    assert a["l875"] == pytest.approx(-119.71, abs=0.05)
    assert a["floor_db"] < -400.0  # numerical zero

    # (b) DEM p=0.5: spurs -> floor, but rms and peak get LARGER
    assert b["n_alt"] == 1084
    assert b["rms_fs"] == pytest.approx(246.14, abs=0.05)
    assert b["peak_fs"] == pytest.approx(462.42, abs=0.05)
    assert b["mean_fs"] == pytest.approx(105.28, abs=0.05)
    assert b["ac_rms_fs"] == pytest.approx(222.49, abs=0.05)
    assert b["rms_fs"] > a["rms_fs"] and b["peak_fs"] > a["peak_fs"]
    assert b["n_spurs"] == 2
    assert b["top_f"] == 890.625e6
    assert b["top_db"] == pytest.approx(-111.00, abs=0.05)
    assert b["l437"] == pytest.approx(-126.37, abs=0.05)
    assert b["l875"] == pytest.approx(-118.66, abs=0.05)
    assert b["floor_db"] == pytest.approx(-129.86, abs=0.05)
    # strongest-spur reduction 9.8 dB; the fundamental itself is NOT reduced
    assert a["top_db"] - b["top_db"] == pytest.approx(9.77, abs=0.05)
    assert abs(b["l890"] - a["l890"]) < 0.5
    assert b["top_db"] - b["floor_db"] == pytest.approx(18.86, abs=0.05)

    # (c) calibrated: smaller error, still periodic (no floor)
    assert c["rms_fs"] == pytest.approx(60.28, abs=0.05)
    assert c["peak_fs"] == pytest.approx(124.00, abs=0.05)
    assert c["mean_fs"] == pytest.approx(3.57, abs=0.05)
    assert c["n_spurs"] == 127
    assert c["top_f"] == 437.5e6
    assert c["top_db"] == pytest.approx(-116.27, abs=0.05)
    assert c["l890"] == pytest.approx(-124.54, abs=0.05)
    assert a["top_db"] - c["top_db"] == pytest.approx(15.04, abs=0.05)
    assert c["floor_db"] < -400.0
