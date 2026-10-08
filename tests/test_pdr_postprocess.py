"""PDR/PRC extraction kit (extraction/, PDR_EXTRACTION.md).

Synthetic round trip: raw transient-kick data fabricated from a KNOWN
asymmetric PDR  delta_theta(e) = -K*(sin e + 0.3*sin 2e), K = 0.3  (plus
10 fs rms timing noise per crossing) -> extraction/postprocess_pdr.py ->
64-point LUT, compared with the truth; the reported K_inj with the analytic
small-signal slope K*(1 + 2*0.3) = 0.48; and simulate(inj_model='lut') with
the recovered LUT must lock.  The Spectre side is a template (NOT RUN); only
its Python driver (dry-run / render / anchor / collect) is tested here.
"""

import math
import os

import numpy as np
import pytest

from extraction import postprocess_pdr as pp
from extraction import run_sweep as rs
from model.python.config import SimConfig
from model.python.simulate import simulate

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLE_CSV = os.path.join(REPO_ROOT, "examples", "pdr_example_asymmetric.csv")

K, H2 = 0.3, 0.3
TRUTH = rs.truth_pdr("asym", K, H2)
K_SMALL_SIGNAL = K * (1.0 + 2.0 * H2)          # -d/de at 0 = 0.48
F_REF = 4e9


def _truth_peak():
    """max of the truth: cos e + 2*H2*cos 2e = 0 -> 4*H2*c^2 + c - 2*H2 = 0."""
    c = (-1.0 + math.sqrt(1.0 + 32.0 * H2 * H2)) / (8.0 * H2)
    e = -math.acos(c)
    return float(TRUTH(e)), e


def _truth_fixed_point(a):
    """Stable steady state of e -> e + a + truth(e) on the branch around 0."""
    _, e_pk = _truth_peak()
    lo, hi = e_pk, -e_pk
    for _ in range(200):
        m = 0.5 * (lo + hi)
        if TRUTH(m) + a > 0.0:
            lo = m
        else:
            hi = m
    return 0.5 * (lo + hi)


def _lut_fixed_point(lut, a):
    e = np.array([p[0] for p in lut])
    d = np.array([p[1] for p in lut])
    lo, hi = -1.0, 1.0
    for _ in range(200):
        m = 0.5 * (lo + hi)
        if np.interp(m, e, d) + a > 0.0:
            lo = m
        else:
            hi = m
    return 0.5 * (lo + hi)


@pytest.fixture(scope="module")
def recovered():
    raw = rs.synthesize_raw("asym", K, H2, n_phi=128, sigma_t_s=10e-15,
                            seed=20261005)
    return pp.postprocess(raw, n_points=64, f_ref_hz=F_REF)


# ---------------------------------------------------------------------------
# sign convention (MODEL_SPEC section 14)
# ---------------------------------------------------------------------------
def test_sign_mapping_late_pulse_pulls_vco_later():
    t_vco = 80e-12
    # pulse 0.1 cycle LATE vs the zero crossing; the injected edge comes
    # 0.02 cycle LATER than the reference edge (VCO pulled toward the pulse)
    e, d = pp.raw_to_samples([0.1], [1e-7], [1e-7 + 0.02 * t_vco], [t_vco])
    assert e[0] == pytest.approx(0.2 * math.pi, abs=1e-12)
    assert d[0] == pytest.approx(-0.04 * math.pi, abs=1e-9)
    # pulse EARLY (phi = 0.9 -> e = -0.2*pi): VCO edge pulled earlier
    e, d = pp.raw_to_samples([0.9], [1e-7], [1e-7 - 0.02 * t_vco], [t_vco])
    assert e[0] == pytest.approx(-0.2 * math.pi, abs=1e-12)
    assert d[0] == pytest.approx(0.04 * math.pi, abs=1e-9)
    # e range is (-pi, pi]: phi = 0.5 -> +pi
    e, _ = pp.raw_to_samples([0.5], [0.0], [0.0], [t_vco])
    assert e[0] == pytest.approx(math.pi, abs=1e-15)


def test_synthetic_generator_inverts_the_mapping():
    raw = rs.synthesize_raw("asym", K, H2, n_phi=64, sigma_t_s=0.0)
    e, d = pp.raw_to_samples(raw["phi_inj_cycles"], raw["t_cross_ref_s"],
                             raw["t_cross_inj_s"], raw["t_vco_s"])
    assert np.max(np.abs(d - TRUTH(e))) < 1e-9


# ---------------------------------------------------------------------------
# synthetic round trip: asymmetric PDR
# ---------------------------------------------------------------------------
def test_round_trip_lut_matches_truth(recovered):
    res = recovered
    assert len(res.lut_e) == 64
    assert res.lut_e[0] == -math.pi and res.lut_e[-1] == math.pi
    assert np.allclose(np.diff(res.lut_e), 2.0 * math.pi / 63, rtol=0,
                       atol=1e-12)
    err = res.lut_d - TRUTH(res.lut_e)
    assert np.max(np.abs(err)) < 6e-3            # 2% of K
    assert np.sqrt(np.mean(err ** 2)) < 2e-3
    # periodic consistency of the endpoints (winding 0)
    assert res.samples.winding == 0
    assert res.lut_d[0] == pytest.approx(res.lut_d[-1], abs=1e-12)
    # the phi = 0 and phi = 1 rows were merged
    assert res.samples.n_raw == 129 and len(res.samples.e) == 128


def test_round_trip_report_matches_analytic(recovered):
    rep = recovered.report
    assert rep["k_inj_small_signal"] == pytest.approx(K_SMALL_SIGNAL, rel=0.02)
    assert rep["k1_first_harmonic"] == pytest.approx(K, rel=0.01)
    assert rep["fourier"][1]["b"] == pytest.approx(-K * H2, abs=2e-3)
    peak, e_pk = _truth_peak()
    assert peak == pytest.approx(0.340949, abs=1e-6)
    assert rep["max_abs_kick_rad"] == pytest.approx(peak, abs=5e-3)
    assert abs(rep["max_kick_at_e_rad"] - e_pk) < 0.1
    # the truth is odd (f(-e) = -f(e)) -> only noise remains
    assert rep["odd_symmetry_err_max_rad"] < 0.01
    # quarter-wave skew of the truth = max|2*K*H2*sin 2e| = 0.18
    assert rep["quarter_wave_skew_max_rad"] == pytest.approx(2 * K * H2,
                                                             abs=0.01)
    stable = [r for r in rep["zero_crossings"] if r["class"] == "stable"]
    unstable = [r for r in rep["zero_crossings"] if r["class"] == "unstable"]
    assert len(stable) == 1 and abs(stable[0]["e_rad"]) < 0.01
    assert len(unstable) == 1 and abs(abs(unstable[0]["e_rad"]) - math.pi) < 0.01
    lr = rep["lock_range"]
    assert lr["a_max_rad"] == pytest.approx(peak, abs=5e-3)
    assert lr["a_min_rad"] == pytest.approx(-peak, abs=5e-3)
    assert lr["delta_f_max_hz"] == pytest.approx(
        lr["a_max_rad"] * F_REF / (2 * math.pi), rel=1e-12)
    st = rep["settle"]
    assert st["edge_pairs"] == [(100, 190)]
    assert st["systematic_max_rad"] < 0.01 * rep["max_abs_kick_rad"]
    assert not any("settling" in w for w in rep["warnings"])
    text = pp.format_report(rep)
    assert "K_inj small-signal" in text and "stable" in text


def test_lut_simulate_locks_small_detuning(recovered):
    lut = recovered.pdr_lut()
    df = 1e6
    a = 2 * math.pi * df / F_REF
    cfg = SimConfig(n_div=3.125, inj_model="lut", pdr_lut=lut, delta_f_hz=df,
                    n_cycles=512)
    d = simulate(cfg).data
    tail = slice(-128, None)
    assert np.all(np.isfinite(d["e_inj"]))
    assert np.std(d["e_inj"][tail]) < 1e-12                 # locked
    assert np.max(np.abs(d["delta_theta"][tail] + a)) < 1e-12
    # steady state = fixed point of the LUT map (exact) ...
    assert d["e_inj"][-1] == pytest.approx(_lut_fixed_point(lut, a), abs=1e-9)
    # ... and close to the truth's (noise-limited LUT null offset)
    assert abs(d["e_inj"][-1] - _truth_fixed_point(a)) < 0.01


def test_lut_lock_range_exceeds_first_harmonic_fit(recovered):
    # a = 0.32 rad/ref-cycle: inside the asymmetric PDR's range (0.341) but
    # outside |a| <= K1 = 0.3 of the best-fit sinusoid -> the LUT locks, the
    # sinusoidal map with K1 does not.
    lut = recovered.pdr_lut()
    a = 0.32
    df = a * F_REF / (2 * math.pi)
    tail = slice(-128, None)
    d = simulate(SimConfig(inj_model="lut", pdr_lut=lut, delta_f_hz=df,
                           n_cycles=2048)).data
    assert np.std(d["e_inj"][tail]) < 1e-9
    assert abs(d["e_inj"][-1] - _truth_fixed_point(a)) < 0.02
    k1 = recovered.report["k1_first_harmonic"]
    d_sin = simulate(SimConfig(inj_model="sin", k_inj=k1, delta_f_hz=df,
                               n_cycles=2048)).data
    assert np.std(d_sin["e_inj"][tail]) > 0.1                # cycle slips


# ---------------------------------------------------------------------------
# cleaning corner cases
# ---------------------------------------------------------------------------
def test_reset_map_winding_and_unwrap():
    raw = rs.synthesize_raw("reset", n_phi=128, sigma_t_s=1e-15)
    res = pp.postprocess(raw, n_points=64)
    assert res.samples.winding == -1
    assert np.max(np.abs(res.lut_d + res.lut_e)) < 2e-3      # delta = -e
    assert res.report["k_inj_small_signal"] == pytest.approx(1.0, abs=0.01)
    assert res.report["k1_first_harmonic"] is None
    assert any("winding" in w for w in res.report["warnings"])


def test_dedupe_and_shuffled_input():
    rng = np.random.default_rng(3)
    raw = rs.synthesize_raw("sin", 0.5, 0.0, n_phi=64, sigma_t_s=0.0,
                            edges=(150,))
    perm = rng.permutation(len(raw["phi_inj_cycles"]))
    shuffled = {c: v[perm] for c, v in raw.items()}
    res = pp.postprocess(shuffled, n_points=33)
    assert res.samples.n_merged == 1                           # phi 0 == phi 1
    assert np.all(np.diff(res.samples.e) > 0)
    assert np.max(np.abs(res.lut_d + 0.5 * np.sin(res.lut_e))) < 2e-3
    assert res.report["settle"] is None                        # single edge


def test_settling_check_flags_unsettled_edges():
    raw = rs.synthesize_raw("asym", K, H2, n_phi=128, settle_tau_cycles=40.0)
    rep = pp.postprocess(raw).report
    expected = 0.25 * (math.exp(-190 / 40) - math.exp(-100 / 40))  # -1.84%
    assert rep["settle"]["rel_gain_change"] == pytest.approx(expected,
                                                             abs=2e-3)
    assert any("settling" in w for w in rep["warnings"])


def test_fourier_smoothing_option():
    raw = rs.synthesize_raw("asym", K, H2, n_phi=128, sigma_t_s=30e-15)
    lin = pp.postprocess(raw, smooth_harmonics=0)
    fit = pp.postprocess(raw, smooth_harmonics=4)
    e_lin = np.max(np.abs(lin.lut_d - TRUTH(lin.lut_e)))
    e_fit = np.max(np.abs(fit.lut_d - TRUTH(fit.lut_e)))
    assert e_fit < e_lin and e_fit < 2e-3


# ---------------------------------------------------------------------------
# file formats: LUT CSV (Python + website Ch13 rules), raw CSV round trip
# ---------------------------------------------------------------------------
def test_lut_csv_round_trip_and_ch13_rules(tmp_path, recovered):
    p = tmp_path / "lut.csv"
    pp.write_lut_csv(p, recovered.lut_e, recovered.lut_d, ["comment line"])
    lut = pp.load_lut_csv(str(p))
    assert lut == recovered.pdr_lut()                     # exact (repr floats)
    text = "# c\n\ne_inj_rad;delta_theta_rad\n-1 0.5\n0, 0\n1;-0.5\nbad,row\n"
    q = tmp_path / "mixed.csv"
    q.write_text(text)
    assert pp.load_lut_csv(str(q)) == [[-1.0, 0.5], [0.0, 0.0], [1.0, -0.5]]
    (tmp_path / "one.csv").write_text("0,0\n")
    with pytest.raises(ValueError):
        pp.load_lut_csv(str(tmp_path / "one.csv"))
    t = tmp_path / "lut.tbl"
    pp.write_va_table(t, recovered.lut_e, recovered.lut_d)
    first = [ln for ln in t.read_text().splitlines() if not ln.startswith("#")]
    assert len(first) == 64 and len(first[0].split()) == 2


def test_raw_csv_round_trip(tmp_path):
    raw = rs.synthesize_raw("asym", K, H2, n_phi=64)
    p = tmp_path / "raw.csv"
    pp.write_raw_csv(p, raw, ["synthetic"])
    back = pp.read_raw_csv(str(p))
    for c in pp.RAW_REQUIRED:
        assert np.array_equal(back[c], raw[c])
    assert np.array_equal(back["edge_idx"], raw["edge_idx"])
    bad = tmp_path / "bad.csv"
    bad.write_text("phi_inj_cycles,t_cross_ref_s\n0,1\n")
    with pytest.raises(ValueError):
        pp.read_raw_csv(str(bad))


def test_example_csv_is_the_documented_synthetic_lut():
    lut = pp.load_lut_csv(EXAMPLE_CSV)
    assert len(lut) == 64
    e = np.array([p[0] for p in lut])
    d = np.array([p[1] for p in lut])
    assert e[0] == -math.pi and e[-1] == math.pi
    assert np.max(np.abs(d - TRUTH(e))) < 6e-3
    with open(EXAMPLE_CSV, encoding="utf-8") as f:
        head = f.read(200)
    assert "SYNTHETIC" in head
    # reproducible from the documented command (tolerance: libm last ULP)
    res = pp.postprocess(rs.synthesize_raw(), n_points=64)
    assert np.max(np.abs(res.lut_d - d)) < 1e-9
    cfg = SimConfig(inj_model="lut", pdr_lut=lut, delta_f_hz=1e6)
    assert np.std(simulate(cfg).data["e_inj"][-128:]) < 1e-12


def test_postprocess_cli(tmp_path, capsys):
    raw_p = tmp_path / "raw.csv"
    assert rs.main(["--synthetic", "-o", str(raw_p)]) == 0
    lut_p = tmp_path / "lut.csv"
    js = tmp_path / "rep.json"
    assert pp.main([str(raw_p), "-o", str(lut_p), "--json", str(js)]) == 0
    out = capsys.readouterr().out
    assert "K_inj small-signal" in out and "zero crossing" in out
    assert len(pp.load_lut_csv(str(lut_p))) == 64
    assert js.exists()


# ---------------------------------------------------------------------------
# run_sweep.py driver (Spectre side NOT RUN; Python side tested)
# ---------------------------------------------------------------------------
def test_dry_run_prints_plan(capsys):
    assert rs.main(["--dry-run", "--n-phi", "64"]) == 0
    out = capsys.readouterr().out
    assert "NOT RUN" in out
    rows = [ln for ln in out.splitlines() if "phi_" in ln and "_ref" in ln
            and ln.startswith("#  ")]
    assert len(rows) == 65                       # 0..64 incl. endpoint
    assert "spectre +aps" in out
    assert ",".join(pp.RAW_REQUIRED) in out
    with pytest.raises(SystemExit):
        rs.main(["--dry-run", "--n-phi", "32"])  # < 64 steps rejected


def test_render_writes_netlists(tmp_path):
    plan = rs.build_plan(n_phi=64, t_anchor=2.4e-7, t_vco=8e-11)
    paths = rs.render(str(tmp_path), plan)
    assert len(paths) == 2 * 65 + 1 + 2
    net = (tmp_path / "runs" / "phi_0016_inj" / "netlist.scs").read_text()
    assert "parameters phi_inj=0.25 inj_en=1" in net
    assert "t_anchor=2.4e-07" in net and "NOT RUN" in net
    assert "parameters phi_inj=0.25           //" not in net  # default gone
    ref = (tmp_path / "runs" / "phi_0016_ref" / "netlist.scs").read_text()
    assert "inj_en=0" in ref
    ps = rs.build_plan(n_phi=64, mode="paramset")
    rs.render(str(tmp_path / "ps"), ps)
    psn = (tmp_path / "ps" / "runs" / "paramset" / "netlist.scs").read_text()
    assert "pdr_ps paramset {" in psn and "sweep paramset=pdr_ps {" in psn
    assert psn.count("\n0.25 ") == 2                  # REF + INJ rows


def _sine_wave(t0, t_vco, t_start, t_end, rng, shift_after=None):
    """Sampled sin(2*pi*(t - t0)/T) on a jittered grid (~T/100); optional
    (t_switch, dt): later edges delayed by dt after t_switch."""
    n = int((t_end - t_start) / (t_vco / 100.0))
    t = t_start + (np.arange(n) + 0.3 * rng.random(n)) * (t_vco / 100.0)
    ph = (t - t0) / t_vco
    if shift_after is not None:
        ts, dt = shift_after
        ph = np.where(t > ts, (t - t0 - dt) / t_vco, ph)
    return t, np.sin(2 * math.pi * ph)


def test_crossings_and_anchor():
    rng = np.random.default_rng(7)
    t_vco = 80e-12
    t0 = 0.123 * t_vco
    t, v = _sine_wave(t0, t_vco, 0.0, 80 * t_vco, rng)
    tc = rs.crossings(t, v, "rise")
    expect = t0 + np.arange(len(tc)) * t_vco
    assert np.max(np.abs(tc - expect)) < 1e-18                 # < 0.001 fs
    tl = rs.crossings(t, v, "rise", refine="linear")
    assert np.max(np.abs(tl - expect)) < 2e-16                 # linear only
    a = rs.measure_anchor(t, v, 50 * t_vco)
    assert a["t_anchor_s"] == pytest.approx(t0 + 50 * t_vco, abs=1e-17)
    assert a["t_vco_s"] == pytest.approx(t_vco, rel=1e-9)
    # chatter around zero is rejected by hysteresis
    tt = np.array([0, 1, 2, 3, 4, 5, 6.0])
    vv = np.array([-1, 0.01, -0.01, 0.02, 1, -1, 1.0])
    assert len(rs.crossings(tt, vv, hysteresis=0.0)) == 3
    assert len(rs.crossings(tt, vv, hysteresis=0.1)) == 2


def test_collect_from_waveforms(tmp_path):
    rng = np.random.default_rng(11)
    t_vco = 80e-12
    n_settle, n_post = 40, 30
    t_anchor = (n_settle + 0.137) * t_vco
    plan = rs.build_plan(n_phi=16, include_endpoint=False, n_settle=n_settle,
                         n_post=n_post, edges=(10, 25), t_anchor=t_anchor,
                         t_vco=t_vco)
    f = rs.truth_pdr("sin", 0.4)
    t_lo, t_hi = t_anchor - 4 * t_vco, t_anchor + (n_post + 2) * t_vco
    for p in plan["pairs"]:
        dt = -float(f(p["e_inj_rad"])) / (2 * math.pi) * t_vco
        t_c = t_anchor + p["phi_inj"] * t_vco
        for rid, sh in ((p["ref"], None), (p["inj"], (t_c, dt))):
            t, v = _sine_wave(t_anchor, t_vco, t_lo, t_hi, rng, sh)
            d = tmp_path / "runs" / rid
            d.mkdir(parents=True)
            np.savetxt(d / "vdiff.csv", np.column_stack([t, v]),
                       delimiter=",", header="time_s,v_diff_V", fmt="%.15e")
    raw = rs.collect(str(tmp_path), plan)
    assert len(raw["phi_inj_cycles"]) == 2 * 16
    e, d = pp.raw_to_samples(raw["phi_inj_cycles"], raw["t_cross_ref_s"],
                             raw["t_cross_inj_s"], raw["t_vco_s"])
    assert np.max(np.abs(d - f(e))) < 1e-7            # cubic crossing refine
    assert np.allclose(raw["t_vco_s"], t_vco, rtol=1e-9)
    res = pp.postprocess(raw, n_points=17)
    assert res.report["k_inj_small_signal"] == pytest.approx(0.4, rel=0.01)
