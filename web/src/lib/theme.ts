/**
 * Theme tokens and light/dark switching.
 *
 * The page theme is controlled by the `data-theme` attribute on <html>
 * (values: 'light' | 'dark', default 'light'). All CSS reads CSS variables
 * defined per theme in index.css. Charts (ECharts canvas) cannot read CSS
 * variables, so chart code reads explicit color tokens from this module via
 * getChartTheme() and must re-render on theme change (see subscribeTheme /
 * useChartTheme in lib/useChartTheme.ts).
 */

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'ilo-theme';

export interface ChartTheme {
  mode: ThemeMode;
  /** primary text color for chart titles / legends */
  text: string;
  /** secondary text (axis labels, axis names) */
  textSubtle: string;
  /** axis line + tick color */
  axisLine: string;
  /** grid split line color */
  splitLine: string;
  /** chart background (transparent: page background shows through) */
  background: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  /** the single site accent color */
  accent: string;
  /** semantic colors for good / warning / bad annotations */
  good: string;
  warn: string;
  bad: string;
  /** categorical series palette (restrained engineering palette) */
  series: string[];
}

const LIGHT: ChartTheme = {
  mode: 'light',
  text: '#1f2937',
  textSubtle: '#64748b',
  axisLine: '#94a3b8',
  splitLine: '#e2e8f0',
  background: 'transparent',
  tooltipBg: '#ffffff',
  tooltipBorder: '#cbd5e1',
  tooltipText: '#1f2937',
  accent: '#2c5fa8',
  good: '#2e7d43',
  warn: '#b07d10',
  bad: '#b03a2e',
  series: ['#2c5fa8', '#b45309', '#0f766e', '#6d28d9', '#be123c', '#475569', '#0e7490', '#7c2d12'],
};

const DARK: ChartTheme = {
  mode: 'dark',
  text: '#dfe5ec',
  textSubtle: '#98a2b0',
  axisLine: '#5b6472',
  splitLine: '#2a323e',
  background: 'transparent',
  tooltipBg: '#1b212a',
  tooltipBorder: '#3a4452',
  tooltipText: '#dfe5ec',
  accent: '#6ea3e8',
  good: '#6dbf85',
  warn: '#d9a24a',
  bad: '#e07b6e',
  series: ['#6ea3e8', '#d9a24a', '#4fb3a5', '#a78bfa', '#e37f95', '#94a3b8', '#5bb8d4', '#c98a6b'],
};

export const CHART_THEMES: Record<ThemeMode, ChartTheme> = { light: LIGHT, dark: DARK };

/** Read the current theme mode from <html data-theme>. Defaults to 'light'. */
export function getThemeMode(): ThemeMode {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Set theme mode: stamps <html data-theme> and persists to localStorage. */
export function setThemeMode(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', mode);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* localStorage unavailable: ignore */
  }
}

export function toggleThemeMode(): ThemeMode {
  const next: ThemeMode = getThemeMode() === 'dark' ? 'light' : 'dark';
  setThemeMode(next);
  return next;
}

/**
 * Idempotent startup initialization (also done by an inline script in
 * index.html before first paint). Default is light.
 */
export function initTheme(): void {
  if (typeof document === 'undefined') return;
  let mode: ThemeMode = 'light';
  try {
    if (localStorage.getItem(STORAGE_KEY) === 'dark') mode = 'dark';
  } catch {
    /* localStorage unavailable: keep light */
  }
  document.documentElement.setAttribute('data-theme', mode);
}

/**
 * Subscribe to theme changes (MutationObserver on <html data-theme>).
 * Returns an unsubscribe function.
 */
export function subscribeTheme(callback: (mode: ThemeMode) => void): () => void {
  const observer = new MutationObserver(() => callback(getThemeMode()));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}

/** Chart color tokens for the currently active theme. */
export function getChartTheme(): ChartTheme {
  return CHART_THEMES[getThemeMode()];
}
