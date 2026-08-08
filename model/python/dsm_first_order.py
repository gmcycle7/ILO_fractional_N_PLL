"""First-order error-feedback DSM quantizer (``ef1``).

Contract: MODEL_SPEC.md section 6 item 4 [EXACT]:

    state e (init 0)
    v = u + e
    y = floor(v)
    e = v - y        # e in [0, 1)
"""

import math


class ErrorFeedbackFirstOrder:
    """First-order error-feedback quantizer with persistent state."""

    def __init__(self):
        self.e = 0.0

    def reset(self):
        self.e = 0.0

    def quantize(self, u: float) -> int:
        v = u + self.e
        y = math.floor(v)
        self.e = v - y
        return y

    @property
    def state(self) -> float:
        """Current error-feedback state e in [0, 1)."""
        return self.e
