"""Regression: --emit-vectors output is bit-for-bit reproducible."""

import filecmp
import os

from model.python.cli import VECTOR_CONFIGS, emit_vectors

EXPECTED_NAMES = {
    "n3p000_nearest", "n3p125_nearest", "n3p130_floor", "n3p130_nearest",
    "n3p130_ef1_shared", "n3p130_ef1_independent", "n3p130_mash11",
    "n3p130_latency_bug", "n3p130_lookahead", "n3p125_tap_mismatch_1deg",
    "n3p125_dtc_gain_1pct", "n3p130_dynamics_sin",
}


def test_vector_set_is_canonical():
    assert set(VECTOR_CONFIGS.keys()) == EXPECTED_NAMES
    for cfg in VECTOR_CONFIGS.values():
        assert cfg.n_cycles == 512
        assert cfg.seed == 12345


def test_emit_vectors_reproducible(tmp_path):
    d1 = tmp_path / "run1"
    d2 = tmp_path / "run2"
    p1 = emit_vectors(str(d1))
    p2 = emit_vectors(str(d2))
    assert len(p1) == len(p2) == 24  # 12 JSON + 12 CSV

    for name in EXPECTED_NAMES:
        j1 = d1 / f"{name}.json"
        j2 = d2 / f"{name}.json"
        c1 = d1 / "csv" / f"{name}.csv"
        c2 = d2 / "csv" / f"{name}.csv"
        assert j1.exists() and c1.exists()
        assert filecmp.cmp(j1, j2, shallow=False), f"{name}.json not reproducible"
        assert filecmp.cmp(c1, c2, shallow=False), f"{name}.csv not reproducible"


def test_vector_schema(tmp_path):
    import json
    emit_vectors(str(tmp_path))
    with open(tmp_path / "n3p130_nearest.json") as f:
        vec = json.load(f)
    assert vec["name"] == "n3p130_nearest"
    assert vec["generator"] == "python"
    assert vec["seed"] == 12345
    assert vec["tolerance"] == {"int": 0, "float_abs": 1e-12, "noise_abs": 1e-9}
    assert isinstance(vec["config"], dict)
    for col in ["k", "s_ideal", "A_FB", "R_FB", "m_FB", "c_FB", "n_int",
                "R_INJ", "j_INJ", "c_INJ", "u_FB_digital", "u_INJ_digital",
                "e_FB_abs", "e_pair"]:
        assert col in vec["columns"]
    assert len(vec["data"]) == 512
    assert len(vec["data"][0]) == len(vec["columns"])
    # command CSV header
    with open(tmp_path / "csv" / "n3p130_nearest.csv") as f:
        header = f.readline().strip()
    assert header == "k,t_ref_ns,n_int,m_FB,c_FB,j_INJ,c_INJ,R_FB,R_INJ,seq_id"
