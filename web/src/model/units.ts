/**
 * Physical constants, unit conversions and derived quantities.
 *
 * Contract: MODEL_SPEC.md sections 1, 9, 11.
 * Mirror of model/python/units.py (mathematically 1:1, float64 everywhere).
 * Internal phase unit everywhere else in the model is VCO cycles (float64):
 * 1 cycle = 2*pi rad = T_vco seconds = 360 degrees.
 */

// --- SI prefixes (seconds) ---
export const FS = 1e-15;
export const PS = 1e-12;
export const NS = 1e-9;

// --- frequency ---
export const HZ = 1.0;
export const KHZ = 1e3;
export const MHZ = 1e6;
export const GHZ = 1e9;

// canonical defaults (MODEL_SPEC section 1)
export const DEFAULT_F_REF_HZ = 4e9;
export const DEFAULT_B_DTC = 6;
export const DEFAULT_N_TAP = 8;
export const DEFAULT_N_PMUX = 4;

export type DtcMode = 'normalized' | 'fixed_time';

/** Fine phase units per T_vco: G = N_PMUX * 2^B_DTC (= 256 default). */
export function gFine(nPmux: number = DEFAULT_N_PMUX, bDtc: number = DEFAULT_B_DTC): number {
  return nPmux * (1 << bDtc);
}

/** Reference period in seconds. */
export function tRefS(fRefHz: number = DEFAULT_F_REF_HZ): number {
  return 1.0 / fRefHz;
}

/** VCO frequency f_vco = N * f_ref. */
export function fVcoHz(nDiv: number, fRefHz: number = DEFAULT_F_REF_HZ): number {
  return nDiv * fRefHz;
}

/** VCO period in seconds: T_vco = 1 / (N * f_ref). */
export function tVco(nDiv: number, fRefHz: number = DEFAULT_F_REF_HZ): number {
  return 1.0 / (nDiv * fRefHz);
}

/** alias used throughout */
export const tVcoS = tVco;

/**
 * DTC LSB in seconds.
 *
 * normalized : T_vco / G   (phase LSB constant 360/G degrees)
 * fixed_time : dtc_lsb_fs femtoseconds, independent of f_vco
 */
export function dtcLsbS(
  nDiv: number,
  fRefHz: number = DEFAULT_F_REF_HZ,
  dtcMode: DtcMode = 'normalized',
  dtcLsbFs: number = 312.5,
  g: number = 256,
): number {
  if (dtcMode === 'normalized') {
    return tVco(nDiv, fRefHz) / g;
  }
  if (dtcMode === 'fixed_time') {
    return dtcLsbFs * FS;
  }
  throw new Error("dtc_mode must be 'normalized' or 'fixed_time'");
}

/** DTC LSB in VCO cycles (normalized: exactly 1/G). */
export function dtcLsbCycles(
  nDiv: number,
  fRefHz: number = DEFAULT_F_REF_HZ,
  dtcMode: DtcMode = 'normalized',
  dtcLsbFs: number = 312.5,
  g: number = 256,
): number {
  if (dtcMode === 'normalized') {
    return 1.0 / g;
  }
  if (dtcMode === 'fixed_time') {
    return (dtcLsbFs * FS) / tVco(nDiv, fRefHz);
  }
  throw new Error("dtc_mode must be 'normalized' or 'fixed_time'");
}

/**
 * Phase LSB in degrees. normalized: 360/G (=1.40625 for G=256).
 * fixed_time: 360 * Delta_t / T_vco (requires nDiv).
 */
export function phaseLsbDeg(
  g: number = 256,
  nDiv: number | null = null,
  fRefHz: number = DEFAULT_F_REF_HZ,
  dtcMode: DtcMode = 'normalized',
  dtcLsbFs: number = 312.5,
): number {
  if (dtcMode === 'normalized') {
    return 360.0 / g;
  }
  if (nDiv === null) {
    throw new Error('nDiv required for fixed_time phase LSB');
  }
  return (360.0 * (dtcLsbFs * FS)) / tVco(nDiv, fRefHz);
}

export function secondsToFs(t: number): number {
  return t / FS;
}

export function fsToSeconds(tFs: number): number {
  return tFs * FS;
}

export function secondsToPs(t: number): number {
  return t / PS;
}

export function secondsToNs(t: number): number {
  return t / NS;
}

export function hzToGhz(f: number): number {
  return f / GHZ;
}
