"""Behavioral DTC model with gain / offset / INL / DNL nonidealities.

Contract: MODEL_SPEC.md sections 10, 11 [ASSUMPTION].

Delay in cycles for code c (0 .. 2^b_dtc - 1):

    delay(c) = gain * c * lsb_cyc
             + offset_cycles
             + inl_sin_amp * sin(2*pi*c/64)
             + p2*(c/63)^2 + p3*(c/63)^3
             + inl_lut[c]
             + dnl_cum[c] * lsb_cyc

lsb_cyc = 1/G (normalized mode) or (dtc_lsb_fs*1e-15)/T_vco (fixed_time mode).

DNL is a frozen per-code cumulative random walk drawn once per DTC instance
from its named stream: dnl_cum[0] = 0; dnl_cum[c] = dnl_cum[c-1] +
dnl_sigma_lsb * gauss()  (units: LSB).  [Resolved ambiguity: code 0 carries no
DNL; steps for codes 1..n_codes-1 accumulate — DNL steps integrate into INL.]
"""

import math

import numpy as np

from .noise_models import Mulberry32


class DTCModel:
    def __init__(self,
                 n_codes: int = 64,
                 lsb_cycles: float = 1.0 / 256.0,
                 gain: float = 1.0,
                 offset_cycles: float = 0.0,
                 inl_sin_amp_cycles: float = 0.0,
                 inl_poly=(0.0, 0.0),
                 inl_lut=None,
                 dnl_sigma_lsb: float = 0.0,
                 dnl_stream: Mulberry32 | None = None):
        self.n_codes = n_codes
        self.lsb_cycles = lsb_cycles
        self.gain = gain
        self.offset_cycles = offset_cycles

        c = np.arange(n_codes, dtype=np.float64)

        # DNL: frozen per-code cumulative error (LSB), code 0 = 0
        dnl_cum = np.zeros(n_codes, dtype=np.float64)
        if dnl_sigma_lsb != 0.0:
            if dnl_stream is None:
                raise ValueError("dnl_sigma_lsb != 0 requires a dnl_stream")
            acc = 0.0
            for i in range(1, n_codes):
                acc += dnl_sigma_lsb * dnl_stream.gauss()
                dnl_cum[i] = acc
        self.dnl_cum_lsb = dnl_cum

        p2 = inl_poly[0] if len(inl_poly) > 0 else 0.0
        p3 = inl_poly[1] if len(inl_poly) > 1 else 0.0
        lut = np.zeros(n_codes) if inl_lut is None else np.asarray(inl_lut, dtype=np.float64)

        denom = float(n_codes - 1)  # 63 for 6-bit
        self.table = (gain * c * lsb_cycles
                      + offset_cycles
                      + inl_sin_amp_cycles * np.sin(2.0 * math.pi * c / n_codes)
                      + p2 * (c / denom) ** 2 + p3 * (c / denom) ** 3
                      + lut
                      + dnl_cum * lsb_cycles)

    def delay_cycles(self, code):
        """Actual DTC delay in cycles for integer code(s)."""
        return self.table[code]

    def ideal_delay_cycles(self, code):
        """Ideal delay c * lsb_cyc (no nonidealities)."""
        return np.asarray(code, dtype=np.float64) * self.lsb_cycles


def make_dtc(cfg, path: str, streams: dict) -> DTCModel:
    """Build the FB ('fb') or INJ ('inj') DTC model from a SimConfig.

    Uses stream 'dnl_fb' / 'dnl_inj' respectively (frozen per instance).
    """
    from .units import FS

    n_codes = 1 << cfg.b_dtc
    if cfg.dtc_mode == "normalized":
        lsb_cyc = 1.0 / cfg.g
    else:  # fixed_time
        lsb_cyc = (cfg.dtc_lsb_fs * FS) / cfg.t_vco_s

    if path == "fb":
        gain, off, stream = cfg.dtc_fb_gain, cfg.dtc_fb_offset_cycles, streams["dnl_fb"]
    elif path == "inj":
        gain, off, stream = cfg.dtc_inj_gain, cfg.dtc_inj_offset_cycles, streams["dnl_inj"]
    else:
        raise ValueError("path must be 'fb' or 'inj'")

    return DTCModel(n_codes=n_codes,
                    lsb_cycles=lsb_cyc,
                    gain=gain,
                    offset_cycles=off,
                    inl_sin_amp_cycles=cfg.inl_sin_amp_cycles,
                    inl_poly=tuple(cfg.inl_poly),
                    inl_lut=cfg.inl_lut,
                    dnl_sigma_lsb=cfg.dnl_sigma_lsb,
                    dnl_stream=stream)
