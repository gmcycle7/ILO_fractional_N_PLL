# web/src/model — TypeScript mirror of the Python golden model

Mathematically 1:1 mirror of `model/python/` against the binding contract
`MODEL_SPEC.md` + `ASSUMPTIONS.md` (repo root). Any deviation from the spec or
from the Python golden model is a bug. Cross-validated column-by-column
against `test_vectors/*.json` (integer columns exact, float `<= 1e-12`,
noise paths `<= 1e-9`; see `__tests__/vectors.test.ts`).

Chapters import compute functionality ONLY from this directory:

```ts
import { simulate, defaultConfig, fromPartial } from '../model';

const res = simulate(fromPartial({ n_div: 3.13, quantizer: 'nearest' }));
res.data.e_FB_abs; // Float64Array, one entry per reference cycle
```

Everything is pure functions over `Float64Array`/`number[]` — no DOM, no
`Math.random()`, no node imports (browser-safe). Deterministic PRNG is
mulberry32 with named streams, base seed 12345 (MODEL_SPEC §12).

## Cross-language exactness rules (MODEL_SPEC §2, §12)

- float64 everywhere; `s_ideal[k] = s0 + k*N` by multiplication, never
  accumulation.
- No language `round()`: `qNearest(x) = Math.floor(x + 0.5)` (half-up).
- PRNG uses `Math.imul` + `>>>`/`>>> 0` masking to mirror the Python
  `& 0xFFFFFFFF` uint32 arithmetic bit-for-bit.
- `pymod(x, m)` reproduces Python's non-negative `%` semantics.

## Module map (mirrors `model/python/`)

| file | Python source | contract |
|---|---|---|
| `units.ts` | `units.py` | §1, §9, §11 constants and conversions |
| `phaseMath.ts` | `phase_math.py` | §2 wrap01/wrapCycles/wrapRadians/qNearest/qFloor |
| `config.ts` | `config.py` | `SimConfig` (snake_case keys = JSON vector schema), `defaultConfig()`, `fromPartial()`, `replaceConfig()`, derived `configG/Alpha/TRefS/TVcoS` |
| `phaseAccumulator.ts` | `phase_accumulator.py` | §3 `sIdeal`/`xIdeal`/`aIdeal` |
| `quantizers.ts` | `dsm_first_order.py`, `mash11.py`, `mash111.py`, `feedback_scheduler.py` | §6 floor/nearest/truncate/`ErrorFeedbackFirstOrder`/`Mash11`/`Mash111`, `makeQuantizer`, triangular dither |
| `rng.ts` | `noise_models.py` | §12 `Mulberry32` (+ Box-Muller `gauss()`), named streams `ref:1 … dsm_inj:10` |
| `dtcModel.ts` | `dtc_model.py` | §10, §11 gain/offset/INL/DNL behavioral DTC |
| `tapModel.ts` | `tap_model.py` | §4, §5, §10 tap/PMUX tables with mismatch |
| `feedbackScheduler.ts` | `feedback_scheduler.py` | §4 quantize + decode `A_FB → I/R/m/c`, assertions |
| `injectionScheduler.ts` | `injection_scheduler.py` | §5, §7, §8 modes A/B/C/D, naive/nearest/calibrated mappings (c-major tie-break), `ePair` |
| `latencyPipeline.ts` | `latency_pipeline.py` | §13 latency + look-ahead + metadata |
| `injectionDynamics.ts` | `injection_dynamics.py` | §14 none/reset/linear/sin/lut maps, `lockCondition`, `sinFixedPointRad` |
| `measurements.ts` | `measurements.py` | §17 rms/p2p/mean/histogram, plain radix-2 FFT, Hann periodogram (one-sided, fs = f_ref), `detectSpurs`, dBc helpers |
| `errorDecomposition.ts` | `error_decomposition.py` | §16 per-term decomposition + joint total |
| `experiments.ts` | `experiments.py` | the 22 presets `exp01…exp22` + `n3p13_shared_reverse` alias (same ids/configs) |
| `simulate.ts` | `simulate.py` | full chain; `SimResult.data` keyed by the same column names (`COLUMNS`), `toRows()`, `summary()` |
| `index.ts` | `__init__` | public re-export surface |

## Key API

```ts
simulate(cfg: SimConfig): SimResult
// SimResult.data: Record<ColumnName, Float64Array> with columns
// k, s_ideal, x_ideal, A_ideal, A_FB, I_FB, R_FB, m_FB, c_FB, n_int,
// u_FB_ideal, u_FB_digital, u_FB_analog, e_FB_abs, dsm_state, dsm_out,
// u_INJ_ideal, R_INJ, j_INJ, c_INJ, u_INJ_digital, u_INJ_analog, e_INJ_abs,
// e_pair_digital, e_pair_analog, e_ZC_hw, theta_minus, e_inj, delta_theta,
// theta_plus, e_ZC_total, seq_id, k_computed, k_applied

defaultConfig(): SimConfig            // spec defaults (N=3.125, mode D, nearest)
fromPartial(p: Partial<SimConfig>)    // defaults + overrides, validated
PRESETS['exp06'] / getPreset(id)      // canonical experiments
periodogramPsd(x, fRef)               // Hann PSD, axis ends exactly at f_ref/2
summary(res) / toRows(res)            // convenience reporting
```

Internal phase unit is ALWAYS VCO cycles (float64); convert only for display
(`web/src/lib/format.ts`). Per-cycle sequences are sampled at `f_ref`, not
`f_vco` (§17).

## Tests (`__tests__/`, vitest, node environment)

- `prng.test.ts` — pinned mulberry32(12345) first-5 outputs, stream offsets,
  Box-Muller pairing.
- `unitsConstants.test.ts`, `quantizers.test.ts`, `modeDIdentity.test.ts`,
  `latency.test.ts`, `mismatch.test.ts`, `sweep.test.ts`,
  `measurements.test.ts`, `dynamics.test.ts` — numeric mirrors of the Python
  acceptance tests 1–8 and 12–14.
- `experiments.test.ts` — every preset loads and simulates without exception.
- `vectors.test.ts` — loads every `test_vectors/*.json` (node `fs`, tests
  only) and compares EVERY column of `simulate()` output against the Python
  golden data at the schema tolerances.
