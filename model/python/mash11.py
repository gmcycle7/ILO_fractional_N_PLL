"""MASH 1-1 phase quantizer.

Contract: MODEL_SPEC.md section 6 item 5 [EXACT]:

    M = floor(u); f = u - M
    acc1 += f;    c1 = floor(acc1); acc1 -= c1
    acc2 += acc1; c2 = floor(acc2); acc2 -= c2
    y = M + c1 + (c2 - c2_prev);  c2_prev = c2

(acc1, acc2, c2_prev init 0)
"""

import math


class Mash11:
    """MASH 1-1 quantizer with persistent state."""

    def __init__(self):
        self.acc1 = 0.0
        self.acc2 = 0.0
        self.c2_prev = 0

    def reset(self):
        self.acc1 = 0.0
        self.acc2 = 0.0
        self.c2_prev = 0

    def quantize(self, u: float) -> int:
        m = math.floor(u)
        f = u - m
        self.acc1 += f
        c1 = math.floor(self.acc1)
        self.acc1 -= c1
        self.acc2 += self.acc1
        c2 = math.floor(self.acc2)
        self.acc2 -= c2
        y = m + c1 + (c2 - self.c2_prev)
        self.c2_prev = c2
        return y

    @property
    def state(self) -> float:
        """First-stage accumulator (reported as dsm_state)."""
        return self.acc1
