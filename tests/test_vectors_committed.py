"""Regression: the committed test_vectors/ directory must match a fresh
``--emit-vectors`` run.

test_vectors_repro.py only proves emission is reproducible run-to-run; this
test pins the committed golden vectors themselves, so any silent Python-model
behavior change that invalidates them (and hence the TS cross-validation of
Test 9) fails pytest instead of passing unnoticed.

Comparison policy (matches MODEL_SPEC section 12/18 tolerances): files are
first byte-compared. Vectors whose columns involve the PRNG noise path
(Box-Muller uses libm log/cos/sin, whose last-ULP results differ between
platforms, e.g. macOS libm vs glibc) may legitimately differ in the last
digit of their float repr across platforms; for those, a JSON-level semantic
comparison is used instead: integer columns exact, float columns within the
vector's own embedded noise tolerance (noise_abs, 1e-9). CSV command vectors
carry only integers and deterministic timestamps and must always byte-match.
"""

import filecmp
import json
import os

from model.python.cli import emit_vectors

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMMITTED_DIR = os.path.join(REPO_ROOT, "test_vectors")


def _json_semantically_equal(fresh_path, committed_path):
    """Tolerance-based comparison per the vector's embedded tolerance block."""
    with open(fresh_path) as f:
        fresh = json.load(f)
    with open(committed_path) as f:
        committed = json.load(f)

    if fresh.get("columns") != committed.get("columns"):
        return False, "columns differ"
    if fresh.get("config") != committed.get("config"):
        return False, "config differs"

    tol = committed.get("tolerance", {})
    noise_abs = float(tol.get("noise_abs", 1e-9))

    fd, cd = fresh.get("data", []), committed.get("data", [])
    if len(fd) != len(cd):
        return False, f"row count {len(fd)} != {len(cd)}"
    for r, (fr, cr) in enumerate(zip(fd, cd)):
        if len(fr) != len(cr):
            return False, f"row {r} width differs"
        for c, (fv, cv) in enumerate(zip(fr, cr)):
            if isinstance(cv, int) and isinstance(fv, int):
                if fv != cv:
                    return False, f"int mismatch at row {r} col {c}: {fv} != {cv}"
            else:
                if abs(float(fv) - float(cv)) > noise_abs:
                    return False, (
                        f"float mismatch at row {r} col {c}: "
                        f"|{fv} - {cv}| > {noise_abs}")
    return True, ""


def test_committed_vectors_match_fresh_emission(tmp_path):
    fresh_dir = tmp_path / "fresh"
    paths = emit_vectors(str(fresh_dir))
    assert len(paths) == 30  # 15 JSON + 15 CSV

    mismatches = []
    for p in paths:
        rel = os.path.relpath(p, str(fresh_dir))
        committed = os.path.join(COMMITTED_DIR, rel)
        assert os.path.exists(committed), f"missing committed vector {rel}"
        if filecmp.cmp(p, committed, shallow=False):
            continue
        # Byte mismatch: CSVs are integer/deterministic and must byte-match;
        # JSONs fall back to the semantic comparison (platform libm ULPs).
        if rel.endswith(".json"):
            ok, why = _json_semantically_equal(p, committed)
            if ok:
                continue
            mismatches.append(f"{rel} ({why})")
        else:
            mismatches.append(rel)
    assert not mismatches, (
        "committed test_vectors/ out of date with the model (regenerate via "
        "'python3 -m model.python.cli --emit-vectors test_vectors'): "
        + ", ".join(sorted(mismatches)))


def test_no_stale_committed_vectors(tmp_path):
    """Every committed JSON/CSV corresponds to a freshly emitted file."""
    fresh_dir = tmp_path / "fresh"
    emitted = {os.path.relpath(p, str(fresh_dir))
               for p in emit_vectors(str(fresh_dir))}
    committed = set()
    for name in sorted(os.listdir(COMMITTED_DIR)):
        if name.endswith(".json"):
            committed.add(name)
    for name in sorted(os.listdir(os.path.join(COMMITTED_DIR, "csv"))):
        if name.endswith(".csv"):
            committed.add(os.path.join("csv", name))
    assert committed == emitted
