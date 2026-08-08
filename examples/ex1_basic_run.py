"""Example 1: basic run of the golden model.

Runs the recommended architecture (mode D, nearest, N=3.13) for 512 reference
cycles and prints the key error statistics.

    python3 examples/ex1_basic_run.py
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from model.python.config import SimConfig       # noqa: E402
from model.python.simulate import simulate      # noqa: E402


def main():
    cfg = SimConfig(n_div=3.13, quantizer="nearest", arch_mode="D")
    res = simulate(cfg)
    s = res.summary()

    print(f"N = {cfg.n_div}  f_vco = {s['f_vco_hz'] / 1e9:.3f} GHz  "
          f"T_vco = {res.t_vco_s / 1e-12:.4f} ps")
    print(f"{'signal':16s} {'rms [fs]':>12s} {'p2p [fs]':>12s} {'rms [deg]':>12s}")
    for name in ["e_FB_abs", "e_INJ_abs", "e_pair_digital", "e_ZC_hw"]:
        row = s[name]
        print(f"{name:16s} {row['rms_fs']:12.3f} {row['p2p_fs']:12.3f} "
              f"{row['rms_deg']:12.5f}")

    d = res.data
    print("\nfirst 8 cycles of the command stream:")
    print("k   x_ideal  R_FB R_INJ  m c_FB  j c_INJ  n_int")
    for k in range(8):
        print(f"{int(d['k'][k]):<3d} {d['x_ideal'][k]:8.4f} "
              f"{int(d['R_FB'][k]):4d} {int(d['R_INJ'][k]):5d} "
              f"{int(d['m_FB'][k]):2d} {int(d['c_FB'][k]):4d} "
              f"{int(d['j_INJ'][k]):2d} {int(d['c_INJ'][k]):5d} "
              f"{int(d['n_int'][k]):5d}")

    # mode D identity: e_pair_digital is exactly zero on every cycle
    assert all(v == 0.0 for v in d["e_pair_digital"])
    print("\nmode D identity holds: e_pair_digital == 0 for all "
          f"{cfg.n_cycles} cycles")


if __name__ == "__main__":
    main()
