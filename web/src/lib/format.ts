/**
 * Unit handling and number formatting for phase quantities.
 *
 * Internal unit convention (MODEL_SPEC.md §2, binding):
 *   phase is ALWAYS stored/computed in VCO cycles (float64).
 *   1 cycle = 2*pi rad = T_vco seconds = 360 degrees.
 *
 * These helpers only convert AT DISPLAY TIME. Never store phase in deg/time.
 */

export type PhaseUnit = 'cycles' | 'deg' | 'time';

export const PHASE_UNITS: PhaseUnit[] = ['cycles', 'deg', 'time'];

/** SI time scales, largest first. */
const TIME_UNITS: readonly (readonly [number, string])[] = [
  [1, 's'],
  [1e-3, 'ms'],
  [1e-6, 'µs'],
  [1e-9, 'ns'],
  [1e-12, 'ps'],
  [1e-15, 'fs'],
];

/**
 * Round to `sig` significant digits and strip trailing zeros.
 * trimNumber(90.0000001, 4) -> "90"; trimNumber(-85.0000000001, 4) -> "-85".
 */
export function trimNumber(value: number, sig = 4): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  return Number(value.toPrecision(sig)).toString();
}

/** Pick the SI scale for a time magnitude. |seconds| below 1 fs still uses fs. */
export function timeUnitFor(seconds: number): { scale: number; unit: string } {
  const a = Math.abs(seconds);
  for (const [scale, unit] of TIME_UNITS) {
    if (a >= scale) return { scale, unit };
  }
  return { scale: 1e-15, unit: 'fs' };
}

/** Format seconds with an auto-chosen SI prefix: 3.125e-13 -> "312.5 fs". */
export function formatSiTime(seconds: number, sig = 4): string {
  if (!Number.isFinite(seconds)) return String(seconds);
  if (seconds === 0) return '0 s';
  const { scale, unit } = timeUnitFor(seconds);
  return `${trimNumber(seconds / scale, sig)} ${unit}`;
}

/**
 * Format a phase value given in cycles, in the requested display unit.
 *   formatPhase(0.337, 'cycles', 80e-12)      -> "0.337 cyc"
 *   formatPhase(0.25, 'deg', 80e-12)          -> "90°"
 *   formatPhase(-0.0010625, 'time', 80e-12)   -> "-85 fs"   (MODEL_SPEC §9)
 */
export function formatPhase(
  valueCycles: number,
  unit: PhaseUnit,
  tVcoSeconds: number,
  sig = 4,
): string {
  switch (unit) {
    case 'cycles':
      return `${trimNumber(valueCycles, sig)} cyc`;
    case 'deg':
      return `${trimNumber(360 * valueCycles, sig)}°`;
    case 'time':
      return formatSiTime(valueCycles * tVcoSeconds, sig);
  }
}

/**
 * Unit string for axis labels. For 'time' the SI prefix is chosen from the
 * magnitude of one VCO period (e.g. T_vco = 80 ps -> "ps"), so that a whole
 * axis shares a single fixed prefix.
 */
export function phaseUnitLabel(unit: PhaseUnit, tVcoSeconds?: number): string {
  switch (unit) {
    case 'cycles':
      return 'cycles';
    case 'deg':
      return 'deg';
    case 'time':
      return tVcoSeconds !== undefined && tVcoSeconds !== 0 ? timeUnitFor(tVcoSeconds).unit : 's';
  }
}

/** "e_pair" + 'time' + 80 ps -> "e_pair (ps)". */
export function phaseAxisLabel(name: string, unit: PhaseUnit, tVcoSeconds?: number): string {
  return `${name} (${phaseUnitLabel(unit, tVcoSeconds)})`;
}

/**
 * Tick formatter for chart axes whose underlying data is in cycles.
 * Produces plain numbers (unit belongs in the axis label, via phaseAxisLabel,
 * with the SAME tVcoSeconds so prefix and numbers agree).
 */
export function makePhaseTickFormatter(
  unit: PhaseUnit,
  tVcoSeconds: number,
  sig = 4,
): (valueCycles: number) => string {
  if (unit === 'cycles') return (v) => trimNumber(v, sig);
  if (unit === 'deg') return (v) => trimNumber(360 * v, sig);
  const { scale } = timeUnitFor(tVcoSeconds);
  return (v) => trimNumber((v * tVcoSeconds) / scale, sig);
}

/** Convert a phase in cycles to the display unit's numeric value (no string). */
export function phaseToUnitValue(valueCycles: number, unit: PhaseUnit, tVcoSeconds: number): number {
  switch (unit) {
    case 'cycles':
      return valueCycles;
    case 'deg':
      return 360 * valueCycles;
    case 'time':
      return valueCycles * tVcoSeconds;
  }
}
