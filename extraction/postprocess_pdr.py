#!/usr/bin/env python3
"""PDR/PRC post-processing: transient single-kick raw data -> MODEL_SPEC.md
section 14 LUT (``SimConfig(inj_model='lut', pdr_lut=...)``).

STATUS: REAL code, tested by ``tests/test_pdr_postprocess.py`` (synthetic
round trip).  It has NOT been exercised on real Spectre output (no circuit
simulator was available when it was written).  The raw-CSV schema below is
the contract between ``extraction/run_sweep.py --collect`` (or your own
measurement script) and this file.  Recipe: ``PDR_EXTRACTION.md``.

Raw CSV schema (header row required; ``#`` lines are comments; extra
columns are ignored)::

    phi_inj_cycles  pulse CENTER position after the target zero crossing of
                    the settled oscillator, in cycles of t_vco_s (0..1)
    t_cross_ref_s   time of a late target-type zero crossing, REF run
                    (pulse disabled)                                  [s]
    t_cross_inj_s   time of the SAME edge in the INJ run (the INJ-run
                    crossing nearest to t_cross_ref_s)                [s]
    t_vco_s         settled VCO period measured in the REF run        [s]
    edge_idx        OPTIONAL int: cycles after the anchor at which the edge
                    was taken.  With >= 2 distinct values per phi the report
                    gives the settling residual between the two latest edges
                    and only the latest edge is used for the LUT.

Sign mapping (MODEL_SPEC.md sections 2, 14)::

    e_inj_rad       = wrapRadians(2*pi*phi_inj_cycles)
                      pulse LATE w.r.t. the zero crossing   ->  e_inj > 0
    dt              = t_cross_inj_s - t_cross_ref_s
                      injected edge LATER than reference    ->  dt > 0
    delta_theta_rad = wrapRadians(-2*pi*dt / t_vco_s)

Why the minus sign: section 14's ``theta`` is the VCO residual (excess)
phase; ``theta_minus`` grows by ``+2*pi*Delta_f*T_ref`` for a FAST VCO, so
``theta > 0`` means the VCO is ahead and its edges come EARLIER.  An
edge-time shift ``dt`` is therefore ``delta_theta = -2*pi*dt/T_vco``.  A pulse
arriving late (``e > 0``) that pulls the oscillator toward itself delays the
VCO edges (``dt > 0``), i.e. ``delta_theta < 0``: negative slope at e = 0,
exactly like ``Delta_theta = -K*sin(e)``.  The equivalent small-signal
strength is::

    K_inj = -d(delta_theta)/d(e) |_(e=0) = d(dt)/d(phi*T_vco) |_(phi=0)

(the fraction of a small timing error one pulse removes; 1 = ideal reset).

Pipeline: read -> convert -> (settle check) -> sort / dedupe / unwrap ->
periodic resample onto a uniform grid on [-pi, pi] (both endpoints) ->
two-column LUT CSV (accepted by ``SimConfig.pdr_lut`` via
``load_lut_csv``, by the website's Ch13 CSV import, and optionally written
as a Verilog-A ``$table_model`` file) -> quality report.

Usage::

    python3 extraction/postprocess_pdr.py raw.csv -o pdr_lut.csv \\
        [--n-points 64] [--smooth-harmonics 0] [--f-ref-hz 4e9] \\
        [--va-table pdr_lut.tbl] [--json report.json]
"""

import argparse
import json
import math
import os
import re
import sys
from dataclasses import dataclass, field

import numpy as np

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from model.python.phase_math import (  # noqa: E402
    TWO_PI, wrap_cycles_arr, wrap_radians, wrap_radians_arr)

RAW_REQUIRED = ("phi_inj_cycles", "t_cross_ref_s", "t_cross_inj_s", "t_vco_s")
RAW_OPTIONAL = ("edge_idx",)
LUT_HEADER = "e_inj_rad,delta_theta_rad"


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------
def _data_lines(text):
    for raw in text.splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            yield line


def _read_text(path_or_buf):
    if hasattr(path_or_buf, "read"):
        return path_or_buf.read()
    with open(path_or_buf, "r", encoding="utf-8") as f:
        return f.read()


def read_raw_csv(path_or_buf) -> dict:
    """Read a raw transient-kick CSV (schema in the module docstring).

    Returns a dict of float64 arrays keyed by the required column names
    (plus ``edge_idx`` as int64 when present)."""
    lines = list(_data_lines(_read_text(path_or_buf)))
    if len(lines) < 2:
        raise ValueError("raw CSV: need a header row and at least one data row")
    header = [h.strip() for h in lines[0].split(",")]
    missing = [c for c in RAW_REQUIRED if c not in header]
    if missing:
        raise ValueError(f"raw CSV: missing column(s) {missing}; "
                         f"required {list(RAW_REQUIRED)}")
    wanted = list(RAW_REQUIRED) + [c for c in RAW_OPTIONAL if c in header]
    pos = {c: header.index(c) for c in wanted}
    cols = {c: [] for c in wanted}
    for n, line in enumerate(lines[1:], start=2):
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < len(header):
            raise ValueError(f"raw CSV data line {n}: expected {len(header)} "
                             f"fields, got {len(parts)}")
        for c in wanted:
            cols[c].append(float(parts[pos[c]]))
    out = {c: np.asarray(v, dtype=np.float64) for c, v in cols.items()}
    for c in RAW_REQUIRED:
        if not np.all(np.isfinite(out[c])):
            raise ValueError(f"raw CSV: non-finite value in column {c}")
    if np.any(out["t_vco_s"] <= 0.0):
        raise ValueError("raw CSV: t_vco_s must be > 0")
    if "edge_idx" in out:
        out["edge_idx"] = out["edge_idx"].astype(np.int64)
    return out


def write_raw_csv(path, raw: dict, comments=()):
    """Write a raw dict in the schema above (used by run_sweep.py)."""
    names = list(RAW_REQUIRED) + [c for c in RAW_OPTIONAL if c in raw]
    with open(path, "w", encoding="utf-8") as f:
        for c in comments:
            f.write(f"# {c}\n")
        f.write(",".join(names) + "\n")
        for i in range(len(raw["phi_inj_cycles"])):
            parts = []
            for c in names:
                v = raw[c][i]
                parts.append(str(int(v)) if c == "edge_idx" else repr(float(v)))
            f.write(",".join(parts) + "\n")


def write_lut_csv(path, e, d, comments=()):
    """Two-column LUT CSV: '#' comment lines, a header row, then
    ``e_inj_rad,delta_theta_rad`` rows (repr floats, exact round trip)."""
    with open(path, "w", encoding="utf-8") as f:
        for c in comments:
            f.write(f"# {c}\n")
        f.write(LUT_HEADER + "\n")
        for x, y in zip(e, d):
            f.write(f"{float(x)!r},{float(y)!r}\n")


def write_va_table(path, e, d, comments=()):
    """Whitespace two-column file for Verilog-A ``$table_model`` (control
    string "1CC" = linear interpolation, constant (clamp) extrapolation, the
    same semantics as the Python/TS LUT).  NOT used by the repo's .va files."""
    with open(path, "w", encoding="utf-8") as f:
        for c in comments:
            f.write(f"# {c}\n")
        for x, y in zip(e, d):
            f.write(f"{float(x)!r} {float(y)!r}\n")


def load_lut_csv(path_or_buf):
    """Load a two-column PDR LUT into the ``SimConfig.pdr_lut`` format
    ``[[e_inj_rad, delta_theta_rad], ...]``.

    Same rules as the website's Ch13 import (``parsePdrLut``): blank and
    ``#`` lines skipped, fields split on ``[,;\\s]+``, lines whose first two
    fields are not finite numbers (e.g. the header row) skipped, at least two
    points required."""
    rows = []
    for line in _data_lines(_read_text(path_or_buf)):
        parts = [p for p in re.split(r"[,;\s]+", line) if p != ""]
        if len(parts) < 2:
            continue
        try:
            e = float(parts[0])
            d = float(parts[1])
        except ValueError:
            continue
        if not (math.isfinite(e) and math.isfinite(d)):
            continue
        rows.append([e, d])
    if len(rows) < 2:
        raise ValueError("PDR LUT needs at least 2 numeric rows "
                         "(e_inj_rad, delta_theta_rad)")
    return rows


# ---------------------------------------------------------------------------
# conversion + cleaning
# ---------------------------------------------------------------------------
def raw_to_samples(phi_cycles, t_cross_ref_s, t_cross_inj_s, t_vco_s):
    """Raw transient-kick columns -> (e_inj_rad, delta_theta_rad), both in
    (-pi, pi], with the sign mapping of the module docstring."""
    phi = np.asarray(phi_cycles, dtype=np.float64)
    dt = (np.asarray(t_cross_inj_s, dtype=np.float64)
          - np.asarray(t_cross_ref_s, dtype=np.float64))
    t_vco = np.asarray(t_vco_s, dtype=np.float64)
    e = TWO_PI * wrap_cycles_arr(phi)
    d = TWO_PI * wrap_cycles_arr(-dt / t_vco)
    return e, d


def select_latest_edge(raw: dict):
    """If ``edge_idx`` is present keep only the latest edge per phi and
    measure the settling residual between the two latest edges.

    Returns (raw_selected, settle) where settle is None (no edge_idx or a
    single edge everywhere) or a dict with the residual statistics."""
    if "edge_idx" not in raw:
        return raw, None
    phi = raw["phi_inj_cycles"]
    _, d_all = raw_to_samples(phi, raw["t_cross_ref_s"], raw["t_cross_inj_s"],
                              raw["t_vco_s"])
    groups = {}
    for i, p in enumerate(phi):
        groups.setdefault(float(p), []).append(i)
    keep, resid, r_phi, r_d, pairs = [], [], [], [], set()
    for p in sorted(groups):
        idx = sorted(groups[p], key=lambda i: int(raw["edge_idx"][i]))
        last = idx[-1]
        keep.append(last)
        if len(idx) >= 2 and raw["edge_idx"][idx[-2]] != raw["edge_idx"][last]:
            prev = idx[-2]
            resid.append(wrap_radians(float(d_all[last] - d_all[prev])))
            r_phi.append(p)
            r_d.append(float(d_all[last]))
            pairs.add((int(raw["edge_idx"][prev]), int(raw["edge_idx"][last])))
    keep = np.asarray(keep, dtype=np.int64)
    sel = {c: v[keep] for c, v in raw.items()}
    if not resid:
        return sel, None
    r = np.asarray(resid)
    dl = np.asarray(r_d)
    er = TWO_PI * wrap_cycles_arr(np.asarray(r_phi))
    # timing noise makes the raw residual noisy; the SYSTEMATIC part (what
    # an unsettled AM->PM transient produces) is estimated by a 4-harmonic
    # least-squares fit of the residual vs e, and as a relative gain change
    # beta of residual ~ beta * dtheta.
    systematic = float(np.max(np.abs(r)))
    if len(r) >= 12:
        cols = [np.ones_like(er)]
        for n in range(1, 5):
            cols += [np.cos(n * er), np.sin(n * er)]
        a = np.stack(cols, axis=1)
        coef, *_ = np.linalg.lstsq(a, r, rcond=None)
        systematic = float(np.max(np.abs(a @ coef)))
    den = float(np.sum(dl * dl))
    settle = {
        "edge_pairs": sorted(pairs),
        "n_phi_checked": int(len(r)),
        "max_abs_rad": float(np.max(np.abs(r))),
        "rms_rad": float(np.sqrt(np.mean(r * r))),
        "systematic_max_rad": systematic,
        "rel_gain_change": float(np.sum(r * dl) / den) if den > 0 else 0.0,
    }
    return sel, settle


@dataclass
class PdrSamples:
    """Cleaned PDR samples.

    e        sorted unique e_inj (rad) in (-pi, pi]
    d        delta_theta (rad), unwrapped along e; branch chosen so the
             sample nearest e = 0 lies in (-pi, pi]
    winding  lift degree: d(e + 2*pi) = d(e) + 2*pi*winding.  0 for every
             PDR whose |kick| stays below pi (all K < 1 shorting curves);
             -1 for the ideal reset map delta_theta = -e.
    """
    e: np.ndarray
    d: np.ndarray
    winding: int = 0
    n_raw: int = 0
    n_merged: int = 0
    max_dup_spread_rad: float = 0.0
    max_gap_rad: float = 0.0


def clean_samples(e, d, dup_tol_rad=1e-9) -> PdrSamples:
    """Sort by e, merge duplicates (|de| <= dup_tol, incl. across the +-pi
    seam; circular mean), unwrap delta_theta along e, determine the winding
    and pick the branch nearest zero at e = 0."""
    e = np.asarray(e, dtype=np.float64).copy()
    d = np.asarray(d, dtype=np.float64)
    if e.shape != d.shape or e.ndim != 1:
        raise ValueError("e and d must be 1-D arrays of equal length")
    n_raw = len(e)
    out = (e <= -math.pi) | (e > math.pi)
    if np.any(out):
        e[out] = wrap_radians_arr(e[out])
    order = np.argsort(e, kind="mergesort")
    e, d = e[order], d[order]

    # group duplicates (sorted, so groups are runs)
    groups = []
    start = 0
    for i in range(1, n_raw + 1):
        if i == n_raw or e[i] - e[start] > dup_tol_rad:
            groups.append(list(range(start, i)))
            start = i
    # a group just above -pi duplicates the group at +pi (same physical phase)
    if len(groups) > 1 and (e[groups[0][0]] + TWO_PI - e[groups[-1][-1]]
                            <= dup_tol_rad):
        groups[-1] = groups[-1] + groups[0]
        groups = groups[1:]
    ge, gd, spread = [], [], 0.0
    for g in groups:
        ref = d[g[0]]
        vals = ref + wrap_radians_arr(d[g] - ref)
        ge.append(float(e[g[0]]))   # seam group: g[0] is the +pi side
        gd.append(float(np.mean(vals)))
        spread = max(spread, float(np.ptp(vals)))
    ge = np.asarray(ge)
    gd = np.asarray(gd)
    order = np.argsort(ge, kind="mergesort")
    ge, gd = ge[order], gd[order]
    if len(ge) < 4:
        raise ValueError(f"need >= 4 distinct e_inj samples, got {len(ge)}")

    du = np.unwrap(gd)
    step = wrap_radians(float(du[0] - du[-1]))       # seam step, wrapped
    winding = int(math.floor((du[-1] + step - du[0]) / TWO_PI + 0.5))
    i0 = int(np.argmin(np.abs(ge)))
    shift = wrap_radians(float(du[i0])) - float(du[i0])
    du = du + TWO_PI * math.floor(shift / TWO_PI + 0.5)

    gaps = np.diff(ge)
    seam = ge[0] + TWO_PI - ge[-1]
    max_gap = float(max(np.max(gaps) if len(gaps) else 0.0, seam))
    return PdrSamples(e=ge, d=du, winding=winding, n_raw=n_raw,
                      n_merged=n_raw - len(ge), max_dup_spread_rad=spread,
                      max_gap_rad=max_gap)


def pdr_eval(s: PdrSamples, eq):
    """Periodic linear interpolation of the samples (respecting the
    winding: the periodic part g = d - winding*e is interpolated)."""
    eq = np.asarray(eq, dtype=np.float64)
    g = s.d - s.winding * s.e
    return np.interp(eq, s.e, g, period=TWO_PI) + s.winding * eq


def fourier_fit(s: PdrSamples, n_harm: int):
    """Least-squares Fourier fit of the periodic part g = d - winding*e.
    Returns coef = [a0, a1, b1, a2, b2, ...]."""
    if n_harm < 1:
        raise ValueError("n_harm must be >= 1")
    if len(s.e) < 2 * n_harm + 2:
        raise ValueError(f"{len(s.e)} samples are too few for {n_harm} "
                         "harmonics")
    g = s.d - s.winding * s.e
    a = [np.ones_like(s.e)]
    for n in range(1, n_harm + 1):
        a += [np.cos(n * s.e), np.sin(n * s.e)]
    coef, *_ = np.linalg.lstsq(np.stack(a, axis=1), g, rcond=None)
    return coef


def fourier_eval(coef, eq, winding=0):
    eq = np.asarray(eq, dtype=np.float64)
    y = np.full_like(eq, coef[0])
    n_harm = (len(coef) - 1) // 2
    for n in range(1, n_harm + 1):
        y = y + coef[2 * n - 1] * np.cos(n * eq) + coef[2 * n] * np.sin(n * eq)
    return y + winding * eq


def resample_uniform(s: PdrSamples, n_points=64, smooth_harmonics=0):
    """Uniform LUT grid on [-pi, pi] (both endpoints, so the clamped linear
    interpolation of the model covers the whole (-pi, pi] range and is
    periodic-consistent).  smooth_harmonics = 0: periodic linear
    interpolation of the samples; > 0: least-squares Fourier fit."""
    if n_points < 4:
        raise ValueError("n_points must be >= 4")
    grid = np.linspace(-math.pi, math.pi, n_points)
    if smooth_harmonics and smooth_harmonics > 0:
        vals = fourier_eval(fourier_fit(s, smooth_harmonics), grid, s.winding)
    else:
        vals = pdr_eval(s, grid)
    return grid, vals


# ---------------------------------------------------------------------------
# quality report
# ---------------------------------------------------------------------------
def _local_slope(s: PdrSamples, window_rad: float):
    """Local cubic least-squares fit around e = 0 -> (slope, value at 0)."""
    sel = np.abs(s.e) <= window_rad
    if np.count_nonzero(sel) < 6:
        sel = np.argsort(np.abs(s.e))[:min(6, len(s.e))]
    x, y = s.e[sel], s.d[sel]
    deg = 3 if len(x) >= 6 else 1
    p = np.polyfit(x, y, deg)
    return float(p[-2]), float(p[-1])


def _classify(slope: float) -> str:
    if 0.0 > slope > -2.0:
        return "stable"
    if slope <= -2.0:
        return "unstable(flip)"
    if slope > 0.0:
        return "unstable"
    return "marginal"


def _zero_crossings(lut_e, lut_d, winding):
    """Roots of the piecewise-linear LUT (wrapped values when winding != 0;
    2*pi jumps are not roots).  Fixed points of e -> e + dtheta(e) at zero
    detuning; stable iff -2 < slope < 0."""
    v = lut_d if winding == 0 else wrap_radians_arr(lut_d)
    roots = []
    for i in range(len(lut_e) - 1):
        v0, v1 = float(v[i]), float(v[i + 1])
        if abs(v1 - v0) >= math.pi:
            continue
        if (v0 > 0.0 and v1 <= 0.0) or (v0 < 0.0 and v1 >= 0.0):
            e0, e1 = float(lut_e[i]), float(lut_e[i + 1])
            r = e1 if v1 == 0.0 else e0 - v0 * (e1 - e0) / (v1 - v0)
            slope = (v1 - v0) / (e1 - e0)
            roots.append({"e_rad": r, "slope": slope,
                          "class": _classify(slope)})
    return roots


def _lock_range(lut_e, lut_d, root_e, n_dense=4096):
    """Static lock range around a stable root: walk the dense LUT while the
    slope stays in (-2, 0); steady state needs a + dtheta(e*) = 0 with
    a = 2*pi*Delta_f*T_ref, so a in [-max dtheta, -min dtheta] on that
    segment.  Returns (a_min, a_max, e_left, e_right)."""
    lut = PdrSamples(e=np.asarray(lut_e[1:]), d=np.asarray(lut_d[1:]))
    x = np.linspace(-math.pi, math.pi, n_dense + 1)[:-1]
    h = x[1] - x[0]
    v = pdr_eval(lut, x)
    slope = (np.roll(v, -1) - v) / h            # slope of [x_j, x_{j+1}]
    j0 = int(np.argmin(np.abs(wrap_radians_arr(x - root_e))))
    ok = (slope < 0.0) & (slope > -2.0)
    lo = j0
    for _ in range(n_dense - 1):
        if not ok[(lo - 1) % n_dense]:
            break
        lo -= 1
    hi = j0
    for _ in range(n_dense - 1):
        if not ok[hi % n_dense]:
            break
        hi += 1
    seg = v[np.arange(lo, hi + 1) % n_dense]
    return (float(-np.max(seg)), float(-np.min(seg)),
            float(wrap_radians(x[lo % n_dense])),
            float(wrap_radians(x[hi % n_dense])))


def quality_report(s: PdrSamples, lut_e, lut_d, slope_window_rad=math.pi / 4,
                   f_ref_hz=None, n_dense=4096, noise_harmonics=8,
                   settle=None) -> dict:
    """Quality metrics of the extraction (data) and of the LUT exactly as
    the model will use it (linear interpolation)."""
    lut_e = np.asarray(lut_e, dtype=np.float64)
    lut_d = np.asarray(lut_d, dtype=np.float64)
    w = s.winding
    rep = {"n_raw": s.n_raw, "n_unique": int(len(s.e)), "n_merged": s.n_merged,
           "max_dup_spread_rad": s.max_dup_spread_rad,
           "max_gap_rad": s.max_gap_rad, "winding": w,
           "n_lut": int(len(lut_e))}

    slope0, value0 = _local_slope(s, slope_window_rad)
    rep["k_inj_small_signal"] = -slope0
    rep["delta_theta_at_e0_rad"] = value0
    i = int(np.searchsorted(lut_e, 0.0, side="right") - 1)
    i = min(max(i, 0), len(lut_e) - 2)
    rep["k_inj_lut_secant"] = float(-(lut_d[i + 1] - lut_d[i])
                                    / (lut_e[i + 1] - lut_e[i]))

    # dense periodic evaluation of the LUT (identical to np.interp inside)
    lut_s = PdrSamples(e=lut_e[1:], d=lut_d[1:], winding=w)
    x = np.linspace(-math.pi, math.pi, n_dense + 1)[:-1]
    v = pdr_eval(lut_s, x)
    g = v - w * x
    harm = []
    for n in range(1, 6):
        harm.append({"n": n,
                     "a": float(2.0 * np.mean(g * np.cos(n * x))),
                     "b": float(2.0 * np.mean(g * np.sin(n * x)))})
    rep["fourier_a0"] = float(np.mean(g))
    rep["fourier"] = harm
    rep["k1_first_harmonic"] = -harm[0]["b"] if w == 0 else None

    vw = v if w == 0 else wrap_radians_arr(v)
    j = int(np.argmax(np.abs(vw)))
    rep["max_abs_kick_rad"] = float(abs(vw[j]))
    rep["max_abs_kick_at_e_rad"] = float(x[j])
    rep["max_kick_rad"] = float(np.max(vw))
    rep["max_kick_at_e_rad"] = float(x[int(np.argmax(vw))])
    rep["min_kick_rad"] = float(np.min(vw))
    rep["min_kick_at_e_rad"] = float(x[int(np.argmin(vw))])

    odd = wrap_radians_arr(v + pdr_eval(lut_s, -x))
    rep["odd_symmetry_err_max_rad"] = float(np.max(np.abs(odd)))
    rep["odd_symmetry_err_rms_rad"] = float(np.sqrt(np.mean(odd * odd)))
    if w == 0:   # deviation from the pure-sine symmetry about e = +-pi/2
        skew = v - pdr_eval(lut_s, math.pi - x)
        rep["quarter_wave_skew_max_rad"] = float(np.max(np.abs(skew)))
    else:
        rep["quarter_wave_skew_max_rad"] = None

    roots = _zero_crossings(lut_e, lut_d, w)
    rep["zero_crossings"] = roots
    stable = [r for r in roots if r["class"] == "stable"]
    rep["lock_range"] = None
    if stable and w == 0:
        r0 = min(stable, key=lambda r: abs(r["e_rad"]))
        a_lo, a_hi, e_l, e_r = _lock_range(lut_e, lut_d, r0["e_rad"], n_dense)
        lr = {"root_e_rad": r0["e_rad"], "a_min_rad": a_lo, "a_max_rad": a_hi,
              "branch_e_left_rad": e_l, "branch_e_right_rad": e_r}
        if f_ref_hz:
            lr["delta_f_min_hz"] = a_lo * f_ref_hz / TWO_PI
            lr["delta_f_max_hz"] = a_hi * f_ref_hz / TWO_PI
        rep["lock_range"] = lr

    h = min(noise_harmonics, (len(s.e) - 2) // 2)
    if h >= 1:
        resid = s.d - fourier_eval(fourier_fit(s, h), s.e, w)
        rep["noise_rms_upper_rad"] = float(np.sqrt(np.mean(resid * resid)))
        rep["noise_fit_harmonics"] = h
    rep["settle"] = settle

    warn = []
    scale = max(rep["max_abs_kick_rad"], 1e-12)
    if s.max_gap_rad > TWO_PI / 64 * 1.0001:
        warn.append("e_inj coverage gap > 2*pi/64: sweep phi_inj with >= 64 "
                    "uniform steps")
    if w != 0:
        warn.append(f"winding = {w}: reset-like map (|kick| reaches pi); "
                    "K1 / lock range not reported")
    if rep["odd_symmetry_err_max_rad"] > 0.05 * scale:
        warn.append("odd-symmetry error > 5% of max|kick|: check the anchor "
                    "crossing type, the pulse-CENTER definition and switch "
                    "asymmetry (may be physical)")
    if abs(value0) > 0.02 * scale:
        warn.append("delta_theta(e=0) != 0: the PDR null is offset from the "
                    "zero crossing (keep it; it is a static timing offset)")
    if settle and settle["systematic_max_rad"] > 0.01 * scale:
        warn.append("systematic settling residual > 1% of max|kick|: "
                    "simulate more cycles after the pulse (amplitude / AM-PM "
                    "transient not settled)")
    if not stable:
        warn.append("no stable zero crossing: the map cannot lock at zero "
                    "detuning")
    rep["warnings"] = warn
    return rep


def format_report(rep: dict) -> str:
    f = "{:.6g}".format
    out = ["PDR/PRC quality report (MODEL_SPEC.md section 14 convention)"]
    out.append(f"  samples: raw {rep['n_raw']}, unique {rep['n_unique']}, "
               f"merged {rep['n_merged']} (max dup spread "
               f"{f(rep['max_dup_spread_rad'])} rad), max gap "
               f"{f(rep['max_gap_rad'])} rad, winding {rep['winding']}, "
               f"LUT points {rep['n_lut']}")
    out.append(f"  K_inj small-signal = -d(dtheta)/de|0 = "
               f"{f(rep['k_inj_small_signal'])}   (local cubic fit; LUT "
               f"secant {f(rep['k_inj_lut_secant'])}); dtheta(0) = "
               f"{f(rep['delta_theta_at_e0_rad'])} rad")
    if rep["k1_first_harmonic"] is not None:
        out.append(f"  K1 first harmonic (best -K*sin(e) fit) = "
                   f"{f(rep['k1_first_harmonic'])}; mean kick a0 = "
                   f"{f(rep['fourier_a0'])} rad")
    out.append("  harmonics of dtheta (a_n cos ne + b_n sin ne): " + ", ".join(
        f"n{h['n']}: a={h['a']:+.4g} b={h['b']:+.4g}" for h in rep["fourier"]))
    out.append(f"  max|kick| = {f(rep['max_abs_kick_rad'])} rad at e = "
               f"{f(rep['max_abs_kick_at_e_rad'])} rad; max {f(rep['max_kick_rad'])}"
               f" @ {f(rep['max_kick_at_e_rad'])}, min {f(rep['min_kick_rad'])}"
               f" @ {f(rep['min_kick_at_e_rad'])}")
    skew = rep["quarter_wave_skew_max_rad"]
    out.append(f"  odd-symmetry error max|d(e)+d(-e)| = "
               f"{f(rep['odd_symmetry_err_max_rad'])} rad (rms "
               f"{f(rep['odd_symmetry_err_rms_rad'])}); quarter-wave skew "
               f"max|d(e)-d(pi-e)| = "
               f"{'n/a' if skew is None else f(skew) + ' rad'}")
    for r in rep["zero_crossings"]:
        out.append(f"  zero crossing e = {r['e_rad']:+.6f} rad, slope "
                   f"{r['slope']:+.5f} -> {r['class']}")
    lr = rep["lock_range"]
    if lr:
        s = (f"  static lock range a = 2*pi*Delta_f*T_ref in "
             f"[{f(lr['a_min_rad'])}, {f(lr['a_max_rad'])}] rad/ref-cycle")
        if "delta_f_min_hz" in lr:
            s += (f"  (Delta_f in [{lr['delta_f_min_hz'] / 1e6:.4g}, "
                  f"{lr['delta_f_max_hz'] / 1e6:.4g}] MHz)")
        out.append(s)
    if "noise_rms_upper_rad" in rep:
        out.append(f"  noise rms (upper bound, residual vs "
                   f"{rep['noise_fit_harmonics']}-harmonic fit) = "
                   f"{f(rep['noise_rms_upper_rad'])} rad")
    st = rep.get("settle")
    if st:
        out.append(f"  settling residual between edges {st['edge_pairs']}: "
                   f"systematic max {f(st['systematic_max_rad'])} rad, "
                   f"relative gain change {st['rel_gain_change']:+.4%} "
                   f"(raw max {f(st['max_abs_rad'])}, rms {f(st['rms_rad'])} "
                   "rad incl. timing noise)")
    for w in rep["warnings"]:
        out.append(f"  WARNING: {w}")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# top level
# ---------------------------------------------------------------------------
@dataclass
class PdrResult:
    lut_e: np.ndarray
    lut_d: np.ndarray
    samples: PdrSamples
    report: dict = field(default_factory=dict)

    def pdr_lut(self):
        """``SimConfig.pdr_lut`` value: [[e_inj_rad, delta_theta_rad], ...]."""
        return [[float(x), float(y)] for x, y in zip(self.lut_e, self.lut_d)]


def postprocess(raw: dict, n_points=64, smooth_harmonics=0,
                slope_window_rad=math.pi / 4, f_ref_hz=None) -> PdrResult:
    """raw dict (read_raw_csv) -> LUT + report."""
    sel, settle = select_latest_edge(raw)
    e, d = raw_to_samples(sel["phi_inj_cycles"], sel["t_cross_ref_s"],
                          sel["t_cross_inj_s"], sel["t_vco_s"])
    s = clean_samples(e, d)
    lut_e, lut_d = resample_uniform(s, n_points, smooth_harmonics)
    rep = quality_report(s, lut_e, lut_d, slope_window_rad=slope_window_rad,
                         f_ref_hz=f_ref_hz, settle=settle)
    return PdrResult(lut_e=lut_e, lut_d=lut_d, samples=s, report=rep)


def lut_comments(res: PdrResult, source: str, extra=()):
    rep = res.report
    k1 = rep["k1_first_harmonic"]
    lines = list(extra) + [
        "PDR/PRC LUT for MODEL_SPEC.md section 14: "
        "SimConfig(inj_model='lut', pdr_lut=...)",
        "columns: e_inj_rad, delta_theta_rad (model: linear interp, clamped "
        "at the ends)",
        f"grid: {len(res.lut_e)} points uniform on [-pi, pi] (both endpoints)",
        "sign: e_inj > 0 = pulse LATE vs target zero crossing; "
        "delta_theta < 0 = VCO edges delayed",
        f"generated by extraction/postprocess_pdr.py from {source}",
        f"K_inj(small-signal, e=0) = {rep['k_inj_small_signal']:.6g}; "
        f"K1(first harmonic) = {'n/a' if k1 is None else format(k1, '.6g')}; "
        f"max|kick| = {rep['max_abs_kick_rad']:.6g} rad",
    ]
    return lines


def _json_default(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    raise TypeError(type(o))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Raw transient-kick CSV -> MODEL_SPEC section 14 PDR LUT")
    ap.add_argument("raw_csv")
    ap.add_argument("-o", "--out", default=None,
                    help="LUT CSV path (default: <raw>_lut.csv)")
    ap.add_argument("--n-points", type=int, default=64)
    ap.add_argument("--smooth-harmonics", type=int, default=0,
                    help="0 = periodic linear interpolation (default); "
                         "H > 0 = least-squares Fourier fit with H harmonics")
    ap.add_argument("--slope-window", type=float, default=math.pi / 4,
                    help="half-width (rad) of the local fit for K_inj at e=0")
    ap.add_argument("--f-ref-hz", type=float, default=4e9,
                    help="reference frequency for the lock range in Hz "
                         "(default 4e9, MODEL_SPEC section 1)")
    ap.add_argument("--va-table", default=None,
                    help="also write a whitespace table for Verilog-A "
                         "$table_model")
    ap.add_argument("--json", default=None, help="write the report as JSON")
    ap.add_argument("--comment", action="append", default=[],
                    help="extra '#' header line for the LUT (repeatable)")
    a = ap.parse_args(argv)

    raw = read_raw_csv(a.raw_csv)
    res = postprocess(raw, n_points=a.n_points,
                      smooth_harmonics=a.smooth_harmonics,
                      slope_window_rad=a.slope_window, f_ref_hz=a.f_ref_hz)
    out = a.out or os.path.splitext(a.raw_csv)[0] + "_lut.csv"
    comments = lut_comments(res, os.path.basename(a.raw_csv), a.comment)
    write_lut_csv(out, res.lut_e, res.lut_d, comments)
    if a.va_table:
        write_va_table(a.va_table, res.lut_e, res.lut_d, comments)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(res.report, f, indent=2, default=_json_default)
    print(format_report(res.report))
    print(f"LUT written: {out} ({len(res.lut_e)} points)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
