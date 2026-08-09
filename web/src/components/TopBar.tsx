/**
 * Top bar: current chapter title, global N control (lib/globalParams),
 * simulation status indicator (SimStatusContext, with spinner while
 * running), theme toggle. Narrow viewports also get the nav toggle.
 */

import { useEffect, useState } from 'react';
import type { ChapterMeta } from '../chapters/index';
import { useSimStatus, type SimStatus } from '../SimStatusContext';
import { getThemeMode, setThemeMode, subscribeTheme, type ThemeMode } from '../lib/theme';
import { N_DIV_MAX, N_DIV_MIN, N_DIV_PRESETS, useGlobalNDiv } from '../lib/globalParams';

const STATUS_LABELS: Record<SimStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  done: 'Done',
};

function SimStatusIndicator() {
  const { status, message } = useSimStatus();
  return (
    <span className={`sim-status sim-status-${status}`} title={message || undefined}>
      {status === 'running' ? (
        <span className="sim-spinner" aria-hidden="true" />
      ) : (
        <span className="sim-status-dot" aria-hidden="true" />
      )}
      <span className="sim-status-text">
        {STATUS_LABELS[status]}
        {message ? ` — ${message}` : ''}
      </span>
    </span>
  );
}

function NDivControl() {
  const { nDiv, setNDiv } = useGlobalNDiv();
  const [text, setText] = useState<string>(String(nDiv));

  // Keep the input text in sync when N changes elsewhere (presets, chapters).
  useEffect(() => {
    setText((prev) => (Number(prev) === nDiv ? prev : String(nDiv)));
  }, [nDiv]);

  const commit = (raw: string) => {
    setText(raw);
    if (raw.trim() === '') return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    setNDiv(n);
  };

  return (
    <div className="topbar-ndiv" title="全站 N(divide ratio),切換章節時保留">
      <span className="topbar-ndiv-label">N</span>
      <div className="topbar-ndiv-presets" role="group" aria-label="N presets">
        {N_DIV_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            className={`topbar-ndiv-preset${nDiv === n ? ' topbar-ndiv-active' : ''}`}
            onClick={() => setNDiv(n)}
          >
            {String(n)}
          </button>
        ))}
      </div>
      <input
        type="number"
        className="topbar-ndiv-input"
        aria-label="N (divide ratio)"
        value={text}
        min={N_DIV_MIN}
        max={N_DIV_MAX}
        step={0.0025}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => setText(String(nDiv))}
      />
    </div>
  );
}

function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(getThemeMode);
  useEffect(() => subscribeTheme(setMode), []);
  const next: ThemeMode = mode === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setThemeMode(next)}
      aria-label={next === 'dark' ? 'switch to dark mode' : 'switch to light mode'}
    >
      {next === 'dark' ? '深色' : '淺色'}
    </button>
  );
}

export interface TopBarProps {
  chapter: ChapterMeta;
  onToggleNav: () => void;
}

export default function TopBar({ chapter, onToggleNav }: TopBarProps) {
  return (
    <header className="topbar">
      <button type="button" className="nav-toggle" onClick={onToggleNav} aria-label="toggle navigation">
        目錄
      </button>
      <div className="topbar-title">
        <span className="topbar-chapter-num">Ch {chapter.id}</span>
        <span className="topbar-chapter-zh">{chapter.titleZh}</span>
        <span className="topbar-chapter-en">{chapter.titleEn}</span>
      </div>
      <div className="topbar-right">
        <NDivControl />
        <SimStatusIndicator />
        <ThemeToggle />
      </div>
    </header>
  );
}
