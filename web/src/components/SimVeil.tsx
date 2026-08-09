/**
 * Subtle progress veil for figure/table areas whose simulation results are
 * being (re)computed in a post-paint effect. Wrap the content:
 *
 *   <SimVeil active={runs === null}> ...charts/tables... </SimVeil>
 *
 * While `active`, a translucent overlay with a small spinner covers the
 * children (which keep their reserved layout height, so nothing jumps).
 */

import type { ReactNode } from 'react';

export interface SimVeilProps {
  active: boolean;
  children: ReactNode;
  /** short status label, default 模擬計算中… */
  label?: string;
}

export default function SimVeil({ active, children, label }: SimVeilProps) {
  return (
    <div className={`sim-veil-host${active ? ' sim-veil-on' : ''}`}>
      {children}
      {active && (
        <div className="sim-veil" role="status" aria-live="polite">
          <span className="sim-spinner" aria-hidden="true" />
          <span className="sim-veil-label">{label ?? '模擬計算中…'}</span>
        </div>
      )}
    </div>
  );
}
