/**
 * ChapterShell + the fixed 11-part chapter section structure.
 *
 * Every chapter MUST use these sections in this order (a section may repeat
 * where it makes sense, e.g. several SectionFigure blocks, but the ordering
 * of kinds is fixed):
 *
 *    1 SectionQuestion       本章要回答的問題
 *    2 SectionIntuition      物理直覺
 *    3 SectionMath           完整數學
 *    4 SectionExample        數值例子
 *    5 SectionFigure         互動圖 (title, children, caption)
 *    6 SectionCode           行為程式碼 (code, language?, title?, children?)
 *    7 SectionLineByLine     逐行解說 (items: {code, explain}[])
 *    8 SectionObserve        圖上應觀察什麼
 *    9 SectionMisconception  常見誤解
 *   10 SectionTakeaway       設計要點
 *   11 SectionLimitation     模型限制
 *
 * ParamPanel (from ./controls) must be a DIRECT child of ChapterShell so the
 * CSS grid can dock it right on wide screens; place it as the LAST child so
 * it renders below the content on narrow screens.
 */

import type { ReactNode } from 'react';
import CodeBlock from './CodeBlock';

export interface ChapterShellProps {
  /** chapter number 0..20, shown as kicker */
  chapter?: number;
  titleZh?: string;
  titleEn?: string;
  children: ReactNode;
}

export function ChapterShell({ chapter, titleZh, titleEn, children }: ChapterShellProps) {
  return (
    <article className="chapter">
      {(titleZh !== undefined || titleEn !== undefined) && (
        <header className="chapter-header">
          {chapter !== undefined && <p className="chapter-kicker">Chapter {chapter}</p>}
          {titleZh !== undefined && <h1>{titleZh}</h1>}
          {titleEn !== undefined && <p className="chapter-subtitle">{titleEn}</p>}
        </header>
      )}
      <div className="chapter-grid">{children}</div>
    </article>
  );
}

/* ------------------------------------------------------------------ */

interface SectionDef {
  num: number;
  zh: string;
  en: string;
  slug: string;
}

const DEFS = {
  question: { num: 1, zh: '本章要回答的問題', en: 'Questions this chapter answers', slug: 'question' },
  intuition: { num: 2, zh: '物理直覺', en: 'Physical intuition', slug: 'intuition' },
  math: { num: 3, zh: '完整數學', en: 'Full mathematics', slug: 'math' },
  example: { num: 4, zh: '數值例子', en: 'Worked numerical example', slug: 'example' },
  figure: { num: 5, zh: '互動圖', en: 'Interactive figure', slug: 'figure' },
  code: { num: 6, zh: '行為程式碼', en: 'Behavioral code', slug: 'code' },
  linebyline: { num: 7, zh: '逐行解說', en: 'Line-by-line walkthrough', slug: 'linebyline' },
  observe: { num: 8, zh: '圖上應觀察什麼', en: 'What to observe', slug: 'observe' },
  misconception: { num: 9, zh: '常見誤解', en: 'Common misconceptions', slug: 'misconception' },
  takeaway: { num: 10, zh: '設計要點', en: 'Design takeaway', slug: 'takeaway' },
  limitation: { num: 11, zh: '模型限制', en: 'Model limitation', slug: 'limitation' },
} satisfies Record<string, SectionDef>;

function Section({
  def,
  children,
  headerExtra,
}: {
  def: SectionDef;
  children: ReactNode;
  headerExtra?: ReactNode;
}) {
  return (
    <section className={`chapter-section section-${def.slug}`}>
      <header className="section-header">
        <span className="section-num">{def.num}</span>
        <h2>
          <span className="section-title-zh">{def.zh}</span>
          <span className="section-title-en">{def.en}</span>
        </h2>
        {headerExtra}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}

export interface SectionProps {
  children: ReactNode;
}

export function SectionQuestion({ children }: SectionProps) {
  return <Section def={DEFS.question}>{children}</Section>;
}

export function SectionIntuition({ children }: SectionProps) {
  return <Section def={DEFS.intuition}>{children}</Section>;
}

export function SectionMath({ children }: SectionProps) {
  return <Section def={DEFS.math}>{children}</Section>;
}

export function SectionExample({ children }: SectionProps) {
  return <Section def={DEFS.example}>{children}</Section>;
}

export interface SectionFigureProps {
  /** figure title, e.g. 'x_ideal[k] trajectory, N = 3.130' */
  title: string;
  children: ReactNode;
  caption?: ReactNode;
}

/** Interactive figure: children are the chart(s)/controls; caption below. */
export function SectionFigure({ title, children, caption }: SectionFigureProps) {
  return (
    <Section def={DEFS.figure}>
      <figure className="section-figure">
        <div className="section-figure-title">{title}</div>
        <div className="section-figure-body">{children}</div>
        {caption !== undefined && <figcaption>{caption}</figcaption>}
      </figure>
    </Section>
  );
}

export interface SectionCodeProps {
  /** the behavioral code shown (monospace, copy button) */
  code: string;
  language?: string;
  title?: string;
  /** optional commentary rendered after the code block */
  children?: ReactNode;
}

export function SectionCode({ code, language, title, children }: SectionCodeProps) {
  return (
    <Section def={DEFS.code}>
      <CodeBlock code={code} language={language} title={title} />
      {children}
    </Section>
  );
}

export interface LineByLineItem {
  /** the code line(s), rendered monospace */
  code: string;
  /** the explanation for those line(s) */
  explain: ReactNode;
}

export interface SectionLineByLineProps {
  items: LineByLineItem[];
}

export function SectionLineByLine({ items }: SectionLineByLineProps) {
  return (
    <Section def={DEFS.linebyline}>
      <div className="linebyline">
        {items.map((item, i) => (
          <div className="linebyline-row" key={i}>
            <pre className="linebyline-code">
              <code>{item.code}</code>
            </pre>
            <div className="linebyline-explain">{item.explain}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

export function SectionObserve({ children }: SectionProps) {
  return <Section def={DEFS.observe}>{children}</Section>;
}

export function SectionMisconception({ children }: SectionProps) {
  return <Section def={DEFS.misconception}>{children}</Section>;
}

export function SectionTakeaway({ children }: SectionProps) {
  return <Section def={DEFS.takeaway}>{children}</Section>;
}

export function SectionLimitation({ children }: SectionProps) {
  return <Section def={DEFS.limitation}>{children}</Section>;
}
