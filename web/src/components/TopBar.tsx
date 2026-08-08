/**
 * Top bar: current chapter title, simulation status indicator
 * (SimStatusContext), theme toggle. Narrow viewports also get the nav toggle.
 */

import { useEffect, useState } from 'react';
import type { ChapterMeta } from '../chapters/index';
import { useSimStatus, type SimStatus } from '../SimStatusContext';
import { getThemeMode, setThemeMode, subscribeTheme, type ThemeMode } from '../lib/theme';

const STATUS_LABELS: Record<SimStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  done: 'Done',
};

function SimStatusIndicator() {
  const { status, message } = useSimStatus();
  return (
    <span className={`sim-status sim-status-${status}`} title={message || undefined}>
      <span className="sim-status-dot" aria-hidden="true" />
      <span className="sim-status-text">
        {STATUS_LABELS[status]}
        {message ? ` — ${message}` : ''}
      </span>
    </span>
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
        <SimStatusIndicator />
        <ThemeToggle />
      </div>
    </header>
  );
}
