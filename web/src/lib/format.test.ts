import { describe, expect, it } from 'vitest';
import {
  formatPhase,
  formatSiTime,
  makePhaseTickFormatter,
  phaseAxisLabel,
  phaseUnitLabel,
  trimNumber,
} from './format';

const T_VCO_80PS = 80e-12; // N = 3.125, f_vco = 12.5 GHz (MODEL_SPEC §9)

describe('trimNumber', () => {
  it('strips trailing zeros after significant rounding', () => {
    expect(trimNumber(90.00000000001, 4)).toBe('90');
    expect(trimNumber(-85.0000000001, 4)).toBe('-85');
    expect(trimNumber(0)).toBe('0');
    expect(trimNumber(1.40625, 6)).toBe('1.40625');
  });
});

describe('formatSiTime', () => {
  it('picks sensible SI prefixes', () => {
    expect(formatSiTime(80e-12)).toBe('80 ps');
    expect(formatSiTime(3.125e-13)).toBe('312.5 fs');
    expect(formatSiTime(-8.5e-14)).toBe('-85 fs');
    expect(formatSiTime(2.5e-10)).toBe('250 ps');
    expect(formatSiTime(1.5e-9)).toBe('1.5 ns');
    expect(formatSiTime(0)).toBe('0 s');
  });
});

describe('formatPhase (canonical MODEL_SPEC §9 values)', () => {
  it('cycles', () => {
    expect(formatPhase(0.337, 'cycles', T_VCO_80PS)).toBe('0.337 cyc');
  });

  it('degrees: 0.25 cycle = 90°, 1 LSB = 1.40625°', () => {
    expect(formatPhase(0.25, 'deg', T_VCO_80PS)).toBe('90°');
    expect(formatPhase(1 / 256, 'deg', T_VCO_80PS, 6)).toBe('1.40625°');
  });

  it('time: e_FB_abs = -0.0010625 cycle -> -85 fs at T_vco = 80 ps', () => {
    expect(formatPhase(-0.0010625, 'time', T_VCO_80PS)).toBe('-85 fs');
  });

  it('time: 1 LSB = 1/256 cycle -> 312.5 fs; 1 cycle -> 80 ps', () => {
    expect(formatPhase(1 / 256, 'time', T_VCO_80PS)).toBe('312.5 fs');
    expect(formatPhase(1, 'time', T_VCO_80PS)).toBe('80 ps');
  });
});

describe('axis helpers', () => {
  it('phaseUnitLabel picks the prefix from T_vco magnitude', () => {
    expect(phaseUnitLabel('cycles')).toBe('cycles');
    expect(phaseUnitLabel('deg')).toBe('deg');
    expect(phaseUnitLabel('time', T_VCO_80PS)).toBe('ps');
  });

  it('phaseAxisLabel composes name and unit', () => {
    expect(phaseAxisLabel('e_pair', 'time', T_VCO_80PS)).toBe('e_pair (ps)');
    expect(phaseAxisLabel('x_ideal', 'cycles')).toBe('x_ideal (cycles)');
  });

  it('tick formatter agrees with the axis label prefix', () => {
    const f = makePhaseTickFormatter('time', T_VCO_80PS);
    expect(f(1)).toBe('80'); // 1 cycle -> 80 (ps)
    expect(f(0.5)).toBe('40');
    const g = makePhaseTickFormatter('deg', T_VCO_80PS);
    expect(g(0.25)).toBe('90');
  });
});
