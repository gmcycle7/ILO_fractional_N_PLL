/**
 * Inline callout box. Types:
 *   note    — neutral remark
 *   warn    — pitfall / caution
 *   honesty — model-honesty statement (what the model does NOT claim),
 *             matching the project's epistemic-honesty requirement.
 */

import type { ReactNode } from 'react';

export type CalloutType = 'note' | 'warn' | 'honesty';

const LABELS: Record<CalloutType, string> = {
  note: '註記 Note',
  warn: '注意 Caution',
  honesty: '誠實聲明 Honesty',
};

export interface CalloutProps {
  type?: CalloutType;
  title?: string;
  children: ReactNode;
}

export default function Callout({ type = 'note', title, children }: CalloutProps) {
  return (
    <aside className={`callout callout-${type}`}>
      <div className="callout-title">{title ?? LABELS[type]}</div>
      <div className="callout-body">{children}</div>
    </aside>
  );
}
