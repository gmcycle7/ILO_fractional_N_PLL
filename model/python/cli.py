"""Command-line interface.

    python3 -m model.python.cli --list-presets
    python3 -m model.python.cli --preset exp03 [--out results]
    python3 -m model.python.cli --emit-vectors test_vectors

--preset writes results/<ID>/summary.json + timeseries.csv + psd.csv
(comparison presets additionally write timeseries_<i>.csv / psd_<i>.csv per
variant; index 0 also gets the unsuffixed names).

--emit-vectors writes the 14 canonical JSON vectors of MODEL_SPEC section 18
(512 cycles each, full float precision) plus per-cycle command CSVs under
DIR/csv/ with columns k,t_ref_ns,n_int,m_FB,c_FB,j_INJ,c_INJ,R_FB,R_INJ,seq_id.

Schema stability: the 12 schema-v1 vectors keep their original column list
(byte-identical files); the schema-v2 vectors (n3p130_mash111,
n3p130_dsm_only_gated) additionally carry the 'inj_fired' int column.
"""

import argparse
import json
import os

from .config import SimConfig
from . import measurements as meas
from .experiments import PRESETS, get_preset, preset_configs
from .phase_math import cycles_to_radians
from .simulate import simulate

#: canonical test vectors (MODEL_SPEC section 18); all 512 cycles, seed 12345
VECTOR_CONFIGS = {
    "n3p000_nearest": SimConfig(n_div=3.0, quantizer="nearest"),
    "n3p125_nearest": SimConfig(n_div=3.125, quantizer="nearest"),
    "n3p130_floor": SimConfig(n_div=3.13, quantizer="floor"),
    "n3p130_nearest": SimConfig(n_div=3.13, quantizer="nearest"),
    "n3p130_ef1_shared": SimConfig(n_div=3.13, quantizer="ef1", arch_mode="D"),
    "n3p130_ef1_independent": SimConfig(n_div=3.13, quantizer="ef1", arch_mode="B"),
    "n3p130_mash11": SimConfig(n_div=3.13, quantizer="mash11"),
    "n3p130_latency_bug": SimConfig(n_div=3.13, latency_cycles=1, lookahead=False),
    "n3p130_lookahead": SimConfig(n_div=3.13, latency_cycles=1, lookahead=True),
    "n3p125_tap_mismatch_1deg": SimConfig(
        n_div=3.125, tap_mismatch_cycles=[1.0 / 360.0] * 8),
    "n3p125_dtc_gain_1pct": SimConfig(n_div=3.125, dtc_inj_gain=1.01),
    "n3p130_dynamics_sin": SimConfig(
        n_div=3.13, inj_model="sin", k_inj=0.3, delta_f_hz=1e6,
        sigma_vco_w_rad=0.01),
    # schema-v2 vectors (carry the extra 'inj_fired' column)
    "n3p130_mash111": SimConfig(n_div=3.13, quantizer="mash111"),
    "n3p130_dsm_only_gated": SimConfig(
        n_div=3.13, quantizer="ef1", actuator_mode="dsm_only",
        inj_gate_mode="threshold", inj_model="sin", k_inj=0.4,
        delta_f_hz=1e6, sigma_vco_w_rad=0.02),
}

#: columns exported in the JSON vectors ("e_pair" == e_pair_digital)
VECTOR_COLUMNS = [
    "k", "s_ideal", "A_FB", "R_FB", "m_FB", "c_FB", "n_int",
    "R_INJ", "j_INJ", "c_INJ", "u_FB_digital", "u_INJ_digital",
    "e_FB_abs", "e_pair", "u_INJ_ideal", "e_INJ_abs",
    "u_FB_analog", "u_INJ_analog", "e_pair_analog",
    "e_ZC_hw", "e_inj", "theta_plus", "seq_id",
]

#: schema-v2 vectors additionally export inj_fired (appended last so the
#: schema-v1 vectors stay byte-identical)
VECTOR_COLUMNS_V2 = VECTOR_COLUMNS + ["inj_fired"]
_V2_VECTORS = {"n3p130_mash111", "n3p130_dsm_only_gated"}

_VECTOR_INT_COLS = {"k", "A_FB", "R_FB", "m_FB", "c_FB", "n_int",
                    "R_INJ", "j_INJ", "c_INJ", "inj_fired", "seq_id"}

CSV_COMMAND_COLUMNS = ["k", "t_ref_ns", "n_int", "m_FB", "c_FB", "j_INJ",
                       "c_INJ", "R_FB", "R_INJ", "seq_id"]


def _vector_dict(name: str, cfg: SimConfig) -> dict:
    res = simulate(cfg)
    columns = VECTOR_COLUMNS_V2 if name in _V2_VECTORS else VECTOR_COLUMNS
    data = []
    n = cfg.n_cycles
    for i in range(n):
        row = []
        for col in columns:
            src = "e_pair_digital" if col == "e_pair" else col
            v = res.data[src][i]
            row.append(int(v) if col in _VECTOR_INT_COLS else float(v))
        data.append(row)
    return {
        "name": name,
        "generator": "python",
        "seed": cfg.seed,
        "config": cfg.to_dict(),
        "tolerance": {"int": 0, "float_abs": 1e-12, "noise_abs": 1e-9},
        "columns": list(columns),
        "data": data,
    }


def _write_command_csv(path: str, res) -> None:
    d = res.data
    t_ref_ns = res.t_ref_s * 1e9
    with open(path, "w") as f:
        f.write(",".join(CSV_COMMAND_COLUMNS) + "\n")
        for i in range(len(d["k"])):
            row = [
                str(int(d["k"][i])),
                repr(float(d["k"][i]) * t_ref_ns),
                str(int(d["n_int"][i])),
                str(int(d["m_FB"][i])),
                str(int(d["c_FB"][i])),
                str(int(d["j_INJ"][i])),
                str(int(d["c_INJ"][i])),
                str(int(d["R_FB"][i])),
                str(int(d["R_INJ"][i])),
                str(int(d["seq_id"][i])),
            ]
            f.write(",".join(row) + "\n")


def emit_vectors(out_dir: str) -> list:
    """Write the 14 canonical JSON vectors + command CSVs. Returns paths."""
    os.makedirs(out_dir, exist_ok=True)
    csv_dir = os.path.join(out_dir, "csv")
    os.makedirs(csv_dir, exist_ok=True)
    paths = []
    for name, cfg in VECTOR_CONFIGS.items():
        vec = _vector_dict(name, cfg)
        jpath = os.path.join(out_dir, f"{name}.json")
        with open(jpath, "w") as f:
            json.dump(vec, f, sort_keys=True, separators=(",", ":"))
            f.write("\n")
        paths.append(jpath)
        res = simulate(cfg)
        cpath = os.path.join(csv_dir, f"{name}.csv")
        _write_command_csv(cpath, res)
        paths.append(cpath)
    return paths


def _psd_csv(path: str, res) -> None:
    phi = cycles_to_radians(1.0) * res.data["e_ZC_total"]  # rad
    freqs, psd = meas.periodogram_psd(phi, fs=res.config.f_ref_hz)
    dbc = meas.psd_to_dbc_per_hz(psd)
    with open(path, "w") as f:
        f.write("freq_hz,s_phi_rad2_per_hz,ssb_dbc_per_hz\n")
        for i in range(len(freqs)):
            f.write(f"{repr(float(freqs[i]))},{repr(float(psd[i]))},"
                    f"{repr(float(dbc[i]))}\n")


def run_preset(preset_id: str, out_root: str = "results") -> str:
    preset = get_preset(preset_id)
    cfgs = preset_configs(preset)
    out_dir = os.path.join(out_root, preset_id)
    os.makedirs(out_dir, exist_ok=True)

    summaries = []
    for i, cfg in enumerate(cfgs):
        res = simulate(cfg)
        summaries.append({
            "variant": i,
            "config": cfg.to_dict(),
            "summary": res.summary(),
        })
        ts_named = os.path.join(out_dir, f"timeseries_{i}.csv")
        psd_named = os.path.join(out_dir, f"psd_{i}.csv")
        if len(cfgs) > 1:
            res.to_csv(ts_named)
            _psd_csv(psd_named, res)
        if i == 0:
            res.to_csv(os.path.join(out_dir, "timeseries.csv"))
            _psd_csv(os.path.join(out_dir, "psd.csv"), res)

    summary = {
        "id": preset["id"],
        "name_zh": preset["name_zh"],
        "name_en": preset["name_en"],
        "description": preset["description"],
        "expected_result": preset["expected_result"],
        "variants": summaries,
    }
    with open(os.path.join(out_dir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, sort_keys=True)
        f.write("\n")
    return out_dir


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python3 -m model.python.cli",
        description="Fractional-N PLL reverse edge injection golden model CLI")
    p.add_argument("--list-presets", action="store_true",
                   help="list available experiment presets")
    p.add_argument("--preset", metavar="ID",
                   help="run a preset and write results/<ID>/")
    p.add_argument("--out", default="results",
                   help="output root for --preset (default: results)")
    p.add_argument("--emit-vectors", metavar="DIR",
                   help="write the 14 canonical JSON test vectors + CSVs")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    did = False
    if args.list_presets:
        for pid, preset in PRESETS.items():
            n_cfg = len(preset_configs(preset))
            print(f"{pid:24s} [{n_cfg} config(s)] {preset['name_en']}")
        did = True
    if args.emit_vectors:
        paths = emit_vectors(args.emit_vectors)
        print(f"wrote {len(paths)} files under {args.emit_vectors}")
        did = True
    if args.preset:
        out_dir = run_preset(args.preset, args.out)
        print(f"wrote {out_dir}/summary.json, timeseries.csv, psd.csv")
        did = True
    if not did:
        build_parser().print_help()
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
