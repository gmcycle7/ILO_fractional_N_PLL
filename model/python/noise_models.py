"""Deterministic PRNG and Gaussian generation.

Contract: MODEL_SPEC.md section 12 [EXACT] — mulberry32, bit-identical between
Python and TypeScript.  All arithmetic is uint32 (masked with & 0xFFFFFFFF
after every multiply/add); ``>>`` is a logical right shift (Python ints are
non-negative here so ``>>`` is already logical).

Named streams (seed = base_seed + offset):
    ref:1  vco_w:2  vco_rw:3  dither_fb:4  dither_inj:5
    dnl_fb:6  dnl_inj:7  lat:8  pulse:9  dsm_inj:10
"""

import math

_MASK = 0xFFFFFFFF
_TWO32 = 4294967296.0  # 2^32

STREAM_OFFSETS = {
    "ref": 1,
    "vco_w": 2,
    "vco_rw": 3,
    "dither_fb": 4,
    "dither_inj": 5,
    "dnl_fb": 6,
    "dnl_inj": 7,
    "lat": 8,
    "pulse": 9,
    "dsm_inj": 10,
}


class Mulberry32:
    """mulberry32 PRNG, bit-exact per MODEL_SPEC section 12."""

    def __init__(self, seed: int):
        self.s = seed & _MASK
        self._gauss_cache = None

    def next(self) -> float:
        """Uniform in [0, 1) with 32-bit resolution."""
        self.s = (self.s + 0x6D2B79F5) & _MASK
        t = self.s
        t = ((t ^ (t >> 15)) * (t | 1)) & _MASK
        t = ((t + (((t ^ (t >> 7)) * (t | 61)) & _MASK)) & _MASK) ^ t
        return ((t ^ (t >> 14)) & _MASK) / _TWO32

    def next_uint32(self) -> int:
        """Raw uint32 output (next() * 2^32 as integer)."""
        self.s = (self.s + 0x6D2B79F5) & _MASK
        t = self.s
        t = ((t ^ (t >> 15)) * (t | 1)) & _MASK
        t = ((t + (((t ^ (t >> 7)) * (t | 61)) & _MASK)) & _MASK) ^ t
        return (t ^ (t >> 14)) & _MASK

    def gauss(self) -> float:
        """Standard normal via Box-Muller, generated in pairs (z1 cached).

        u1 = next(); if u1 == 0: u1 = 2^-32
        u2 = next()
        r  = sqrt(-2*ln(u1))
        z0 = r*cos(2*pi*u2);  z1 = r*sin(2*pi*u2)
        """
        if self._gauss_cache is not None:
            z = self._gauss_cache
            self._gauss_cache = None
            return z
        u1 = self.next()
        if u1 == 0.0:
            u1 = 2.0 ** -32
        u2 = self.next()
        r = math.sqrt(-2.0 * math.log(u1))
        z0 = r * math.cos(2.0 * math.pi * u2)
        z1 = r * math.sin(2.0 * math.pi * u2)
        self._gauss_cache = z1
        return z0


def make_stream(name: str, base_seed: int = 12345) -> Mulberry32:
    """Named noise stream: seed = base_seed + STREAM_OFFSETS[name]."""
    if name not in STREAM_OFFSETS:
        raise KeyError(f"unknown stream '{name}'; valid: {sorted(STREAM_OFFSETS)}")
    return Mulberry32(base_seed + STREAM_OFFSETS[name])


def make_all_streams(base_seed: int = 12345) -> dict:
    """All named streams, each an independent Mulberry32 instance."""
    return {name: Mulberry32(base_seed + off) for name, off in STREAM_OFFSETS.items()}
