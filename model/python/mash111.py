"""MASH 1-1-1 phase quantizer.

Contract: MODEL_SPEC.md section 6 item 6 [EXACT]:

    M = floor(u); f = u - M
    acc1 += f;    c1 = floor(acc1); acc1 -= c1
    acc2 += acc1; c2 = floor(acc2); acc2 -= c2
    acc3 += acc2; c3 = floor(acc3); acc3 -= c3
    y = M + c1 + (c2 - c2_prev) + (c3 - 2*c3_prev + c3_prev2)
    c2_prev = c2;  c3_prev2 = c3_prev;  c3_prev = c3

(states updated in exactly that order; acc1, acc2, acc3, c2_prev, c3_prev,
c3_prev2 all init 0)
"""

import math


class Mash111:
    """MASH 1-1-1 quantizer with persistent state."""

    def __init__(self):
        self.acc1 = 0.0
        self.acc2 = 0.0
        self.acc3 = 0.0
        self.c2_prev = 0
        self.c3_prev = 0
        self.c3_prev2 = 0

    def reset(self):
        self.acc1 = 0.0
        self.acc2 = 0.0
        self.acc3 = 0.0
        self.c2_prev = 0
        self.c3_prev = 0
        self.c3_prev2 = 0

    def quantize(self, u: float) -> int:
        m = math.floor(u)
        f = u - m
        self.acc1 += f
        c1 = math.floor(self.acc1)
        self.acc1 -= c1
        self.acc2 += self.acc1
        c2 = math.floor(self.acc2)
        self.acc2 -= c2
        self.acc3 += self.acc2
        c3 = math.floor(self.acc3)
        self.acc3 -= c3
        y = m + c1 + (c2 - self.c2_prev) + (c3 - 2 * self.c3_prev + self.c3_prev2)
        self.c2_prev = c2
        self.c3_prev2 = self.c3_prev
        self.c3_prev = c3
        return y

    @property
    def state(self) -> float:
        """First-stage accumulator (reported as dsm_state)."""
        return self.acc1
