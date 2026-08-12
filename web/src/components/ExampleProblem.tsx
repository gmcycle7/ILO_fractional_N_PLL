/**
 * ExampleProblem — the shared interactive worked-example widget used inside
 * SectionExample (數值例子). Every chapter uses it three times, so the API is
 * deliberately declarative: the chapter supplies the problem statement, the
 * editable inputs and ONE pure `compute` function; this component owns all
 * state, validation, formatting and layout.
 *
 * Contract (web/ARCHITECTURE.md §5):
 *   - `compute` must be PURE and must get every number it needs from `v`
 *     (keyed by `inputs[].key`). It must not read component state, the DOM or
 *     the clock — it is called on every keystroke.
 *   - `compute` must call the model (`../model`) for any real math; chapters
 *     never re-implement wrap/quantizer math inline (ARCHITECTURE §6).
 *   - Step `value` strings are DISPLAY only: build them with `fmt` (below) or
 *     `../lib/format`, never let a display rounding feed back into compute.
 *
 * SSR-safe: pure render from props + state, no window/document at render
 * scope and no effects (renderToString in the node test environment works).
 */

import { useCallback, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import EpistemicTag from './EpistemicTag';
import type { EpistemicKind } from './EpistemicTag';
import { trimNumber } from '../lib/format';

/* -------------------------------------------------------------- fmt helper */

/** toPrecision() accepts 1..21 significant digits; clamp so fmt never throws. */
const MIN_SIG = 1;
const MAX_SIG = 21;

/**
 * Format one intermediate value for a 解題步驟 row (DISPLAY ONLY).
 *
 *   fmt(0.6499999999999986, 6)          -> '0.65'
 *   fmt(79.87220447284345, 5, 'ps')     -> '79.872 ps'
 *   fmt(1 / 256, 6, 'cyc')              -> '0.00390625 cyc'
 *   fmt(Number.NaN)                     -> 'NaN'
 *
 * `digits` is SIGNIFICANT digits (same convention as `trimNumber`), trailing
 * zeros stripped; `unit` is appended after a single space when given.
 * Never use fmt output as an input to further computation.
 */
export function fmt(value: number, digits = 6, unit?: string): string {
  let body: string;
  if (Number.isNaN(value)) {
    body = 'NaN';
  } else if (!Number.isFinite(value)) {
    body = value > 0 ? '∞' : '−∞';
  } else {
    const sig = Math.min(MAX_SIG, Math.max(MIN_SIG, Math.trunc(digits)));
    body = trimNumber(value, sig);
  }
  return unit === undefined || unit === '' ? body : `${body} ${unit}`;
}

/* -------------------------------------------------------------------- types */

/** One editable scalar input. `key` is what `compute` receives it under. */
export interface ExampleInput {
  /** identifier passed to compute as `v[key]`; also used in warn messages */
  key: string;
  /** displayed label (may contain <M> math) */
  label: ReactNode;
  /** default value, restored by 重設 */
  def: number;
  /** inclusive lower bound; values below it raise the out-of-range warning */
  min?: number;
  /** inclusive upper bound */
  max?: number;
  /** spinner step (display only — typed values are not snapped) */
  step?: number;
  /** unit shown after the field, e.g. 'cyc', 'GHz', 'ps' */
  unit?: string;
}

/** One intermediate line of the collapsible 解題步驟 list. */
export interface ExampleStep {
  label: ReactNode;
  /** preformatted display string — build it with `fmt` */
  value: string;
}

export interface ExampleResult {
  steps: ExampleStep[];
  answer: ReactNode;
  /** model caveat for THIS input point (edge case, boundary, out of validity) */
  warn?: string;
}

/** Tags an interactive example may carry (subset of EpistemicKind). */
export type ExampleTag = Extract<EpistemicKind, 'EXACT' | 'APPROX' | 'EXPERIMENT'>;

export interface ExampleProblemProps {
  /** short zh-Hant title of the problem */
  title: string;
  /** the zh-Hant problem statement (may contain <M> math) */
  prompt: ReactNode;
  inputs: ExampleInput[];
  /** PURE: called on every edit with the parsed, in-range values */
  compute: (v: Record<string, number>) => ExampleResult;
  /** epistemic status of the formulas this example evaluates */
  tag?: ExampleTag;
  /** number shown in the card badge (1..3 within a chapter); omit for 例 */
  index?: number;
  /** start with 解題步驟 expanded (default false — the card stays compact) */
  defaultOpen?: boolean;
}

/* ---------------------------------------------------------------- internals */

type Outcome =
  | { ok: true; result: ExampleResult }
  | { ok: false; error: string };

function initialText(inputs: ExampleInput[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const inp of inputs) out[inp.key] = String(inp.def);
  return out;
}

interface Parsed {
  values: Record<string, number>;
  bad: Record<string, true>;
  problems: string[];
}

function parseInputs(inputs: ExampleInput[], text: Record<string, string>): Parsed {
  const values: Record<string, number> = {};
  const bad: Record<string, true> = {};
  const problems: string[] = [];
  for (const inp of inputs) {
    const raw = (text[inp.key] ?? String(inp.def)).trim();
    // Number('') === 0, so empty must be rejected explicitly.
    const n = raw === '' ? Number.NaN : Number(raw);
    if (!Number.isFinite(n)) {
      bad[inp.key] = true;
      problems.push(`${inp.key} 不是有效數字`);
      continue;
    }
    if (inp.min !== undefined && n < inp.min) {
      bad[inp.key] = true;
      problems.push(`${inp.key} 小於下限 ${trimNumber(inp.min, 6)}`);
      continue;
    }
    if (inp.max !== undefined && n > inp.max) {
      bad[inp.key] = true;
      problems.push(`${inp.key} 大於上限 ${trimNumber(inp.max, 6)}`);
      continue;
    }
    values[inp.key] = n;
  }
  return { values, bad, problems };
}

/* --------------------------------------------------------------- component */

export default function ExampleProblem({
  title,
  prompt,
  inputs,
  compute,
  tag,
  index,
  defaultOpen = false,
}: ExampleProblemProps) {
  const uid = useId();
  const [text, setText] = useState<Record<string, string>>(() => initialText(inputs));
  const [open, setOpen] = useState<boolean>(defaultOpen);

  const parsed = useMemo(() => parseInputs(inputs, text), [inputs, text]);

  // Live recompute. compute is user code: a throw becomes a warning, never a
  // blank chapter (an exception here would unmount the whole chapter tree).
  const outcome = useMemo<Outcome | null>(() => {
    if (parsed.problems.length > 0) return null;
    try {
      return { ok: true, result: compute(parsed.values) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `計算失敗:${msg}` };
    }
  }, [compute, parsed]);

  const reset = useCallback(() => {
    setText(initialText(inputs));
  }, [inputs]);

  const result = outcome !== null && outcome.ok ? outcome.result : null;
  const warn =
    parsed.problems.length > 0
      ? `輸入無效:${parsed.problems.join('、')}`
      : outcome !== null && !outcome.ok
        ? outcome.error
        : (result?.warn ?? null);

  const steps = result?.steps ?? [];

  return (
    <div className="example-problem">
      <div className="example-problem-header">
        <span className="example-problem-num">{index ?? '例'}</span>
        <h4 className="example-problem-title">{title}</h4>
        {tag !== undefined && <EpistemicTag kind={tag} />}
      </div>

      <div className="example-problem-prompt">{prompt}</div>

      <div className="example-problem-inputs">
        {inputs.map((inp) => {
          const id = `${uid}-${inp.key}`;
          const isBad = parsed.bad[inp.key] === true;
          return (
            <div
              key={inp.key}
              className={`control control-number example-problem-input${
                isBad ? ' example-problem-input-bad' : ''
              }`}
            >
              <label className="control-label" htmlFor={id}>
                {inp.label}
              </label>
              <input
                id={id}
                type="number"
                inputMode="decimal"
                value={text[inp.key] ?? String(inp.def)}
                min={inp.min}
                max={inp.max}
                step={inp.step}
                aria-invalid={isBad}
                onChange={(e) => {
                  const next = e.target.value;
                  setText((prev) => ({ ...prev, [inp.key]: next }));
                }}
              />
              {inp.unit !== undefined && <span className="control-unit">{inp.unit}</span>}
            </div>
          );
        })}
      </div>

      {warn !== null && (
        <p className="example-problem-warn" role="status">
          {warn}
        </p>
      )}

      <div className="example-problem-actions">
        <button
          type="button"
          className="preset-button"
          aria-expanded={open}
          aria-controls={`${uid}-steps`}
          disabled={steps.length === 0}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '−' : '+'} 解題步驟{steps.length > 0 ? `(${steps.length})` : ''}
        </button>
        <button type="button" className="preset-button" onClick={reset}>
          重設
        </button>
      </div>

      {open && steps.length > 0 && (
        <ol className="example-problem-steps" id={`${uid}-steps`}>
          {steps.map((step, i) => (
            <li key={i}>
              <span className="example-problem-step-label">{step.label}</span>
              <span className="example-problem-step-value">{step.value}</span>
            </li>
          ))}
        </ol>
      )}

      {result !== null && (
        <div className="example-problem-answer">
          <span className="example-problem-answer-label">答案 Answer</span>
          <span className="example-problem-answer-value">{result.answer}</span>
        </div>
      )}
    </div>
  );
}
