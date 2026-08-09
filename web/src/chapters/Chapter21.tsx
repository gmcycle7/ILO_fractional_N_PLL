/**
 * Chapter 21 — PD 輸入端誤差逐級解析 PD-Input Phase Error Anatomy
 *
 * Content contract: CHAPTER_GUIDE.md Ch21; math contract: MODEL_SPEC.md
 * section 2 (wrap/quantize primitives), section 3 (ideal trajectory),
 * section 4 (feedback decode 與 e_FB_abs), section 6 (quantizers),
 * section 17 (PSD/spur conventions)。
 *
 * 主題:feedback chain「/3-/4 divider → 4-to-1 PMUX → 6-bit DTC」在不同
 * divide ratio 下於 PD 輸入端產生的 phase error —— 從第一性原理、逐級暫態、
 * DSM 的有效解析度,到每一級的頻譜與頻譜合理性檢查。
 * 全章為 open-loop scheduler error(PD 之前),不含 loop dynamics。
 *
 * 所有引用數字均以 python3(model/python,同一 golden model)交叉驗證;
 * stage 量化的 v = A_ideal·(S/256) 中 S/256 為 2 的冪 → 縮放無捨入,
 * TS 與 Python 逐位一致。
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
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
import DebugTable from '../components/DebugTable';
import { M, MathBlock } from '../components/Math';
import { ParamPanel, Slider, SelectControl, Toggle, PresetButtons } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import { makeLineOption, baseAxis, makeMarkLine } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import {
  phaseAxisLabel,
  makePhaseTickFormatter,
  formatSiTime,
  trimNumber,
} from '../lib/format';
import { useChapterNDiv, N_DIV_PRESETS } from '../lib/globalParams';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  aIdeal,
  wrapCycles,
  pymod,
  makeQuantizer,
  ErrorFeedbackFirstOrder,
  makeStream,
  triangularDither,
  periodogramPsd,
  detectSpurs,
  rms,
  mean,
} from '../model';
import type { Quantizer } from '../model';

const meta = chapterById(21)!;

const F_REF = 4e9;
const NC_PSD = 1024; // 2 的冪 → Hann periodogram 用滿全長,bin = f_ref/1024
const F_BAND = F_REF / 64; // in-band proxy 上限 62.5 MHz
/** 診斷用微擾:dyadic 加項讓 α 的有效有理週期 ≫ 觀察窗(見 Layer 3/4)。 */
const DIAG_DELTA = 2 ** -13 + 2 ** -25;
/** periodic Hann 的 U = mean(w²) = 3/8(整數週期 cos 平均為 0、cos² 為 1/2)。 */
const HANN_U = 0.375;

type StageKey = 'div' | 'pmux' | 'dtc';

interface StageDef {
  key: StageKey;
  s: number; // 每 VCO cycle 的 grid steps:1 / 4 / 256
  labelZh: string;
  short: string;
}

const STAGE_DEFS: StageDef[] = [
  { key: 'div', s: 1, labelZh: '/3-/4 divider 單獨(grid = T_vco)', short: 'divider' },
  { key: 'pmux', s: 4, labelZh: '+ 4-to-1 PMUX(grid = T_vco/4)', short: '+PMUX' },
  { key: 'dtc', s: 256, labelZh: '+ 6-bit DTC(grid = T_vco/256)', short: '+DTC' },
];

const QUANT_OPTIONS: { value: Quantizer; label: string }[] = [
  { value: 'nearest', label: 'nearest(half-up)' },
  { value: 'ef1', label: 'ef1(1st-order DSM)' },
  { value: 'mash11', label: 'mash11(MASH 1-1)' },
  { value: 'mash111', label: 'mash111(MASH 1-1-1)' },
];

const DSM_ORDER: Record<string, number> = { nearest: 0, floor: 0, truncate: 0, ef1: 1, mash11: 2, mash111: 3 };

/* ------------------------------------------------------------------ */
/* stage 量化 helper(SectionCode 引用的即為此段真實碼)               */
/* ------------------------------------------------------------------ */

interface StageRun {
  v: Float64Array; // ideal code(stage-LSB 單位)= A_ideal · S/256
  y: Float64Array; // 量化後整數 code
  err: Float64Array; // e_PD = wrapCycles((y − v)/S),cycles
  raw: Float64Array; // (y − v)/S 未 wrap,cycles
  state: Float64Array; // quantizer 內部 state(逐拍記錄)
  folds: number; // |raw| ≥ 0.5 cycle 的拍數(wrap 摺疊)
}

/** 把 chain 截斷在「每 cycle S 步」的 stage grid 上,回傳 PD 輸入端誤差。 */
function runStage(
  nDiv: number,
  nCycles: number,
  s: number,
  quant: Quantizer,
  ditherLsb: number,
): StageRun {
  const a = aIdeal(nCycles, nDiv); // A_ideal = 256 · s_ideal(§4)
  const scale = s / 256; // 2 的冪 → 縮放不引入捨入
  const q = makeQuantizer(quant); // 每次 run 都是 fresh state(§6)
  const dither = ditherLsb > 0 ? makeStream('dither_fb') : null;
  const v = new Float64Array(nCycles);
  const y = new Float64Array(nCycles);
  const err = new Float64Array(nCycles);
  const raw = new Float64Array(nCycles);
  const state = new Float64Array(nCycles);
  let folds = 0;
  for (let k = 0; k < nCycles; k++) {
    v[k] = a[k] * scale;
    let u = v[k];
    if (dither !== null) u += triangularDither(ditherLsb, dither);
    y[k] = q.quantize(u);
    state[k] = q.state;
    raw[k] = (y[k] - v[k]) / s;
    err[k] = wrapCycles(raw[k]);
    if (Math.abs(raw[k]) >= 0.5) folds += 1;
  }
  return { v, y, err, raw, state, folds };
}

/** stage code → 全鏈 decode(§4):A = y·(256/S) → I/R/m/c 與 n_int。 */
function decodeStage(y: Float64Array, s: number) {
  const mult = 256 / s;
  const n = y.length;
  const iFb = new Float64Array(n);
  const rFb = new Float64Array(n);
  const mFb = new Float64Array(n);
  const cFb = new Float64Array(n);
  const nInt = new Float64Array(n); // 最後一拍無定義 → NaN
  for (let k = 0; k < n; k++) {
    const aFull = y[k] * mult;
    iFb[k] = Math.floor(aFull / 256);
    rFb[k] = pymod(aFull, 256);
    mFb[k] = Math.floor(rFb[k] / 64);
    cFb[k] = pymod(rFb[k], 64);
  }
  for (let k = 0; k < n - 1; k++) nInt[k] = iFb[k + 1] - iFb[k];
  nInt[n - 1] = NaN;
  return { iFb, rFb, mFb, cFb, nInt };
}

/* ------------------------------------------------------------------ */
/* 數學 helpers(層一公式 + 頻譜檢查)                                 */
/* ------------------------------------------------------------------ */

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

/** 連分數近似 α ≈ p/q(q ≤ qMax、|α − p/q| < tol),找不到回傳 null。 */
function ratApprox(x: number, qMax = 1024, tol = 1e-9): { p: number; q: number } | null {
  let p0 = 0;
  let q0 = 1;
  let p1 = 1;
  let q1 = 0;
  let a = x;
  for (let i = 0; i < 64; i++) {
    const ai = Math.floor(a);
    const p2 = ai * p1 + p0;
    const q2 = ai * q1 + q0;
    if (q2 > qMax) break;
    p0 = p1;
    q0 = q1;
    p1 = p2;
    q1 = q2;
    if (q1 > 0 && Math.abs(x - p1 / q1) < tol) return { p: p1, q: q1 };
    const fr = a - ai;
    if (fr < 1e-15) break;
    a = 1 / fr;
  }
  return null;
}

/** 序列的最小週期(容差比較;float64 準週期用)。 */
function findPeriod(e: Float64Array, maxP = 256, tol = 1e-9): number | null {
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

function maxAbs(x: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > m) m = a;
  }
  return m;
}

function meanSquare(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return s / x.length;
}

/** in-band rms = sqrt(Σ S·df),f ∈ (0, fHi](排除 DC bin)。 */
function inbandRms(freqs: Float64Array, psd: Float64Array, fHi: number): number {
  const df = freqs[1] - freqs[0];
  let s = 0;
  for (let i = 1; i < freqs.length; i++) {
    if (freqs[i] <= fHi) s += psd[i];
  }
  return Math.sqrt(s * df);
}

/** 最小平方直線 fit:回傳 slope 與 R²。 */
function fitLine(xs: number[], ys: number[]): { slope: number; r2: number } {
  const n = xs.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  let ssRes = 0;
  let ssTot = 0;
  const my = sy / n;
  for (let i = 0; i < n; i++) {
    const yh = slope * xs[i] + intercept;
    ssRes += (ys[i] - yh) * (ys[i] - yh);
    ssTot += (ys[i] - my) * (ys[i] - my);
  }
  return { slope, r2: ssTot > 0 ? 1 - ssRes / ssTot : 1 };
}

/**
 * Shaping-order 檢查:err 對其 n 重(去 mean)累加的 PSD 比值
 * = |2 sin(πf/f_ref)|^{2n} [EXACT 恆等式,windowing 為近似],
 * 在 [f_ref/64, f_ref/6.4] 內 fit 斜率 → 期望 ≈ +20n dB/dec。
 */
function fitSlopeRatio(rawErr: Float64Array, order: number): { slope: number; r2: number } {
  let x = Float64Array.from(rawErr);
  for (let o = 0; o < order; o++) {
    const mu = mean(x);
    let acc = 0;
    const next = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) {
      acc += x[i] - mu;
      next[i] = acc;
    }
    x = next;
  }
  const pe = periodogramPsd(rawErr, F_REF);
  const pi = periodogramPsd(x, F_REF);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 1; i < pe.freqsHz.length; i++) {
    const f = pe.freqsHz[i];
    if (f >= F_REF / 64 && f <= F_REF / 6.4 && pe.psd[i] > 0 && pi.psd[i] > 0) {
      xs.push(Math.log10(f));
      ys.push(10 * Math.log10(pe.psd[i] / pi.psd[i]));
    }
  }
  return fitLine(xs, ys);
}

/**
 * tone-bin 集中度:DC/Nyquist 鄰域 + (spur ±1 bins) 的功率占比。
 * detectSpurs 只掃內點,P = 2 之類「tone 恰在 Nyquist」的情況由固定納入的
 * 末兩 bin 涵蓋(python 驗證:無 dither、P ≤ 128 時 preset 0.987–1.000、
 * slider 掃描 ≥ 0.94;PMUX/DTC 級 dither 0.5 → 0.003–0.090)。
 */
function combConcentration(freqs: Float64Array, psd: Float64Array): number {
  let tot = 0;
  for (let i = 0; i < psd.length; i++) tot += psd[i];
  if (tot <= 0) return NaN;
  const spurs = detectSpurs(freqs, psd, 10);
  const df = freqs[1] - freqs[0];
  const idx = new Set<number>([0, 1, psd.length - 1, psd.length - 2]);
  for (const sp of spurs) {
    const i = Math.round(sp.freqHz / df);
    for (const j of [i - 1, i, i + 1]) {
      if (j >= 0 && j < psd.length) idx.add(j);
    }
  }
  let p = 0;
  for (const i of idx) p += psd[i];
  return p / tot;
}

function toXY(ys: ArrayLike<number>, count?: number): [number, number][] {
  const n = count === undefined ? ys.length : Math.min(count, ys.length);
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) out.push([k, ys[k]]);
  return out;
}

interface CheckRow {
  name: string;
  status: 'pass' | 'fail' | 'na';
  detail: string;
  tolerance: string;
}

/* ------------------------------------------------------------------ */
/* SectionCode 引用字串(與上方真實碼逐字同步)                        */
/* ------------------------------------------------------------------ */

const STAGE_HELPER_SRC = `/** 把 chain 截斷在「每 cycle S 步」的 stage grid 上,回傳 PD 輸入端誤差。 */
function runStage(nDiv, nCycles, s, quant, ditherLsb): StageRun {
  const a = aIdeal(nCycles, nDiv);      // A_ideal = 256 · s_ideal(§4)
  const scale = s / 256;                // 2 的冪 → 縮放不引入捨入
  const q = makeQuantizer(quant);       // 每次 run 都是 fresh state(§6)
  const dither = ditherLsb > 0 ? makeStream('dither_fb') : null;
  ...
  for (let k = 0; k < nCycles; k++) {
    v[k] = a[k] * scale;                // ideal code(stage-LSB 單位)
    let u = v[k];
    if (dither !== null) u += triangularDither(ditherLsb, dither);
    y[k] = q.quantize(u);               // 整數 code —— 這就是 actuator 全部自由度
    state[k] = q.state;
    raw[k] = (y[k] - v[k]) / s;         // 未 wrap 誤差(cycles)
    err[k] = wrapCycles(raw[k]);        // e_PD:PD 看到的 wrap 後誤差
    if (Math.abs(raw[k]) >= 0.5) folds += 1;   // wrap 摺疊計數
  }
  return { v, y, err, raw, state, folds };
}`;

const EF1_SRC = `export class ErrorFeedbackFirstOrder implements QuantizerState {
  private e = 0.0;
  quantize(u: number): number {
    const v = u + this.e;   // 把上一拍殘量加回本拍
    const y = Math.floor(v);
    this.e = v - y;         // e ∈ [0, 1):唯一的記憶
    return y;
  }
  get state(): number { return this.e; }
}`;

/* ================================================================== */

export default function Chapter21() {
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const [nDiv, setNDiv] = useChapterNDiv();
  const [stageKey, setStageKey] = useState<StageKey>('dtc');
  const [quant, setQuant] = useState<Quantizer>('nearest');
  const [dither, setDither] = useState(0);
  const [nCyc, setNCyc] = useState(256);
  const [logX, setLogX] = useState(false);

  const stage = STAGE_DEFS.find((s) => s.key === stageKey)!;
  const tVco = 1 / (F_REF * nDiv); // display only
  const alpha = nDiv - 3;
  /** 診斷 N*:微擾成長週期 rational(N > 3.2 改為減,避免逼近 3.25 上界)。 */
  const nDiag = nDiv <= 3.2 ? nDiv + DIAG_DELTA : nDiv - DIAG_DELTA;

  /* -------------------------------------------------- Layer 1: 公式表 */
  const layer1 = useMemo(() => {
    const rows: {
      n: number;
      frac: string;
      stage: string;
      s: number;
      pPred: number | null;
      pMeas: number | null;
      peakPredCyc: number | null;
      peakMeasCyc: number;
      peakFs: number;
      f0Mhz: number | null;
      exact: boolean;
    }[] = [];
    for (const n of N_DIV_PRESETS) {
      const fr = ratApprox(n - 3);
      for (const sd of STAGE_DEFS) {
        const run = runStage(n, 512, sd.s, 'nearest', 0);
        const pPred = fr ? fr.q / gcd(fr.q, sd.s) : null;
        const peakPredCyc = pPred !== null ? Math.floor(pPred / 2) / pPred / sd.s : null;
        const peakMeasCyc = maxAbs(run.err);
        rows.push({
          n,
          frac: fr ? (fr.p === 0 ? '0' : `${fr.p}/${fr.q}`) : '—',
          stage: sd.short,
          s: sd.s,
          pPred,
          pMeas: findPeriod(run.err),
          peakPredCyc,
          peakMeasCyc,
          peakFs: peakMeasCyc * (1 / (F_REF * n)),
          f0Mhz: pPred !== null ? F_REF / pPred / 1e6 : null,
          exact: peakMeasCyc === 0,
        });
      }
    }
    return rows;
  }, []);

  /* ------------------------------------- Layer 2: 逐級暫態(互動模擬) */
  const transient = useMemo(() => {
    const runs = STAGE_DEFS.map((sd) => runStage(nDiv, nCyc, sd.s, quant, dither));
    const decoded = STAGE_DEFS.map((sd, i) => decodeStage(runs[i].y, sd.s));
    return { runs, decoded };
  }, [nDiv, nCyc, quant, dither]);

  /** stage × quantizer 峰值/rms 矩陣(512 cycles,無 dither)。 */
  const matrix = useMemo(() => {
    const quants: Quantizer[] = ['nearest', 'ef1', 'mash11', 'mash111'];
    return STAGE_DEFS.map((sd) => ({
      stage: sd,
      cells: quants.map((qn) => {
        const r = runStage(nDiv, 512, sd.s, qn, 0);
        const nIntSet = new Set<number>();
        const dec = decodeStage(r.y, sd.s);
        for (let k = 0; k < r.y.length - 1; k++) nIntSet.add(dec.nInt[k]);
        return {
          quant: qn,
          peakCyc: maxAbs(r.err),
          peakRawCyc: maxAbs(r.raw),
          rmsCyc: rms(r.err),
          folds: r.folds,
          nInt: `{${[...nIntSet].sort((a, b) => a - b).join(',')}}`,
        };
      }),
    }));
  }, [nDiv]);

  /** SectionExample:ef1 @ PMUX grid、N=3.13 固定,手動 step 前 25 拍。 */
  const startup = useMemo(() => {
    const a = aIdeal(25, 3.13);
    const q = new ErrorFeedbackFirstOrder();
    const rows: { k: number; v: number; eIn: number; sum: number; y: number; eOut: number; errCyc: number }[] = [];
    for (let k = 0; k < 25; k++) {
      const v = a[k] * (4 / 256);
      const eIn = q.state;
      const y = q.quantize(v);
      rows.push({ k, v, eIn, sum: v + eIn, y, eOut: q.state, errCyc: (y - v) / 4 });
    }
    return rows;
  }, []);

  /* ------------------------------ Layer 3: in-band 有效解析度(N 與 N*) */
  const layer3 = useMemo(() => {
    const quants: Quantizer[] = ['nearest', 'ef1', 'mash11', 'mash111'];
    const stages = [STAGE_DEFS[1], STAGE_DEFS[2]]; // PMUX / DTC
    const table = stages.map((sd) => {
      const rows = quants.map((qn) => {
        const rExact = runStage(nDiv, NC_PSD, sd.s, qn, 0);
        const rDiag = runStage(nDiag, NC_PSD, sd.s, qn, 0);
        const pE = periodogramPsd(rExact.err, F_REF);
        const pD = periodogramPsd(rDiag.err, F_REF);
        return {
          quant: qn,
          ibExact: inbandRms(pE.freqsHz, pE.psd, F_BAND),
          ibDiag: inbandRms(pD.freqsHz, pD.psd, F_BAND),
          totDiag: rms(rDiag.err),
          peakDiag: maxAbs(rDiag.err),
          folds: rDiag.folds,
        };
      });
      const ibNearest = rows[0].ibDiag;
      return {
        stage: sd,
        rows: rows.map((r) => ({
          ...r,
          bits: r.ibDiag > 0 && r.quant !== 'nearest' ? Math.log2(ibNearest / r.ibDiag) : null,
        })),
      };
    });
    // N* @ DTC 的 PSD 比較圖(nearest vs 選定 quantizer)
    const rN = runStage(nDiag, NC_PSD, 256, 'nearest', 0);
    const rQ = runStage(nDiag, NC_PSD, 256, quant, 0);
    const pN = periodogramPsd(rN.err, F_REF);
    const pQ = periodogramPsd(rQ.err, F_REF);
    const mk = (p: { freqsHz: Float64Array; psd: Float64Array }): [number, number][] => {
      const pts: [number, number][] = [];
      for (let i = 1; i < p.freqsHz.length; i++) {
        pts.push([p.freqsHz[i] / 1e6, 10 * Math.log10(Math.max(p.psd[i], 1e-30))]);
      }
      return pts;
    };
    return { table, psdN: mk(pN), psdQ: mk(pQ) };
  }, [nDiv, nDiag, quant]);

  /* --------------------------- Layer 4: 每級頻譜 + sanity 檢查(1024) */
  const spectrum = useMemo(() => {
    const runSel = runStage(nDiv, NC_PSD, stage.s, quant, dither);
    const runNearestClean = runStage(nDiv, NC_PSD, stage.s, 'nearest', 0);
    const runNearestDith =
      dither > 0 ? runStage(nDiv, NC_PSD, stage.s, 'nearest', dither) : runNearestClean;
    const pSel = periodogramPsd(runSel.err, F_REF);
    const pNc = periodogramPsd(runNearestClean.err, F_REF);
    const pNd = dither > 0 ? periodogramPsd(runNearestDith.err, F_REF) : pNc;
    const mk = (p: { freqsHz: Float64Array; psd: Float64Array }): [number, number][] => {
      const pts: [number, number][] = [];
      for (let i = 1; i < p.freqsHz.length; i++) {
        pts.push([p.freqsHz[i] / 1e6, 10 * Math.log10(Math.max(p.psd[i], 1e-30))]);
      }
      return pts;
    };
    const spurs = detectSpurs(pSel.freqsHz, pSel.psd, 10).slice(0, 5);

    /* --- sanity checklist --- */
    const checks: CheckRow[] = [];
    const df = F_REF / NC_PSD;
    const fr = ratApprox(alpha);
    /** nearest 誤差的週期 P = q/gcd(q,G);null = 非短週期 rational。 */
    const pShort = fr === null ? null : fr.q / gcd(fr.q, stage.s);
    const totalNearest = meanSquare(runNearestClean.err);

    // (1) spur spacing = f_ref / P
    if (fr === null) {
      checks.push({
        name: '1. spur 間距 = f_ref/P',
        status: 'na',
        detail: `α = ${trimNumber(alpha, 6)} 非短週期 rational(q ≤ 1024 內無 1e-9 近似)→ 無 P 預測`,
        tolerance: '|Δf| ≤ 1 bin = 3.906 MHz',
      });
    } else {
      const p = fr.q / gcd(fr.q, stage.s);
      if (totalNearest < 1e-22 || p === 1) {
        checks.push({
          name: '1. spur 間距 = f_ref/P',
          status: 'pass',
          detail: `on-grid exact(α·${stage.s} 為整數)→ 誤差 ≡ 0,無 spur(P = ${p})`,
          tolerance: '|Δf| ≤ 1 bin = 3.906 MHz',
        });
      } else if (p === 2) {
        // 交錯 pattern:tone 恰在 Nyquist,detectSpurs(內點)掃不到
        let iMax = 1;
        for (let i = 2; i < pNc.psd.length; i++) if (pNc.psd[i] > pNc.psd[iMax]) iMax = i;
        const atNyq = iMax === pNc.psd.length - 1;
        checks.push({
          name: '1. spur 間距 = f_ref/P',
          status: atNyq ? 'pass' : 'fail',
          detail: `P = 2 → tone 在 f_ref/2 = 2 GHz(Nyquist bin);最大非 DC bin ${atNyq ? '就在' : '不在'} Nyquist`,
          tolerance: 'argmax(非 DC bin) = Nyquist bin',
        });
      } else if (p > NC_PSD / 2) {
        checks.push({
          name: '1. spur 間距 = f_ref/P',
          status: 'na',
          detail: `P = ${p} → comb 間距 f_ref/P = ${trimNumber(F_REF / p / 1e6, 4)} MHz < 2 bins,${NC_PSD} 點頻譜解析不出格點`,
          tolerance: '需 f_ref/P ≥ 2 bins = 7.81 MHz',
        });
      } else {
        const spAll = detectSpurs(pNc.freqsHz, pNc.psd, 10);
        const top = spAll.length > 0 ? spAll[0].psdDb : -Infinity;
        const strong = spAll.filter((s0) => s0.psdDb >= top - 30);
        const fPred = F_REF / p;
        const offGrid = strong.filter((s0) => {
          const mHarm = Math.round(s0.freqHz / fPred);
          return mHarm < 1 || Math.abs(s0.freqHz - mHarm * fPred) > df + 1e-6;
        });
        const ok = strong.length > 0 && offGrid.length === 0;
        checks.push({
          name: '1. spur 間距 = f_ref/P',
          status: ok ? 'pass' : 'fail',
          detail: `預測 comb 間距 f_ref/${p} = ${trimNumber(fPred / 1e6, 5)} MHz;偵測(nearest、30 dB 窗)${strong.length} 根 strong spur、off-grid ${offGrid.length} 根${
            strong.length > 0
              ? `;最低 ${trimNumber(Math.min(...strong.map((s0) => s0.freqHz)) / 1e6, 5)} MHz`
              : ''
          }`,
          tolerance: '每根 strong spur 距 m·f_ref/P ≤ 1 bin = 3.906 MHz',
        });
      }
    }

    // (2) shaping slope(對 DSM;以 N* 診斷序列的未 wrap 誤差計算)
    const order = DSM_ORDER[quant];
    if (order === 0) {
      checks.push({
        name: '2. shaping 斜率 ≈ +20n dB/dec',
        status: 'na',
        detail: 'nearest 無 shaping(order 0)→ 不適用;選 ef1/mash11/mash111 觀察',
        tolerance: '|slope − 20n| ≤ 4 dB/dec',
      });
    } else {
      const diagRaw = runStage(nDiag, NC_PSD, stage.s, quant, 0).raw;
      const fit = fitSlopeRatio(diagRaw, order);
      const ok = Math.abs(fit.slope - 20 * order) <= 4;
      checks.push({
        name: '2. shaping 斜率 ≈ +20n dB/dec',
        status: ok ? 'pass' : 'fail',
        detail: `order ${order}:fit ${trimNumber(fit.slope, 4)} dB/dec(R² ${trimNumber(fit.r2, 3)});期望 +${20 * order}(含 sin 曲率的理論 fit ≈ +${trimNumber([19.6, 39.3, 58.9][order - 1], 3)});診斷序列 N* = ${trimNumber(nDiag, 8)}(未 wrap)`,
        tolerance: '|slope − 20n| ≤ 4 dB/dec,band [62.5, 625] MHz',
      });
    }

    // (3) Parseval:Σ S·df ≈ mean(e²)。只對「窗內成立週期性」(P ≤ 128)或
    // 有效 dither(G > 1)的序列檢查;窗內非週期的慢 tonal 序列(P > 128 無
    // dither)窗-tone 交互可把比值推到 1.9(python 掃 slider N 實測)。
    const msSel = meanSquare(runSel.err);
    const parsevalApplicable =
      (dither > 0 && stage.s > 1) || (pShort !== null && pShort <= 128);
    if (msSel < 1e-22) {
      checks.push({
        name: '3. Parseval:Σ S·df ≈ mean(e²)',
        status: 'pass',
        detail: '誤差 ≡ 0(exact)→ 兩側皆 0',
        tolerance: 'ratio ∈ [0.8, 1.2]',
      });
    } else if (!parsevalApplicable) {
      checks.push({
        name: '3. Parseval:Σ S·df ≈ mean(e²)',
        status: 'na',
        detail: `α ${pShort === null ? '非短週期 rational' : `週期 P = ${pShort} > 128`} 且無有效 dither → 窗內非週期的慢 tonal 序列,Hann 窗-tone 交互使比值失準(python 實測可達 1.9)`,
        tolerance: 'ratio ∈ [0.8, 1.2]',
      });
    } else {
      let sum = 0;
      for (let i = 0; i < pSel.psd.length; i++) sum += pSel.psd[i];
      const ratio = (sum * df) / msSel;
      checks.push({
        name: '3. Parseval:Σ S·df ≈ mean(e²)',
        status: ratio >= 0.8 && ratio <= 1.2 ? 'pass' : 'fail',
        detail: `Σ S·df = ${trimNumber(sum * df, 4)},mean(e²) = ${trimNumber(msSel, 4)},ratio = ${trimNumber(ratio, 4)}(U = mean(w²) 歸一化保證白噪積分回 variance;tonal 訊號與窗的交互造成偏差)`,
        tolerance: 'ratio ∈ [0.8, 1.2](python:preset 67 組 0.865–1.101;slider 掃 P ≤ 128 為 0.967–1.021、dither 組 0.814–1.151)',
      });
    }

    // (4) DC bin ↔ 時域 mean(static offset)。DC bin 精確等於「Hann 加權平均」;
    // 它與樣本平均對帳需要序列在窗內近似週期(P ≤ 128)且無 dither(dither 的
    // 隨機成分使兩種平均統計性分離,~rms/√N 位階)。
    const muT = Math.abs(mean(runSel.err));
    if (dither > 0 || pShort === null || pShort > 128) {
      checks.push({
        name: '4. DC bin ↔ 時域 mean',
        status: 'na',
        detail:
          dither > 0
            ? 'dither 的隨機成分使窗權重平均與樣本平均統計性分離(~rms/√N 位階)→ 不適用'
            : `α ${pShort === null ? '非短週期 rational' : `週期 P = ${pShort} > 128`} → 最低 tone 洩漏進 DC bin → 不適用`,
        tolerance: '|Δ| ≤ max(2×10⁻⁴, 10%, peak·P/N)',
      });
    } else {
      const muPsd = 2 * Math.sqrt((pSel.psd[0] * F_REF * HANN_U) / NC_PSD);
      const tolMu = Math.max(2e-4, 0.1 * muT, (maxAbs(runSel.err) * pShort) / NC_PSD);
      checks.push({
        name: '4. DC bin ↔ 時域 mean',
        status: Math.abs(muPsd - muT) <= tolMu ? 'pass' : 'fail',
        detail: `|mean| 時域 = ${trimNumber(muT, 4)} cyc;由 DC bin 反推 2·√(S₀·f_ref·U/N) = ${trimNumber(muPsd, 4)} cyc`,
        tolerance: '|Δ| ≤ max(2×10⁻⁴, 10%, peak·P/N)(P 不整除窗長 → 部分週期殘量)',
      });
    }

    // (5) nearest = pure tone comb;dither ≥ 0.5(G > 1)→ floor。
    // divider 級(G = 1)y±1 經 wrap 後不可見 → dither 無效,仍期望 comb;
    // 0 < dither < 0.5 是轉換區(python 實測集中度 0.27–0.99)→ 無二元預測;
    // comb 預測需要短週期 rational α(P ≤ 128),否則 tone 結構無預測。
    if (meanSquare(runNearestDith.err) < 1e-22) {
      checks.push({
        name: '5. nearest comb ↔ dither floor',
        status: 'na',
        detail: '誤差 ≡ 0(exact)→ 無頻譜內容',
        tolerance: 'comb ≥ 0.9;floor ≤ 0.5',
      });
    } else if (dither > 0 && dither < 0.5 && stage.s > 1) {
      checks.push({
        name: '5. nearest comb ↔ dither floor',
        status: 'na',
        detail: `dither ${trimNumber(dither, 3)} LSB ∈ (0, 0.5):comb 未完全攤平的轉換區(python 實測集中度 0.27–0.99)→ 無二元預測`,
        tolerance: 'comb ≥ 0.9;floor ≤ 0.5',
      });
    } else {
      const expectComb = dither === 0 || stage.s === 1;
      if (expectComb && (pShort === null || pShort > 128)) {
        checks.push({
          name: '5. nearest comb ↔ dither floor',
          status: 'na',
          detail: `α ${pShort === null ? '非短週期 rational' : `週期 P = ${pShort} > 128`} → comb 結構無預測`,
          tolerance: 'comb ≥ 0.9;floor ≤ 0.5',
        });
      } else {
        const conc = combConcentration(pNd.freqsHz, pNd.psd);
        const ok = expectComb ? conc >= 0.9 : conc <= 0.5;
        checks.push({
          name: '5. nearest comb ↔ dither floor',
          status: ok ? 'pass' : 'fail',
          detail: `tone-bin 集中度 = ${trimNumber(conc, 4)}(nearest${dither > 0 ? ` + dither ${trimNumber(dither, 3)} LSB` : ''})${
            stage.s === 1 && dither > 0 ? ';divider 級 y±1 wrap 後不可見 → dither 無效' : ''
          };${expectComb ? '期望純 comb(≥ 0.9)' : 'dither ≥ 0.5 → 期望 tone 攤成 floor(≤ 0.5)'}`,
          tolerance: 'comb ≥ 0.9(preset 實測 0.987–1.000;slider P ≤ 128 掃描 ≥ 0.94);floor ≤ 0.5(dither 0.5 實測 0.003–0.090)',
        });
      }
    }

    return { pts: { sel: mk(pSel), nearest: mk(pNc) }, spurs, checks, folds: runSel.folds };
  }, [nDiv, nDiag, stage, quant, dither, alpha]);

  useEffect(() => {
    setStatus(
      'done',
      `Ch21:transient ${nCyc}×3、matrix 512×12、PSD ${NC_PSD}×~12(${stage.short}, ${quant})`,
    );
  }, [transient, matrix, layer3, spectrum, setStatus, nCyc, stage, quant]);

  /* ------------------------------------------------------------ 圖表 */
  const stairOption = useMemo(() => {
    const nShow = Math.min(40, nCyc);
    const ideal: [number, number][] = [];
    for (let k = 0; k < nShow; k++) {
      ideal.push([k, transient.runs[2].v[k] / 256 - 3 * k]);
    }
    const mkStage = (i: number): [number, number][] => {
      const pts: [number, number][] = [];
      for (let k = 0; k < nShow; k++) {
        pts.push([k, transient.runs[i].y[k] / STAGE_DEFS[i].s - 3 * k]);
      }
      return pts;
    };
    return makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: 'edge 位置 − 3k (cycles)',
      series: [
        { name: 'ideal(斜率 α)', data: ideal, showSymbol: false, color: ct.textSubtle, width: 2.2 },
        { name: 'divider(grid 1)', data: mkStage(0), step: 'middle', showSymbol: false, color: ct.series[4] },
        { name: '+PMUX(grid 1/4)', data: mkStage(1), step: 'middle', showSymbol: false, color: ct.warn },
        { name: '+DTC(grid 1/256)', data: mkStage(2), step: 'middle', showSymbol: false, color: ct.accent },
      ],
    });
  }, [transient, nCyc, ct]);

  const errOption = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: phaseAxisLabel('e_PD', unit, tVco),
        yTickFormatter: makePhaseTickFormatter(unit, tVco),
        series: [
          {
            name: 'divider only',
            data: toXY(transient.runs[0].err),
            step: 'middle',
            showSymbol: false,
            color: ct.series[4],
          },
          {
            name: '+PMUX',
            data: toXY(transient.runs[1].err),
            step: 'middle',
            showSymbol: false,
            color: ct.warn,
          },
          {
            name: '+DTC',
            data: toXY(transient.runs[2].err),
            step: 'middle',
            showSymbol: false,
            color: ct.accent,
            width: 2,
          },
        ],
      }),
    [transient, unit, tVco, ct],
  );

  const stageIdx = STAGE_DEFS.findIndex((s) => s.key === stageKey);
  const codeOption = useMemo(() => {
    const dec = transient.decoded[stageIdx];
    const nShow = Math.min(96, nCyc);
    return makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: 'code value',
      series: [
        { name: 'n_int', data: toXY(dec.nInt, nShow - 1), step: 'middle', showSymbol: false, color: ct.accent, width: 2 },
        { name: 'm_FB', data: toXY(dec.mFb, nShow), step: 'middle', showSymbol: false, color: ct.warn },
        { name: 'c_FB', data: toXY(dec.cFb, nShow), step: 'middle', showSymbol: false, color: ct.series[2] },
      ],
    });
  }, [transient, stageIdx, nCyc, ct]);

  const stateOption = useMemo(() => {
    const r = transient.runs[stageIdx];
    const nShow = Math.min(96, nCyc);
    const errLsb: [number, number][] = [];
    for (let k = 0; k < nShow; k++) errLsb.push([k, r.raw[k] * stage.s]);
    return makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: 'stage-LSB / state',
      series: [
        { name: 'quantizer state e[k]', data: toXY(r.state, nShow), step: 'middle', showSymbol: false, color: ct.accent },
        { name: '誤差 y−v(stage-LSB,未 wrap)', data: errLsb, step: 'middle', showSymbol: false, color: ct.bad },
      ],
      extra: { markLine: undefined },
    });
  }, [transient, stageIdx, stage, nCyc, ct]);

  const psdL3Option = useMemo(
    () =>
      makeLineOption({
        xLabel: 'frequency (MHz) — sample rate = f_ref = 4 GHz',
        yLabel: '10·log₁₀ S_e (dB re cycle²/Hz)',
        series: [
          { name: 'nearest @ N*', data: layer3.psdN, showSymbol: false, color: ct.textSubtle },
          { name: `${quant} @ N*`, data: layer3.psdQ, showSymbol: false, color: ct.accent, width: 2 },
        ],
        extra: {
          xAxis: { ...baseAxis(ct, 'frequency (MHz, log) — f_ref = 4 GHz'), type: 'log', min: F_REF / NC_PSD / 1e6 },
          markLine: undefined,
        },
      }),
    [layer3, quant, ct],
  );

  const psdOption = useMemo(() => {
    const opt = makeLineOption({
      xLabel: 'frequency (MHz) — sample rate = f_ref = 4 GHz',
      yLabel: '10·log₁₀ S_e (dB re cycle²/Hz)',
      series: [
        { name: 'nearest baseline', data: spectrum.pts.nearest, showSymbol: false, color: ct.textSubtle },
        {
          name: `${quant}${dither > 0 ? ' + dither' : ''}`,
          data: spectrum.pts.sel,
          showSymbol: false,
          color: ct.accent,
          width: 2,
        },
      ],
      extra: logX
        ? {
            xAxis: {
              ...baseAxis(ct, 'frequency (MHz, log) — f_ref = 4 GHz'),
              type: 'log',
              min: F_REF / NC_PSD / 1e6,
            },
          }
        : { markLine: makeMarkLine([{ x: F_BAND / 1e6, label: 'f_ref/64', color: ct.warn }]) },
    });
    return opt;
  }, [spectrum, quant, dither, logX, ct]);

  /* ------------------------------------------------- debug table rows */
  const debugRows = useMemo(() => {
    const rows: Record<string, unknown>[] = [];
    const [rD, rP, rT] = transient.runs;
    const dec = transient.decoded[2];
    for (let k = 0; k < nCyc; k++) {
      rows.push({
        k,
        s_ideal: rT.v[k] / 256,
        v_div: rD.v[k],
        y_div: rD.y[k],
        e_div_cyc: rD.err[k],
        v_pmux: rP.v[k],
        y_pmux: rP.y[k],
        e_pmux_cyc: rP.err[k],
        v_dtc: rT.v[k],
        y_dtc: rT.y[k],
        e_dtc_cyc: rT.err[k],
        n_int_dtc: dec.nInt[k],
        m_FB_dtc: dec.mFb[k],
        c_FB_dtc: dec.cFb[k],
        dsm_state_dtc: rT.state[k],
      });
    }
    return rows;
  }, [transient, nCyc]);

  const badge = (status: CheckRow['status']): ReactNode => {
    const color = status === 'pass' ? ct.good : status === 'fail' ? ct.bad : ct.textSubtle;
    const text = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'N/A';
    return (
      <span
        style={{
          color,
          border: '1px solid currentColor',
          borderRadius: 4,
          padding: '0 6px',
          fontSize: 12,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        {text}
      </span>
    );
  };

  const fmtCyc = (v: number, sig = 4): string => trimNumber(v, sig);

  /* ================================================================ */
  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            PD 到底在比什麼?feedback chain「/3-/4 → PMUX → DTC」每加一級,PD 輸入端的
            phase error 從哪個公式、縮小多少倍?<EpistemicTag kind="EXACT" />
          </li>
          <li>
            為什麼 fractional N = 3 + α 在「只有整數 divider」時必然產生 ±0.5 cycle 的鋸齒?
            公式 P = q/gcd(q, G) 與 peak = (⌊P/2⌋/P)·Δ 怎麼推出來、五個 preset N 全部驗證?
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            逐級暫態長什麼樣子:n_int、m_FB、c_FB、DSM 內部 state 每一拍怎麼動?DSM 的
            startup transient 在哪裡?<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            DSM 到底「買」到什麼:per-edge 誤差沒變細(峰值反而變大),那有效解析度從哪來?
            in-band 剩多少 error?<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            每一級的頻譜怎麼驗證是「可信的」:spur 間距、shaping 斜率、Parseval、DC bin、
            comb vs floor 五項 sanity check 全部即時重算。<EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          PD 每一拍只做一件事:比較第 k 個 reference edge(t = k·T_ref)與 feedback chain
          送回來的那個 edge。理想上 feedback edge 應該落在 s_ideal[k] = k·N 個 VCO cycle 的
          位置;實際上它只能落在 actuator <b>格點</b>上。這一章把 chain 拆成三段來看格點:
        </p>
        <p>
          <b>(a) 只有 /3-/4 divider</b>:divider 是計數器,输出 edge 只能貼在<b>整數</b> VCO
          cycle 邊界 —— 格距 Δ = T_vco(N = 3.13 時 79.87 ps)。α 是分數,每拍欠 α 個 cycle,
          債務累積到超過半格就換捨入方向 —— 鋸齒誤差,峰值 ±0.5 cycle。
          <b>(b) 加 4-to-1 PMUX</b>:VCO 的 4 個 quarter phase 可選,格距縮成 T_vco/4 ——
          誤差立刻縮 4 倍(±1/8 cycle)。<b>(c) 加 6-bit DTC</b>:把 T_vco/4 再切 64 步,
          格距 T_vco/256 —— 峰值 ≤ half-LSB(12.5 GHz 時 156.25 fs)。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>
          直覺畫面:一把只有公分刻度的尺,量 3.13 cm 的東西每次都差幾 mm;換上 2.5 mm
          刻度(÷4)、再換上 39 µm 游標(再 ÷64),<b>殘差永遠存在,只是縮小</b>。而 DSM 是另一件事:它不改變刻度,
          只是「這拍多讀一格、下拍少讀一格」,讓<b>平均</b>讀數變準 —— 這正是 Layer 3 要
          量化的 trade-off。
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>
          <b>(1) PD 輸入端誤差的定義。</b>第 k 拍 feedback edge 的絕對位置是
          s_FB_actual[k](cycles),PD 輸入端 phase error 定義為:
        </p>
        <MathBlock>
          {'e_{PD}[k] = \\operatorname{wrapCycles}\\bigl(s_{FB,actual}[k] - s_{ideal}[k]\\bigr)\\quad[\\text{cycles}],\\qquad e_{PD}^{(t)}[k] = e_{PD}[k]\\cdot T_{vco}\\;[\\text{s}]'}
        </MathBlock>
        <p>
          當 chain 完整(divider+PMUX+DTC、S = 256)時,這<b>就是</b> MODEL_SPEC §4 的{' '}
          <M>{'e_{FB,abs}'}</M> —— 本章對四種 quantizer 逐拍驗證 stage-256 誤差與{' '}
          <code>simulate()</code> 的 e_FB_abs 最大差 = 0(python3,512 cycles)。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>
          <b>(2) stage grid。</b>把 chain 截斷在第 j 級,actuator 每個 VCO cycle 有 G 步
          (G ∈ {'{1, 4, 256}'}),格距 Δ = 1/G cycle。quantize 作用在 stage code 上:
        </p>
        <MathBlock>
          {'v[k] = G\\, s_{ideal}[k],\\qquad y[k] = Q\\bigl(v[k]\\bigr),\\qquad e_{PD}[k] = \\operatorname{wrapCycles}\\!\\Bigl(\\tfrac{y[k]-v[k]}{G}\\Bigr)'}
        </MathBlock>
        <p>
          nearest 時 <M>{'|y-v| \\le 1/2'}</M>,故 <M>{'|e_{PD}| \\le \\Delta/2 = 1/(2G)'}</M>{' '}
          cycle —— divider 0.5 cycle、PMUX 1/8 cycle、DTC 1/512 cycle(= half-LSB,12.5 GHz
          時 156.25 fs)。<EpistemicTag kind="EXACT" />
        </p>
        <p>
          <b>(3) 誤差序列的週期 P。</b>寫 α = p/q(最簡分數)。nearest 誤差只依賴{' '}
          <M>{'\\operatorname{frac}(G\\alpha k) = \\operatorname{frac}\\!\\bigl(\\tfrac{Gp}{q}k\\bigr)'}</M>。
          令 d = gcd(Gp, q) = gcd(G, q)(因 gcd(p,q)=1),序列{' '}
          <M>{'\\tfrac{Gp}{q}k \\bmod 1'}</M> 取值恰為 {'{m·d/q}'},且以
        </p>
        <MathBlock>{'P = \\frac{q}{\\gcd(q, G)}'}</MathBlock>
        <p>
          為最小週期(k → k+P 時 <M>{'\\tfrac{Gp}{q}P = \\tfrac{pq/d\\cdot G}{q}\\cdot\\tfrac{d}{G}'}</M>{' '}
          …整理後為整數,且 P 之內走遍全部 residue)。誤差取值為{' '}
          <M>{'\\{m/P\\}'}</M> 對最近整數的殘差,故實際峰值:
        </p>
        <MathBlock>
          {'\\text{peak} = \\frac{\\lfloor P/2\\rfloor}{P}\\cdot\\Delta \\;\\le\\; \\frac{\\Delta}{2},\\qquad f_{spur} = m\\cdot\\frac{f_{ref}}{P}'}
        </MathBlock>
        <p>
          P 為偶數時峰值恰為 Δ/2;P 為奇數時略小(N=3.13、P=25:0.48 Δ)。deterministic
          週期序列的全部功率都在 f_ref/P 的諧波上 —— 這是 Layer 4 檢查 (1) 的依據。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>
          <b>(4) DSM 誤差恆等式與 wrap 摺疊。</b>ef1(§6)的輸出滿足{' '}
          <M>{'y[k]-u[k] = e[k-1]-e[k]'}</M>,z-domain{' '}
          <M>{'Y-U = -(1-z^{-1})E'}</M>;mash11 / mash111 為{' '}
          <M>{'(1-z^{-1})^2 / (1-z^{-1})^3'}</M>。因此誤差對其 n 重(去 mean)累加的 PSD
          比值<b>恰為</b> <M>{'|2\\sin(\\pi f/f_{ref})|^{2n}'}</M> —— log-log 斜率 +20n
          dB/dec(檢查 (2) 用它 fit)。<EpistemicTag kind="EXACT" /> 但注意:shaping 把瞬時
          擺幅放大;一旦 <M>{'|y-v|/G \\ge 0.5'}</M> cycle,PD 只能看到 wrap 後的值 ——
          摺疊(aliasing)會毀掉 in-band 的 shaping 收益(Layer 3 的 mash111@PMUX 實例)。
          <EpistemicTag kind="EXPERIMENT" />
        </p>
        <p>
          <b>(5) loop 的角色(誠實聲明)。</b>本章是 open-loop:e_PD 是 PD 輸入端的
          scheduler 誤差。閉環後,feedback path 的誤差經過 closed-loop <b>low-pass</b>{' '}
          傳到輸出(與 reference noise 同路徑);VCO 自身 noise 則被 high-pass。所以
          「loop 看得到的」是 e_PD 在 loop bandwidth 之內的功率 —— 本章用 f {'<'} f_ref/64
          = 62.5 MHz 作 proxy band,實際頻寬依 loop 設計而定。
          <EpistemicTag kind="ASSUMPTION" />
        </p>
      </SectionMath>

      <SectionExample>
        <p>
          <b>手算例:N = 3.13、ef1 @ PMUX grid(G = 4)的 startup 全表。</b>v[k] = 4·s_ideal[k]
          = 12.52k。ef1 fresh state e = 0(fresh instance,§6);每拍 v+e 取 floor,殘量存回
          state。前 3 拍手驗:k=1:v = 12.52,e_in = 0 → y = ⌊12.52⌋ = 12,e_out = 0.52,
          誤差 (12 − 12.52)/4 = <b>−0.13 cycle</b>;k=2:25.04 + 0.52 = 25.56 → y = 25,
          e_out = 0.56,誤差 −0.01;k=3:37.56 + 0.56 = 38.12 → y = 38(<b>進位拍</b>),
          e_out = 0.12,誤差 <b>+0.11</b>。峰值出現在 k=5(−0.15 cyc = −0.6 stage-LSB)與
          k=20(+0.15 cyc):<b>比 nearest 的 ±0.48 stage-LSB 更大</b>。下表 25 拍(= 誤差
          序列的數學週期)由 model 的 <code>ErrorFeedbackFirstOrder</code> 逐拍 step,與
          python3 golden model 逐位一致。<EpistemicTag kind="EXACT" />
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>k</th>
                <th>v = 12.52k</th>
                <th>e_in</th>
                <th>v + e</th>
                <th>y = ⌊v+e⌋</th>
                <th>e_out</th>
                <th>err (cycle)</th>
                <th>err (stage-LSB)</th>
              </tr>
            </thead>
            <tbody>
              {startup.map((r) => (
                <tr key={r.k}>
                  <td>{r.k}</td>
                  <td>{trimNumber(r.v, 6)}</td>
                  <td>{trimNumber(r.eIn, 4)}</td>
                  <td>{trimNumber(r.sum, 6)}</td>
                  <td>{r.y}</td>
                  <td>{trimNumber(r.eOut, 4)}</td>
                  <td>{trimNumber(r.errCyc, 4)}</td>
                  <td>{trimNumber(r.errCyc * 4, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          注意兩件事:(i) ef1 以 e₀ = 0 起步時,state 恆等於{' '}
          <M>{'\\operatorname{frac}\\bigl(\\sum_{j\\le k} v_j\\bigr)'}</M>,序列從 k=0 就進入
          週期 25 的穩態 —— <b>ef1 沒有額外 startup transient</b>;mash11 / mash111 的
          差分項(c₂ − c₂_prev 等)則在前 1–2 拍有 transient(圖三切換 quantizer 可見)。
          <EpistemicTag kind="EXACT" /> (ii) 表中 k=24 的 e_out 顯示 1:實際值是
          0.9999…(float64 累積捨入,e ∈ [0,1) 嚴格成立)。精確算術下這一拍 v + e =
          301 恰為整數(y = 301、err = +0.13);float64 落在 300.9999… → y = 300、err
          = −0.12 —— DSM 序列在這類 floor 邊界拍與精確算術分歧、輸出翻轉一整個
          stage-LSB,因此<b>只對 nearest</b> 做週期量測(圖一),且比較用明示容差。
          <EpistemicTag kind="EXPERIMENT" />
        </p>
      </SectionExample>

      <SectionFigure
        title="圖一 — Layer 1 公式驗證表:P = q/gcd(q,G)、peak = (⌊P/2⌋/P)·Δ、f_spur = f_ref/P(5 preset N × 3 stages,即時計算)"
        caption={
          <span>
            每列:公式預測(P、peak、spur 基頻)vs 本頁 model 即時量測(nearest、512
            cycles;週期以 1e-9 容差比對)。「exact」= α·G 為整數 → 誤差 ≡ 0。peak(fs) 用
            各 N 的 T_vco 換算。與 python3 交叉驗證:N=3.13@DTC → P=25、peak 0.48 LSB =
            149.8 fs、間距 160 MHz;N=3.125@DTC exact;N=3.125@PMUX P=2 交錯;N=3.000
            全級 0。<EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>N</th>
                <th>α = p/q</th>
                <th>stage(G)</th>
                <th>P 公式</th>
                <th>P 量測</th>
                <th>peak 公式 (cyc)</th>
                <th>peak 量測 (cyc)</th>
                <th>peak (fs)</th>
                <th>spur 間距 f_ref/P</th>
              </tr>
            </thead>
            <tbody>
              {layer1.map((r, i) => (
                <tr key={i} style={r.n === nDiv ? { fontWeight: 600 } : undefined}>
                  <td>{r.n}</td>
                  <td>{r.frac}</td>
                  <td>
                    {r.stage}({r.s})
                  </td>
                  <td>{r.pPred ?? '—'}</td>
                  <td>{r.exact ? '1(≡0)' : (r.pMeas ?? '—')}</td>
                  <td>{r.peakPredCyc !== null ? fmtCyc(r.peakPredCyc) : '—'}</td>
                  <td>{fmtCyc(r.peakMeasCyc)}</td>
                  <td>{r.exact ? '0' : formatSiTime(r.peakFs)}</td>
                  <td>{r.exact ? '無 spur' : r.f0Mhz !== null ? `${trimNumber(r.f0Mhz, 5)} MHz` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 13, opacity: 0.85 }}>
          對照鏈:divider→PMUX 縮 4×、PMUX→DTC 再縮 64×,但 N=3.13 的 P 在 PMUX 與 DTC{' '}
          <b>同為 25</b>(gcd(100,4) = gcd(100,256) = 4 → P = 100/4 = 25)→ spur <b>位置不變、
          只有幅度縮小</b>。<EpistemicTag kind="EXACT" />
        </p>
      </SectionFigure>

      <SectionFigure
        title="圖二 — edge staircase:ideal 斜坡 vs 三級 grid 的量化樓梯(前 40 拍)"
        caption={
          <span>
            x 軸:k;y 軸:edge 位置 − 3k(cycles)—— 扣掉整數 3 讓 α 斜坡可見。灰線:
            ideal(斜率 α = {trimNumber(alpha, 6)});三條階梯:各級 grid 上量化後的實際
            edge(目前 quantizer = {quant})。divider 只能踩整數 cycle(大階);PMUX 踩
            1/4;DTC 踩 1/256(幾乎貼合)。切 ef1/mash11 可見階梯「在 ideal 兩側跳動」
            而非單純貼近。
          </span>
        }
      >
        <EChart option={stairOption} height={300} />
      </SectionFigure>

      <SectionFigure
        title="圖三 — e_PD[k] 三級同軸疊圖(單位可切換)"
        caption={
          <span>
            x 軸:k;y 軸:e_PD(<UnitSwitch />)。三條線:divider(±0.5 cycle 鋸齒)、
            +PMUX(±1/8)、+DTC(±half-LSB,幾乎貼 0 —— 用 dataZoom 放大)。量級差 4× /
            64×,對數上等距。N on-grid(3.000/3.125@DTC/3.25@PMUX+DTC)時對應線恆 0。
            <EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <EChart option={errOption} height={300} />
      </SectionFigure>

      <SectionFigure
        title={`圖四 — code-level 暫態(${stage.short} stage):n_int / m_FB / c_FB 與 quantizer state`}
        caption={
          <span>
            上:由 stage code decode 的 divider 指令 n_int = I[k+1]−I[k]、PMUX code m_FB、
            DTC code c_FB(divider stage 時 m=c≡0;PMUX stage 時 c≡0 —— grid 還沒細到用得上
            它們)。下:quantizer 內部 state e[k](ef1 的 error-feedback 殘量;mash 顯示第一級
            accumulator)與未 wrap 誤差(stage-LSB)。前 {Math.min(96, nCyc)} 拍。DSM 的
            startup:mash11/mash111 前 1–2 拍的差分 transient 清晰可見。
            <EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <EChart option={codeOption} height={240} />
          <EChart option={stateOption} height={240} />
        </div>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>stage \ quantizer(peak |e_PD|,cycles;512 拍,N = {trimNumber(nDiv, 6)})</th>
                {QUANT_OPTIONS.map((q) => (
                  <th key={q.value}>{q.value}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((row) => (
                <tr key={row.stage.key}>
                  <td>{row.stage.short}(Δ = 1/{row.stage.s})</td>
                  {row.cells.map((c) => (
                    <td key={c.quant}>
                      {fmtCyc(c.peakCyc)}
                      {c.folds > 0 ? (
                        <span style={{ color: ct.bad }}> (raw {fmtCyc(c.peakRawCyc)}, 摺疊 {c.folds})</span>
                      ) : null}
                      <br />
                      <span style={{ fontSize: 12, opacity: 0.8 }}>
                        rms {fmtCyc(c.rmsCyc)};n_int {c.nInt}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 13, opacity: 0.85 }}>
          矩陣即時計算(無 dither;摺疊 = |raw| ≥ 0.5 cycle 的拍數,含恰為 +0.5 被 wrap
          成 −0.5 的拍)。N=3.13 驗證錨點:DTC 列 peak = 0.48 / 0.76 / 1.36 / 1.76 LSB
          (nearest → mash111,與 Ch11 exp22 相同);divider 列的 DSM 出現大量 wrap 摺疊
          (ef1 raw ±0.9 cyc、132 拍;python3 同值)且 n_int 集合擴大(mash111 到 {'{−3…9}'}
          —— 對 /3-/4 硬體不可實作,只是把數學推到極端的教學展示)。
          <EpistemicTag kind="EXPERIMENT" />
        </p>
      </SectionFigure>

      <SectionFigure
        title="圖五 — cycle-by-cycle DebugTable(三級誤差 + DTC 級 decode,CSV 可匯出)"
        caption={
          <span>
            全部欄位為 raw 值(CSV 匯出後可與 python3 golden model 逐位 diff)。e_*_cyc 為
            wrap 後 PD 誤差(cycles);dsm_state_dtc 為 DTC 級 quantizer 內部 state。
          </span>
        }
      >
        <DebugTable
          columns={[
            { key: 'k', label: 'k' },
            { key: 's_ideal', label: 's_ideal' },
            { key: 'v_div', label: 'v(div)' },
            { key: 'y_div', label: 'y(div)' },
            { key: 'e_div_cyc', label: 'e_div' },
            { key: 'v_pmux', label: 'v(pmux)' },
            { key: 'y_pmux', label: 'y(pmux)' },
            { key: 'e_pmux_cyc', label: 'e_pmux' },
            { key: 'v_dtc', label: 'v(dtc)' },
            { key: 'y_dtc', label: 'y(dtc)' },
            { key: 'e_dtc_cyc', label: 'e_dtc' },
            { key: 'n_int_dtc', label: 'n_int' },
            { key: 'm_FB_dtc', label: 'm_FB' },
            { key: 'c_FB_dtc', label: 'c_FB' },
            { key: 'dsm_state_dtc', label: 'dsm_state' },
          ]}
          rows={debugRows}
          exportName="ch21_stage_errors.csv"
        />
      </SectionFigure>

      <SectionFigure
        title="圖六 — Layer 3:DSM 買到的是 in-band 有效解析度(f < f_ref/64 proxy band)"
        caption={
          <span>
            PSD(log-f):N* = {trimNumber(nDiag, 8)}(診斷微擾,見下)@ DTC grid,nearest
            vs {quant}。y 軸 dB re cycle²/Hz;sample rate = f_ref。DSM 把低頻誤差壓下去、
            高頻墊高 —— in-band(62.5 MHz 左側)的差距就是「有效解析度」的來源。
            <EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <p>
          <b>先講誠實的部分:</b>對 N = 3.13(P = 25),<b>全部</b>量化功率都在 m×160 MHz
          的 tone 上 —— f {'<'} 62.5 MHz 之內<b>本來就沒有誤差功率</b>(量測值 DTC 級
          ~10⁻⁹、PMUX 級 ~10⁻⁷ cycle,純為 Hann leakage 位階)。此時 nearest 在 band 內已經「乾淨」,DSM 沒有東西可買。
          <EpistemicTag kind="EXPERIMENT" /> DSM 的 in-band 收益出現在<b>誤差 pattern 週期夠長、
          基頻掉進 band 內</b>的 N:表中用診斷 N* = N + 2⁻¹³ + 2⁻²⁵(dyadic 微擾把有效
          rational 週期推到 ≫ 觀察窗)呈現。這正是實務中「α 不是漂亮分數」的一般情況。
        </p>
        <EChart option={psdL3Option} height={300} />
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>stage / quantizer</th>
                <th>in-band rms @ N(cyc)</th>
                <th>in-band rms @ N*(cyc / fs)</th>
                <th>total rms @ N*(cyc)</th>
                <th>peak @ N*(cyc)</th>
                <th>vs nearest(bits)</th>
              </tr>
            </thead>
            <tbody>
              {layer3.table.map((st) =>
                st.rows.map((r) => (
                  <tr key={`${st.stage.key}-${r.quant}`}>
                    <td>
                      {st.stage.short} / {r.quant}
                    </td>
                    <td>{fmtCyc(r.ibExact, 3)}</td>
                    <td>
                      {fmtCyc(r.ibDiag, 3)} / {formatSiTime(r.ibDiag * tVco)}
                      {r.folds > 0 ? <span style={{ color: ct.bad }}>(摺疊 {r.folds} 拍!)</span> : null}
                    </td>
                    <td>{fmtCyc(r.totDiag, 3)}</td>
                    <td>{fmtCyc(r.peakDiag, 3)}</td>
                    <td>{r.bits !== null ? `${trimNumber(r.bits, 3)} bits` : '(基準)'}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
        <p>
          python3 驗證錨點(N = 3.13 的 N*、1024 cycles):DTC grid — nearest in-band
          2.97×10⁻⁵ cyc(2.37 fs)、ef1 1.42×10⁻⁵(+6.4 dB ≈ <b>+1.1 bit</b>)、mash11
          7.2×10⁻⁷(+32.3 dB ≈ <b>+5.4 bits</b>)、mash111 7.7×10⁻⁸(+51.8 dB ≈{' '}
          <b>+8.6 bits</b>)。等效地說:mash111 在 f {'<'} f_ref/64 內的表現相當於把 1/256
          cycle 的實體 grid 換成 Δ_eff ≈ Δ/2^8.6 ≈ 1/99000 cycle 的 nearest —— 但<b>只在
          in-band 平均意義下</b>。同表 total rms 與 peak 欄位顯示代價:mash111 的 peak 是
          nearest 的 6.5 倍。PMUX grid 的 mash111 更慘:shaped 擺幅 ±0.92 cycle 超過 wrap
          範圍,132 拍摺疊,in-band 反而<b>劣化 22 dB</b>(表中紅字)—— shaping 收益被
          aliasing 毀掉。<EpistemicTag kind="EXPERIMENT" />
        </p>
        <p>
          <b>誠實的反面(接 Ch10/Ch11):</b>per-edge 對準<b>沒有</b>改善 —— 每一拍的 edge
          仍在 1 stage-LSB 格點上,且 DSM 的瞬時峰值更大(上表 peak 欄)。對 injection /
          zero-crossing 這種逐拍直接作用、沒有 loop 低通可依賴的用途,DSM 買的「平均 /
          in-band 解析度」用不上(Ch14 的 shorting energy 看的是瞬時誤差)。另外 dither
          在 error-feedback 結構中<b>不被 shaping</b>(誤差 = dither + shaped 殘量):
          dither 0.5 LSB 會把 DTC 級 in-band floor 墊到 ~1.2–2.4×10⁻⁴ cycle,nearest 與
          ef1 落在同一量級 —— dither 買 spur 平滑、賣 in-band floor。<EpistemicTag kind="EXPERIMENT" />
        </p>
      </SectionFigure>

      <SectionFigure
        title={`圖七 — Layer 4:${stage.short} stage 的 PSD 與 5 項 sanity checklist(即時重算)`}
        caption={
          <span>
            PSD:e_PD @ {stage.short}(N = {trimNumber(nDiv, 6)}、{NC_PSD} cycles、Hann、
            sample rate = f_ref = 4 GHz,bin = 3.906 MHz)。灰:nearest baseline;藍:
            {quant}
            {dither > 0 ? ` + dither ${trimNumber(dither, 3)} LSB` : ''}。y 軸為 dB re
            cycle²/Hz(<b>不</b>標 dBc/Hz —— divider 級誤差達 ±0.5 cycle,small-angle 不成立,
            §17)。直線標記 f_ref/64 = in-band proxy 邊界;log-x 切換在右側面板。
            {spectrum.folds > 0 ? (
              <b style={{ color: ct.bad }}>
                {' '}
                注意:目前設定有 {spectrum.folds} 拍 wrap 摺疊,頻譜含 aliasing。
              </b>
            ) : null}
          </span>
        }
      >
        <EChart option={psdOption} height={320} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 8 }}>
          <div style={{ flex: '1 1 260px', overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>top-5 spur({quant})</th>
                  <th>level (dB re cyc²/Hz)</th>
                </tr>
              </thead>
              <tbody>
                {spectrum.spurs.length === 0 ? (
                  <tr>
                    <td colSpan={2}>無(exact 或 floor-dominated)</td>
                  </tr>
                ) : (
                  spectrum.spurs.map((s, i) => (
                    <tr key={i}>
                      <td>{trimNumber(s.freqHz / 1e6, 5)} MHz</td>
                      <td>{trimNumber(s.psdDb, 4)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div style={{ flex: '2 1 380px' }}>
            <table className="data-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>sanity check</th>
                  <th>結果</th>
                  <th>數值(即時)與容差</th>
                </tr>
              </thead>
              <tbody>
                {spectrum.checks.map((c) => (
                  <tr key={c.name}>
                    <td style={{ whiteSpace: 'nowrap' }}>{c.name}</td>
                    <td>{badge(c.status)}</td>
                    <td>
                      {c.detail}
                      <br />
                      <span style={{ fontSize: 12, opacity: 0.75 }}>容差:{c.tolerance}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p style={{ fontSize: 13, opacity: 0.85 }}>
          五項檢查的依據:(1) 週期序列功率只在 f_ref/P 諧波 [EXACT] —— 檢查每根
          strong spur 都落在 m·f_ref/P 格點 ±1 bin;(2) DSM 誤差 ≡
          (1−z⁻¹)ⁿ × 有界序列 → 對 n 重積分的 PSD 比值斜率 +20n dB/dec [EXACT],python3
          掃 5 preset × 3 stage 實測 fit:order 1 = 19.5–19.8、order 2 = 39.0–39.5、order 3
          = 59.6–61.7 dB/dec [EXPERIMENT];(3) periodogramPsd 的 U = mean(w²) 歸一化
          (measurements.ts docstring:「white noise integrates to its variance」)保證
          寬頻訊號 Parseval 成立,短週期 tonal(P ≤ 128)python 實測 ratio:preset
          0.865–1.101、slider 掃描 0.967–1.021;慢 tonal(P {'>'} 128 無 dither)可偏到
          1.9 → N/A [EXPERIMENT];(4) 靜態 offset 只出現在 DC bin:N=3.125@PMUX nearest
          的 mean = +1/16 cycle 由 DC bin 反推分毫不差 [EXACT](dither / P {'>'} 128 時
          對帳失效 → N/A);(5) deterministic 短週期 → comb(preset 實測 0.987–1.000、
          slider P ≤ 128 掃描 ≥ 0.94;P = 2 的 Nyquist tone 由固定納入的末兩 bin 涵蓋)、
          dither ≥ 0.5(PMUX/DTC)→ floor(0.003–0.090)[EXPERIMENT]。
        </p>
      </SectionFigure>

      <SectionCode
        title="本章 stage 量化 helper(真實碼)+ model 的 ef1 quantizer(web/src/model/quantizers.ts 節錄)"
        language="typescript"
        code={`${STAGE_HELPER_SRC}\n\n${EF1_SRC}`}
      >
        <p>
          runStage 是本章所有圖表唯一的計算入口:量化與 wrap 全部呼叫 model 的{' '}
          <code>makeQuantizer</code> / <code>wrapCycles</code> / <code>triangularDither</code>
          (§6/§2),chapter 內只做 2 的冪縮放與統計。S = 256 時它與{' '}
          <code>simulate()</code> 的 feedback path 完全重合(e_FB_abs 逐位相等,python3
          驗證)。<EpistemicTag kind="EXACT" />
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'const a = aIdeal(nCycles, nDiv);',
            explain: (
              <span>
                A_ideal = 256·s_ideal = 256·k·N(乘法而非累加,§3)—— 全 chain 共用的
                master accumulator 軌跡,三個 stage 都從同一條軌跡量化。
              </span>
            ),
          },
          {
            code: 'const scale = s / 256;',
            explain: (
              <span>
                stage grid 換算:S ∈ {'{1, 4, 256}'} → scale ∈ {'{2⁻⁸, 2⁻⁶, 1}'} 全是 2 的冪,
                float64 縮放<b>無捨入</b> —— TS 與 Python 的 v 逐位一致,量化輸出必然相同。
                <EpistemicTag kind="EXACT" />
              </span>
            ),
          },
          {
            code: 'const q = makeQuantizer(quant);',
            explain: (
              <span>
                每次 run 都是 fresh state:DSM 的內部 state 從 0 起步(startup transient
                在圖四可見),兩次互動之間不殘留狀態 —— 決定性、可重現。
              </span>
            ),
          },
          {
            code: "if (dither !== null) u += triangularDither(ditherLsb, dither);",
            explain: (
              <span>
                triangular dither 加在 quantize <b>之前</b>(§6 item 7),stream 為
                mulberry32 'dither_fb'(§12,跨語言逐位一致)。注意:在 error-feedback
                結構裡 dither 本身不被 shaping。
              </span>
            ),
          },
          {
            code: 'y[k] = q.quantize(u);',
            explain: (
              <span>
                整數 stage code —— actuator 的全部自由度。divider 級它就是「第幾個 VCO
                cycle」;PMUX 級是「第幾個 quarter」;DTC 級是 §4 的 A_FB。
              </span>
            ),
          },
          {
            code: 'raw[k] = (y[k] - v[k]) / s;',
            explain: (
              <span>
                未 wrap 誤差(cycles)。除以 S 把 stage-LSB 換回 cycle;nearest 時 |raw| ≤
                1/(2S),DSM 時可超過 —— 這條線是圖四下圖的紅線。
              </span>
            ),
          },
          {
            code: 'err[k] = wrapCycles(raw[k]);',
            explain: (
              <span>
                PD 只能看到 wrap 到 [−0.5, 0.5) 的相位差 —— e_PD 的定義。raw 與 err 不同
                的拍就是「摺疊」:shaped 誤差 aliasing 回 in-band(Layer 3 的 mash111@PMUX)。
                <EpistemicTag kind="EXACT" />
              </span>
            ),
          },
          {
            code: 'iFb[k] = Math.floor(aFull / 256);  rFb[k] = pymod(aFull, 256);',
            explain: (
              <span>
                §4 decode:同一個 absolute code 拆成 integer cycle(I)與 fractional
                code(R = 64m + c)。n_int = I[k+1] − I[k] —— divider 指令是 accumulator
                的<b>差分</b>,不是獨立產生的 bit(Ch4/Ch9)。
              </span>
            ),
          },
          {
            code: 'const v2 = u + this.e;  const y2 = Math.floor(v2);  this.e = v2 - y2;',
            explain: (
              <span>
                ef1 三行核心(右側 SectionCode):殘量記帳 → y − u = e[k−1] − e[k] →
                (1−z⁻¹) shaping。SectionExample 的 25 拍表就是這三行手算。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            圖一:N = 3.13 列 —— PMUX 與 DTC 的 P 都是 25(spur 間距同為 160 MHz),但
            peak 從 9.6 ps 縮到 149.8 fs:<b>加細 grid 縮幅度、不動頻率</b>。對照 N =
            3.1375:DTC 級 P 從 80 縮到 5(gcd 大),spur 反而變稀(800 MHz)。
          </li>
          <li>
            圖二:divider 階梯一次跨 1 cycle(誤差鋸齒 ±0.5),DTC 階梯幾乎貼住灰線;把
            quantizer 切到 mash111 再看 divider 級 —— 階梯會「過衝」到 ideal 之外好幾格。
          </li>
          <li>
            圖三:三條線量級 4× / 64× 分離;N 切到 3.125:PMUX 線變成 0 / +1/8 交錯
            (P = 2),DTC 線恆 0(on-grid exact)。
          </li>
          <li>
            圖四:nearest 的 state 恆 0;ef1 的 state 是 frac 累加鋸齒;mash11/mash111
            前 1–2 拍差分 transient。c_FB 只在 DTC 級非零 —— grid 決定哪些 code 欄位
            「活著」。
          </li>
          <li>
            圖六表:N 欄(exact)只剩 leakage 位階(DTC ~10⁻⁹、PMUX ~10⁻⁷)——{' '}
            <b>對 P=25 的 N,in-band 本來就空</b>;
            N* 欄才看得到 DSM 的 in-band 收益隨階數增加(+1.1 / +5.4 / +8.6 bits @ DTC),
            以及 mash111@PMUX 的摺疊災難(紅字)。
          </li>
          <li>
            圖七:切 quantizer / dither / stage,五個 badge 即時重算 —— 特別試:(a) N=3.125
            + PMUX:check 1 走 Nyquist 特例、check 4 的 mean = 1/16 cycle 被 DC bin 精確
            回收;(b) dither 從 0 拉到 0.5:check 5 從 comb 翻成 floor(PMUX/DTC 級;
            divider 級 y±1 經 wrap 後不可見,維持 comb;0 {'<'} dither {'<'} 0.5 是轉換區
            → N/A);(c) mash111 + divider:摺疊警告出現,check 2 仍 pass(它用未 wrap
            診斷序列)。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解 1:「DSM 提高了 DTC 解析度,所以每個 edge 都更準」">
          <p>
            錯,而且方向相反。DSM 輸出仍是整數 code —— 每一拍 edge 還是在 1/G cycle 格點
            上;瞬時峰值反而<b>變大</b>:N=3.13@DTC 實測 peak 0.48(nearest)→ 0.76(ef1)
            → 1.36(mash11)→ 1.76 LSB(mash111)。DSM 改變的是誤差的<b>頻譜分佈</b>
            (低頻壓下、高頻墊高),「更準」只在 loop 低通之後的平均意義下成立;對逐拍
            作用的 injection(Ch10/Ch11/Ch14)是淨損失。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解 2:「grid 越細,spur 就會被推到越高頻」">
          <p>
            不一定 —— spur <b>間距</b>由 P = q/gcd(q,G) 決定,只跟 α 的分母與 G 的公因數
            有關。N=3.13 從 PMUX 到 DTC(G: 4 → 256)P 都是 25:spur 還在原地(m×160
            MHz),只是<b>幅度</b>縮了 64 倍。甚至可能變稀疏:N=3.1375 在 DTC 級 P=5。
            要移動 spur 位置,得改 α 的數論結構(或用 dither / DSM 重塑),不是加 DTC bits。
            <EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <p>grid 選擇 vs DSM 階數的 trade-off(本章量測總表):</p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>手段</th>
                <th>per-edge peak</th>
                <th>in-band error(長週期 α)</th>
                <th>spur 位置</th>
                <th>風險 / 成本</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>加細 grid(divider → +PMUX → +DTC)</td>
                <td>÷4、再 ÷64(bound Δ/2)[EXACT]</td>
                <td>等比例縮小(nearest:PMUX→DTC 實測 ~×1/90)</td>
                <td>不動(P 只依 gcd(q,G))</td>
                <td>硬體:相位路由 + DTC 面積/校正(Ch15)</td>
              </tr>
              <tr>
                <td>提高 DSM 階數(同 grid)</td>
                <td><b>變大</b>(0.48→1.76 LSB @DTC)</td>
                <td>−6 / −32 / −52 dB(ef1/mash11/mash111 @N*)</td>
                <td>tone 重塑為 shaped comb/floor</td>
                <td>摺疊(shaped 擺幅 ≥ 0.5 cyc 即毀)、n_int 範圍擴大、逐拍精度劣化</td>
              </tr>
              <tr>
                <td>triangular dither</td>
                <td>+d_amp(略增)</td>
                <td><b>墊高</b> floor(unshaped!)</td>
                <td>comb → floor(集中度 0.99 → 0.05)</td>
                <td>in-band floor 換 spur 平滑</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          設計序位:<b>先把 grid 買足</b>(每細一級,peak 與 in-band 同時等比縮,無副作用
          —— divider→PMUX→DTC 是本架構最有價值的 64×/256×);DSM 只該在「α 數論結構把
          tone 掉進 loop band 內、且頻譜規格吃緊」時加,階數上限由「shaped 擺幅 × Δ{' '}
          {'<'} 0.5 cycle」的摺疊條件與逐拍 injection 精度(Ch11/Ch14)共同決定 ——
          mash111 配粗 grid(PMUX 級)是實測會翻車的組合。dither 是頻譜整形工具,
          不是精度工具。<EpistemicTag kind="INFERENCE" />
        </p>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            本章是 <b>open-loop scheduler error</b>:e_PD 為 PD 輸入端的量化誤差,PD 的
            非線性 / 增益、charge pump、loop filter 與閉環動態<b>皆未建模</b>;
            「f {'<'} f_ref/64 = in-band」只是 proxy band,實際收益取決於 loop 頻寬與
            誤差傳遞函數。divider / PMUX 截斷級是<b>思想實驗</b>(真硬體的 mash 高階
            divider-only 模式會違反 /3-/4 約束,Ch11 §7.1);analog 誤差(tap mismatch、
            DTC gain/INL、route skew,Ch15)與 injection dynamics(Ch13)全部關閉。頻譜為
            單一 realization(seed 12345)的 Hann periodogram,無 ensemble 平均;N* 診斷
            微擾是人為構造的長週期 rational,用來代表「α 非漂亮分數」的一般情況。float64
            的累積捨入使 DSM 內部 state 僅為<b>準週期</b>(wrap 後漂移 ~10⁻¹⁰);state
            落在 floor 邊界的拍上,量化輸出會整個翻轉 1 stage-LSB(SectionExample 的
            k=24),故圖一的週期量測只對 nearest 進行、比較皆用明示容差(nearest 實測
            週期殘差 {'<'} 10⁻¹²)。
          </p>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="參數 Parameters">
        <SelectControl<StageKey>
          label="Stage(圖四/圖七)"
          value={stageKey}
          options={STAGE_DEFS.map((s) => ({ value: s.key, label: s.labelZh }))}
          onChange={setStageKey}
        />
        <SelectControl<Quantizer>
          label="Quantizer"
          value={quant}
          options={QUANT_OPTIONS}
          onChange={setQuant}
        />
        <Slider
          label="N(divide ratio,全站共用)"
          value={nDiv}
          min={3}
          max={3.25}
          step={0.0005}
          onChange={setNDiv}
        />
        <PresetButtons
          label="Preset N"
          presets={N_DIV_PRESETS.map((n) => ({ label: String(n), onClick: () => setNDiv(n) }))}
        />
        <Slider
          label="triangular dither(stage-LSB)"
          value={dither}
          min={0}
          max={1}
          step={0.05}
          onChange={setDither}
        />
        <Slider
          label="n_cycles(暫態圖)"
          value={nCyc}
          min={64}
          max={512}
          step={64}
          onChange={setNCyc}
        />
        <Toggle label="PSD 用 log 頻率軸(圖七)" checked={logX} onChange={setLogX} />
        <p style={{ fontSize: 12, opacity: 0.75 }}>
          頻譜與 checklist 固定 {NC_PSD} cycles(bin 3.906 MHz);矩陣固定 512;Layer 3 的
          N* = N ± (2⁻¹³ + 2⁻²⁵) 自動跟隨 N。dither 影響圖二三四、矩陣除外、圖七的兩條
          series 與 check 5;check 2 恆用無 dither 的未 wrap 診斷序列。seed 固定 12345
          (§12),全部 deterministic。
        </p>
      </ParamPanel>
    </ChapterShell>
  );
}
