"""Regression: --emit-vectors output is bit-for-bit reproducible."""

import filecmp
import os

from model.python.cli import VECTOR_CONFIGS, emit_vectors

EXPECTED_NAMES = {
    "n3p000_nearest", "n3p125_nearest", "n3p130_floor", "n3p130_nearest",
    "n3p130_ef1_shared", "n3p130_ef1_independent", "n3p130_mash11",
    "n3p130_latency_bug", "n3p130_lookahead", "n3p125_tap_mismatch_1deg",
    "n3p125_dtc_gain_1pct", "n3p130_dynamics_sin",
    # schema-v2 vectors (carry the extra 'inj_fired' column)
    "n3p130_mash111", "n3p130_dsm_only_gated",
    # schema-v4 vector (additionally carries 'u_loop' and 'pd_e')
    "n3p130_loop_both",
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
    assert len(p1) == len(p2) == 30  # 15 JSON + 15 CSV

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


def test_vector_schema_v2(tmp_path):
    """Schema-v2 vectors carry the trailing 'inj_fired' column and the
    non-default schema-v2 config keys; schema-v1 vectors carry neither
    (byte-stability, MODEL_SPEC section 18)."""
    import json
    emit_vectors(str(tmp_path))
    with open(tmp_path / "n3p130_dsm_only_gated.json") as f:
        v2 = json.load(f)
    assert v2["columns"][-1] == "inj_fired"
    assert v2["config"]["actuator_mode"] == "dsm_only"
    assert v2["config"]["inj_gate_mode"] == "threshold"
    with open(tmp_path / "n3p130_mash111.json") as f:
        v2m = json.load(f)
    assert v2m["columns"][-1] == "inj_fired"
    assert v2m["config"]["quantizer"] == "mash111"
    # defaults omitted for schema stability
    assert "actuator_mode" not in v2m["config"]
    with open(tmp_path / "n3p130_nearest.json") as f:
        v1 = json.load(f)
    assert "inj_fired" not in v1["columns"]
    assert "actuator_mode" not in v1["config"]
    assert "inj_gate_mode" not in v1["config"]


def test_vector_schema_v4(tmp_path):
    """The schema-v4 vector carries the trailing 'u_loop'/'pd_e' columns and
    the non-default loop_mode config key; earlier vectors carry neither
    (byte-stability, MODEL_SPEC sections 14.1, 18)."""
    import json
    emit_vectors(str(tmp_path))
    with open(tmp_path / "n3p130_loop_both.json") as f:
        v4 = json.load(f)
    assert v4["columns"][-2:] == ["u_loop", "pd_e"]
    assert v4["config"]["loop_mode"] == "pi"
    # loop gains at defaults are omitted (from_dict restores them)
    assert "loop_kp" not in v4["config"]
    assert "loop_ki" not in v4["config"]
    with open(tmp_path / "n3p130_dsm_only_gated.json") as f:
        v2 = json.load(f)
    assert "u_loop" not in v2["columns"]
    assert "pd_e" not in v2["columns"]
    assert "loop_mode" not in v2["config"]
