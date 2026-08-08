"""Measurement conventions.

Contract: MODEL_SPEC.md section 17 [EXACT].

- Per-reference-cycle sequences are sampled at f_ref (NOT f_vco).
- FFT/PSD: sequence truncated to a power-of-2 length; Hann-window
  periodogram, one-sided.  The frequency axis therefore ends exactly at
  f_ref/2.
- dBc convention: for a phase sequence phi[k] (rad) containing a tone of
  amplitude a rad, the small-angle SSB spur is 20*log10(a/2) dBc; a phase
  PSD S_phi (rad^2/Hz) is plotted as 10*log10(S_phi/2) dBc/Hz.  A phase PSD
  without carrier normalization must NOT be labeled dBc.
"""

import math

import numpy as np


# --- basic statistics ---

def rms(x) -> float:
    x = np.asarray(x, dtype=np.float64)
    return float(np.sqrt(np.mean(x * x)))


def peak_to_peak(x) -> float:
    x = np.asarray(x, dtype=np.float64)
    return float(np.max(x) - np.min(x))


def mean(x) -> float:
    return float(np.mean(np.asarray(x, dtype=np.float64)))


def histogram(x, bins: int = 32):
    """(counts, bin_edges) of the sequence."""
    counts, edges = np.histogram(np.asarray(x, dtype=np.float64), bins=bins)
    return counts, edges


# --- spectra ---

def _pow2_truncate(x: np.ndarray) -> np.ndarray:
    n = len(x)
    if n < 2:
        raise ValueError("need at least 2 samples")
    p = 1 << (n.bit_length() - 1)
    if p > n:
        p >>= 1
    return x[:p]


def fft_mag(x) -> np.ndarray:
    """|FFT| of the power-of-2-truncated sequence (no window), one-sided."""
    x = _pow2_truncate(np.asarray(x, dtype=np.float64))
    return np.abs(np.fft.rfft(x))


def periodogram_psd(x, fs: float):
    """Hann-window periodogram PSD, one-sided, sample rate fs (= f_ref).

    Returns (freqs_hz, psd) with psd in <x-units>^2/Hz.  The sequence is
    truncated to a power-of-2 length N; freqs_hz[-1] == fs/2 exactly.
    Window: periodic Hann w[n] = 0.5 - 0.5*cos(2*pi*n/N); normalization
    U = mean(w^2) so white noise integrates to its variance.  One-sided
    doubling applied to all bins except DC and Nyquist.
    """
    x = _pow2_truncate(np.asarray(x, dtype=np.float64))
    n = len(x)
    w = 0.5 - 0.5 * np.cos(2.0 * math.pi * np.arange(n) / n)
    u = np.mean(w * w)
    spec = np.fft.rfft(x * w)
    psd = (np.abs(spec) ** 2) / (fs * n * u)
    psd[1:-1] *= 2.0  # one-sided (DC and Nyquist not doubled)
    # bin spacing fs/n (n is a power of 2 -> exact); freqs[-1] == fs/2 exactly
    freqs = np.arange(n // 2 + 1, dtype=np.float64) * (fs / n)
    return freqs, psd


def detect_spurs(freqs: np.ndarray, psd: np.ndarray, threshold_db: float = 10.0):
    """Local maxima of the PSD exceeding median + threshold_db.

    Returns list of (freq_hz, psd_db) sorted by descending level.
    """
    eps = np.finfo(np.float64).tiny
    p_db = 10.0 * np.log10(np.maximum(psd, eps))
    floor_db = float(np.median(p_db))
    spurs = []
    for i in range(1, len(psd) - 1):
        if p_db[i] > floor_db + threshold_db and p_db[i] >= p_db[i - 1] and p_db[i] >= p_db[i + 1]:
            spurs.append((float(freqs[i]), float(p_db[i])))
    spurs.sort(key=lambda t: -t[1])
    return spurs


def integrated_phase(freqs: np.ndarray, psd: np.ndarray,
                     f_lo: float = 0.0, f_hi: float = None) -> float:
    """RMS integrated phase over [f_lo, f_hi] (units of x, e.g. rad if the
    input sequence was rad): sqrt(sum(S df))."""
    if f_hi is None:
        f_hi = float(freqs[-1])
    sel = (freqs >= f_lo) & (freqs <= f_hi)
    if np.count_nonzero(sel) < 2:
        return 0.0
    df = float(freqs[1] - freqs[0])
    return float(np.sqrt(np.sum(psd[sel]) * df))


# --- dBc helpers ---

def tone_amp_to_dbc(a_rad: float) -> float:
    """SSB spur level (dBc) of a phase tone with amplitude a rad
    (small-angle): 20*log10(a/2)."""
    return 20.0 * math.log10(a_rad / 2.0)


def psd_to_dbc_per_hz(s_phi: np.ndarray) -> np.ndarray:
    """Phase PSD (rad^2/Hz) -> SSB dBc/Hz: 10*log10(S_phi/2)."""
    eps = np.finfo(np.float64).tiny
    return 10.0 * np.log10(np.maximum(np.asarray(s_phi, dtype=np.float64), eps) / 2.0)


def db10(x: float) -> float:
    return 10.0 * math.log10(x)


def db20(x: float) -> float:
    return 20.0 * math.log10(x)
