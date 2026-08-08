/**
 * Acceptance Test 1 (MODEL_SPEC section 19): canonical constants, plus the
 * frequency table of section 11.  Mirror of tests/test_units_constants.py.
 */

import { describe, expect, it } from 'vitest';
import { dtcLsbS, fVcoHz, gFine, phaseLsbDeg, tVco } from '../units';

describe('units and canonical constants (Test 1)', () => {
  it('N=3.125 canonical constants', () => {
    // N=3.125, f_ref=4 GHz -> f_vco=12.5 GHz, T_vco=80 ps
    const tvco = tVco(3.125, 4e9);
    expect(Math.abs(tvco - 80e-12)).toBeLessThanOrEqual(1e-24);
    // 1 LSB = 80 ps / 256 = 312.5 fs
    const lsb = dtcLsbS(3.125, 4e9, 'normalized');
    expect(Math.abs(lsb - 312.5e-15)).toBeLessThanOrEqual(1e-27);
    // phase LSB = 360/256 = 1.40625 deg; half-LSB = 0.703125 deg
    expect(phaseLsbDeg(256)).toBe(1.40625);
    expect(phaseLsbDeg(256) / 2).toBe(0.703125);
    // half-LSB in time = 156.25 fs
    expect(Math.abs(lsb / 2 - 156.25e-15)).toBeLessThanOrEqual(1e-27);
  });

  it('check values of section 1', () => {
    expect(fVcoHz(3.0, 4e9)).toBeCloseTo(12.0e9, 0);
    expect(tVco(3.0, 4e9)).toBeCloseTo(83.3333333333e-12, 20);
    expect(fVcoHz(3.125, 4e9)).toBeCloseTo(12.5e9, 0);
    expect(tVco(3.125, 4e9)).toBeCloseTo(80.0e-12, 22);
    expect(fVcoHz(3.25, 4e9)).toBeCloseTo(13.0e9, 0);
    expect(tVco(3.25, 4e9)).toBeCloseTo(76.923076923e-12, 20);
  });

  it('frequency table of section 11 (normalized LSB)', () => {
    const table: Array<[number, number]> = [
      [3.0, 325.5208333333],
      [3.125, 312.5],
      [3.25, 300.4807692308],
    ];
    for (const [n, lsbFs] of table) {
      const got = dtcLsbS(n, 4e9, 'normalized') / 1e-15;
      expect(Math.abs(got - lsbFs) / lsbFs).toBeLessThan(1e-9);
    }
  });

  it('fixed-time LSB independent of N; phase LSB scales with f_vco', () => {
    for (const n of [3.0, 3.125, 3.25]) {
      const got = dtcLsbS(n, 4e9, 'fixed_time', 312.5);
      expect(Math.abs(got - 312.5e-15) / 312.5e-15).toBeLessThan(1e-12);
    }
    expect(phaseLsbDeg(256, 3.125, 4e9, 'fixed_time')).toBeCloseTo(1.40625, 9);
    expect(phaseLsbDeg(256, 3.25, 4e9, 'fixed_time')).toBeGreaterThan(1.40625);
  });

  it('G = N_PMUX * 2^B_DTC = 256', () => {
    expect(gFine(4, 6)).toBe(256);
  });
});
