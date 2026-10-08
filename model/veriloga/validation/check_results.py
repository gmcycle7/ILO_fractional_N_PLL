#!/usr/bin/env python3
"""Checker for the Spectre validation kit (REAL; runs with python3 >= 3.8).

Compares a Spectre result, exported to CSV by the generated Ocean script
(build/ocean/export_tb_<tb>.ocn), with the committed test vectors / golden
model, and exits nonzero on mismatch with a first-mismatch report.

    python3 check_results.py --tb fractional_phase_scheduler \\
            --result build/results/tb_fractional_phase_scheduler.csv
    python3 check_results.py --all [--results-dir build/results]
    python3 check_results.py --lint        # netlists vs manifest vs .va vs vectors
    python3 check_results.py --self-test   # proves the checker passes/fails correctly

Result CSV contract (what the Ocean script writes; see README.md):
    header  k,t_s,<col>,<col>,...      one row per reference cycle k = 0..511
    'v' columns     : V(net) sampled at t_s = k*T_REF + T_STROBE (200 ps)
    'cross' columns : time [s] of the (k+1)-th rising 0.5 V crossing of the net
    missing values  : 'nan'

Exit codes: 0 PASS, 1 mismatch (FAIL), 2 bad input (missing file/columns/rows).

Expected values:
  * fractional_phase_scheduler / reverse_injection_scheduler: the committed
    command CSV (integer codes, exact after rounding the voltage) and the
    committed JSON (s_ideal, u_INJ_digital floats).
  * dtc_nonideal_model: delay = t_cross(out) - t_cross(trig) - t_rise/2 vs
    u_INJ_analog[k] * T_vco, from the committed JSON (dtc_tap, dtc_ideal) or
    from the golden model re-run with the instance's impairment (dtc_gain,
    dtc_inl) -- needs numpy + model/python.
  * pulsed_injection_phase_model: golden model run_dynamics with noise off and
    epsilon_hw augmented by 2*pi*delta_f*(t_k - (k+1)*T_REF) (README) -- needs
    numpy + model/python.
"""

import argparse
import csv
import math
import os
import random
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kit_common as kc  # noqa: E402
import va_emulator as emu  # noqa: E402

T = kc.TIMING
TWO_PI = 2.0 * math.pi

DEFAULT_TOL = {
    "code": 0.25,       # |V/v_per_code - nearest integer| allowed [LSB]
    "float": 1e-6,      # s_ideal / x_frac / u_INJ_digital [V = cycles]
    "time_fs": 1.0,     # stimulus edge crossings (exact PWL/pulse ramps) [fs]
    "delay_fs": 10.0,   # DTC delay; canonical impairments are 97..222 fs [fs]
    "rad": 5e-4,        # ILO e_inj / dtheta / theta [rad] (~6.4 fs @ 12.52 GHz)
}

INJ_MAP_TO_MODEL = {0: "linear", 1: "sin", 2: "reset"}
Q_MODE_TO_QUANT = {0: "floor", 1: "nearest", 2: "ef1"}


# ---------------------------------------------------------------------------
# Check definition
# ---------------------------------------------------------------------------
class Check:
    """One compared quantity per reference cycle.

    kind: code | float | float01 | rad | time | delay
    columns: result columns read; derive(row) -> measured value (default:
    first column). expected: list per k. tol: absolute (seconds for
    time/delay, LSB for code)."""

    def __init__(self, name, kind, columns, expected, tol, source,
                 derive=None, skip=()):
        self.name, self.kind, self.columns = name, kind, list(columns)
        self.expected, self.tol, self.source = list(expected), tol, source
        self.derive = derive or (lambda row, c=self.columns[0]: row[c])
        self.skip = set(skip)

    def error(self, meas, exp):
        """(ok, err) for one sample."""
        if meas is None or math.isnan(meas):
            return False, float("inf")
        if self.kind == "code":
            c = meas / kc.V_PER_CODE
            r = math.floor(c + 0.5)
            return (abs(c - r) <= self.tol and r == exp), abs(c - exp)
        if self.kind == "float01":
            e = abs(kc.wrap_cycles(meas - exp))
        elif self.kind == "rad":
            e = abs(kc.wrap_radians(meas - exp))
        else:
            e = abs(meas - exp)
        return e <= self.tol, e


def _vec(name):
    return kc.load_vector_csv(name), kc.load_vector_json(name)


def _golden_rerun(vector, overrides):
    """Golden model (model/python) re-run of a committed vector's config."""
    if kc.REPO_ROOT not in sys.path:
        sys.path.insert(0, kc.REPO_ROOT)
    from model.python.config import SimConfig
    from model.python.simulate import simulate
    cfg_dict, _ = kc.load_vector_json(vector)
    cfg = SimConfig.from_dict(cfg_dict).replace(**overrides)
    return cfg, simulate(cfg)


def ilo_expected(ins):
    """Expected e_inj / dtheta / theta of one pulsed_injection_phase_model
    instance driven by the kit's trigger PWL. Continuous-time model vs the
    discrete map of MODEL_SPEC sec.14: with theta := 2*pi*theta_c +
    2*pi*delta_f*(k+1)*T_REF the .va recursion IS the golden recursion with
    epsilon_hw[k] -> epsilon_hw[k] + 2*pi*delta_f*(t_k - (k+1)*T_REF)."""
    if kc.REPO_ROOT not in sys.path:
        sys.path.insert(0, kc.REPO_ROOT)
    import numpy as np
    from model.python.config import SimConfig
    from model.python.injection_dynamics import run_dynamics
    cfg_dict, js = kc.load_vector_json(ins["vector"])
    cfg = SimConfig.from_dict(cfg_dict).replace(**ins["rerun"])
    p = ins["params"]
    times = kc.ilo_trigger_times(ins["vector"], p["f0"])
    n = T["N_CYC"]
    delta = [cfg.delta_f_hz * (times[k] - (k + 1) * cfg.t_ref_s) for k in range(n)]
    ezc = np.asarray(js["e_ZC_hw"][:n], dtype=np.float64) + np.asarray(delta)
    dyn = run_dynamics(cfg, ezc, {}, fired=None)
    th = [kc.wrap_radians(float(dyn["theta_plus"][k])
                          - TWO_PI * cfg.delta_f_hz * (k + 1) * cfg.t_ref_s)
          for k in range(n)]
    return ([float(x) for x in dyn["e_inj"]],
            [float(x) for x in dyn["delta_theta"]], th, js)


def build_checks(tb, tol):
    tb, d = kc.get_tb(tb)
    n = T["N_CYC"]
    tol_t = tol["time_fs"] * 1e-15
    checks = []
    if tb == "fractional_phase_scheduler":
        for ins in d["instances"]:
            i, v = ins["inst"], ins["vector"]
            vc, (_, js) = _vec(v)
            skip = {n - 1} if kc.SKIP_LAST_N_INT else set()
            checks.append(Check(f"{i}_n_int", "code", [f"{i}_n_int"], vc["n_int"][:n],
                                tol["code"], f"{v}.csv:n_int", skip=skip))
            for col, vcol in (("m_fb", "m_FB"), ("c_fb", "c_FB"), ("r_fb", "R_FB")):
                checks.append(Check(f"{i}_{col}", "code", [f"{i}_{col}"], vc[vcol][:n],
                                    tol["code"], f"{v}.csv:{vcol}"))
            s = js["s_ideal"][:n]
            checks.append(Check(f"{i}_s_ideal", "float", [f"{i}_s_ideal"], s,
                                tol["float"], f"{v}.json:s_ideal"))
            checks.append(Check(f"{i}_x_frac", "float01", [f"{i}_x_frac"],
                                [kc.wrap01(x) for x in s], tol["float"],
                                f"wrap01({v}.json:s_ideal)"))
    elif tb == "reverse_injection_scheduler":
        st = d["stimuli"][0]
        vc, _ = _vec(st["vector"])
        checks.append(Check("rfb_pwl", "code", ["rfb_pwl"], vc["R_FB"][:n], tol["code"],
                            f"{st['vector']}.csv:R_FB (stimulus)"))
        for ins in d["instances"]:
            i, v = ins["inst"], ins["vector"]
            vc, (_, js) = _vec(v)
            if ins["master"] == "fractional_phase_scheduler":
                checks.append(Check(f"{i}_r_fb", "code", [f"{i}_r_fb"], vc["R_FB"][:n],
                                    tol["code"], f"{v}.csv:R_FB"))
                continue
            for col, vcol in (("j", "j_INJ"), ("c", "c_INJ"), ("r", "R_INJ")):
                checks.append(Check(f"{i}_{col}", "code", [f"{i}_{col}"], vc[vcol][:n],
                                    tol["code"], f"{v}.csv:{vcol}"))
            checks.append(Check(f"{i}_u", "float01", [f"{i}_u"], js["u_INJ_digital"][:n],
                                tol["float"], f"{v}.json:u_INJ_digital"))
    elif tb == "dtc_nonideal_model":
        checks.append(Check("trig", "time", ["trig"],
                            [k * T["T_REF"] + T["T_ARM_DTC"] for k in range(n)],
                            tol_t, "pulse source timing (stimulus)"))
        for st in d["stimuli"]:
            vc, _ = _vec(st["vector"])
            checks.append(Check(st["net"], "code", [st["net"]], vc[st["column"]][:n],
                                tol["code"], f"{st['vector']}.csv:{st['column']} (stimulus)"))
        for ins in d["instances"]:
            i, v = ins["inst"], ins["vector"]
            vc, (_, js) = _vec(v)
            if ins["expect"] == "committed":
                u = js["u_INJ_analog"][:n]
                src = f"{v}.json:u_INJ_analog*T_vco"
            else:
                _, res = _golden_rerun(v, ins["rerun"])
                for col in ("j_INJ", "c_INJ"):
                    if [int(x) for x in res.data[col][:n]] != vc[col][:n]:
                        raise SystemExit(f"golden re-run of {v} changed {col}; "
                                         "stimulus no longer matches")
                u = [float(x) for x in res.data["u_INJ_analog"][:n]]
                src = f"golden({v}+{ins['rerun']}):u_INJ_analog*T_vco"
            tv = ins["tvco"]
            half = T["T_RISE_DTC"] / 2.0
            checks.append(Check(
                f"{i}_delay", "delay", [f"{i}_out", "trig"], [x * tv for x in u],
                tol["delay_fs"] * 1e-15, src,
                derive=lambda row, o=f"{i}_out", h=half: row[o] - row["trig"] - h))
    elif tb == "pulsed_injection_phase_model":
        st = d["stimuli"][0]
        times = kc.ilo_trigger_times(st["vector"], st["f0"])
        checks.append(Check("inj", "time", ["inj"], times[:n], tol_t,
                            "trigger PWL timing (stimulus)"))
        for ins in d["instances"]:
            i = ins["inst"]
            e, dth, th, _ = ilo_expected(ins)
            src = f"golden run_dynamics({ins['vector']}+{ins['rerun']}, eps+delta)"
            checks.append(Check(f"{i}_e", "rad", [f"{i}_e"], e, tol["rad"], src + ":e_inj"))
            checks.append(Check(f"{i}_dth", "rad", [f"{i}_dth"], dth, tol["rad"],
                                src + ":delta_theta"))
            checks.append(Check(f"{i}_th", "rad", [f"{i}_th"], th, tol["rad"],
                                src + ":theta_plus-2*pi*df*(k+1)*Tref"))
    return checks


# ---------------------------------------------------------------------------
# Result CSV I/O + comparison
# ---------------------------------------------------------------------------
class InputError(Exception):
    pass


def read_result_csv(path):
    if not os.path.isfile(path):
        raise InputError(f"result file not found: {path}")
    with open(path, newline="") as f:
        lines = [ln for ln in f if ln.strip() and not ln.lstrip().startswith("#")]
    rd = csv.reader(lines)
    header = [h.strip() for h in next(rd)]
    rows = []
    for rec in rd:
        row = {}
        for h, val in zip(header, rec):
            val = val.strip()
            try:
                row[h] = float(val)
            except ValueError:
                row[h] = float("nan")
        rows.append(row)
    return header, rows


def write_result_csv(path, header, rows):
    with open(path, "w") as f:
        f.write(",".join(header) + "\n")
        for r in rows:
            f.write(",".join("%d" % r[h] if h == "k" else "%.15e" % r[h]
                             for h in header) + "\n")


def _fmt(kind, x):
    if kind in ("time", "delay"):
        return f"{x * 1e15:.3f} fs"
    if kind == "code":
        return f"{x:.4g} LSB"
    return f"{x:.3e}"


def compare(tb, header, rows, tol, skip_first=0):
    """-> (status 0/1/2, report text, per-check stats)."""
    checks = build_checks(tb, tol)
    n = T["N_CYC"]
    need = {c for ch in checks for c in ch.columns} | {"k"}
    missing = sorted(need - set(header))
    if missing:
        return 2, f"  INPUT ERROR: result is missing columns: {', '.join(missing)}", []
    if len(rows) < n:
        return 2, (f"  INPUT ERROR: result has {len(rows)} rows, {n} required "
                   "(one per reference cycle)"), []
    by_k = {}
    for r in rows:
        if not math.isnan(r["k"]):
            by_k[int(r["k"])] = r
    if any(k not in by_k for k in range(n)):
        return 2, f"  INPUT ERROR: result rows do not cover k = 0..{n - 1}", []
    lines, first, n_samp, n_bad_total, failed, stats = [], None, 0, 0, 0, []
    lines.append(f"  {'check':<17}{'kind':<8}{'n':>4}{'bad':>5}  {'max|err|':>13}"
                 f"  {'mean err':>13}  tol / expected source")
    for ch in checks:
        bad, emax, esum, cnt, kbad = 0, 0.0, 0.0, 0, None
        for k in range(skip_first, n):
            if k in ch.skip:
                continue
            row = by_k[k]
            try:
                meas = ch.derive(row)
            except (KeyError, TypeError):
                meas = float("nan")
            exp = ch.expected[k]
            ok, err = ch.error(meas, exp)
            cnt += 1
            if math.isfinite(err):
                emax = max(emax, err)
                if ch.kind in ("time", "delay", "float", "rad"):
                    esum += (meas - exp) if ch.kind != "rad" else kc.wrap_radians(meas - exp)
            if not ok:
                bad += 1
                if kbad is None:
                    kbad = k
                    if first is None:
                        first = (k, ch, meas, exp, row.get("t_s", float("nan")))
        n_samp += cnt
        n_bad_total += bad
        stats.append({"name": ch.name, "kind": ch.kind, "n": cnt, "bad": bad,
                      "max_err": emax})
        failed += bad > 0
        mean = _fmt(ch.kind, esum / cnt) if ch.kind in ("time", "delay", "float", "rad") and cnt else "-"
        lines.append(f"  {ch.name:<17}{ch.kind:<8}{cnt:>4}{bad:>5}  {_fmt(ch.kind, emax):>13}"
                     f"  {mean:>13}  {_fmt(ch.kind, ch.tol)} / {ch.source}")
    if first:
        k, ch, meas, exp, ts = first
        if ch.kind == "code":
            mtxt = f"{meas!r} V (code {math.floor(meas / kc.V_PER_CODE + 0.5) if math.isfinite(meas) else 'n/a'})"
            etxt = f"{exp}"
        elif ch.kind in ("time", "delay"):
            mtxt, etxt = f"{meas * 1e12:.6f} ps", f"{exp * 1e12:.6f} ps"
        else:
            mtxt, etxt = f"{meas!r}", f"{exp!r}"
        lines.append(f"  FIRST MISMATCH: k={k} (t_s={ts:.6e} s) check={ch.name} "
                     f"columns={'/'.join(ch.columns)} measured={mtxt} expected={etxt} "
                     f"[{ch.source}]")
    status = 1 if n_bad_total else 0
    verdict = "PASS" if status == 0 else "FAIL"
    lines.append(f"  RESULT tb_{kc.get_tb(tb)[0]}: {verdict} ({len(checks)} checks, "
                 f"{n_samp} samples, {failed} failing checks, {n_bad_total} bad samples)")
    return status, "\n".join(lines), stats


def check_file(tb, path, tol, skip_first=0):
    """-> (status 0/1/2, report text, per-check stats)."""
    try:
        header, rows = read_result_csv(path)
        return compare(tb, header, rows, tol, skip_first)
    except InputError as exc:
        return 2, f"  INPUT ERROR: {exc}", []


# ---------------------------------------------------------------------------
# --lint: netlists vs manifest vs .va headers vs vector configs (static)
# ---------------------------------------------------------------------------
_NETLIST_TIMING = {"tref": "T_REF", "tedge": "T_EDGE", "tramp": "T_RAMP",
                   "tskew": "T_SKEW", "tarm": "T_ARM_DTC", "wdtc": "W_DTC",
                   "nref": "N_CYC", "tstop": "T_STOP"}


_PULSE_CROSSING = {"vref": T["T_EDGE"], "vref_rev": T["T_EDGE"] + T["T_SKEW"],
                   "vtrig": T["T_ARM_DTC"]}


def _close(a, b):
    """Relative 1e-12 (exact zero must match exactly)."""
    return a == b or abs(a - b) <= 1e-12 * max(abs(a), abs(b))


def lint():
    problems, notes = [], []
    va = {}
    for f in sorted(os.listdir(kc.VERILOGA_DIR)):
        if f.endswith(".va"):
            name, ports, pars = kc.parse_va_module(os.path.join(kc.VERILOGA_DIR, f))
            va[name] = (f, ports, pars)
    for tb in kc.tb_names():
        _, d = kc.get_tb(tb)
        path = os.path.join(HERE, d["netlist"])
        nl = kc.parse_netlist(path)
        pfx = d["netlist"]
        for pname, tkey in _NETLIST_TIMING.items():
            if pname in nl["parameters"] and not _close(nl["parameters"][pname], T[tkey]):
                problems.append(f"{pfx}: parameter {pname}={nl['parameters'][pname]!r} != "
                                f"TIMING[{tkey}]={T[tkey]!r}")
        incs = [os.path.basename(x) for x in nl["ahdl_include"]]
        if sorted(incs) != sorted(d["va"]):
            problems.append(f"{pfx}: ahdl_include {incs} != manifest {d['va']}")
        for x in nl["ahdl_include"]:
            if not os.path.isfile(os.path.normpath(os.path.join(HERE, x))):
                problems.append(f"{pfx}: ahdl_include target missing: {x}")
        env = dict(nl["parameters"])
        nets = set()
        for iname, inst in nl["instances"].items():
            nets.update(inst["nodes"])
            if inst["master"] == "vsource" and inst["params"].get("type") == "pwl":
                fn = inst["params"].get("file", "").strip('"')
                want = {f"build/stim/{s['vector']}__{s['column']}.pwl" for s in d["stimuli"]}
                if fn not in want:
                    problems.append(f"{pfx}: {iname} reads {fn}, not a generated stimulus")
        for iname, inst in nl["instances"].items():
            if inst["master"] == "vsource" and inst["params"].get("type") == "pulse":
                pp = {k: kc.eval_expr(v, env) for k, v in inst["params"].items()
                      if k in ("delay", "rise", "fall", "width", "period", "val0", "val1")}
                want_x = _PULSE_CROSSING.get(iname)
                if want_x is None:
                    problems.append(f"{pfx}: unexpected pulse source {iname}")
                    continue
                if not (_close(pp.get("delay", 0) + pp.get("rise", 0) / 2, want_x)
                        and _close(pp.get("rise", 0), T["T_RAMP"])
                        and _close(pp.get("period", 0), T["T_REF"])
                        and pp.get("val0") == 0.0 and pp.get("val1") == 1.0):
                    problems.append(f"{pfx}: pulse {iname} does not cross 0.5 V at "
                                    f"k*T_REF+{want_x!r} with T_RAMP edges")
                if iname == "vtrig" and not _close(pp.get("width", 0), T["W_DTC"]):
                    problems.append(f"{pfx}: vtrig width != W_DTC")
        tran = [ln for ln in nl["other"] if ln.split()[:2] == ["tran", "tran"]]
        if len(tran) != 1:
            problems.append(f"{pfx}: need exactly one 'tran tran stop=...' analysis")
        else:
            stop = kc.eval_expr(kc._split_params(tran[0])["stop"], env)
            if not _close(stop, T["T_STOP"]):
                problems.append(f"{pfx}: tran stop={stop!r} != T_STOP")
        manifest = {i["inst"]: i for i in d["instances"]}
        for iname, inst in nl["instances"].items():
            if inst["master"] in va and iname not in manifest:
                problems.append(f"{pfx}: instance {iname} ({inst['master']}) not in manifest")
        for iname, ins in manifest.items():
            inst = nl["instances"].get(iname)
            if inst is None:
                problems.append(f"{pfx}: manifest instance {iname} missing from netlist")
                continue
            if inst["master"] != ins["master"]:
                problems.append(f"{pfx}: {iname} master {inst['master']} != {ins['master']}")
                continue
            vfile, ports, vpars = va[ins["master"]]
            if ports != kc.PORTS[ins["master"]][0]:
                problems.append(f"{pfx}: {vfile} ports {ports} != kit_common.PORTS "
                                f"{kc.PORTS[ins['master']][0]} (update the kit)")
            want_nodes = kc.expected_nodes(tb, ins)
            if inst["nodes"] != want_nodes:
                problems.append(f"{pfx}: {iname} nodes {inst['nodes']} != expected "
                                f"{want_nodes} (port order of {vfile})")
            for pn in inst["params"]:
                if pn not in vpars:
                    problems.append(f"{pfx}: {iname} parameter '{pn}' not declared in {vfile}")
            for pn, want in ins["params"].items():
                if pn not in inst["params"]:
                    problems.append(f"{pfx}: {iname} missing parameter {pn}={want!r}")
                    continue
                got = kc.eval_expr(inst["params"][pn], env)
                if not _close(got, float(want)):
                    problems.append(f"{pfx}: {iname} {pn}={got!r} != manifest {want!r}")
        for col, net, _ in kc.probes(tb):
            if net not in nets:
                problems.append(f"{pfx}: probed net '{net}' does not exist in the netlist")
        problems += _vector_consistency(tb, d)
        notes.append(f"{pfx}: {len(manifest)} DUT instances, "
                     f"{len(kc.probes(tb))} probes, parameters {sorted(nl['parameters'])}")
    return problems, notes


def _vector_consistency(tb, d):
    """Manifest instance parameters vs the vector config they claim to match."""
    out = []
    for ins in d["instances"]:
        cfg, _ = kc.load_vector_json(ins["vector"])
        cfg = dict(cfg, **ins.get("rerun", {}))
        p, tag = ins["params"], f"{d['netlist']}:{ins['inst']}"
        if ins["master"] in ("fractional_phase_scheduler", "reverse_injection_scheduler"):
            if "alpha" in p and not _close(p["n_int_base"] + p["alpha"], cfg["n_div"]):
                out.append(f"{tag}: n_int_base+alpha != n_div {cfg['n_div']}")
            if "q_mode" in p and Q_MODE_TO_QUANT[p["q_mode"]] != cfg["quantizer"]:
                out.append(f"{tag}: q_mode {p['q_mode']} != quantizer {cfg['quantizer']}")
            if "lat_cycles" in p and p["lat_cycles"] != cfg["latency_cycles"]:
                out.append(f"{tag}: lat_cycles != latency_cycles {cfg['latency_cycles']}")
            if p.get("shared_mode") == 0 and p.get("look_ahead", 1) != int(cfg["lookahead"]):
                out.append(f"{tag}: look_ahead != lookahead {cfg['lookahead']}")
            if "b_dtc" in p and p["b_dtc"] != cfg["b_dtc"]:
                out.append(f"{tag}: b_dtc mismatch")
            if p.get("shared_mode") == 1 and cfg["arch_mode"] != "D":
                out.append(f"{tag}: shared_mode=1 but vector arch_mode {cfg['arch_mode']}")
        elif ins["master"] == "dtc_nonideal_model":
            tv = 1.0 / (cfg["n_div"] * cfg["f_ref_hz"])
            if not _close(tv, ins["tvco"]):
                out.append(f"{tag}: tvco != 1/(N f_ref)")
            if not _close(p["gain"], cfg["dtc_inj_gain"]):
                out.append(f"{tag}: gain != dtc_inj_gain {cfg['dtc_inj_gain']}")
            if not _close(p["lsb_s"], tv / 256.0) or cfg["dtc_mode"] != "normalized":
                out.append(f"{tag}: lsb_s != T_vco/256 (normalized mode)")
            if not _close(p.get("offset_s", 0.0), cfg["dtc_inj_offset_cycles"] * tv):
                out.append(f"{tag}: offset_s != dtc_inj_offset_cycles*T_vco")
            if not _close(p.get("inl_sin_amp_s", 0.0), cfg["inl_sin_amp_cycles"] * tv):
                out.append(f"{tag}: inl_sin_amp_s mismatch")
            p2, p3 = (list(cfg["inl_poly"]) + [0.0, 0.0])[:2]
            if not (_close(p.get("p2_s", 0.0), p2 * tv) and _close(p.get("p3_s", 0.0), p3 * tv)):
                out.append(f"{tag}: p2_s/p3_s mismatch")
            for j in range(8):
                want = (j / 8.0 + cfg["tap_mismatch_cycles"][j]) * tv
                if abs(p[f"tap{j}"] - want) > 1e-24:
                    out.append(f"{tag}: tap{j}={p[f'tap{j}']!r} != (j/8+mismatch)*T_vco={want!r}")
            if cfg["route_inj_cycles"] != 0.0 or cfg.get("inl_lut") or cfg["dnl_sigma_lsb"]:
                out.append(f"{tag}: vector uses route/LUT/DNL terms the .va does not model")
        elif ins["master"] == "pulsed_injection_phase_model":
            if not _close(p["f0"], cfg["n_div"] * cfg["f_ref_hz"]):
                out.append(f"{tag}: f0 != N*f_ref")
            if not _close(p["delta_f"], cfg["delta_f_hz"]) or not _close(p["k_inj"], cfg["k_inj"]):
                out.append(f"{tag}: delta_f/k_inj mismatch")
            if INJ_MAP_TO_MODEL[p["inj_map"]] != cfg["inj_model"]:
                out.append(f"{tag}: inj_map {p['inj_map']} != inj_model {cfg['inj_model']}")
            if not _close(p["z0"], cfg["z0_cycles"]):
                out.append(f"{tag}: z0 mismatch")
            if cfg["sigma_vco_w_rad"] or cfg["sigma_vco_rw_rad"] or cfg["sigma_ref_s"] or cfg["sigma_pulse_s"]:
                out.append(f"{tag}: expected values must be noise-free (rerun sigma=0)")
    return out


# ---------------------------------------------------------------------------
# --self-test: fabricate Spectre-like exports from the .va emulator
# ---------------------------------------------------------------------------
def fabricate(tb, corrupt=None, noise=True, seed=20261005):
    """Rows a CORRECT Spectre run + Ocean export should produce, built from
    va_emulator (event math of the .va files at the bench's event times).
    corrupt names one realistic failure to inject (see CORRUPTIONS)."""
    tb, d = kc.get_tb(tb)
    n = T["N_CYC"]
    rng = random.Random(seed)
    cols = {}

    def put(col, vals, kind):
        if noise:
            amp = {"code": 0.02, "float": 1e-9, "time": 0.3e-15, "rad": 2e-6}[kind]
            vals = [x + rng.uniform(-amp, amp) for x in vals]
        cols[col] = list(vals)

    inst = {i["inst"]: i for i in d["instances"]}
    if tb == "fractional_phase_scheduler":
        for i, ins in inst.items():
            o = emu.fractional_phase_scheduler(n, **ins["params"])
            for key in ("n_int", "m_fb", "c_fb", "s_ideal", "x_frac", "r_fb"):
                vals = o[key][:n]
                if corrupt == "one_cycle_skew" and i == "fps_b":
                    vals = [o["init"][key]] + vals[:-1]   # sampled one edge late
                if corrupt == "lsb_glitch" and i == "fps_a" and key == "c_fb":
                    vals = list(vals)
                    vals[137] += 1.0
                put(f"{i}_{key}", vals, "code" if key not in ("s_ideal", "x_frac") else "float")
    elif tb == "reverse_injection_scheduler":
        rfb = [float(x) for x in kc.load_vector_csv(d["stimuli"][0]["vector"])["R_FB"][:n]]
        put("rfb_pwl", rfb, "code")
        fo = emu.fractional_phase_scheduler(n, **inst["fps"]["params"])
        put("fps_r_fb", fo["r_fb"], "code")
        for i, ins in inst.items():
            if ins["master"] != "reverse_injection_scheduler":
                continue
            p = dict(ins["params"])
            if ins["r_fb_net"] == "rfb_pwl":
                src = rfb
            elif ins["r_fb_net"] == "fps_r_fb":
                src = fo["r_fb"][:n]
                if corrupt == "same_edge_race" and i == "rev_chain":
                    src = [fo["init"]["r_fb"]] + src[:-1]   # sampled before update
            else:
                src = [0.0] * n
            if corrupt == "ef1_unseeded" and i == "rev_b":
                p["e_q_init"] = 0.0
            o = emu.reverse_injection_scheduler(src, **p)
            for key in ("j", "c", "r"):
                put(f"{i}_{key}", o[key], "code")
            put(f"{i}_u", o["u"], "float")
    elif tb == "dtc_nonideal_model":
        trig = [k * T["T_REF"] + T["T_ARM_DTC"] for k in range(n)]
        stim = {}
        for st in d["stimuli"]:
            stim[st["net"]] = [float(x) for x in kc.load_vector_csv(st["vector"])[st["column"]][:n]]
            put(st["net"], stim[st["net"]], "code")
        for i, ins in inst.items():
            p = dict(ins["params"])
            if corrupt == "gain_missing" and i == "dtc_gain":
                p["gain"] = 1.0
            if corrupt == "nominal_taps_missing" and i == "dtc_tap":
                for j in range(8):
                    p[f"tap{j}"] -= j * ins["tvco"] / 8.0
            out = [trig[k] + emu.dtc_delay(stim[ins["code_net"]][k], stim[ins["tap_net"]][k], **p)
                   + T["T_RISE_DTC"] / 2.0 for k in range(n)]
            put(f"{i}_out", out, "time")
        put("trig", trig, "time")
    elif tb == "pulsed_injection_phase_model":
        st = d["stimuli"][0]
        times = kc.ilo_trigger_times(st["vector"], st["f0"])[:n]
        put("inj", times, "time")
        for i, ins in inst.items():
            p = dict(ins["params"])
            if corrupt == "k_inj_0p2" and i == "ilo_sin":
                p["k_inj"] = 0.2
            o = emu.pulsed_injection_phase_model(times, **p)
            if corrupt == "kick_glitch" and i == "ilo_rst":
                o["e"][300] += 0.01
            for key in ("e", "dth", "th"):
                put(f"{i}_{key}", o[key], "rad")
    header = ["k", "t_s"] + [c for c, _, _ in kc.probes(tb)]
    rows = []
    for k in range(n):
        r = {"k": k, "t_s": kc.strobe_time(k)}
        for c in header[2:]:
            r[c] = cols[c][k]
        rows.append(r)
    return header, rows


CORRUPTIONS = {
    "fractional_phase_scheduler": [
        ("lsb_glitch", "fps_a c_FB +1 LSB at k=137"),
        ("one_cycle_skew", "fps_b outputs sampled one edge late"),
    ],
    "reverse_injection_scheduler": [
        ("same_edge_race", "rev_chain samples R_FB before the scheduler updated it"),
        ("ef1_unseeded", "rev_b with e_q_init = 0 (golden seeds it from 'dsm_inj')"),
    ],
    "dtc_nonideal_model": [
        ("gain_missing", "dtc_gain built with gain 1.0 instead of 1.01"),
        ("nominal_taps_missing", "dtc_tap taps carry mismatch only (hookup rule 3 violated)"),
    ],
    "pulsed_injection_phase_model": [
        ("k_inj_0p2", "ilo_sin with K_inj 0.2 instead of 0.3"),
        ("kick_glitch", "ilo_rst e_inj +0.01 rad at k=300"),
    ],
}


def self_test(tol, verbose=False):
    ok_all = True
    print("SELF-TEST check_results.py (fabricated exports from va_emulator.py; no simulator involved)")
    probs, _ = lint()
    print(f"[lint] netlists vs manifest vs .va ports/params vs vector configs: "
          f"{'PASS' if not probs else 'FAIL'}")
    for pmsg in probs:
        print("   ", pmsg)
    ok_all &= not probs
    with tempfile.TemporaryDirectory() as tmp:
        for tb in kc.tb_names():
            print(f"[{tb}]")
            cases = [("emulator_exact", None, False, 0),
                     ("matching+noise", None, True, 0)]
            cases += [(f"corrupt:{name}", name, True, 1) for name, _ in CORRUPTIONS[tb]]
            for label, corrupt, noise, want in cases:
                header, rows = fabricate(tb, corrupt=corrupt, noise=noise)
                path = os.path.join(tmp, f"{tb}_{label.replace(':', '_')}.csv")
                write_result_csv(path, header, rows)
                status, report, stats = check_file(tb, path, tol)
                good = status == want
                ok_all &= good
                verdict = "PASS" if status == 0 else ("FAIL" if status == 1 else "ERROR")
                exp_txt = "PASS" if want == 0 else "FAIL"
                line = f"  {label:<30} checker={verdict:<5} expected={exp_txt:<5} -> {'ok' if good else 'WRONG'}"
                if corrupt:
                    desc = dict(CORRUPTIONS[tb])[corrupt]
                    fm = [ln.strip() for ln in report.splitlines() if "FIRST MISMATCH" in ln]
                    line += f"\n      ({desc})\n      {fm[0] if fm else '(no mismatch reported)'}"
                elif label == "emulator_exact":
                    line += "\n      max|err| by kind: " + _worst_errors(stats)
                print(line)
                if verbose or not good:
                    print(report)
        # malformed input must be rejected with exit status 2
        header, rows = fabricate("dtc_nonideal_model")
        path = os.path.join(tmp, "short.csv")
        write_result_csv(path, header[:-1], rows[:100])
        status, _, _ = check_file("dtc_nonideal_model", path, tol)
        good = status == 2
        ok_all &= good
        print(f"[input] truncated CSV (100 rows, one column dropped): status {status} "
              f"(expected 2) -> {'ok' if good else 'WRONG'}")
    print("SELF-TEST", "PASS" if ok_all else "FAIL")
    return ok_all


def _worst_errors(stats):
    worst = {}
    for st in stats:
        worst[st["kind"]] = max(worst.get(st["kind"], 0.0), st["max_err"])
    return "; ".join(f"{k} {_fmt(k, v)}" for k, v in worst.items())


# ---------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description="Spectre validation-kit result checker")
    ap.add_argument("--tb", help="testbench (e.g. fractional_phase_scheduler)")
    ap.add_argument("--result", help="exported result CSV")
    ap.add_argument("--all", action="store_true", help="check all four results")
    ap.add_argument("--results-dir", default=os.path.join(kc.DEFAULT_BUILD, "results"))
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--lint", action="store_true")
    ap.add_argument("--skip-first", type=int, default=0, help="ignore rows k < N (diagnostics)")
    ap.add_argument("--verbose", action="store_true")
    for key, val in DEFAULT_TOL.items():
        ap.add_argument(f"--tol-{key.replace('_', '-')}", type=float, default=val,
                        dest=f"tol_{key}", help=f"default {val}")
    a = ap.parse_args(argv)
    tol = {key: getattr(a, f"tol_{key}") for key in DEFAULT_TOL}
    if a.self_test:
        return 0 if self_test(tol, a.verbose) else 1
    if a.lint:
        probs, notes = lint()
        for nt in notes:
            print("  " + nt)
        for pmsg in probs:
            print("  PROBLEM: " + pmsg)
        print("LINT", "PASS" if not probs else "FAIL")
        return 0 if not probs else 1
    jobs = []
    if a.all:
        jobs = [(tb, os.path.join(a.results_dir, f"tb_{tb}.csv")) for tb in kc.tb_names()]
    elif a.tb and a.result:
        jobs = [(a.tb, a.result)]
    else:
        ap.print_help()
        return 2
    worst = 0
    for tb, path in jobs:
        print(f"tb_{kc.get_tb(tb)[0]}: {path}")
        status, report, _ = check_file(tb, path, tol, a.skip_first)
        print(report)
        worst = max(worst, status)
    return worst


if __name__ == "__main__":
    sys.exit(main())
