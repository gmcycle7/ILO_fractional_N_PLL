#!/usr/bin/env python3
"""Bit-exact check of rtl/frac_phase_scheduler.sv against the Python golden model.

    python3 rtl/run_sim.py                 # build once, run every vector case
    python3 rtl/run_sim.py --no-synth      # skip the synthesizability pass
    python3 rtl/run_sim.py -k ef1          # only cases whose name contains "ef1"

Flow (pip-only toolchain, no iverilog / verilator needed):

    yosys  read_verilog -sv  ->  write_cxxrtl simtop.cc
    $CXX   tb/tb_main.cc + simtop.cc + CXXRTL runtime headers  ->  sim
    sim    one run per case in rtl/vectors/manifest.json
    compare every output of every reference cycle against the golden CSV

plus `synth -flatten; stat` on the bare scheduler (LAT = 0, 1, 3) to prove
synthesizability; the cell counts are written to rtl/synth_stat.txt.

Toolchain discovery
    yosys : $YOSYS (command line), else the `yowasp_yosys` Python package
            (pip install yowasp-yosys), else `yowasp-yosys` / `yosys` on PATH.
    CXXRTL runtime headers : $CXXRTL_INCLUDE, else
            <yowasp_yosys package>/share/include/backends/cxxrtl/runtime, else
            `yosys-config --datdir`/include/backends/cxxrtl/runtime.
    C++   : $CXX, else c++, g++, clang++ (C++14).

Exit status: 0 all cases bit-exact, 1 any mismatch / stale build product,
2 toolchain missing or build failure.
"""

import argparse
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import time

RTL_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_VECTORS = os.path.join(RTL_DIR, "vectors")
DEFAULT_BUILD = os.path.join(RTL_DIR, "build")
DEFAULT_SYNTH_OUT = os.path.join(RTL_DIR, "synth_stat.txt")

RTL_SOURCES = ["fps_quantizer.sv", "fps_decode.sv", "frac_phase_scheduler.sv"]
TB_SOURCE = os.path.join("tb", "tb_main.cc")
TOP = "frac_phase_scheduler"

IW = 4            # scheduler defaults used by the simulation wrapper
SEQW = 16
SYNTH_LATS = (0, 1, 3)
SYNTH_F = 24

SIGNALS = ["n_int", "m_fb", "c_fb", "r_fb", "r_inj", "j_inj", "c_inj", "seq_id"]
_CXXRTL_SUBDIR = os.path.join("include", "backends", "cxxrtl", "runtime")
_YOWASP_SNIPPET = ("import sys, yowasp_yosys; "
                   "sys.exit(yowasp_yosys.run_yosys(sys.argv[1:]))")


class ToolchainError(RuntimeError):
    """Required tool missing or a build step failed."""


# --------------------------------------------------------------------------
# toolchain discovery
# --------------------------------------------------------------------------

def _has_cxxrtl(path):
    return bool(path) and os.path.isfile(os.path.join(path, "cxxrtl", "cxxrtl.h"))


def _yowasp_share_dir():
    """share/ directory of an importable yowasp_yosys package, or None."""
    try:
        import importlib.util
        spec = importlib.util.find_spec("yowasp_yosys")
    except (ImportError, ValueError):
        return None
    if spec is None or not spec.submodule_search_locations:
        return None
    return os.path.join(list(spec.submodule_search_locations)[0], "share")


def find_yosys():
    """Return (argv_prefix, description, cxxrtl_include_dir or None)."""
    env = os.environ.get("YOSYS")
    candidates = []
    if env:
        argv = shlex.split(env)
        if not argv or not shutil.which(argv[0]):
            raise ToolchainError(f"$YOSYS={env!r} is not an executable")
        candidates.append((argv, "$YOSYS"))
    share = _yowasp_share_dir()
    if share is not None:
        candidates.append(([sys.executable, "-c", _YOWASP_SNIPPET],
                           "yowasp_yosys (python package)"))
    for exe in ("yowasp-yosys", "yosys"):
        path = shutil.which(exe)
        if path:
            candidates.append(([path], exe))
    if not candidates:
        raise ToolchainError(
            "yosys not found: pip install yowasp-yosys (or put yosys on PATH, "
            "or set $YOSYS)")
    argv, desc = candidates[0]

    include = os.environ.get("CXXRTL_INCLUDE")
    if not _has_cxxrtl(include):
        include = None
        tries = []
        if share is not None:
            tries.append(os.path.join(share, _CXXRTL_SUBDIR))
        cfg = shutil.which("yosys-config")
        if cfg:
            try:
                datdir = subprocess.run([cfg, "--datdir"], capture_output=True,
                                        text=True, check=True).stdout.strip()
                tries.append(os.path.join(datdir, _CXXRTL_SUBDIR))
            except (OSError, subprocess.CalledProcessError):
                pass
        for t in tries:
            if _has_cxxrtl(t):
                include = t
                break
    return argv, desc, include


def find_cxx():
    """Return the C++ compiler argv prefix ($CXX, c++, g++, clang++)."""
    env = os.environ.get("CXX")
    if env:
        argv = shlex.split(env)
        if not argv or not shutil.which(argv[0]):
            raise ToolchainError(f"$CXX={env!r} is not an executable")
        return argv
    for exe in ("c++", "g++", "clang++"):
        path = shutil.which(exe)
        if path:
            return [path]
    raise ToolchainError("no C++ compiler found (set $CXX or install c++/g++)")


def find_toolchain():
    """Return dict(yosys, yosys_desc, cxxrtl_include, cxx); raises
    ToolchainError when something is missing."""
    yosys, desc, include = find_yosys()
    if include is None:
        raise ToolchainError(
            "CXXRTL runtime headers not found (expected <yowasp_yosys>/share/"
            + _CXXRTL_SUBDIR.replace(os.sep, "/") + "; set $CXXRTL_INCLUDE)")
    return {"yosys": yosys, "yosys_desc": desc, "cxxrtl_include": include,
            "cxx": find_cxx()}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _run(argv, cwd, what, timeout=600):
    """Run a build step; raise ToolchainError with its output on failure."""
    try:
        proc = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                              timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ToolchainError(f"{what} could not run: {exc}") from exc
    if proc.returncode != 0:
        tail = (proc.stdout + proc.stderr).strip().splitlines()[-25:]
        raise ToolchainError(f"{what} failed (exit {proc.returncode}):\n  "
                             + "\n  ".join(tail))
    return proc.stdout


def _rel(path, start):
    """Relative POSIX path (the WASM yosys sandbox resolves relative paths
    through its cwd / parent preopens; absolute /tmp paths are remapped)."""
    return os.path.relpath(path, start).replace(os.sep, "/")


def _yosys_version(tc, cwd):
    out = _run(tc["yosys"] + ["-V"], cwd, "yosys -V")
    return out.strip().splitlines()[-1].strip()


class _BuildLock:
    """Advisory lock so concurrent runs do not build into the same directory."""

    def __init__(self, build_dir):
        self._path = os.path.join(build_dir, ".lock")
        self._fh = None

    def __enter__(self):
        try:
            import fcntl
        except ImportError:          # non-POSIX: no locking
            return self
        self._fh = open(self._path, "w")
        fcntl.flock(self._fh, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        if self._fh is not None:
            self._fh.close()         # releases the lock
        return False


# --------------------------------------------------------------------------
# simulation build: yosys -> CXXRTL C++ -> native binary
# --------------------------------------------------------------------------

def variants_of(cases):
    """Sorted distinct (F, LAT) pairs; the index is the wrapper's `sel`."""
    return sorted({(c["F"], c["lat"]) for c in cases})


def wrapper_sv(variants):
    """SystemVerilog source of `simtop`: one scheduler per (F, LAT) variant on
    shared inputs, outputs selected by `sel`."""
    ow = 1 + IW + 2 + 6 + 8 + 8 + 3 + 6 + SEQW
    lines = [
        "// generated by rtl/run_sim.py -- simulation wrapper, do not edit",
        "module simtop (",
        "    input  logic        clk,",
        "    input  logic        rst,",
        "    input  logic        en,",
        "    input  logic [7:0]  sel,",
        "    input  logic [63:0] fcw,",
        "    input  logic [1:0]  qmode,",
        "    input  logic [7:0]  rzero,",
        "    output logic        valid,",
        f"    output logic [{IW - 1}:0]  nint,",
        "    output logic [1:0]  mfb,",
        "    output logic [5:0]  cfb,",
        "    output logic [7:0]  rfb,",
        "    output logic [7:0]  rinj,",
        "    output logic [2:0]  jinj,",
        "    output logic [5:0]  cinj,",
        f"    output logic [{SEQW - 1}:0] seqid",
        ");",
        f"    logic [{ow - 1}:0] obus;",
    ]
    for i, (f_bits, lat) in enumerate(variants):
        w = IW + 8 + f_bits
        lines += [
            f"    logic [{ow - 1}:0] o{i};",
            f"    frac_phase_scheduler #(.F({f_bits}), .IW({IW}), .LAT({lat}), "
            f".SEQW({SEQW})) u{i} (",
            "        .clk(clk), .rst(rst), .en(en),",
            f"        .fcw(fcw[{w - 1}:0]), .q_mode(qmode), .r_zero(rzero),",
            f"        .valid(o{i}[{ow - 1}]), .n_int(o{i}[{ow - 2}:{ow - 1 - IW}]),",
            f"        .m_fb(o{i}[{SEQW + 32}:{SEQW + 31}]), "
            f".c_fb(o{i}[{SEQW + 30}:{SEQW + 25}]),",
            f"        .r_fb(o{i}[{SEQW + 24}:{SEQW + 17}]), "
            f".r_inj(o{i}[{SEQW + 16}:{SEQW + 9}]),",
            f"        .j_inj(o{i}[{SEQW + 8}:{SEQW + 6}]), "
            f".c_inj(o{i}[{SEQW + 5}:{SEQW}]),",
            f"        .seq_id(o{i}[{SEQW - 1}:0])",
            "    );",
        ]
    lines.append("    always_comb begin")
    lines.append("        case (sel)")
    for i in range(len(variants)):
        lines.append(f"            8'd{i}: obus = o{i};")
    lines.append("            default: obus = '0;")
    lines.append("        endcase")
    lines.append("    end")
    lines.append("    assign {valid, nint, mfb, cfb, rfb, rinj, jinj, cinj, seqid} = obus;")
    lines.append("endmodule")
    return "\n".join(lines) + "\n"


def _source_hash(tc, version, wrapper):
    h = hashlib.sha256()
    for name in RTL_SOURCES + [TB_SOURCE]:
        with open(os.path.join(RTL_DIR, name), "rb") as f:
            h.update(name.encode() + b"\0" + f.read() + b"\0")
    h.update(wrapper.encode())
    h.update(version.encode())
    h.update(" ".join(tc["cxx"]).encode())
    return h.hexdigest()


def build_sim(tc, build_dir, variants, rebuild=False, log=print):
    """Build the CXXRTL simulation binary (cached by a source hash)."""
    os.makedirs(build_dir, exist_ok=True)
    exe = os.path.join(build_dir, "sim.exe" if os.name == "nt" else "sim")
    stamp_path = os.path.join(build_dir, "sim.stamp")
    with _BuildLock(build_dir):
        version = _yosys_version(tc, build_dir)
        wrapper = wrapper_sv(variants)
        stamp = _source_hash(tc, version, wrapper)
        if not rebuild and os.path.isfile(exe) and os.path.isfile(stamp_path):
            with open(stamp_path) as f:
                if f.read().strip() == stamp:
                    log(f"[build] up to date ({_rel(exe, os.getcwd())})")
                    return exe, version
        if os.path.exists(stamp_path):
            os.remove(stamp_path)

        with open(os.path.join(build_dir, "simtop.sv"), "w") as f:
            f.write(wrapper)
        srcs = [_rel(os.path.join(RTL_DIR, s), build_dir) for s in RTL_SOURCES]
        script = (f"read_verilog -sv {' '.join(srcs)} simtop.sv; "
                  "hierarchy -check -top simtop; "
                  "write_cxxrtl simtop.cc")
        t0 = time.time()
        _run(tc["yosys"] + ["-q", "-l", "yosys_cxxrtl.log", "-p", script],
             build_dir, "yosys write_cxxrtl")
        t1 = time.time()
        _run(tc["cxx"] + ["-std=c++14", "-O1", "-I", tc["cxxrtl_include"],
                          "-I", build_dir,
                          os.path.join(RTL_DIR, TB_SOURCE), "-o", exe],
             build_dir, "C++ compile")
        t2 = time.time()
        with open(stamp_path, "w") as f:
            f.write(stamp + "\n")
        log(f"[build] yosys write_cxxrtl {t1 - t0:.1f} s, "
            f"C++ compile {t2 - t1:.1f} s ({len(variants)} variants)")
    return exe, version


# --------------------------------------------------------------------------
# per-case run + compare
# --------------------------------------------------------------------------

def load_manifest(vec_dir):
    with open(os.path.join(vec_dir, "manifest.json")) as f:
        return json.load(f)


def load_golden(path, columns):
    with open(path) as f:
        lines = f.read().split("\n")
    if lines[0].split(",") != columns:
        raise ValueError(f"{path}: unexpected header {lines[0]!r}")
    return [tuple(int(v) for v in ln.split(",")) for ln in lines[1:] if ln]


def run_case(exe, case, sel, vec_dir, columns):
    """Simulate one case.  Returns (ok, message, cycles_compared)."""
    golden = load_golden(os.path.join(vec_dir, case["file"]), columns)
    n = case["n_cycles"]
    lat = case["lat"]
    if len(golden) != n:
        return False, f"golden vector has {len(golden)} rows, expected {n}", 0
    col = {name: i for i, name in enumerate(columns)}

    proc = subprocess.run(
        [exe, str(sel), str(case["fcw"]), str(case["q_mode"]),
         str(case["r_zero"]), str(n)],
        capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        return False, f"simulator exit {proc.returncode}: {proc.stderr.strip()}", 0

    passes = {0: [], 1: []}
    for ln in proc.stdout.split("\n")[1:]:
        if not ln:
            continue
        if ln.startswith("!unstable"):
            _, k, idle = ln.split(",")
            return (False, f"pass 1 cycle {k}: outputs changed on idle clock "
                           f"{idle} (en = 0)", 0)
        vals = [int(v) for v in ln.split(",")]
        passes[vals[0]].append(vals[1:])   # k, valid, n_int ... seq_id

    compared = 0
    for p in (0, 1):
        rows = passes[p]
        if len(rows) != n:
            return False, f"pass {p}: simulator produced {len(rows)} rows, expected {n}", compared
        for k, row in enumerate(rows):
            if row[0] != k:
                return False, f"pass {p}: row index {row[0]} != {k}", compared
            got_valid, got = row[1], row[2:]
            if k < lat:
                # pipeline still filling: valid low, command outputs zero
                if got_valid != 0:
                    return (False, f"pass {p} cycle {k} signal valid: got 1 "
                                   f"expected 0 (k < LAT)", compared)
                for name, g in zip(SIGNALS, got):
                    if g != 0:
                        return (False, f"pass {p} cycle {k} signal {name}: got {g} "
                                       f"expected 0 (k < LAT)", compared)
                continue
            if got_valid != 1:
                return (False, f"pass {p} cycle {k} signal valid: got {got_valid} "
                               f"expected 1", compared)
            exp = golden[k]
            if exp[col["k"]] != k:
                return False, f"golden row {k} has k = {exp[col['k']]}", compared
            for name, g in zip(SIGNALS, got):
                e = exp[col[name]]
                if g != e:
                    return (False, f"pass {p} cycle {k} signal {name}: got {g} "
                                   f"expected {e}", compared)
            compared += 1
    return True, "", compared


# --------------------------------------------------------------------------
# synthesizability pass
# --------------------------------------------------------------------------

_FLOP_PREFIXES = ("$_DFF", "$_SDFF", "$_ADFF", "$_ALDFF", "$_DFFSR", "$dff",
                  "$sdff", "$adff")
_LATCH_PREFIXES = ("$_DLATCH", "$dlatch", "$_SR_", "$sr")


def run_synth(tc, build_dir, out_path, version, log=print):
    """`synth -flatten; stat` for the bare scheduler; writes out_path and
    returns {lat: {"cells", "flops", "comb", "by_type"}}."""
    os.makedirs(build_dir, exist_ok=True)
    srcs = " ".join(_rel(os.path.join(RTL_DIR, s), build_dir) for s in RTL_SOURCES)
    steps = []
    for lat in SYNTH_LATS:
        steps += [
            "design -reset",
            f"read_verilog -sv {srcs}",
            f"hierarchy -check -top {TOP} -chparam F {SYNTH_F} -chparam LAT {lat}",
            f"synth -flatten -top {TOP}",
            "check -assert",
            f"tee -q -o synth_lat{lat}.json stat -json -top {TOP}",
        ]
    t0 = time.time()
    with _BuildLock(build_dir):
        _run(tc["yosys"] + ["-q", "-l", "yosys_synth.log", "-p", "; ".join(steps)],
             build_dir, "yosys synth")
        result = {}
        for lat in SYNTH_LATS:
            with open(os.path.join(build_dir, f"synth_lat{lat}.json")) as f:
                stat = json.load(f)
            design = stat.get("design") or stat["modules"]["\\" + TOP]
            by_type = {t: n for t, n in design["num_cells_by_type"].items()
                       if t != "$scopeinfo"}      # bookkeeping, not logic
            flops = sum(n for t, n in by_type.items() if t.startswith(_FLOP_PREFIXES))
            latches = sum(n for t, n in by_type.items() if t.startswith(_LATCH_PREFIXES))
            if latches:
                raise ToolchainError(f"synth LAT={lat}: {latches} latch cell(s) inferred")
            cells = sum(by_type.values())
            result[lat] = {"cells": cells, "flops": flops, "comb": cells - flops,
                           "by_type": by_type}

    types = sorted({t for r in result.values() for t in r["by_type"]})
    out = [
        "# rtl/synth_stat.txt -- generated by rtl/run_sim.py, do not edit",
        "# flow    : read_verilog -sv; hierarchy -check; synth -flatten; check -assert; stat",
        "#           (yosys generic gate library; technology independent, no timing)",
        f"# yosys   : {version}",
        f"# module  : {TOP}  F={SYNTH_F} IW={IW} SEQW={SEQW}",
        "#",
        "config".ljust(14) + "".join(f"LAT={lat}".rjust(9) for lat in SYNTH_LATS),
        "cells_total".ljust(14) + "".join(str(result[lat]["cells"]).rjust(9) for lat in SYNTH_LATS),
        "flip_flops".ljust(14) + "".join(str(result[lat]["flops"]).rjust(9) for lat in SYNTH_LATS),
        "combinational".ljust(14) + "".join(str(result[lat]["comb"]).rjust(9) for lat in SYNTH_LATS),
        "latches".ljust(14) + "".join("0".rjust(9) for _ in SYNTH_LATS),
        "#",
        "# cells by type",
    ]
    for t in types:
        out.append(t.ljust(14) + "".join(
            str(result[lat]["by_type"].get(t, 0)).rjust(9) for lat in SYNTH_LATS))
    with open(out_path, "w", newline="\n") as f:
        f.write("\n".join(out) + "\n")
    log(f"[synth] {time.time() - t0:.1f} s -> {_rel(out_path, os.getcwd())}: "
        + ", ".join(f"LAT={lat} {result[lat]['cells']} cells "
                    f"({result[lat]['flops']} FF)" for lat in SYNTH_LATS))
    return result


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--vectors", default=DEFAULT_VECTORS,
                    help="golden vector directory (manifest.json + *.csv)")
    ap.add_argument("--build", default=DEFAULT_BUILD, help="build directory")
    ap.add_argument("--synth-out", default=DEFAULT_SYNTH_OUT,
                    help="where to write the synthesis cell-count report")
    ap.add_argument("--no-synth", action="store_true",
                    help="skip the synthesizability pass")
    ap.add_argument("--rebuild", action="store_true",
                    help="ignore the cached simulation binary")
    ap.add_argument("-k", dest="filter", default=None,
                    help="only run cases whose name contains this substring")
    args = ap.parse_args(argv)

    t_start = time.time()
    manifest = load_manifest(args.vectors)
    columns = manifest["columns"]
    all_cases = manifest["cases"]
    variants = variants_of(all_cases)
    cases = [c for c in all_cases if not args.filter or args.filter in c["name"]]
    if not cases:
        print("no cases selected")
        return 1

    try:
        tc = find_toolchain()
        print(f"[tools] yosys: {tc['yosys_desc']}; c++: {' '.join(tc['cxx'])}")
        exe, version = build_sim(tc, args.build, variants, rebuild=args.rebuild)
        print(f"[tools] {version}")
    except ToolchainError as exc:
        print(f"TOOLCHAIN ERROR: {exc}")
        return 2

    n_fail = 0
    total_cycles = 0
    for case in cases:
        sel = variants.index((case["F"], case["lat"]))
        ok, msg, compared = run_case(exe, case, sel, args.vectors, columns)
        total_cycles += compared
        if ok:
            print(f"PASS {case['name']}  ({compared} cycles x {len(SIGNALS)} signals)")
        else:
            n_fail += 1
            print(f"FAIL {case['name']}  first mismatch: {msg}")

    synth_failed = False
    if not args.no_synth:
        try:
            run_synth(tc, args.build, args.synth_out, version)
        except ToolchainError as exc:
            synth_failed = True
            print(f"SYNTH ERROR: {exc}")

    n_pass = len(cases) - n_fail
    print(f"SUMMARY: {n_pass}/{len(cases)} cases PASS, {n_fail} FAIL, "
          f"{total_cycles} cycles compared bit-exact "
          f"({total_cycles * len(SIGNALS)} signal values), "
          f"{time.time() - t_start:.1f} s")
    if n_fail == 0 and not synth_failed:
        print("ALL PASS")
        return 0
    return 2 if (synth_failed and n_fail == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
