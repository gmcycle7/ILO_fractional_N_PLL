#!/usr/bin/env python3
"""Stimulus + export-script generator for the Spectre validation kit.

Converts committed command vectors (test_vectors/csv/<name>.csv) into Spectre
PWL source files, and writes one Ocean export script per testbench.

    # everything the four testbenches need (+ self-verification of the files)
    python3 gen_stimulus.py --all --verify

    # generic: any code column(s) of any committed vector
    python3 gen_stimulus.py --vector n3p125_nearest --columns c_INJ j_INJ --verify

    # injection trigger PWL (one pulse per cycle, timed from j_INJ/c_INJ)
    python3 gen_stimulus.py --vector n3p130_dynamics_sin --ilo-trigger --f0 12.52e9

Outputs (default --build = <this dir>/build):
    build/stim/<vector>__<column>.pwl        code stimulus, "time value" per line
    build/stim/<vector>__inj_trigger.pwl     injection trigger
    build/ocean/export_tb_<tb>.ocn           Ocean CSV export (with --all)

PWL code waveform (timing plan in kit_common.TIMING): value = code[k] *
v_per_code, held from k*T_REF + T_CODE + T_RAMP until the next change; each
change is a T_RAMP linear ramp starting at k*T_REF + T_CODE (code updates
"clock-to-q" after the reference edge at k*T_REF + T_EDGE). Points are
written only where the code changes.

This script is REAL and runs anywhere (python3 stdlib only). The Spectre and
Ocean steps it prepares are UNRUN (see README.md).
"""

import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit_common as kc  # noqa: E402

T = kc.TIMING


# ---------------------------------------------------------------------------
# PWL construction
# ---------------------------------------------------------------------------
def code_pwl_points(codes, v_per_code=kc.V_PER_CODE):
    t_ref, t_code, t_ramp = T["T_REF"], T["T_CODE"], T["T_RAMP"]
    pts = [(0.0, codes[0] * v_per_code)]
    for k in range(1, len(codes)):
        if codes[k] != codes[k - 1]:
            t0 = k * t_ref + t_code
            pts.append((t0, codes[k - 1] * v_per_code))
            pts.append((t0 + t_ramp, codes[k] * v_per_code))
    pts.append((len(codes) * t_ref, codes[-1] * v_per_code))
    return pts


def trigger_pwl_points(times, width=None):
    """Rising crossing (0.5 V) exactly at each t_k: ramp t_k -/+ T_RAMP/2."""
    r = T["T_RAMP"]
    w = T["W_ILO"] if width is None else width
    pts = [(0.0, 0.0)]
    for tk in times:
        pts += [(tk - r / 2, 0.0), (tk + r / 2, 1.0),
                (tk + r / 2 + w, 1.0), (tk + r / 2 + w + r, 0.0)]
    return pts


def write_pwl(path, pts):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for t, v in pts:
            f.write(f"{t!r} {v!r}\n")


def read_pwl(path):
    pts = []
    with open(path) as f:
        for ln in f:
            if ln.strip():
                a, b = ln.split()
                pts.append((float(a), float(b)))
    return pts


def pwl_value(pts, t):
    """Piecewise-linear value (held after the last point), like a vsource pwl."""
    if t <= pts[0][0]:
        return pts[0][1]
    lo, hi = 0, len(pts) - 1
    if t >= pts[hi][0]:
        return pts[hi][1]
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if pts[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    (t0, v0), (t1, v1) = pts[lo], pts[hi]
    return v0 + (v1 - v0) * (t - t0) / (t1 - t0)


def rising_crossings(pts, level=0.5):
    out = []
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        if v0 < level <= v1:
            out.append(t0 + (level - v0) * (t1 - t0) / (v1 - v0))
    return out


# ---------------------------------------------------------------------------
# Verification of generated files (shape + timing)
# ---------------------------------------------------------------------------
def _offset_seconds(expr):
    """'T_EDGE+T_SKEW' -> seconds."""
    return sum(T[name.strip()] for name in expr.split("+"))


def verify_code_pwl(path, codes, sample_offset, guard=10e-12):
    """Return list of problems (empty = OK). Checks: strictly increasing time,
    integer-coded levels, every change is one T_RAMP ramp starting at
    k*T_REF + T_CODE, and the value is exactly code[k] (flat, no breakpoint
    within +-guard) at the consumer sampling instant k*T_REF + sample_offset
    and at the export strobe k*T_REF + T_STROBE."""
    pts = read_pwl(path)
    errs = []
    for (t0, _), (t1, _) in zip(pts, pts[1:]):
        if not t1 > t0:
            errs.append(f"time not strictly increasing at t={t0!r}")
            break
    for t, v in pts:
        if abs(v / kc.V_PER_CODE - round(v / kc.V_PER_CODE)) > 1e-12:
            errs.append(f"non-integer level {v} at t={t!r}")
            break
    for (t0, v0), (t1, v1) in zip(pts[1:-1], pts[2:-1]):
        if v0 != v1:
            k = (t0 - T["T_CODE"]) / T["T_REF"]
            if abs(k - round(k)) > 1e-6 or abs((t1 - t0) - T["T_RAMP"]) > 1e-18:
                errs.append(f"ramp at t={t0!r}..{t1!r} not on the code grid")
                break
    bps = [p[0] for p in pts]
    for label, off in (("consumer", sample_offset), ("strobe", T["T_STROBE"])):
        for k, code in enumerate(codes):
            ts = k * T["T_REF"] + off
            v = pwl_value(pts, ts)
            if v != code * kc.V_PER_CODE:
                errs.append(f"{label} sample k={k} t={ts:.4e}: {v} != {code}")
                break
            if any(abs(b - ts) < guard for b in bps[1:]):
                errs.append(f"{label} sample k={k}: breakpoint within {guard:g} s")
                break
    return errs, len(pts)


def verify_trigger_pwl(path, times, f0, vector):
    """Crossings exactly at t_k, one pulse per reference cycle, pulse lands on
    phase x_k + u_k (the intended zero crossing) of an f0 oscillator."""
    pts = read_pwl(path)
    errs = []
    cr = rising_crossings(pts)
    if len(cr) != len(times):
        errs.append(f"{len(cr)} rising crossings, expected {len(times)}")
        return errs, len(pts)
    t_vco = 1.0 / f0
    cols = kc.load_vector_csv(vector)
    cfg, _ = kc.load_vector_json(vector)
    n_div = cfg["n_div"]
    worst = 0.0
    for k, (c, tk) in enumerate(zip(cr, times)):
        if abs(c - tk) > 1e-21:
            errs.append(f"k={k}: crossing {c!r} != nominal {tk!r}")
            break
        off = tk - k * T["T_REF"]
        if not (T["ILO_ARM_CYCLES"] * t_vco - 1e-18 <= off
                < (T["ILO_ARM_CYCLES"] + 1) * t_vco):
            errs.append(f"k={k}: offset {off:.4e} outside [T_arm, T_arm+T_vco)")
            break
        if off + T["T_RAMP"] / 2 + T["W_ILO"] + T["T_RAMP"] >= T["T_REF"]:
            errs.append(f"k={k}: pulse spills into the next cycle")
            break
        # oscillator phase at the trigger: f0*t_k mod 1 == wrap01(x_k + u_k)
        u = ((32 * cols["j_INJ"][k] + cols["c_INJ"][k]) % 256) / 256.0
        want = kc.wrap01(kc.wrap01(k * n_div) + u)
        got = kc.wrap01(f0 * tk)
        d = abs(kc.wrap_cycles(got - want))
        worst = max(worst, d)
    if worst > 1e-9:
        errs.append(f"trigger phase misaligned by up to {worst:.3e} cycles")
    return errs, len(pts)


# ---------------------------------------------------------------------------
# Ocean export script
# ---------------------------------------------------------------------------
def ocean_script(tb, build):
    tb, d = kc.get_tb(tb)
    raw = os.path.abspath(os.path.join(build, "raw", f"tb_{tb}.raw"))
    out = os.path.abspath(os.path.join(build, "results", f"tb_{tb}.csv"))
    prb = kc.probes(tb)
    n = T["N_CYC"]
    L = []
    L.append(f"; export_tb_{tb}.ocn -- generated by gen_stimulus.py. STATUS: UNRUN.")
    L.append("; Exports one CSV row per reference cycle k = 0..N-1 for check_results.py:")
    L.append(";   'v' columns     : V(net) at t = k*T_REF + T_STROBE   (Ocean value())")
    L.append(";   'cross' columns : time of the (k+1)-th rising 0.5 V crossing (cross())")
    L.append("; Run:  ocean -nograph -restore <this file> < /dev/null")
    L.append(f'rawDir  = "{raw}"')
    L.append(f'outCsv  = "{out}"')
    L.append("resName = 'tran   ; = analysis instance name in the netlist ('tran tran ...')")
    L.append('unless(openResults(rawDir) error("openResults failed for %s" rawDir))')
    L.append("selectResult(resName)   ; if this fails: results() lists the names")
    for i, (col, net, how) in enumerate(prb):
        L.append(f'w{i} = v("{net}")   ; {col} ({how})')
        L.append(f'unless(w{i} error("signal {net} not found in %s" rawDir))')
    L.append('port = outfile(outCsv "w")')
    L.append('unless(port error("cannot open %s for writing" outCsv))')
    L.append('fprintf(port "k,t_s,' + ",".join(c for c, _, _ in prb) + '\\n")')
    L.append(f"for(k 0 {n - 1}")
    L.append(f"  t = {T['T_STROBE']!r} + k * {T['T_REF']!r}")
    L.append('  fprintf(port "%d,%.15e" k t)')
    for i, (col, net, how) in enumerate(prb):
        if how == "v":
            L.append(f'  fprintf(port ",%.15e" value(w{i} t))')
        else:
            L.append(f"  x = cross(w{i} 0.5 k+1 'rising)")
            L.append('  if(x then fprintf(port ",%.15e" x) else fprintf(port ",nan"))')
    L.append('  fprintf(port "\\n")')
    L.append(")")
    L.append("close(port)")
    L.append('printf("wrote %s\\n" outCsv)')
    L.append("exit()")
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------------------
# Drivers
# ---------------------------------------------------------------------------
def _disp(path):
    """Path for messages: relative when under the cwd, absolute otherwise."""
    rel = os.path.relpath(path)
    return path if rel.startswith("..") else rel


def stim_path(build, vector, column):
    return os.path.join(build, "stim", f"{vector}__{column}.pwl")


def gen_code(build, vector, column, verify, sample_offset=None):
    cols = kc.load_vector_csv(vector)
    if column not in cols:
        raise SystemExit(f"column '{column}' not in {vector}.csv ({', '.join(cols)})")
    codes = cols[column]
    path = stim_path(build, vector, column)
    write_pwl(path, code_pwl_points(codes))
    msg = f"wrote {_disp(path)}  ({len(codes)} cycles, codes {min(codes)}..{max(codes)})"
    ok = True
    if verify:
        off = _offset_seconds(sample_offset) if sample_offset else T["T_STROBE"]
        errs, npts = verify_code_pwl(path, codes, off)
        ok = not errs
        msg += f"\n    verify: {npts} points, sampled at k*T_REF+{off*1e12:.1f} ps and " \
               f"+{T['T_STROBE']*1e12:.0f} ps -> " + ("OK" if ok else "FAIL: " + "; ".join(errs))
    print(msg)
    return ok


def gen_trigger(build, vector, f0, verify):
    times = kc.ilo_trigger_times(vector, f0)
    path = stim_path(build, vector, "inj_trigger")
    write_pwl(path, trigger_pwl_points(times))
    offs = [t - k * T["T_REF"] for k, t in enumerate(times)]
    msg = (f"wrote {_disp(path)}  ({len(times)} pulses, crossing offset "
           f"{min(offs)*1e12:.3f}..{max(offs)*1e12:.3f} ps after k*T_REF, f0={f0:g})")
    ok = True
    if verify:
        errs, npts = verify_trigger_pwl(path, times, f0, vector)
        ok = not errs
        msg += f"\n    verify: {npts} points -> " + ("OK" if ok else "FAIL: " + "; ".join(errs))
    print(msg)
    return ok


def gen_all(build, verify):
    ok = True
    for tb in kc.tb_names():
        _, d = kc.get_tb(tb)
        for st in d["stimuli"]:
            if st["kind"] == "code":
                ok &= gen_code(build, st["vector"], st["column"], verify, st["sampled_at"])
            else:
                ok &= gen_trigger(build, st["vector"], st["f0"], verify)
        path = os.path.join(build, "ocean", f"export_tb_{tb}.ocn")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(ocean_script(tb, build))
        print(f"wrote {_disp(path)}  ({len(kc.probes(tb))} columns)")
    for sub in ("raw", "results", "log"):
        os.makedirs(os.path.join(build, sub), exist_ok=True)
    return ok


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--all", action="store_true", help="all stimuli + Ocean scripts of the 4 testbenches")
    p.add_argument("--vector", help="committed vector name (test_vectors/csv/<name>.csv)")
    p.add_argument("--columns", nargs="+", default=[], help="code columns to convert")
    p.add_argument("--ilo-trigger", action="store_true", help="write the injection trigger PWL")
    p.add_argument("--f0", type=float, default=None, help="VCO frequency for --ilo-trigger [Hz] (default N*f_ref)")
    p.add_argument("--build", default=kc.DEFAULT_BUILD, help="output root (default: validation/build)")
    p.add_argument("--verify", action="store_true", help="re-read and check every written PWL")
    a = p.parse_args(argv)
    if a.all:
        ok = gen_all(a.build, a.verify)
    elif a.vector:
        ok = True
        for col in a.columns:
            ok &= gen_code(a.build, a.vector, col, a.verify)
        if a.ilo_trigger:
            cfg, _ = kc.load_vector_json(a.vector)
            f0 = a.f0 if a.f0 else cfg["n_div"] * cfg["f_ref_hz"]
            ok &= gen_trigger(a.build, a.vector, f0, a.verify)
        if not a.columns and not a.ilo_trigger:
            p.error("--vector needs --columns and/or --ilo-trigger")
    else:
        p.print_help()
        return 2
    if a.verify:
        print("stimulus verification:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
