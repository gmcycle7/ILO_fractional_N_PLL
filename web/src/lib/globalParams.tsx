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

/** One selectable N value. `label` is compact (button / option text), `hint` is the tooltip. */
export interface NDivPreset {
  /** float64 divide ratio N, always inside [N_DIV_MIN, N_DIV_MAX]. */
  n: number;
  /** compact display string (base group uses exactly `String(n)`). */
  label: string;
  /** zh-Hant + English-terms one-liner: α·G, period P, spur spacing, story. */
  hint: string;
}

/** A named group of presets; groups keep the UI uncluttered (see TopBar). */
export interface NDivPresetGroup {
  label: string;
  values: NDivPreset[];
}

/**
 * Grouped preset catalogue (MODEL_SPEC §1 preset table).
 *
 * Index 0 is the 基本 group and its `n` values mirror `N_DIV_PRESETS` exactly
 * (byte-identical order); TopBar renders it as the always-visible buttons and
 * puts `N_DIV_PRESET_GROUPS.slice(1)` behind one compact `<select>`.
 *
 * Period `P` in the hints is the period of the feedback quantization error
 * sequence at the DTC grid: reduce α = N − 3 to p/q, then `P = q / gcd(q, G)`
 * with `G = 256` (MODEL_SPEC §4/§17). Deterministic spurs land at
 * `f_spur,m = (m/P) * f_ref`, i.e. spacing `f_ref / P` with `f_ref = 4 GHz`.
 * `P = 1` means α is on-grid and `e_FB ≡ 0` — no fractional spur at all.
 *
 * float64 note: only 3.0, 3.125, 3.25, F1, F2 and F6 are dyadic and therefore
 * exactly representable; the rest are the nearest double to the stated decimal
 * (F8 is the nearest double to an irrational). The deviation is ~1e-16 per
 * reference edge, far below the 1/256-cycle LSB over any practical run length,
 * so the observed error period matches the nominal P.
 */
export const N_DIV_PRESET_GROUPS: NDivPresetGroup[] = [
  {
    label: '基本',
    values: [
      { n: 3.0, label: '3', hint: 'integer-N:α = 0,α·G = 0,on-grid,e_FB ≡ 0(P = 1);f_vco = 12 GHz' },
      {
        n: 3.125,
        label: '3.125',
        hint: 'on-grid α = 1/8:α·G = 32,e_FB ≡ 0(P = 1);f_vco = 12.5 GHz,LSB = 312.5 fs',
      },
      {
        n: 3.13,
        label: '3.13',
        hint: '預設 off-grid 主力案例:α·G = 33.28,P = 25 → spur 間距 160 MHz;f_vco = 12.52 GHz',
      },
      {
        n: 3.1375,
        label: '3.1375',
        hint: 'off-grid α = 11/80:α·G = 35.2,P = 5 → spur 間距 800 MHz;f_vco = 12.55 GHz',
      },
      { n: 3.25, label: '3.25', hint: 'on-grid α = 1/4:α·G = 64,e_FB ≡ 0(P = 1);f_vco = 13 GHz' },
    ],
  },
  {
    label: 'sub-LSB 階梯',
    values: [
      {
        n: 3.126953125,
        label: '3.126953125 · ½ LSB tie',
        hint: 'α·G = 32.5 半 LSB tie:half-up qNearest 每隔一拍才進位,P = 2 → Nyquist tone @ f_ref/2 = 2 GHz;f_vco = 12.5078125 GHz',
      },
      {
        n: 3.1259765625,
        label: '3.1259765625 · ¼ LSB',
        hint: 'α·G = 32.25,殘量 0.25 LSB:P = 4 → spur 間距 1 GHz;f_vco = 12.50390625 GHz',
      },
      {
        n: 3.125390625,
        label: '3.125390625 · 0.1 LSB',
        hint: 'α·G = 32.1,殘量 0.1 LSB:P = 10 → spur 間距 400 MHz;f_vco = 12.5015625 GHz',
      },
      {
        n: 3.1250390625,
        label: '3.1250390625 · 0.01 LSB',
        hint: 'α·G = 32.01,殘量 0.01 LSB(fractional boundary):P = 100 → close-in spur 間距 40 MHz;f_vco = 12.50015625 GHz',
      },
    ],
  },
  {
    label: '特殊',
    values: [
      {
        n: 3.2,
        label: '3.2 · 三層 grid 同 P',
        hint: 'α = 1/5:integer / PMUX / DTC 三層 grid 的 P 都是 5 → spur 間距 800 MHz;f_vco = 12.8 GHz',
      },
      {
        n: 3.22265625,
        label: '3.22265625 · Ethernet',
        hint: 'f_vco = 12.890625 GHz = 25.78125 Gbps / 2(Ethernet):α·G = 57 exactly on-grid,e_FB ≡ 0(P = 1)',
      },
      {
        n: 3.001,
        label: '3.001 · near-integer',
        hint: 'near-integer α = 0.001 < 3/256 → DSM 進入 n_int = 2 regime;P = 125 → close-in spur 間距 32 MHz;f_vco = 12.004 GHz',
      },
      {
        n: 3.1545084971874737,
        label: '3.1545084971874737 · 1/φ',
        hint: 'α = 0.25/φ(golden ratio,φ =(1+√5)/2):quasi-periodic,無離散 spur;APPROX — float64 嚴格來說仍是有理數,只是週期遠長於任何模擬長度',
      },
    ],
  },
];

/** Flattened catalogue (all groups, in group order). */
export const N_DIV_ALL_PRESETS: NDivPreset[] = N_DIV_PRESET_GROUPS.flatMap((g) => g.values);

/** Exact float64 lookup — returns the preset whose `n` is bit-identical to `n`. */
export function findNDivPreset(n: number): NDivPreset | undefined {
  return N_DIV_ALL_PRESETS.find((p) => p.n === n);
}

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
