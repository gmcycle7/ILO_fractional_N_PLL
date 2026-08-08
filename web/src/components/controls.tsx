/**
 * Parameter controls: Slider, NumberInput, SelectControl, Toggle,
 * PresetButtons, ParamPanel.
 *
 * ParamPanel docking: render it as a DIRECT, LAST child of ChapterShell.
 * On >= 1280 px viewports CSS docks it as a sticky right column; on narrower
 * viewports it flows below the chapter content.
 */

import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { trimNumber } from '../lib/format';

/* ---------------------------------------------------------------- Slider */

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  /** logarithmic mapping (requires min > 0); slider position is log-spaced */
  log?: boolean;
  /** custom value display; default trims to 6 significant digits */
  fmt?: (value: number) => string;
}

const LOG_STEPS = 400;

export function Slider({ label, value, min, max, step, unit, onChange, log = false, fmt }: SliderProps) {
  const id = useId();
  const useLog = log && min > 0 && max > min;

  let sliderMin: number;
  let sliderMax: number;
  let sliderStep: number | 'any';
  let sliderValue: number;
  let handle: (raw: number) => void;

  if (useLog) {
    const lmin = Math.log(min);
    const lmax = Math.log(max);
    sliderMin = 0;
    sliderMax = LOG_STEPS;
    sliderStep = 1;
    sliderValue = Math.round((LOG_STEPS * (Math.log(Math.max(value, min)) - lmin)) / (lmax - lmin));
    handle = (raw) => onChange(Math.exp(lmin + (raw / LOG_STEPS) * (lmax - lmin)));
  } else {
    sliderMin = min;
    sliderMax = max;
    sliderStep = step ?? 'any';
    sliderValue = value;
    handle = onChange;
  }

  const display = fmt ? fmt(value) : trimNumber(value, 6);

  return (
    <div className="control control-slider">
      <label className="control-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={sliderMin}
        max={sliderMax}
        step={sliderStep}
        value={sliderValue}
        onChange={(e) => handle(Number(e.target.value))}
      />
      <span className="control-value">
        {display}
        {unit ? ` ${unit}` : ''}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------- NumberInput */

export interface NumberInputProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export function NumberInput({ label, value, onChange, min, max, step, unit }: NumberInputProps) {
  const id = useId();
  const [text, setText] = useState<string>(String(value));

  // Keep local text in sync when the value changes from outside.
  useEffect(() => {
    setText((prev) => (Number(prev) === value ? prev : String(value)));
  }, [value]);

  const commit = (raw: string) => {
    setText(raw);
    if (raw.trim() === '') return;
    let n = Number(raw);
    if (!Number.isFinite(n)) return;
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    onChange(n);
  };

  return (
    <div className="control control-number">
      <label className="control-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => setText(String(value))}
      />
      {unit && <span className="control-unit">{unit}</span>}
    </div>
  );
}

/* --------------------------------------------------------- SelectControl */

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

export interface SelectControlProps<T extends string = string> {
  label: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
}

export function SelectControl<T extends string = string>({
  label,
  value,
  options,
  onChange,
}: SelectControlProps<T>) {
  const id = useId();
  return (
    <div className="control control-select">
      <label className="control-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ---------------------------------------------------------------- Toggle */

export interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function Toggle({ label, checked, onChange }: ToggleProps) {
  const id = useId();
  return (
    <div className="control control-toggle">
      <label className="control-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}

/* --------------------------------------------------------- PresetButtons */

export interface PresetButtonsProps {
  label?: string;
  presets: { label: string; onClick: () => void }[];
}

export function PresetButtons({ label, presets }: PresetButtonsProps) {
  return (
    <div className="control control-presets">
      {label && <span className="control-label">{label}</span>}
      <div className="preset-buttons">
        {presets.map((p) => (
          <button key={p.label} type="button" className="preset-button" onClick={p.onClick}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ ParamPanel */

export interface ParamPanelProps {
  title?: string;
  children: ReactNode;
}

export function ParamPanel({ title, children }: ParamPanelProps) {
  return (
    <aside className="param-panel">
      <div className="param-panel-inner">
        <h3 className="param-panel-title">{title ?? '參數 Parameters'}</h3>
        {children}
      </div>
    </aside>
  );
}
