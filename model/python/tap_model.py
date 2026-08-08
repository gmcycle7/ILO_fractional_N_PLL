"""Injection tap and feedback PMUX phase models.

Contract: MODEL_SPEC.md sections 4, 5, 10 [EXACT nominal + ASSUMPTION mismatch].

    tap_actual(j)  = j/N_TAP  + delta_tap[j]     (cycles)
    pmux_actual(m) = m/N_PMUX + delta_pmux[m]    (cycles)
"""

import numpy as np


def tap_actual(j: int, n_tap: int = 8, delta_tap=None) -> float:
    """Actual phase of injection tap j (cycles)."""
    d = 0.0 if delta_tap is None else delta_tap[j]
    return j / n_tap + d


def pmux_actual(m: int, n_pmux: int = 4, delta_pmux=None) -> float:
    """Actual phase of feedback PMUX phase m (cycles)."""
    d = 0.0 if delta_pmux is None else delta_pmux[m]
    return m / n_pmux + d


def tap_table(n_tap: int = 8, delta_tap=None) -> np.ndarray:
    """Vector of actual tap phases (cycles)."""
    j = np.arange(n_tap, dtype=np.float64)
    d = np.zeros(n_tap) if delta_tap is None else np.asarray(delta_tap, dtype=np.float64)
    return j / n_tap + d


def pmux_table(n_pmux: int = 4, delta_pmux=None) -> np.ndarray:
    """Vector of actual PMUX phases (cycles)."""
    m = np.arange(n_pmux, dtype=np.float64)
    d = np.zeros(n_pmux) if delta_pmux is None else np.asarray(delta_pmux, dtype=np.float64)
    return m / n_pmux + d
