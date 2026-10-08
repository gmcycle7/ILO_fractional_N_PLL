#!/usr/bin/env python3
"""PDR transient-kick sweep driver for extraction/spectre_pdr_tb.scs.

STATUS: the Spectre side is a TEMPLATE -- NOT RUN (no circuit simulator was
available when this was written; the command lines and the paramset syntax
are unverified).  The Python side is real and tested
(tests/test_pdr_postprocess.py): --dry-run, --render, --anchor, --collect and
--synthetic all run here.  Recipe: PDR_EXTRACTION.md.

Modes
-----
--dry-run           print the plan (pass-0 anchor run, the phi_inj grid, the
                    twin REF/INJ runs, the command lines, the raw-CSV schema).
                    Writes nothing.
--render OUTDIR     write the per-run netlists (or one paramset netlist),
                    OUTDIR/plan.json and OUTDIR/run_all.sh.  Runs nothing.
--anchor WAVE       pass 0: measure t_anchor (first target-type crossing
                    after n_settle nominal cycles) and t_vco from the anchor
                    run's exported waveform; prints the --t-anchor/--t-vco
                    values to pass to --render.
--collect OUTDIR    per-run waveform exports (OUTDIR/runs/<id>/vdiff.csv,
                    two numeric columns time_s, v_diff_V) -> raw CSV.
--synthetic         fabricate a raw CSV from a KNOWN PDR (plus timing
                    noise), so the post-processing can be exercised end to
                    end without a simulator.

Raw CSV schema (consumed by extraction/postprocess_pdr.py)
----------------------------------------------------------
    phi_inj_cycles,t_cross_ref_s,t_cross_inj_s,t_vco_s[,edge_idx]

    phi_inj_cycles  pulse CENTER after the anchor (target zero crossing), in
                    cycles of t_vco_s (0..1)
    t_cross_ref_s   REF run: first target-type crossing after
                    t_anchor + (edge_idx - 0.5)*t_vco  (the "late edge")
    t_cross_inj_s   INJ run: the target-type crossing nearest t_cross_ref_s
                    (same edge; |dt| <= T/2 by construction)
    t_vco_s         REF run: settled period (regression over its crossings)
    edge_idx        cycles after the anchor of that late edge (optional;
                    two edges per phi enable the settling check)

Examples
--------
    python3 extraction/run_sweep.py --dry-run --n-phi 128
    python3 extraction/run_sweep.py --synthetic -o /tmp/raw.csv
    python3 extraction/postprocess_pdr.py /tmp/raw.csv -o /tmp/lut.csv
"""

import argparse
import json
import math
import os
import re
import shlex
import sys

import numpy as np

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from extraction.postprocess_pdr import (  # noqa: E402
    RAW_REQUIRED, write_raw_csv)
from model.python.phase_math import TWO_PI, wrap_cycles  # noqa: E402

DEFAULT_TB = os.path.join(_REPO_ROOT, "extraction", "spectre_pdr_tb.scs")
DEFAULT_SPECTRE = ("spectre +aps +mt=4 -format psfxl -raw {raw} +log {log} "
                   "{netlist}")
SWEEP_BEGIN, SWEEP_END = "@SWEEP-PARAMS-BEGIN", "@SWEEP-PARAMS-END"
ANA_BEGIN, ANA_END = "@ANALYSIS-BEGIN", "@ANALYSIS-END"
MIN_PHI_STEPS = 64

NOT_RUN = ("TEMPLATE -- NOT RUN: no circuit simulator was available; Spectre "
           "command lines and netlist syntax are unverified")


# ---------------------------------------------------------------------------
# plan
# ---------------------------------------------------------------------------
def phi_grid(n_steps: int, include_endpoint: bool = True) -> np.ndarray:
    """phi_inj = i/n_steps, i = 0..n_steps (endpoint 1.0 duplicates 0.0 and
    exercises the post-processor's dedupe) or 0..n_steps-1."""
    if n_steps < 1:
        raise ValueError("n_steps must be >= 1")
    n = n_steps + 1 if include_endpoint else n_steps
    return np.arange(n, dtype=np.float64) / n_steps


def build_plan(n_phi=128, include_endpoint=True, f_vco_nom=12.5e9,
               n_settle=3000, n_post=200, edges=(100, 190), t_anchor=None,
               t_vco=None, mode="per-run", direction="rise",
               spectre_cmd=DEFAULT_SPECTRE, tb=DEFAULT_TB) -> dict:
    """Everything a sweep needs, as plain JSON-able data."""
    if mode not in ("per-run", "paramset"):
        raise ValueError("mode must be 'per-run' or 'paramset'")
    if direction not in ("rise", "fall"):
        raise ValueError("direction must be 'rise' or 'fall'")
    edges = sorted(int(e) for e in edges)
    if not edges or edges[-1] >= n_post or edges[0] < 1:
        raise ValueError("measured edges must satisfy 1 <= edge < n_post")
    t_nom = 1.0 / f_vco_nom
    measured = t_anchor is not None and t_vco is not None
    if not measured:
        t_anchor = n_settle * t_nom      # placeholder until pass 0 is done
        t_vco = t_nom
    pairs = []
    for i, phi in enumerate(phi_grid(n_phi, include_endpoint)):
        pairs.append({"idx": i, "phi_inj": float(phi),
                      "e_inj_rad": TWO_PI * wrap_cycles(float(phi)),
                      "ref": f"phi_{i:04d}_ref", "inj": f"phi_{i:04d}_inj"})
    return {
        "status": NOT_RUN,
        "testbench": os.path.abspath(tb),
        "mode": mode,
        "direction": direction,
        "f_vco_nom_hz": f_vco_nom,
        "n_settle": int(n_settle),
        "n_post": int(n_post),
        "edges": edges,
        "t_anchor_s": float(t_anchor),
        "t_vco_s": float(t_vco),
        "anchor_measured": bool(measured),
        "n_phi_steps": int(n_phi),
        "pairs": pairs,
        "spectre_cmd": spectre_cmd,
    }


def sweep_param_lines(plan: dict, phi: float, inj_en: int) -> list:
    return [
        f"parameters n_settle={plan['n_settle']} n_post={plan['n_post']}",
        f"parameters phi_inj={phi!r} inj_en={int(inj_en)}",
        f"parameters t_anchor={plan['t_anchor_s']!r} "
        f"t_vco_meas={plan['t_vco_s']!r}",
    ]


def _replace_block(lines, begin, end, new_lines):
    try:
        b = next(i for i, ln in enumerate(lines) if begin in ln)
        e = next(i for i, ln in enumerate(lines) if end in ln and i > b)
    except StopIteration:
        raise ValueError(f"testbench markers {begin}/{end} not found")
    return lines[:b + 1] + list(new_lines) + lines[e:], lines[b + 1:e]


def render_netlist(tb_text: str, plan: dict, phi: float, inj_en: int) -> str:
    """Per-run netlist: the template with the sweep-parameter block
    replaced."""
    lines = tb_text.splitlines()
    head = [f"// GENERATED by extraction/run_sweep.py -- {NOT_RUN}",
            f"// phi_inj={phi!r} inj_en={inj_en}"]
    out, _ = _replace_block(lines, SWEEP_BEGIN, SWEEP_END,
                            sweep_param_lines(plan, phi, inj_en))
    return "\n".join(head + out) + "\n"


def render_paramset_netlist(tb_text: str, plan: dict) -> str:
    """One netlist, all REF/INJ runs as a Spectre paramset sweep (syntax
    unverified: `spectre -h paramset`, `spectre -h sweep`)."""
    lines = tb_text.splitlines()
    lines, _ = _replace_block(lines, SWEEP_BEGIN, SWEEP_END,
                              sweep_param_lines(plan, 0.0, 1))
    rows = ["pdr_ps paramset {", "phi_inj inj_en"]
    for p in plan["pairs"]:
        rows.append(f"{p['phi_inj']!r} 0")
        rows.append(f"{p['phi_inj']!r} 1")
    rows.append("}")
    b = next(i for i, ln in enumerate(lines) if ANA_BEGIN in ln)
    e = next(i for i, ln in enumerate(lines) if ANA_END in ln and i > b)
    analysis = lines[b + 1:e]
    wrapped = rows + ["pdr_sweep sweep paramset=pdr_ps {"] + analysis + ["}"]
    lines = lines[:b + 1] + wrapped + lines[e:]
    head = [f"// GENERATED by extraction/run_sweep.py (paramset mode) -- "
            f"{NOT_RUN}"]
    return "\n".join(head + lines) + "\n"


def spectre_command(plan: dict, run_dir: str) -> str:
    return plan["spectre_cmd"].format(
        raw=shlex.quote(os.path.join(run_dir, "psf")),
        log=shlex.quote(os.path.join(run_dir, "spectre.log")),
        netlist=shlex.quote(os.path.join(run_dir, "netlist.scs")))


def format_plan(plan: dict, show_all: bool = True) -> str:
    n = len(plan["pairs"])
    out = [f"# PDR transient-kick sweep plan -- {plan['status']}",
           f"# testbench : {plan['testbench']}",
           f"# mode      : {plan['mode']}  ({2 * n} twin runs + 1 anchor run)",
           f"# target    : {plan['direction']} crossing of v(outp)-v(outn); "
           f"f_vco_nom = {plan['f_vco_nom_hz']:.6g} Hz",
           f"# settle    : n_settle = {plan['n_settle']} cycles; n_post = "
           f"{plan['n_post']}; late edges = {plan['edges']}"]
    if plan["anchor_measured"]:
        out.append(f"# anchor    : t_anchor = {plan['t_anchor_s']!r} s, "
                   f"t_vco = {plan['t_vco_s']!r} s (measured)")
    else:
        out.append(f"# anchor    : NOT MEASURED -- placeholders t_anchor = "
                   f"n_settle*T_nom = {plan['t_anchor_s']:.6g} s, t_vco = "
                   f"T_nom = {plan['t_vco_s']:.6g} s; run pass 0 first")
    out += ["#",
            "# pass 0 (anchor): netlist with inj_en=0, then",
            "#   " + spectre_command(plan, "runs/anchor"),
            "#   export runs/anchor/vdiff.csv, then",
            f"#   python3 extraction/run_sweep.py --anchor runs/anchor/vdiff.csv "
            f"--n-settle {plan['n_settle']} --f-vco {plan['f_vco_nom_hz']:.6g}",
            "#",
            f"# pass 1 (twin sweep, {n} phi points, phi = i/{plan['n_phi_steps']}):",
            "#  idx   phi_inj        e_inj_rad   REF run          INJ run"]
    shown = plan["pairs"] if show_all or n <= 8 else (
        plan["pairs"][:4] + [None] + plan["pairs"][-4:])
    for p in shown:
        if p is None:
            out.append("#  ...")
            continue
        out.append(f"#  {p['idx']:4d}  {p['phi_inj']:.8f}  "
                   f"{p['e_inj_rad']:+.8f}  {p['ref']}  {p['inj']}")
    out.append("#")
    if plan["mode"] == "per-run":
        out.append("# commands (one per run; run_all.sh from --render holds "
                   f"the anchor run + all {2 * n} twin runs):")
        for p in plan["pairs"][:1] + plan["pairs"][-1:]:
            for rid in (p["ref"], p["inj"]):
                out.append(spectre_command(plan, f"runs/{rid}"))
        out.append(f"# ... ({2 * n - 4} more, same pattern)")
    else:
        out.append("# command (single paramset job):")
        out.append(plan["spectre_cmd"].format(
            raw="runs/paramset/psf", log="runs/paramset/spectre.log",
            netlist="runs/paramset/netlist.scs"))
        out.append("# then export every sweep point to runs/<id>/vdiff.csv")
    out += ["#",
            "# after each run: export v(outp)-v(outn) to runs/<id>/vdiff.csv "
            "(time_s, v_diff_V), then",
            "#   python3 extraction/run_sweep.py --collect <OUTDIR> -o raw.csv",
            "#   python3 extraction/postprocess_pdr.py raw.csv -o pdr_lut.csv",
            "#",
            "# raw CSV schema: " + ",".join(RAW_REQUIRED) + "[,edge_idx]"]
    return "\n".join(out)


def render(outdir: str, plan: dict) -> list:
    """Write netlists + plan.json + run_all.sh.  Returns written paths."""
    with open(plan["testbench"], "r", encoding="utf-8") as f:
        tb = f.read()
    written = []
    runs = os.path.join(outdir, "runs")
    os.makedirs(runs, exist_ok=True)
    cmds = ["#!/bin/sh", f"# {NOT_RUN}", "set -e", "cd \"$(dirname \"$0\")\""]
    if plan["mode"] == "per-run":
        jobs = [("anchor", 0.0, 0)]
        for p in plan["pairs"]:
            jobs += [(p["ref"], p["phi_inj"], 0), (p["inj"], p["phi_inj"], 1)]
        for rid, phi, en in jobs:
            d = os.path.join(runs, rid)
            os.makedirs(d, exist_ok=True)
            path = os.path.join(d, "netlist.scs")
            with open(path, "w", encoding="utf-8") as f:
                f.write(render_netlist(tb, plan, phi, en))
            written.append(path)
            cmds.append(spectre_command(plan, f"runs/{rid}"))
    else:
        d = os.path.join(runs, "paramset")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, "netlist.scs")
        with open(path, "w", encoding="utf-8") as f:
            f.write(render_paramset_netlist(tb, plan))
        written.append(path)
        cmds.append(spectre_command(plan, "runs/paramset"))
    sh = os.path.join(outdir, "run_all.sh")
    with open(sh, "w", encoding="utf-8") as f:
        f.write("\n".join(cmds) + "\n")
    pj = os.path.join(outdir, "plan.json")
    with open(pj, "w", encoding="utf-8") as f:
        json.dump(plan, f, indent=2)
    return written + [sh, pj]


# ---------------------------------------------------------------------------
# waveform handling (real, tested)
# ---------------------------------------------------------------------------
def read_wave(path):
    """Two numeric columns (time_s, v_diff_V); any line whose first two
    fields are not numbers (headers, Ocean text) is skipped."""
    t, v = [], []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            parts = [p for p in re.split(r"[,;\s]+", line.strip()) if p]
            if len(parts) < 2:
                continue
            try:
                a, b = float(parts[0]), float(parts[1])
            except ValueError:
                continue
            t.append(a)
            v.append(b)
    t = np.asarray(t)
    v = np.asarray(v)
    if len(t) < 4 or np.any(np.diff(t) <= 0):
        raise ValueError(f"{path}: need >= 4 samples with increasing time")
    return t, v


def _cubic_refine(t, x, i, t_lin):
    """Root of the cubic through samples i-1..i+2 inside [t_i, t_{i+1}]
    (Newton from the linear estimate); falls back to t_lin."""
    if i < 1 or i + 2 >= len(t):
        return t_lin
    ts = t[i - 1:i + 3]
    scale = ts[2] - ts[1]
    u = (ts - t[i]) / scale
    p = np.polyfit(u, x[i - 1:i + 3], 3)
    dp = np.polyder(p)
    r = (t_lin - t[i]) / scale
    for _ in range(4):
        dv = np.polyval(dp, r)
        if dv == 0.0:
            return t_lin
        r -= np.polyval(p, r) / dv
    if not 0.0 <= r <= 1.0:
        return t_lin
    return float(t[i] + r * scale)


def crossings(t, v, direction="rise", threshold=0.0, hysteresis=0.0,
              refine="cubic"):
    """Times where v crosses threshold in the given direction: bracketing
    samples, linear interpolation, then (refine='cubic') the root of the
    4-point cubic through the neighbouring samples (error ~1e-8 cycle at
    T/100 sampling vs ~1e-6 for linear).  With hysteresis > 0 a crossing only
    counts if the signal went beyond threshold -/+ hysteresis since the
    previous accepted crossing (rejects chatter during the pulse)."""
    t = np.asarray(t, dtype=np.float64)
    x = np.asarray(v, dtype=np.float64) - threshold
    if direction == "fall":
        x = -x
    elif direction != "rise":
        raise ValueError("direction must be 'rise' or 'fall'")
    if refine not in ("linear", "cubic"):
        raise ValueError("refine must be 'linear' or 'cubic'")
    idx = np.nonzero((x[:-1] < 0.0) & (x[1:] >= 0.0))[0]
    out = []
    last = -1
    for i in idx:
        if hysteresis > 0.0 and np.min(x[last + 1:i + 1]) > -hysteresis:
            continue
        tc = t[i] + (0.0 - x[i]) * (t[i + 1] - t[i]) / (x[i + 1] - x[i])
        if refine == "cubic":
            tc = _cubic_refine(t, x, i, tc)
        out.append(tc)
        last = i
    return np.asarray(out)


def _period_fit(tc):
    """Least-squares period from consecutive crossing times."""
    k = np.arange(len(tc), dtype=np.float64)
    return float(np.polyfit(k, tc, 1)[0])


def measure_anchor(t, v, t_settle, direction="rise", n_period=50,
                   hysteresis_frac=0.05):
    """Pass 0: t_anchor = first target crossing at/after t_settle; t_vco =
    least-squares period over the (up to) n_period crossings from the anchor
    on (the anchor run has no pulse and saves only from t_anchor - 4 T, so
    the settled window AFTER the anchor is what is available).  Also returns
    the relative period drift between the two halves of that window (should
    be < 1e-6; larger means n_settle is too short)."""
    amp = 0.5 * float(np.max(v) - np.min(v))
    tc = crossings(t, v, direction, hysteresis=hysteresis_frac * amp)
    after = np.nonzero(tc >= t_settle)[0]
    if len(after) == 0:
        raise ValueError("no target crossing after t_settle")
    ia = int(after[0])
    win = tc[ia:ia + n_period + 1]
    if len(win) < 4:
        raise ValueError("too few crossings after the anchor")
    t_vco = _period_fit(win)
    h = len(win) // 2
    drift = abs(_period_fit(win[h:]) - _period_fit(win[:h + 1])) / t_vco
    return {"t_anchor_s": float(tc[ia]), "t_vco_s": t_vco,
            "period_drift_rel": float(drift), "n_crossings_used": len(win)}


def collect_pair(t_ref, v_ref, t_inj, v_inj, t_anchor, t_vco_plan, edges,
                 direction="rise", hysteresis_frac=0.05):
    """One REF/INJ pair -> list of (t_cross_ref, t_cross_inj, t_vco, edge)."""
    amp = 0.5 * float(np.max(v_ref) - np.min(v_ref))
    hyst = hysteresis_frac * amp
    cr = crossings(t_ref, v_ref, direction, hysteresis=hyst)
    ci = crossings(t_inj, v_inj, direction, hysteresis=hyst)
    rows = []
    for n in edges:
        t_lo = t_anchor + (n - 0.5) * t_vco_plan
        k = np.nonzero(cr >= t_lo)[0]
        if len(k) == 0 or cr[k[0]] > t_lo + t_vco_plan:
            raise ValueError(f"REF run: no crossing for edge {n}")
        tr = float(cr[k[0]])
        win = cr[(cr >= t_anchor - 0.5 * t_vco_plan) & (cr <= tr + 1e-30)]
        t_vco = _period_fit(win) if len(win) >= 4 else t_vco_plan
        j = int(np.argmin(np.abs(ci - tr)))
        ti = float(ci[j])
        if abs(ti - tr) > 0.75 * t_vco:
            raise ValueError(f"INJ run: no crossing near REF edge {n}")
        rows.append((tr, ti, t_vco, int(n)))
    return rows


def collect(outdir: str, plan=None) -> dict:
    """OUTDIR/runs/<id>/vdiff.csv for every pair in plan.json -> raw dict."""
    if plan is None:
        with open(os.path.join(outdir, "plan.json"), "r",
                  encoding="utf-8") as f:
            plan = json.load(f)
    cols = {c: [] for c in RAW_REQUIRED + ("edge_idx",)}
    for p in plan["pairs"]:
        tr, vr = read_wave(os.path.join(outdir, "runs", p["ref"], "vdiff.csv"))
        ti, vi = read_wave(os.path.join(outdir, "runs", p["inj"], "vdiff.csv"))
        for a, b, tv, n in collect_pair(tr, vr, ti, vi, plan["t_anchor_s"],
                                        plan["t_vco_s"], plan["edges"],
                                        plan["direction"]):
            cols["phi_inj_cycles"].append(p["phi_inj"])
            cols["t_cross_ref_s"].append(a)
            cols["t_cross_inj_s"].append(b)
            cols["t_vco_s"].append(tv)
            cols["edge_idx"].append(n)
    out = {c: np.asarray(v, dtype=np.float64) for c, v in cols.items()}
    out["edge_idx"] = out["edge_idx"].astype(np.int64)
    return out


# ---------------------------------------------------------------------------
# synthetic raw data (pipeline self-test; NOT simulator output)
# ---------------------------------------------------------------------------
def truth_pdr(name="asym", k=0.3, h2=0.3):
    """Known PDRs in the MODEL_SPEC section 14 convention:
    asym : -k*(sin e + h2*sin 2e)   (default; K_inj(0) = k*(1 + 2*h2))
    sin  : -k*sin e
    reset: -e                        (ideal reset, winding -1)"""
    if name == "asym":
        return lambda e: -k * (np.sin(e) + h2 * np.sin(2.0 * e))
    if name == "sin":
        return lambda e: -k * np.sin(e)
    if name == "reset":
        return lambda e: -np.asarray(e, dtype=np.float64)
    raise ValueError(f"unknown synthetic PDR '{name}'")


def synthesize_raw(pdr="asym", k=0.3, h2=0.3, n_phi=128,
                   include_endpoint=True, f_vco=12.5e9, n_settle=3000,
                   edges=(100, 190), sigma_t_s=10e-15, settle_tau_cycles=0.0,
                   seed=20261005) -> dict:
    """Fabricate raw transient-kick rows from a known PDR.

    For each phi and late edge n:  t_ref = t_anchor + n*T + noise,
    t_inj = t_anchor + n*T - dtheta(e)/(2*pi)*T + noise  (the inverse of the
    postprocess sign mapping), with independent N(0, sigma_t_s) timing noise
    on every crossing.  settle_tau_cycles > 0 adds an unsettled AM->PM term
    dtheta*0.25*exp(-n/tau) to emulate a too-early edge."""
    f = truth_pdr(pdr, k, h2)
    rng = np.random.default_rng(seed)
    t_vco = 1.0 / f_vco
    t_anchor = (n_settle + 0.137) * t_vco
    cols = {c: [] for c in RAW_REQUIRED + ("edge_idx",)}
    for phi in phi_grid(n_phi, include_endpoint):
        e = TWO_PI * wrap_cycles(float(phi))
        d_true = float(f(e))
        for n in sorted(edges):
            d = d_true
            if settle_tau_cycles > 0.0:
                d = d_true * (1.0 + 0.25 * math.exp(-n / settle_tau_cycles))
            base = t_anchor + n * t_vco
            cols["phi_inj_cycles"].append(float(phi))
            cols["t_cross_ref_s"].append(base + sigma_t_s * rng.standard_normal())
            cols["t_cross_inj_s"].append(base - d / TWO_PI * t_vco
                                         + sigma_t_s * rng.standard_normal())
            cols["t_vco_s"].append(t_vco)
            cols["edge_idx"].append(int(n))
    out = {c: np.asarray(v, dtype=np.float64) for c, v in cols.items()}
    out["edge_idx"] = out["edge_idx"].astype(np.int64)
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _edges(s):
    return tuple(int(x) for x in s.split(","))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--render", metavar="OUTDIR")
    g.add_argument("--anchor", metavar="WAVE")
    g.add_argument("--collect", metavar="OUTDIR")
    g.add_argument("--synthetic", action="store_true")
    ap.add_argument("--tb", default=DEFAULT_TB)
    ap.add_argument("--mode", default="per-run", choices=("per-run", "paramset"))
    ap.add_argument("--n-phi", type=int, default=128,
                    help=f"phi_inj steps over 0..1 (>= {MIN_PHI_STEPS})")
    ap.add_argument("--no-endpoint", action="store_true",
                    help="omit phi = 1.0 (duplicate of 0.0)")
    ap.add_argument("--f-vco", type=float, default=12.5e9)
    ap.add_argument("--n-settle", type=int, default=3000)
    ap.add_argument("--n-post", type=int, default=200)
    ap.add_argument("--edges", type=_edges, default=(100, 190))
    ap.add_argument("--t-anchor", type=float, default=None)
    ap.add_argument("--t-vco", type=float, default=None)
    ap.add_argument("--direction", default="rise", choices=("rise", "fall"))
    ap.add_argument("--spectre-cmd", default=DEFAULT_SPECTRE)
    ap.add_argument("-o", "--out", default=None, help="raw CSV output path")
    ap.add_argument("--pdr", default="asym", choices=("asym", "sin", "reset"))
    ap.add_argument("--k", type=float, default=0.3)
    ap.add_argument("--h2", type=float, default=0.3)
    ap.add_argument("--sigma-t-fs", type=float, default=10.0)
    ap.add_argument("--settle-tau", type=float, default=0.0)
    ap.add_argument("--seed", type=int, default=20261005)
    a = ap.parse_args(argv)

    if a.n_phi < MIN_PHI_STEPS:
        ap.error(f"--n-phi must be >= {MIN_PHI_STEPS}")

    if a.anchor:
        t, v = read_wave(a.anchor)
        r = measure_anchor(t, v, a.n_settle / a.f_vco, a.direction)
        print(json.dumps(r, indent=2))
        print(f"# next: --render OUTDIR --t-anchor {r['t_anchor_s']!r} "
              f"--t-vco {r['t_vco_s']!r}")
        return 0

    if a.collect:
        raw = collect(a.collect)
        out = a.out or os.path.join(a.collect, "raw.csv")
        write_raw_csv(out, raw, [f"collected by run_sweep.py from {a.collect}"])
        print(f"raw CSV written: {out} ({len(raw['phi_inj_cycles'])} rows)")
        return 0

    if a.synthetic:
        raw = synthesize_raw(a.pdr, a.k, a.h2, a.n_phi, not a.no_endpoint,
                             a.f_vco, a.n_settle, a.edges, a.sigma_t_fs * 1e-15,
                             a.settle_tau, a.seed)
        out = a.out or "pdr_raw_synthetic.csv"
        truth = {"asym": f"-{a.k}*(sin e + {a.h2}*sin 2e)",
                 "sin": f"-{a.k}*sin e", "reset": "-e"}[a.pdr]
        write_raw_csv(out, raw, [
            "SYNTHETIC raw data fabricated by extraction/run_sweep.py "
            "--synthetic -- NOT simulator output",
            f"truth PDR: delta_theta(e) = {truth}; timing noise "
            f"{a.sigma_t_fs} fs rms per crossing; seed {a.seed}; "
            f"f_vco {a.f_vco:.6g} Hz"])
        print(f"synthetic raw CSV written: {out} "
              f"({len(raw['phi_inj_cycles'])} rows)")
        return 0

    plan = build_plan(a.n_phi, not a.no_endpoint, a.f_vco, a.n_settle,
                      a.n_post, a.edges, a.t_anchor, a.t_vco, a.mode,
                      a.direction, a.spectre_cmd, a.tb)
    if a.dry_run:
        print(format_plan(plan))
        return 0
    paths = render(a.render, plan)
    print(f"# {NOT_RUN}")
    print(f"rendered {len(paths)} files under {a.render} "
          f"(run_all.sh, plan.json, netlists)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
