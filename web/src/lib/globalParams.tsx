/**
 * Global cross-chapter parameters. Currently a single value: the divide
 * ratio N (n_div), shared by the TopBar N control and every chapter that
 * exposes an N / α control.
 *
 * - Persisted in sessionStorage['pll_n_div'] (per-tab, survives reloads).
 * - Chapters keep their own local state but seed it from the global value
 *   and write back on change via useChapterNDiv() / useChapterAlpha().
 * - Changing N in the TopBar re-initializes the current chapter's local N
 *   state through the context subscription inside those hooks.
 *
 * SSR-safe: no window access at module scope; render smoke tests run the
 * chapters without a provider and fall back to the default context value.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

const STORAGE_KEY = 'pll_n_div';

export const N_DIV_DEFAULT = 3.13;
export const N_DIV_MIN = 3.0;
export const N_DIV_MAX = 3.25;

/** The five canonical presets used by every chapter's "Preset N" buttons. */
export const N_DIV_PRESETS: number[] = [3.0, 3.125, 3.13, 3.1375, 3.25];

export interface GlobalParamsValue {
  nDiv: number;
  setNDiv: (n: number) => void;
}

const GlobalParamsContext = createContext<GlobalParamsValue>({
  nDiv: N_DIV_DEFAULT,
  setNDiv: () => undefined,
});

function clampNDiv(n: number): number {
  return Math.min(N_DIV_MAX, Math.max(N_DIV_MIN, n));
}

function readStoredNDiv(): number {
  if (typeof window === 'undefined') return N_DIV_DEFAULT;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return N_DIV_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) ? clampNDiv(n) : N_DIV_DEFAULT;
  } catch {
    return N_DIV_DEFAULT;
  }
}

export function GlobalParamsProvider({ children }: { children: ReactNode }) {
  const [nDiv, setNDivState] = useState<number>(readStoredNDiv);

  const setNDiv = useCallback((n: number) => {
    if (!Number.isFinite(n)) return;
    const clamped = clampNDiv(n);
    setNDivState(clamped);
    try {
      window.sessionStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      /* sessionStorage unavailable */
    }
  }, []);

  const value = useMemo<GlobalParamsValue>(() => ({ nDiv, setNDiv }), [nDiv, setNDiv]);
  return <GlobalParamsContext.Provider value={value}>{children}</GlobalParamsContext.Provider>;
}

export function useGlobalNDiv(): GlobalParamsValue {
  return useContext(GlobalParamsContext);
}

/**
 * Chapter-local N state, seeded from the global N, re-initialized whenever
 * the global value changes (TopBar edits), and written back on local change
 * (slider / preset inside the chapter).
 */
export function useChapterNDiv(): [number, (n: number) => void] {
  const { nDiv, setNDiv } = useGlobalNDiv();
  const [local, setLocal] = useState<number>(nDiv);

  // Global -> local. A functional update returning the previous value when
  // it already matches avoids render churn on the chapter's own write-backs.
  useEffect(() => {
    setLocal((prev) => (prev === nDiv ? prev : nDiv));
  }, [nDiv]);

  // Local -> global (write back).
  const set = useCallback(
    (n: number) => {
      setLocal(n);
      setNDiv(n);
    },
    [setNDiv],
  );
  return [local, set];
}

/**
 * Same as useChapterNDiv but exposed as α = N − 3 for chapters whose local
 * state is the fractional part.
 */
export function useChapterAlpha(): [number, (alpha: number) => void] {
  const [nDiv, setNDiv] = useChapterNDiv();
  const setAlpha = useCallback((alpha: number) => setNDiv(3 + alpha), [setNDiv]);
  return [nDiv - 3, setAlpha];
}
