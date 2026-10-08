/**
 * Chapter 23 — 設計工具 Design Tools:Frequency Planner 與 Jitter Budget
 *
 * Content contract: CHAPTER_GUIDE.md(11 節 ChapterShell 固定順序;SectionMath
 * 之後緊接三個 ExampleProblem);math contract: MODEL_SPEC.md §1/§1.1(N 範圍、
 * P = q/gcd(q, G))、§2(qNearest half-up)、§4(e_FB_abs)、§8/§10(injection
 * mapping 與 analog nonidealities)、§14(reset injection、e_ZC_total)、§17
 * (spur 落點 m·f_ref/P、sample rate = f_ref)。
 *
 * 工具一 Frequency Planner:給定 f_vco 與 f_ref 候選(清單或 sweep),以連分數
 * 求 α ≈ p/q(分母上限 4096)→ 三級 grid 的誤差週期 P = q/gcd(q, G_s)、spur 基頻
 * f_ref/P、nearest 峰值誤差;依 loop bandwidth 分帶內/帶外並排名。選取任一列即以
 * simulate()(f_ref_hz、n_div)即時確認 P 與 spur 間距。
 * 工具二 Jitter Budget:random 項 RSS、deterministic 項 worst-case 與 RSS 兩種合成、
 * dual-Dirac TJ(BER);一鍵以 simulate()(reset injection + 等效 nonidealities)
 * 交叉驗證,誠實顯示比值。
 *
 * 所有引用數字均以 python3(model/python,同一 golden model)交叉驗證。本章 helper
 * (連分數、Acklam Φ⁻¹)屬規劃層計算,不重做任何 wrap/quantizer/DSM 數學。
 */

import { useEffect, useId, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ChapterShell,
  SectionQuestion,
  SectionIntuition,
  SectionMath,
  SectionExample,
  SectionFigure,
  SectionCode,
  SectionLineByLine,
  SectionObserve,
  SectionMisconception,
  SectionTakeaway,
  SectionLimitation,
} from '../components/ChapterShell';
import EChart from '../components/EChart';
import EpistemicTag from '../components/EpistemicTag';
import Callout from '../components/Callout';
import ExampleProblem, { fmt } from '../components/ExampleProblem';
import { M, MathBlock } from '../components/Math';
import {
  ParamPanel,
  Slider,
  NumberInput,
  SelectControl,
  Toggle,
  PresetButtons,
} from '../components/controls';
import { makeLineOption, makeMarkLine } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { trimNumber } from '../lib/format';
import { useChapterNDiv, N_DIV_PRESETS } from '../lib/globalParams';
import { chapterHref } from '../lib/router';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  simulate,
  fromPartial,
  replaceConfig,
  configG,
  configAlpha,
  configTVcoS,
  qNearest,
  periodogramPsd,
  detectSpurs,
  rms,
  peakToPeak,
  TWO_PI,
  FS,
} from '../model';
import type { InjMapping, SimConfig } from '../model';

// registry 由 integration agent 加入(id 23,slug design-tools);未註冊前用 fallback。
const meta = chapterById(23) ?? {
  id: 23,
  titleZh: '設計工具:Frequency Planner 與 Jitter Budget',
  titleEn: 'Design Tools',
};

const F_REF_DEFAULT = 4e9; // 全站預設 f_ref(MODEL_SPEC §1)
const N_LO = 3.0; // 本 /3-/4 架構的合法 N 範圍(α ∈ [0, 0.25],MODEL_SPEC §1)
const N_HI = 3.25;
const CF_QMAX = 4096; // 連分數分母上限
const CF_TOL = 1e-10; // |α − p/q| < tol 判為 exact(float64 f_vco/f_ref 的捨入 ~1e-16)
const NC_PLAN = 1024; // planner 確認模擬拍數(2 的冪 → PSD bin = f_ref/1024)
const NC_SHOW = 256; // 時域圖顯示拍數
const NC_XCHECK = 4096; // cross-check 拍數(按鈕觸發,full + deterministic 兩次)
const XC_TAP = 3; // tap mismatch 放在 tap 3(與 Ch7/Ch15 一致)
const MAX_ROWS = 401;
const DEFAULT_LIST = '3.84, 3.90625, 3.96, 4.0, 4.096, 4.125, 4.25';

/* ------------------------------------------------------------------ */
/* 規劃層 helpers(SectionCode 引用的即為此段真實碼)                   */
/* ------------------------------------------------------------------ */

/** 最大公因數(非負整數)。 */
function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

interface RatApprox {
  p: number;
  q: number;
  err: number; // |x − p/q|
  exact: boolean; // err < tol(float64 意義下就是 p/q)
}

/**
 * 連分數展開 x = [a0; a1, a2, …],逐一產生 convergent p/q。
 * 回傳 q ≤ qMax 的最後一個 convergent;|x − p/q| < tol 即判 exact 並提早結束。
 */
function cfApprox(x: number, qMax = CF_QMAX, tol = CF_TOL): RatApprox | null {
  let p0 = 0;
  let q0 = 1;
  let p1 = 1;
  let q1 = 0;
  let a = x;
  let best: RatApprox | null = null;
  for (let i = 0; i < 64; i++) {
    const ai = Math.floor(a);
    const p2 = ai * p1 + p0; // p_i = a_i·p_{i−1} + p_{i−2}
    const q2 = ai * q1 + q0; // q_i = a_i·q_{i−1} + q_{i−2}
    if (q2 > qMax) break;
    p0 = p1;
    q0 = q1;
    p1 = p2;
    q1 = q2;
    const err = Math.abs(x - p1 / q1);
    best = { p: p1, q: q1, err, exact: err < tol };
    if (best.exact) return best;
    const fr = a - ai;
    if (fr < 1e-15) break;
    a = 1 / fr;
  }
  return best;
}

/**
 * stage grid(每 VCO cycle G 步)上 nearest 量化誤差序列的週期 P。
 * α = p/q(最簡)⇒ P = q / gcd(q, G)。α 的分母 > qMax 時改對 frac(α·G) 做連分數:
 * frac(α·G) 的最簡分母恰為 q / gcd(q, G)(同一恆等式)。都找不到 → null(長週期)。
 */
function stagePeriod(alpha: number, g: number): number | null {
  const r = cfApprox(alpha);
  if (r !== null && r.exact) return r.q / gcd(r.q, g);
  const y = alpha * g;
  const r2 = cfApprox(y - Math.floor(y));
  return r2 !== null && r2.exact ? r2.q : null;
}

type Band = 'exact' | 'out' | 'in' | 'illegal';

interface PlanRow {
  fRefGHz: number;
  fRefHz: number;
  n: number;
  legal: boolean;
  reason: string;
  alphaG: number; // (N − 3)·G
  dist: number; // α·G − qNearest(α·G),LSB
  rat: RatApprox | null;
  pStage: (number | null)[]; // [divider, PMUX, DTC]
  spurHz: number | null; // f_ref / P_DTC(P = 1 或未知 → null)
  peakFs: number; // nearest 峰值 ⌊P/2⌋/P LSB(P 未知 → 0.5 LSB 上界)
  tVcoS: number;
  band: Band;
}

/** 單一候選 f_ref 的規劃列:N、α 與 grid 皆取自 model config。 */
function planRow(fVcoGHz: number, fRefGHz: number, bwMHz: number): PlanRow {
  const fRefHz = fRefGHz * 1e9;
  const n = (fVcoGHz * 1e9) / fRefHz;
  const cfg = fromPartial({ f_ref_hz: fRefHz, n_div: n });
  const g = configG(cfg); // 256 = n_pmux · 2^b_dtc
  const tVcoS = configTVcoS(cfg); // 1 / (N·f_ref)
  const alpha = configAlpha(cfg); // N − trunc(N)
  const legal = n >= N_LO && n <= N_HI;
  const reason =
    n < N_LO ? 'N < 3:/3-/4 無法產生' : n > N_HI ? 'N > 3.25:超出 α ∈ [0, 0.25]' : '';
  const alphaG = (n - 3) * g;
  const dist = alphaG - qNearest(alphaG); // half-up(MODEL_SPEC §2)
  const rat = cfApprox(alpha);
  const pStage = [1, cfg.n_pmux, g].map((gs) => stagePeriod(alpha, gs));
  const pDtc = pStage[2];
  const spurHz = pDtc === null || pDtc === 1 ? null : fRefHz / pDtc;
  const peakLsb = pDtc === null ? 0.5 : Math.floor(pDtc / 2) / pDtc;
  const peakFs = (peakLsb * tVcoS) / g / FS;
  const band: Band = !legal
    ? 'illegal'
    : pDtc === 1
      ? 'exact'
      : spurHz !== null && spurHz > bwMHz * 1e6
        ? 'out'
        : 'in';
  return { fRefGHz, fRefHz, n, legal, reason, alphaG, dist, rat, pStage, spurHz, peakFs, tVcoS, band };
}

const BAND_ORDER: Record<Band, number> = { exact: 0, out: 1, in: 2, illegal: 3 };

/** 排名:exact → 帶外(P 小者先)→ 帶內(P 小者先)→ 不合法;同級再比 f_ref。 */
function rankCompare(a: PlanRow, b: PlanRow): number {
  const c = BAND_ORDER[a.band] - BAND_ORDER[b.band];
  if (c !== 0) return c;
  const pa = a.pStage[2] ?? Infinity;
  const pb = b.pStage[2] ?? Infinity;
  if (pa !== pb) return pa < pb ? -1 : 1;
  return a.fRefGHz - b.fRefGHz;
}

type SortKey = 'rank' | 'fref' | 'n' | 'pdtc' | 'spur' | 'peak';

function sortValue(r: PlanRow, key: SortKey): number {
  switch (key) {
    case 'fref':
      return r.fRefGHz;
    case 'n':
      return r.n;
    case 'pdtc':
      return r.pStage[2] ?? Infinity;
    case 'spur':
      // exact(無 spur)視為 +∞;P 未知(< f_ref/4096)視為 0
      return r.spurHz ?? (r.pStage[2] === 1 ? Infinity : 0);
    default:
      return r.peakFs;
  }
}

function parseList(text: string): number[] {
  const out: number[] = [];
  for (const tok of text.split(/[\s,;]+/)) {
    if (tok === '') continue;
    const v = Number(tok);
    if (Number.isFinite(v) && v > 0 && !out.includes(v)) out.push(v);
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

function sweepList(start: number, stop: number, step: number): number[] {
  if (!(start > 0) || !(step > 0) || !(stop >= start)) return [];
  const count = Math.min(MAX_ROWS, Math.floor((stop - start) / step + 1e-9) + 1);
  return Array.from({ length: count }, (_, i) => start + i * step);
}

function maxAbs(x: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > m) m = a;
  }
  return m;
}

/** 序列的最小週期(容差比較;float64 準週期用,同 Ch21)。 */
function findPeriod(e: ArrayLike<number>, maxP: number, tol = 1e-9): number | null {
  const n = e.length;
  for (let p = 1; p <= maxP; p++) {
    if (n < 2 * p) break;
    let ok = true;
    for (let k = 0; k + p < n; k++) {
      if (Math.abs(e[k] - e[k + p]) >= tol) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
  }
  return null;
}

function toXYScaled(ys: ArrayLike<number>, count: number, scale: number): [number, number][] {
  const n = Math.min(count, ys.length);
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) out.push([k, ys[k] * scale]);
  return out;
}

interface ConfirmRun {
  eFs: [number, number][];
  psd: [number, number][];
  detP: number | null;
  peakFs: number;
  strong: number;
  onGrid: number;
  lowestHz: number | null;
  topHz: number | null;
  binHz: number;
}

/** 選中列的 live 確認:simulate(f_ref_hz, n_div, nearest)→ e_FB_abs 週期、峰值、spur 落點。 */
function runConfirm(fRefHz: number, n: number, pDtc: number | null): ConfirmRun {
  const res = simulate(fromPartial({ f_ref_hz: fRefHz, n_div: n, n_cycles: NC_PLAN, quantizer: 'nearest' }));
  const e = res.data.e_FB_abs;
  const fsPerCyc = res.t_vco_s / FS;
  const { freqsHz, psd } = periodogramPsd(e, fRefHz); // sample rate = f_ref(§17)
  const binHz = freqsHz[1];
  const spurs = detectSpurs(freqsHz, psd, 10);
  const topDb = spurs.length > 0 ? spurs[0].psdDb : 0;
  const strong = spurs.filter((s) => s.psdDb >= topDb - 30);
  let onGrid = 0;
  if (pDtc !== null && pDtc > 1) {
    const spacing = fRefHz / pDtc;
    for (const s of strong) {
      const m = qNearest(s.freqHz / spacing);
      if (Math.abs(s.freqHz - m * spacing) <= 1.5 * binHz) onGrid += 1;
    }
  }
  let lowestHz: number | null = null;
  for (const s of strong) if (lowestHz === null || s.freqHz < lowestHz) lowestHz = s.freqHz;
  const pts: [number, number][] = [];
  for (let i = 1; i < freqsHz.length; i++) {
    pts.push([freqsHz[i] / 1e6, 10 * Math.log10(Math.max(psd[i], 1e-30))]);
  }
  return {
    eFs: toXYScaled(e, NC_SHOW, fsPerCyc),
    psd: pts,
    detP: findPeriod(e, NC_PLAN / 2),
    peakFs: maxAbs(e) * fsPerCyc,
    strong: strong.length,
    onGrid,
    lowestHz,
    topHz: strong.length > 0 ? strong[0].freqHz : null,
    binHz,
  };
}

/* ------------------------------------------------------------------ */
/* Jitter budget helpers                                               */
/* ------------------------------------------------------------------ */

const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
];
const ACKLAM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
];
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
];
const ACKLAM_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

/** Φ⁻¹(p):Acklam rational approximation(python 對 scipy 驗證:相對誤差 ≤ 1.15e-9)。 */
function normInv(p: number): number {
  const [a0, a1, a2, a3, a4, a5] = ACKLAM_A;
  const [b0, b1, b2, b3, b4] = ACKLAM_B;
  const [c0, c1, c2, c3, c4, c5] = ACKLAM_C;
  const [d0, d1, d2, d3] = ACKLAM_D;
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  }
  if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
      (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
}

/** erfc⁻¹(y) = −Φ⁻¹(y/2)/√2。 */
function erfcInv(y: number): number {
  return -normInv(y / 2) / Math.SQRT2;
}

/** dual-Dirac:BER = ½·erfc(Q/√2) ⇒ Q = √2·erfc⁻¹(2·BER);Q(1e-12) = 7.034。 */
function qOfBer(ber: number): number {
  return Math.SQRT2 * erfcInv(2 * ber);
}

type TermKey = 'ref' | 'vco' | 'pulse' | 'quant' | 'tap' | 'gain' | 'inl' | 'route';

interface BudgetIn {
  tVcoS: number;
  g: number;
  dtcRangeLsb: number; // 2^b_dtc = 64
  sRefFs: number;
  sVcoFs: number;
  sPulseFs: number;
  quantFs: number;
  tapDeg: number;
  gainPct: number;
  inlLsb: number;
  routeFs: number;
  ber: number;
}

interface Term {
  key: TermKey;
  label: string;
  kind: 'RJ' | 'DJ';
  input: string;
  fs: number; // RJ:σ(fs);DJ:單邊峰值 d_i(fs)
  shareWc: number; // 在 TJ_wc 中的加法份額(fs)
  shareRss: number; // 在 TJ_rss 中的加法份額(fs)
}

interface Budget {
  tVcoFs: number;
  lsbFs: number;
  terms: Term[];
  rj: number;
  dWc: number;
  dRss: number;
  q: number;
  tjWc: number;
  tjRss: number;
  rmsEst: number;
  dominant: TermKey;
}

/** budget 合成:RJ 取 RSS;DJ 取 worst-case 線性和與 RSS;dual-Dirac TJ。 */
function computeBudget(b: BudgetIn): Budget {
  const tVcoFs = b.tVcoS / FS; // configTVcoS → fs
  const lsbFs = tVcoFs / b.g; // 1 LSB = T_vco / G
  const rjIn: [TermKey, string, string, number][] = [
    ['ref', 'reference jitter', `${trimNumber(b.sRefFs, 5)} fs rms`, b.sRefFs],
    ['vco', 'VCO residual / cycle', `${trimNumber(b.sVcoFs, 5)} fs rms`, b.sVcoFs],
    ['pulse', 'pulse timing noise', `${trimNumber(b.sPulseFs, 5)} fs rms`, b.sPulseFs],
  ];
  const djIn: [TermKey, string, string, number][] = [
    ['quant', 'quantization peak', `${trimNumber(b.quantFs, 5)} fs`, b.quantFs],
    ['tap', 'tap mismatch', `${trimNumber(b.tapDeg, 4)}°`, (b.tapDeg / 360) * tVcoFs],
    ['gain', 'DTC gain mismatch', `${trimNumber(b.gainPct, 4)}% × ${b.dtcRangeLsb} LSB`, (b.gainPct / 100) * b.dtcRangeLsb * lsbFs],
    ['inl', 'DTC INL', `${trimNumber(b.inlLsb, 4)} LSB`, b.inlLsb * lsbFs],
    ['route', 'route skew', `${trimNumber(b.routeFs, 5)} fs`, Math.abs(b.routeFs)],
  ];
  const rj = Math.sqrt(rjIn.reduce((s, t) => s + t[3] * t[3], 0));
  const dWc = djIn.reduce((s, t) => s + t[3], 0);
  const dRss = Math.sqrt(djIn.reduce((s, t) => s + t[3] * t[3], 0));
  const q = qOfBer(b.ber);
  const tjWc = 2 * dWc + 2 * q * rj;
  const tjRss = 2 * dRss + 2 * q * rj;
  const rmsEst = Math.sqrt(rj * rj + (dRss * dRss) / 3);
  const rjShare = (s: number) => (rj > 0 ? (2 * q * rj * s * s) / (rj * rj) : 0);
  const terms: Term[] = [
    ...rjIn.map(([key, label, input, s]) => ({
      key, label, kind: 'RJ' as const, input, fs: s, shareWc: rjShare(s), shareRss: rjShare(s),
    })),
    ...djIn.map(([key, label, input, d]) => ({
      key, label, kind: 'DJ' as const, input, fs: d, shareWc: 2 * d,
      shareRss: dRss > 0 ? (2 * d * d) / dRss : 0,
    })),
  ];
  let dominant: TermKey = terms[0].key;
  let best = -1;
  for (const t of terms) {
    if (t.shareWc > best) {
      best = t.shareWc;
      dominant = t.key;
    }
  }
  return { tVcoFs, lsbFs, terms, rj, dWc, dRss, q, tjWc, tjRss, rmsEst, dominant };
}

/** cross-check 的等效 config:reset injection + 與 budget 同值的 nonidealities。 */
function xcConfig(n: number, fRefHz: number, b: BudgetIn, mapping: InjMapping, noise: boolean): SimConfig {
  const base = fromPartial({ n_div: n, f_ref_hz: fRefHz });
  const tVcoS = configTVcoS(base);
  const tap = new Array<number>(base.n_tap).fill(0);
  tap[XC_TAP] = b.tapDeg / 360;
  return replaceConfig(base, {
    n_cycles: NC_XCHECK,
    inj_model: 'reset',
    delta_f_hz: 0,
    inj_mapping: mapping,
    tap_mismatch_cycles: tap,
    dtc_inj_gain: 1 + b.gainPct / 100,
    inl_sin_amp_cycles: b.inlLsb / configG(base),
    route_inj_cycles: (b.routeFs * FS) / tVcoS,
    sigma_ref_s: noise ? b.sRefFs * FS : 0,
    sigma_pulse_s: noise ? b.sPulseFs * FS : 0,
    sigma_vco_w_rad: noise ? (TWO_PI * b.sVcoFs * FS) / tVcoS : 0,
  });
}

interface XcStats {
  rj: number;
  djPp: number;
  djPeak: number;
  rms: number;
  peak: number;
}

interface XcResult {
  sig: string;
  budget: Budget;
  n: number;
  fRefHz: number;
  mapping: InjMapping;
  qN: number;
  resetRj: number;
  th: XcStats;
  ez: XcStats;
  thSeries: [number, number][];
  ezSeries: [number, number][];
}

function diff(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

function scaled(a: Float64Array, s: number): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * s;
  return out;
}

function stats(full: Float64Array, det: Float64Array): XcStats {
  return {
    rj: rms(diff(full, det)), // 隨機部分:同一 deterministic 序列相減
    djPp: peakToPeak(det),
    djPeak: maxAbs(det),
    rms: rms(full),
    peak: maxAbs(full),
  };
}

/** 兩次 simulate():full(含隨機源)與 deterministic-only,θ⁻ 與 e_ZC_total 轉成 fs。 */
function runCrossCheck(sig: string, n: number, fRefHz: number, b: BudgetIn, mapping: InjMapping): XcResult {
  const full = simulate(xcConfig(n, fRefHz, b, mapping, true));
  const det = simulate(xcConfig(n, fRefHz, b, mapping, false));
  const fsPerCyc = full.t_vco_s / FS;
  const radToFs = fsPerCyc / TWO_PI;
  const thF = scaled(full.data.theta_minus, radToFs); // θ⁻:kick 前 VCO 絕對相位誤差
  const thD = scaled(det.data.theta_minus, radToFs);
  const ezF = scaled(full.data.e_ZC_total, fsPerCyc); // e_ZC_total:pulse 處 ZC miss
  const ezD = scaled(det.data.e_ZC_total, fsPerCyc);
  return {
    sig,
    budget: computeBudget(b),
    n,
    fRefHz,
    mapping,
    qN: qOfBer(1 / NC_XCHECK),
    resetRj: Math.sqrt(b.sVcoFs ** 2 + 2 * b.sRefFs ** 2 + 2 * b.sPulseFs ** 2),
    th: stats(thF, thD),
    ez: stats(ezF, ezD),
    thSeries: toXYScaled(thF, NC_SHOW, 1),
    ezSeries: toXYScaled(ezF, NC_SHOW, 1),
  };
}

/* ------------------------------------------------------------------ */
/* SectionCode 引用字串(與上方真實碼逐字同步)                        */
/* ------------------------------------------------------------------ */

const PLANNER_SRC = `function cfApprox(x: number, qMax = CF_QMAX, tol = CF_TOL): RatApprox | null {
  let p0 = 0;
  let q0 = 1;
  let p1 = 1;
  let q1 = 0;
  let a = x;
  let best: RatApprox | null = null;
  for (let i = 0; i < 64; i++) {
    const ai = Math.floor(a);
    const p2 = ai * p1 + p0; // p_i = a_i·p_{i−1} + p_{i−2}
    const q2 = ai * q1 + q0; // q_i = a_i·q_{i−1} + q_{i−2}
    if (q2 > qMax) break;
    p0 = p1;
    q0 = q1;
    p1 = p2;
    q1 = q2;
    const err = Math.abs(x - p1 / q1);
    best = { p: p1, q: q1, err, exact: err < tol };
    if (best.exact) return best;
    const fr = a - ai;
    if (fr < 1e-15) break;
    a = 1 / fr;
  }
  return best;
}

function stagePeriod(alpha: number, g: number): number | null {
  const r = cfApprox(alpha);
  if (r !== null && r.exact) return r.q / gcd(r.q, g);
  const y = alpha * g;
  const r2 = cfApprox(y - Math.floor(y));
  return r2 !== null && r2.exact ? r2.q : null;
}

// planRow(節錄):N、α、grid、T_vco 全部取自 model config
  const cfg = fromPartial({ f_ref_hz: fRefHz, n_div: n });
  const g = configG(cfg); // 256 = n_pmux · 2^b_dtc
  const tVcoS = configTVcoS(cfg); // 1 / (N·f_ref)
  const alpha = configAlpha(cfg); // N − trunc(N)
  ...
  const dist = alphaG - qNearest(alphaG); // half-up(MODEL_SPEC §2)
  const pStage = [1, cfg.n_pmux, g].map((gs) => stagePeriod(alpha, gs));
  const pDtc = pStage[2];
  const spurHz = pDtc === null || pDtc === 1 ? null : fRefHz / pDtc;
  const peakLsb = pDtc === null ? 0.5 : Math.floor(pDtc / 2) / pDtc;

// runConfirm(節錄):選中列即時以 golden model 確認
  const res = simulate(fromPartial({ f_ref_hz: fRefHz, n_div: n, n_cycles: NC_PLAN, quantizer: 'nearest' }));
  const e = res.data.e_FB_abs;
  const { freqsHz, psd } = periodogramPsd(e, fRefHz); // sample rate = f_ref(§17)
  ...
      const m = qNearest(s.freqHz / spacing);
      if (Math.abs(s.freqHz - m * spacing) <= 1.5 * binHz) onGrid += 1;`;

const BUDGET_SRC = `/** dual-Dirac:BER = ½·erfc(Q/√2) ⇒ Q = √2·erfc⁻¹(2·BER);Q(1e-12) = 7.034。 */
function qOfBer(ber: number): number {
  return Math.SQRT2 * erfcInv(2 * ber);
}

// computeBudget(節錄)
  const tVcoFs = b.tVcoS / FS; // configTVcoS → fs
  const lsbFs = tVcoFs / b.g; // 1 LSB = T_vco / G
  ...
  const rj = Math.sqrt(rjIn.reduce((s, t) => s + t[3] * t[3], 0));
  const dWc = djIn.reduce((s, t) => s + t[3], 0);
  const dRss = Math.sqrt(djIn.reduce((s, t) => s + t[3] * t[3], 0));
  const q = qOfBer(b.ber);
  const tjWc = 2 * dWc + 2 * q * rj;
  const tjRss = 2 * dRss + 2 * q * rj;
  const rmsEst = Math.sqrt(rj * rj + (dRss * dRss) / 3);

/** cross-check 的等效 config:reset injection + 與 budget 同值的 nonidealities。 */
function xcConfig(n: number, fRefHz: number, b: BudgetIn, mapping: InjMapping, noise: boolean): SimConfig {
  const base = fromPartial({ n_div: n, f_ref_hz: fRefHz });
  const tVcoS = configTVcoS(base);
  const tap = new Array<number>(base.n_tap).fill(0);
  tap[XC_TAP] = b.tapDeg / 360;
  return replaceConfig(base, {
    n_cycles: NC_XCHECK,
    inj_model: 'reset',
    delta_f_hz: 0,
    inj_mapping: mapping,
    tap_mismatch_cycles: tap,
    dtc_inj_gain: 1 + b.gainPct / 100,
    inl_sin_amp_cycles: b.inlLsb / configG(base),
    route_inj_cycles: (b.routeFs * FS) / tVcoS,
    sigma_ref_s: noise ? b.sRefFs * FS : 0,
    sigma_pulse_s: noise ? b.sPulseFs * FS : 0,
    sigma_vco_w_rad: noise ? (TWO_PI * b.sVcoFs * FS) / tVcoS : 0,
  });
}

// runCrossCheck(節錄):full 與 deterministic-only 兩次 simulate()
  const full = simulate(xcConfig(n, fRefHz, b, mapping, true));
  const det = simulate(xcConfig(n, fRefHz, b, mapping, false));
  const thF = scaled(full.data.theta_minus, radToFs); // θ⁻:kick 前 VCO 絕對相位誤差
  const ezF = scaled(full.data.e_ZC_total, fsPerCyc); // e_ZC_total:pulse 處 ZC miss`;

/* ------------------------------------------------------------------ */
/* 小元件與樣式                                                        */
/* ------------------------------------------------------------------ */

const TEXT_INPUT_STYLE: CSSProperties = {
  width: '100%',
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border-strong)',
  borderRadius: 4,
  padding: '3px 7px',
  fontFamily: 'var(--font-mono)',
  fontSize: 12.5,
};

const CONTROL_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
  columnGap: 18,
};

const TH_BTN: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
};

const BAND_LABEL: Record<Band, string> = {
  exact: 'exact(on-grid)',
  out: '帶外 out-of-band',
  in: '帶內 in-band',
  illegal: '不合法',
};

const BAND_COLOR: Record<Band, string> = {
  exact: 'var(--tag-exact)',
  out: 'var(--accent)',
  in: 'var(--status-running)',
  illegal: 'var(--fg-faint)',
};

function fsStr(v: number, sig = 5): string {
  return `${trimNumber(v, sig)} fs`;
}

function mhzStr(hz: number, sig = 6): string {
  return `${trimNumber(hz / 1e6, sig)} MHz`;
}

function ratioStr(sim: number, est: number): string {
  return est > 0 ? trimNumber(sim / est, 4) : '—';
}

function Verdict({ ok, na }: { ok: boolean; na?: boolean }) {
  const ct = useChartTheme();
  if (na) return <span style={{ color: 'var(--fg-faint)' }}>N/A</span>;
  return <b style={{ color: ok ? ct.good : ct.bad }}>{ok ? '一致' : '不一致'}</b>;
}

/* ================================================================== */

export default function Chapter23() {
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();
  const listId = useId();

  const [nDiv, setNDiv] = useChapterNDiv();

  /* ---------------- 工具一:Frequency Planner --------------------- */
  const [fVcoGHz, setFVcoGHz] = useState(12.890625);
  const [listText, setListText] = useState(DEFAULT_LIST);
  const [sweepOn, setSweepOn] = useState(false);
  const [swStart, setSwStart] = useState(3.9);
  const [swStop, setSwStop] = useState(4.3);
  const [swStep, setSwStep] = useState(0.005);
  const [bwMHz, setBwMHz] = useState(50);
  const [sortKey, setSortKey] = useState<SortKey>('rank');
  const [sortAsc, setSortAsc] = useState(true);
  const [selFRef, setSelFRef] = useState(4.25);

  const candidates = useMemo(
    () => (sweepOn ? sweepList(swStart, swStop, swStep) : parseList(listText)),
    [sweepOn, swStart, swStop, swStep, listText],
  );
  const rows = useMemo(
    () => candidates.map((f) => planRow(fVcoGHz, f, bwMHz)),
    [candidates, fVcoGHz, bwMHz],
  );
  const ranked = useMemo(() => [...rows].sort(rankCompare), [rows]);
  const rankOf = useMemo(() => {
    const m = new Map<PlanRow, number>();
    ranked.filter((r) => r.legal).forEach((r, i) => m.set(r, i + 1));
    return m;
  }, [ranked]);
  const sorted = useMemo(() => {
    if (sortKey === 'rank') return sortAsc ? ranked : [...ranked].reverse();
    const dir = sortAsc ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      return va === vb ? 0 : (va < vb ? -1 : 1) * dir;
    });
  }, [rows, ranked, sortKey, sortAsc]);
  const bandCount = useMemo(() => {
    const c: Record<Band, number> = { exact: 0, out: 0, in: 0, illegal: 0 };
    for (const r of rows) c[r.band] += 1;
    return c;
  }, [rows]);

  const sel: PlanRow | null =
    rows.find((r) => r.legal && r.fRefGHz === selFRef) ??
    ranked.find((r) => r.legal && r.band !== 'exact') ??
    ranked.find((r) => r.legal) ??
    null;
  const selFRefHz = sel === null ? 0 : sel.fRefHz;
  const selN = sel === null ? 0 : sel.n;
  const selP = sel === null ? null : sel.pStage[2];

  const confirm = useMemo(
    () => (selFRefHz > 0 ? runConfirm(selFRefHz, selN, selP) : null),
    [selFRefHz, selN, selP],
  );

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortAsc(!sortAsc);
    else {
      setSortKey(k);
      setSortAsc(true);
    }
  };

  /* ---------------- 工具二:Jitter Budget ------------------------- */
  const [opPoint, setOpPoint] = useState<'global' | 'planner'>('global');
  const [sRef, setSRef] = useState(40);
  const [sVco, setSVco] = useState(60);
  const [sPulse, setSPulse] = useState(20);
  const [quantAuto, setQuantAuto] = useState(true);
  const [quantManual, setQuantManual] = useState(150);
  const [tapDeg, setTapDeg] = useState(0.5);
  const [gainPct, setGainPct] = useState(0.5);
  const [inlLsb, setInlLsb] = useState(0.1);
  const [routeFs, setRouteFs] = useState(30);
  const [specRms, setSpecRms] = useState(150);
  const [specTj, setSpecTj] = useState(1600);
  const [berExp, setBerExp] = useState(-12);

  const usePlanner = opPoint === 'planner' && sel !== null;
  const opN = usePlanner && sel !== null ? sel.n : nDiv;
  const opFRefHz = usePlanner && sel !== null ? sel.fRefHz : F_REF_DEFAULT;

  // 量化峰值自動帶入:目前操作點、nominal config 的 max|e_ZC_hw|(model 實跑)
  const opRun = useMemo(() => {
    const cfg = fromPartial({ n_div: opN, f_ref_hz: opFRefHz, n_cycles: NC_PLAN });
    const res = simulate(cfg);
    return {
      tVcoS: configTVcoS(cfg),
      g: configG(cfg),
      dtcRangeLsb: 1 << cfg.b_dtc,
      quantFs: (maxAbs(res.data.e_ZC_hw) * res.t_vco_s) / FS,
    };
  }, [opN, opFRefHz]);

  const budgetIn: BudgetIn = useMemo(
    () => ({
      tVcoS: opRun.tVcoS,
      g: opRun.g,
      dtcRangeLsb: opRun.dtcRangeLsb,
      sRefFs: sRef,
      sVcoFs: sVco,
      sPulseFs: sPulse,
      quantFs: quantAuto ? opRun.quantFs : quantManual,
      tapDeg,
      gainPct,
      inlLsb,
      routeFs,
      ber: 10 ** berExp,
    }),
    [opRun, sRef, sVco, sPulse, quantAuto, quantManual, tapDeg, gainPct, inlLsb, routeFs, berExp],
  );
  const budget = useMemo(() => computeBudget(budgetIn), [budgetIn]);

  /* ---------------- cross-check(按鈕觸發)------------------------ */
  const [xcMapping, setXcMapping] = useState<InjMapping>('naive');
  const [xc, setXc] = useState<XcResult | null>(null);
  const [xcBusy, setXcBusy] = useState(false);
  const xcSig = [
    opN, opFRefHz, sRef, sVco, sPulse, budgetIn.quantFs, tapDeg, gainPct, inlLsb, routeFs, berExp, xcMapping,
  ].join('|');
  const runXc = () => {
    setXcBusy(true);
    setStatus('running', `Ch23:cross-check simulate 2 × ${NC_XCHECK} cycles(reset injection)…`);
    const inp = budgetIn;
    const n = opN;
    const fr = opFRefHz;
    const mp = xcMapping;
    const sig = xcSig;
    window.setTimeout(() => {
      const r = runCrossCheck(sig, n, fr, inp, mp);
      setXc(r);
      setXcBusy(false);
      setStatus('done', `Ch23:cross-check 完成(N=${trimNumber(n, 8)}, ${mp}, ${NC_XCHECK} cycles)`);
    }, 0);
  };
  const xcStale = xc !== null && xc.sig !== xcSig;

  /* ---------------- simulation status ------------------------------- */
  useEffect(() => {
    if (xcBusy) return;
    setStatus(
      'done',
      `Ch23:planner ${rows.length} 列` +
        (selFRefHz > 0 ? `;確認 simulate ${NC_PLAN} cycles @ f_ref=${trimNumber(selFRefHz / 1e9, 7)} GHz` : '') +
        `;budget N=${trimNumber(opN, 8)}`,
    );
  }, [rows.length, selFRefHz, opN, xcBusy, setStatus]);

  /* ------------------------------------------------------------ 圖表 */

  const eOption = useMemo(() => {
    if (confirm === null || sel === null) return null;
    const opt = makeLineOption({
      xLabel: 'k(reference cycle,sample rate = f_ref)',
      xMin: 0,
      xMax: NC_SHOW - 1,
      yLabel: 'e_FB_abs (fs)',
      series: [{ name: 'e_FB_abs(simulate)', data: confirm.eFs, step: 'middle', color: ct.accent }],
      legend: false,
    });
    if (sel.peakFs > 0) {
      (opt as unknown as { series: Record<string, unknown>[] }).series[0].markLine = makeMarkLine([
        { y: sel.peakFs, label: `+預測峰值 ${trimNumber(sel.peakFs, 5)} fs`, color: ct.warn },
        { y: -sel.peakFs, label: `−預測峰值`, color: ct.warn },
      ]);
    }
    return opt;
  }, [confirm, sel, ct]);

  const psdOption = useMemo(() => {
    if (confirm === null || sel === null) return null;
    const opt = makeLineOption({
      xLabel: `frequency (MHz) — sample rate = f_ref = ${trimNumber(sel.fRefGHz, 7)} GHz`,
      yLabel: '10·log₁₀ S_e (dB re cycle²/Hz)',
      series: [{ name: 'PSD e_FB_abs', data: confirm.psd, color: ct.accent }],
      legend: false,
    });
    const p = sel.pStage[2];
    if (p !== null && p > 1) {
      const marks: { x: number; label: string; color: string }[] = [];
      const mMax = Math.min(Math.floor(p / 2), 8);
      for (let m = 1; m <= mMax; m++) {
        marks.push({ x: (m * sel.fRefHz) / p / 1e6, label: m === 1 ? 'f_ref/P' : `${m}/P`, color: ct.warn });
      }
      (opt as unknown as { series: Record<string, unknown>[] }).series[0].markLine = makeMarkLine(marks);
    }
    return opt;
  }, [confirm, sel, ct]);

  const barOption = useMemo(() => {
    const opt = makeLineOption({
      xType: 'category',
      categories: ['worst-case', 'RSS'],
      yLabel: `TJ(BER = 1e${berExp}) 份額 (fs)`,
      zoom: false,
      series: budget.terms.map((t, i) => ({
        name: `${t.kind} · ${t.label}`,
        data: [t.shareWc, t.shareRss],
        type: 'bar' as const,
        color: ct.series[i % ct.series.length],
      })),
      extra: {
        legend: {
          type: 'scroll',
          bottom: 4,
          left: 8,
          right: 8,
          textStyle: { color: ct.text, fontSize: 11 },
        },
        grid: { left: 60, right: 24, top: 30, bottom: 64 },
      },
    });
    const ser = (opt as unknown as { series: Record<string, unknown>[] }).series;
    for (const s of ser) {
      s.stack = 'tj';
      s.barWidth = '42%';
    }
    if (specTj > 0) {
      ser[ser.length - 1].markLine = makeMarkLine([
        { y: specTj, label: `TJ spec ${trimNumber(specTj, 5)} fs`, color: ct.bad },
      ]);
    }
    return opt;
  }, [budget, berExp, specTj, ct]);

  const xcOption = useMemo(() => {
    if (xc === null) return null;
    const b = xc.budget;
    const pkWc = b.dWc + xc.qN * b.rj;
    const pkRss = b.dRss + xc.qN * b.rj;
    // 對稱 y 範圍(顯示用):涵蓋 wc 峰值估計與兩條量測曲線,取 100 fs 整數倍
    const lim = Math.ceil((1.1 * Math.max(pkWc, xc.th.peak, xc.ez.peak)) / 100) * 100;
    const opt = makeLineOption({
      xLabel: 'k(reference cycle)',
      xMin: 0,
      xMax: NC_SHOW - 1,
      yLabel: 'timing error (fs)',
      yMin: -lim,
      yMax: lim,
      series: [
        { name: 'θ⁻(kick 前 VCO 絕對相位誤差)', data: xc.thSeries, color: ct.accent },
        { name: 'e_ZC_total(pulse 處 ZC miss)', data: xc.ezSeries, color: ct.series[1] },
      ],
    });
    (opt as unknown as { series: Record<string, unknown>[] }).series[0].markLine = makeMarkLine([
      { y: pkWc, label: `±(D_wc + Q·RJ) ${trimNumber(pkWc, 4)} fs`, color: ct.bad },
      { y: -pkWc, color: ct.bad },
      { y: pkRss, label: `±(D_rss + Q·RJ) ${trimNumber(pkRss, 4)} fs`, color: ct.warn },
      { y: -pkRss, color: ct.warn },
    ]);
    return opt;
  }, [xc, ct]);

  /* ---------------------------------------------------- 表格小工具 */

  const sortTh = (k: SortKey, label: ReactNode) => (
    <th aria-sort={sortKey === k ? (sortAsc ? 'ascending' : 'descending') : 'none'}>
      <button type="button" style={TH_BTN} onClick={() => toggleSort(k)} title="點擊排序">
        {label}
        {sortKey === k ? (sortAsc ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );

  const pStr = (p: number | null) => (p === null ? '> 4096' : String(p));

  const marginCell = (spec: number, est: number) => {
    if (!(spec > 0)) return <span style={{ color: 'var(--fg-faint)' }}>未設定</span>;
    const m = spec - est;
    return (
      <b style={{ color: m >= 0 ? ct.good : ct.bad }}>
        {m >= 0 ? 'PASS' : 'FAIL'}({m >= 0 ? '+' : '−'}
        {trimNumber(Math.abs(m), 5)} fs)
      </b>
    );
  };

  const dominantTerm = budget.terms.find((t) => t.key === budget.dominant);

  /* ================================================================ */

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      {/* ---------------------------------------------------- 1 問題 */}
      <SectionQuestion>
        <ul>
          <li>
            給定目標 <M>{'f_{vco}'}</M>,哪一個 <M>{'f_{ref}'}</M> 讓 <M>{'\\alpha G'}</M> 恰為整數
            (exact,量化 spur 完全消失)?做不到時,誤差週期 <M>{'P'}</M>、spur 基頻{' '}
            <M>{'f_{ref}/P'}</M> 是多少、落在 loop bandwidth 內還是外?
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            為什麼只靠連分數(continued fraction)就能從 <M>{'f_{vco}/f_{ref}'}</M> 算出{' '}
            <M>{'P = q/\\gcd(q, G)'}</M>,不必先跑模擬?模擬又如何反過來確認預測?
          </li>
          <li>
            一份 jitter budget 要怎麼把 random 項(reference、VCO residual、pulse)與
            deterministic 項(quantization、tap、DTC gain、INL、route)合成一個 total jitter?
            worst-case 線性和與 RSS 差在哪裡?
          </li>
          <li>
            dual-Dirac 的 <M>{'TJ(\\mathrm{BER}) = DJ_{pp} + 2Q\\,RJ_{rms}'}</M> 中{' '}
            <M>{'Q(10^{-12}) = 7.034'}</M> 從哪裡來?<EpistemicTag kind="APPROX" />
          </li>
          <li>
            budget 的估計值與 golden model 實際跑出的 <code>e_ZC_total</code> 差多少?差異來自哪裡?
            <EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
      </SectionQuestion>

      {/* ---------------------------------------------------- 2 直覺 */}
      <SectionIntuition>
        <p>
          前面 22 章都在回答「某個 N 下誤差長什麼樣」。設計時問題反過來:<b>N 還沒決定</b>。
          <M>{'f_{vco}'}</M> 通常由系統規格鎖死(例如 Ethernet 25.78125 Gbps 的半速率{' '}
          <M>{'f_{vco} = 12.890625'}</M> GHz),而 <M>{'f_{ref}'}</M> 常常有幾個候選(晶振、
          上游 PLL 的整數分頻、板上既有時脈)。同一個 <M>{'f_{vco}'}</M>,換一個{' '}
          <M>{'f_{ref}'}</M> 就換一個 <M>{'\\alpha'}</M>,而 <M>{'\\alpha'}</M> 的有理結構
          決定一切:on-grid 時 <code>e_FB ≡ 0</code>;<M>{'\\alpha = p/q'}</M> 時誤差以{' '}
          <M>{'P = q/\\gcd(q,256)'}</M> 為週期,spur 落在 <M>{'m f_{ref}/P'}</M>(
          <a href={chapterHref('pd-input-error-anatomy')}>Ch21</a>)。
        </p>
        <p>
          <b>為什麼規劃頻率比事後修 spur 便宜:</b>挑 <M>{'f_{ref}'}</M> 只是一張表格;
          事後修 spur 的每一種手段都有代價 —— DSM 讓 per-edge 峰值變大且有 wrap 摺疊上限
          (Ch21 L3)、dither 墊高 floor、QNC 需要 analog 精度與校正、縮 loop bandwidth 犧牲
          settling 與 VCO noise 抑制。<M>{'f_{ref} = 4.0'}</M> GHz 讓 12.890625 GHz 的{' '}
          <M>{'\\alpha G = 57'}</M> 恰為整數(量化 spur 為零,電路什麼都不用做);換成 4.096 GHz
          就變成 <M>{'P = 128'}</M>、32 MHz 的 close-in spur。這個差別在 schematic 之前就能算出來。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>
          <b>Jitter budget 的直覺:</b>random 項彼此獨立 → 變異數相加(RSS);deterministic 項是
          有界的、可能同號相加 → 保守時取線性和。dual-Dirac 把 DJ 想成兩根 delta、RJ 想成
          Gaussian,於是在 BER 處的總寬度是 <M>{'DJ_{pp} + 2Q\\,RJ'}</M>。budget 的價值不在
          精確,而在<b>找出 dominant contributor</b>:錢(面積、功耗、校正)該花在哪一項。
          最後用 golden model 跑一次,看估計離實際多遠。
        </p>
      </SectionIntuition>

      {/* ---------------------------------------------------- 3 數學 */}
      <SectionMath>
        <p>
          <b>(A) Frequency planner。</b>給定 <M>{'f_{vco}'}</M> 與候選 <M>{'f_{ref}'}</M>:
        </p>
        <MathBlock>
          {'N = \\frac{f_{vco}}{f_{ref}},\\qquad \\alpha = N - 3,\\qquad \\text{legal} \\iff 3 \\le N \\le 3.25'}
        </MathBlock>
        <p>
          合法範圍即 MODEL_SPEC §1 的 <M>{'\\alpha \\in [0, 0.25]'}</M>(/3-/4 + 4-phase PMUX
          的設計範圍)<EpistemicTag kind="ASSUMPTION" />。stage grid <M>{'G_s \\in \\{1, 4, 256\\}'}</M>
          (divider / +PMUX / +DTC,同 Ch21)上,第 k 拍的理想 code 小數部分只由{' '}
          <M>{'k\\,\\alpha G_s'}</M> 決定(s₀ = 0):
        </p>
        <MathBlock>
          {
            '\\alpha = \\frac{p}{q}\\ (\\gcd(p,q)=1) \\;\\Rightarrow\\; \\alpha G_s = \\frac{p\\,G_s/\\gcd(q,G_s)}{q/\\gcd(q,G_s)},\\qquad P_s = \\frac{q}{\\gcd(q, G_s)}'
          }
        </MathBlock>
        <p>
          分子分母互質,所以 <M>{'\\operatorname{frac}(k\\alpha G_s)'}</M> 走遍{' '}
          <M>{'\\{0, 1/P, \\dots, (P-1)/P\\}'}</M>:誤差序列週期為 <M>{'P_s'}</M>,nearest
          (half-up)量化峰值與 spur 落點為 <EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {
            '|e|_{peak} = \\frac{\\lfloor P/2 \\rfloor}{P}\\,\\Delta_s,\\quad \\Delta_{256} = \\frac{T_{vco}}{256};\\qquad f_{spur,m} = \\frac{m}{P_{256}}\\,f_{ref}\\ \\ (\\S 17)'
          }
        </MathBlock>
        <p>
          <b>連分數求 p/q。</b>展開 <M>{'\\alpha = [a_0; a_1, a_2, \\dots]'}</M>,convergent 遞迴
        </p>
        <MathBlock>
          {
            'p_i = a_i\\,p_{i-1} + p_{i-2},\\qquad q_i = a_i\\,q_{i-1} + q_{i-2},\\qquad (p_{-1},q_{-1}) = (1,0),\\ (p_{-2},q_{-2}) = (0,1)'
          }
        </MathBlock>
        <p>
          取 <M>{'q_i \\le 4096'}</M> 的最後一個 convergent;<M>{'|\\alpha - p_i/q_i| < 10^{-10}'}</M>{' '}
          即判 exact(<M>{'f_{vco}/f_{ref}'}</M> 的 float64 捨入約 1e-16,而分母 ≤ 4096 的相異分數
          彼此至少相距 <M>{'1/4096^2 \\approx 6\\times10^{-8}'}</M>,故不會誤判)。若 <M>{'\\alpha'}</M>{' '}
          的分母超過 4096(例:<M>{'f_{ref} = 4.096'}</M> GHz 的 <M>{'\\alpha = 4821/32768'}</M>),改對{' '}
          <M>{'\\operatorname{frac}(\\alpha G_s)'}</M> 做連分數 —— 它的最簡分母正是{' '}
          <M>{'q/\\gcd(q,G_s)'}</M>,同一恆等式 <EpistemicTag kind="EXACT" />;兩者都找不到 → 顯示「&gt; 4096」
          (長週期,spur 間距 &lt; <M>{'f_{ref}/4096'}</M>)<EpistemicTag kind="APPROX" />。
          到 nearest 整數的距離 <M>{'d = \\alpha G - \\operatorname{qNearest}(\\alpha G)'}</M>(LSB),
          <M>{'d = 0 \\iff P_{256} = 1'}</M>。
        </p>
        <p>
          <b>帶內/帶外與排名。</b><M>{'f_{spur,1} = f_{ref}/P_{256} \\le f_{BW}'}</M> → 帶內:PD 輸入端
          的 spur 經 PLL 的 low-pass 傳到 VCO 輸出;帶外則被 loop filter 衰減
          <EpistemicTag kind="INFERENCE" />。排名規則:exact → 帶外(P 小者先)→ 帶內(P 小者先)→
          不合法。預設清單(<M>{'f_{vco} = 12.890625'}</M> GHz、<M>{'T_{vco} = 77.5758'}</M> ps、
          1 LSB = 303.03 fs、<M>{'f_{BW} = 50'}</M> MHz),python3 逐列驗證:
          <EpistemicTag kind="EXACT" />
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>f_ref (GHz)</th>
                <th>N</th>
                <th>合法</th>
                <th>α·G</th>
                <th>d (LSB)</th>
                <th>P div / PMUX / DTC</th>
                <th>spur f_ref/P</th>
                <th>peak</th>
                <th>分類</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>3.84</td><td>3.35693359375</td><td>N &gt; 3.25</td><td>91.375</td><td>+0.375</td><td>2048 / 512 / 8</td><td>(480 MHz)</td><td>(151.5 fs)</td><td>不合法</td></tr>
              <tr><td>3.90625</td><td>3.3</td><td>N &gt; 3.25</td><td>76.8</td><td>−0.2</td><td>10 / 5 / 5</td><td>(781.25 MHz)</td><td>(121.2 fs)</td><td>不合法</td></tr>
              <tr><td>3.96</td><td>3.2552083…</td><td>N &gt; 3.25</td><td>65.333…</td><td>+0.3333</td><td>192 / 48 / 3</td><td>(1320 MHz)</td><td>(101.0 fs)</td><td>不合法</td></tr>
              <tr><td>4.0</td><td>3.22265625</td><td>是</td><td>57</td><td>0</td><td>256 / 64 / 1</td><td>—</td><td>0</td><td>exact(第 1 名)</td></tr>
              <tr><td>4.096</td><td>3.147125244140625</td><td>是</td><td>37.6640625</td><td>−0.3359</td><td>&gt; 4096 / &gt; 4096 / 128</td><td>32 MHz</td><td>151.5 fs</td><td>帶內(第 4 名)</td></tr>
              <tr><td>4.125</td><td>3.125</td><td>是</td><td>32</td><td>0</td><td>8 / 2 / 1</td><td>—</td><td>0</td><td>exact(第 2 名)</td></tr>
              <tr><td>4.25</td><td>3.0330882…</td><td>是</td><td>8.470588…</td><td>+0.4706</td><td>272 / 68 / 17</td><td>250 MHz</td><td>142.6 fs</td><td>帶外(第 3 名)</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          4.25 GHz 的 <M>{'\\alpha = 9/272'}</M>,<M>{'\\gcd(272,256) = 16 \\Rightarrow P_{256} = 17'}</M>,
          峰值 <M>{'8/17'}</M> LSB = 142.60 fs;4.096 GHz 的 <M>{'\\operatorname{frac}(\\alpha\\cdot256) = 85/128'}</M>{' '}
          → <M>{'P_{256} = 128'}</M>,而 <M>{'P_4 = 8192'}</M>、<M>{'P_1 = 32768'}</M> 超出 4096 上限。
        </p>

        <p style={{ marginTop: 18 }}>
          <b>(B) Jitter budget。</b>單位換算一律經 <code>configTVcoS</code>:
        </p>
        <MathBlock>
          {
            'T_{vco} = \\frac{1}{N f_{ref}},\\qquad 1\\,\\mathrm{LSB} = \\frac{T_{vco}}{G},\\qquad \\delta^{\\circ} \\mapsto \\frac{\\delta}{360}\\,T_{vco}'
          }
        </MathBlock>
        <p>
          random 項(各自獨立的 Gaussian)<EpistemicTag kind="ASSUMPTION" />:
        </p>
        <MathBlock>{'RJ_{rms} = \\sqrt{\\sigma_{ref}^2 + \\sigma_{vco}^2 + \\sigma_{pulse}^2}'}</MathBlock>
        <p>deterministic 項的單邊峰值 <M>{'d_i'}</M>(相對理想 zero crossing):</p>
        <MathBlock>
          {
            'd_Q = \\max_k |e_{ZC,hw}[k]|\\,T_{vco},\\quad d_{tap} = \\tfrac{\\delta}{360}T_{vco},\\quad d_{gain} = \\varepsilon\\cdot 64\\,\\mathrm{LSB},\\quad d_{INL} = A\\,\\mathrm{LSB},\\quad d_{route} = |t_{route}|'
          }
        </MathBlock>
        <p>
          <M>{'d_Q'}</M> 由 model 在目前 N 實跑(nominal config)自動帶入 <EpistemicTag kind="EXPERIMENT" />;
          <M>{'d_{gain}'}</M> 取 6-bit DTC 的 64-LSB 滿量程(Ch0 的 1% × 20 ps = 200 fs 同一口徑)。兩種合成:
        </p>
        <MathBlock>
          {
            'D_{wc} = \\sum_i d_i,\\qquad D_{rss} = \\sqrt{\\textstyle\\sum_i d_i^2},\\qquad DJ_{pp} = 2D'
          }
        </MathBlock>
        <p>
          <M>{'DJ_{pp} = 2D'}</M> 假設合成誤差是相對理想 crossing 的對稱 <M>{'\\pm D'}</M> 包絡(靜態的
          route skew 也以其大小計入,因為目標是對準 <M>{'z_0'}</M>,不只是繞平均值的抖動)
          <EpistemicTag kind="ASSUMPTION" />。dual-Dirac total jitter:
        </p>
        <MathBlock>
          {
            'TJ(\\mathrm{BER}) = DJ_{pp} + 2\\,Q(\\mathrm{BER})\\,RJ_{rms},\\qquad \\mathrm{BER} = \\tfrac12\\operatorname{erfc}\\!\\left(\\tfrac{Q}{\\sqrt2}\\right) \\;\\Rightarrow\\; Q = \\sqrt{2}\\,\\operatorname{erfc}^{-1}(2\\,\\mathrm{BER})'
          }
        </MathBlock>
        <p>
          <M>{'Q(10^{-12}) = 7.0345'}</M>(<M>{'\\operatorname{erfc}^{-1}'}</M> 以 Acklam 的{' '}
          <M>{'\\Phi^{-1}'}</M> rational approximation 實作,<M>{'\\operatorname{erfc}^{-1}(y) = -\\Phi^{-1}(y/2)/\\sqrt2'}</M>,
          python 對 scipy 相對誤差 ≤ 1.15e-9)<EpistemicTag kind="APPROX" />。rms 估計把每個 DJ 項當成
          均勻分佈(rms = 峰值/√3)<EpistemicTag kind="APPROX" />,dominant contributor 以 TJ_wc 的加法份額判定
          (RJ 份額按變異數比例分攤)<EpistemicTag kind="APPROX" />:
        </p>
        <MathBlock>
          {
            '\\sigma_{tot} \\approx \\sqrt{RJ_{rms}^2 + D_{rss}^2/3},\\qquad s_i^{DJ} = 2d_i,\\quad s_j^{RJ} = 2Q\\,RJ_{rms}\\,\\frac{\\sigma_j^2}{RJ_{rms}^2},\\quad \\textstyle\\sum s = TJ_{wc}'
          }
        </MathBlock>
        <p>
          預設情境(N = 3.13、<M>{'f_{ref}'}</M> = 4 GHz、<M>{'T_{vco}'}</M> = 79.872 ps、1 LSB = 312.00 fs;
          σ = 40/60/20 fs;<M>{'d_Q'}</M> = 149.76 fs(0.48 LSB)、tap 0.5° = 110.93 fs、gain 0.5% = 99.84 fs、
          INL 0.1 LSB = 31.20 fs、route 30 fs):<M>{'RJ_{rms}'}</M> = 74.83 fs、<M>{'D_{wc}'}</M> = 421.73 fs、
          <M>{'D_{rss}'}</M> = 215.81 fs、<M>{'TJ_{wc}(10^{-12})'}</M> = 1896.3 fs、<M>{'TJ_{rss}'}</M> = 1484.5 fs、
          <M>{'\\sigma_{tot}'}</M> = 145.35 fs;dominant = VCO residual(676.8 fs,佔 TJ_wc 35.7%)。
          <EpistemicTag kind="EXACT" />(算術,python3 驗證)
        </p>
        <p>
          <b>(C) Cross-check 對應的 model 量。</b>以 §14 的 ideal reset injection(上限模型)跑{' '}
          <code>simulate()</code>:令 <M>{'\\varepsilon[k] = \\varepsilon_{hw}[k] + \\varepsilon_{rand}[k]'}</M>{' '}
          為第 k 個 pulse 的 timing error,<M>{'w[k]'}</M> 為該拍 VCO 累積雜訊,則(時間單位)
          <EpistemicTag kind="EXACT" />(在 model 內)
        </p>
        <MathBlock>
          {
            '\\theta^-[k] = w[k] - \\varepsilon[k-1],\\qquad e_{ZC,total}[k] = \\theta^-[k] + \\varepsilon[k] = w[k] + \\varepsilon[k] - \\varepsilon[k-1]'
          }
        </MathBlock>
        <p>
          <M>{'\\theta^-'}</M>(kick 前 VCO 的絕對相位誤差)正是 budget 的直接對應:所有來源各出現一次。
          <code>e_ZC_total</code>(pulse 處的 ZC miss)則是 pulse 誤差的<b>一階差分</b> —— 即{' '}
          <a href={chapterHref('dsm-residual-injection-lock')}>Ch22</a> 的{' '}
          <M>{'H(z) = (z-1)/(z-(1-K))'}</M> 在 <M>{'K = 1'}</M> 時的 <M>{'1 - z^{-1}'}</M>:靜態 offset
          (route skew)被消掉,白色的 ref/pulse 項變成 √2 倍,其隨機部分預測為{' '}
          <M>{'\\sqrt{\\sigma_{vco}^2 + 2\\sigma_{ref}^2 + 2\\sigma_{pulse}^2}'}</M>。
        </p>
      </SectionMath>

      {/* ---------------------------------------------------- 4 數值例子 */}
      <SectionExample>
        <ExampleProblem
          index={1}
          tag="EXACT"
          title="Planner:給定 f_vco 與 f_ref 求 N、P 與 spur"
          prompt={
            <>
              取目標 <M>{'f_{vco}'}</M>、候選 <M>{'f_{ref}'}</M> 與 loop bandwidth{' '}
              <M>{'f_{BW}'}</M>。求 <M>{'N'}</M>、是否合法、<M>{'\\alpha G'}</M> 到最近整數的距離、
              連分數 <M>{'\\alpha \\approx p/q'}</M>(<M>{'q \\le 4096'}</M>)、三級 grid 的週期{' '}
              <M>{'P_s = q/\\gcd(q, G_s)'}</M>、spur 基頻 <M>{'f_{ref}/P_{256}'}</M>、nearest 峰值誤差(fs)
              以及帶內/帶外。
            </>
          }
          inputs={[
            { key: 'fvco', label: <M>{'f_{vco}'}</M>, def: 12.890625, min: 1, max: 100, step: 0.000001, unit: 'GHz' },
            { key: 'fref', label: <M>{'f_{ref}'}</M>, def: 4.25, min: 0.1, max: 50, step: 0.001, unit: 'GHz' },
            { key: 'bw', label: <M>{'f_{BW}'}</M>, def: 50, min: 0.001, max: 10000, step: 1, unit: 'MHz' },
          ]}
          compute={(v) => {
            const fRefHz = v.fref * 1e9;
            const n = (v.fvco * 1e9) / fRefHz;
            const cfg = fromPartial({ n_div: n, f_ref_hz: fRefHz });
            const g = configG(cfg);
            const tVcoFs = configTVcoS(cfg) / FS;
            const alpha = configAlpha(cfg);
            const alphaG = (n - 3) * g;
            const near = qNearest(alphaG);
            const rat = cfApprox(alpha);
            const ps = [1, cfg.n_pmux, g].map((gs) => stagePeriod(alpha, gs));
            const p = ps[2];
            const legal = n >= N_LO && n <= N_HI;
            const peakLsb = p === null ? 0.5 : Math.floor(p / 2) / p;
            const peakFs = (peakLsb * tVcoFs) / g;
            const spurHz = p === null || p === 1 ? null : fRefHz / p;
            const band =
              p === 1 ? 'exact(無量化 spur)' : spurHz !== null && spurHz > v.bw * 1e6 ? '帶外 out-of-band' : '帶內 in-band';
            return {
              steps: [
                { label: <><M>{'N = f_{vco}/f_{ref}'}</M></>, value: fmt(n, 12) },
                { label: <>合法?<M>{'3 \\le N \\le 3.25'}</M></>, value: legal ? '是' : '否' },
                { label: <><M>{'\\alpha G = (N-3)\\cdot 256'}</M></>, value: fmt(alphaG, 10) },
                {
                  label: <><M>{'d = \\alpha G - \\operatorname{qNearest}(\\alpha G)'}</M></>,
                  value: `${fmt(alphaG - near, 6)} LSB(nearest = ${near})`,
                },
                {
                  label: <>連分數 <M>{'\\alpha \\approx p/q'}</M>(<M>{'q \\le 4096'}</M>)</>,
                  value:
                    rat === null
                      ? '—'
                      : `${rat.p}/${rat.q}${rat.exact ? '(exact)' : `(誤差 ${fmt(rat.err, 3)},不 exact)`}`,
                },
                {
                  label: <><M>{'P_1 / P_4 / P_{256}'}</M>(divider / PMUX / DTC)</>,
                  value: ps.map((x) => (x === null ? '> 4096' : String(x))).join(' / '),
                },
                {
                  label: <>spur 基頻 <M>{'f_{ref}/P_{256}'}</M></>,
                  value: spurHz === null ? (p === 1 ? '無(exact)' : '< f_ref/4096') : fmt(spurHz / 1e6, 7, 'MHz'),
                },
                {
                  label: <><M>{'T_{vco}'}</M>、1 LSB</>,
                  value: `${fmt(tVcoFs / 1000, 6, 'ps')}、${fmt(tVcoFs / g, 6, 'fs')}`,
                },
                {
                  label: <>nearest 峰值 <M>{'\\lfloor P/2\\rfloor/P'}</M> LSB</>,
                  value: `${fmt(peakLsb, 6)} LSB = ${fmt(peakFs, 6, 'fs')}`,
                },
              ],
              answer: (
                <>
                  <M>{'N'}</M> = {fmt(n, 10)},<M>{'P_{256}'}</M> = {p === null ? '> 4096' : p},spur 基頻{' '}
                  {spurHz === null ? (p === 1 ? '無' : '< f_ref/4096') : fmt(spurHz / 1e6, 6, 'MHz')},峰值{' '}
                  {fmt(peakFs, 5, 'fs')},{band}
                </>
              ),
              warn: !legal
                ? `N = ${fmt(n, 8)} 超出本架構 [3, 3.25]:數字僅供參考,planner 會把此列標成不合法`
                : p === null
                  ? '分母超過 4096:視為長週期,峰值取 0.5 LSB 上界'
                  : undefined,
            };
          }}
        />
        <ExampleProblem
          index={2}
          tag="EXACT"
          title="RJ / DJ roll-up:把各項換成 fs 再合成"
          prompt={
            <>
              在 <M>{'N'}</M>、<M>{'f_{ref}'}</M> 下(<M>{'T_{vco}'}</M> 由 <code>configTVcoS</code> 換算),
              三個 random 項取 RSS;五個 deterministic 項換成單邊峰值 <M>{'d_i'}</M>(fs)後,分別以
              worst-case 線性和與 RSS 合成,並依本章定義 <M>{'DJ_{pp} = 2D'}</M>(對稱包絡假設)。
            </>
          }
          inputs={[
            { key: 'N', label: <M>{'N'}</M>, def: 3.13, min: 3, max: 3.25, step: 0.0005 },
            { key: 'fref', label: <M>{'f_{ref}'}</M>, def: 4, min: 0.1, max: 50, step: 0.01, unit: 'GHz' },
            { key: 'sref', label: <M>{'\\sigma_{ref}'}</M>, def: 40, min: 0, max: 10000, step: 1, unit: 'fs' },
            { key: 'svco', label: <M>{'\\sigma_{vco}'}</M>, def: 60, min: 0, max: 10000, step: 1, unit: 'fs' },
            { key: 'spulse', label: <M>{'\\sigma_{pulse}'}</M>, def: 20, min: 0, max: 10000, step: 1, unit: 'fs' },
            { key: 'q', label: <>quantization peak</>, def: 0.48, min: 0, max: 64, step: 0.01, unit: 'LSB' },
            { key: 'tap', label: <>tap mismatch</>, def: 0.5, min: 0, max: 45, step: 0.1, unit: 'deg' },
            { key: 'gain', label: <>DTC gain mismatch</>, def: 0.5, min: 0, max: 50, step: 0.1, unit: '%' },
            { key: 'inl', label: <>INL amplitude</>, def: 0.1, min: 0, max: 64, step: 0.05, unit: 'LSB' },
            { key: 'route', label: <>route skew</>, def: 30, min: -10000, max: 10000, step: 1, unit: 'fs' },
          ]}
          compute={(v) => {
            const cfg = fromPartial({ n_div: v.N, f_ref_hz: v.fref * 1e9 });
            const g = configG(cfg);
            const tVcoFs = configTVcoS(cfg) / FS;
            const lsb = tVcoFs / g;
            const b = computeBudget({
              tVcoS: configTVcoS(cfg),
              g,
              dtcRangeLsb: 1 << cfg.b_dtc,
              sRefFs: v.sref,
              sVcoFs: v.svco,
              sPulseFs: v.spulse,
              quantFs: v.q * lsb,
              tapDeg: v.tap,
              gainPct: v.gain,
              inlLsb: v.inl,
              routeFs: v.route,
              ber: 1e-12,
            });
            const d = (k: TermKey) => b.terms.find((t) => t.key === k)?.fs ?? NaN;
            return {
              steps: [
                { label: <><M>{'T_{vco}'}</M>、1 LSB = <M>{'T_{vco}/256'}</M></>, value: `${fmt(tVcoFs / 1000, 6, 'ps')}、${fmt(lsb, 6, 'fs')}` },
                { label: <><M>{'RJ_{rms} = \\sqrt{\\sum \\sigma^2}'}</M></>, value: fmt(b.rj, 6, 'fs') },
                { label: <><M>{'d_Q'}</M> = q·LSB</>, value: fmt(d('quant'), 6, 'fs') },
                { label: <><M>{'d_{tap} = \\delta/360\\cdot T_{vco}'}</M></>, value: fmt(d('tap'), 6, 'fs') },
                { label: <><M>{'d_{gain} = \\varepsilon\\cdot 64\\,\\mathrm{LSB}'}</M></>, value: fmt(d('gain'), 6, 'fs') },
                { label: <><M>{'d_{INL} = A\\cdot\\mathrm{LSB}'}</M></>, value: fmt(d('inl'), 6, 'fs') },
                { label: <><M>{'d_{route} = |t_{route}|'}</M></>, value: fmt(d('route'), 6, 'fs') },
                { label: <><M>{'D_{wc} = \\sum d_i'}</M></>, value: fmt(b.dWc, 6, 'fs') },
                { label: <><M>{'D_{rss} = \\sqrt{\\sum d_i^2}'}</M></>, value: fmt(b.dRss, 6, 'fs') },
              ],
              answer: (
                <>
                  <M>{'RJ_{rms}'}</M> = {fmt(b.rj, 5, 'fs')};<M>{'DJ_{pp}'}</M> worst-case ={' '}
                  {fmt(2 * b.dWc, 5, 'fs')},RSS = {fmt(2 * b.dRss, 5, 'fs')}
                </>
              ),
              warn:
                b.rj === 0 && b.dWc === 0 ? '所有來源皆為 0:budget 退化為 0' : undefined,
            };
          }}
        />
        <ExampleProblem
          index={3}
          tag="APPROX"
          title="TJ at BER:dual-Dirac 與 margin"
          prompt={
            <>
              已知 <M>{'DJ_{pp}'}</M>、<M>{'RJ_{rms}'}</M> 與目標 BER(以 <M>{'\\log_{10}'}</M> 輸入),
              用 <M>{'Q = \\sqrt2\\,\\operatorname{erfc}^{-1}(2\\,\\mathrm{BER})'}</M> 求{' '}
              <M>{'TJ = DJ_{pp} + 2Q\\,RJ_{rms}'}</M>,並與 TJ spec 比較 margin。dual-Dirac 假設:DJ 為兩根
              delta、RJ 為 Gaussian。
            </>
          }
          inputs={[
            { key: 'dj', label: <M>{'DJ_{pp}'}</M>, def: 431.63, min: 0, max: 1e6, step: 1, unit: 'fs' },
            { key: 'rj', label: <M>{'RJ_{rms}'}</M>, def: 74.833, min: 0, max: 1e6, step: 0.1, unit: 'fs' },
            { key: 'e', label: <M>{'\\log_{10}\\mathrm{BER}'}</M>, def: -12, min: -18, max: -1, step: 1 },
            { key: 'spec', label: <>TJ spec</>, def: 1600, min: 0, max: 1e7, step: 10, unit: 'fs' },
          ]}
          compute={(v) => {
            const ber = 10 ** v.e;
            const q = qOfBer(ber);
            const tj = v.dj + 2 * q * v.rj;
            const margin = v.spec - tj;
            return {
              steps: [
                { label: <>BER</>, value: fmt(ber, 4) },
                { label: <><M>{'Q = \\sqrt2\\,\\operatorname{erfc}^{-1}(2\\,\\mathrm{BER})'}</M></>, value: fmt(q, 6) },
                { label: <><M>{'2Q\\,RJ_{rms}'}</M></>, value: fmt(2 * q * v.rj, 6, 'fs') },
                { label: <><M>{'TJ = DJ_{pp} + 2Q\\,RJ_{rms}'}</M></>, value: fmt(tj, 6, 'fs') },
                { label: <>margin = spec − TJ</>, value: fmt(margin, 6, 'fs') },
              ],
              answer: (
                <>
                  <M>{'Q'}</M> = {fmt(q, 5)},<M>{'TJ'}</M> = {fmt(tj, 5, 'fs')},{margin >= 0 ? 'PASS' : 'FAIL'}
                  (margin {fmt(margin, 5, 'fs')})
                </>
              ),
              warn:
                v.e > -3
                  ? 'BER > 1e-3:dual-Dirac 的尾端外插在此區不具意義(Q 太小,DJ 主導)'
                  : undefined,
            };
          }}
        />
      </SectionExample>

      {/* ---------------------------------------------------- 5 互動圖 */}
      <SectionFigure
        title="圖一 Frequency Planner:候選 f_ref 的 N、P、spur 與排名"
        caption={
          <span>
            每列由連分數與 <M>{'P = q/\\gcd(q, G_s)'}</M> 直接算出(不跑模擬)
            <EpistemicTag kind="EXACT" />;帶內/帶外依右側 loop bandwidth <EpistemicTag kind="INFERENCE" />。
            點欄名排序(預設「排名」:exact → 帶外小 P → 帶內 → 不合法);點合法列即在圖二以{' '}
            <code>simulate()</code> 確認。peak 欄為 DTC grid 的 nearest 峰值(P 未知時為 0.5 LSB 上界)。
            不合法列以灰字顯示並註明原因。
          </span>
        }
      >
        <div style={CONTROL_GRID}>
          <NumberInput label="目標 f_vco" value={fVcoGHz} min={1} max={100} step={0.000001} unit="GHz" onChange={setFVcoGHz} />
          <Toggle label="sweep 模式(start/stop/step)" checked={sweepOn} onChange={setSweepOn} />
          {!sweepOn && (
            <div className="control control-number" style={{ gridColumn: '1 / -1' }}>
              <label className="control-label" htmlFor={listId}>
                f_ref 候選
              </label>
              <input
                id={listId}
                type="text"
                value={listText}
                title="GHz,以逗號或空白分隔"
                placeholder="GHz,逗號分隔"
                style={TEXT_INPUT_STYLE}
                onChange={(e) => setListText(e.target.value)}
              />
              <button type="button" className="preset-button" onClick={() => setListText(DEFAULT_LIST)}>
                預設清單
              </button>
            </div>
          )}
          {sweepOn && (
            <>
              <NumberInput label="start f_ref" value={swStart} min={0.1} max={50} step={0.001} unit="GHz" onChange={setSwStart} />
              <NumberInput label="stop f_ref" value={swStop} min={0.1} max={50} step={0.001} unit="GHz" onChange={setSwStop} />
              <NumberInput label="step" value={swStep} min={0.00001} max={10} step={0.001} unit="GHz" onChange={setSwStep} />
            </>
          )}
        </div>
        <p style={{ fontSize: 13, color: 'var(--fg-subtle)', margin: '6px 0' }}>
          {rows.length} 列(上限 {MAX_ROWS}):exact {bandCount.exact}、帶外 {bandCount.out}、帶內 {bandCount.in}、
          不合法 {bandCount.illegal};<M>{'f_{BW}'}</M> = {trimNumber(bwMHz, 4)} MHz(右側參數欄調整)。
        </p>
        <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                {sortTh('rank', '排名')}
                {sortTh('fref', 'f_ref (GHz)')}
                {sortTh('n', 'N')}
                <th>合法</th>
                <th>α·G</th>
                <th>|d| (LSB)</th>
                <th>α ≈ p/q</th>
                <th>P div</th>
                <th>P PMUX</th>
                {sortTh('pdtc', 'P DTC')}
                {sortTh('spur', 'spur f_ref/P')}
                {sortTh('peak', 'peak (fs)')}
                <th>分類</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const isSel = sel !== null && r === sel;
                const style: CSSProperties = {
                  cursor: r.legal ? 'pointer' : 'not-allowed',
                  color: r.legal ? undefined : 'var(--fg-faint)',
                  background: isSel ? 'var(--accent-soft)' : undefined,
                  fontWeight: isSel ? 600 : undefined,
                };
                return (
                  <tr
                    key={`${i}-${r.fRefGHz}`}
                    style={style}
                    onClick={() => {
                      if (r.legal) setSelFRef(r.fRefGHz);
                    }}
                    title={r.legal ? '點擊以 simulate() 確認' : r.reason}
                  >
                    <td>{rankOf.get(r) ?? '—'}</td>
                    <td>{trimNumber(r.fRefGHz, 8)}</td>
                    <td>{trimNumber(r.n, 10)}</td>
                    <td>{r.legal ? '是' : r.reason}</td>
                    <td>{trimNumber(r.alphaG, 8)}</td>
                    <td>{trimNumber(Math.abs(r.dist), 4)}</td>
                    <td>
                      {r.rat === null
                        ? '—'
                        : r.rat.exact
                          ? `${r.rat.p}/${r.rat.q}`
                          : `≈ ${r.rat.p}/${r.rat.q}`}
                    </td>
                    <td>{pStr(r.pStage[0])}</td>
                    <td>{pStr(r.pStage[1])}</td>
                    <td>{pStr(r.pStage[2])}</td>
                    <td>
                      {r.spurHz !== null
                        ? mhzStr(r.spurHz)
                        : r.pStage[2] === 1
                          ? '—(exact)'
                          : '< f_ref/4096'}
                    </td>
                    <td>{trimNumber(r.peakFs, 5)}</td>
                    <td style={{ color: BAND_COLOR[r.band], fontWeight: 600 }}>{BAND_LABEL[r.band]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <Callout type="warn" title="沒有候選">
            <p>清單為空或 sweep 參數不合法(需 start &gt; 0、step &gt; 0、stop ≥ start)。</p>
          </Callout>
        )}
      </SectionFigure>

      <SectionFigure
        title="圖二 選中列的 live 確認:simulate(f_ref_hz, n_div)的 e_FB_abs 與 PSD"
        caption={
          <span>
            以選中列的 <code>f_ref_hz</code> 與 <code>n_div</code> 跑 golden model {NC_PLAN} 拍(nearest、mode D),
            時域畫前 {NC_SHOW} 拍(fs),虛線為公式預測峰值;PSD 以 sample rate = 選中的 <M>{'f_{ref}'}</M>{' '}
            (MODEL_SPEC §17)、Hann periodogram,y 軸 dB re cycle²/Hz(未做 carrier normalization,不標 dBc),
            虛線為預測的 <M>{'m f_{ref}/P'}</M>。strong spur = 最強者 30 dB 內的 local maxima;「落在格點」容差
            ±1.5 bin。<EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        {sel === null || confirm === null ? (
          <Callout type="warn" title="沒有合法的候選">
            <p>目前清單中沒有 3 ≤ N ≤ 3.25 的 f_ref,無法模擬。</p>
          </Callout>
        ) : (
          <>
            <p style={{ fontSize: 13.5, margin: '4px 0 8px' }}>
              選中:<b>f_ref = {trimNumber(sel.fRefGHz, 8)} GHz</b>,N = {trimNumber(sel.n, 12)},
              T_vco = {trimNumber(sel.tVcoS * 1e12, 6)} ps,1 LSB = {fsStr(sel.tVcoS / 256 / FS)};分類{' '}
              <b style={{ color: BAND_COLOR[sel.band] }}>{BAND_LABEL[sel.band]}</b>。{' '}
              <button
                type="button"
                className="preset-button"
                onClick={() => setNDiv(sel.n)}
                title="寫入全站 N(其他章固定 f_ref = 4 GHz:α 的有理結構與 P 相同,但絕對頻率與 spur 間距會依 4 GHz 重算)"
              >
                以此 N 設為全域 N
              </button>
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>量</th>
                    <th>公式預測</th>
                    <th>simulate 偵測</th>
                    <th>判定</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>P(DTC grid)</td>
                    <td>{pStr(sel.pStage[2])}</td>
                    <td>{confirm.detP === null ? `> ${NC_PLAN / 2}(視窗內未重複)` : confirm.detP}</td>
                    <td>
                      <Verdict
                        ok={confirm.detP !== null && confirm.detP === sel.pStage[2]}
                        na={sel.pStage[2] === null || (sel.pStage[2] ?? 0) > NC_PLAN / 2}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td>spur 基頻 f_ref/P</td>
                    <td>{sel.spurHz === null ? '—(無 spur)' : mhzStr(sel.spurHz)}</td>
                    <td>
                      {confirm.lowestHz === null
                        ? '無 strong spur'
                        : `${mhzStr(confirm.lowestHz)}(最低 strong spur;bin = ${mhzStr(confirm.binHz, 5)})`}
                    </td>
                    <td>
                      {sel.spurHz === null ? (
                        <Verdict ok={confirm.lowestHz === null} />
                      ) : (
                        <Verdict
                          ok={confirm.lowestHz !== null && Math.abs(confirm.lowestHz - sel.spurHz) <= 1.5 * confirm.binHz}
                        />
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td>strong spur 落在 m·f_ref/P</td>
                    <td>全部</td>
                    <td>
                      {confirm.onGrid} / {confirm.strong}
                      {confirm.topHz !== null ? `(最強在 ${mhzStr(confirm.topHz)})` : ''}
                    </td>
                    <td>
                      <Verdict
                        ok={confirm.onGrid === confirm.strong}
                        na={sel.pStage[2] === null || sel.pStage[2] === 1}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td>peak |e_FB_abs|</td>
                    <td>{fsStr(sel.peakFs, 6)}</td>
                    <td>{fsStr(confirm.peakFs, 6)}</td>
                    <td>
                      <Verdict ok={Math.abs(confirm.peakFs - sel.peakFs) < 0.01} na={sel.pStage[2] === null} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            {eOption !== null && <EChart option={eOption} height={260} />}
            {confirm.peakFs === 0 ? (
              <Callout type="note" title="e_FB ≡ 0">
                <p>
                  α·G 為整數(exact on-grid):整條序列為零,PSD 無任何量化功率 —— 這就是 planner 把它排第一的原因。
                  注意這只代表<b>量化</b>項為零(見常見誤解)。
                </p>
              </Callout>
            ) : (
              psdOption !== null && <EChart option={psdOption} height={300} />
            )}
          </>
        )}
      </SectionFigure>

      <SectionFigure
        title="圖三 Jitter Budget:RJ / DJ 合成、dual-Dirac TJ、margin 與 dominant contributor"
        caption={
          <span>
            操作點的 <M>{'T_{vco}'}</M> 由 <code>configTVcoS</code> 換算;量化峰值預設由 model 在操作點實跑
            (max|e_ZC_hw|,nominal config)<EpistemicTag kind="EXPERIMENT" />。堆疊長條為 TJ 的加法份額:DJ 項
            為 2d_i(RSS 欄按 d_i² 比例分攤),RJ 項按變異數比例分攤 2Q·RJ <EpistemicTag kind="APPROX" />;
            紅色虛線為 TJ spec。BER 在右側參數欄。
          </span>
        }
      >
        <div style={CONTROL_GRID}>
          <SelectControl
            label="操作點"
            value={opPoint}
            options={[
              { value: 'global', label: `全域 N = ${trimNumber(nDiv, 8)} @ f_ref = 4 GHz` },
              {
                value: 'planner',
                label: sel === null ? 'Planner 選中列(無)' : `Planner 選中列(f_ref = ${trimNumber(sel.fRefGHz, 7)} GHz)`,
              },
            ]}
            onChange={(v) => setOpPoint(v === 'planner' ? 'planner' : 'global')}
          />
          <NumberInput label="σ_ref(reference)" value={sRef} min={0} max={100000} step={1} unit="fs rms" onChange={setSRef} />
          <NumberInput label="σ_vco(residual / cycle)" value={sVco} min={0} max={100000} step={1} unit="fs rms" onChange={setSVco} />
          <NumberInput label="σ_pulse(pulse timing)" value={sPulse} min={0} max={100000} step={1} unit="fs rms" onChange={setSPulse} />
          <Toggle label={`量化峰值自動(model:${trimNumber(opRun.quantFs, 5)} fs)`} checked={quantAuto} onChange={setQuantAuto} />
          {!quantAuto && (
            <NumberInput label="量化峰值(手動)" value={quantManual} min={0} max={100000} step={1} unit="fs" onChange={setQuantManual} />
          )}
          <NumberInput label="tap mismatch" value={tapDeg} min={0} max={45} step={0.1} unit="deg" onChange={setTapDeg} />
          <NumberInput label="DTC gain mismatch" value={gainPct} min={0} max={50} step={0.1} unit="% (64 LSB)" onChange={setGainPct} />
          <NumberInput label="INL amplitude" value={inlLsb} min={0} max={64} step={0.05} unit="LSB" onChange={setInlLsb} />
          <NumberInput label="route skew" value={routeFs} min={-100000} max={100000} step={1} unit="fs" onChange={setRouteFs} />
          <NumberInput label="spec rms(0 = 不檢查)" value={specRms} min={0} max={1e6} step={1} unit="fs" onChange={setSpecRms} />
          <NumberInput label="spec TJ(0 = 不檢查)" value={specTj} min={0} max={1e7} step={10} unit="fs" onChange={setSpecTj} />
        </div>
        <p style={{ fontSize: 13, color: 'var(--fg-subtle)', margin: '6px 0' }}>
          操作點:N = {trimNumber(opN, 10)},f_ref = {trimNumber(opFRefHz / 1e9, 7)} GHz,T_vco ={' '}
          {trimNumber(budget.tVcoFs / 1000, 6)} ps,1 LSB = {fsStr(budget.lsbFs)};BER = 1e{berExp} → Q ={' '}
          {trimNumber(budget.q, 5)}。
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>來源</th>
                <th>類別</th>
                <th>輸入</th>
                <th>σ 或 d_i (fs)</th>
                <th>TJ_wc 份額 (fs)</th>
                <th>% of TJ_wc</th>
                <th>TJ_rss 份額 (fs)</th>
              </tr>
            </thead>
            <tbody>
              {budget.terms.map((t) => {
                const dom = t.key === budget.dominant;
                return (
                  <tr key={t.key} style={dom ? { background: 'var(--accent-soft)', fontWeight: 600 } : undefined}>
                    <td style={{ textAlign: 'left' }}>
                      {t.label}
                      {dom ? <span style={{ color: 'var(--accent)' }}>(dominant)</span> : ''}
                    </td>
                    <td>{t.kind}</td>
                    <td>{t.input}</td>
                    <td>{trimNumber(t.fs, 5)}</td>
                    <td>{trimNumber(t.shareWc, 5)}</td>
                    <td>{budget.tjWc > 0 ? `${trimNumber((100 * t.shareWc) / budget.tjWc, 3)}%` : '—'}</td>
                    <td>{trimNumber(t.shareRss, 5)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>合成量</th>
                <th>worst-case</th>
                <th>RSS</th>
                <th>spec</th>
                <th>margin(worst-case)</th>
                <th>margin(RSS)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ textAlign: 'left' }}>RJ_rms</td>
                <td colSpan={2}>{fsStr(budget.rj)}</td>
                <td>—</td>
                <td colSpan={2}>—</td>
              </tr>
              <tr>
                <td style={{ textAlign: 'left' }}>D(單邊峰值)</td>
                <td>{fsStr(budget.dWc)}</td>
                <td>{fsStr(budget.dRss)}</td>
                <td>—</td>
                <td colSpan={2}>—</td>
              </tr>
              <tr>
                <td style={{ textAlign: 'left' }}>DJ_pp = 2D</td>
                <td>{fsStr(2 * budget.dWc)}</td>
                <td>{fsStr(2 * budget.dRss)}</td>
                <td>—</td>
                <td colSpan={2}>—</td>
              </tr>
              <tr>
                <td style={{ textAlign: 'left' }}>TJ(BER = 1e{berExp})</td>
                <td>{fsStr(budget.tjWc)}</td>
                <td>{fsStr(budget.tjRss)}</td>
                <td>{specTj > 0 ? fsStr(specTj) : '—'}</td>
                <td>{marginCell(specTj, budget.tjWc)}</td>
                <td>{marginCell(specTj, budget.tjRss)}</td>
              </tr>
              <tr>
                <td style={{ textAlign: 'left' }}>σ_tot ≈ √(RJ² + D_rss²/3)</td>
                <td colSpan={2}>{fsStr(budget.rmsEst)}</td>
                <td>{specRms > 0 ? fsStr(specRms) : '—'}</td>
                <td colSpan={2}>{marginCell(specRms, budget.rmsEst)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {dominantTerm !== undefined && (
          <p style={{ fontSize: 13.5, margin: '8px 0' }}>
            Dominant contributor:<b style={{ color: 'var(--accent)' }}>{dominantTerm.label}</b>({dominantTerm.kind}),
            佔 TJ_wc 的 {budget.tjWc > 0 ? trimNumber((100 * dominantTerm.shareWc) / budget.tjWc, 3) : '—'}%。
            <EpistemicTag kind="APPROX" />
          </p>
        )}
        <EChart option={barOption} height={340} />
      </SectionFigure>

      <SectionFigure
        title="圖四 Cross-check by simulation:budget 估計 vs simulate() 實測"
        caption={
          <span>
            按鈕以操作點跑兩次 <code>simulate()</code>({NC_XCHECK} 拍,seed 12345):full(含三個隨機源)與
            deterministic-only(隨機 σ 全設 0,其餘相同)。設定:<code>inj_model = 'reset'</code>(§14 理想上限)、
            Δf = 0、tap mismatch 放在 tap {XC_TAP}、<code>dtc_inj_gain = 1 + ε</code>、
            <code>inl_sin_amp_cycles = A/256</code>、<code>route_inj_cycles</code>、
            <code>sigma_vco_w_rad = 2π·σ_vco/T_vco</code>。隨機部分 = full − deterministic(同一確定性序列相減)。
            峰值估計用 BER_eff = 1/{NC_XCHECK} → Q = {trimNumber(qOfBer(1 / NC_XCHECK), 5)}。ratio = sim / budget,
            照實顯示。<EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' }}>
          <div style={{ minWidth: 280 }}>
            <SelectControl
              label="injection mapping"
              value={xcMapping}
              options={[
                { value: 'naive', label: 'naive(c ≤ 31,預設)' },
                { value: 'redundant_random', label: 'redundant_random(p = 0.5,c 用滿 0..63)' },
              ]}
              onChange={(v) => setXcMapping(v === 'redundant_random' ? 'redundant_random' : 'naive')}
            />
          </div>
          <button type="button" className="preset-button" onClick={runXc} disabled={xcBusy}>
            {xcBusy ? '模擬中…' : 'cross-check by simulation'}
          </button>
          {xcStale && (
            <span style={{ fontSize: 12.5, color: 'var(--status-running)' }}>
              參數已變更:下表仍是上次執行的結果,請重跑。
            </span>
          )}
        </div>
        {xc === null ? (
          <p style={{ fontSize: 13.5, color: 'var(--fg-subtle)' }}>
            尚未執行。按下按鈕後此處顯示 θ⁻ 與 e_ZC_total 兩組比較(預設情境 N = 3.13、naive 的 python3 結果:
            θ⁻ rms ratio 1.04、e_ZC_total rms ratio 1.20,見圖上應觀察什麼)。
          </p>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--fg-subtle)', margin: '8px 0 4px' }}>
              上次執行:N = {trimNumber(xc.n, 10)},f_ref = {trimNumber(xc.fRefHz / 1e9, 7)} GHz,mapping = {xc.mapping}。
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>觀測量</th>
                    <th>budget 估計 (fs)</th>
                    <th>simulate 量測 (fs)</th>
                    <th>ratio sim / budget</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'left', fontWeight: 600 }}>
                      θ⁻:kick 前 VCO 絕對相位誤差(budget 的直接對應)
                    </td>
                  </tr>
                  <tr>
                    <td style={{ textAlign: 'left' }}>RJ rms(full − det)</td>
                    <td>{trimNumber(xc.budget.rj, 5)}</td>
                    <td>{trimNumber(xc.th.rj, 5)}</td>
                    <td>{ratioStr(xc.th.rj, xc.budget.rj)}</td>
                  </tr>
                  <tr>
                    <td style={{ textAlign: 'left' }}>DJ pp(det)</td>
                    <td>wc {trimNumber(2 * xc.budget.dWc, 5)} / RSS {trimNumber(2 * xc.budget.dRss, 5)}</td>
                    <td>{trimNumber(xc.th.djPp, 5)}</td>
                    <td>{ratioStr(xc.th.djPp, 2 * xc.budget.dWc)} / {ratioStr(xc.th.djPp, 2 * xc.budget.dRss)}</td>
                  </tr>
                  <tr>
                    <td style={{ textAlign: 'left' }}>DJ peak |·|(det,相對理想)</td>
                    <td>wc {trimNumber(xc.budget.dWc, 5)} / RSS {trimNumber(xc.budget.dRss, 5)}</td>
                    <td>{trimNumber(xc.th.djPeak, 5)}</td>
                    <td>{ratioStr(xc.th.djPeak, xc.budget.dWc)} / {ratioStr(xc.th.djPeak, xc.budget.dRss)}</td>
                  </tr>
                  <tr>
                    <td style={{ textAlign: 'left' }}>total rms</td>
                    <td>{trimNumber(xc.budget.rmsEst, 5)}</td>
                    <td>{trimNumber(xc.th.rms, 5)}</td>
                    <td>{ratioStr(xc.th.rms, xc.budget.rmsEst)}</td>
                  </tr>
                  <tr>
                    <td style={{ textAlign: 'left' }}>total peak(D + Q·RJ)</td>
                    <td>
                      wc {trimNumber(xc.budget.dWc + xc.qN * xc.budget.rj, 5)} / RSS{' '}
                      {trimNumber(xc.budget.dRss + xc.qN * xc.budget.rj, 5)}
                    </td>
                    <td>{trimNumber(xc.th.peak, 5)}</td>
                    <td>
                      {ratioStr(xc.th.peak, xc.budget.dWc + xc.qN * xc.budget.rj)} /{' '}
                      {ratioStr(xc.th.peak, xc.budget.dRss + xc.qN * xc.budget.rj)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'left', fontWeight: 600 }}>
                      e_ZC_total:pulse 處 zero-crossing miss(reset 下為 pulse 誤差的一階差分)
                    </td>
                  </tr>
                  <tr>
                    <td style={{ textAlign: 'left' }}>RJ rms(full − det)</td>
                    <td>
                      budget {trimNumber(xc.budget.rj, 5)} / reset 預測 {trimNumber(xc.resetRj, 5)}
                    </td>
                    <td>{trimNumber(xc.ez.rj, 5)}</td>
                    <td>{ratioStr(xc.ez.rj, xc.budget.rj)} / {ratioStr(xc.ez.rj, xc.resetRj)}</td>
                  </tr>
                  <tr>
                    <td style={{ textAlign: 'left' }}>total rms</td>
                    <td>{trimNumber(xc.budget.rmsEst, 5)}</td>
                    <td>{trimNumber(xc.ez.rms, 5)}</td>
                    <td>{ratioStr(xc.ez.rms, xc.budget.rmsEst)}</td>
                  </tr>
                  <tr>
                    <td style={{ textAlign: 'left' }}>total peak(D + Q·RJ)</td>
                    <td>
                      wc {trimNumber(xc.budget.dWc + xc.qN * xc.budget.rj, 5)} / RSS{' '}
                      {trimNumber(xc.budget.dRss + xc.qN * xc.budget.rj, 5)}
                    </td>
                    <td>{trimNumber(xc.ez.peak, 5)}</td>
                    <td>
                      {ratioStr(xc.ez.peak, xc.budget.dWc + xc.qN * xc.budget.rj)} /{' '}
                      {ratioStr(xc.ez.peak, xc.budget.dRss + xc.qN * xc.budget.rj)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            {xcOption !== null && <EChart option={xcOption} height={300} />}
          </>
        )}
      </SectionFigure>

      {/* ---------------------------------------------------- 6 程式碼 */}
      <SectionCode language="typescript" title="Planner:連分數 helper 與 model 呼叫(本章真實碼節錄)" code={PLANNER_SRC}>
        <p>
          <code>cfApprox</code>/<code>stagePeriod</code> 是本章的規劃層 helper(與 Ch21 同一公式,分母上限放寬到
          4096 並加上 <M>{'\\operatorname{frac}(\\alpha G)'}</M> fallback);N、α、G、<M>{'T_{vco}'}</M> 與確認模擬
          全部經 <code>../model</code>。
        </p>
      </SectionCode>
      <SectionCode language="typescript" title="Jitter budget 與 cross-check 的 model 呼叫(本章真實碼節錄)" code={BUDGET_SRC} />

      {/* ---------------------------------------------------- 7 逐行 */}
      <SectionLineByLine
        items={[
          {
            code: 'const q2 = ai * q1 + q0; // q_i = a_i·q_{i−1} + q_{i−2}',
            explain:
              'convergent 分母遞迴。分母單調遞增,一旦超過 qMax = 4096 就停 —— 回傳的是「分母 ≤ 4096 的最佳有理近似」。',
          },
          {
            code: 'best = { p: p1, q: q1, err, exact: err < tol };',
            explain:
              'tol = 1e-10:分母 ≤ 4096 的相異分數至少相距 1/4096² ≈ 6e-8,f_vco/f_ref 的 float64 捨入約 1e-16,兩者之間有 6 個數量級的安全距離。',
          },
          {
            code: 'if (r !== null && r.exact) return r.q / gcd(r.q, g);',
            explain: 'MODEL_SPEC §1.1 的 P = q / gcd(q, G)。G = 256 時 gcd 只取 q 的 2 的冪因子 —— 所以 q = 272 = 16·17 → P = 17。',
          },
          {
            code: 'const r2 = cfApprox(y - Math.floor(y));',
            explain:
              'α 的分母 > 4096(例:4.096 GHz 的 α = 4821/32768)時直接約 frac(α·G):其最簡分母就是 q/gcd(q, G)。DTC 級 85/128 → P = 128,而 PMUX/divider 級的 8192/32768 仍超出上限 → 顯示「> 4096」。',
          },
          {
            code: 'const dist = alphaG - qNearest(alphaG); // half-up(MODEL_SPEC §2)',
            explain: '用 model 的 qNearest(floor(x + 0.5)),不用 Math.round,與 Python 逐位一致;d = 0 ⇔ on-grid ⇔ P_256 = 1。',
          },
          {
            code: 'const peakLsb = pDtc === null ? 0.5 : Math.floor(pDtc / 2) / pDtc;',
            explain: 'P 個殘量 j/P 經 nearest 量化後的最大 |誤差|;P 為偶數時恰為 0.5 LSB(half-up tie)。未知 P 取上界 0.5 LSB。',
          },
          {
            code: "simulate(fromPartial({ f_ref_hz: fRefHz, n_div: n, n_cycles: NC_PLAN, quantizer: 'nearest' }))",
            explain: 'config 原生支援 f_ref_hz:每個候選以自己的 f_ref 與 N 跑 golden model,PSD 的 sample rate 也跟著換(§17)。',
          },
          {
            code: 'if (Math.abs(s.freqHz - m * spacing) <= 1.5 * binHz) onGrid += 1;',
            explain: 'f_ref/P 通常不落在 FFT bin 上(4.25 GHz:bin 4.150 MHz,250 MHz = 60.24 bin),所以容差 ±1.5 bin。',
          },
          {
            code: 'return Math.SQRT2 * erfcInv(2 * ber);',
            explain: 'BER = ½·erfc(Q/√2) 的反函數;erfcInv 由 Acklam Φ⁻¹ 構成。Q(1e-12) = 7.0345,Q(1/4096) = 3.4871。',
          },
          {
            code: 'const tjWc = 2 * dWc + 2 * q * rj;',
            explain: 'dual-Dirac:DJ_pp(此處 = 2D,對稱包絡假設)加上兩側各 Q·RJ 的 Gaussian 尾。RSS 版只把 D_wc 換成 D_rss。',
          },
          {
            code: 'sigma_vco_w_rad: noise ? (TWO_PI * b.sVcoFs * FS) / tVcoS : 0,',
            explain: 'budget 以 fs 輸入,model 的 VCO 白雜訊以 rad/ref-cycle 輸入:乘 2π/T_vco(T_vco 來自 configTVcoS)。',
          },
          {
            code: "inj_model: 'reset',",
            explain: '§14 ideal reset:θ⁺ = −ε,下一拍 θ⁻ = w − ε[k−1]。θ⁻ 對應 budget(各源一次);e_ZC_total 則是 ε 的一階差分。',
          },
          {
            code: 'const det = simulate(xcConfig(n, fRefHz, b, mapping, false));',
            explain: '第二次跑把三個 σ 設 0、其餘不變:noiseless config 不消耗 PRNG(§12),確定性序列逐位相同,full − det 即純隨機部分。',
          },
        ]}
      />

      {/* ---------------------------------------------------- 8 觀察 */}
      <SectionObserve>
        <ul>
          <li>
            <b>圖一預設清單:</b>3.84 / 3.90625 / 3.96 GHz 灰字不合法(N = 3.3569 / 3.3 / 3.2552 &gt; 3.25);
            4.0 GHz(<M>{'\\alpha G = 57'}</M>)與 4.125 GHz(N = 3.125)為 exact,排第 1、2;4.25 GHz 的{' '}
            <M>{'P = 17'}</M>、250 MHz 在 50 MHz 帶外排第 3;4.096 GHz 的 <M>{'P = 128'}</M>、32 MHz 落在帶內排第 4。
            把 <M>{'f_{BW}'}</M> 拉到 32 MHz 以下,4.096 GHz 立刻改判帶外(名次仍在 4.25 GHz 之後,因為同為帶外時 P = 17 &lt; 128)。<EpistemicTag kind="EXACT" />
          </li>
          <li>
            <b>sweep 模式</b>(3.9–4.3 GHz、5 MHz 步進,81 列,<M>{'f_{BW}'}</M> = 50 MHz):exact 2、帶外 18、帶內 46、
            不合法 15;帶外最佳是 4.2 GHz(<M>{'P = 7'}</M>、600 MHz)。exact 只出現在{' '}
            <M>{'f_{ref} = 3300/m'}</M> GHz(<M>{'f_{vco}\\cdot256 = 3300'}</M>)且恰落在步進格點上的 4.0 與 4.125。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            <b>圖二選 4.25 GHz:</b>偵測 P = 17、峰值 142.60 fs 與公式逐位相同;最低 strong spur 249.02 MHz
            (bin 4.150 MHz,與 250 MHz 差 &lt; 1 bin),8 根 strong spur 全部落在 <M>{'m\\cdot250'}</M> MHz 格點,
            最強的是 2000.49 MHz(m = 8)而不是基頻(基頻低 6.1 dB)。選 4.096 GHz:P = 128,36 / 36 根落在 32 MHz
            的整數倍,最強在 1376 MHz(m = 43),32 MHz 基頻低 9.5 dB —— <b>spur 間距由 P 決定,但哪一根最強由鋸齒形狀
            決定</b>。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            <b>圖三預設:</b>TJ_wc(1e-12)= 1896.3 fs 對 1.6 ps spec <b>FAIL(−296.3 fs)</b>,TJ_rss = 1484.5 fs PASS
            (+115.5 fs);σ_tot = 145.35 fs 剛好過 150 fs。dominant 是 VCO residual(676.8 fs,35.7%),量化只佔
            15.8%(299.5 fs)—— 這組數字下,先改善 injection/VCO,而不是加 DSM。<EpistemicTag kind="EXACT" />
          </li>
          <li>
            <b>圖四預設(N = 3.13、naive)按下 cross-check:</b>θ⁻ 的 RJ 74.63 vs 74.83 fs(ratio 0.997)、total rms
            151.67 vs 145.35 fs(1.04)、peak 506.1 fs(對 wc 估計 0.74、對 RSS 估計 1.06);DJ peak 338.2 fs 對 D_rss
            215.8 fs 是 <b>1.57×</b> —— RSS 低估峰值,因為 tap/gain/INL/route 都是單邊(同號)誤差。e_ZC_total 的隨機部分
            86.86 fs 對 budget RJ 為 1.16×,但對 reset 預測 87.18 fs 為 0.996;total rms 174.8 fs(1.20×)。
            <EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
      </SectionObserve>

      {/* ---------------------------------------------------- 9 誤解 */}
      <SectionMisconception>
        <Callout type="warn" title="誤解一:「on-grid(exact)就沒有 jitter」">
          <p>
            錯。on-grid 只讓<b>量化</b>項 <M>{'d_Q'}</M> 變成 0。把操作點換成 N = 3.22265625(4.0 GHz 的 exact 列,
            <M>{'T_{vco}'}</M> = 77.576 ps),其餘預設不變:TJ_wc(1e-12)仍有 1582.9 fs、TJ_rss 1355.0 fs、σ_tot 114.9 fs ——
            只比 off-grid 的 N = 3.13(1896.3 fs)少 16.5%。tap mismatch(107.7 fs)、DTC gain(97.0 fs)、INL、route
            與三個 random 項全部還在;cross-check 實測 θ⁻ 的 DJ peak 仍有 196.3 fs、rms 121.5 fs。
            <EpistemicTag kind="EXPERIMENT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解二:「deterministic 項用 RSS 合成就夠了」">
          <p>
            RSS 只在各項獨立、符號隨機時成立。本 model 的 tap/gain/INL/route 都是單邊(同號)誤差,會同向相加:
            預設情境下 θ⁻ 的 DJ 峰值 338.2 fs 是 D_rss(215.8 fs)的 1.57 倍,卻只有 D_wc(421.7 fs)的 0.80 倍。
            sign-off 用 worst-case,RSS 只作為「典型值」參考。<EpistemicTag kind="EXPERIMENT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解三:「最強的 spur 就在 f_ref/P」">
          <p>
            spur <b>位置</b>由 P 決定(全部落在 <M>{'m f_{ref}/P'}</M>),但各諧波的<b>幅度</b>由誤差序列的形狀決定。
            4.096 GHz 的最強 spur 在 1376 MHz(第 43 根),基頻 32 MHz 低 9.5 dB。帶內/帶外分類只看基頻是保守的
            第一步,完整判斷要看整串 comb 與 loop transfer。<EpistemicTag kind="EXPERIMENT" />
          </p>
        </Callout>
      </SectionMisconception>

      {/* ---------------------------------------------------- 10 設計要點 */}
      <SectionTakeaway>
        <ol>
          <li>
            <b>先排頻率,再設計電路。</b>同一個 <M>{'f_{vco}'}</M>,換 <M>{'f_{ref}'}</M> 就能讓量化 spur 消失
            (12.890625 GHz:4.0 / 4.125 GHz exact)或推到帶外(4.25 GHz,<M>{'P = 17'}</M>、250 MHz),成本是零。
          </li>
          <li>
            <b>做不到 exact 時選「小 P、帶外」。</b>小 P → spur 根數少、基頻高、易被 loop 濾掉;避開
            4.096 GHz 這種 <M>{'P = 128'}</M>、32 MHz 帶內的點。exact 的條件是 <M>{'f_{ref} = 256 f_{vco}/m'}</M>。
          </li>
          <li>
            <b>Budget 的用途是找 dominant contributor。</b>預設情境下 VCO residual 佔 TJ_wc 35.7%、量化 15.8%:
            加強 injection(或 VCO)比加 DSM 階數有效;DSM 反而會放大 per-edge 峰值(Ch21/Ch22)。
          </li>
          <li>
            <b>sign-off 用 worst-case,RSS 當典型值。</b>單邊同號的 DJ 會線性相加(RSS 低估峰值 1.57×)。
          </li>
          <li>
            <b>估計之後一定跑模擬。</b>budget 與 θ⁻ 的 rms 差 4%;但 ZC miss(e_ZC_total)在 strong injection 下看的是
            pulse-to-pulse 差分,隨機項 ×√2、靜態 offset 消失 —— 規格要寫清楚量的是哪一個。
          </li>
        </ol>
      </SectionTakeaway>

      {/* ---------------------------------------------------- 11 限制 */}
      <SectionLimitation>
        <Callout type="honesty" title="模型限制">
          <ul>
            <li>
              <b>dual-Dirac 是近似。</b>真實 DJ 分佈不是兩根 delta(量化鋸齒近似均勻、tap mismatch 是 1/8 機率的單點),
              RJ 假設 Gaussian 且各源獨立;Q 以 Acklam 近似(相對誤差 ~1e-9)。<M>{'DJ_{pp} = 2D'}</M> 的對稱包絡、
              rms 的「峰值/√3」、RJ 份額按變異數分攤都是本章的簿記慣例。<EpistemicTag kind="APPROX" />
            </li>
            <li>
              <b>loop 沒有共同設計。</b>帶內/帶外只是 <M>{'f_{spur,1}'}</M> 對 <M>{'f_{BW}'}</M> 的硬門檻;真實
              closed-loop transfer 有 peaking 與有限 roll-off,而 injection path 對高頻 scheduling 誤差是 high-pass
              (Ch22),spur 是否可接受要用完整 transfer(或 §14.1 loop co-sim)評估。<EpistemicTag kind="INFERENCE" />
            </li>
            <li>
              <b>f_ref 候選假設一樣乾淨。</b>planner 只看 α 的有理結構;不同 f_ref 來源的 phase noise、自身 spur、
              取得成本與 duty-cycle 都假設相同,budget 的 σ_ref 也不隨 f_ref 改變。<EpistemicTag kind="ASSUMPTION" />
            </li>
            <li>
              planner 只算 nearest quantizer、feedback 的 e_FB(mode D 下 injection 的 e_ZC_hw 有同樣的 P);DSM 會改變
              spur 分佈(Ch21)。P &gt; 4096 不再細分(spur 間距 &lt; f_ref/4096)。
            </li>
            <li>
              budget 的 gain 項取 64 LSB 滿量程;naive mapping 只用 c ≤ 31,故此項約保守 2×(redundant_random 會用滿)。
              tap mismatch 只放在單一 tap 3。
            </li>
            <li>
              cross-check 為單一 realization(seed 12345)、{NC_XCHECK} 拍、reset injection 理想上限;峰值統計受樣本數
              限制(BER_eff = 1/{NC_XCHECK}),不能外插到 1e-12 的實測。
            </li>
          </ul>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="參數">
        <Slider
          label="全域 N(budget 操作點)"
          value={nDiv}
          min={3}
          max={3.25}
          step={0.0005}
          onChange={setNDiv}
          fmt={(v) => trimNumber(v, 10)}
        />
        <PresetButtons
          label="Preset N"
          presets={[...N_DIV_PRESETS, 3.22265625].map((n) => ({ label: String(n), onClick: () => setNDiv(n) }))}
        />
        <Slider
          label="loop bandwidth f_BW"
          value={bwMHz}
          min={1}
          max={2000}
          log
          unit="MHz"
          onChange={setBwMHz}
          fmt={(v) => trimNumber(v, 4)}
        />
        <Slider
          label="spec BER(log₁₀)"
          value={berExp}
          min={-18}
          max={-3}
          step={1}
          onChange={setBerExp}
          fmt={(v) => `1e${v}`}
        />
        <p style={{ fontSize: 12, color: 'var(--fg-subtle)', margin: '8px 0 0' }}>
          f_vco、f_ref 候選與 sweep 在圖一;budget 各項在圖三;cross-check mapping 在圖四。
        </p>
      </ParamPanel>
    </ChapterShell>
  );
}
