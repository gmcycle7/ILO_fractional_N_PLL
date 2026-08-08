/**
 * KaTeX rendering. `katex/dist/katex.min.css` is imported once in main.tsx.
 * trust: false — LaTeX input is never allowed to emit arbitrary HTML.
 *
 *   <M>{'\\alpha = N - 3'}</M>                      inline
 *   <MathBlock>{'s_{ideal}[k] = s_0 + kN'}</MathBlock>   display
 */

import { useMemo } from 'react';
import katex from 'katex';

function renderTex(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    errorColor: '#b03a2e',
    strict: 'ignore',
    trust: false,
  });
}

/** Inline math. Children must be a raw TeX string. */
export function M({ children }: { children: string }) {
  const html = useMemo(() => renderTex(children, false), [children]);
  return <span className="math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Display (block) math. Children must be a raw TeX string. */
export function MathBlock({ children }: { children: string }) {
  const html = useMemo(() => renderTex(children, true), [children]);
  return <div className="math-block" dangerouslySetInnerHTML={{ __html: html }} />;
}
