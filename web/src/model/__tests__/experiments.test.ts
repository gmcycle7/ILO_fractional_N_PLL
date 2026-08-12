/**
 * Acceptance Test 11: all experiment presets load and simulate without any
 * runtime exception; ids and structure mirror model/python/experiments.py.
 */

import { describe, expect, it } from 'vitest';
import { EXPERIMENTS, PRESETS, getPreset, presetConfigs } from '../experiments';
import { simulate } from '../simulate';

describe('experiment presets (Test 11)', () => {
  it('has the 23 canonical experiments plus the alias', () => {
    expect(EXPERIMENTS.length).toBe(23);
    const ids = EXPERIMENTS.map((e) => e.id);
    for (let i = 1; i <= 23; i++) {
      expect(ids).toContain(`exp${String(i).padStart(2, '0')}`);
    }
    expect(Object.keys(PRESETS).length).toBe(24);
    expect(PRESETS.n3p13_shared_reverse).toBeDefined();
  });

  it('alias n3p13_shared_reverse matches the exp06-style config', () => {
    const alias = getPreset('n3p13_shared_reverse');
    const cfg = presetConfigs(alias)[0];
    expect(cfg.n_div).toBe(3.13);
    expect(cfg.arch_mode).toBe('D');
    expect(cfg.quantizer).toBe('nearest');
    expect(cfg.latency_cycles).toBe(1);
    expect(cfg.lookahead).toBe(true);
  });

  it('every preset config simulates without runtime exception', () => {
    for (const id of Object.keys(PRESETS)) {
      const preset = getPreset(id);
      for (const cfg of presetConfigs(preset)) {
        const res = simulate(cfg);
        expect(res.data.k.length).toBe(cfg.n_cycles);
      }
    }
  });

  it('unknown preset id throws', () => {
    expect(() => getPreset('nope')).toThrow();
  });
});
