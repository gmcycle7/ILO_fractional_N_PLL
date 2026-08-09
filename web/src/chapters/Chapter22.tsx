/**
 * Chapter 22 — DSM 殘餘誤差與失鎖邊界 DSM Residuals and Injection Lock Margin
 *
 * Content contract: CHAPTER_GUIDE.md Ch22; math contract: MODEL_SPEC.md
 * section 14(injection dynamics,[ASSUMPTION/APPROX])、section 4/6(feedback
 * decode 與 quantizers)、section 7.1(dsm_only actuator)。
 *
 * 主題:當用 DSM 把除數解析度做到小於 1 LSB 時,殘餘的 per-edge phase error
 * 會不會讓 injection-locked VCO 脫鎖?
 * 分析鏈:單位換算(LSB → rad)→ 離散 map 的小訊號 transfer(high-pass)→
 * lock margin 幾何(stable/unstable fixed point 距離)→ (K, ω₀/K) 平面的
 * cycle-slip map 實測。
 *
 * 所有引用數字均以 python3(model/python,同一 golden model)交叉驗證;
 * slip 計數 helper 與 stage-grid helper 已與 python 逐點比對(見 git 歷史
 * 的 scratch 測試)。
 */

import { useEffect, useMemo, useState } from 'react';
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
import SimVeil from '../components/SimVeil';
import { M, MathBlock } from '../components/Math';
import { ParamPanel, Slider, SelectControl, PresetButtons } from '../components/controls';
import { makeLineOption, baseAxis, baseTooltip, baseToolbox, makeMarkLine } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { trimNumber } from '../lib/format';
import { useChapterNDiv, N_DIV_PRESETS } from '../lib/globalParams';
import { chapterHref } from '../lib/router';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  simulate,
  fromPartial,
  runDynamics,
  makeAllStreams,
  aIdeal,
  makeQuantizer,
  wrapCycles,
  wrapRadians,
  periodogramPsd,
  fftMag,
  rms,
  TWO_PI,
} from '../model';
import type { Quantizer, ActuatorMode, SimConfig } from '../model';

const meta = chapterById(22)!;

const F_REF = 4e9;
const N_MAP = 256; // map 每格模擬拍數(144 格 ≤ 150 runs)
const N_TRAJ = 256; // 軌跡圖拍數
const N_PEAK = 512; // 峰值量測拍數(與 exp22 錨點一致)
const N_SPEC = 1280; // 頻譜 run(丟棄前 256 拍 → 1024 點 PSD)
const SPEC_SKIP = 256;
const K_SPEC = 0.3; // 頻譜/transfer 錨點用的固定 K

/** map 的 K 軸(12 步,近似對數)與 ω₀/K 軸(12 步)。 */
const K_STEPS = [0.02, 0.03, 0.05, 0.08, 0.12, 0.18, 0.27, 0.4, 0.55, 0.7, 0.85, 1.0];
const R_STEPS = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1];

/** transfer 驗證的 tone index(N=1024;皆為偶數 → 後 512 拍 bin = m/2)。 */
const TONE_MS = [4, 8, 16, 32, 64, 96, 128, 192, 256, 320, 384, 448];

const QUANT_OPTIONS: { value: Quantizer; label: string }[] = [
  { value: 'nearest', label: 'nearest(half-up)' },
  { value: 'ef1', label: 'ef1(1st-order DSM)' },
  { value: 'mash11', label: 'mash11(MASH 1-1)' },
  { value: 'mash111', label: 'mash111(MASH 1-1-1)' },
];

/** actuator 選項:full = 完整 /3-/4+PMUX+DTC;pmux = 截斷在 PMUX grid 的
 *  思想實驗(經 runDynamics 餵 stage 誤差);dsm_only = §7.1 整數-cycle。 */
type ActKey = ActuatorMode | 'pmux';
const ACT_OPTIONS: { value: ActKey; label: string }[] = [
  { value: 'full', label: 'full(6-bit DTC grid)' },
  { value: 'pmux', label: 'PMUX grid(思想實驗)' },
  { value: 'dsm_only', label: 'dsm_only(整數 cycle)' },
];

/* ------------------------------------------------------------------ */
/* 本章 helpers(SectionCode 引用的即為此段真實碼)                     */
/* ------------------------------------------------------------------ */

/** wrap-aware 累加 theta_plus 的差分 → 未 wrap 的 drift 軌跡(rad)。 */
function unwrapDrift(thetaPlus: ArrayLike<number>): Float64Array {
  const n = thetaPlus.length;
  const out = new Float64Array(n);
  let acc = n > 0 ? thetaPlus[0] : 0;
  if (n > 0) out[0] = acc;
  for (let k = 1; k < n; k++) {
    acc += wrapRadians(thetaPlus[k] - thetaPlus[k - 1]);
    out[k] = acc;
  }
  return out;
}

/** cycle-slip 計數:drift 總範圍每跨 2π 記一次 slip(行為 proxy)。 */
function slipCount(drift: Float64Array): number {
  if (drift.length === 0) return 0;
  let mn = drift[0];
  let mx = drift[0];
  for (let k = 1; k < drift.length; k++) {
    if (drift[k] < mn) mn = drift[k];
    if (drift[k] > mx) mx = drift[k];
  }
  return Math.floor((mx - mn) / TWO_PI);
}

/** slip 事件拍:floor((drift−drift[0])/2π) 改變的 k。 */
function slipEventKs(drift: Float64Array): number[] {
  const ks: number[] = [];
  if (drift.length === 0) return ks;
  let prev = 0;
  for (let k = 1; k < drift.length; k++) {
    const cur = Math.floor((drift[k] - drift[0]) / TWO_PI);
    if (cur !== prev) {
      ks.push(k);
      prev = cur;
    }
  }
  return ks;
}

/** Ch21 的 stage 量化 helper 濃縮版:把 chain 截斷在每 cycle S 步的 grid,
 *  回傳 PD/ZC 端的 wrap 後誤差(cycles)。 */
function stageErrCycles(nDiv: number, s: number, quant: Quantizer, n: number): Float64Array {
  const a = aIdeal(n, nDiv);
  const scale = s / 256; // 2 的冪 → 縮放無捨入
  const q = makeQuantizer(quant); // fresh state per run(§6)
  const err = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const v = a[k] * scale;
    const y = q.quantize(v);
    err[k] = wrapCycles((y - v) / s);
  }
  return err;
}

interface CellRun {
  thetaPlus: Float64Array;
  thetaMinus: Float64Array;
  deltaTheta: Float64Array;
  eInj: Float64Array;
  epsRad: Float64Array;
}

/** 一格模擬:full/dsm_only 走 simulate();pmux 思想實驗把 stage 誤差
 *  餵進 runDynamics(同一 §14 map、同一 vco_w stream、seed 12345)。 */
function runCell(
  nDiv: number,
  kInj: number,
  ratio: number,
  quant: Quantizer,
  act: ActKey,
  sigma: number,
  nCycles: number,
): CellRun {
  const deltaF = (ratio * kInj * F_REF) / TWO_PI;
  if (act === 'pmux') {
    const cfg = fromPartial({
      n_div: nDiv,
      inj_model: 'sin',
      k_inj: kInj,
      delta_f_hz: deltaF,
      sigma_vco_w_rad: sigma,
      n_cycles: nCycles,
    });
    const eps = stageErrCycles(nDiv, 4, quant, nCycles);
    const dyn = runDynamics(cfg, eps, makeAllStreams(cfg.seed));
    return {
      thetaPlus: dyn.theta_plus,
      thetaMinus: dyn.theta_minus,
      deltaTheta: dyn.delta_theta,
      eInj: dyn.e_inj,
      epsRad: dyn.epsilon_hw,
    };
  }
  const cfg: SimConfig = fromPartial({
    n_div: nDiv,
    arch_mode: 'D',
    quantizer: quant,
    actuator_mode: act,
    inj_model: 'sin',
    k_inj: kInj,
    delta_f_hz: deltaF,
    sigma_vco_w_rad: sigma,
    n_cycles: nCycles,
  });
  const res = simulate(cfg);
  const epsRad = new Float64Array(nCycles);
  for (let k = 0; k < nCycles; k++) epsRad[k] = TWO_PI * res.data.e_ZC_hw[k];
  return {
    thetaPlus: res.data.theta_plus,
    thetaMinus: res.data.theta_minus,
    deltaTheta: res.data.delta_theta,
    eInj: res.data.e_inj,
    epsRad,
  };
}

/** |H(e^{jω})| = |e^{jω}−1| / |e^{jω}−(1−K)|,ω = 2πf/f_ref。 */
function hMag(fHz: number, kInj: number): number {
  const w = (TWO_PI * fHz) / F_REF;
  const reN = Math.cos(w) - 1;
  const imN = Math.sin(w);
  const reD = Math.cos(w) - (1 - kInj);
  const imD = Math.sin(w);
  return Math.hypot(reN, imN) / Math.hypot(reD, imD);
}

function maxAbs(x: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > m) m = a;
  }
  return m;
}

/** 靜態 margin M(r) = π − 2·asin(r)(stable FP 到 unstable FP 的距離)。 */
function staticMargin(r: number): number {
  return Math.PI - 2 * Math.asin(Math.min(1, Math.max(0, r)));
}

/** dsm_only 無法跑 mash11/mash111(A_FB 單調性 assert,見 Limitation)。 */
function dsmOnlyAllowed(q: Quantizer): boolean {
  return q === 'nearest' || q === 'ef1';
}

interface MapCell {
  slips: number;
  tail: number; // rms theta_plus(後 64 拍,rad)
}

/* ------------------------------------------------------------------ */
/* SectionCode 引用字串(與 model 原始碼 / 上方真實碼逐字同步)          */
/* ------------------------------------------------------------------ */

const DYNAMICS_SRC = `// web/src/model/injectionDynamics.ts — 每 reference cycle 一次的 map(節錄)
let tpPrev = 0.0;
for (let k = 0; k < n; k++) {
  // ... noise draws (w, epsRand) ...
  const tm = tpPrev + a + w;                       // a = 2π·Δf·T_ref
  const e = wrapRadians(tm + epsilonHw[k] + epsRand);
  const dth =
    fired !== null && fired[k] === 0
      ? 0.0
      : deltaTheta(cfg.inj_model, cfg.k_inj, e, lutE, lutD); // sin: -K·sin(e)
  const tp = wrapRadians(tm + dth);
  // ...
  tpPrev = tp;
}

// stable fixed point(lock 範圍外回傳 null)
export function sinFixedPointRad(kInj, deltaFHz, fRefHz) {
  const a = (2.0 * Math.PI * deltaFHz) / fRefHz;
  if (kInj <= 0.0 || Math.abs(a) > kInj) {
    return null;
  }
  return Math.asin(a / kInj);
}`;

const SLIP_SRC = `/** wrap-aware 累加 theta_plus 的差分 → 未 wrap 的 drift 軌跡(rad)。 */
function unwrapDrift(thetaPlus): Float64Array {
  const out = new Float64Array(n);
  let acc = thetaPlus[0];
  out[0] = acc;
  for (let k = 1; k < n; k++) {
    acc += wrapRadians(thetaPlus[k] - thetaPlus[k - 1]);
    out[k] = acc;
  }
  return out;
}

/** cycle-slip 計數:drift 總範圍每跨 2π 記一次 slip(行為 proxy)。 */
function slipCount(drift): number {
  let mn = drift[0], mx = drift[0];
  for (let k = 1; k < drift.length; k++) {
    if (drift[k] < mn) mn = drift[k];
    if (drift[k] > mx) mx = drift[k];
  }
  return Math.floor((mx - mn) / TWO_PI);
}

/** PMUX-grid 思想實驗:stage 量化誤差(cycles)→ runDynamics 的 eps_hw。 */
function stageErrCycles(nDiv, s, quant, n): Float64Array {
  const a = aIdeal(n, nDiv);
  const scale = s / 256;                 // 2 的冪 → 縮放無捨入
  const q = makeQuantizer(quant);        // fresh state per run(§6)
  for (let k = 0; k < n; k++) {
    const v = a[k] * scale;
    const y = q.quantize(v);
    err[k] = wrapCycles((y - v) / s);
  }
  return err;
}`;

/* ================================================================== */

export default function Chapter22() {
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const [nDiv, setNDiv] = useChapterNDiv();
  const [quant, setQuant] = useState<Quantizer>('mash111');
  const [act, setAct] = useState<ActKey>('full');
  const [sigma, setSigma] = useState(0.01);
  const [kSel, setKSel] = useState(0.4);
  const [rSel, setRSel] = useState(0.9);

  // dsm_only + mash11/mash111 會觸發 model 的 A_FB 單調性 assert(倒退
  // edge,硬體不可實作)→ 自動退回 ef1;effQuant 保護 effect 執行前的一拍。
  useEffect(() => {
    if (act === 'dsm_only' && !dsmOnlyAllowed(quant)) setQuant('ef1');
  }, [act, quant]);
  const effQuant: Quantizer = act === 'dsm_only' && !dsmOnlyAllowed(quant) ? 'ef1' : quant;

  const omega0 = rSel * kSel; // rad/cycle
  const thetaSs = rSel <= 1 ? Math.asin(rSel) : null;
  const margin = rSel <= 1 ? staticMargin(rSel) : 0;

  /* ---------------- 圖一:lock map(post-paint,144 × 256 cycles) --- */
  const [mapCells, setMapCells] = useState<MapCell[][] | null>(null);
  useEffect(() => {
    setMapCells(null);
    const id = window.setTimeout(() => {
      const cells: MapCell[][] = K_STEPS.map((k) =>
        R_STEPS.map((r) => {
          const run = runCell(nDiv, k, r, effQuant, act, sigma, N_MAP);
          const drift = unwrapDrift(run.thetaPlus);
          return {
            slips: slipCount(drift),
            tail: rms(run.thetaPlus.subarray(N_MAP - 64)),
          };
        }),
      );
      setMapCells(cells);
    }, 0);
    return () => window.clearTimeout(id);
  }, [nDiv, effQuant, act, sigma]);

  /* -------- margin 峰值 + e_inj 頻譜(post-paint,只依 nDiv) -------- */
  interface HeavyData {
    peaks: { dtc: number[]; pmux: number[]; dsm: (number | null)[] };
    psdEps: [number, number][];
    psdInjM: [number, number][];
    psdInjN: [number, number][];
    psdPred: [number, number][];
    peakEpsM: number;
    peakInjM: number;
  }
  const [heavy, setHeavy] = useState<HeavyData | null>(null);
  useEffect(() => {
    setHeavy(null);
    const id = window.setTimeout(() => {
      const quants: Quantizer[] = ['nearest', 'ef1', 'mash11', 'mash111'];
      const dtc = quants.map((q) => maxAbs(runCell(nDiv, K_SPEC, 0, q, 'full', 0, N_PEAK).epsRad));
      const pmux = quants.map((q) => maxAbs(stageErrCycles(nDiv, 4, q, N_PEAK)) * TWO_PI);
      const dsm = quants.map((q) =>
        dsmOnlyAllowed(q) ? maxAbs(runCell(nDiv, K_SPEC, 0, q, 'dsm_only', 0, N_PEAK).epsRad) : null,
      );
      // e_inj 頻譜:K=0.3、Δf=0、σ=0,mash111 vs nearest(丟棄前 256 拍)
      const runM = runCell(nDiv, K_SPEC, 0, 'mash111', 'full', 0, N_SPEC);
      const runN = runCell(nDiv, K_SPEC, 0, 'nearest', 'full', 0, N_SPEC);
      const pE = periodogramPsd(runM.epsRad.subarray(SPEC_SKIP), F_REF);
      const pIM = periodogramPsd(runM.eInj.subarray(SPEC_SKIP), F_REF);
      const pIN = periodogramPsd(runN.eInj.subarray(SPEC_SKIP), F_REF);
      const mk = (p: { freqsHz: Float64Array; psd: Float64Array }): [number, number][] => {
        const pts: [number, number][] = [];
        for (let i = 1; i < p.freqsHz.length; i++) {
          pts.push([p.freqsHz[i] / 1e6, 10 * Math.log10(Math.max(p.psd[i], 1e-30))]);
        }
        return pts;
      };
      const pred: [number, number][] = [];
      for (let i = 1; i < pE.freqsHz.length; i++) {
        const h2 = hMag(pE.freqsHz[i], K_SPEC) ** 2;
        pred.push([pE.freqsHz[i] / 1e6, 10 * Math.log10(Math.max(pE.psd[i] * h2, 1e-30))]);
      }
      setHeavy({
        peaks: { dtc, pmux, dsm },
        psdEps: mk(pE),
        psdInjM: mk(pIM),
        psdInjN: mk(pIN),
        psdPred: pred,
        peakEpsM: maxAbs(runM.epsRad.subarray(SPEC_SKIP)),
        peakInjM: maxAbs(runM.eInj.subarray(SPEC_SKIP)),
      });
    }, 0);
    return () => window.clearTimeout(id);
  }, [nDiv]);

  /* ---------------- 圖二:trajectory explorer(單 run,useMemo) ----- */
  const traj = useMemo(() => {
    const run = runCell(nDiv, kSel, rSel, effQuant, act, sigma, N_TRAJ);
    const drift = unwrapDrift(run.thetaPlus);
    return { run, drift, slips: slipCount(drift), events: slipEventKs(drift) };
  }, [nDiv, kSel, rSel, effQuant, act, sigma]);

  /* ---------------- 圖五:transfer 量測 vs 公式(useMemo) ----------- */
  const transfer = useMemo(() => {
    const N = 1024;
    const cfg = fromPartial({
      n_div: nDiv,
      inj_model: 'sin',
      k_inj: kSel,
      delta_f_hz: 0,
      n_cycles: N,
    });
    const pts: [number, number][] = [];
    for (const m of TONE_MS) {
      const eps = new Float64Array(N);
      for (let k = 0; k < N; k++) eps[k] = (0.01 / TWO_PI) * Math.cos((TWO_PI * m * k) / N);
      const dyn = runDynamics(cfg, eps, makeAllStreams(cfg.seed));
      const segOut = dyn.e_inj.subarray(512);
      const segIn = new Float64Array(512);
      for (let k = 0; k < 512; k++) segIn[k] = TWO_PI * eps[512 + k];
      const b = m / 2;
      pts.push([(m / N) * F_REF / 1e6, fftMag(segOut)[b] / fftMag(segIn)[b]]);
    }
    const curve: [number, number][] = [];
    for (let i = 1; i <= 200; i++) {
      const f = (i / 200) * (F_REF / 2);
      curve.push([f / 1e6, hMag(f, kSel)]);
    }
    return { pts, curve };
  }, [nDiv, kSel]);

  /* ---------------- simulation status ------------------------------- */
  const pending = mapCells === null || heavy === null;
  useEffect(() => {
    if (pending) {
      setStatus('running', `Ch22:lock map ${K_STEPS.length}×${R_STEPS.length} × ${N_MAP} cycles…`);
    } else {
      setStatus(
        'done',
        `Ch22:map 144×${N_MAP} + peaks/PSD(${act}, ${effQuant}, σ=${trimNumber(sigma, 3)})`,
      );
    }
  }, [pending, setStatus, act, effQuant, sigma]);

  /* ------------------------------------------------------------ 圖表 */

  const mapOption = useMemo(() => {
    if (mapCells === null) return null;
    const data: [number, number, number][] = [];
    let maxSlips = 0;
    for (let ki = 0; ki < K_STEPS.length; ki++) {
      for (let ri = 0; ri < R_STEPS.length; ri++) {
        const c = mapCells[ki][ri];
        data.push([ri, ki, c.slips]);
        if (c.slips > maxSlips) maxSlips = c.slips;
      }
    }
    return {
      animation: false,
      backgroundColor: 'transparent',
      tooltip: {
        ...baseTooltip(ct),
        trigger: 'item',
        axisPointer: { type: 'none' },
        formatter: (p: unknown) => {
          const d = (p as { data: [number, number, number] }).data;
          const cell = mapCells[d[1]][d[0]];
          return (
            `K_inj = ${K_STEPS[d[1]]},  ω₀/K = ${R_STEPS[d[0]]}<br/>` +
            `cycle slips(${N_MAP} 拍)= <b>${d[2]}</b><br/>` +
            `tail rms θ⁺(後 64 拍)= ${trimNumber(cell.tail, 4)} rad<br/>` +
            `點擊把此格載入圖二軌跡`
          );
        },
      },
      grid: { left: 64, right: 96, top: 28, bottom: 44 },
      toolbox: baseToolbox(ct, { dataZoom: false }),
      xAxis: {
        type: 'category',
        data: R_STEPS.map((r) => trimNumber(r, 3)),
        ...baseAxis(ct, 'ω₀ / K_inj(detuning 比例 r)'),
        splitLine: { show: false },
      },
      yAxis: {
        type: 'category',
        data: K_STEPS.map((k) => trimNumber(k, 3)),
        ...baseAxis(ct, 'K_inj'),
        nameLocation: 'middle',
        nameGap: 44,
        splitLine: { show: false },
      },
      visualMap: {
        min: 0,
        max: Math.max(4, maxSlips),
        calculable: true,
        orient: 'vertical',
        right: 8,
        top: 'center',
        text: ['slips', 'locked'],
        textStyle: { color: ct.textSubtle, fontSize: 11 },
        inRange: { color: [ct.good, ct.warn, ct.bad] },
      },
      series: [
        {
          name: 'cycle slips',
          type: 'heatmap',
          data,
          label: { show: true, fontSize: 10, color: ct.text, formatter: (p: unknown) => {
            const v = (p as { data: [number, number, number] }).data[2];
            return v === 0 ? '' : String(v);
          } },
          emphasis: { itemStyle: { borderColor: ct.accent, borderWidth: 1.5 } },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: ct.text, type: 'dashed', width: 1.5 },
            label: { color: ct.text, fontSize: 11, formatter: 'ω₀ = K(靜態 lock 邊界)' },
            data: [{ xAxis: 10 }],
          },
        },
      ],
    } as unknown as import('echarts').EChartsOption;
  }, [mapCells, ct]);

  const trajThetaOption = useMemo(() => {
    const xy = (arr: Float64Array) => Array.from(arr, (v, k) => [k, v] as [number, number]);
    const opt = makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: 'rad',
      yTickFormatter: (v) => trimNumber(v, 3),
      series: [
        {
          name: 'θ⁺[k](wrapped)',
          data: xy(traj.run.thetaPlus),
          color: ct.accent,
          width: 1.8,
        },
        { name: 'e_inj[k]', data: xy(traj.run.eInj), color: ct.series[1], dashed: true },
        {
          name: 'ε_hw[k](scheduling error)',
          data: xy(traj.run.epsRad),
          color: ct.series[4],
          width: 1,
        },
      ],
    });
    const o = opt as unknown as { series?: Record<string, unknown>[] };
    if (o.series && o.series[0] && thetaSs !== null) {
      o.series[0].markLine = makeMarkLine([
        { y: thetaSs, label: `θ_ss = ${trimNumber(thetaSs, 4)}`, color: ct.good },
        { y: Math.PI - thetaSs, label: `unstable = ${trimNumber(Math.PI - thetaSs, 4)}`, color: ct.bad },
      ]);
    }
    return opt;
  }, [traj, thetaSs, ct]);

  const trajDriftOption = useMemo(() => {
    const xy = Array.from(traj.drift, (v, k) => [k, v] as [number, number]);
    const events: [number, number][] = traj.events.map((k) => [k, traj.drift[k]]);
    const opt = makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: 'unwrapped drift (rad)',
      yTickFormatter: (v) => trimNumber(v, 3),
      series: [
        { name: 'unwrapped θ⁺(drift)', data: xy, color: ct.accent, width: 1.8 },
        {
          name: `slip 事件(共 ${traj.slips} 次)`,
          data: events,
          type: 'scatter',
          color: ct.bad,
          symbolSize: 9,
          showSymbol: true,
        },
      ],
    });
    const o = opt as unknown as { series?: Record<string, unknown>[] };
    if (o.series && o.series[0]) {
      o.series[0].markLine = makeMarkLine([
        { y: traj.drift[0] + TWO_PI, label: '+2π' },
        { y: traj.drift[0] - TWO_PI, label: '−2π' },
      ]);
    }
    return opt;
  }, [traj, ct]);

  const marginOption = useMemo(() => {
    if (heavy === null) return null;
    const cats = QUANT_OPTIONS.map((q) => q.value);
    const opt = makeLineOption({
      xLabel: 'quantizer',
      yLabel: 'peak |ε_hw| (rad, log)',
      xType: 'category',
      categories: cats,
      zoom: false,
      series: [
        { name: 'full(DTC grid)', data: heavy.peaks.dtc, type: 'bar', color: ct.accent },
        { name: 'PMUX grid(思想實驗)', data: heavy.peaks.pmux, type: 'bar', color: ct.warn },
        { name: 'dsm_only', data: heavy.peaks.dsm, type: 'bar', color: ct.bad },
      ],
      extra: {
        yAxis: {
          type: 'log',
          min: 0.004,
          max: 6,
          ...baseAxis(ct, 'peak |ε_hw| (rad, log)', (v) => trimNumber(v, 3)),
          nameLocation: 'middle',
          nameGap: 46,
        },
      },
    });
    const o = opt as unknown as { series?: Record<string, unknown>[] };
    if (o.series && o.series[0]) {
      o.series[0].markLine = makeMarkLine([
        { y: Math.PI, label: 'M(0) = π(ω₀ = 0 的 basin)', color: ct.good },
        { y: staticMargin(0.5), label: 'M(0.5) = 2.094', color: ct.textSubtle },
        { y: staticMargin(0.9), label: 'M(0.9) = 0.902', color: ct.bad },
      ]);
    }
    return opt;
  }, [heavy, ct]);

  const psdOption = useMemo(() => {
    if (heavy === null) return null;
    return makeLineOption({
      xLabel: 'frequency (MHz, log) — sample rate = f_ref = 4 GHz',
      yLabel: '10·log₁₀ S (dB re rad²/Hz)',
      series: [
        { name: 'ε_hw(mash111)', data: heavy.psdEps, color: ct.series[4], width: 1 },
        { name: 'e_inj(mash111)', data: heavy.psdInjM, color: ct.accent, width: 2 },
        { name: '預測 |H|²·S_ε(mash111)', data: heavy.psdPred, color: ct.warn, dashed: true },
        { name: 'e_inj(nearest)', data: heavy.psdInjN, color: ct.textSubtle, width: 1 },
      ],
      extra: {
        xAxis: {
          type: 'log',
          min: F_REF / 1024 / 1e6,
          ...baseAxis(ct, 'frequency (MHz, log) — f_ref = 4 GHz'),
        },
      },
    });
  }, [heavy, ct]);

  const transferOption = useMemo(() => {
    const opt = makeLineOption({
      xLabel: 'frequency (MHz)',
      yLabel: '|e_inj / ε| (linear)',
      yTickFormatter: (v) => trimNumber(v, 3),
      zoom: false,
      series: [
        {
          name: `|H| 公式(K=${trimNumber(kSel, 3)})`,
          data: transfer.curve,
          color: ct.accent,
          width: 2,
        },
        {
          name: '量測(小訊號 tone,runDynamics)',
          data: transfer.pts,
          type: 'scatter',
          color: ct.warn,
          symbolSize: 7,
          showSymbol: true,
        },
      ],
    });
    const o = opt as unknown as { series?: Record<string, unknown>[] };
    if (o.series && o.series[0]) {
      o.series[0].markLine = makeMarkLine([
        { y: 1, label: '|H| = 1(完全 passthrough)' },
        { y: 2 / (2 - kSel), label: `|H|max = 2/(2−K) = ${trimNumber(2 / (2 - kSel), 4)}`, color: ct.bad },
      ]);
    }
    return opt;
  }, [transfer, kSel, ct]);

  /* --------------------------------------------------- debug table --- */
  const debugRows = useMemo(() => {
    const rows: Record<string, unknown>[] = [];
    const { run, drift } = traj;
    const eventSet = new Set(traj.events);
    for (let k = 0; k < N_TRAJ; k++) {
      rows.push({
        k,
        eps_hw_rad: run.epsRad[k],
        theta_minus: run.thetaMinus[k],
        e_inj: run.eInj[k],
        delta_theta: run.deltaTheta[k],
        theta_plus: run.thetaPlus[k],
        drift_unwrapped: drift[k],
        slip: eventSet.has(k) ? 1 : 0,
      });
    }
    return rows;
  }, [traj]);

  const fmt = (v: number, sig = 4): string => trimNumber(v, sig);
  const quantLabel = QUANT_OPTIONS.find((q) => q.value === effQuant)?.value ?? effQuant;

  /* ================================================================ */
  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            當用 DSM 把除數解析度做到小於 1 LSB 時,殘餘的 per-edge phase error
            會不會讓 injection-locked VCO 脫鎖?<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            DSM 殘餘誤差換算成 rad 有多大?對 sin map 的 lock-in basin(半寬 π)
            佔多少比例?<EpistemicTag kind="EXACT" />
          </li>
          <li>
            injection loop 對 scheduling error 的小訊號 transfer 是什麼形狀?為什麼
            DSM 的 noise shaping「幫不上」zero-crossing 對準?<EpistemicTag kind="APPROX" />
          </li>
          <li>
            detuning 逼近 lock range 邊界時,margin 怎麼塌掉?slip 判準能不能寫成
            一條設計規則?<EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            grid 從 6-bit DTC 粗化到 PMUX、再到 dsm_only(整數 cycle)時,失鎖邊界
            實測移動到哪裡?<EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          <a href={chapterHref('rounding-vs-phase-dsm')}>Ch11</a> 與{' '}
          <a href={chapterHref('pd-input-error-anatomy')}>Ch21</a> 已經確認:off-grid 的
          α(如 N = 3.13,α·G = 33.28 LSB/拍,殘量 0.28 LSB;或更細的 N = 3 + 32.1/256,
          殘量 0.1 LSB)讓 DSM 能把量化誤差的<b>頻譜</b>搬到高頻,但 per-edge 峰值反而
          <b>變大</b>:N=3.13、mode D 實測 0.48(nearest)→ 0.76(ef1)→ 1.36(mash11)→
          1.76 LSB(mash111)。<EpistemicTag kind="EXPERIMENT" /> 這些誤差不是抽象的
          頻譜量 —— 每一拍的 injection pulse 都以 ε_hw = 2π·e_ZC_hw 的 offset 打在 VCO
          上(<a href={chapterHref('vco-injection-dynamics')}>Ch13</a> 的 §14 map)。
          本章問的就是:這些 kick offset 會不會把 VCO 從 sin map 的 basin 裡踢出去?
        </p>
        <p>
          直覺畫面:把 VCO residual phase 想成停在山谷(stable fixed point)裡的珠子,
          山口在 π − θ_ss(unstable fixed point)。每拍的 DSM 殘餘誤差等於隨機往左右
          推珠子一把:推力只有 0.012–0.043 rad(sub-LSB 級),山口卻在 ~0.9–3.1 rad 外
          —— 差 20–270 倍,珠子晃都晃不出去。但若 actuator 粗到 PMUX grid(推力
          0.75–2.5 rad)或干脆沒有(dsm_only,±π),同一把 DSM 就把珠子直接推過山口
          —— cycle slip、失鎖。<b>答案取決於「誤差幾 rad」對「margin 幾 rad」,而不是
          「誤差幾 LSB」</b>。
        </p>
        <p>
          另一個關鍵直覺:injection loop 本身是一個 <b>high-pass</b> 的誤差抑制器
          (下節推導):它每拍把「累積下來的」phase error 拉回去,所以 DC/低頻的
          scheduling error 會被壓掉;但 DSM 恰恰把量化能量搬到<b>高頻</b> —— 正是
          injection loop 完全擋不住的頻段。shaping 買的是 PLL in-band 頻譜(Ch21
          Layer 3),<b>不是</b> zero crossing 的瞬時對準。
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>
          <b>(a) 單位橋:LSB → rad。</b>1 fine LSB = 1/256 cycle,而 sin map 的變數
          θ 以 rad 計:
        </p>
        <MathBlock>
          {'1\\ \\mathrm{LSB} = \\frac{2\\pi}{256} = 0.024544\\ \\mathrm{rad} = 1.40625^\\circ'}
        </MathBlock>
        <p>
          N=3.13、mode D、512 拍的實測峰值(<a href={chapterHref('architecture-comparisons')}>exp22</a>,
          e_FB_abs 與 e_ZC_hw 峰值相同)換算:<EpistemicTag kind="EXPERIMENT" />
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>quantizer</th>
                <th>peak(LSB)</th>
                <th>peak(rad)</th>
                <th>π / peak(margin ratio @ ω₀=0)</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>nearest</td><td>0.48</td><td>0.01178</td><td>266.7×</td></tr>
              <tr><td>ef1</td><td>0.76</td><td>0.01865</td><td>168.4×</td></tr>
              <tr><td>mash11</td><td>1.36</td><td>0.03338</td><td>94.1×</td></tr>
              <tr><td>mash111</td><td>1.76</td><td>0.04320</td><td>72.7×</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          即使是最兇的 mash111,峰值也只有 basin 半寬 π 的 1.4%(margin ratio 73×);
          nearest 到 mash111 全部落在 <b>73–267×</b> 的安全區間。
          <EpistemicTag kind="EXACT" />(換算)+<EpistemicTag kind="EXPERIMENT" />(峰值)
        </p>
        <p>
          <b>(b) 小訊號 transfer:injection loop 是 high-pass。</b>§14 sin map 在
          fixed point 附近線性化(<M>{'\\sin e \\approx e'}</M>,取 ω₀ 小、
          <M>{'\\cos\\theta_{ss}\\approx 1'}</M>):
        </p>
        <MathBlock>
          {
            '\\theta^{-}[k{+}1] = \\theta^{-}[k] - K\\bigl(\\theta^{-}[k] + \\varepsilon[k]\\bigr) + \\omega_0,\\qquad e_{inj}[k] = \\theta^{-}[k] + \\varepsilon[k]'
          }
        </MathBlock>
        <p>z-domain 消去 θ⁻:</p>
        <MathBlock>
          {
            'H(z) \\;=\\; \\frac{E_{inj}(z)}{\\mathcal{E}(z)} \\;=\\; \\frac{z-1}{\\,z-(1-K)\\,}'
          }
        </MathBlock>
        <p>
          一階 <b>high-pass</b>:DC 有零點(<M>{'H(1)=0'}</M> —— 固定的 scheduling
          offset 完全被 loop 吸收),高頻增益趨近{' '}
          <M>{'2/(2-K)'}</M>(K=0.3 時 1.176,+1.4 dB —— 甚至<b>略放大</b>)。
          <EpistemicTag kind="APPROX" /> 數值驗證(K=0.3、0.01 rad 小訊號 tone 餵進
          非線性 sin map,量測輸出/輸入振幅比;python3 與本頁 model 同碼):
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr><th>f</th><th>量測 |e_inj/ε|</th><th>公式 |H|</th><th>相對誤差</th></tr>
            </thead>
            <tbody>
              <tr><td>15.625 MHz</td><td>0.08162</td><td>0.08162</td><td>&lt;0.001%</td></tr>
              <tr><td>250 MHz</td><td>0.88006</td><td>0.88005</td><td>&lt;0.001%</td></tr>
              <tr><td>1.75 GHz</td><td>1.17574</td><td>1.17575</td><td>&lt;0.001%</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          <b>結論(本章核心):</b>DSM noise shaping 把量化能量推到高頻,而 injection
          loop 恰好是 high-pass —— <b>低頻誤差它會修,高頻誤差近乎 1:1 直達 zero
          crossing</b>。N=3.13 的第一根 spur 在 160 MHz,|H| 已達 0.685(−3.3 dB);
          shaped 能量集中的 GHz 頻段 |H| ≈ 1.18(+1.4 dB)。所以「DSM 之後 in-band
          乾淨」對 ZC 對準毫無幫助:mash111 的 e_inj 穩態峰值 0.0509 rad 甚至比 ε 峰值
          0.0432 rad 還大 18%(= |H| 峰化)。<EpistemicTag kind="EXPERIMENT" />
        </p>
      </SectionMath>

      <SectionMath>
        <p>
          <b>(c) lock margin 幾何。</b>sin map 的穩態(<a href={chapterHref('vco-injection-dynamics')}>Ch13</a>):
          detuning 比例 <M>{'r = \\omega_0/K_{inj}'}</M>(<M>{'\\omega_0 = 2\\pi\\Delta f\\,T_{ref}'}</M>),
        </p>
        <MathBlock>
          {
            '\\theta_{ss} = \\arcsin(r),\\qquad \\theta_{unstable} = \\pi - \\theta_{ss},\\qquad M(r) \\;=\\; \\pi - 2\\arcsin(r)'
          }
        </MathBlock>
        <p>
          M(r) 是 stable 到 unstable fixed point 的距離 —— 瞬時 e_inj 一旦跨過
          unstable 點,sin 拉力小於 detuning,θ 淨往前漂,發展成 cycle slip。
          <M>{'r\\to 1'}</M> 時 <M>{'M\\to 0'}</M>:M(0.9) = 0.902、M(0.99) = 0.283、
          M(0.999) = 0.089 rad —— 邊界附近 margin 以 <M>{'2\\sqrt{2(1-r)}'}</M> 塌掉。
          <EpistemicTag kind="APPROX" />
        </p>
        <p>
          <b>修正後的安全條件(定性)。</b>靜態 lock 條件 |ω₀| ≤ K 之外,還要留住
          瞬時擾動:
        </p>
        <MathBlock>
          {
            '\\operatorname{peak}|\\varepsilon_{hw}| \\;+\\; \\text{noise tail} \\;\\ll\\; M(r) \\;=\\; \\pi - 2\\arcsin\\!\\bigl(\\omega_0/K_{inj}\\bigr)'
          }
        </MathBlock>
        <p>
          這是<b>必要方向的近似判準,不是精確公式</b>:連續多拍大誤差可以在單拍未跨越
          unstable 點的情況下把 θ 走過去,所以實測 slip onset <b>不會晚於</b>「單拍
          峰值 = M(r)」的預測,高階 DSM 更明顯提早(Δr=0.01 細掃:實測 onset
          0.90/0.89/0.59/0.13,比預測早 0.03/0.00/0.14/0.18 個 r)。PMUX-grid
          思想實驗的掃描(K=0.3、σ=0、256 拍):
          <EpistemicTag kind="INFERENCE" />(判準)+<EpistemicTag kind="EXPERIMENT" />(掃描)
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>quantizer @ PMUX grid</th>
                <th>peak |ε_hw|(rad)</th>
                <th>預測 onset r* = sin((π−peak)/2)</th>
                <th>實測 onset(Δr = 0.1 格)</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>nearest</td><td>0.754</td><td>0.93</td><td>0.9</td></tr>
              <tr><td>ef1</td><td>0.943</td><td>0.89</td><td>0.9</td></tr>
              <tr><td>mash11</td><td>1.508</td><td>0.73</td><td>0.6</td></tr>
              <tr><td>mash111</td><td>2.513</td><td>0.31</td><td>0.2</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          <b>(d) grid 粗細階梯。</b>同一組 quantizer,把 actuator 從 6-bit DTC 粗化:
          full DTC 的峰值 0.012–0.043 rad(margin ratio 73–267×,永遠安全);PMUX grid
          (Δ = 1/4 cycle)的峰值 0.75–2.51 rad(對 π 只剩 4.2×–1.25×,高階 DSM 在
          r ≈ 0.2 就 slip);dsm_only(<a href={chapterHref('rounding-vs-phase-dsm')}>Ch11</a>{' '}
          §7.1)的 ε_hw 掃滿 ±π —— margin 為<b>零</b>,不 gate 必失鎖:exp21 實測
          ungated tail rms θ⁺ = 1.81 rad(失鎖)vs threshold gating 後 0.102 rad、
          full actuator 0.015 rad。<EpistemicTag kind="EXPERIMENT" />
        </p>
      </SectionMath>

      <SectionExample>
        <p>
          <b>手算例:lock 邊緣附近的一拍。</b>取 K_inj = 0.3、ω₀ = 0.9K = 0.27
          rad/cycle(Δf = 171.89 MHz;K=0.3 的 lock edge 是 190.99 MHz):
        </p>
        <ul>
          <li>
            <M>{'\\theta_{ss} = \\arcsin(0.9) = 1.1198'}</M> rad;unstable ={' '}
            <M>{'\\pi - 1.1198 = 2.0218'}</M> rad;margin M = <M>{'\\pi - 2\\times 1.1198 = 0.9021'}</M> rad。
          </li>
          <li>
            <b>mash111 @ full DTC</b>(peak ε = 0.0432 rad):e_inj = 1.1198 + 0.0432 =
            1.1630 &lt; 2.0218(距 unstable 還有 20.9×);kick = −0.3·sin(1.1630) =
            −0.27540,淨移動 0.27 − 0.27540 = <b>−0.00540</b> rad —— 被拉回 fixed
            point。<b>不 slip</b>。
          </li>
          <li>
            <b>ef1 @ PMUX grid</b>(peak ε = 0.9425 rad):e_inj = 1.1198 + 0.9425 =
            2.0623 &gt; 2.0218 —— <b>跨過 unstable 點</b>;kick = −0.3·sin(2.0623) =
            −0.26449,淨移動 0.27 − 0.26449 = <b>+0.00551</b> rad —— 往 slip 方向漂。
            連續多拍即發展成 cycle slip。
          </li>
        </ul>
        <p>
          全部數字與 python3 單拍計算逐位一致。<EpistemicTag kind="EXACT" />
          (單拍算術)+<EpistemicTag kind="APPROX" />(sin map 本身)
        </p>
      </SectionExample>

      <SectionFigure
        title={`圖一 — Lock map:cycle slips 於 (K_inj, ω₀/K) 平面(${quantLabel} @ ${act},σ_vco_w = ${trimNumber(sigma, 3)} rad)`}
        caption={
          <span>
            x 軸:detuning 比例 r = ω₀/K(0…1.1);y 軸:K_inj(0.02…1,近似對數);
            顏色/數字:{N_MAP} 拍內的 cycle-slip 次數(0 = locked,綠色)。虛線 = 靜態
            lock 邊界 ω₀ = K。點擊任一格把該 (K, r) 載入圖二軌跡。python3 交叉驗證錨點
            (N=3.13):full+mash111+σ=0.01 → r ≤ 1.0 全為 0、r=1.1 從 K=0.08 起
            1/2/3/4/7/10/13/16/19 slips;dsm_only+ef1 → K ≥ 0.27 時連 r=0 都 slip
            (K=1.0、r=0 高達 33 次)。<EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <SimVeil active={mapCells === null} label={`lock map 計算中(144 × ${N_MAP} cycles)…`}>
          {mapOption !== null ? (
            <EChart
              option={mapOption}
              height={380}
              onEvents={{
                click: (params: unknown) => {
                  const d = (params as { data?: [number, number, number] }).data;
                  if (d !== undefined) {
                    setRSel(R_STEPS[d[0]]);
                    setKSel(K_STEPS[d[1]]);
                  }
                },
              }}
            />
          ) : (
            <div style={{ height: 380 }} />
          )}
        </SimVeil>
        <p style={{ fontSize: 13, opacity: 0.85 }}>
          本章標題問題的視覺答案:<b>full actuator 的整個 r ≤ 1 區域是綠的,與 quantizer
          無關</b> —— sub-LSB DSM 殘餘誤差推不出 basin;失鎖邊界由 detuning(r → 1)
          決定。切到 PMUX grid / dsm_only 看邊界向左塌陷。
        </p>
      </SectionFigure>

      <SectionFigure
        title={`圖二 — Trajectory explorer:K=${trimNumber(kSel, 3)}, r=${trimNumber(rSel, 3)}, ${quantLabel} @ ${act}(slips = ${traj.slips})`}
        caption={
          <span>
            上:wrapped θ⁺[k]、e_inj[k] 與 scheduling error ε_hw[k](rad);綠/紅虛線 =
            stable / unstable fixed point(r ≤ 1 時)。下:wrap-aware 展開的 drift 軌跡,
            紅點 = slip 事件(drift 每跨 2π 記一次);±2π 參考線。三個 canonical 點
            (K=0.4):deep-lock r=0.1(0 slips)、lock-edge r=0.9(0 slips —— margin
            0.902 rad 仍是 mash111 峰值的 20.9×)、past-edge r=1.1(mash111、σ=0.01
            實測 7 slips)。python3 同組態同 seed 逐點一致。
            <EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <EChart option={trajThetaOption} height={260} />
          <EChart option={trajDriftOption} height={260} />
        </div>
      </SectionFigure>

      <SectionFigure
        title="圖三 — Margin 條形圖:peak |ε_hw|(rad)vs 靜態 margin M(r)(quantizer × actuator grid)"
        caption={
          <span>
            對數 y 軸:每個 quantizer × grid 的實測 peak |ε_hw|({N_PEAK} 拍,
            N = {trimNumber(nDiv, 6)});水平虛線 = M(0) = π、M(0.5) = 2.094、M(0.9) =
            0.902 rad。條形低於線 = 該 detuning 下有 margin。N=3.13 錨點:DTC 級
            0.0118/0.0187/0.0334/0.0432 rad(全部遠低於三條線);PMUX 級
            0.754/0.943/1.508/2.513 rad(ef1/mash11/mash111 超過 M(0.9),mash111 更
            超過 M(0.5),達 M(0)/1.25);dsm_only = π(零 margin;mash11/mash111 缺格 —— model assert,
            見 Limitation)。<EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <SimVeil active={heavy === null}>
          {marginOption !== null ? <EChart option={marginOption} height={320} /> : <div style={{ height: 320 }} />}
        </SimVeil>
      </SectionFigure>

      <SectionFigure
        title="圖四 — e_inj 頻譜:high-pass 之後,shaped 噪聲原封不動抵達 zero crossing"
        caption={
          <span>
            PSD(log-f,dB re rad²/Hz;K = {K_SPEC}、Δf = 0、σ = 0、{N_SPEC - SPEC_SKIP}
            拍穩態)。灰細線:mash111 的 ε_hw(shaped 量化誤差);藍線:同一 run 的
            e_inj(pulse 實際看到的誤差);黃虛線:預測 |H|²·S_ε —— 與量測逐 bin 重合
            (N=3.13 的 12 根 160 MHz 諧波上偏差 ≤ 0.02 dB,python3 驗證)。第一根 tone
            (160 MHz)僅被壓 3.3 dB,高頻 tone 反而 +1.4 dB;低頻段兩者都只剩 leakage
            位階(N=3.13 的 P=25 comb 在 62.5 MHz 以下本無功率,Ch21)。細灰線:nearest
            的 e_inj 對照(總功率低 ~12.5 dB、峰值低 ~12 dB;但前兩根諧波因未 shaped
            反而比 mash111 高 15–27 dB —— shaping 把能量搬到高頻的直接證據)。
            <EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <SimVeil active={heavy === null}>
          {psdOption !== null ? <EChart option={psdOption} height={320} /> : <div style={{ height: 320 }} />}
        </SimVeil>
        {heavy !== null ? (
          <p style={{ fontSize: 13, opacity: 0.85 }}>
            穩態峰值 passthrough(量測):peak |ε_hw| = {fmt(heavy.peakEpsM)} rad →
            peak |e_inj| = {fmt(heavy.peakInjM)} rad(×
            {fmt(heavy.peakInjM / Math.max(heavy.peakEpsM, 1e-30), 3)};N=3.13 錨點
            0.0432 → 0.0509 rad,×1.18 ≈ |H| 高頻峰值)—— <b>DSM 的瞬時誤差經過
            injection loop 後不減反增</b>。
          </p>
        ) : null}
      </SectionFigure>

      <SectionFigure
        title={`圖五 — Transfer 驗證:量測 tone 增益 vs |H(e^{jω})| 公式(K = ${trimNumber(kSel, 3)})`}
        caption={
          <span>
            實線:|H| = |e^{'{jω}'}−1| / |e^{'{jω}'}−(1−K)|;黃點:把 0.01 rad 的小訊號
            tone 餵進<b>非線性</b> sin map(runDynamics,丟棄前 512 拍)後量測的
            輸出/輸入振幅比,{TONE_MS.length} 個頻率。K=0.3 錨點:15.6 MHz → 0.0816、
            250 MHz → 0.8801、1.75 GHz → 1.1757,量測與公式相對誤差 &lt;0.001%
            (python3 同值)。拉 K slider 觀察:K 越大,high-pass 轉角越高、低頻抑制
            越強 —— 但高頻增益永遠 ≥ 1(→ 2/(2−K))。<EpistemicTag kind="APPROX" />
            <EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <EChart option={transferOption} height={300} />
      </SectionFigure>

      <SectionFigure
        title="圖六 — cycle-by-cycle DebugTable(圖二的軌跡,CSV 可匯出)"
        caption={
          <span>
            全部欄位為 raw 值(rad;CSV 匯出後可與 python3 golden model 逐位 diff)。
            slip = 1 的拍是 drift 跨越 2π 邊界的事件拍。
          </span>
        }
      >
        <DebugTable
          columns={[
            { key: 'k', label: 'k' },
            { key: 'eps_hw_rad', label: 'ε_hw (rad)' },
            { key: 'theta_minus', label: 'θ⁻' },
            { key: 'e_inj', label: 'e_inj' },
            { key: 'delta_theta', label: 'Δθ' },
            { key: 'theta_plus', label: 'θ⁺' },
            { key: 'drift_unwrapped', label: 'drift(unwrapped)' },
            { key: 'slip', label: 'slip' },
          ]}
          rows={debugRows}
          exportName="ch22_trajectory.csv"
        />
      </SectionFigure>

      <SectionCode
        title="model 的 §14 map(web/src/model/injectionDynamics.ts 節錄)+ 本章 slip/stage helpers(真實碼)"
        language="typescript"
        code={`${DYNAMICS_SRC}\n\n${SLIP_SRC}`}
      >
        <p>
          動力學一律呼叫 model 的 <code>simulate()</code> /{' '}
          <code>runDynamics()</code>(§14);本章只加純量測 helper:unwrapDrift
          (wrap-aware 展開)、slipCount(2π 計數)、slipEventKs(事件拍標記)與
          stageErrCycles(PMUX-grid 思想實驗的誤差源,同 Ch21 的 stage 量化)。full / dsm_only 兩種 actuator 走
          完整 <code>simulate()</code> chain;三者共用同一 vco_w noise stream 與 seed
          12345 —— python3 逐點同值。<EpistemicTag kind="EXACT" />
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'const tm = tpPrev + a + w;',
            explain: (
              <span>
                拍間演化(§14):上一拍 post-injection phase + detuning 增量 a =
                2π·Δf·T_ref + VCO noise。本章掃 a = r·K —— r 是 map 的 x 軸。
              </span>
            ),
          },
          {
            code: 'const e = wrapRadians(tm + epsilonHw[k] + epsRand);',
            explain: (
              <span>
                pulse 看到的總誤差:VCO residual + <b>ε_hw = 2π·e_ZC_hw</b>(DSM 殘餘
                誤差從這裡進入動力學)。wrap 到 (−π, π] —— basin 幾何的來源。
              </span>
            ),
          },
          {
            code: "deltaTheta(cfg.inj_model, cfg.k_inj, e, ...)  // sin: -K·sin(e)",
            explain: (
              <span>
                sin map 拉力 <EpistemicTag kind="APPROX" />:e 跨過 π − θ_ss 後拉力
                &lt; detuning,淨漂移轉正 —— SectionExample 的兩個單拍算式。
              </span>
            ),
          },
          {
            code: 'return Math.asin(a / kInj);',
            explain: (
              <span>
                stable fixed point θ_ss = asin(r)。margin M(r) = π − 2·asin(r) 由它與
                unstable 點 π − θ_ss 相減而得。
              </span>
            ),
          },
          {
            code: 'acc += wrapRadians(thetaPlus[k] - thetaPlus[k - 1]);',
            explain: (
              <span>
                wrap-aware 展開:θ⁺ 本身存在 (−π, π],逐拍差分再 wrap 可還原連續
                drift(假設單拍移動 &lt; π —— K ≤ 1 時成立)。
              </span>
            ),
          },
          {
            code: 'return Math.floor((mx - mn) / TWO_PI);',
            explain: (
              <span>
                slip 計數 proxy:drift 總範圍每跨一整圈記一次。locked 軌跡的範圍
                &lt; 2π → 0;detuning 主導的失鎖軌跡單調爬升 → 計數 ∝ 漂移速率。
              </span>
            ),
          },
          {
            code: 'const eps = stageErrCycles(nDiv, 4, quant, nCycles);',
            explain: (
              <span>
                PMUX-grid 思想實驗:S = 4 的 stage 量化誤差(Ch21)直接作為
                runDynamics 的 e_ZC_hw 輸入 —— 把「grid 粗化」與「DSM 階數」正交掃描。
              </span>
            ),
          },
          {
            code: 'delta_f_hz: (ratio * kInj * F_REF) / TWO_PI,',
            explain: (
              <span>
                map 的參數化:固定 r = ω₀/K 而非固定 Δf,讓每一列的靜態邊界都落在
                r = 1 —— margin 塌陷的形狀在同一張圖上可比。
              </span>
            ),
          },
          {
            code: "if (act === 'dsm_only' && !dsmOnlyAllowed(quant)) setQuant('ef1');",
            explain: (
              <span>
                dsm_only + mash11/mash111 會產生倒退的 divider edge,model 以 A_FB
                單調性 assert 擋下(硬體不可實作)—— UI 自動退回 ef1。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            圖一(full actuator):r ≤ 1.0 的 132 格全綠(0 slips)—— 對四種 quantizer
            都成立;slips 只出現在 r = 1.1 欄,且次數隨 K 增加(漂移速率 ∝ 超出量
            0.1K)。<b>把 quantizer 從 nearest 切到 mash111,map 一格都不變</b> ——
            這就是標題問題的答案。
          </li>
          <li>
            圖一(dsm_only,自動退回 ef1):K ≥ 0.27 時連 r = 0 都在 slip(K=1.0 時
            33 次)—— 大 kick 打在任意 offset 上等於強隨機走;中等 r 反而有一條淺谷
            (detuning 與 kick 隨機走部分抵銷),但沒有任何一格能與 full 的綠區相比。
          </li>
          <li>
            圖一(PMUX grid):失鎖邊界從 r ≈ 1 內縮 —— nearest/ef1 縮到 r ≈ 0.9,
            mash11 到 r ≈ 0.6,mash111 到 r ≈ 0.2:<b>同一把 DSM,grid 粗 64 倍之後
            從無害變成失鎖主因</b>。
          </li>
          <li>
            圖二:past-edge(r = 1.1)的 drift 是等斜率爬梯(每 2π 一個紅點);
            lock-edge(r = 0.9)的 θ⁺ 貼著 θ_ss = 1.12 rad 抖動,離 unstable 2.02 rad
            遠得很 —— ε_hw 的細鋸齒(±0.043 rad)在圖上幾乎看不見。
          </li>
          <li>
            圖二切到 N = 3.125/3.000(on-grid):ε_hw ≡ 0,軌跡退化成 Ch13 的純
            dynamics —— DSM 殘餘誤差是 off-grid α 才有的現象。
          </li>
          <li>
            圖四:藍線(e_inj)與黃虛線(|H|²·S_ε 預測)重合 —— 混進非線性 sin map
            的 shaped 噪聲仍然精確走線性 high-pass;低頻抑制對 DSM 毫無用武之地,
            因為 shaped 能量根本不在低頻。
          </li>
          <li>
            圖五:K 拉大 → 低頻抑制變強(250 MHz 處 |H| 從 0.88(K=0.3)掉到 0.60
            (K=0.6)),但高頻 |H| 永遠 ≥ 1(趨近 2/(2−K),K=1 時達 2)——{' '}
            <b>加大 K 也擋不住高頻誤差</b>,它只能靠把誤差本身做小(grid)解決。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解 1:「DSM 把量化誤差 shaping 掉了,所以 injection 也變準」">
          <p>
            錯,兩個層面。(i) per-edge:DSM 的瞬時峰值<b>變大</b>(0.48 → 1.76 LSB,
            Ch11/Ch21),每一拍 pulse 打在更歪的 offset 上。(ii) 頻譜:injection loop
            對 scheduling error 是 high-pass H(z) = (z−1)/(z−(1−K)) —— 它只會修
            <b>低頻</b>誤差,而 DSM 恰把能量搬到<b>高頻</b>(|H| ≈ 1–1.18 的頻段),
            e_inj 峰值甚至比 ε_hw 大 18%(圖四)。shaping 的收益屬於 PLL loop 低通
            之後的 in-band 頻譜(Ch21 Layer 3),與 ZC 對準無關。幸運的是殘餘峰值
            只有 basin 的 1/73–1/267 —— 所以「不變準」但也「不脫鎖」。
            <EpistemicTag kind="EXPERIMENT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解 2:「只要 |ω₀| ≤ K_inj,DSM/量化誤差就與失鎖無關」">
          <p>
            靜態 lock 條件只保證 fixed point <b>存在</b>;margin M(r) = π − 2·asin(r)
            在邊界附近以 √(1−r) 塌掉(M(0.99) 只剩 0.283 rad)。full DTC 的 0.043 rad
            峰值仍有 6.6× 裕度,但 PMUX-grid 的 0.75–2.5 rad 峰值使實測 slip onset
            內縮到 r ≈ 0.9/0.6/0.2(隨 DSM 階數),dsm_only 更是 r = 0 就失鎖(exp21b
            的 Δf = 1 MHz 對 K = 0.4 只有 r = 0.004!)。判斷失鎖要同時看
            <b>誤差峰值(rad)與 M(r)</b>,不是只看 lock range。
            <EpistemicTag kind="EXPERIMENT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <p>
          <b>標題問題的答案:sub-LSB DSM 殘餘誤差本身不會讓 injection-locked VCO
          脫鎖 —— 前提是 actuator grid 夠細、且不在 lock range 邊緣操作。</b>三個
          regime(全部實測,N=3.13、seed 12345):
        </p>
        <ul>
          <li>
            <b>(1) full 6-bit DTC actuator:</b>DSM 峰值 0.012–0.043 rad,對 basin
            半寬 π 是 73–267× 裕度 —— lock map 上 r ≤ 1.0 全綠、與 quantizer 無關,
            fine 掃描(K=0.4)到 r = 1.01 才首見 slip(nearest 與 mash111{' '}
            <b>同一格</b>,σ = 0.02 也不變;更小的 K 因漂移慢,256 拍窗內 onset
            反而更晚)。DSM 的代價是 spur/jitter(Ch11/Ch16)與 e_inj 峰值 +18%,
            <b>不是</b> lock。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            <b>(2) lock range 邊緣(r → 1):</b>margin 以 2√(2(1−r)) 塌掉,任何殘餘
            誤差 + noise 都會先於靜態邊界觸發偶發 slip —— 但對 full DTC 的 sub-LSB
            峰值,這個內縮小於 Δr = 0.01(量測解析度)。真正把邊界拉進來的是粗 grid:
            PMUX 級實測 onset r ≈ 0.9(nearest/ef1)、0.6(mash11)、0.2(mash111)。
            <EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            <b>(3) 粗 actuator(dsm_only):</b>ε_hw 掃滿 ±π,margin = 0,ungated
            必失鎖(tail rms 1.81 rad);需要 threshold gating 才能換回有界 residual
            (0.102 rad @ 13% fire rate,Ch13/exp21)。mash11/mash111 連 model 都
            擋下(倒退 edge)。<EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
        <p>
          <b>設計規則(一行):</b>把每一拍的排程誤差預算成 rad,要求{' '}
          <M>{'\\operatorname{peak}|\\varepsilon_{hw}| + \\text{noise tail} \\ll \\pi - 2\\arcsin(\\omega_0/K_{inj})'}</M>
          ,並記住三件事:injection loop 是 high-pass(高頻誤差 1:1 直達 ZC,加大 K
          無解);DSM 提高峰值、grid 縮小峰值(先買 grid,Ch21);判準偏樂觀 ——
          高階 DSM 的實測 onset 比單拍峰值預測早 0.14–0.18 個 r(mash11/mash111,
          Δr=0.01 細掃),nearest/ef1 則與預測差 ≤ 0.03。
          <EpistemicTag kind="INFERENCE" />
        </p>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <ul>
            <li>
              sin map 是 injection locking 的一階近似 <EpistemicTag kind="APPROX" />:
              真實 PDR/PRC 的 basin 可能更窄、不對稱,unstable 點位置與 π − θ_ss
              不同 —— margin ratio 73–267× 的<b>數量級</b>結論穩健,精確邊界不可
              直接沿用(可用 Ch13 的 LUT 匯入實測曲線重跑)。
            </li>
            <li>
              amplitude dynamics(AM-PM、pulse 能量隨 offset 變化,Ch14)與 PLL loop
              的 frequency pullback(loop 會把平均 Δf 積分歸零,等效把工作點拉離
              r → 1)皆未建模 —— 本章的 detuning 是固定的 worst case。
            </li>
            <li>
              slip 偵測是行為 proxy(drift 範圍每 2π 記一次):它偵測不到「跨過
              unstable 點又被 noise 推回」的未遂事件;{N_MAP} 拍的觀察窗也會低估
              慢速 slip(小 K 的 r &gt; 1 格顯示 0)。
            </li>
            <li>
              PMUX-grid actuator 是<b>思想實驗</b>(真實 chain 一定帶 DTC;Ch21 同):
              用來把「grid 粗細」與「DSM 階數」正交化。dsm_only 的 mash11/mash111
              會產生倒退 divider edge,model 以 A_FB 單調性 assert 擋下 —— 表格/UI
              以缺格呈現,不是量測值。
            </li>
            <li>
              單一 realization(seed 12345)、單一 N 錨點(3.13);噪聲只有 σ_vco_w
              白噪(random walk、ref/pulse jitter 關閉)。slip onset 的統計分布需要
              ensemble 掃描。
            </li>
          </ul>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="參數 — Chapter 22">
        <SelectControl<Quantizer>
          label="Quantizer(map/軌跡共用)"
          value={effQuant}
          options={act === 'dsm_only' ? QUANT_OPTIONS.filter((q) => dsmOnlyAllowed(q.value)) : QUANT_OPTIONS}
          onChange={setQuant}
        />
        <SelectControl<ActKey>
          label="Actuator grid"
          value={act}
          options={ACT_OPTIONS}
          onChange={setAct}
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
          label="σ_vco_w(white noise)"
          value={sigma}
          min={0}
          max={0.05}
          step={0.001}
          unit="rad"
          onChange={setSigma}
        />
        <Slider label="K_inj(圖二/圖五)" value={kSel} min={0.02} max={1} step={0.01} onChange={setKSel} />
        <Slider
          label="r = ω₀/K(圖二)"
          value={rSel}
          min={0}
          max={1.2}
          step={0.01}
          onChange={setRSel}
        />
        <PresetButtons
          label="Canonical 軌跡點(K=0.4)"
          presets={[
            {
              label: 'deep-lock r=0.1',
              onClick: () => {
                setKSel(0.4);
                setRSel(0.1);
              },
            },
            {
              label: 'lock-edge r=0.9',
              onClick: () => {
                setKSel(0.4);
                setRSel(0.9);
              },
            },
            {
              label: 'past-edge r=1.1',
              onClick: () => {
                setKSel(0.4);
                setRSel(1.1);
              },
            },
          ]}
        />
        <p style={{ fontSize: 12, opacity: 0.75 }}>
          目前 ω₀ = r·K = {trimNumber(omega0, 4)} rad/cycle(Δf ={' '}
          {trimNumber((omega0 * F_REF) / TWO_PI / 1e6, 4)} MHz);
          {thetaSs !== null
            ? `θ_ss = ${trimNumber(thetaSs, 4)} rad,margin M = ${trimNumber(margin, 4)} rad`
            : 'r > 1:無 fixed point(靜態失鎖)'}
          。map 固定 {N_MAP} cycles/格(144 格);頻譜/margin 峰值固定 K = {K_SPEC}、
          Δf = 0、σ = 0。dsm_only 只允許 nearest/ef1(A_FB 單調性)。seed 12345,全部
          deterministic。
        </p>
      </ParamPanel>
    </ChapterShell>
  );
}
