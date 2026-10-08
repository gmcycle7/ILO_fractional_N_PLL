"""RTL reference scheduler (rtl/frac_phase_scheduler.sv) vs the Python golden
model, bit-exact.

Three layers:

1. ``test_rtl_golden_vectors_are_current`` - the committed rtl/vectors/*.csv
   are regenerated from model/python and must be byte-identical (pure
   Python + numpy, always runs; pins the RTL golden set to the golden model).
2. ``test_rtl_bitexact`` - builds the CXXRTL simulation (yosys -> C++) and
   runs rtl/run_sim.py: every case, every reference cycle, every output must
   equal the golden CSV; the synthesizability pass must infer no latches.
3. ``test_rtl_runner_detects_mismatch`` - a corrupted copy of one vector must
   make the runner FAIL with the right cycle/signal (the check is not vacuous).

Layers 2 and 3 ``pytest.skip`` cleanly when the pip-only toolchain
(``pip install yowasp-yosys`` + a C++ compiler) is unavailable.  The
simulation binary is cached in rtl/build (source-hash stamped), so a warm
run of the whole file takes a few seconds; a cold one roughly 10-20 s.
"""

import importlib.util
import os
import shutil
import subprocess
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RTL_DIR = os.path.join(REPO_ROOT, "rtl")
VEC_DIR = os.path.join(RTL_DIR, "vectors")
RUN_SIM = os.path.join(RTL_DIR, "run_sim.py")


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(RTL_DIR, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gen_vectors = _load("gen_vectors")
run_sim = _load("run_sim")


# --------------------------------------------------------------------------
# 1. committed golden vectors == fresh golden-model emission
# --------------------------------------------------------------------------

def test_rtl_golden_vectors_are_current():
    problems = gen_vectors.check(VEC_DIR)
    assert problems == [], (
        "rtl/vectors is stale vs the golden model; regenerate with "
        "`python3 rtl/gen_vectors.py`: " + ", ".join(problems))
    cases = gen_vectors.case_list()
    assert len(cases) == 50
    # required coverage (task contract)
    assert {c["quantizer"] for c in cases} == {"nearest", "floor", "ef1"}
    assert {c["lat"] for c in cases} >= {0, 1, 3}
    assert {c["r_zero"] for c in cases} == {0, 10}
    assert any(c["n_target"] == "3.126953125" and c["quantizer"] == "nearest"
               for c in cases)                       # half-LSB tie case


def test_int_reference_matches_spec_canonicals():
    # N = 3.13, F = 24: FCW = round(3.13 * 256 * 2^24) = 13443247636
    assert gen_vectors.fcw_of("3.13", 24) == 13443247636
    # tie case: A[k] = 800.5 k -> odd k rounds UP under floor(x + 0.5)
    rows = gen_vectors.int_reference(gen_vectors.fcw_of("3.126953125", 24),
                                     24, "nearest", 0, 4)
    r_fb = [r[4] for r in rows]
    assert r_fb == [0, 33, 65, 98]          # 0, 800.5->801, 1601, 2401.5->2402
    # Mode D identity: (R_FB + R_INJ) mod 256 == R_zero
    rows = gen_vectors.int_reference(gen_vectors.fcw_of("3.13", 24), 24, "ef1", 10, 64)
    assert all((r[4] + r[5]) % 256 == 10 for r in rows)


# --------------------------------------------------------------------------
# 2./3. CXXRTL simulation (skips without the toolchain)
# --------------------------------------------------------------------------

@pytest.fixture(scope="module")
def toolchain():
    try:
        return run_sim.find_toolchain()
    except run_sim.ToolchainError as exc:
        pytest.skip(f"RTL toolchain unavailable: {exc}")


def _run(args, timeout=600):
    return subprocess.run([sys.executable, RUN_SIM] + args, cwd=REPO_ROOT,
                          capture_output=True, text=True, timeout=timeout)


def test_rtl_bitexact(toolchain, tmp_path):
    synth_out = tmp_path / "synth_stat.txt"
    proc = _run(["--synth-out", str(synth_out)])
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out
    assert "ALL PASS" in out, out
    assert not any(ln.startswith("FAIL ") for ln in out.splitlines()), out
    n_pass = sum(1 for ln in out.splitlines() if ln.startswith("PASS "))
    assert n_pass == 50, out
    summary = [ln for ln in out.splitlines() if ln.startswith("SUMMARY:")][0]
    assert "50/50 cases PASS" in summary, summary
    cycles = int(summary.split("FAIL, ")[1].split(" cycles")[0])
    # 50 cases x 2 passes x (2048 - LAT) golden-compared cycles
    expected = sum(2 * (c["n_cycles"] - c["lat"]) for c in gen_vectors.case_list())
    assert cycles == expected == 204634
    # synthesizability report: real cells, flops, no latches
    text = synth_out.read_text()
    assert "latches               0        0        0" in text, text
    for row in ("cells_total", "flip_flops"):
        vals = [int(v) for v in text.split(row)[1].split("\n")[0].split()]
        assert len(vals) == 3 and all(v > 0 for v in vals), text


def test_rtl_runner_detects_mismatch(toolchain, tmp_path):
    vec = tmp_path / "vectors"
    shutil.copytree(VEC_DIR, vec)
    name = "n3p13_ef1_lat3_rz0"
    path = vec / f"{name}.csv"
    lines = path.read_text().split("\n")
    fields = lines[1 + 777].split(",")          # row k = 777, column c_fb
    fields[3] = str((int(fields[3]) + 1) % 64)
    lines[1 + 777] = ",".join(fields)
    path.write_text("\n".join(lines))

    proc = _run(["--vectors", str(vec), "--no-synth", "-k", "n3p13_ef1"])
    out = proc.stdout + proc.stderr
    assert proc.returncode == 1, out
    assert f"FAIL {name}  first mismatch: pass 0 cycle 777 signal c_fb:" in out, out
    assert "PASS n3p13_ef1_lat0_rz0" in out, out
    assert "ALL PASS" not in out
