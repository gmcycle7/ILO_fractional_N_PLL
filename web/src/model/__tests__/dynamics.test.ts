/**
 * Acceptance Test 14: injection dynamics trends (MODEL_SPEC section 14).
 * Mirror of tests/test_dynamics.py.
 */

import { describe, expect, it } from 'vitest';
import type { InjModel, SimConfig } from '../config';
import { fromPartial } from '../config';
import { lockCondition, sinFixedPointRad } from '../injectionDynamics';
import { simulate } from '../simulate';

const F_REF = 4e9;
const T_REF = 1.0 / F_REF;
const DF = 1e6; // 1 MHz detuning
const A = 2 * Math.PI * DF * T_REF; // per-cycle detuning phase ramp (rad)

function run(kInj: number, model: InjModel = 'sin', noise = 0.0, nDiv = 3.125, df = DF) {
  const cfg: SimConfig = fromPartial({
    n_div: nDiv,
    inj_model: model,
    k_inj: kInj,
    delta_f_hz: df,
    sigma_vco_w_rad: noise,
  });
  return simulate(cfg);
}

function rmsOf(x: ArrayLike<number>, from = 0): number {
  let s = 0;
  let n = 0;
  for (let i = from < 0 ? x.length + from : from; i < x.length; i++) {
    s += x[i] * x[i];
    n += 1;
  }
  return Math.sqrt(s / n);
}

function meanAbs(x: ArrayLike<number>, from = 0): number {
  let s = 0;
  let n = 0;
  for (let i = from < 0 ? x.length + from : from; i < x.length; i++) {
    s += Math.abs(x[i]);
    n += 1;
  }
  return s / n;
}

describe('injection dynamics trends (Test 14)', () => {
  it('K_inj = 0 gives no correction (detuning ramp)', () => {
    const res = run(0.0);
    const d = res.data;
    for (const v of d.delta_theta) {
      // no correction at all (== 0 comparison so -0.0 counts, as in numpy)
      expect(v === 0.0).toBe(true);
    }
    // detuning ramp: theta_minus grows linearly, e_inj = wrapped ramp
    expect(Math.abs(d.theta_minus[100] - 101 * A) / (101 * A)).toBeLessThan(1e-9);
    const rampRms = rmsOf(d.e_inj);
    const lockedRms = rmsOf(run(0.3).data.e_inj);
    expect(rampRms).toBeGreaterThan(10 * lockedRms);
  });

  it('larger K_inj gives smaller steady-state residual (asin fixed points)', () => {
    // noise off, detuning within lock range for both gains
    expect(lockCondition(0.05, DF, F_REF)).toBe(true);
    expect(lockCondition(0.6, DF, F_REF)).toBe(true);
    const rmsWeak = rmsOf(run(0.05).data.e_inj, -128);
    const rmsStrong = rmsOf(run(0.6).data.e_inj, -128);
    expect(rmsStrong).toBeLessThan(rmsWeak);
    // steady-state values ~ asin(a/K): monotone decreasing in K
    expect(Math.abs(rmsWeak - Math.asin(A / 0.05)) / Math.asin(A / 0.05)).toBeLessThan(1e-3);
    expect(Math.abs(rmsStrong - Math.asin(A / 0.6)) / Math.asin(A / 0.6)).toBeLessThan(1e-3);
  });

  it('sin steady state matches the asin fixed point', () => {
    const res = run(0.3, 'sin');
    const ss = sinFixedPointRad(0.3, DF, F_REF);
    expect(ss).not.toBeNull();
    expect(Math.abs((ss as number) - Math.asin(A / 0.3))).toBeLessThan(1e-12);
    const last = res.data.e_inj[res.data.e_inj.length - 1];
    expect(Math.abs(last - (ss as number))).toBeLessThan(1e-6);
  });

  it('the three models show reasonable trends', () => {
    const eReset = simulate(fromPartial({ n_div: 3.125, inj_model: 'reset', delta_f_hz: DF }));
    const meanReset = meanAbs(eReset.data.e_inj, -128);
    const meanLin = meanAbs(run(0.3, 'linear').data.e_inj, -128);
    const meanSin = meanAbs(run(0.3, 'sin').data.e_inj, -128);
    const meanNone = meanAbs(run(0.0, 'none').data.e_inj, -128);
    // reset leaves only the per-cycle detuning step
    expect(Math.abs(meanReset - A) / A).toBeLessThan(1e-6);
    // linear ss residual a/K; sin ss residual asin(a/K) >= a/K; both << none
    expect(Math.abs(meanLin - A / 0.3) / (A / 0.3)).toBeLessThan(1e-3);
    expect(meanSin).toBeGreaterThanOrEqual(meanLin - 1e-12);
    expect(meanNone).toBeGreaterThan(10 * meanSin);
  });

  it('lock condition boundary', () => {
    // lock iff |2*pi*df*T_ref| <= K
    const k = A * 0.999;
    expect(lockCondition(k, DF, F_REF)).toBe(false);
    expect(lockCondition(A * 1.001, DF, F_REF)).toBe(true);
    expect(sinFixedPointRad(k, DF, F_REF)).toBeNull();
  });

  it('a dense sine LUT reproduces the sin model', () => {
    const lut: number[][] = [];
    for (let i = 0; i < 2001; i++) {
      const e = -Math.PI + (2 * Math.PI * i) / 2000;
      lut.push([e, -0.3 * Math.sin(e)]);
    }
    const cfg = fromPartial({
      n_div: 3.125,
      inj_model: 'lut',
      pdr_lut: lut,
      k_inj: 0.3,
      delta_f_hz: DF,
    });
    const resLut = simulate(cfg);
    const resSin = run(0.3, 'sin');
    const lastLut = resLut.data.e_inj[resLut.data.e_inj.length - 1];
    const lastSin = resSin.data.e_inj[resSin.data.e_inj.length - 1];
    expect(Math.abs(lastLut - lastSin)).toBeLessThan(1e-6);
  });

  it('with noise on, locked residual stays bounded', () => {
    const res = run(0.3, 'sin', 0.01);
    const e = res.data.e_inj;
    let maxAbs = 0;
    for (let i = e.length - 256; i < e.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(e[i]));
    }
    expect(maxAbs).toBeLessThan(0.2); // bounded residual, well inside a cycle
  });
});
