"""Example 2: architecture mode comparison (A/B/C/D).

Shows why mode D (quantize once + modular reverse) is the recommended
architecture: its digital pair error is identically zero, while independent
quantization (A/B/C) leaves +/-1 LSB cycle-by-cycle pair errors.

    python3 examples/ex2_compare_modes.py
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import numpy as np                              # noqa: E402

from model.python.config import SimConfig       # noqa: E402
from model.python.simulate import simulate      # noqa: E402


def main():
    print("N = 3.13, quantizer = ef1, 512 cycles")
    print(f"{'mode':6s} {'pair rms [LSB]':>15s} {'pair max [LSB]':>15s} "
          f"{'nonzero cycles':>15s}")
    for mode in ["A", "B", "C", "D"]:
        cfg = SimConfig(n_div=3.13, quantizer="ef1", arch_mode=mode)
        res = simulate(cfg)
        pair_lsb = res.data["e_pair_digital"] * 256.0
        print(f"{mode:6s} {np.sqrt(np.mean(pair_lsb ** 2)):15.4f} "
              f"{np.max(np.abs(pair_lsb)):15.4f} "
              f"{int(np.count_nonzero(pair_lsb)):15d}")
    print("\nmode D: R_INJ = (R_zero - R_FB) mod 256 -> e_pair_digital == 0 "
          "exactly (MODEL_SPEC section 7);")
    print("modes A/B/C re-quantize independently -> the exact reverse pairing "
          "is lost cycle-by-cycle.")


if __name__ == "__main__":
    main()
