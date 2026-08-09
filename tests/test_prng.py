"""MODEL_SPEC section 12: mulberry32 bit-exact PRNG.

The five hardcoded values below are the reference constants for the
TypeScript implementation (mulberry32 seeded with 12345).
"""

import pytest

from model.python.noise_models import Mulberry32, make_stream, make_all_streams, STREAM_OFFSETS

# first 5 outputs of mulberry32(12345) — cross-language reference constants
MULBERRY32_12345_FIRST5 = [
    0.9797282677609473,
    0.3067522644996643,
    0.484205421525985,
    0.817934412509203,
    0.5094283693470061,
]


def test_mulberry32_12345_first5_hardcoded():
    r = Mulberry32(12345)
    for expected in MULBERRY32_12345_FIRST5:
        assert r.next() == expected  # bit-exact


def test_uniform_range():
    r = Mulberry32(1)
    for _ in range(1000):
        u = r.next()
        assert 0.0 <= u < 1.0


def test_named_stream_offsets():
    assert STREAM_OFFSETS == {"ref": 1, "vco_w": 2, "vco_rw": 3,
                              "dither_fb": 4, "dither_inj": 5, "dnl_fb": 6,
                              "dnl_inj": 7, "lat": 8, "pulse": 9,
                              "dsm_inj": 10}
    # stream seed = base_seed + offset
    s = make_stream("ref", 12345)
    assert s.next() == Mulberry32(12346).next()
    streams = make_all_streams(12345)
    assert streams["pulse"].next() == Mulberry32(12345 + 9).next()
    assert streams["dsm_inj"].next() == Mulberry32(12345 + 10).next()


def test_gaussian_pairs_deterministic_and_cached():
    a = Mulberry32(777)
    b = Mulberry32(777)
    # two gauss() calls consume exactly two uniforms (pair generation)
    g0, g1 = a.gauss(), a.gauss()
    u1, u2 = b.next(), b.next()
    import math
    r = math.sqrt(-2 * math.log(u1))
    assert g0 == pytest.approx(r * math.cos(2 * math.pi * u2), abs=0)
    assert g1 == pytest.approx(r * math.sin(2 * math.pi * u2), abs=0)
    # deterministic across instances
    d, e = Mulberry32(999), Mulberry32(999)
    assert [d.gauss() for _ in range(6)] == [e.gauss() for _ in range(6)]
