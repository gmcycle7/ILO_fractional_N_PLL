/**
 * Behavioral DTC model with gain / offset / INL / DNL nonidealities.
 *
 * Contract: MODEL_SPEC.md sections 10, 11 [ASSUMPTION].
 * Mirror of model/python/dtc_model.py.
 *
 * Delay in cycles for code c (0 .. 2^b_dtc - 1):
 *
 *     delay(c) = gain * c * lsb_cyc
 *              + offset_cycles
 *              + inl_sin_amp * sin(2*pi*c/64)
 *              + p2*(c/63)^2 + p3*(c/63)^3
 *              + inl_lut[c]
 *              + dnl_cum[c] * lsb_cyc
 *
 * lsb_cyc = 1/G (normalized mode) or (dtc_lsb_fs*1e-15)/T_vco (fixed_time).
 *
 * DNL is a frozen per-code cumulative random walk drawn once per DTC instance
 * from its named stream: dnl_cum[0] = 0; dnl_cum[c] = dnl_cum[c-1] +
 * dnl_sigma_lsb * gauss()  (units: LSB).  [Resolved ambiguity: code 0 carries
 * no DNL; steps for codes 1..n_codes-1 accumulate — DNL steps integrate into
 * INL.]
 */

import type { SimConfig } from './config';
import { configG, configTVcoS } from './config';
import type { Mulberry32, Streams } from './rng';
import { FS } from './units';

export interface DTCModelOptions {
  nCodes?: number;
  lsbCycles?: number;
  gain?: number;
  offsetCycles?: number;
  inlSinAmpCycles?: number;
  inlPoly?: readonly number[];
  inlLut?: readonly number[] | null;
  dnlSigmaLsb?: number;
  dnlStream?: Mulberry32 | null;
}

export class DTCModel {
  readonly nCodes: number;
  readonly lsbCycles: number;
  readonly gain: number;
  readonly offsetCycles: number;
  readonly dnlCumLsb: Float64Array;
  readonly table: Float64Array;

  constructor(opts: DTCModelOptions = {}) {
    const nCodes = opts.nCodes ?? 64;
    const lsbCycles = opts.lsbCycles ?? 1.0 / 256.0;
    const gain = opts.gain ?? 1.0;
    const offsetCycles = opts.offsetCycles ?? 0.0;
    const inlSinAmpCycles = opts.inlSinAmpCycles ?? 0.0;
    const inlPoly = opts.inlPoly ?? [0.0, 0.0];
    const inlLut = opts.inlLut ?? null;
    const dnlSigmaLsb = opts.dnlSigmaLsb ?? 0.0;
    const dnlStream = opts.dnlStream ?? null;

    this.nCodes = nCodes;
    this.lsbCycles = lsbCycles;
    this.gain = gain;
    this.offsetCycles = offsetCycles;

    // DNL: frozen per-code cumulative error (LSB), code 0 = 0
    const dnlCum = new Float64Array(nCodes);
    if (dnlSigmaLsb !== 0.0) {
      if (dnlStream === null) {
        throw new Error('dnl_sigma_lsb != 0 requires a dnl_stream');
      }
      let acc = 0.0;
      for (let i = 1; i < nCodes; i++) {
        acc += dnlSigmaLsb * dnlStream.gauss();
        dnlCum[i] = acc;
      }
    }
    this.dnlCumLsb = dnlCum;

    const p2 = inlPoly.length > 0 ? inlPoly[0] : 0.0;
    const p3 = inlPoly.length > 1 ? inlPoly[1] : 0.0;

    const denom = nCodes - 1; // 63 for 6-bit
    const table = new Float64Array(nCodes);
    for (let c = 0; c < nCodes; c++) {
      const lut = inlLut === null ? 0.0 : inlLut[c];
      table[c] =
        gain * c * lsbCycles +
        offsetCycles +
        inlSinAmpCycles * Math.sin((2.0 * Math.PI * c) / nCodes) +
        p2 * (c / denom) ** 2 +
        p3 * (c / denom) ** 3 +
        lut +
        dnlCum[c] * lsbCycles;
    }
    this.table = table;
  }

  /** Actual DTC delay in cycles for an integer code. */
  delayCycles(code: number): number {
    return this.table[code];
  }

  /** Ideal delay c * lsb_cyc (no nonidealities). */
  idealDelayCycles(code: number): number {
    return code * this.lsbCycles;
  }
}

/**
 * Build the FB ('fb') or INJ ('inj') DTC model from a SimConfig.
 * Uses stream 'dnl_fb' / 'dnl_inj' respectively (frozen per instance).
 */
export function makeDtc(cfg: SimConfig, path: 'fb' | 'inj', streams: Streams): DTCModel {
  const nCodes = 1 << cfg.b_dtc;
  let lsbCyc: number;
  if (cfg.dtc_mode === 'normalized') {
    lsbCyc = 1.0 / configG(cfg);
  } else {
    // fixed_time
    lsbCyc = (cfg.dtc_lsb_fs * FS) / configTVcoS(cfg);
  }

  let gain: number;
  let off: number;
  let stream: Mulberry32;
  if (path === 'fb') {
    gain = cfg.dtc_fb_gain;
    off = cfg.dtc_fb_offset_cycles;
    stream = streams.dnl_fb;
  } else if (path === 'inj') {
    gain = cfg.dtc_inj_gain;
    off = cfg.dtc_inj_offset_cycles;
    stream = streams.dnl_inj;
  } else {
    throw new Error("path must be 'fb' or 'inj'");
  }

  return new DTCModel({
    nCodes,
    lsbCycles: lsbCyc,
    gain,
    offsetCycles: off,
    inlSinAmpCycles: cfg.inl_sin_amp_cycles,
    inlPoly: cfg.inl_poly,
    inlLut: cfg.inl_lut,
    dnlSigmaLsb: cfg.dnl_sigma_lsb,
    dnlStream: stream,
  });
}
