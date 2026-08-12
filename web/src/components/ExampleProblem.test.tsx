/**
 * ExampleProblem: `fmt` formatting contract + SSR render smoke.
 *
 * The render tests use react-dom/server in the plain node environment (no
 * jsdom) — the widget must stay SSR-safe (no window/document at render
 * scope, no effects needed for the first paint).
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ExampleProblem, { fmt } from './ExampleProblem';
import type { ExampleProblemProps } from './ExampleProblem';

describe('fmt', () => {
  it('rounds to significant digits and strips trailing zeros', () => {
    expect(fmt(0.6499999999999986, 6)).toBe('0.65');
    expect(fmt(15.649999999999999, 8)).toBe('15.65');
    expect(fmt(79.87220447284345, 5)).toBe('79.872');
    expect(fmt(1 / 256, 6)).toBe('0.00390625'); // 1 LSB in cycles
    expect(fmt(90.00000000001, 4)).toBe('90');
    expect(fmt(0)).toBe('0');
    expect(fmt(-0.0010625, 6)).toBe('-0.0010625'); // e_FB_abs, MODEL_SPEC §9
    expect(fmt(-0.0010625, 4)).toBe('-0.001063'); // 4 sig digits rounds it
  });

  it('defaults to 6 significant digits', () => {
    expect(fmt(1.234567891)).toBe('1.23457');
    expect(fmt(1.234567891, 6)).toBe(fmt(1.234567891));
  });

  it('appends the unit after one space, and only when non-empty', () => {
    expect(fmt(79.87220447284345, 5, 'ps')).toBe('79.872 ps');
    expect(fmt(0.65, 6, 'cyc')).toBe('0.65 cyc');
    expect(fmt(166, 6, '')).toBe('166');
    expect(fmt(166, 6)).toBe('166');
  });

  it('renders non-finite values without throwing', () => {
    expect(fmt(Number.NaN)).toBe('NaN');
    expect(fmt(Number.NaN, 6, 'cyc')).toBe('NaN cyc');
    expect(fmt(Number.POSITIVE_INFINITY)).toBe('∞');
    expect(fmt(Number.NEGATIVE_INFINITY, 6, 'ps')).toBe('−∞ ps');
  });

  it('clamps digits into the legal toPrecision range (1..21)', () => {
    expect(() => fmt(1.23456, 0)).not.toThrow();
    expect(fmt(1.23456, 0)).toBe('1'); // clamped to 1 sig digit
    expect(() => fmt(1.23456, 999)).not.toThrow();
    expect(() => fmt(1.23456, 2.7)).not.toThrow();
    expect(fmt(1.23456, 2.7)).toBe('1.2'); // truncated to 2 sig digits
  });
});

/** Trivial worked example: double the input. */
function trivialProps(over: Partial<ExampleProblemProps> = {}): ExampleProblemProps {
  return {
    title: '把數字加倍',
    prompt: '取一個數 a,求 2a。',
    inputs: [{ key: 'a', label: 'a', def: 2.5, min: 0, max: 10, step: 0.5, unit: 'cyc' }],
    compute: (v) => ({
      steps: [{ label: '2 × a', value: fmt(2 * v.a, 6, 'cyc') }],
      answer: fmt(2 * v.a, 6, 'cyc'),
    }),
    tag: 'EXACT',
    index: 1,
    ...over,
  };
}

function render(over: Partial<ExampleProblemProps> = {}): string {
  return renderToString(createElement(ExampleProblem, trivialProps(over)));
}

describe('ExampleProblem (SSR render)', () => {
  it('renders the card, prompt, default input value and the computed answer', () => {
    const html = render();
    expect(html).toContain('把數字加倍');
    expect(html).toContain('取一個數 a,求 2a。');
    expect(html).toContain('example-problem-answer');
    expect(html).toContain('5 cyc'); // 2 × 2.5
    expect(html).toContain('value="2.5"'); // default filled into the input
    expect(html).toContain('重設');
    expect(html).toContain('解題步驟');
    expect(html).toContain('epistemic-tag epistemic-exact'); // EpistemicTag
    expect(html).toContain('>1<'); // index badge
  });

  it('keeps 解題步驟 collapsed by default and expands with defaultOpen', () => {
    expect(render()).not.toContain('example-problem-steps');
    const open = render({ defaultOpen: true });
    expect(open).toContain('example-problem-steps');
    expect(open).toContain('2 × a');
  });

  it('warns instead of computing when a value is not a finite number', () => {
    const html = render({ inputs: [{ key: 'a', label: 'a', def: Number.NaN }] });
    expect(html).toContain('example-problem-warn');
    expect(html).toContain('a 不是有效數字');
    expect(html).not.toContain('example-problem-answer');
  });

  it('warns instead of computing when a value is out of range', () => {
    const low = render({ inputs: [{ key: 'a', label: 'a', def: -1, min: 0, max: 10 }] });
    expect(low).toContain('a 小於下限 0');
    expect(low).not.toContain('example-problem-answer');

    const high = render({ inputs: [{ key: 'a', label: 'a', def: 42, min: 0, max: 10 }] });
    expect(high).toContain('a 大於上限 10');
    expect(high).not.toContain('example-problem-answer');
  });

  it('surfaces a compute-supplied warn alongside the answer', () => {
    const html = render({
      compute: (v) => ({
        steps: [],
        answer: fmt(v.a, 6),
        warn: '此點落在量化邊界',
      }),
    });
    expect(html).toContain('此點落在量化邊界');
    expect(html).toContain('example-problem-answer');
  });

  it('turns a throwing compute into a warning instead of unmounting the chapter', () => {
    const html = render({
      compute: () => {
        throw new Error('boom');
      },
    });
    expect(html).toContain('計算失敗:boom');
    expect(html).not.toContain('example-problem-answer');
  });
});
