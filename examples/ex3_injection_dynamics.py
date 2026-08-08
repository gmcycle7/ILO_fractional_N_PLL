"""Example 3: injection dynamics (MODEL_SPEC section 14).

Sweeps the lumped injection strength K_inj with a 1 MHz VCO detuning and
compares the simulated steady-state residual against the analytic sinusoidal
fixed point theta_ss = asin(2*pi*Delta_f*T_ref / K_inj).

    python3 examples/ex3_injection_dynamics.py
"""

import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import numpy as np                                              # noqa: E402

from model.python.config import SimConfig                       # noqa: E402
from model.python.injection_dynamics import (                   # noqa: E402
    lock_condition, sin_fixed_point_rad)
from model.python.simulate import simulate                      # noqa: E402

F_REF = 4e9
DF = 1e6  # 1 MHz detuning


def main():
    a = 2 * math.pi * DF / F_REF
    print(f"detuning ramp per cycle: 2*pi*Delta_f*T_ref = {a:.6e} rad")
    print(f"{'K_inj':>7s} {'locked':>7s} {'sim ss e_inj [rad]':>20s} "
          f"{'asin fixed point':>18s} {'residual rms [mrad]':>20s}")
    for k_inj in [0.0, 0.002, 0.05, 0.1, 0.3, 0.6, 0.9]:
        cfg = SimConfig(n_div=3.125, inj_model="sin", k_inj=k_inj,
                        delta_f_hz=DF)
        res = simulate(cfg)
        e = res.data["e_inj"]
        tail_rms = float(np.sqrt(np.mean(e[-128:] ** 2)))
        locked = lock_condition(k_inj, DF, F_REF)
        fp = sin_fixed_point_rad(k_inj, DF, F_REF)
        fp_s = f"{fp:18.6e}" if fp is not None else f"{'-':>18s}"
        print(f"{k_inj:7.3f} {str(locked):>7s} {e[-1]:20.6e} {fp_s} "
              f"{tail_rms * 1e3:20.4f}")
    print("\nK_inj = 0: no correction (detuning ramp / random walk);")
    print("K_inj below 2*pi*Delta_f*T_ref: outside lock range, residual "
          "cycles;")
    print("larger K_inj: faster convergence, smaller steady-state residual "
          "(sim matches asin fixed point).")


if __name__ == "__main__":
    main()
