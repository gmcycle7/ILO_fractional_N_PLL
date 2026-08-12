/**
 * Chapter 15 — 類比失配 Analog Mismatch
 *
 * 內容契約:CHAPTER_GUIDE.md Ch15;數學契約:MODEL_SPEC.md §10(16 項
 * nonideality 清單)、§16(error decomposition)、§8(calibrated mapping)。
 * 互動圖:#25 tap mismatch polar plot、#26 DTC INL plot(sin/poly/LUT)、
 * error decomposition 逐項貢獻圖(decompose())、naive vs calibrated 比較。
 * 所有計算經由 ../model;本檔不重新實作任何 wrap/quantize/mismatch 數學。
 */

import { useEffect, useMemo, useState } from 'react';
import { useGlobalNDiv } from '../lib/globalParams';
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
import { M, MathBlock } from '../components/Math';
import ExampleProblem, { fmt } from '../components/ExampleProblem';
import { ParamPanel, Slider, SelectControl, Toggle, PresetButtons } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import PhaseWheel from '../components/PhaseWheel';
import DebugTable from '../components/DebugTable';
import SimVeil from '../components/SimVeil';
import { makeLineOption, makeMarkLine } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import {
  formatPhase,
  formatSiTime,
  phaseAxisLabel,
  makePhaseTickFormatter,
  trimNumber,
} from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  DTCModel,
  Mulberry32,
  decompose,
  fromPartial,
  histogram,
  rms,
  simulate,
  tapActual,
  tapTable,
  wrapCycles,
  qFloor,
  configG,
  configTVcoS,
  cyclesToTime,
  dtcLsbS,
} from '../model';
import type { SimConfig } from '../model';

const meta = chapterById(15)!;

const LSB = 1 / 256; // 1 fine LSB in cycles [EXACT]
const DEG = 1 / 360; // 1 degree in cycles [EXACT]
const HALF_LSB = 0.5 / 256; // half-LSB in cycles [EXACT]
const N_CYCLES = 256;

/* ------------------------------------------------ MODEL_SPEC §10 16 項清單 */

interface KnobDef {
  no: number;
  id: string;
  name: string; // zh + en technical term
  field: string; // SimConfig field(s)
  term: string; // errorDecomposition TERMS key
}

const KNOBS: KnobDef[] = [
  { no: 1, id: 'tap', name: '8-tap mismatch δ_tap[j]', field: 'tap_mismatch_cycles', term: 'tap_mismatch' },
  { no: 2, id: 'pmux', name: 'PMUX mismatch δ_pmux[m]', field: 'pmux_mismatch_cycles', term: 'pmux_mismatch' },
  { no: 3, id: 'gain_fb', name: 'FB DTC gain error g_FB', field: 'dtc_fb_gain', term: 'dtc_gain' },
  { no: 4, id: 'gain_inj', name: 'INJ DTC gain error g_INJ', field: 'dtc_inj_gain', term: 'dtc_gain' },
  { no: 5, id: 'offset', name: 'DTC offset', field: 'dtc_{fb,inj}_offset_cycles', term: 'dtc_offset' },
  { no: 6, id: 'inl_sin', name: 'sinusoidal INL', field: 'inl_sin_amp_cycles', term: 'dtc_inl' },
  { no: 7, id: 'inl_poly', name: 'polynomial INL', field: 'inl_poly [p2, p3]', term: 'dtc_inl' },
  { no: 8, id: 'inl_lut', name: 'user LUT INL', field: 'inl_lut (64 entries)', term: 'dtc_inl' },
  { no: 9, id: 'dnl', name: 'DNL(frozen random step)', field: 'dnl_sigma_lsb', term: 'dtc_dnl' },
  { no: 10, id: 'route', name: 'route skew', field: 'route_{fb,inj}_cycles', term: 'route' },
  { no: 11, id: 'ref_jitter', name: 'reference jitter', field: 'sigma_ref_s', term: 'ref_jitter' },
  { no: 12, id: 'vco_w', name: 'VCO white phase noise', field: 'sigma_vco_w_rad', term: 'vco_noise' },
  { no: 13, id: 'vco_rw', name: 'VCO random walk', field: 'sigma_vco_rw_rad', term: 'vco_noise' },
  { no: 14, id: 'latency', name: 'fixed digital latency L', field: 'latency_cycles + lookahead', term: 'latency' },
  { no: 15, id: 'p_late', name: 'random command latency', field: 'p_late', term: 'latency' },
  { no: 16, id: 'pulse', name: 'injection pulse timing noise', field: 'sigma_pulse_s', term: 'pulse_noise' },
];

/** 三角形 user LUT 範例(輸入資料,非物理宣稱):峰值在 c=32。 */
function triLut(ampCyc: number): number[] {
  return Array.from({ length: 64 }, (_, c) => ampCyc * (1 - Math.abs(c - 32) / 32));
}

/** tap mismatch pattern:uniform(全部 +δ)或 exp19 交錯 pattern。 */
function tapPatternArr(pattern: 'uniform' | 'alt', degAmp: number): number[] {
  const d = degAmp * DEG;
  if (pattern === 'uniform') return new Array<number>(8).fill(d);
  return [0, d, -d, 0.5 * d, -0.5 * d, d, -d, 0.5 * d];
}

/** 每個 knob 開啟時套用的 config 欄位(量值 = 本章 canonical 值)。 */
function knobOverrides(
  id: string,
  p: { tapArr: number[]; gain: number; inlAmpCyc: number },
): Partial<SimConfig> {
  switch (id) {
    case 'tap':
      return { tap_mismatch_cycles: p.tapArr };
    case 'pmux':
      return { pmux_mismatch_cycles: [0, 0.3 * LSB, -0.3 * LSB, 0.15 * LSB] };
    case 'gain_fb':
      return { dtc_fb_gain: p.gain };
    case 'gain_inj':
      return { dtc_inj_gain: p.gain };
    case 'offset':
      return { dtc_fb_offset_cycles: 0.5 * LSB, dtc_inj_offset_cycles: 0.5 * LSB };
    case 'inl_sin':
      return { inl_sin_amp_cycles: p.inlAmpCyc };
    case 'inl_poly':
      return { inl_poly: [0.5 * LSB, -0.3 * LSB] };
    case 'inl_lut':
      return { inl_lut: triLut(0.3 * LSB) };
    case 'dnl':
      return { dnl_sigma_lsb: 0.05 };
    case 'route':
      return { route_fb_cycles: 1 * LSB, route_inj_cycles: 2 * LSB };
    case 'ref_jitter':
      return { sigma_ref_s: 100e-15 };
    case 'vco_w':
      return { sigma_vco_w_rad: 0.01 };
    case 'vco_rw':
      return { sigma_vco_rw_rad: 0.003 };
    case 'latency':
      return { latency_cycles: 1, lookahead: false };
    case 'p_late':
      return { p_late: 0.05 };
    case 'pulse':
      return { sigma_pulse_s: 100e-15 };
    default:
      return {};
  }
}

const TERM_LABELS: { key: string; label: string }[] = [
  { key: 'tap_mismatch', label: 'tap' },
  { key: 'pmux_mismatch', label: 'pmux' },
  { key: 'dtc_gain', label: 'gain' },
  { key: 'dtc_offset', label: 'offset' },
  { key: 'dtc_inl', label: 'INL' },
  { key: 'dtc_dnl', label: 'DNL' },
  { key: 'route', label: 'route' },
  { key: 'ref_jitter', label: 'ref jit' },
  { key: 'vco_noise', label: 'VCO noise' },
  { key: 'pulse_noise', label: 'pulse' },
  { key: 'latency', label: 'latency' },
];

function onlyEnabled(...ids: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const kb of KNOBS) out[kb.id] = ids.includes(kb.id);
  return out;
}

const DEFAULT_ENABLED = onlyEnabled('tap', 'gain_inj', 'inl_sin', 'ref_jitter', 'vco_w');

/* ==================================================================
 * 背景 LMS 校正(chapter-local 迭代迴路,EXPERIMENT)
 *
 * MODEL_SPEC 沒有定義 calibration 演算法;本節的迴路是章內組合 model
 * primitive(simulate / tapTable / DTCModel / wrapCycles)而成的實驗,
 * 不新增任何 wrap / quantize / mismatch 數學。
 *
 * 待估參數(兩個,單位皆為 cycles,量級相當 → 單一 μ 即可):
 *   δ̂ : tap 3 的位置偏移         regressor φ₁[k] = 1{j[k] = 3}
 *   γ̂ : INJ DTC 的滿 range 增益誤差 γ = (g − 1)·64·LSB
 *                                  regressor φ₂[k] = c[k]/64
 * 因為 analog 誤差 = δ[j] + (g−1)·c·LSB = δ·φ₁ + γ·φ₂,兩者是同一組
 * 線性迴歸的係數;LMS 更新 θ ← θ + μ·r·φ。
 *
 * 誤差訊號(可切換):
 *   ε_analog[k] = wrapCycles(e_ZC_hw[k] − e_INJ_abs[k])
 *               = u_INJ_analog − u_INJ_digital  ← 純 analog 殘差
 *   e_ZC_hw[k]  = 直接用總誤差(含 digital 量化殘差 → 估計有偏)
 *
 * 時序:mapping 表每個 window(LMS_BATCH 拍)更新一次,LMS 每拍更新
 * 參數 —— 對應真實硬體「LUT 重載速率 ≪ sample rate」的背景校正。
 * ================================================================== */

const LMS_TAP = 3; // 被校正的 injection tap index
const LMS_BATCH = 64; // 一個觀測 window 的 reference cycles
const LMS_ITERS = 48; // window 數(共 48 × 64 = 3072 拍)
const GAMMA_SCALE = 64 * LSB; // DTC full range = 0.25 cycle(γ 的 regressor 尺度)

type MismatchPreset = 'both' | 'tap' | 'gain';

const MISMATCH_PRESETS: Record<MismatchPreset, { tapDeg: number; gainPct: number; label: string }> =
  {
    both: { tapDeg: 1, gainPct: 1, label: 'exp12 + exp13(1° tap3 + 1% gain)' },
    tap: { tapDeg: 1, gainPct: 0, label: 'exp12(1° tap3,gain 理想)' },
    gain: { tapDeg: 0, gainPct: 1, label: 'exp13(1% INJ gain,tap 理想)' },
  };

function maxAbs(x: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > m) m = a;
  }
  return m;
}

interface LmsResult {
  dHist: Float64Array; // δ̂ 每次更新後的值(長度 ITERS × BATCH)
  gHist: Float64Array; // γ̂ 同上
  dStart: number[]; // 每個 window 開始時的 δ̂(= 該 window mapping 用的值)
  gStart: number[];
  traces: Float64Array[]; // 每個 window 的 e_ZC_hw(迴路)
  floorTraces: Float64Array[]; // 同 window 的 perfect-knowledge 參考
  rmsIter: number[];
  peakIter: number[];
  rmsFloor: number[];
  peakFloor: number[];
  dTrue: number;
  gTrue: number;
  identicalFrom: number | null; // 第一個與 perfect-knowledge 逐位相同的 window
}

/** 背景 LMS 校正迴路:回傳完整收斂歷史與 calibrated floor 參考。 */
function runLmsCalibration(
  nDiv: number,
  mu: number,
  tapDeg: number,
  gainPct: number,
  useAnalogResidual: boolean,
): LmsResult {
  // --- 真實硬體(plant):只有 tap 3 偏移 + INJ DTC gain 誤差 ---
  const tapTrue = new Array<number>(8).fill(0);
  tapTrue[LMS_TAP] = tapDeg * DEG;
  const tapTblTrue = tapTable(8, tapTrue);
  const dtcTrue = new DTCModel({ gain: 1 + gainPct / 100 });

  const dHist = new Float64Array(LMS_ITERS * LMS_BATCH);
  const gHist = new Float64Array(LMS_ITERS * LMS_BATCH);
  const dStart: number[] = [];
  const gStart: number[] = [];
  const traces: Float64Array[] = [];
  const floorTraces: Float64Array[] = [];
  const rmsIter: number[] = [];
  const peakIter: number[] = [];
  const rmsFloor: number[] = [];
  const peakFloor: number[] = [];

  let dHat = 0;
  let gHat = 0;
  let n = 0;
  let identicalFrom: number | null = null;

  for (let it = 0; it < LMS_ITERS; it++) {
    const tapEst = new Array<number>(8).fill(0);
    tapEst[LMS_TAP] = dHat;
    const common: Partial<SimConfig> = {
      n_div: nDiv,
      n_cycles: LMS_BATCH,
      s0: it * LMS_BATCH * nDiv, // 連續的 phase 軌跡:每個 window 接著上一個
      quantizer: 'nearest',
      arch_mode: 'D',
      inj_mapping: 'calibrated',
      inj_model: 'none',
    };
    // (a) 迴路:argmin 用「估計」表;(b) 參考:argmin 用「真值」表(floor)
    const res = simulate(
      fromPartial({
        ...common,
        tap_mismatch_cycles: tapEst,
        dtc_inj_gain: 1 + gHat / GAMMA_SCALE,
      }),
    );
    const ref = simulate(
      fromPartial({
        ...common,
        tap_mismatch_cycles: tapTrue,
        dtc_inj_gain: 1 + gainPct / 100,
      }),
    );

    // 用「真實」表評估迴路選中的 (j, c):MODEL_SPEC §5.1 的 e_ZC_hw 定義
    const jArr = res.data.j_INJ;
    const cArr = res.data.c_INJ;
    const xArr = res.data.x_ideal;
    const eDig = res.data.e_INJ_abs;
    const e = new Float64Array(LMS_BATCH);
    const eps = new Float64Array(LMS_BATCH);
    for (let k = 0; k < LMS_BATCH; k++) {
      const u = tapTblTrue[jArr[k]] + dtcTrue.delayCycles(cArr[k]);
      e[k] = wrapCycles(xArr[k] + u);
      eps[k] = wrapCycles(e[k] - eDig[k]);
    }

    const fl = ref.data.e_ZC_hw;
    if (identicalFrom === null) {
      let same = true;
      for (let k = 0; k < LMS_BATCH; k++) {
        if (e[k] !== fl[k]) {
          same = false;
          break;
        }
      }
      if (same) identicalFrom = it;
    }

    dStart.push(dHat);
    gStart.push(gHat);
    traces.push(e);
    floorTraces.push(Float64Array.from(fl));
    rmsIter.push(rms(e));
    peakIter.push(maxAbs(e));
    rmsFloor.push(rms(fl));
    peakFloor.push(maxAbs(fl));

    // --- LMS pass(每拍一次更新) ---
    const src = useAnalogResidual ? eps : e;
    for (let k = 0; k < LMS_BATCH; k++) {
      const phi1 = jArr[k] === LMS_TAP ? 1 : 0;
      const phi2 = cArr[k] / 64;
      const r = src[k] - (dHat * phi1 + gHat * phi2);
      dHat = dHat + mu * r * phi1;
      gHat = gHat + mu * r * phi2;
      dHist[n] = dHat;
      gHist[n] = gHat;
      n += 1;
    }
  }

  return {
    dHist,
    gHist,
    dStart,
    gStart,
    traces,
    floorTraces,
    rmsIter,
    peakIter,
    rmsFloor,
    peakFloor,
    dTrue: tapDeg * DEG,
    gTrue: (gainPct / 100) * GAMMA_SCALE,
    identicalFrom,
  };
}

/* ==================================================================
 * Monte Carlo mismatch(K = 64 組隨機 mismatch,EXPERIMENT)
 *
 * 每個 sample s 用獨立的 Mulberry32(MODEL_SPEC §12)stream:
 *     seed = MC_SEED + s        (per-sample stream offset,完全決定性)
 * 抽樣順序固定為 tap j = 0…7 → dtc_fb_gain → dtc_inj_gain(共 10 個
 * gauss()),Python 與 TS 逐位相同。
 * ================================================================== */

const MC_K = 64; // sample 數
const MC_CYCLES = 128; // 每個 sample 的 reference cycles
const MC_SEED = 20250; // base seed(per-sample offset = s)
const MC_BINS = 16;

interface McSeries {
  peaks: Float64Array;
  rmss: Float64Array;
}

interface McResult {
  naive: McSeries;
  calib: McSeries;
}

function runMonteCarlo(nDiv: number, sigTapDeg: number, sigGainPct: number): McResult {
  const out: McResult = {
    naive: { peaks: new Float64Array(MC_K), rmss: new Float64Array(MC_K) },
    calib: { peaks: new Float64Array(MC_K), rmss: new Float64Array(MC_K) },
  };
  for (let s = 0; s < MC_K; s++) {
    const rng = new Mulberry32(MC_SEED + s);
    const taps = new Array<number>(8);
    for (let j = 0; j < 8; j++) {
      taps[j] = sigTapDeg * DEG * rng.gauss();
    }
    const gFb = 1 + (sigGainPct / 100) * rng.gauss();
    const gInj = 1 + (sigGainPct / 100) * rng.gauss();
    const base: Partial<SimConfig> = {
      n_div: nDiv,
      n_cycles: MC_CYCLES,
      quantizer: 'nearest',
      arch_mode: 'D',
      inj_model: 'none',
      tap_mismatch_cycles: taps,
      dtc_fb_gain: gFb,
      dtc_inj_gain: gInj,
    };
    const runs: [keyof McResult, SimConfig['inj_mapping']][] = [
      ['naive', 'naive'],
      ['calib', 'calibrated'],
    ];
    for (const [key, mapping] of runs) {
      const e = simulate(fromPartial({ ...base, inj_mapping: mapping })).data.e_ZC_hw;
      out[key].peaks[s] = maxAbs(e);
      out[key].rmss[s] = rms(e);
    }
  }
  return out;
}

/** nearest-rank 分位數(不內插):index = ceil(p·K) − 1。 */
function quantileNearestRank(x: ArrayLike<number>, p: number): number {
  const s = Array.from(x).sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[i];
}

/**
 * 依 model histogram() 產生的 edges 對單一序列計數(疊圖必須共用 bin);
 * 右邊界閉區間的處理與 measurements.histogram() 完全相同。
 */
function countInBins(x: ArrayLike<number>, edges: Float64Array): number[] {
  const bins = edges.length - 1;
  const mn = edges[0];
  const mx = edges[bins];
  const counts = new Array<number>(bins).fill(0);
  const scale = bins / (mx - mn);
  for (let i = 0; i < x.length; i++) {
    let b = Math.floor((x[i] - mn) * scale);
    if (b === bins) b = bins - 1;
    if (b >= 0 && b < bins) counts[b] += 1;
  }
  return counts;
}

/* ---------------------------------------------------------- 真實模型碼節錄 */

const CODE_EXCERPT = `// web/src/model/tapModel.ts — tap_actual(j) = j/N_TAP + delta_tap[j]
export function tapActual(
  j: number,
  nTap: number = 8,
  deltaTap: readonly number[] | null = null,
): number {
  const d = deltaTap === null ? 0.0 : deltaTap[j];
  return j / nTap + d;
}

// web/src/model/dtcModel.ts — DTCModel constructor(delay table,frozen)
    const denom = nCodes - 1; // 63 for 6-bit
    const table = new Float64Array(nCodes);
    for (let c = 0; c < nCodes; c++) {
      const lut = inlLut === null ? 0.0 : inlLut[c];
      table[c] =
        gain * c * lsbCycles +
        offsetCycles +
        inlSinAmpCycles * Math.sin((2.0 * Math.PI * c) / nCodes) +
        p2 * (c / denom) ** 2 +
        p3 * (c / denom) ** 3 +
        lut +
        dnlCum[c] * lsbCycles;
    }
    this.table = table;

// web/src/model/injectionScheduler.ts — candidates():calibrated 用實測值
      if (calibrated) {
        us[i] = tapTbl[j] + dtcInj.delayCycles(c) + cfg.route_inj_cycles;
      } else {
        us[i] = j / cfg.n_tap + c / g;
      }`;

/** 本檔 chapter-local 迴路的真實碼(與上方 runLmsCalibration / runMonteCarlo 逐字同步)。 */
const LOCAL_CODE_EXCERPT = `// Chapter15.tsx — 用「真實」表評估迴路選中的 (j, c),再做 LMS 更新
    for (let k = 0; k < LMS_BATCH; k++) {
      const u = tapTblTrue[jArr[k]] + dtcTrue.delayCycles(cArr[k]);
      e[k] = wrapCycles(xArr[k] + u);
      eps[k] = wrapCycles(e[k] - eDig[k]);
    }
    ...
    const src = useAnalogResidual ? eps : e;
    for (let k = 0; k < LMS_BATCH; k++) {
      const phi1 = jArr[k] === LMS_TAP ? 1 : 0;
      const phi2 = cArr[k] / 64;
      const r = src[k] - (dHat * phi1 + gHat * phi2);
      dHat = dHat + mu * r * phi1;
      gHat = gHat + mu * r * phi2;

// Chapter15.tsx — Monte Carlo:per-sample stream offset,抽樣順序固定
    const rng = new Mulberry32(MC_SEED + s);
    const taps = new Array<number>(8);
    for (let j = 0; j < 8; j++) {
      taps[j] = sigTapDeg * DEG * rng.gauss();
    }
    const gFb = 1 + (sigGainPct / 100) * rng.gauss();
    const gInj = 1 + (sigGainPct / 100) * rng.gauss();`;

/* ---------------------------------------------------------------- 章節主體 */

type NDivStr = '3.125' | '3.13' | '3.1375';
type SignalName = 'e_ZC_hw' | 'e_ZC_total';

/** global N -> Ch15 的受限選單值(本章僅支援這三個 N;其他值不改變本章狀態) */
function toNDivStr(n: number): NDivStr | null {
  if (n === 3.125) return '3.125';
  if (n === 3.13) return '3.13';
  if (n === 3.1375) return '3.1375';
  return null;
}

/* ---------------------------------------------------------------------------
 * 數值例子(SectionExample):三個互動 worked example。
 * compute 皆為 pure function,mismatch 數學全部走 ../model
 * (tapActual / DTCModel / simulate / wrapCycles / qFloor / dtcLsbS /
 * cyclesToTime),沒有任何寫死的答案常數。
 * ------------------------------------------------------------------------- */

const EX_N_SIM = 128; // 例 3 的模擬長度

const EX_SCALE_INPUTS = [
  { key: 'tapDeg', label: <>tap mismatch</>, def: 1, min: -45, max: 45, step: 0.05, unit: '°' },
  { key: 'gainPct', label: <>DTC gain error</>, def: 1, min: -20, max: 20, step: 0.05, unit: '%' },
  { key: 'nDiv', label: <M>{'N'}</M>, def: 3.125, min: 2, max: 8, step: 0.001 },
  { key: 'frefGHz', label: <M>{'f_{ref}'}</M>, def: 4, min: 0.1, max: 20, step: 0.1, unit: 'GHz' },
];

function exScaleCompute(v: Record<string, number>) {
  const cfg = fromPartial({ n_div: v.nDiv, f_ref_hz: v.frefGHz * 1e9 });
  const tVco = configTVcoS(cfg);
  const lsbS = dtcLsbS(cfg.n_div, cfg.f_ref_hz);
  const halfS = 0.5 * lsbS;
  const nCodes = 1 << cfg.b_dtc; // 64 codes = T_vco/4 full range
  const tapS = cyclesToTime(v.tapDeg / 360, tVco); // 1 cycle = 360°
  const fullRangeS = nCodes * lsbS;
  const gainS = (v.gainPct / 100) * fullRangeS;
  return {
    steps: [
      {
        label: (
          <>
            <M>{'T_{vco} = 1/(N f_{ref})'}</M>
          </>
        ),
        value: fmt(tVco * 1e12, 6, 'ps'),
      },
      {
        label: <>1 LSB / half-LSB</>,
        value: `${fmt(lsbS * 1e15, 6, 'fs')} / ${fmt(halfS * 1e15, 6, 'fs')}`,
      },
      {
        label: (
          <>
            tap mismatch <M>{'\\theta\\,T_{vco}/360'}</M>
          </>
        ),
        value: `${fmt(tapS * 1e15, 6, 'fs')} = ${fmt(tapS / lsbS, 6, 'LSB')}`,
      },
      {
        label: (
          <>
            DTC full range = <M>{'2^{b}'}</M> LSB = <M>{'T_{vco}/4'}</M>
          </>
        ),
        value: `${fmt(fullRangeS * 1e12, 6, 'ps')} (${nCodes} LSB)`,
      },
      {
        label: <>gain error × full range</>,
        value: `${fmt(gainS * 1e15, 6, 'fs')} = ${fmt(gainS / lsbS, 6, 'LSB')}`,
      },
      {
        label: <>各自相對 half-LSB 的倍數</>,
        value: `${fmt(Math.abs(tapS) / halfS, 6)}× / ${fmt(Math.abs(gainS) / halfS, 6)}×`,
      },
    ],
    answer: (
      <>
        tap {fmt(v.tapDeg, 6)}° = {fmt(tapS * 1e15, 6, 'fs')} = {fmt(tapS / lsbS, 6, 'LSB')};gain{' '}
        {fmt(v.gainPct, 6)}% = {fmt(gainS * 1e15, 6, 'fs')} = {fmt(gainS / lsbS, 6, 'LSB')}
      </>
    ),
    warn:
      Math.abs(tapS) > halfS || Math.abs(gainS) > halfS
        ? '至少一項單獨就超過 half-LSB — 未校正的 analog mismatch 已吃光整個量化預算'
        : undefined,
  };
}

const EX_DECODE_INPUTS = [
  { key: 'j', label: <>tap index <M>{'j'}</M></>, def: 3, min: 0, max: 7, step: 1 },
  { key: 'c', label: <>DTC code <M>{'c'}</M></>, def: 20, min: 0, max: 63, step: 1 },
  { key: 'gain', label: <>DTC gain <M>{'g'}</M></>, def: 1.01, min: 0.8, max: 1.2, step: 0.001 },
  {
    key: 'inlLsb',
    label: (
      <>
        sinusoidal INL <M>{'a_{INL}'}</M>
      </>
    ),
    def: 0.5,
    min: -8,
    max: 8,
    step: 0.05,
    unit: 'LSB',
  },
];

function exDecodeCompute(v: Record<string, number>) {
  const cfg = fromPartial({}); // N = 3.125,T_vco = 80 ps(章節基準)
  const g = configG(cfg);
  const tVco = configTVcoS(cfg);
  const lsbS = dtcLsbS(cfg.n_div, cfg.f_ref_hz);
  const j = qFloor(v.j);
  const c = qFloor(v.c);
  const tapCyc = tapActual(j, cfg.n_tap, null); // j/8 + delta_tap[j](此例 delta = 0)
  const dtc = new DTCModel({
    nCodes: 1 << cfg.b_dtc,
    lsbCycles: 1 / g,
    gain: v.gain,
    offsetCycles: 0,
    inlSinAmpCycles: v.inlLsb / g,
    inlPoly: [0, 0],
  });
  const dtcCyc = dtc.delayCycles(c);
  const dtcIdealCyc = dtc.idealDelayCycles(c);
  const uActual = tapCyc + dtcCyc;
  const uIdeal = j / cfg.n_tap + c / g;
  const err = uActual - uIdeal;
  return {
    steps: [
      {
        label: (
          <>
            <M>{'\\mathrm{tap}_{actual}(j) = j/8 + \\delta_{tap}[j]'}</M>
          </>
        ),
        value: fmt(tapCyc, 8, 'cyc'),
      },
      {
        label: (
          <>
            理想 DTC 段 <M>{'c\\,\\mathrm{LSB}'}</M>
          </>
        ),
        value: `${fmt(dtcIdealCyc, 8, 'cyc')} = ${fmt(c, 6, 'LSB')}`,
      },
      {
        label: (
          <>
            gain 貢獻 <M>{'(g-1)c\\,\\mathrm{LSB}'}</M>
          </>
        ),
        value: fmt((v.gain - 1) * c, 6, 'LSB'),
      },
      {
        label: (
          <>
            INL 貢獻 <M>{'a_{INL}\\sin(2\\pi c/64)'}</M>
          </>
        ),
        value: fmt(v.inlLsb * Math.sin((2 * Math.PI * c) / (1 << cfg.b_dtc)), 6, 'LSB'),
      },
      {
        label: (
          <>
            <M>{'\\mathrm{DTC}_{actual}(c)'}</M>
          </>
        ),
        value: fmt(dtcCyc, 8, 'cyc'),
      },
      {
        label: (
          <>
            <M>{'u_{INJ,analog} = \\mathrm{tap}_{actual} + \\mathrm{DTC}_{actual}'}</M>
          </>
        ),
        value: fmt(uActual, 8, 'cyc'),
      },
      {
        label: (
          <>
            理想 <M>{'j/8 + c/G'}</M>
          </>
        ),
        value: fmt(uIdeal, 8, 'cyc'),
      },
      {
        label: <>誤差 actual − ideal</>,
        value: `${fmt(err * g, 6, 'LSB')} = ${fmt(cyclesToTime(err, tVco) * 1e15, 6, 'fs')}`,
      },
    ],
    answer: (
      <>
        <M>{'u_{INJ,analog}'}</M> = {fmt(uActual, 8, 'cyc')},誤差 = {fmt(err * g, 6, 'LSB')} ={' '}
        {fmt(cyclesToTime(err, tVco) * 1e15, 6, 'fs')}
      </>
    ),
    warn:
      Math.abs(err * g) > 0.5
        ? `誤差 ${fmt(err * g, 4)} LSB 已超過 half-LSB(${fmt(lsbS * 0.5e15, 4)} fs);naive mapping 無法補償,需要 calibrated argmin`
        : undefined,
  };
}

const EX_ZC_INPUTS = [
  { key: 'nDiv', label: <M>{'N'}</M>, def: 3.13, min: 3, max: 3.25, step: 0.001 },
  { key: 'k', label: <M>{'k'}</M>, def: 7, min: 0, max: EX_N_SIM - 1, step: 1 },
  {
    key: 'gainPct',
    label: (
      <>
        INJ DTC gain error
      </>
    ),
    def: 1,
    min: -10,
    max: 10,
    step: 0.05,
    unit: '%',
  },
  {
    key: 'routeLsb',
    label: <>route<sub>INJ</sub> skew</>,
    def: 0.5,
    min: -32,
    max: 32,
    step: 0.05,
    unit: 'LSB',
  },
];

function exZcCompute(v: Record<string, number>) {
  const base = {
    n_div: v.nDiv,
    n_cycles: EX_N_SIM,
  };
  const cfgIdeal = fromPartial(base);
  const cfgReal = fromPartial({
    ...base,
    dtc_inj_gain: 1 + v.gainPct / 100,
    route_inj_cycles: v.routeLsb / configG(cfgIdeal),
  });
  const g = configG(cfgReal);
  const tVco = configTVcoS(cfgReal);
  const resReal = simulate(cfgReal);
  const resIdeal = simulate(cfgIdeal);
  const k = Math.min(EX_N_SIM - 1, Math.max(0, qFloor(v.k)));
  const d = resReal.data;
  const eReal = d.e_ZC_hw[k];
  const eIdeal = resIdeal.data.e_ZC_hw[k];
  const delta = wrapCycles(eReal - eIdeal);
  return {
    steps: [
      {
        label: (
          <>
            <M>{'x_{ideal}[k]'}</M>
          </>
        ),
        value: fmt(d.x_ideal[k], 8, 'cyc'),
      },
      {
        label: (
          <>
            <M>{'u_{INJ,ideal}[k] = \\operatorname{wrap01}(z_0 - x)'}</M>
          </>
        ),
        value: fmt(d.u_INJ_ideal[k], 8, 'cyc'),
      },
      {
        label: (
          <>
            <M>{'R_{INJ}[k]'}</M>(arch D:<M>{'(R_{zero}-R_{FB})\\bmod G'}</M>)
          </>
        ),
        value: `${d.R_INJ[k]} / ${g} LSB`,
      },
      {
        label: (
          <>
            naive decode <M>{'(j, c)'}</M>
          </>
        ),
        value: `j = ${d.j_INJ[k]}, c = ${d.c_INJ[k]}`,
      },
      {
        label: (
          <>
            <M>{'u_{INJ,digital} = R_{INJ}/G'}</M>
          </>
        ),
        value: fmt(d.u_INJ_digital[k], 8, 'cyc'),
      },
      {
        label: (
          <>
            <M>{'u_{INJ,analog} = \\mathrm{tap} + \\mathrm{DTC}_{actual} + \\mathrm{route}'}</M>
          </>
        ),
        value: fmt(d.u_INJ_analog[k], 8, 'cyc'),
      },
      {
        label: (
          <>
            <M>{'e_{ZC,hw} = \\operatorname{wrapCycles}(x + u_{INJ,analog} - z_0)'}</M>
          </>
        ),
        value: `${fmt(eReal * g, 6, 'LSB')} = ${fmt(cyclesToTime(eReal, tVco) * 1e15, 6, 'fs')}`,
      },
      {
        label: <>同一拍、關掉所有 mismatch 的 e_ZC,hw(純量化殘差)</>,
        value: fmt(eIdeal * g, 6, 'LSB'),
      },
      {
        label: <>mismatch 淨貢獻(gain × c + route)</>,
        value: fmt(delta * g, 6, 'LSB'),
      },
    ],
    answer: (
      <>
        <M>{'e_{ZC,hw}[k]'}</M> = {fmt(eReal * g, 6, 'LSB')} ={' '}
        {fmt(cyclesToTime(eReal, tVco) * 1e15, 6, 'fs')};其中量化只佔{' '}
        {fmt(eIdeal * g, 6, 'LSB')},mismatch 佔 {fmt(delta * g, 6, 'LSB')}
      </>
    ),
    warn:
      Math.abs(eReal * g) > 0.5
        ? `總誤差 ${fmt(eReal * g, 4)} LSB > half-LSB:mismatch 主導,量化預算已被吃光`
        : undefined,
  };
}

export default function Chapter15() {
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const { nDiv: globalNDiv, setNDiv: setGlobalNDiv } = useGlobalNDiv();
  const [nDivStr, setNDivStrState] = useState<NDivStr>(() => toNDivStr(globalNDiv) ?? '3.13');
  useEffect(() => {
    const s = toNDivStr(globalNDiv);
    if (s !== null) setNDivStrState((prev) => (prev === s ? prev : s));
  }, [globalNDiv]);
  const setNDivStr = (v: NDivStr) => {
    setNDivStrState(v);
    setGlobalNDiv(Number(v));
  };
  const [tapDeg, setTapDeg] = useState(1.0);
  const [tapPattern, setTapPattern] = useState<'uniform' | 'alt'>('uniform');
  const [gainPct, setGainPct] = useState(1.0);
  const [inlAmpLsb, setInlAmpLsb] = useState(0.5);
  const [exag, setExag] = useState(20);
  const [signal, setSignal] = useState<SignalName>('e_ZC_hw');
  const [enabled, setEnabled] = useState<Record<string, boolean>>(DEFAULT_ENABLED);
  // --- 背景 LMS 校正 ---
  const [calMu, setCalMu] = useState(0.2);
  const [calPreset, setCalPreset] = useState<MismatchPreset>('both');
  const [calAnalogResid, setCalAnalogResid] = useState(true);
  const [calIter, setCalIter] = useState(0);
  const [calPlaying, setCalPlaying] = useState(false);
  // --- Monte Carlo mismatch ---
  const [sigTapDeg, setSigTapDeg] = useState(1.0);
  const [sigGainPct, setSigGainPct] = useState(1.0);

  const nDiv = Number(nDivStr);
  const tapArr = useMemo(() => tapPatternArr(tapPattern, tapDeg), [tapPattern, tapDeg]);

  // joint config:所有開啟的 knob 同時套用(analog 誤差疊加於 digital 值之後)
  const jointCfg = useMemo(() => {
    const p = { tapArr, gain: 1 + gainPct / 100, inlAmpCyc: inlAmpLsb * LSB };
    let over: Partial<SimConfig> = {
      n_div: nDiv,
      n_cycles: N_CYCLES,
      quantizer: 'nearest',
      arch_mode: 'D',
      inj_mapping: 'naive',
      inj_model: signal === 'e_ZC_total' ? 'sin' : 'none',
      k_inj: 0.3,
    };
    for (const kb of KNOBS) {
      if (enabled[kb.id]) over = { ...over, ...knobOverrides(kb.id, p) };
    }
    return fromPartial(over);
  }, [nDiv, tapArr, gainPct, inlAmpLsb, signal, enabled]);

  const tVco = configTVcoS(jointCfg);

  // §16 error decomposition:baseline(全 ideal)→ 逐項單獨開啟 → joint
  const decomp = useMemo(() => decompose(jointCfg, signal), [jointCfg, signal]);

  // naive vs calibrated mapping(同一組 mismatch;e_ZC_hw 為 deterministic 量)
  const nvc = useMemo(() => {
    const cfgN = fromPartial({ ...jointCfg, inj_mapping: 'naive', inj_model: 'none' });
    const cfgC = fromPartial({ ...jointCfg, inj_mapping: 'calibrated', inj_model: 'none' });
    const rN = simulate(cfgN);
    const rC = simulate(cfgC);
    const toPairs = (a: Float64Array): [number, number][] =>
      Array.from(a, (v, k) => [k, v] as [number, number]);
    return {
      naive: toPairs(rN.data.e_ZC_hw),
      calib: toPairs(rC.data.e_ZC_hw),
      rmsNaive: rms(rN.data.e_ZC_hw),
      rmsCalib: rms(rC.data.e_ZC_hw),
    };
  }, [jointCfg]);

  /* --------------- 背景 LMS 校正(post-paint;96 × 64 cycles) --------------- */
  const [lms, setLms] = useState<LmsResult | null>(null);
  useEffect(() => {
    setLms(null);
    setCalIter(0);
    setCalPlaying(false);
    const p = MISMATCH_PRESETS[calPreset];
    const id = window.setTimeout(() => {
      setLms(runLmsCalibration(nDiv, calMu, p.tapDeg, p.gainPct, calAnalogResid));
    }, 0);
    return () => window.clearTimeout(id);
  }, [nDiv, calMu, calPreset, calAnalogResid]);

  // 動畫:逐 window 前進(到底回捲)
  useEffect(() => {
    if (!calPlaying || lms === null) return undefined;
    const id = window.setInterval(() => {
      setCalIter((p) => (p + 1) % LMS_ITERS);
    }, 420);
    return () => window.clearInterval(id);
  }, [calPlaying, lms]);

  /* ------------- Monte Carlo mismatch(post-paint;2 × 64 × 128) ------------- */
  const [mc, setMc] = useState<McResult | null>(null);
  useEffect(() => {
    setMc(null);
    const id = window.setTimeout(() => {
      setMc(runMonteCarlo(nDiv, sigTapDeg, sigGainPct));
    }, 0);
    return () => window.clearTimeout(id);
  }, [nDiv, sigTapDeg, sigGainPct]);

  const heavyPending = lms === null || mc === null;
  useEffect(() => {
    if (heavyPending) {
      setStatus(
        'running',
        `Ch15:LMS ${2 * LMS_ITERS} × ${LMS_BATCH} cycles + Monte Carlo 2 × ${MC_K} × ${MC_CYCLES} cycles…`,
      );
    } else {
      setStatus(
        'done',
        `decompose: 13 × ${N_CYCLES} cycles;mapping 比較 2 × ${N_CYCLES};` +
          `LMS ${LMS_ITERS} windows;Monte Carlo K = ${MC_K}`,
      );
    }
  }, [decomp, nvc, heavyPending, setStatus]);

  /* ------------------------------------------------------------ 圖表選項 */

  // decomposition 逐項貢獻 bar chart
  const decompOption = useMemo(() => {
    const cats = [...TERM_LABELS.map((t) => t.label), 'RSS', 'joint'];
    const contrib: (number | null)[] = TERM_LABELS.map(
      (t) => decomp.contributions[t.key] ?? 0,
    );
    contrib.push(null, null);
    const totals: (number | null)[] = TERM_LABELS.map(() => null);
    totals.push(decomp.rss_reference_rms, decomp.joint_total_rms_cycles);
    const opt = makeLineOption({
      xLabel: 'error term(MODEL_SPEC §16)',
      yLabel: phaseAxisLabel(`rms Δ${signal}`, unit, tVco),
      yTickFormatter: makePhaseTickFormatter(unit, tVco),
      xType: 'category',
      categories: cats,
      zoom: false,
      series: [
        { name: '單項貢獻 rms', data: contrib, type: 'bar', color: ct.accent },
        { name: 'RSS / joint total', data: totals, type: 'bar', color: ct.warn },
      ],
    });
    (opt as unknown as { series: Record<string, unknown>[] }).series[0].markLine = makeMarkLine([
      { y: HALF_LSB, label: `half-LSB ${formatPhase(HALF_LSB, unit, tVco)}`, color: ct.bad },
    ]);
    return opt;
  }, [decomp, signal, unit, tVco, ct]);

  // #26 DTC INL plot:sin / poly / LUT 三種 INL + gain 斜率誤差(單位 LSB)
  const inlOption = useMemo(() => {
    const amp = inlAmpLsb * LSB;
    const models: { name: string; m: DTCModel }[] = [
      { name: `sin INL(a=${trimNumber(inlAmpLsb, 3)} LSB)`, m: new DTCModel({ inlSinAmpCycles: amp }) },
      { name: 'poly INL(p2=0.5, p3=−0.3 LSB)', m: new DTCModel({ inlPoly: [0.5 * LSB, -0.3 * LSB] }) },
      { name: 'LUT INL(0.3 LSB 三角形)', m: new DTCModel({ inlLut: triLut(0.3 * LSB) }) },
      { name: `gain error(${trimNumber(gainPct, 3)}%)`, m: new DTCModel({ gain: 1 + gainPct / 100 }) },
    ];
    const toLsb = (m: DTCModel): [number, number][] =>
      Array.from({ length: 64 }, (_, c) => [c, (m.delayCycles(c) - c * LSB) / LSB]);
    const opt = makeLineOption({
      xLabel: 'DTC code c (0..63)',
      yLabel: 'delay error(LSB)',
      zoom: false,
      series: models.map((s, i) => ({
        name: s.name,
        data: toLsb(s.m),
        color: ct.series[i % ct.series.length],
        showSymbol: false,
      })),
    });
    (opt as unknown as { series: Record<string, unknown>[] }).series[0].markLine = makeMarkLine([
      { y: 0.5, label: 'half-LSB = 0.5 LSB', color: ct.bad },
      { y: -0.5, color: ct.bad },
    ]);
    return opt;
  }, [inlAmpLsb, gainPct, ct]);

  // naive vs calibrated e_ZC_hw 時序
  const nvcOption = useMemo(() => {
    const opt = makeLineOption({
      xLabel: 'k(reference cycle;sample rate = f_ref)',
      yLabel: phaseAxisLabel('e_ZC_hw', unit, tVco),
      yTickFormatter: makePhaseTickFormatter(unit, tVco),
      series: [
        { name: 'naive floor mapping', data: nvc.naive, step: 'middle', color: ct.series[1] },
        { name: 'calibrated mapping', data: nvc.calib, step: 'middle', color: ct.series[2] },
      ],
    });
    (opt as unknown as { series: Record<string, unknown>[] }).series[0].markLine = makeMarkLine([
      { y: HALF_LSB, label: '+half-LSB', color: ct.bad },
      { y: -HALF_LSB, label: '−half-LSB', color: ct.bad },
    ]);
    return opt;
  }, [nvc, unit, tVco, ct]);

  /* ------------------------------------------- 背景 LMS 校正:三張圖 */

  // (1) 參數收斂:δ̂ 與 γ̂ vs LMS 更新次數
  const calParamOption = useMemo(() => {
    if (lms === null) return null;
    const dPts: [number, number][] = [];
    const gPts: [number, number][] = [];
    for (let i = 0; i < lms.dHist.length; i++) {
      dPts.push([i, lms.dHist[i]]);
      gPts.push([i, lms.gHist[i]]);
    }
    const opt = makeLineOption({
      xLabel: `LMS 更新次數 n(= it × ${LMS_BATCH} + k;每拍一次)`,
      yLabel: phaseAxisLabel('參數估計', unit, tVco),
      yTickFormatter: makePhaseTickFormatter(unit, tVco),
      series: [
        { name: 'δ̂ (tap 3 offset)', data: dPts, color: ct.series[0], showSymbol: false },
        { name: 'γ̂ (DTC gain @ full range)', data: gPts, color: ct.series[1], showSymbol: false },
      ],
    });
    (opt as unknown as { series: Record<string, unknown>[] }).series[0].markLine = makeMarkLine([
      { y: lms.dTrue, label: 'δ_true', color: ct.good },
      { y: lms.gTrue, label: 'γ_true', color: ct.warn },
      { x: LMS_BATCH, color: ct.textSubtle },
    ]);
    return opt;
  }, [lms, unit, tVco, ct]);

  // (2) 殘差收斂曲線:每個 window 的 rms / peak vs calibrated floor
  const calResidOption = useMemo(() => {
    if (lms === null) return null;
    const pts = (a: number[]): [number, number][] => a.map((v, i) => [i, v]);
    const opt = makeLineOption({
      xLabel: `window index it(每個 window = ${LMS_BATCH} cycles)`,
      yLabel: phaseAxisLabel('|e_ZC_hw| 統計量', unit, tVco),
      yTickFormatter: makePhaseTickFormatter(unit, tVco),
      zoom: false,
      series: [
        { name: 'peak(LMS)', data: pts(lms.peakIter), color: ct.series[1], showSymbol: true, symbolSize: 4 },
        { name: 'rms(LMS)', data: pts(lms.rmsIter), color: ct.series[0], showSymbol: true, symbolSize: 4 },
        { name: 'peak(floor)', data: pts(lms.peakFloor), color: ct.series[3], dashed: true },
        { name: 'rms(floor)', data: pts(lms.rmsFloor), color: ct.series[2], dashed: true },
      ],
    });
    (opt as unknown as { series: Record<string, unknown>[] }).series[0].markLine = makeMarkLine([
      { y: HALF_LSB, label: `half-LSB ${formatPhase(HALF_LSB, unit, tVco)}`, color: ct.bad },
      { x: calIter, label: `it = ${calIter}`, color: ct.accent },
    ]);
    return opt;
  }, [lms, calIter, unit, tVco, ct]);

  // (3) before / after 誤差軌跡(動畫:目前 window)
  const calTraceOption = useMemo(() => {
    if (lms === null) return null;
    const pts = (a: Float64Array): [number, number][] =>
      Array.from(a, (v, k) => [k, v] as [number, number]);
    const opt = makeLineOption({
      xLabel: `k(window 內的 reference cycle,0…${LMS_BATCH - 1})`,
      yLabel: phaseAxisLabel('e_ZC_hw', unit, tVco),
      yTickFormatter: makePhaseTickFormatter(unit, tVco),
      zoom: false,
      series: [
        {
          name: 'before:window 0(未校正)',
          data: pts(lms.traces[0]),
          step: 'middle',
          color: ct.series[1],
        },
        {
          name: `after:window ${calIter}(LMS)`,
          data: pts(lms.traces[calIter]),
          step: 'middle',
          color: ct.series[0],
        },
        {
          name: 'calibrated floor(完美已知)',
          data: pts(lms.floorTraces[calIter]),
          step: 'middle',
          color: ct.series[2],
          dashed: true,
        },
      ],
    });
    (opt as unknown as { series: Record<string, unknown>[] }).series[0].markLine = makeMarkLine([
      { y: HALF_LSB, label: '+half-LSB', color: ct.bad },
      { y: -HALF_LSB, label: '−half-LSB', color: ct.bad },
    ]);
    return opt;
  }, [lms, calIter, unit, tVco, ct]);

  /* --------------------------------- Monte Carlo:兩張直方圖 + 統計 */

  const mcStats = useMemo(() => {
    if (mc === null) return null;
    const q = (a: Float64Array) => ({
      med: quantileNearestRank(a, 0.5),
      p95: quantileNearestRank(a, 0.95),
      min: quantileNearestRank(a, 0),
      max: quantileNearestRank(a, 1),
    });
    return {
      naivePeak: q(mc.naive.peaks),
      naiveRms: q(mc.naive.rmss),
      calibPeak: q(mc.calib.peaks),
      calibRms: q(mc.calib.rmss),
    };
  }, [mc]);

  const mcOptions = useMemo(() => {
    if (mc === null) return null;
    const build = (naiveArr: Float64Array, calibArr: Float64Array, xLabel: string) => {
      // 疊圖必須共用 bin:用兩組樣本的聯集決定 edges(model histogram())
      const all = new Float64Array(2 * MC_K);
      all.set(naiveArr, 0);
      all.set(calibArr, MC_K);
      const { edges } = histogram(all, MC_BINS);
      const centers = Array.from({ length: MC_BINS }, (_, i) => 0.5 * (edges[i] + edges[i + 1]));
      const toPts = (counts: number[]): [number, number][] =>
        counts.map((c, i) => [centers[i], c] as [number, number]);
      const opt = makeLineOption({
        xLabel,
        yLabel: `樣本數(每 bin;K = ${MC_K})`,
        xTickFormatter: makePhaseTickFormatter(unit, tVco),
        zoom: false,
        series: [
          {
            name: 'naive mapping',
            data: toPts(countInBins(naiveArr, edges)),
            step: 'middle',
            area: true,
            color: ct.series[1],
          },
          {
            name: 'calibrated mapping',
            data: toPts(countInBins(calibArr, edges)),
            step: 'middle',
            area: true,
            color: ct.series[2],
          },
        ],
      });
      (opt as unknown as { series: Record<string, unknown>[] }).series[0].markLine = makeMarkLine([
        { x: HALF_LSB, label: 'half-LSB', color: ct.bad },
        { x: LSB, label: '1 LSB', color: ct.textSubtle },
      ]);
      return opt;
    };
    return {
      peak: build(mc.naive.peaks, mc.calib.peaks, phaseAxisLabel('peak |e_ZC_hw|', unit, tVco)),
      rms: build(mc.naive.rmss, mc.calib.rmss, phaseAxisLabel('rms e_ZC_hw', unit, tVco)),
    };
  }, [mc, unit, tVco, ct]);

  /* ------------------------------------------------------------ 顯示資料 */

  const wheelMarkers = useMemo(
    () =>
      tapArr.map((d, j) => ({
        angleCycles: j / 8 + exag * d,
        color: ct.warn,
        r: 1.0,
      })),
    [tapArr, exag, ct],
  );

  const wheelTaps = useMemo(
    () =>
      Array.from({ length: 8 }, (_, j) => ({
        angleCycles: j / 8,
        label: `j${j}`,
      })),
    [],
  );

  const tapRows = useMemo(
    () =>
      tapArr.map((d, j) => ({
        j,
        ideal_cycles: j / 8,
        delta_deg: 360 * d,
        delta_fs: (d * tVco) / 1e-15,
        actual_cycles: j / 8 + d,
      })),
    [tapArr, tVco],
  );

  const knobMagnitude = (id: string): string => {
    switch (id) {
      case 'tap':
        return `${tapPattern === 'uniform' ? '+' : '±'}${trimNumber(tapDeg, 3)}°(slider)`;
      case 'pmux':
        return '±0.3 LSB pattern';
      case 'gain_fb':
      case 'gain_inj':
        return `${trimNumber(gainPct, 3)}%(slider)`;
      case 'offset':
        return '+0.5 LSB(FB 與 INJ)';
      case 'inl_sin':
        return `${trimNumber(inlAmpLsb, 3)} LSB(slider)`;
      case 'inl_poly':
        return 'p2=0.5, p3=−0.3 LSB';
      case 'inl_lut':
        return '0.3 LSB 三角形';
      case 'dnl':
        return 'σ = 0.05 LSB/step';
      case 'route':
        return 'FB 1 LSB / INJ 2 LSB';
      case 'ref_jitter':
        return '100 fs rms';
      case 'vco_w':
        return '0.01 rad/cycle';
      case 'vco_rw':
        return '0.003 rad/√cycle';
      case 'latency':
        return 'L=1,無 look-ahead';
      case 'p_late':
        return 'p = 0.05';
      case 'pulse':
        return '100 fs rms';
      default:
        return '';
    }
  };

  const oneDegFs = formatSiTime(DEG * tVco, 6);
  const oneDegLsb = trimNumber((DEG * tVco) / (tVco / 256), 4);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            Mode D 使 <M>{'e_{pair,digital} \\equiv 0'}</M> 之後,injection edge 還會被哪些
            analog 誤差推離 zero crossing?MODEL_SPEC §10 的 16 項 nonideality
            各是什麼、量級多大?<EpistemicTag kind="ASSUMPTION" />
          </li>
          <li>
            1° tap mismatch 與 1% DTC gain error 換算成時間各是多少 fs?
            為什麼兩者都超過 half-LSB 156.25 fs?<EpistemicTag kind="EXACT" />
          </li>
          <li>
            如何用 error decomposition(逐項單獨開啟)把 <M>{'e_{ZC}'}</M> 分解成
            per-term 貢獻?可加性(additivity)何時成立?<EpistemicTag kind="APPROX" />
          </li>
          <li>
            calibrated tap/DTC mapping 利用 redundancy 能補回多少 mismatch?
            什麼永遠補不掉?<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            校正表不是天上掉下來的:一個背景 LMS 迴路要多少 cycle 才能同時估出
            injection DTC gain 與一個 tap 的偏移?殘差會停在哪裡?
            <EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            mismatch 是統計量而非單一數字:σ_tap = 1°、σ_gain = 1% 的製程分佈下,
            peak / rms <M>{'e_{ZC,hw}'}</M> 的中位數與 95th percentile 是多少?
            <EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          數位端的恆等式 <M>{'R_{INJ} = (R_{zero} - R_{FB}) \\bmod 256'}</M> 是整數運算,
          永遠位元精確;但把 code 變成真實 edge 的是 analog 電路:8 個 injection tap
          來自 VCO ring 的實體節點,DTC 是 64 級的實體 delay line。製程 mismatch
          使 tap 不會剛好落在 45° 格點上、DTC 的 delay-vs-code 曲線不會是完美直線。
          這些誤差以 cycles 為單位<strong>疊加在 digital 值之後</strong>(MODEL_SPEC §10),
          與量化誤差無關、DSM 也無法預測它們。
        </p>
        <p>
          尺度感是本章重點:injection 的時間預算是 half-LSB = 156.25 fs 這一級
          (N=3.125)。一個看似無害的 1° tap 偏移就是 222 fs、一個 1% 的 DTC gain
          誤差在滿 range 是 200 fs — <strong>單獨一項未校正 analog mismatch
          就足以吃光整個量化預算</strong>。<EpistemicTag kind="INFERENCE" />
          所以第 7 章的 calibrated mapping(用實測 tap/DTC 表做 argmin)
          不是選配而是必需品。
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>
          Injection 端的實際 analog phase(單位 cycles;error = actual − ideal,
          delay 為正,MODEL_SPEC §2):<EpistemicTag kind="ASSUMPTION" />
        </p>
        <MathBlock>
          {'u_{INJ,analog}[k] = \\mathrm{tap}_{actual}(j[k]) + \\mathrm{DTC}_{actual}(c[k]) + \\mathrm{route}_{INJ}'}
        </MathBlock>
        <MathBlock>{'\\mathrm{tap}_{actual}(j) = \\frac{j}{8} + \\delta_{tap}[j]'}</MathBlock>
        <p>DTC 行為模型(§10 之 3–9 項全部落在這條式子;LSB = 1/256 cycle):</p>
        <MathBlock>
          {'\\mathrm{DTC}_{actual}(c) = g\\,c\\,\\mathrm{LSB} + \\mathrm{off} + a_{INL}\\sin\\!\\Big(\\frac{2\\pi c}{64}\\Big) + p_2\\Big(\\frac{c}{63}\\Big)^{2} + p_3\\Big(\\frac{c}{63}\\Big)^{3} + \\mathrm{LUT}[c] + \\mathrm{DNL}_{cum}[c]\\,\\mathrm{LSB}'}
        </MathBlock>
        <p>
          最終 deterministic 的 hardware zero-crossing error(與 <M>{'e_{abs}'}</M>、
          <M>{'e_{pair}'}</M> 不可混淆,MODEL_SPEC §16):<EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {'e_{ZC,hw}[k] = \\operatorname{wrapCycles}\\big(x_{ideal}[k] + u_{INJ,analog}[k] - z_0\\big)'}
        </MathBlock>
        <p>Error decomposition 的定義(§16;各項為對全 ideal baseline 逐項開啟的 delta):</p>
        <MathBlock>
          {'e_{ZC} = e_{VCO} + e_{ref} + e_{sched} + e_{quant} + e_{DSM} + e_{tap} + e_{gain} + e_{INL} + e_{route} + e_{latency}'}
        </MathBlock>
        <p>
          可加性只在 linear regime 下近似成立<EpistemicTag kind="APPROX" />,
          因此 model 同時輸出 individual contributions、RSS 與 jointly-simulated
          total,並顯示 additivity gap。檢查值(MODEL_SPEC §10,Test 6/7,
          <M>{'T_{vco} = 80\\,\\mathrm{ps}'}</M>):<EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {'1^{\\circ} = \\frac{T_{vco}}{360} = \\frac{80\\,\\mathrm{ps}}{360} = 222.22\\,\\mathrm{fs} \\approx 0.711\\,\\mathrm{LSB}'}
        </MathBlock>
        <MathBlock>
          {'1\\% \\times \\frac{T_{vco}}{4} = 0.01 \\times 20\\,\\mathrm{ps} = 200\\,\\mathrm{fs} \\approx 0.64\\,\\mathrm{LSB}'}
        </MathBlock>
        <p>
          兩者都大於 half-LSB(156.25 fs)。<EpistemicTag kind="INFERENCE" />
        </p>
      </SectionMath>

      <SectionExample>
        <p>手算驗證(N = 3.125,f_vco = 12.5 GHz,T_vco = 80 ps):</p>
        <ol>
          <li>
            1 LSB = 80 ps / 256 = <strong>312.5 fs</strong>;half-LSB =
            <strong> 156.25 fs</strong>。<EpistemicTag kind="EXACT" />
          </li>
          <li>
            1° tap mismatch:80 ps / 360 = <strong>222.22 fs</strong>;
            222.22 / 312.5 = <strong>0.711 LSB</strong>,大於 0.5 LSB。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            DTC full range = T_vco / 4 = 64 LSB = <strong>20 ps</strong>;
            1% gain error 以滿 range 計 = 0.01 × 20 ps =
            <strong> 200 fs</strong> = 200 / 312.5 = <strong>0.64 LSB</strong>,
            也大於 0.5 LSB。<EpistemicTag kind="EXACT" />
          </li>
        </ol>
        <p>
          目前選定的 N = {nDivStr}(T_vco = {formatSiTime(tVco, 6)}):1° ={' '}
          {oneDegFs} = {oneDegLsb} LSB。單位切換:<UnitSwitch />
        </p>

        <ExampleProblem
          index={1}
          tag="EXACT"
          title="尺度換算:1° tap 與 1% gain 各佔幾個 LSB"
          prompt={
            <>
              本章的預算單位是 half-LSB。給定 <M>{'N'}</M> 與 <M>{'f_{ref}'}</M>,先算{' '}
              <M>{'T_{vco}'}</M> 與 1 LSB <M>{'=T_{vco}/256'}</M>;再把 tap mismatch(角度)
              用 <M>{'\\theta\\,T_{vco}/360'}</M> 換成時間、把 DTC gain error 乘上滿 range{' '}
              <M>{'2^{b}\\,\\mathrm{LSB}=T_{vco}/4'}</M>,最後看兩者各是 half-LSB 的幾倍。
            </>
          }
          inputs={EX_SCALE_INPUTS}
          compute={exScaleCompute}
        />

        <ExampleProblem
          index={2}
          tag="APPROX"
          title="tap + DTC 解碼:一組 (j, c) 的實際 injection 相位"
          prompt={
            <>
              injection 端的實際相位是{' '}
              <M>{'u_{INJ,analog}=\\mathrm{tap}_{actual}(j)+\\mathrm{DTC}_{actual}(c)'}</M>。取{' '}
              <M>{'\\mathrm{tap}_{actual}(j)=j/8'}</M>(此例 <M>{'\\delta_{tap}=0'}</M>)與{' '}
              <M>{'\\mathrm{DTC}_{actual}(c)=g\\,c\\,\\mathrm{LSB}+a_{INL}\\sin(2\\pi c/64)'}</M>,
              算出實際相位、與理想 <M>{'j/8+c/G'}</M> 的差,並換算成 LSB 與 fs
              (<M>{'N=3.125'}</M>,<M>{'T_{vco}=80'}</M> ps)。
            </>
          }
          inputs={EX_DECODE_INPUTS}
          compute={exDecodeCompute}
        />

        <ExampleProblem
          index={3}
          tag="EXPERIMENT"
          title="Code round-trip:e_ZC,hw 中量化與 mismatch 各佔多少"
          prompt={
            <>
              跑 {EX_N_SIM} 拍模擬,取第 k 拍走完整條鏈:
              <M>{'x_{ideal}\\to u_{INJ,ideal}\\to R_{INJ}\\to (j,c)\\to u_{INJ,analog}'}</M>,
              最後得 <M>{'e_{ZC,hw}=\\operatorname{wrapCycles}(x+u_{INJ,analog}-z_0)'}</M>。
              再跑一次<strong>關掉全部 mismatch</strong> 的同組態,把總誤差拆成「純量化殘差」與
              「mismatch 淨貢獻(<M>{'(g-1)c'}</M> + route)」兩部分。
            </>
          }
          inputs={EX_ZC_INPUTS}
          compute={exZcCompute}
        />
      </SectionExample>

      <SectionFigure
        title="圖 #25 — Tap mismatch polar plot(8-tap phase wheel)"
        caption={
          <span>
            灰點 = ideal tap 位置(j/8 cycle,45° 間距);彩色 needle = 加上{' '}
            <M>{'\\delta_{tap}[j]'}</M> 後的 actual 位置,角度偏移已放大 {exag}× 以便觀察
            (實際 1° 在圖上幾乎不可見)。表格為未放大的真實值;delta_fs 欄位顯示
            每個 tap 的時間偏移(1° ≈ {oneDegFs})。
          </span>
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-start' }}>
          <PhaseWheel
            taps={wheelTaps}
            markers={wheelMarkers}
            size={280}
            title={`pattern = ${tapPattern},δ = ${trimNumber(tapDeg, 3)}°,顯示放大 ${exag}×`}
          />
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <DebugTable
              columns={[
                { key: 'j', label: 'j' },
                { key: 'ideal_cycles', label: 'ideal (cyc)' },
                { key: 'delta_deg', label: 'δ (°)', fmt: (v) => `${trimNumber(Number(v), 4)}°` },
                { key: 'delta_fs', label: 'δ (fs)', fmt: (v) => `${trimNumber(Number(v), 5)} fs` },
                { key: 'actual_cycles', label: 'actual (cyc)', fmt: (v) => trimNumber(Number(v), 6) },
              ]}
              rows={tapRows}
              maxHeight={260}
              exportName="ch15_tap_mismatch.csv"
            />
          </div>
        </div>
      </SectionFigure>

      <SectionFigure
        title="圖 #26 — DTC INL plot(sin / poly / LUT / gain)"
        caption={
          <span>
            橫軸 DTC code c(0..63),縱軸 delay 誤差(actual − ideal,單位 LSB;
            1 LSB = {formatSiTime(tVco / 256, 5)} @ N={nDivStr})。sin INL 週期 =
            全部 64 codes(c=16 最大、c=48 最小);poly 為單調彎曲;LUT 為使用者輸入的
            三角形範例;gain error 是通過原點的斜線,c=63 處達{' '}
            {trimNumber(0.63 * gainPct, 3)} LSB。紅虛線 = ±half-LSB。
          </span>
        }
      >
        <EChart option={inlOption} height={320} group="ch15" />
      </SectionFigure>

      <SectionFigure
        title="Error decomposition — 逐項貢獻(MODEL_SPEC §16,decompose())"
        caption={
          <span>
            每根藍色 bar = 只開啟該項、其餘全 ideal 時,{signal} 相對 baseline 之
            per-cycle delta 的 rms<EpistemicTag kind="EXPERIMENT" />;黃色 bar = RSS
            (各項平方和開根號,僅作 uncorrelated 參考)與 jointly-simulated total。
            additivity gap = {formatPhase(decomp.additivity_gap_cycles, unit, tVco)}
            (逐 cycle 線性和殘差 rms[(joint−base) − Σ(term−base)],§16;
            linear regime 下應接近 0<EpistemicTag kind="APPROX" />)。
            紅虛線 = half-LSB。下表 16 個 knob 可逐項 enable/disable(§10 完整清單);
            多個 knob 映射到同一分解項時(如 3+4 → gain)會合併模擬。
          </span>
        }
      >
        <EChart option={decompOption} height={320} group="ch15" />
        <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>nonideality(§10)</th>
                <th>SimConfig 欄位</th>
                <th>本章量值</th>
                <th>分解項</th>
                <th>enable</th>
              </tr>
            </thead>
            <tbody>
              {KNOBS.map((kb) => (
                <tr key={kb.id}>
                  <td>{kb.no}</td>
                  <td>{kb.name}</td>
                  <td>
                    <code>{kb.field}</code>
                  </td>
                  <td>{knobMagnitude(kb.id)}</td>
                  <td>
                    <code>{kb.term}</code>
                  </td>
                  <td>
                    <Toggle
                      label=""
                      checked={enabled[kb.id] ?? false}
                      onChange={(v) => setEnabled((e) => ({ ...e, [kb.id]: v }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionFigure>

      <SectionFigure
        title="Naive vs calibrated mapping(同一組 mismatch)"
        caption={
          <span>
            兩條線用完全相同的 mismatch 設定,只換 tap/DTC decode 方式。rms:naive ={' '}
            {formatPhase(nvc.rmsNaive, unit, tVco)},calibrated ={' '}
            {formatPhase(nvc.rmsCalib, unit, tVco)}。<EpistemicTag kind="EXPERIMENT" />
            calibrated 利用 redundancy(tap 間距 32 LSB、DTC range 64 LSB,同一 target
            有兩組 (j,c) 解)在實測表上做 argmin,可避開偏移最大的 tap 或 DTC 區段
            (對應 experiment 12/13/14/19)。紅虛線 = ±half-LSB。
          </span>
        }
      >
        <EChart option={nvcOption} height={320} group="ch15" />
      </SectionFigure>

      <SectionFigure
        title="校正動態 — 背景 LMS 同時估計 tap 3 偏移與 injection DTC gain"
        caption={
          <span>
            <strong>迴路設定</strong>:硬體(plant)只有兩項失配 —— tap {LMS_TAP} 偏移{' '}
            <M>{'\\delta'}</M> 與 INJ DTC gain <M>{'g'}</M>;校正引擎持有估計值{' '}
            <M>{'\\hat{\\delta}, \\hat{\\gamma}'}</M>(<M>{'\\gamma \\equiv (g-1)\\cdot 64\\,\\mathrm{LSB}'}</M>,
            把 gain 誤差換算成「滿 range 的時間誤差」,於是兩個參數同單位、同量級,
            單一 <M>{'\\mu'}</M> 即可)。每個 window({LMS_BATCH} 拍)用當時的估計表
            重建 calibrated argmin 候選,LMS 每拍更新一次:
            <M>{'\\theta \\leftarrow \\theta + \\mu\\, r\\, \\varphi'}</M>,
            <M>{'\\varphi_1 = \\mathbf{1}\\{j=3\\}'}</M>、<M>{'\\varphi_2 = c/64'}</M>。
            <EpistemicTag kind="EXPERIMENT" />
            <br />
            <strong>錨點</strong>(N = 3.13、preset「exp12 + exp13」、<M>{'\\mu'}</M> = 0.2、
            誤差訊號 = <M>{'\\varepsilon_{analog}'}</M>,python3 交叉驗證):window 0 的
            未校正殘差 rms = 0.438686 LSB(136.87 fs)、peak = 1.241111 LSB(387.23 fs);
            第 1 個 window({LMS_BATCH} 次更新)後 <M>{'\\hat{\\delta}'}</M> = 0.877262°、
            <M>{'\\hat{\\gamma}'}</M> = 0.509462 LSB;window 4 起兩個參數都進入真值的 1%
            以內(256 拍);<strong>window 2 起迴路的 e_ZC_hw 與「完美已知 mismatch」的
            calibrated 參考逐位(bit-identical)相同</strong>,peak 固定在 0.66 LSB、
            rms 平均 0.338101 LSB。收斂值 <M>{'\\hat{\\delta}'}</M> = 1.000000°、
            <M>{'\\hat{\\gamma}'}</M> = 0.640000 LSB = 199.68 fs。
            <br />
            <strong>看圖順序</strong>:上 = 參數收斂(暫態集中在前 ~200 次更新,
            用 x 軸 dataZoom 放大;水平虛線 = 真值);中 = 每個 window 的 peak / rms
            與 calibrated floor(虛線)對照,直立虛線 = 目前 window;下 = 動畫的
            before / after 誤差軌跡。按 Play 逐 window 播放。
          </span>
        }
      >
        <SimVeil active={lms === null} label={`LMS 迴路計算中(${2 * LMS_ITERS} × ${LMS_BATCH} cycles)…`}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="preset-button"
              onClick={() => setCalPlaying((p) => !p)}
              disabled={lms === null}
            >
              {calPlaying ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              className="preset-button"
              onClick={() => {
                setCalPlaying(false);
                setCalIter((p) => (p + 1) % LMS_ITERS);
              }}
              disabled={lms === null}
            >
              Step +1 window
            </button>
            <button
              type="button"
              className="preset-button"
              onClick={() => {
                setCalPlaying(false);
                setCalIter(0);
              }}
              disabled={lms === null}
            >
              Reset
            </button>
            {lms !== null && (
              <span style={{ fontSize: 13, opacity: 0.85 }}>
                window {calIter} / {LMS_ITERS - 1}(n = {calIter * LMS_BATCH} 次更新):
                δ̂ = {formatPhase(lms.dStart[calIter], unit, tVco)}(誤差{' '}
                {formatPhase(lms.dStart[calIter] - lms.dTrue, unit, tVco)})、γ̂ ={' '}
                {formatPhase(lms.gStart[calIter], unit, tVco)}(誤差{' '}
                {formatPhase(lms.gStart[calIter] - lms.gTrue, unit, tVco)});
                rms = {formatPhase(lms.rmsIter[calIter], unit, tVco)}、peak ={' '}
                {formatPhase(lms.peakIter[calIter], unit, tVco)}(floor peak ={' '}
                {formatPhase(lms.peakFloor[calIter], unit, tVco)})
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {calParamOption !== null ? (
              <EChart option={calParamOption} height={280} />
            ) : (
              <div style={{ height: 280 }} />
            )}
            {calResidOption !== null ? (
              <EChart option={calResidOption} height={260} />
            ) : (
              <div style={{ height: 260 }} />
            )}
            {calTraceOption !== null ? (
              <EChart option={calTraceOption} height={260} />
            ) : (
              <div style={{ height: 260 }} />
            )}
          </div>
        </SimVeil>
        {lms !== null && (
          <p style={{ fontSize: 13, opacity: 0.85 }}>
            逐位相同於 calibrated floor 的第一個 window:
            {lms.identicalFrom === null ? (
              <strong> 無(48 個 window 內未達成)</strong>
            ) : (
              <strong> it = {lms.identicalFrom}</strong>
            )}
            。收斂值 δ̂ = {formatPhase(lms.dHist[lms.dHist.length - 1], unit, tVco)}(真值{' '}
            {formatPhase(lms.dTrue, unit, tVco)})、γ̂ ={' '}
            {formatPhase(lms.gHist[lms.gHist.length - 1], unit, tVco)}(真值{' '}
            {formatPhase(lms.gTrue, unit, tVco)})。<EpistemicTag kind="EXPERIMENT" />
          </p>
        )}
      </SectionFigure>

      <SectionFigure
        title={`Monte Carlo mismatch — K = ${MC_K} 組隨機失配的 e_ZC_hw 分佈`}
        caption={
          <span>
            每個 sample 用獨立的 Mulberry32 stream(seed = {MC_SEED} + s,per-sample
            offset;MODEL_SPEC §12),抽樣順序固定為 8 個 tap →{' '}
            <code>dtc_fb_gain</code> → <code>dtc_inj_gain</code>:
            <M>{'\\delta_{tap}[j] \\sim N(0, \\sigma_{tap}^2)'}</M>、
            <M>{'g_{FB}, g_{INJ} \\sim N(1, \\sigma_{gain}^2)'}</M>;每個 sample 跑{' '}
            {MC_CYCLES} 拍、同一組 mismatch 分別用 naive 與 calibrated mapping 跑一次。
            直方圖以階梯線繪製(共用 bin edges);分位數用 nearest-rank(不內插,
            index = ⌈p·K⌉ − 1)。<EpistemicTag kind="EXPERIMENT" />
            <br />
            <strong>錨點</strong>(N = 3.13、<M>{'\\sigma_{tap}'}</M> = 1°、
            <M>{'\\sigma_{gain}'}</M> = 1%,python3 交叉驗證):naive 的 peak 中位數{' '}
            <strong>1.800934 LSB(561.89 fs)</strong>、95th percentile{' '}
            <strong>2.542269 LSB(793.19 fs)</strong>;rms 中位數{' '}
            <strong>0.802319 LSB(250.32 fs)</strong>、p95{' '}
            <strong>1.092562 LSB(340.88 fs)</strong>。calibrated 對應為 peak 中位數
            0.819170 LSB(255.58 fs)、p95 0.922251 LSB(287.74 fs);rms 中位數
            0.352260 LSB(109.91 fs)、p95 0.400873 LSB(125.07 fs)—— 中位數改善
            2.20×、p95 改善 2.76×。σ = 0 的下限(純 digital 量化)為 peak 0.48 LSB、
            rms 0.288747 LSB(90.09 fs);naive 有 63/64 個 sample 的 peak 超過 1 LSB,
            calibrated 為 0/64。
          </span>
        }
      >
        <SimVeil active={mc === null} label={`Monte Carlo 計算中(2 × ${MC_K} × ${MC_CYCLES} cycles)…`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {mcOptions !== null ? (
              <EChart option={mcOptions.peak} height={280} />
            ) : (
              <div style={{ height: 280 }} />
            )}
            {mcOptions !== null ? (
              <EChart option={mcOptions.rms} height={280} />
            ) : (
              <div style={{ height: 280 }} />
            )}
          </div>
        </SimVeil>
        {mcStats !== null && (
          <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>統計量</th>
                  <th>mapping</th>
                  <th>median</th>
                  <th>95th pct</th>
                  <th>min</th>
                  <th>max</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['peak |e_ZC_hw|', 'naive', mcStats.naivePeak],
                    ['peak |e_ZC_hw|', 'calibrated', mcStats.calibPeak],
                    ['rms e_ZC_hw', 'naive', mcStats.naiveRms],
                    ['rms e_ZC_hw', 'calibrated', mcStats.calibRms],
                  ] as [string, string, { med: number; p95: number; min: number; max: number }][]
                ).map(([metric, mapping, st]) => (
                  <tr key={`${metric}-${mapping}`}>
                    <td>{metric}</td>
                    <td>{mapping}</td>
                    <td>{formatPhase(st.med, unit, tVco)}</td>
                    <td>{formatPhase(st.p95, unit, tVco)}</td>
                    <td>{formatPhase(st.min, unit, tVco)}</td>
                    <td>{formatPhase(st.max, unit, tVco)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model — tapModel.ts / dtcModel.ts / injectionScheduler.ts(真實碼節錄)"
        code={`${CODE_EXCERPT}\n\n${LOCAL_CODE_EXCERPT}`}
      >
        <p>
          前三段節錄對應本章三個層次:tap 位置模型、DTC delay 表(§10 之 3–9 項
          全部凍結成 64-entry table)、以及 calibrated mapping 如何把「實測」表
          放進 argmin。後兩段是本章 chapter-local 的實驗迴路(LMS 更新與 Monte
          Carlo 抽樣):它們只組合 model primitive,不重新實作任何 wrap /
          quantize / mismatch 數學。
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'return j / nTap + d;',
            explain: (
              <span>
                tap 的 nominal 位置是 <M>{'j/8'}</M> cycle;mismatch 是加法項
                <M>{'\\delta_{tap}[j]'}</M>(cycles)。error = actual − ideal 的
                sign convention 在此:δ 為正 = edge 較晚。
              </span>
            ),
          },
          {
            code: 'gain * c * lsbCycles +',
            explain: (
              <span>
                gain error 是斜率誤差:誤差量 <M>{'(g-1)\\,c\\,\\mathrm{LSB}'}</M>{' '}
                隨 code 線性放大,c=64 滿 range 時 1% → 200 fs(Test 7)。
              </span>
            ),
          },
          {
            code: 'offsetCycles +',
            explain: 'offset 是常數項:所有 code 一起平移,會被 z0 校正吸收,單獨看不傷 pair。',
          },
          {
            code: 'inlSinAmpCycles * Math.sin((2.0 * Math.PI * c) / nCodes) +',
            explain: (
              <span>
                sinusoidal INL:週期 = 整個 code range(64)。code 隨 k 週期掃描時,
                這個 code-dependent 誤差變成時間上的週期誤差 → fractional spur(Ch16)。
              </span>
            ),
          },
          {
            code: 'p2 * (c / denom) ** 2 + p3 * (c / denom) ** 3 +',
            explain: '多項式 INL 以 c/63 正規化,p2、p3 單位是 cycles(本章用 0.5/−0.3 LSB)。',
          },
          {
            code: 'lut + dnlCum[c] * lsbCycles;',
            explain: (
              <span>
                user LUT 直接以 cycles 疊加;DNL 是 per-code random step 的累積
                (PRNG stream <code>dnl_fb</code>/<code>dnl_inj</code>,per instance
                凍結)— DNL 積分成 INL。
              </span>
            ),
          },
          {
            code: 'this.table = table;',
            explain: '整張 delay 表在建構時凍結:同一 seed 下 Python 與 TS 逐位一致,模擬中不再抽亂數。',
          },
          {
            code: 'us[i] = tapTbl[j] + dtcInj.delayCycles(c) + cfg.route_inj_cycles;',
            explain: (
              <span>
                calibrated 候選值用<strong>實測(行為模型)值</strong>:含 tap mismatch、
                DTC gain/INL/DNL、route。之後 argmin{' '}
                <M>{'|\\operatorname{wrapCycles}(u_{target} - u_i)|'}</M> 挑最近的 (j,c)。
              </span>
            ),
          },
          {
            code: 'us[i] = j / cfg.n_tap + c / g;',
            explain: 'nearest(未校正)只用 ideal 幾何值 — mismatch 存在時它會選錯,因為它根本看不到誤差。',
          },
          {
            code: 'eps[k] = wrapCycles(e[k] - eDig[k]);',
            explain: (
              <span>
                <M>{'\\varepsilon_{analog} = e_{ZC,hw} - e_{INJ,abs} = u_{INJ,analog} - u_{INJ,digital}'}</M>
                :把「數位端自己就知道」的量化殘差扣掉,剩下純 analog 失配 —— LMS 的
                迴歸資料因此無偏。直接拿 <code>e_ZC_hw</code> 當誤差訊號會把 ±0.5 LSB
                的量化殘差混進 regressor,估計嚴重偏移(圖上可切換驗證)。
              </span>
            ),
          },
          {
            code: 'const phi2 = cArr[k] / 64;',
            explain: (
              <span>
                gain 參數改用 <M>{'\\gamma = (g-1)\\cdot 64\\,\\mathrm{LSB}'}</M>(滿 range
                的時間誤差,1% → 0.64 LSB = 200 fs)而不是 <M>{'g'}</M> 本身,對應
                regressor <M>{'c/64 \\in [0,1)'}</M>。這樣兩個參數與兩個 regressor 都是
                O(1) 尺度,單一 <M>{'\\mu'}</M> 即可同時收斂,不必做 per-parameter 調步長。
              </span>
            ),
          },
          {
            code: 'const rng = new Mulberry32(MC_SEED + s);',
            explain: (
              <span>
                Monte Carlo 的每個 sample 用固定的 per-sample stream offset(seed ={' '}
                {MC_SEED} + s),抽樣順序固定 —— 同一組 (σ, s) 在 Python 與 TS、在任何
                一次重繪都給出<strong>同一組 mismatch</strong>,直方圖可重現、可交叉驗證。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            <strong>圖 #25</strong>:pattern = uniform、δ = 1° 時 8 根 needle 同方向偏移
            (共模,經 z0 校正可吸收);切到 alt(exp19 pattern)後方向交錯 —
            這種 per-tap 差模誤差才是 calibrated mapping 要處理的對象。
            表格中每 1° 的 delta_fs ≈ 222 fs。
          </li>
          <li>
            <strong>圖 #26</strong>:sin INL 峰在 c=16(+a)、谷在 c=48(−a);
            gain 斜線在 c=63 到 {trimNumber(0.63 * gainPct, 3)} LSB。amp = 0.5 LSB 時
            sin INL 恰好觸及 half-LSB 線。
          </li>
          <li>
            <strong>decomposition</strong>:預設設定下 tap bar ≈ 0.711 LSB(約 222 fs),
            明顯超過 half-LSB 虛線;gain bar 是 rms(naive mapping 下 c 只掃 0..31),
            低於峰值 200 fs — rms 與 peak 是不同統計量。把 signal 切到{' '}
            <code>e_ZC_total</code>(sin injection,K=0.3)後:static 項(tap/offset/route)
            的貢獻變小 — VCO 鎖進來後把固定偏移吸收成靜態相位;noise 項
            (ref/VCO/pulse)則出現非零貢獻。
          </li>
          <li>
            <strong>naive vs calibrated</strong>:caption 的兩個 rms 值;calibrated
            藉 redundant (j−1, c+32) 解避開大偏移 tap,rms 下降(exp19)。
            所有 mismatch 關閉時兩者重合 — 差異完全來自 mismatch。
          </li>
          <li>
            <strong>校正動態(參數圖)</strong>:兩條估計曲線在第一個 window
            ({LMS_BATCH} 次更新)內就走完約 88% 的距離(δ̂ 0 → 0.877°),之後是
            指數收斂的尾巴;window 4 進入 1% 以內。把 μ 調到 0.01 會看到 48 個
            window 跑完仍差 5.9%(δ̂)/ 8.0%(γ̂);μ ≥ 1.9 則發散(本章 slider 上限
            設在 1.0)。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            <strong>校正動態(殘差圖 + 軌跡圖)</strong>:peak 從 1.241 LSB 掉到
            0.660 LSB 之後就<strong>不再下降</strong> —— 那是 calibrated floor
            (虛線),由 mode D 的 digital 量化殘差(N = 3.13、nearest:0.48 LSB)
            加上候選格點殘差構成,與 analog 校正無關。軌跡圖的黃線(window 0)
            與藍線(目前 window)差距就是 LMS 買到的東西;藍線與綠虛線重合代表
            估計已等同「完美已知 mismatch」。
          </li>
          <li>
            <strong>切到 preset「exp12(1° tap3,gain 理想)」</strong>:殘差照樣
            掉到 floor,但 δ̂ 在第一個 window 之後<strong>凍結在 0.767119°</strong>
            (真值 1°)。原因是 <M>{'\\hat{g}=1'}</M> 時 redundant 候選 (j−1, c+32)
            可以精確命中 target,argmin 於是繞過 tap 3 → 該 regressor 不再被激發
            (persistent excitation 消失)。N = 3.125(on-grid)更極端:δ̂ 停在
            0.832228°。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            <strong>Monte Carlo</strong>:兩條分佈幾乎不重疊 —— naive 的 peak 分佈
            落在 1–2.7 LSB,calibrated 落在 0.6–1.0 LSB。注意<strong>兩者的整個
            分佈都在 half-LSB 線右側</strong>:σ = 0 時的量化下限(peak 0.48 LSB)
            已經吃掉 96% 的 half-LSB 預算,任何 analog 誤差都直接超標。把 σ_tap
            拉到 0(只留 σ_gain = 1%)naive 的 peak 中位數降到 0.617866 LSB、
            最小值 0.490452 LSB —— 逼近但永遠碰不到 0.48 LSB 的量化下限;
            反過來只留 σ_tap = 1° 則中位數 1.822376 LSB,可見<strong>tap mismatch
            是 peak 的主導項</strong>。<EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解一:e_pair_digital ≡ 0 表示 injection 對準 zero crossing">
          <p>
            錯。Mode D 的恆等式只保證<strong>數位碼</strong>互補
            (<M>{'(R_{FB}+R_{INJ}) \\bmod 256 = R_{zero}'}</M>)。tap/DTC/route mismatch
            疊加在 code 之後,照樣把實際 edge 推離 zero crossing —{' '}
            <M>{'e_{pair,digital}=0'}</M> 與 <M>{'e_{ZC,hw}=0'}</M> 是兩件事
            (§16 三種 error 的區分)。單一 1° tap 誤差就超過 half-LSB。
          </p>
        </Callout>
        <Callout type="warn" title="誤解二:calibration 可以補償一切 mismatch">
          <p>
            錯。calibrated mapping 只能在<strong>離散的 512 個 (j,c) 候選</strong>中挑最近,
            殘差仍受格點解析度與 LUT 量測精度限制;而 random 項(ref jitter、VCO noise、
            pulse noise,knob 11–13、16)每拍都不同,任何靜態校正表都補不掉 —
            那是 injection 本身(Ch13)的工作,不是 mapping 的。
          </p>
        </Callout>
        <Callout type="warn" title="誤解三:校正迴路的殘差降到底,就代表參數估對了">
          <p>
            錯,而且本章可以現場反證。切到 preset「exp12(1° tap3,gain 理想)」:
            殘差 rms 從 0.363815 LSB 掉到 0.289569 LSB(calibrated floor 0.288416),
            看起來完全收斂 —— 但 <M>{'\\hat{\\delta}'}</M> 凍結在 0.767119°,離真值 1°
            還差 23%。因為 tap/DTC 的 redundancy 讓 argmin 可以<strong>繞過</strong>
            那個壞 tap 而不是<strong>學會</strong>它:regressor{' '}
            <M>{'\\varphi_1 = \\mathbf{1}\\{j=3\\}'}</M> 之後幾乎不再被激發。
            「殘差小」與「參數可信」是兩件事;要讓參數本身可信,必須另外設計激勵
            (dither / 強制輪詢候選),那超出本章範圍。<EpistemicTag kind="EXPERIMENT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>
            誤差預算結論:half-LSB = 156.25 fs,而 1° tap = 222 fs(0.711 LSB)、
            1% gain = 200 fs(0.64 LSB)— <strong>單項典型 mismatch 即超標</strong>,
            tap 與 DTC 都必須校正。<EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            redundancy 是免費的校正自由度:tap 間距 32 LSB、DTC range 64 LSB,
            calibrated argmin 可換 tap 避開大偏移(exp19)。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            debug/budget 方法:先逐項單獨開啟(decompose),對照 RSS 與 joint total;
            additivity gap 大 → 已離開 linear regime,不能再用線性預算表。
            <EpistemicTag kind="APPROX" />
          </li>
          <li>
            共模 offset(全 tap 同偏、DTC offset、route)可由 z0 校正吸收;
            差模(per-tap、code-dependent)才需要 per-element 校正表。
            <EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            背景校正的成本是可量化的:兩個參數、單一 μ、每拍一次更新,256 拍
            (4 個 window)即可把 tap 偏移與 DTC gain 估到真值的 1% 內,之後
            e_ZC_hw 與「完美已知 mismatch」的 calibrated 執行結果逐位相同。
            把 gain 誤差參數化成滿 range 時間誤差 γ =(g−1)·64·LSB 是關鍵 —
            兩個參數同尺度才能共用一個步長。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            但收斂的是<strong>殘差</strong>,不保證是<strong>參數</strong>:
            redundancy 既是校正的自由度,也是 excitation 的殺手。若校正表要拿去
            做別的用途(良率分析、跨溫度外插),必須額外設計激勵,不能直接相信
            背景迴路的收斂值。<EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            預算要用分佈寫,不要用單一數字:σ_tap = 1°、σ_gain = 1% 下 naive 的
            peak 中位數 1.80 LSB、p95 2.54 LSB;完美 calibrated 也只到 0.82 /
            0.92 LSB —— 因為 0.48 LSB 的 digital 量化下限本身就佔掉 96% 的
            half-LSB 預算。要真的守住 half-LSB,得同時動 mapping(analog)與
            grid/DSM(digital),單靠校正不夠。<EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <ul>
            <li>
              §10 全部 16 項都是 <strong>behavioral nonideality model</strong>
              <EpistemicTag kind="ASSUMPTION" />:量值為合理預設,非量測到的電路事實。
            </li>
            <li>
              mismatch 為靜態(per-instance 凍結):不含溫度漂移、aging、
              supply 相依性;DNL 用 frozen random walk 近似,非真實 element 分佈。
            </li>
            <li>
              decomposition 的可加性是 <strong>linear regime 近似</strong>
              <EpistemicTag kind="APPROX" />;additivity gap(逐 cycle 線性和殘差,§16)
              已如實顯示,RSS 僅作 uncorrelated 合成的參考值。
            </li>
            <li>
              LMS 迴路是 <strong>chapter-local 實驗</strong>
              <EpistemicTag kind="EXPERIMENT" />,不在 MODEL_SPEC 內:本節<strong>不提供
              收斂性證明</strong>(無 excitation 條件、無 misadjustment 分析、無步長
              上界推導;實測 μ ≥ 1.9 發散僅為單一組態的觀察),也<strong>不涵蓋
              dither / 激勵策略</strong> —— 上面誤解三示範的 excitation 消失正是
              需要 dither 的地方,其設計不在本章範圍。
            </li>
            <li>
              迴路假設校正引擎每拍都能取得 <M>{'e_{ZC,hw}'}</M> 的無偏實數觀測值,
              並且知道自己的 digital 量化殘差 <M>{'e_{INJ,abs}'}</M>
              <EpistemicTag kind="ASSUMPTION" />。真實硬體通常只有 bang-bang PD 的
              1-bit 符號資訊,需要額外的平均與量測噪聲模型 — 未建模。
              只校正 2 個參數(tap 3 偏移 + INJ DTC gain);其餘 14 項
              nonideality 在此迴路中設為 0。
            </li>
            <li>
              Monte Carlo 只有 K = {MC_K} 個 sample、每個 {MC_CYCLES} 拍:
              95th percentile 由第 61 個排序值(nearest-rank)決定,抽樣不確定度
              明顯<EpistemicTag kind="APPROX" />;peak 統計也受有限 window 長度
              低估。tap 與 gain 假設為獨立高斯、無空間相關、無溫度/電壓相依,
              calibrated 一律視為<strong>完美已知</strong>校正表(不含量測誤差),
              因此它給出的是 calibration 的樂觀上限。
            </li>
            <li>本專案未執行 Spectre;行為級模型 ≠ silicon(MODEL_SPEC §20)。</li>
          </ul>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="Ch15 參數">
        <SelectControl<NDivStr>
          label="N(divide ratio)"
          value={nDivStr}
          options={[
            { value: '3.125', label: '3.125(on-grid,80 ps)' },
            { value: '3.13', label: '3.130(off-grid)' },
            { value: '3.1375', label: '3.1375(off-grid)' },
          ]}
          onChange={setNDivStr}
        />
        <Slider label="tap mismatch δ" value={tapDeg} min={0} max={2} step={0.05} unit="°" onChange={setTapDeg} />
        <SelectControl<'uniform' | 'alt'>
          label="tap pattern"
          value={tapPattern}
          options={[
            { value: 'uniform', label: 'uniform(全部 +δ)' },
            { value: 'alt', label: 'alternating(exp19 pattern)' },
          ]}
          onChange={setTapPattern}
        />
        <Slider label="DTC gain error" value={gainPct} min={-2} max={2} step={0.1} unit="%" onChange={setGainPct} />
        <Slider label="sin INL 振幅" value={inlAmpLsb} min={0} max={1} step={0.05} unit="LSB" onChange={setInlAmpLsb} />
        <Slider label="polar 顯示放大" value={exag} min={5} max={50} step={1} unit="×" onChange={setExag} />
        <SelectControl<SignalName>
          label="decomposition signal"
          value={signal}
          options={[
            { value: 'e_ZC_hw', label: 'e_ZC_hw(deterministic)' },
            { value: 'e_ZC_total', label: 'e_ZC_total(sin injection)' },
          ]}
          onChange={setSignal}
        />
        <Slider
          label="LMS 步長 μ"
          value={calMu}
          min={0.01}
          max={1}
          log
          fmt={(v) => trimNumber(v, 3)}
          onChange={setCalMu}
        />
        <SelectControl<MismatchPreset>
          label="LMS 初始失配"
          value={calPreset}
          options={(Object.keys(MISMATCH_PRESETS) as MismatchPreset[]).map((k) => ({
            value: k,
            label: MISMATCH_PRESETS[k].label,
          }))}
          onChange={setCalPreset}
        />
        <Toggle
          label="LMS 誤差訊號扣除量化殘差"
          checked={calAnalogResid}
          onChange={setCalAnalogResid}
        />
        <Slider
          label="MC σ_tap"
          value={sigTapDeg}
          min={0}
          max={3}
          step={0.1}
          unit="°"
          onChange={setSigTapDeg}
        />
        <Slider
          label="MC σ_gain"
          value={sigGainPct}
          min={0}
          max={3}
          step={0.1}
          unit="%"
          onChange={setSigGainPct}
        />
        <PresetButtons
          label="Experiment presets"
          presets={[
            {
              label: 'exp12 1° tap',
              onClick: () => {
                setTapDeg(1);
                setTapPattern('uniform');
                setGainPct(0);
                setEnabled(onlyEnabled('tap'));
              },
            },
            {
              label: 'exp13 1% gain',
              onClick: () => {
                setGainPct(1);
                setEnabled(onlyEnabled('gain_inj'));
              },
            },
            {
              label: 'exp14 sin INL',
              onClick: () => {
                setInlAmpLsb(0.5);
                setEnabled(onlyEnabled('inl_sin'));
              },
            },
            {
              label: 'exp19 mixed',
              onClick: () => {
                setTapDeg(1);
                setTapPattern('alt');
                setGainPct(1);
                setEnabled(onlyEnabled('tap', 'gain_inj'));
              },
            },
          ]}
        />
      </ParamPanel>
    </ChapterShell>
  );
}
