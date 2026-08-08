"""Wrap conventions and quantization primitives.

Contract: MODEL_SPEC.md section 2 [EXACT].

These helpers MUST be implemented identically (character-for-character
semantics) in Python and TypeScript.  The language built-in ``round()`` is
FORBIDDEN (Python uses banker's rounding, JS half-up); ``q_nearest`` is
defined as floor(x + 0.5) so both languages agree bit-for-bit.

Scalar versions use math.floor; ``*_arr`` versions are numpy-vectorized with
identical semantics (np.floor == math.floor on float64).
"""

import math

import numpy as np

TWO_PI = 2.0 * math.pi


def wrap01(x: float) -> float:
    """x - floor(x)  ->  [0, 1)."""
    return x - math.floor(x)


def wrap_cycles(x: float) -> float:
    """y = x - floor(x); if y > 0.5: y -= 1  ->  (-0.5, 0.5]."""
    y = x - math.floor(x)
    if y > 0.5:
        y -= 1.0
    return y


def wrap_radians(t: float) -> float:
    """2*pi * wrap_cycles(t / (2*pi))  ->  (-pi, pi]."""
    return TWO_PI * wrap_cycles(t / TWO_PI)


def cycles_to_time(x: float, t_vco: float) -> float:
    """cycles -> seconds."""
    return x * t_vco


def cycles_to_degrees(x: float) -> float:
    """cycles -> degrees (1 cycle = 360 deg)."""
    return 360.0 * x


def cycles_to_radians(x: float) -> float:
    """cycles -> radians (1 cycle = 2*pi rad)."""
    return TWO_PI * x


def time_to_cycles(t: float, t_vco: float) -> float:
    """seconds -> cycles."""
    return t / t_vco


def q_floor(x: float) -> int:
    """floor quantizer."""
    return math.floor(x)


def q_nearest(x: float) -> int:
    """Half-up nearest quantizer: floor(x + 0.5).

    NEVER use Python round() (banker's rounding) — q_nearest(2.5) == 3.
    """
    return math.floor(x + 0.5)


# ---------------------------------------------------------------------------
# numpy-vectorized versions (identical semantics, float64)
# ---------------------------------------------------------------------------

def wrap01_arr(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    return x - np.floor(x)


def wrap_cycles_arr(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    y = x - np.floor(x)
    y = np.where(y > 0.5, y - 1.0, y)
    return y


def wrap_radians_arr(t: np.ndarray) -> np.ndarray:
    t = np.asarray(t, dtype=np.float64)
    return TWO_PI * wrap_cycles_arr(t / TWO_PI)
