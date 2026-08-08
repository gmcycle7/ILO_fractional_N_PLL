/**
 * Measurement conventions.
 *
 * Contract: MODEL_SPEC.md section 17 [EXACT].
 * Mirror of model/python/measurements.py (FFT implemented as plain radix-2
 * TypeScript — no external dependency).
 *
 * - Per-reference-cycle sequences are sampled at f_ref (NOT f_vco).
 * - FFT/PSD: sequence truncated to a power-of-2 length; Hann-window
 *   periodogram, one-sided.  The frequency axis therefore ends exactly at
 *   f_ref/2.
 * - dBc convention: for a phase sequence phi[k] (rad) containing a tone of
 *   amplitude a rad, the small-angle SSB spur is 20*log10(a/2) dBc; a phase
 *   PSD S_phi (rad^2/Hz) is plotted as 10*log10(S_phi/2) dBc/Hz.  A phase
 *   PSD without carrier normalization must NOT be labeled dBc.
 */

/** Smallest positive normal float64 (np.finfo(float64).tiny). */
const FLOAT64_TINY = 2.2250738585072014e-308;

// --- basic statistics ---

export function rms(x: ArrayLike<number>): number {
  let s = 0.0;
  for (let i = 0; i < x.length; i++) {
    s += x[i] * x[i];
  }
  return Math.sqrt(s / x.length);
}

export function peakToPeak(x: ArrayLike<number>): number {
  let mx = -Infinity;
  let mn = Infinity;
  for (let i = 0; i < x.length; i++) {
    if (x[i] > mx) mx = x[i];
    if (x[i] < mn) mn = x[i];
  }
  return mx - mn;
}

export function mean(x: ArrayLike<number>): number {
  let s = 0.0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
  }
  return s / x.length;
}

/**
 * (counts, binEdges) of the sequence — numpy.histogram convention: linear
 * edges over [min, max]; every bin is half-open [e_i, e_{i+1}) except the
 * last which is closed.  min == max uses the range (min-0.5, max+0.5).
 */
export function histogram(
  x: ArrayLike<number>,
  bins: number = 32,
): { counts: Int32Array; edges: Float64Array } {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (x[i] < mn) mn = x[i];
    if (x[i] > mx) mx = x[i];
  }
  if (mn === mx) {
    mn -= 0.5;
    mx += 0.5;
  }
  const edges = new Float64Array(bins + 1);
  for (let i = 0; i <= bins; i++) {
    edges[i] = mn + ((mx - mn) * i) / bins;
  }
  const counts = new Int32Array(bins);
  const scale = bins / (mx - mn);
  for (let i = 0; i < x.length; i++) {
    let b = Math.floor((x[i] - mn) * scale);
    if (b === bins) b = bins - 1; // right edge of the last bin is closed
    if (b >= 0 && b < bins) counts[b] += 1;
  }
  return { counts, edges };
}

// --- FFT (plain radix-2, decimation-in-time) ---

/**
 * In-place iterative radix-2 complex FFT (forward, numpy sign convention
 * exp(-2*pi*i*k*n/N)).  Length must be a power of two.
 */
export function fftComplex(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new Error('fftComplex requires power-of-2 equal-length arrays');
  }
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2.0 * Math.PI) / len;
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + half] * wr - im[i + k + half] * wi;
        const vi = re[i + k + half] * wi + im[i + k + half] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
      }
    }
  }
}

/** Truncate to the largest power-of-2 length <= len(x); needs >= 2 samples. */
function pow2Truncate(x: ArrayLike<number>): Float64Array {
  const n = x.length;
  if (n < 2) {
    throw new Error('need at least 2 samples');
  }
  let p = 1;
  while (p * 2 <= n) {
    p *= 2;
  }
  const out = new Float64Array(p);
  for (let i = 0; i < p; i++) {
    out[i] = x[i];
  }
  return out;
}

/**
 * rfft of a real sequence (already power-of-2 length): returns the first
 * n/2 + 1 complex bins.
 */
function rfft(x: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = x.length;
  const re = Float64Array.from(x);
  const im = new Float64Array(n);
  fftComplex(re, im);
  const m = n / 2 + 1;
  return { re: re.subarray(0, m).slice(), im: im.subarray(0, m).slice() };
}

/** |FFT| of the power-of-2-truncated sequence (no window), one-sided. */
export function fftMag(x: ArrayLike<number>): Float64Array {
  const xt = pow2Truncate(x);
  const { re, im } = rfft(xt);
  const out = new Float64Array(re.length);
  for (let i = 0; i < re.length; i++) {
    out[i] = Math.hypot(re[i], im[i]);
  }
  return out;
}

/**
 * Hann-window periodogram PSD, one-sided, sample rate fs (= f_ref).
 *
 * Returns { freqsHz, psd } with psd in <x-units>^2/Hz.  The sequence is
 * truncated to a power-of-2 length N; freqsHz[last] == fs/2 exactly.
 * Window: periodic Hann w[n] = 0.5 - 0.5*cos(2*pi*n/N); normalization
 * U = mean(w^2) so white noise integrates to its variance.  One-sided
 * doubling applied to all bins except DC and Nyquist.
 */
export function periodogramPsd(
  x: ArrayLike<number>,
  fs: number,
): { freqsHz: Float64Array; psd: Float64Array } {
  const xt = pow2Truncate(x);
  const n = xt.length;
  const w = new Float64Array(n);
  let u = 0.0;
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / n);
    u += w[i] * w[i];
  }
  u /= n;
  const xw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xw[i] = xt[i] * w[i];
  }
  const { re, im } = rfft(xw);
  const m = re.length;
  const psd = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    psd[i] = (re[i] * re[i] + im[i] * im[i]) / (fs * n * u);
  }
  for (let i = 1; i < m - 1; i++) {
    psd[i] *= 2.0; // one-sided (DC and Nyquist not doubled)
  }
  // bin spacing fs/n (n is a power of 2 -> exact); freqs[last] == fs/2
  const freqsHz = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    freqsHz[i] = i * (fs / n);
  }
  return { freqsHz, psd };
}

/** numpy-style median (average of the two middle values for even length). */
function median(x: Float64Array): number {
  const s = Float64Array.from(x).sort();
  const n = s.length;
  const mid = n >> 1;
  return n % 2 === 1 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

export interface Spur {
  freqHz: number;
  psdDb: number;
}

/**
 * Local maxima of the PSD exceeding median + thresholdDb.
 * Returns list of { freqHz, psdDb } sorted by descending level.
 */
export function detectSpurs(
  freqs: ArrayLike<number>,
  psd: ArrayLike<number>,
  thresholdDb: number = 10.0,
): Spur[] {
  const n = psd.length;
  const pDb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    pDb[i] = 10.0 * Math.log10(Math.max(psd[i], FLOAT64_TINY));
  }
  const floorDb = median(pDb);
  const spurs: Spur[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (pDb[i] > floorDb + thresholdDb && pDb[i] >= pDb[i - 1] && pDb[i] >= pDb[i + 1]) {
      spurs.push({ freqHz: freqs[i], psdDb: pDb[i] });
    }
  }
  spurs.sort((a, b) => b.psdDb - a.psdDb);
  return spurs;
}

/**
 * RMS integrated phase over [fLo, fHi] (units of x, e.g. rad if the input
 * sequence was rad): sqrt(sum(S df)).
 */
export function integratedPhase(
  freqs: ArrayLike<number>,
  psd: ArrayLike<number>,
  fLo: number = 0.0,
  fHi: number | null = null,
): number {
  const hi = fHi === null ? freqs[freqs.length - 1] : fHi;
  let count = 0;
  let sum = 0.0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= fLo && freqs[i] <= hi) {
      count += 1;
      sum += psd[i];
    }
  }
  if (count < 2) {
    return 0.0;
  }
  const df = freqs[1] - freqs[0];
  return Math.sqrt(sum * df);
}

// --- dBc helpers ---

/**
 * SSB spur level (dBc) of a phase tone with amplitude a rad (small-angle):
 * 20*log10(a/2).
 */
export function toneAmpToDbc(aRad: number): number {
  return 20.0 * Math.log10(aRad / 2.0);
}

/** Phase PSD (rad^2/Hz) -> SSB dBc/Hz: 10*log10(S_phi/2). */
export function psdToDbcPerHz(sPhi: ArrayLike<number>): Float64Array {
  const out = new Float64Array(sPhi.length);
  for (let i = 0; i < sPhi.length; i++) {
    out[i] = 10.0 * Math.log10(Math.max(sPhi[i], FLOAT64_TINY) / 2.0);
  }
  return out;
}

export function db10(x: number): number {
  return 10.0 * Math.log10(x);
}

export function db20(x: number): number {
  return 20.0 * Math.log10(x);
}
