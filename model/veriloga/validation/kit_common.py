"""Shared manifest + helpers for the Spectre validation kit.

STATUS: the Spectre side of this kit is UNRUN (no Verilog-A capable simulator
was available where it was written). The Python side (this module,
gen_stimulus.py, check_results.py, va_emulator.py) runs with python3 >= 3.8;
numpy is needed only for the checks that call the golden model
(dtc_nonideal_model gain/INL instances, pulsed_injection_phase_model).

Single source of truth for
  * the TIMING PLAN shared by the four .scs netlists, the stimulus generator,
    the Ocean export scripts and the checker (the netlists repeat the numbers
    in their `parameters` line; `check_results.py --lint` verifies they agree);
  * the per-testbench INSTANCE MANIFEST: which .va module, which parameters,
    which committed vector each instance is aligned with;
  * the PROBE LIST (= columns of the exported result CSV).

Voltage encoding (all four .va models): integer code -> code * v_per_code
(v_per_code = 1 V here); debug phases 1 V per cycle (scheduler) or 1 V per rad
(injection model).
"""

import ast
import csv
import json
import math
import os
import re

VALIDATION_DIR = os.path.dirname(os.path.abspath(__file__))
VERILOGA_DIR = os.path.dirname(VALIDATION_DIR)
REPO_ROOT = os.path.dirname(os.path.dirname(VERILOGA_DIR))
VECTORS_DIR = os.path.join(REPO_ROOT, "test_vectors")
DEFAULT_BUILD = os.path.join(VALIDATION_DIR, "build")

# ---------------------------------------------------------------------------
# Timing plan [s].  Reference edge k: 0.5 V crossing of ref_clk at
#   t_edge(k) = k*T_REF + T_EDGE.
# ---------------------------------------------------------------------------
TIMING = {
    "T_REF": 250e-12,        # 1/f_ref, f_ref = 4 GHz (all vectors)
    "N_CYC": 512,            # cycles simulated = rows per committed vector
    "T_EDGE": 10e-12,        # ref_clk rising-edge crossing offset
    "T_RAMP": 1e-12,         # rise/fall of every source in the benches
    "T_CODE": 20e-12,        # PWL code k starts ramping at k*T_REF + T_CODE
    "T_SKEW": 62.5e-12,      # reverse-scheduler clock = ref_clk + T_REF/4
    "T_STROBE": 200e-12,     # export samples at k*T_REF + T_STROBE
    "T_ARM_DTC": 100e-12,    # DTC trigger crossing at k*T_REF + T_ARM_DTC
    "W_DTC": 120e-12,        # DTC trigger high time (> max t_d, see README)
    "T_RISE_DTC": 1e-12,     # dtc_nonideal_model t_rise (output ramp)
    "W_ILO": 10e-12,         # injection trigger high time
    "ILO_ARM_CYCLES": 1,     # injection trigger offset = 1 * T_vco (phase-neutral)
}
TIMING["T_STOP"] = TIMING["N_CYC"] * TIMING["T_REF"]

V_PER_CODE = 1.0

# Python vectors pad the LAST n_int with the previous value (cli/simulate:
# n_int = diff(I_FB) padded); the .va computes the true I[k+1]-I[k], so the
# last row's n_int is not comparable (it differs for n3p125_nearest: 4 vs 3).
SKIP_LAST_N_INT = True

# ---------------------------------------------------------------------------
# Testbench manifest.
#   inst: instance name in the .scs (also the net-name prefix)
#   params: Verilog-A parameter overrides that MUST appear in the netlist
#   vector: committed vector the instance is checked against
#   expect: how expected values are obtained (see check_results.py)
# ---------------------------------------------------------------------------
TVCO_125 = 1.0 / (3.125 * 4e9)      # 80 ps        (n3p125 vectors)
TVCO_130 = 1.0 / (3.13 * 4e9)       # 79.872... ps (n3p130 vectors)

TBS = {
    "fractional_phase_scheduler": {
        "netlist": "tb_fractional_phase_scheduler.scs",
        "va": ["fractional_phase_scheduler.va"],
        "instances": [
            {"inst": "fps_a", "master": "fractional_phase_scheduler",
             "vector": "n3p130_nearest", "expect": "committed",
             "params": {"n_int_base": 3, "alpha": 0.13, "s0": 0.0, "b_dtc": 6,
                        "q_mode": 1, "vth": 0.5, "v_per_code": 1.0}},
            {"inst": "fps_b", "master": "fractional_phase_scheduler",
             "vector": "n3p125_nearest", "expect": "committed",
             "params": {"n_int_base": 3, "alpha": 0.125, "s0": 0.0, "b_dtc": 6,
                        "q_mode": 1, "vth": 0.5, "v_per_code": 1.0}},
            {"inst": "fps_c", "master": "fractional_phase_scheduler",
             "vector": "n3p130_ef1_shared", "expect": "committed",
             "params": {"n_int_base": 3, "alpha": 0.13, "s0": 0.0, "b_dtc": 6,
                        "q_mode": 2, "vth": 0.5, "v_per_code": 1.0}},
        ],
        "stimuli": [],
    },
    "reverse_injection_scheduler": {
        "netlist": "tb_reverse_injection_scheduler.scs",
        "va": ["reverse_injection_scheduler.va", "fractional_phase_scheduler.va"],
        "instances": [
            # Mode D fed by the committed R_FB stream (PWL) -- unit test
            {"inst": "rev_d", "master": "reverse_injection_scheduler",
             "vector": "n3p130_nearest", "expect": "committed",
             "r_fb_net": "rfb_pwl",
             "params": {"r_zero": 0, "shared_mode": 1, "map_mode": 0,
                        "lat_cycles": 0, "b_dtc": 6, "v_per_code": 1.0}},
            # feedback scheduler driving the Mode-D block (hookup test)
            {"inst": "fps", "master": "fractional_phase_scheduler",
             "vector": "n3p130_nearest", "expect": "committed",
             "params": {"n_int_base": 3, "alpha": 0.13, "s0": 0.0, "b_dtc": 6,
                        "q_mode": 1, "v_per_code": 1.0}},
            {"inst": "rev_chain", "master": "reverse_injection_scheduler",
             "vector": "n3p130_nearest", "expect": "committed",
             "r_fb_net": "fps_r_fb",
             "params": {"r_zero": 0, "shared_mode": 1, "map_mode": 0,
                        "lat_cycles": 0, "b_dtc": 6, "v_per_code": 1.0}},
            # Mode A/B independent ef1 with the golden model's seeded state
            {"inst": "rev_b", "master": "reverse_injection_scheduler",
             "vector": "n3p130_ef1_independent", "expect": "committed",
             "r_fb_net": "0",
             "params": {"r_zero": 0, "shared_mode": 0, "map_mode": 0,
                        "lat_cycles": 0, "look_ahead": 1, "n_int_base": 3,
                        "alpha": 0.13, "s0": 0.0, "z0": 0.0, "b_dtc": 6,
                        "q_mode": 2, "e_q_init": 0.7047782763838768,
                        "v_per_code": 1.0}},
            # latency L=1: bug mode (look_ahead=0) and correct look-ahead
            {"inst": "rev_lb", "master": "reverse_injection_scheduler",
             "vector": "n3p130_latency_bug", "expect": "committed",
             "r_fb_net": "0",
             "params": {"r_zero": 0, "shared_mode": 0, "map_mode": 0,
                        "lat_cycles": 1, "look_ahead": 0, "n_int_base": 3,
                        "alpha": 0.13, "s0": 0.0, "z0": 0.0, "b_dtc": 6,
                        "q_mode": 1, "v_per_code": 1.0}},
            {"inst": "rev_la", "master": "reverse_injection_scheduler",
             "vector": "n3p130_lookahead", "expect": "committed",
             "r_fb_net": "0",
             "params": {"r_zero": 0, "shared_mode": 0, "map_mode": 0,
                        "lat_cycles": 1, "look_ahead": 1, "n_int_base": 3,
                        "alpha": 0.13, "s0": 0.0, "z0": 0.0, "b_dtc": 6,
                        "q_mode": 1, "v_per_code": 1.0}},
        ],
        "stimuli": [
            {"net": "rfb_pwl", "vector": "n3p130_nearest", "column": "R_FB",
             "kind": "code", "sampled_at": "T_EDGE+T_SKEW"},
        ],
    },
    "dtc_nonideal_model": {
        "netlist": "tb_dtc_nonideal_model.scs",
        "va": ["dtc_nonideal_model.va"],
        "instances": [
            # committed n3p125_tap_mismatch_1deg: T_vco = 80 ps, taps =
            # nominal j*T_vco/8 + 1 deg (T_vco/360) each. c_INJ == 0 here.
            {"inst": "dtc_tap", "master": "dtc_nonideal_model",
             "vector": "n3p125_tap_mismatch_1deg", "expect": "committed",
             "code_net": "code_v125", "tap_net": "tap_v125",
             "tvco": TVCO_125,
             "params": {"lsb_s": TVCO_125 / 256.0, "gain": 1.0,
                        "offset_s": 0.0, "use_tap": 1, "n_codes": 64,
                        "t_rise": 1e-12, "v_per_code": 1.0,
                        **{f"tap{j}": j * TVCO_125 / 8.0 + TVCO_125 / 360.0
                           for j in range(8)}}},
            # committed n3p130_nearest: ideal DTC, c_INJ in 0..31
            {"inst": "dtc_ideal", "master": "dtc_nonideal_model",
             "vector": "n3p130_nearest", "expect": "committed",
             "code_net": "code_v130", "tap_net": "tap_v130",
             "tvco": TVCO_130,
             "params": {"lsb_s": TVCO_130 / 256.0, "gain": 1.0,
                        "offset_s": 0.0, "use_tap": 1, "n_codes": 64,
                        "t_rise": 1e-12, "v_per_code": 1.0,
                        **{f"tap{j}": j * TVCO_130 / 8.0 for j in range(8)}}},
            # +1 % gain on the n3p130_nearest codes. The committed
            # n3p125_dtc_gain_1pct is degenerate (c_INJ == 0 at N = 3.125,
            # the gain never acts), so the expected value is the golden
            # model re-run of n3p130_nearest with dtc_inj_gain = 1.01.
            {"inst": "dtc_gain", "master": "dtc_nonideal_model",
             "vector": "n3p130_nearest", "expect": "golden_rerun",
             "rerun": {"dtc_inj_gain": 1.01},
             "code_net": "code_v130", "tap_net": "tap_v130",
             "tvco": TVCO_130,
             "params": {"lsb_s": TVCO_130 / 256.0, "gain": 1.01,
                        "offset_s": 0.0, "use_tap": 1, "n_codes": 64,
                        "t_rise": 1e-12, "v_per_code": 1.0,
                        **{f"tap{j}": j * TVCO_130 / 8.0 for j in range(8)}}},
            # offset + sinusoidal INL + polynomial INL (spec sec.10 items 5-7)
            {"inst": "dtc_inl", "master": "dtc_nonideal_model",
             "vector": "n3p130_nearest", "expect": "golden_rerun",
             "rerun": {"dtc_inj_offset_cycles": 0.01,
                       "inl_sin_amp_cycles": 0.002,
                       "inl_poly": [0.001, -0.0005]},
             "code_net": "code_v130", "tap_net": "tap_v130",
             "tvco": TVCO_130,
             "params": {"lsb_s": TVCO_130 / 256.0, "gain": 1.0,
                        "offset_s": 0.01 * TVCO_130,
                        "inl_sin_amp_s": 0.002 * TVCO_130,
                        "p2_s": 0.001 * TVCO_130,
                        "p3_s": -0.0005 * TVCO_130,
                        "use_tap": 1, "n_codes": 64,
                        "t_rise": 1e-12, "v_per_code": 1.0,
                        **{f"tap{j}": j * TVCO_130 / 8.0 for j in range(8)}}},
        ],
        "stimuli": [
            {"net": "code_v125", "vector": "n3p125_tap_mismatch_1deg",
             "column": "c_INJ", "kind": "code", "sampled_at": "T_ARM_DTC"},
            {"net": "tap_v125", "vector": "n3p125_tap_mismatch_1deg",
             "column": "j_INJ", "kind": "code", "sampled_at": "T_ARM_DTC"},
            {"net": "code_v130", "vector": "n3p130_nearest",
             "column": "c_INJ", "kind": "code", "sampled_at": "T_ARM_DTC"},
            {"net": "tap_v130", "vector": "n3p130_nearest",
             "column": "j_INJ", "kind": "code", "sampled_at": "T_ARM_DTC"},
        ],
    },
    "pulsed_injection_phase_model": {
        "netlist": "tb_pulsed_injection_phase_model.scs",
        "va": ["pulsed_injection_phase_model.va"],
        "instances": [
            {"inst": "ilo_sin", "master": "pulsed_injection_phase_model",
             "vector": "n3p130_dynamics_sin", "expect": "golden_rerun",
             "rerun": {"sigma_vco_w_rad": 0.0},
             "params": {"f0": 3.13 * 4e9, "delta_f": 1e6, "k_inj": 0.3,
                        "inj_map": 1, "k_scale": 1.0, "z0": 0.0,
                        "theta0": 0.0, "out_mode": 0, "vth_trig": 0.5}},
            {"inst": "ilo_lin", "master": "pulsed_injection_phase_model",
             "vector": "n3p130_dynamics_sin", "expect": "golden_rerun",
             "rerun": {"sigma_vco_w_rad": 0.0, "inj_model": "linear"},
             "params": {"f0": 3.13 * 4e9, "delta_f": 1e6, "k_inj": 0.3,
                        "inj_map": 0, "k_scale": 1.0, "z0": 0.0,
                        "theta0": 0.0, "out_mode": 0, "vth_trig": 0.5}},
            {"inst": "ilo_rst", "master": "pulsed_injection_phase_model",
             "vector": "n3p130_dynamics_sin", "expect": "golden_rerun",
             "rerun": {"sigma_vco_w_rad": 0.0, "inj_model": "reset"},
             "params": {"f0": 3.13 * 4e9, "delta_f": 1e6, "k_inj": 0.3,
                        "inj_map": 2, "k_scale": 1.0, "z0": 0.0,
                        "theta0": 0.0, "out_mode": 0, "vth_trig": 0.5}},
        ],
        "stimuli": [
            {"net": "inj", "vector": "n3p130_dynamics_sin",
             "column": "inj_trigger", "kind": "ilo_trigger",
             "f0": 3.13 * 4e9},
        ],
    },
}

TB_ORDER = ["fractional_phase_scheduler", "reverse_injection_scheduler",
            "dtc_nonideal_model", "pulsed_injection_phase_model"]


def tb_names():
    return list(TB_ORDER)


def get_tb(tb):
    if tb.startswith("tb_"):
        tb = tb[3:]
    if tb not in TBS:
        raise KeyError(f"unknown testbench '{tb}'; valid: {', '.join(TB_ORDER)}")
    return tb, TBS[tb]


# ---------------------------------------------------------------------------
# Probes = exported columns: (column, net, how)
#   how = 'v'     : V(net) sampled at k*T_REF + T_STROBE
#   how = 'cross' : time of the (k+1)-th rising 0.5 V crossing of V(net)
# ---------------------------------------------------------------------------
_FPS_OUTS = ["n_int", "m_fb", "c_fb", "s_ideal", "x_frac", "r_fb"]
_REV_OUTS = ["j", "c", "r", "u"]
_ILO_OUTS = ["e", "dth", "th"]


def probes(tb):
    tb, d = get_tb(tb)
    out = []
    if tb == "fractional_phase_scheduler":
        for ins in d["instances"]:
            out += [(f"{ins['inst']}_{o}", f"{ins['inst']}_{o}", "v")
                    for o in _FPS_OUTS]
    elif tb == "reverse_injection_scheduler":
        out.append(("rfb_pwl", "rfb_pwl", "v"))
        for ins in d["instances"]:
            if ins["master"] == "fractional_phase_scheduler":
                out.append((f"{ins['inst']}_r_fb", f"{ins['inst']}_r_fb", "v"))
            else:
                out += [(f"{ins['inst']}_{o}", f"{ins['inst']}_{o}", "v")
                        for o in _REV_OUTS]
    elif tb == "dtc_nonideal_model":
        out.append(("trig", "trig", "cross"))
        for st in d["stimuli"]:
            out.append((st["net"], st["net"], "v"))
        for ins in d["instances"]:
            out.append((f"{ins['inst']}_out", f"{ins['inst']}_out", "cross"))
    elif tb == "pulsed_injection_phase_model":
        out.append(("inj", "inj", "cross"))
        for ins in d["instances"]:
            out += [(f"{ins['inst']}_{o}", f"{ins['inst']}_{o}", "v")
                    for o in _ILO_OUTS]
    return out


# Port order of each .va module (lint asserts the .va headers still match)
# and the net-name suffix the benches use for each OUTPUT port.
PORTS = {
    "fractional_phase_scheduler": (
        ["ref_clk", "n_int_out", "m_fb_out", "c_fb_out", "s_ideal_out",
         "x_frac_out", "r_fb_out"], _FPS_OUTS),
    "reverse_injection_scheduler": (
        ["ref_clk", "r_fb_in", "j_inj_out", "c_inj_out", "r_inj_out",
         "u_inj_out"], _REV_OUTS),
    "dtc_nonideal_model": (
        ["trig_in", "code_in", "tap_sel_in", "trig_out"], ["out"]),
    "pulsed_injection_phase_model": (
        ["inj_in", "vco_out", "e_inj_dbg", "dtheta_dbg", "theta_dbg"],
        ["vco"] + _ILO_OUTS),
}
CLOCK_NET = {"fractional_phase_scheduler": "ref_clk",
             "reverse_injection_scheduler": "ref_clk_rev",
             "dtc_nonideal_model": "trig",
             "pulsed_injection_phase_model": "inj"}


def expected_nodes(tb, ins):
    """Exact node list an instance must have in its testbench netlist."""
    tb, _ = get_tb(tb)
    i, master = ins["inst"], ins["master"]
    clk = CLOCK_NET[tb]
    if master == "fractional_phase_scheduler":
        clk = "ref_clk"           # also inside the reverse bench (hookup)
    inputs = {"fractional_phase_scheduler": [clk],
              "reverse_injection_scheduler": [clk, ins.get("r_fb_net", "0")],
              "dtc_nonideal_model": [clk, ins.get("code_net"), ins.get("tap_net")],
              "pulsed_injection_phase_model": [clk]}[master]
    return inputs + [f"{i}_{o}" for o in PORTS[master][1]]


def strobe_time(k):
    return k * TIMING["T_REF"] + TIMING["T_STROBE"]


# ---------------------------------------------------------------------------
# Vector loading
# ---------------------------------------------------------------------------
def load_vector_csv(name):
    """Committed per-cycle command CSV -> dict column -> list (ints, t_ref_ns float)."""
    path = os.path.join(VECTORS_DIR, "csv", f"{name}.csv")
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    cols = {}
    for key in rows[0].keys():
        if key == "t_ref_ns":
            cols[key] = [float(r[key]) for r in rows]
        else:
            cols[key] = [int(r[key]) for r in rows]
    return cols


def load_vector_json(name):
    """Committed JSON vector -> (config dict, dict column -> list)."""
    path = os.path.join(VECTORS_DIR, f"{name}.json")
    with open(path) as f:
        d = json.load(f)
    cols = {c: [row[i] for row in d["data"]] for i, c in enumerate(d["columns"])}
    return d["config"], cols


# ---------------------------------------------------------------------------
# ILO trigger timing (shared by gen_stimulus, checker and emulator)
#   trigger k crossing: t_k = k*T_REF + ILO_ARM_CYCLES*T_vco + u_dig[k]*T_vco
#   u_dig[k] = ((32*j + c) mod 256)/256 from the committed CSV codes
#   (T_vco = 1/f0 with f0 = N*f_ref, so f0*t_k = N*k + integer + u_dig and the
#   pulse lands on the intended zero crossing -- the scheduler+DTC function
#   is replaced by exact PWL timing so this bench isolates the ILO model).
# ---------------------------------------------------------------------------
def ilo_trigger_times(vector, f0):
    cols = load_vector_csv(vector)
    t_vco = 1.0 / f0
    t_arm = TIMING["ILO_ARM_CYCLES"] * t_vco
    out = []
    for k, (j, c) in enumerate(zip(cols["j_INJ"], cols["c_INJ"])):
        u = ((32 * j + c) % 256) / 256.0
        out.append(k * TIMING["T_REF"] + t_arm + u * t_vco)
    return out


# ---------------------------------------------------------------------------
# Static netlist / Verilog-A parsing (used by `check_results.py --lint`)
# ---------------------------------------------------------------------------
_SI = {"T": 1e12, "G": 1e9, "M": 1e6, "K": 1e3, "k": 1e3, "m": 1e-3,
       "u": 1e-6, "n": 1e-9, "p": 1e-12, "f": 1e-15, "a": 1e-18}
_NUM_SI = re.compile(r"(?<![\w.])(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)([TGMKkmunpfa])(?![\w])")


def eval_expr(text, env):
    """Evaluate a Spectre parameter expression (numbers with Spectre SI
    suffixes -- case-sensitive, M = 1e6 --, + - * / ( ) and names in env)."""
    src = _NUM_SI.sub(lambda m: f"({m.group(1)}*{_SI[m.group(2)]!r})", text.strip())
    node = ast.parse(src, mode="eval")

    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return float(n.value)
        if isinstance(n, ast.Name):
            if n.id not in env:
                raise ValueError(f"unknown name '{n.id}' in '{text}'")
            return env[n.id]
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.USub, ast.UAdd)):
            v = ev(n.operand)
            return -v if isinstance(n.op, ast.USub) else v
        if isinstance(n, ast.BinOp) and isinstance(n.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
            a, b = ev(n.left), ev(n.right)
            if isinstance(n.op, ast.Add):
                return a + b
            if isinstance(n.op, ast.Sub):
                return a - b
            if isinstance(n.op, ast.Mult):
                return a * b
            return a / b
        raise ValueError(f"unsupported expression '{text}'")
    return ev(node)


def _split_params(text):
    """'a=1 b="x y" c=2*p' -> {'a': '1', 'b': '"x y"', 'c': '2*p'}"""
    out = {}
    for m in re.finditer(r'(\w+)\s*=\s*("[^"]*"|\S+)', text):
        out[m.group(1)] = m.group(2)
    return out


def parse_netlist(path):
    """Minimal Spectre-language parser: returns dict with
    'parameters' (name -> float), 'instances' (name -> {nodes, master, params
    (raw strings)}), 'ahdl_include' (list of paths), 'analyses' (raw lines)."""
    with open(path) as f:
        raw = f.read().splitlines()
    lines, cur = [], ""
    for ln in raw:
        ln = ln.split("//", 1)[0].rstrip()
        if ln.endswith("\\"):
            cur += ln[:-1] + " "
            continue
        cur += ln
        if cur.strip():
            lines.append(cur.strip())
        cur = ""
    params, insts, incs, others = {}, {}, [], []
    for ln in lines:
        if ln.startswith("parameters "):
            for k, v in _split_params(ln[len("parameters "):]).items():
                params[k] = eval_expr(v, params)
            continue
        if ln.startswith("ahdl_include"):
            incs.append(ln.split('"')[1])
            continue
        m = re.match(r"^(\w+)\s*\(([^)]*)\)\s*(\w+)\s*(.*)$", ln)
        if m:
            insts[m.group(1)] = {"nodes": m.group(2).split(), "master": m.group(3),
                                 "params": _split_params(m.group(4))}
        else:
            others.append(ln)
    return {"parameters": params, "instances": insts, "ahdl_include": incs,
            "other": others}


def parse_va_module(path):
    """Return (module name, [ports], {param: default text})."""
    with open(path) as f:
        src = f.read()
    src_nc = re.sub(r"//[^\n]*", "", src)
    m = re.search(r"\bmodule\s+(\w+)\s*\(([^;]*)\)\s*;", src_nc)
    ports = [p.strip() for p in m.group(2).replace("\n", " ").split(",") if p.strip()]
    pars = {pm.group(1): pm.group(2).strip() for pm in re.finditer(
        r"\bparameter\s+(?:real|integer)\s+(\w+)\s*=\s*([^;]*?)(?:\s+from\s+[^;]*)?;", src_nc)}
    return m.group(1), ports, pars


def wrap01(x):
    return x - math.floor(x)


def wrap_cycles(x):
    y = x - math.floor(x)
    if y > 0.5:
        y -= 1.0
    return y


def wrap_radians(t):
    two_pi = 2.0 * math.pi
    return two_pi * wrap_cycles(t / two_pi)
