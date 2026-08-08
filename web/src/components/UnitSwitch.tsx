/**
 * Phase display unit switching ('cycles' | 'deg' | 'time').
 *
 * A global UnitProvider wraps the app (main App component). Chapters call
 * useUnit() to read the active unit and feed it into lib/format.ts helpers.
 * UnitSwitch renders the segmented control; without props it binds to the
 * context, or pass value/onChange for a locally scoped unit.
 */

import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { PhaseUnit } from '../lib/format';

export interface UnitContextValue {
  unit: PhaseUnit;
  setUnit: (unit: PhaseUnit) => void;
}

const UnitContext = createContext<UnitContextValue>({
  unit: 'cycles',
  setUnit: () => undefined,
});

export function UnitProvider({
  children,
  initial = 'cycles',
}: {
  children: ReactNode;
  initial?: PhaseUnit;
}) {
  const [unit, setUnit] = useState<PhaseUnit>(initial);
  const value = useMemo(() => ({ unit, setUnit }), [unit]);
  return <UnitContext.Provider value={value}>{children}</UnitContext.Provider>;
}

export function useUnit(): UnitContextValue {
  return useContext(UnitContext);
}

const UNIT_OPTIONS: { value: PhaseUnit; label: string }[] = [
  { value: 'cycles', label: 'cycles' },
  { value: 'deg', label: 'deg' },
  { value: 'time', label: 'time' },
];

export interface UnitSwitchProps {
  value?: PhaseUnit;
  onChange?: (unit: PhaseUnit) => void;
}

export default function UnitSwitch({ value, onChange }: UnitSwitchProps) {
  const ctx = useUnit();
  const unit = value ?? ctx.unit;
  const set = onChange ?? ctx.setUnit;
  return (
    <div className="unit-switch" role="group" aria-label="phase display unit">
      {UNIT_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === unit ? 'active' : undefined}
          onClick={() => set(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
