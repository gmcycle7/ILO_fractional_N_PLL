/**
 * Acceptance Test 12: PSD sample rate = f_ref (axis ends at f_ref/2), plus
 * basic measurement helpers.  Mirror of tests/test_measurements.py.
 */

import { describe, expect, it } from 'vitest';
import { fromPartial } from '../config';
import {
  detectSpurs,
  histogram,
  integratedPhase,
  mean,
  peakToPeak,
  periodogramPsd,
  psdToDbcPerHz,
  rms,
  toneAmpToDbc,
} from '../measurements';
import { Mulberry32 } from '../rng';
import { simulate } from '../simulate';

const F_REF = 4e9;

describe('measurements (Test 12)', () => {
  it('PSD frequency axis ends exactly at f_ref/2', () => {
    const res = simulate(fromPartial({ n_div: 3.13 }));
    const phi = Float64Array.from(res.data.e_ZC_total, (v) => 2 * Math.PI * v);
    const { freqsHz, psd } = periodogramPsd(phi, F_REF);
    expect(freqsHz[freqsHz.length - 1]).toBe(F_REF / 2); // exact
    expect(psd.length).toBe(freqsHz.length);
  });

  it('sequence is truncated to a power of 2', () => {
    const r = new Mulberry32(0);
    const x = Float64Array.from({ length: 1000 }, () => r.gauss()); // not a power of 2
    const { freqsHz } = periodogramPsd(x, F_REF);
    const n = 2 * (freqsHz.length - 1);
    expect(n).toBe(512); // truncated down to 2^9
    expect(freqsHz[freqsHz.length - 1]).toBe(F_REF / 2);
  });

  it('white noise PSD integrates to its variance', () => {
    const r = new Mulberry32(1);
    const x = Float64Array.from({ length: 4096 }, () => r.gauss());
    const { freqsHz, psd } = periodogramPsd(x, F_REF);
    const df = freqsHz[1] - freqsHz[0];
    let sum = 0;
    for (const p of psd) sum += p;
    const mu = mean(x);
    let varX = 0;
    for (const v of x) varX += (v - mu) * (v - mu);
    varX /= x.length;
    expect(Math.abs(sum * df - varX) / varX).toBeLessThan(0.15);
  });

  it('tone detection finds the spur at (m/P)*f_ref', () => {
    // period-P sequence -> spur at (m/P)*f_ref
    const n = 1024;
    const p = 8;
    const x = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      x[k] = 0.01 * Math.sin((2 * Math.PI * k) / p);
    }
    const { freqsHz, psd } = periodogramPsd(x, F_REF);
    const spurs = detectSpurs(freqsHz, psd, 20);
    expect(spurs.length).toBeGreaterThan(0);
    expect(Math.abs(spurs[0].freqHz - F_REF / p) / (F_REF / p)).toBeLessThan(1e-12);
  });

  it('basic statistics', () => {
    const x = [1.0, -1.0, 1.0, -1.0];
    expect(rms(x)).toBe(1.0);
    expect(peakToPeak(x)).toBe(2.0);
    expect(mean(x)).toBe(0.0);
    const { counts } = histogram(x, 4);
    let total = 0;
    for (const c of counts) total += c;
    expect(total).toBe(4);
  });

  it('dBc conventions', () => {
    // tone amplitude a rad -> SSB spur 20*log10(a/2) dBc
    expect(toneAmpToDbc(0.02)).toBeCloseTo(20 * Math.log10(0.01), 12);
    const s = psdToDbcPerHz([2.0]);
    expect(s[0]).toBeCloseTo(0.0, 12);
  });

  it('integrated phase of a flat PSD', () => {
    const freqs = new Float64Array(513);
    const psd = new Float64Array(513);
    for (let i = 0; i < 513; i++) {
      freqs[i] = (2e9 * i) / 512;
      psd[i] = 1e-18;
    }
    const val = integratedPhase(freqs, psd, 0, 2e9);
    const expected = Math.sqrt(1e-18 * 2e9);
    expect(Math.abs(val - expected) / expected).toBeLessThan(1e-2);
  });
});
