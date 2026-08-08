/**
 * Preset smoke test (acceptance Test 11, digital side).
 *
 * For every canonical experiment in EXPERIMENTS plus the alias preset
 * `n3p13_shared_reverse`: presetConfigs() followed by simulate() with
 * n_cycles overridden to 128 must not throw, and the key per-cycle error
 * columns must contain only finite values.
 */

import { describe, expect, it } from 'vitest';
import { EXPERIMENTS, getPreset, presetConfigs, type Experiment } from '../experiments';
import { simulate, type ColumnName } from '../simulate';

const N_CYCLES = 128;

/** Key digital/analog error columns that must always be finite. */
const KEY_COLUMNS: ColumnName[] = [
  'e_FB_abs',
  'e_INJ_abs',
  'e_pair_digital',
  'e_pair_analog',
  'e_ZC_hw',
  'e_ZC_total',
  'u_FB_digital',
  'u_INJ_digital',
];

function allFinite(x: Float64Array): boolean {
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) return false;
  }
  return true;
}

const PRESET_LIST: Experiment[] = [...EXPERIMENTS, getPreset('n3p13_shared_reverse')];

describe('preset smoke (Test 11 digital side, n_cycles=128)', () => {
  for (const preset of PRESET_LIST) {
    it(`${preset.id} simulates without throwing and yields finite key columns`, () => {
      const cfgs = presetConfigs(preset);
      expect(cfgs.length).toBeGreaterThan(0);
      for (const cfg of cfgs) {
        const res = simulate({ ...cfg, n_cycles: N_CYCLES });
        expect(res.data.k.length).toBe(N_CYCLES);
        for (const col of KEY_COLUMNS) {
          const arr = res.data[col];
          expect(arr).toBeInstanceOf(Float64Array);
          expect(arr.length).toBe(N_CYCLES);
          expect(allFinite(arr), `${preset.id}: column ${col} has non-finite values`).toBe(true);
        }
      }
    });
  }
});
