#!/usr/bin/env python3
"""Golden vectors for the RTL reference scheduler (rtl/frac_phase_scheduler.sv).

    python3 rtl/gen_vectors.py            # (re)write rtl/vectors/*.csv + manifest.json
    python3 rtl/gen_vectors.py --check    # verify the committed vectors are current

The vectors come from the Python GOLDEN MODEL (model/python, the executable
form of MODEL_SPEC.md) - not from a re-implementation.  The RTL works in
fixed point with a frequency control word

    FCW = round(N * 256 * 2^F)            (round half up, exact rational math)

so the golden model is run with ``n_div`` set to the EXACT dyadic value

    N_realized = FCW / 2^(8+F)

For the chosen lengths every float64 operation on the digital path is then
exact (k*N, 256*s, u+0.5 and the ef1 state all fit in 53 bits); this is
asserted per case, and the golden-model rows are additionally cross-checked
against an independent pure-integer reference (``int_reference``) before a
file is written.

Each case is simulated for N_CYCLES + 1 reference cycles and the first
N_CYCLES rows are kept, so every stored n_int[k] = I[k+1] - I[k] is the true
value (the golden model pads its very last n_int entry).

Columns: k,n_int,m_fb,c_fb,r_fb,r_inj,j_inj,c_inj,seq_id
"""

import argparse
import json
import os
import sys
from fractions import Fraction

RTL_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(RTL_DIR)
DEFAULT_OUT = os.path.join(RTL_DIR, "vectors")

if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

N_CYCLES = 2048
G_BITS = 8                      # G = 256 fine codes per VCO cycle
COLUMNS = ["k", "n_int", "m_fb", "c_fb", "r_fb", "r_inj", "j_inj", "c_inj",
           "seq_id"]
#: golden-model column feeding each CSV column
_GOLDEN_COLUMNS = ["k", "n_int", "m_FB", "c_FB", "R_FB", "R_INJ", "j_INJ",
                   "c_INJ", "seq_id"]

#: q_mode encoding of the RTL (rtl/fps_quantizer.sv)
Q_MODE = {"nearest": 0, "floor": 1, "ef1": 2}

#: (id, decimal N target) - FCW is rounded from the exact decimal value
N_TARGETS = [
    ("n3p13", "3.13"),                 # default off-grid case, FCW rounded
    ("n3p125", "3.125"),               # on-grid (alpha*256 = 32)
    ("n3p2", "3.2"),                   # alpha = 1/5, FCW rounded
    ("n3p126953125", "3.126953125"),   # half-LSB tie: floor(x+0.5) boundary
    ("n3p001", "3.001"),               # near-integer: ef1 reaches n_int = 2
]
QUANTIZERS = ["nearest", "floor", "ef1"]
LATS = [0, 1, 3]
R_ZEROS = [0, 10]


def fcw_of(n_target: str, f_bits: int) -> int:
    """FCW = round(N * 256 * 2^F), half-up, in exact rational arithmetic."""
    x = Fraction(n_target) * (1 << (G_BITS + f_bits)) + Fraction(1, 2)
    return x.numerator // x.denominator


def case_list():
    """Deterministic list of cases (dicts)."""
    cases = []

    def add(nid, n_target, q, lat, rz, f_bits=24):
        name = f"{nid}_{q}_lat{lat}_rz{rz}"
        if f_bits != 24:
            name += f"_f{f_bits}"
        fcw = fcw_of(n_target, f_bits)
        cases.append({
            "name": name,
            "file": name + ".csv",
            "n_target": n_target,
            "F": f_bits,
            "fcw": fcw,
            "n_realized": repr(fcw / (1 << (G_BITS + f_bits))),
            "quantizer": q,
            "q_mode": Q_MODE[q],
            "lat": lat,
            "r_zero": rz,
            "n_cycles": N_CYCLES,
        })

    # main matrix: N x quantizer x LAT, R_ZERO alternating so that every
    # (N, quantizer) pair and every LAT sees both R_ZERO values
    for ni, (nid, n_target) in enumerate(N_TARGETS):
        for qi, q in enumerate(QUANTIZERS):
            for li, lat in enumerate(LATS):
                add(nid, n_target, q, lat, R_ZEROS[(ni + qi + li) % 2])

    # parameter-range extras: maximum LAT, and other accumulator widths
    add("n3p13", "3.13", "ef1", 8, 10)
    add("n3p13", "3.13", "nearest", 8, 0)
    add("n3p13", "3.13", "ef1", 1, 0, f_bits=16)
    add("n3p126953125", "3.126953125", "nearest", 3, 10, f_bits=16)
    add("n3p001", "3.001", "ef1", 3, 10, f_bits=32)
    return cases


def assert_float_exact(fcw: int, f_bits: int, n: int) -> float:
    """Return n_div = FCW / 2^(8+F) after proving the golden model's float64
    digital path is exact for k = 0..n (inclusive)."""
    scale = 1 << (G_BITS + f_bits)
    n_div = fcw / scale
    assert Fraction(n_div) == Fraction(fcw, scale), "n_div is not exact"
    for k in range(n + 1):
        # s_ideal[k] = k * N  (float multiplication) must be exact
        assert Fraction(float(k) * n_div) == Fraction(k * fcw, scale), (
            f"k*N not exact in float64 at k={k}")
        # u + 0.5 (nearest) and u + e (ef1, e < 1) need <= 53 significant bits
        assert (k * fcw + (1 << f_bits)).bit_length() <= 53, (
            f"quantizer input exceeds 53 bits at k={k}")
    return n_div


def int_reference(fcw: int, f_bits: int, quantizer: str, r_zero: int, n: int):
    """Independent pure-integer model of MODEL_SPEC sections 3, 4, 6, 7(D), 8
    (unbounded Python ints; the RTL is this arithmetic modulo 2^W)."""
    mask = (1 << f_bits) - 1
    a_fb = []
    e = 0
    for k in range(n + 1):
        acc = k * fcw                         # 256 * k * N in units of 2^-F LSB
        if quantizer == "nearest":
            y = (acc + (1 << (f_bits - 1))) >> f_bits
        elif quantizer == "floor":
            y = acc >> f_bits
        elif quantizer == "ef1":
            v = acc + e
            y = v >> f_bits
            e = v & mask
        else:
            raise ValueError(quantizer)
        a_fb.append(y)
    rows = []
    for k in range(n):
        r_fb = a_fb[k] & 255
        n_int = (a_fb[k + 1] >> 8) - (a_fb[k] >> 8)
        r_inj = (r_zero - r_fb) & 255
        rows.append([k, n_int, r_fb >> 6, r_fb & 63, r_fb, r_inj,
                     r_inj >> 5, r_inj & 31, k])
    return rows


def golden_rows(case):
    """Run the Python golden model for one case; returns integer rows."""
    from model.python.config import SimConfig
    from model.python.simulate import simulate

    n = case["n_cycles"]
    n_div = assert_float_exact(case["fcw"], case["F"], n)
    cfg = SimConfig(
        n_div=n_div,
        n_cycles=n + 1,              # +1 so n_int[n-1] is not the padded entry
        quantizer=case["quantizer"],
        arch_mode="D",
        actuator_mode="full",
        inj_mapping="naive",
        latency_cycles=case["lat"],
        lookahead=True,
        r_zero=case["r_zero"],
    )
    data = simulate(cfg).data
    cols = [data[c] for c in _GOLDEN_COLUMNS]
    rows = [[int(col[k]) for col in cols] for k in range(n)]

    ref = int_reference(case["fcw"], case["F"], case["quantizer"],
                        case["r_zero"], n)
    assert rows == ref, (
        f"{case['name']}: golden model disagrees with the integer reference")
    return rows


def render_csv(rows) -> str:
    lines = [",".join(COLUMNS)]
    lines.extend(",".join(str(v) for v in row) for row in rows)
    return "\n".join(lines) + "\n"


def render_manifest(cases) -> str:
    doc = {
        "schema": 1,
        "generator": "rtl/gen_vectors.py",
        "source": "model/python golden model, n_div = fcw / 2^(8+F) (exact)",
        "columns": COLUMNS,
        "cases": cases,
    }
    return json.dumps(doc, indent=2) + "\n"


def build_all():
    """Return {filename: text} for every vector file plus the manifest."""
    cases = case_list()
    files = {}
    for case in cases:
        files[case["file"]] = render_csv(golden_rows(case))
    files["manifest.json"] = render_manifest(cases)
    return files


def generate(out_dir: str = DEFAULT_OUT):
    """Write all vector files into out_dir; returns the list of paths."""
    files = build_all()
    os.makedirs(out_dir, exist_ok=True)
    paths = []
    for name, text in files.items():
        path = os.path.join(out_dir, name)
        with open(path, "w", newline="\n") as f:
            f.write(text)
        paths.append(path)
    return paths


def check(out_dir: str = DEFAULT_OUT):
    """Compare out_dir against a fresh generation; returns a list of problems."""
    files = build_all()
    problems = []
    for name, text in files.items():
        path = os.path.join(out_dir, name)
        if not os.path.exists(path):
            problems.append(f"missing {name}")
            continue
        with open(path, newline="") as f:
            if f.read() != text:
                problems.append(f"stale {name}")
    if os.path.isdir(out_dir):
        for name in sorted(os.listdir(out_dir)):
            if name.endswith((".csv", ".json")) and name not in files:
                problems.append(f"unexpected {name}")
    return problems


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=DEFAULT_OUT, help="vector directory")
    ap.add_argument("--check", action="store_true",
                    help="verify the directory matches a fresh generation")
    args = ap.parse_args(argv)

    if args.check:
        problems = check(args.out)
        for p in problems:
            print("FAIL", p)
        print(f"{len(case_list())} cases checked: "
              + ("OK" if not problems else f"{len(problems)} problem(s)"))
        return 1 if problems else 0

    paths = generate(args.out)
    n_cases = len(paths) - 1
    print(f"wrote {n_cases} vector files x {N_CYCLES} cycles + manifest.json "
          f"to {os.path.relpath(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
