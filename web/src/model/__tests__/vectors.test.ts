/**
 * Acceptance Test 9: Python <-> TypeScript cross-validation.
 *
 * Loads EVERY test_vectors/*.json emitted by the Python golden model
 * (model/python/cli.py --emit-vectors), runs the TS simulate() with the
 * embedded config and compares EVERY column row-by-row:
 *   - integer columns: exactly equal
 *   - float columns: |diff| <= 1e-12 (pure digital paths)
 *   - noise-dependent vectors: |diff| <= 1e-9 (libm differences)
 * Tolerances come from the vector schema itself (MODEL_SPEC section 18).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SimConfig } from '../config';
import { fromPartial } from '../config';
import type { ColumnName } from '../simulate';
import { simulate } from '../simulate';

const HERE = dirname(fileURLToPath(import.meta.url));
// web/src/model/__tests__ -> repo root
const VECTOR_DIR = join(HERE, '..', '..', '..', '..', 'test_vectors');

interface VectorFile {
  name: string;
  generator: string;
  seed: number;
  config: Record<string, unknown>;
  tolerance: { int: number; float_abs: number; noise_abs: number };
  columns: string[];
  data: number[][];
}

/** vector column name -> SimResult column name */
function resultColumn(col: string): ColumnName {
  return (col === 'e_pair' ? 'e_pair_digital' : col) as ColumnName;
}

const INT_COLS = new Set([
  'k',
  'A_FB',
  'R_FB',
  'm_FB',
  'c_FB',
  'n_int',
  'R_INJ',
  'j_INJ',
  'c_INJ',
  'seq_id',
]);

/** A vector is noise-dependent iff its config enables any random source. */
function isNoiseDependent(cfg: SimConfig): boolean {
  return (
    cfg.sigma_ref_s > 0 ||
    cfg.sigma_vco_w_rad > 0 ||
    cfg.sigma_vco_rw_rad > 0 ||
    cfg.sigma_pulse_s > 0 ||
    cfg.dnl_sigma_lsb > 0 ||
    cfg.dither_amp_lsb > 0 ||
    cfg.p_late > 0
  );
}

const files = readdirSync(VECTOR_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('Python golden test vectors (Test 9)', () => {
  it('finds the 12 canonical vectors', () => {
    expect(files.length).toBe(12);
  });

  for (const file of files) {
    it(`matches ${file} column-by-column`, () => {
      const vec = JSON.parse(readFileSync(join(VECTOR_DIR, file), 'utf8')) as VectorFile;
      expect(vec.generator).toBe('python');

      const cfg = fromPartial(vec.config as Partial<SimConfig>);
      expect(cfg.seed).toBe(vec.seed);
      const res = simulate(cfg);

      const floatTol = isNoiseDependent(cfg) ? vec.tolerance.noise_abs : vec.tolerance.float_abs;

      expect(vec.data.length).toBe(cfg.n_cycles);
      for (let ci = 0; ci < vec.columns.length; ci++) {
        const col = vec.columns[ci];
        const tsCol = res.data[resultColumn(col)];
        expect(tsCol, `missing column ${col}`).toBeDefined();
        const isInt = INT_COLS.has(col);
        for (let k = 0; k < vec.data.length; k++) {
          const golden = vec.data[k][ci];
          const got = tsCol[k];
          if (isInt) {
            if (got !== golden) {
              expect.fail(`${file} col '${col}' row ${k}: TS ${got} != Python ${golden}`);
            }
          } else {
            const diff = Math.abs(got - golden);
            if (!(diff <= floatTol)) {
              expect.fail(
                `${file} col '${col}' row ${k}: |${got} - ${golden}| = ${diff} > ${floatTol}`,
              );
            }
          }
        }
      }
    });
  }
});
