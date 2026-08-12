"""Regression: the committed test_vectors/ directory must byte-match a fresh
``--emit-vectors`` run.

test_vectors_repro.py only proves emission is reproducible run-to-run; this
test pins the committed golden vectors themselves, so any silent Python-model
behavior change that invalidates them (and hence the TS cross-validation of
Test 9) fails pytest instead of passing unnoticed.
"""

import filecmp
import os

from model.python.cli import emit_vectors

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMMITTED_DIR = os.path.join(REPO_ROOT, "test_vectors")


def test_committed_vectors_match_fresh_emission(tmp_path):
    fresh_dir = tmp_path / "fresh"
    paths = emit_vectors(str(fresh_dir))
    assert len(paths) == 30  # 15 JSON + 15 CSV

    mismatches = []
    for p in paths:
        rel = os.path.relpath(p, str(fresh_dir))
        committed = os.path.join(COMMITTED_DIR, rel)
        assert os.path.exists(committed), f"missing committed vector {rel}"
        if not filecmp.cmp(p, committed, shallow=False):
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
