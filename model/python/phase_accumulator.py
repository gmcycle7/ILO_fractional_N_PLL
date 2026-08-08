"""Ideal fractional phase trajectory.

Contract: MODEL_SPEC.md section 3 [EXACT].

s_ideal[k] = s0 + k*N computed by MULTIPLICATION (never by accumulation) so
float64 results are bit-identical between Python and TypeScript.
"""

import numpy as np

from .phase_math import wrap01_arr


def s_ideal(n_cycles: int, n_div: float, s0: float = 0.0) -> np.ndarray:
    """Absolute VCO phase coordinate at reference edge k (cycles).

    s_ideal[k] = s0 + k * N   (multiplication, not accumulation)
    """
    k = np.arange(n_cycles, dtype=np.float64)
    return s0 + k * n_div


def x_ideal(n_cycles: int, n_div: float, s0: float = 0.0) -> np.ndarray:
    """Fractional phase state x_ideal[k] = wrap01(s_ideal[k])."""
    return wrap01_arr(s_ideal(n_cycles, n_div, s0))


def a_ideal(n_cycles: int, n_div: float, s0: float = 0.0, g: int = 256) -> np.ndarray:
    """High-resolution ideal fine code A_ideal[k] = G * s_ideal[k] (real)."""
    return g * s_ideal(n_cycles, n_div, s0)
