/**
 * Chapter 16 — Spur 與相位雜訊分析 Spur and Phase-Noise Analysis
 *
 * 內容契約:CHAPTER_GUIDE.md Ch16;數學契約:MODEL_SPEC.md §17(measurement
 * conventions:sample rate = f_ref、f_spur = m/P·f_ref、Hann PSD、dBc
 * convention 全文引用)、§12(fixed seed)、§15(誤差性質 → 頻譜後果)。
 * 互動圖:#17 Hann PSD、#18 spur markers(標 m/P·f_ref);
 * 五種 error-signature preset 一鍵切換。所有計算經由 ../model。
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
import { M, MathBlock } from '../components/Math';
import ExampleProblem, { fmt } from '../components/ExampleProblem';
import { ParamPanel, Slider, SelectControl, Toggle, PresetButtons } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import DebugTable from '../components/DebugTable';
import { makeLineOption, makeMarkLine } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { formatPhase, phaseAxisLabel, makePhaseTickFormatter, trimNumber } from '../lib/format';
import { N_DIV_ALL_PRESETS } from '../lib/globalParams';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  simulate,
  fromPartial,
  periodogramPsd,
  detectSpurs,
  psdToDbcPerHz,
  toneAmpToDbc,
  integratedPhase,
  mean,
  rms,
  db20,
  wrap01,
  qFloor,
  configG,
  cyclesToRadians,
  TWO_PI,
} from '../model';
import type { SimConfig, Spur } from '../model';

const meta = chapterById(16)!;

const LSB = 1 / 256;
/** 10*log10(2):psdDb(10log10 S)→ dBc/Hz(10log10 S/2)的常數差,顯示用 */
const LOG2_DB = 10 * Math.log10(2);
const FLOOR_DB = -220; // 顯示下限(數值 floor 以下截斷,僅影響畫面)

/* ------------------------------------------------- 五種 error signature */

type SigId = 'spur' | 'broadband' | 'offset' | 'rj' | 'pj';

interface SigPreset {
  id: SigId;
  label: string;
  zh: string;
  mechanism: string;
  signature: string;
  /** 週期 P(deterministic periodic 時才有;f_spur = m/P · f_ref) */
  P: number | null;
  partial: Partial<SimConfig>;
}

const SIG_PRESETS: SigPreset[] = [
  {
    id: 'spur',
    label: 'deterministic spur',
    zh: '確定性 spur',
    mechanism: '0.125 LSB 週期量化誤差(N = 3 + 32.125/256,nearest)',
    signature: '離散 tone @ m·(f_ref/8) = m·500 MHz(恰落在 FFT bin 上)',
    P: 8,
    partial: { n_div: 3 + 32.125 / 256, quantizer: 'nearest' },
  },
  {
    id: 'broadband',
    label: 'broadband',
    zh: '寬頻 noise floor',
    mechanism: 'VCO white phase noise 0.02 rad/cycle + sin injection K=0.3(N=3.125 on-grid)',
    signature: '無離散 tone 的連續 floor',
    P: null,
    partial: { n_div: 3.125, sigma_vco_w_rad: 0.02, inj_model: 'sin', k_inj: 0.3 },
  },
  {
    id: 'offset',
    label: 'static offset',
    zh: '固定 offset',
    mechanism: 'route_INJ = 2 LSB 靜態 skew(N=3.125,無 noise;exp16)',
    signature: '能量全部集中在 DC(近 DC 的 Hann main lobe)',
    P: null,
    partial: { n_div: 3.125, route_inj_cycles: 2 * LSB },
  },
  {
    id: 'rj',
    label: 'random jitter',
    zh: '隨機 jitter(RJ)',
    mechanism: 'reference jitter 100 fs rms(white)+ linear injection K=0.3(exp16)',
    signature: '白色 floor(無 tone)',
    P: null,
    partial: { n_div: 3.125, sigma_ref_s: 100e-15, inj_model: 'linear', k_inj: 0.3 },
  },
  {
    id: 'pj',
    label: 'periodic jitter',
    zh: '週期性 jitter(PJ)',
    mechanism: 'DTC sin INL 0.5 LSB + off-grid N=3.13(fine-code 小數增量 0.28 = 7/25 → P=25;exp14)',
    signature: '密集 tone @ m·(f_ref/25) = m·160 MHz',
    P: 25,
    partial: { n_div: 3.13, inl_sin_amp_cycles: 0.5 * LSB },
  },
];

/* ------------------------------------------------- spur summary table(全 N presets) */

/**
 * id + P(DTC grid,MODEL_SPEC §1.1)for every N_DIV_ALL_PRESETS entry, keyed
 * by exact float64 n(與 globalParams.test.ts 的 EXPECTED_PERIOD 同一份真值,
 * 已經 errorPeriod() 數值驗證過)。P = null 表示 quasi-periodic(F8)。
 */
const N_PERIOD_INFO: ReadonlyMap<number, { id: string; P: number | null }> = new Map([
  [3.0, { id: '—', P: 1 }],
  [3.125, { id: '—', P: 1 }],
  [3.13, { id: '—', P: 25 }],
  [3.1375, { id: '—', P: 5 }],
  [3.25, { id: '—', P: 1 }],
  [3.126953125, { id: 'F1', P: 2 }],
  [3.1259765625, { id: 'F2', P: 4 }],
  [3.125390625, { id: 'F3', P: 10 }],
  [3.1250390625, { id: 'F4', P: 100 }],
  [3.2, { id: 'F5', P: 5 }],
  [3.22265625, { id: 'F6', P: 1 }],
  [3.001, { id: 'F7', P: 125 }],
  [3.1545084971874737, { id: 'F8', P: null }],
]);

/** n_cycles used by the summary sweep — independent of the chapter's own n_cycles selector. */
const SPUR_SUMMARY_N_CYCLES = 1024;

interface SpurSummaryDetection {
  fMhz: number;
  levelDbcHz: number;
}

interface SpurSummaryRow {
  id: string;
  nLabel: string;
  n: number;
  P: number | null;
  spacingMhz: number | null; // predicted f_ref/P;null when P=1(on-grid,無 fractional spur)或 P=null(F8)
  detections: SpurSummaryDetection[]; // top-5,降冪排序
}

/**
 * 對 N_DIV_ALL_PRESETS 每一個 N 重跑一次模擬(quantizer='nearest' — 本章
 * 所有 SIG_PRESETS 明講或預設值都落在這個 quantizer,是「章節目前的
 * quantizer」;其餘欄位一律 defaultConfig,即純 feedback quantization,
 * 不含 injection/noise,才能讓 spur 位置乾淨對應 P),detectSpurs 抓
 * e_ZC_total 的 top-5。
 */
function computeSpurSummary(thresholdDb: number): SpurSummaryRow[] {
  return N_DIV_ALL_PRESETS.map((preset) => {
    const info = N_PERIOD_INFO.get(preset.n) ?? { id: '—', P: null };
    const cfg = fromPartial({
      n_div: preset.n,
      n_cycles: SPUR_SUMMARY_N_CYCLES,
      quantizer: 'nearest',
    });
    const res = simulate(cfg);
    const phi = Float64Array.from(res.data.e_ZC_total, (v) => TWO_PI * v);
    const { freqsHz, psd } = periodogramPsd(phi, cfg.f_ref_hz);
    const spurs = detectSpurs(freqsHz, psd, thresholdDb);
    const detections: SpurSummaryDetection[] = spurs.slice(0, 5).map((s) => ({
      fMhz: s.freqHz / 1e6,
      levelDbcHz: s.psdDb - LOG2_DB,
    }));
    const spacingMhz = info.P !== null && info.P > 1 ? cfg.f_ref_hz / info.P / 1e6 : null;
    return {
      id: info.id,
      nLabel: preset.label,
      n: preset.n,
      P: info.P,
      spacingMhz,
      detections,
    };
  });
}

/* ---------------------------------------------------------- 真實模型碼節錄 */

const CODE_EXCERPT = `// web/src/model/measurements.ts — Hann-window periodogram(MODEL_SPEC §17)
export function periodogramPsd(
  x: ArrayLike<number>,
  fs: number,
): { freqsHz: Float64Array; psd: Float64Array } {
  const xt = pow2Truncate(x);
  const n = xt.length;
  const w = new Float64Array(n);
  let u = 0.0;
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / n);
    u += w[i] * w[i];
  }
  u /= n;
  const xw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xw[i] = xt[i] * w[i];
  }
  const { re, im } = rfft(xw);
  const m = re.length;
  const psd = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    psd[i] = (re[i] * re[i] + im[i] * im[i]) / (fs * n * u);
  }
  for (let i = 1; i < m - 1; i++) {
    psd[i] *= 2.0; // one-sided (DC and Nyquist not doubled)
  }
  // bin spacing fs/n (n is a power of 2 -> exact); freqs[last] == fs/2
  const freqsHz = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    freqsHz[i] = i * (fs / n);
  }
  return { freqsHz, psd };
}

// dBc helpers(同檔):
export function toneAmpToDbc(aRad: number): number {
  return 20.0 * Math.log10(aRad / 2.0);
}`;

/* ------------------------------------------ shaped-noise folding 比較設定 */

/** 模擬長度;PSD 分析取後 1024 拍(2 的冪)避開 θ 收斂 transient。 */
const FOLD_N = 1536;
const FOLD_QS = ['nearest', 'ef1', 'mash11', 'mash111'] as const;
type FoldQ = (typeof FOLD_QS)[number];
type FoldSigmaStr = '0' | '0.002';

/* ---------------------------------------------------------------- 章節主體 */

type NCyclesStr = '256' | '512' | '1024';

/* ---------------------------------------------------------------------------
 * 數值例子(SectionExample):三個互動 worked example。
 * compute 皆為 pure function,dBc / shaping / 週期偵測全部建立在 ../model
 * (toneAmpToDbc / db20 / cyclesToRadians / configG / wrap01 / simulate)
 * 之上,沒有任何寫死的答案常數。
 * ------------------------------------------------------------------------- */

const EX_N_SIM = 128; // 例 2 的模擬長度(週期偵測用)
const EX_PERIOD_TOL = 1e-9; // cycles;e_ZC_hw 逐位比較的容差

/** 由 model 輸出的 e_ZC_hw 找最小重複週期 P(找不到回傳 null)。 */
function findPeriod(e: Float64Array, pMax: number, tol: number): number | null {
  for (let p = 1; p <= pMax; p++) {
    let ok = true;
    for (let i = 0; i + p < e.length; i++) {
      if (Math.abs(e[i + p] - e[i]) > tol) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
  }
  return null;
}

const EX_DBC_INPUTS = [
  {
    key: 'aLsb',
    label: (
      <>
        tone 幅度 <M>{'a'}</M>
      </>
    ),
    def: 1,
    min: 0.001,
    max: 64,
    step: 0.01,
    unit: 'LSB',
  },
  { key: 'frefGHz', label: <M>{'f_{ref}'}</M>, def: 4, min: 0.1, max: 20, step: 0.1, unit: 'GHz' },
  { key: 'nfft', label: <>FFT 長度 <M>{'N'}</M></>, def: 512, min: 8, max: 65536, step: 1 },
];

function exDbcCompute(v: Record<string, number>) {
  const cfg = fromPartial({ f_ref_hz: v.frefGHz * 1e9 });
  const g = configG(cfg);
  const aCyc = v.aLsb / g;
  const aRad = cyclesToRadians(aCyc);
  const dbc = toneAmpToDbc(aRad);
  const nfft = qFloor(v.nfft);
  const binHz = cfg.f_ref_hz / nfft;
  return {
    steps: [
      {
        label: (
          <>
            <M>{'a'}</M> 換算成 cycles(1 LSB = 1/{g} cycle)
          </>
        ),
        value: fmt(aCyc, 8, 'cyc'),
      },
      {
        label: (
          <>
            <M>{'a'}</M> 換算成 rad(<M>{'2\\pi\\times'}</M> cycles)
          </>
        ),
        value: fmt(aRad, 8, 'rad'),
      },
      {
        label: (
          <>
            single sideband 幅度 <M>{'a/2'}</M>(narrowband FM 一階展開)
          </>
        ),
        value: fmt(aRad / 2, 8, 'rad'),
      },
      {
        label: (
          <>
            SSB spur <M>{'= 20\\log_{10}(a/2)'}</M>
          </>
        ),
        value: fmt(dbc, 7, 'dBc'),
      },
      {
        label: (
          <>
            FFT bin 間距 <M>{'\\Delta f = f_{ref}/N'}</M>(取樣率 = <M>{'f_{ref}'}</M>)
          </>
        ),
        value: fmt(binHz / 1e6, 7, 'MHz'),
      },
      {
        label: (
          <>
            最高可觀測頻率 <M>{'f_{ref}/2'}</M>
          </>
        ),
        value: fmt(cfg.f_ref_hz / 2e6, 7, 'MHz'),
      },
    ],
    answer: (
      <>
        SSB spur = {fmt(dbc, 7, 'dBc')}(<M>{'a'}</M> = {fmt(aRad, 6, 'rad')});bin 間距{' '}
        {fmt(binHz / 1e6, 7, 'MHz')}
      </>
    ),
    warn:
      aRad > 0.2
        ? `a = ${fmt(aRad, 4)} rad 已不算 small angle,20log10(a/2) 的一階展開開始失準(高階 sideband 不可忽略)`
        : undefined,
  };
}

const EX_SPUR_INPUTS = [
  { key: 'nDiv', label: <M>{'N'}</M>, def: 3 + 32.125 / 256, min: 3, max: 3.25, step: 0.0001 },
  { key: 'frefGHz', label: <M>{'f_{ref}'}</M>, def: 4, min: 0.1, max: 20, step: 0.1, unit: 'GHz' },
  {
    key: 'pMax',
    label: (
      <>
        搜尋上限 <M>{'P_{max}'}</M>
      </>
    ),
    def: 64,
    min: 1,
    max: EX_N_SIM / 2,
    step: 1,
  },
];

function exSpurCompute(v: Record<string, number>) {
  const cfg = fromPartial({
    n_div: v.nDiv,
    f_ref_hz: v.frefGHz * 1e9,
    n_cycles: EX_N_SIM,
    quantizer: 'nearest',
  });
  const g = configG(cfg);
  const res = simulate(cfg);
  const e = res.data.e_ZC_hw;
  const frac = wrap01(g * cfg.n_div); // 每拍 fine code 的小數增量
  const p = findPeriod(e, qFloor(v.pMax), EX_PERIOD_TOL);
  const eRmsLsb = rms(e) * g;
  const mMax = p === null ? 0 : qFloor(p / 2);
  const fSpur1 = p === null ? Number.NaN : cfg.f_ref_hz / p;
  const list: string[] = [];
  if (p !== null) {
    for (let m = 1; m <= Math.min(mMax, 4); m++) {
      list.push(fmt((m * cfg.f_ref_hz) / p / 1e6, 6));
    }
  }
  return {
    steps: [
      {
        label: (
          <>
            每拍 fine code 增量 <M>{'G\\,N'}</M>
          </>
        ),
        value: fmt(g * cfg.n_div, 10, 'LSB'),
      },
      {
        label: (
          <>
            其小數部分 <M>{'\\operatorname{wrap01}(G N)'}</M>
          </>
        ),
        value: fmt(frac, 8, 'LSB'),
      },
      {
        label: <>模擬 {EX_N_SIM} 拍後 e_ZC,hw 的 rms</>,
        value: fmt(eRmsLsb, 6, 'LSB'),
      },
      {
        label: (
          <>
            最小重複週期 <M>{'P'}</M>(逐位比較,容差 {fmt(EX_PERIOD_TOL, 2)} cyc)
          </>
        ),
        value: p === null ? `> ${qFloor(v.pMax)}(未在搜尋範圍內重複)` : `${p} 拍`,
      },
      {
        label: (
          <>
            基頻 <M>{'f_{ref}/P'}</M>
          </>
        ),
        value: p === null ? '—' : fmt(fSpur1 / 1e6, 7, 'MHz'),
      },
      {
        label: (
          <>
            spur 序號範圍 <M>{'m = 1..\\lfloor P/2 \\rfloor'}</M>
          </>
        ),
        value: p === null ? '—' : mMax === 0 ? '無(P = 1,誤差為 DC)' : `1 .. ${mMax}`,
      },
      {
        label: (
          <>
            前幾根 spur <M>{'m\\,f_{ref}/P'}</M>
          </>
        ),
        value: list.length === 0 ? '—' : `${list.join(', ')} MHz`,
      },
    ],
    answer:
      p === null ? (
        <>
          在 <M>{'P \\le'}</M> {qFloor(v.pMax)} 內找不到週期:誤差序列非短週期,頻譜呈現密集
          tone 或近似 floor
        </>
      ) : mMax === 0 ? (
        <>
          <M>{'P'}</M> = 1:e_ZC,hw 每拍相同(rms = {fmt(eRmsLsb, 6, 'LSB')}),能量集中在
          DC,不產生 spur
        </>
      ) : (
        <>
          <M>{'P'}</M> = {p} → spur 位於 <M>{'m\\,f_{ref}/P'}</M> ={' '}
          {fmt(fSpur1 / 1e6, 7, 'MHz')} 的整數倍,<M>{'m'}</M> = 1..{mMax}
        </>
      ),
    warn:
      p !== null && p > EX_N_SIM / 4
        ? `P = ${p} 已接近 ${EX_N_SIM} 拍模擬能可靠判定的上限,建議在圖 #17 用更長序列確認`
        : undefined,
  };
}

const EX_FOLD_INPUTS = [
  {
    key: 'ePkLsb',
    label: (
      <>
        peak <M>{'|e_{FB,abs}|'}</M>
      </>
    ),
    def: 1.76,
    min: 0.01,
    max: 128,
    step: 0.01,
    unit: 'LSB',
  },
  { key: 'order', label: <>DSM 階數 <M>{'m'}</M></>, def: 3, min: 1, max: 5, step: 1 },
  {
    key: 'foffMHz',
    label: <>offset 頻率 <M>{'f'}</M></>,
    def: 100,
    min: 0.01,
    max: 2000,
    step: 1,
    unit: 'MHz',
  },
  { key: 'frefGHz', label: <M>{'f_{ref}'}</M>, def: 4, min: 0.1, max: 20, step: 0.1, unit: 'GHz' },
];

function exFoldCompute(v: Record<string, number>) {
  const cfg = fromPartial({ f_ref_hz: v.frefGHz * 1e9 });
  const g = configG(cfg);
  const m = qFloor(v.order);
  const fHz = v.foffMHz * 1e6;
  const epsPk = cyclesToRadians(v.ePkLsb / g); // rad
  const hAmp = (2 * Math.sin((Math.PI * fHz) / cfg.f_ref_hz)) ** m; // |1-e^{-j2pi f/fref}|^m
  const hDb = db20(hAmp);
  const aShaped = epsPk * hAmp;
  const dbcShaped = toneAmpToDbc(aShaped);
  const foldRatio = (epsPk * epsPk) / 6; // sin map 三階項相對線性項
  const foldDb = db20(foldRatio);
  const marginDb = foldDb - hDb;
  return {
    steps: [
      {
        label: (
          <>
            <M>{'\\varepsilon_{pk} = 2\\pi\\,e_{pk}/G'}</M>
          </>
        ),
        value: fmt(epsPk, 7, 'rad'),
      },
      {
        label: (
          <>
            NTF 幅度 <M>{'(2\\sin(\\pi f/f_{ref}))^{m}'}</M>
          </>
        ),
        value: fmt(hAmp, 7),
      },
      {
        label: <>換成 dB(振幅,20log10)</>,
        value: fmt(hDb, 7, 'dB'),
      },
      {
        label: (
          <>
            shaped in-band tone 幅度 <M>{'\\varepsilon_{pk}\\cdot H'}</M>
          </>
        ),
        value: fmt(aShaped, 7, 'rad'),
      },
      {
        label: (
          <>
            其 SSB 位準 <M>{'20\\log_{10}(a/2)'}</M>
          </>
        ),
        value: fmt(dbcShaped, 7, 'dBc'),
      },
      {
        label: (
          <>
            sin map 三階折返相對量 <M>{'\\varepsilon_{pk}^{2}/6'}</M>
          </>
        ),
        value: `${fmt(foldRatio, 7)} = ${fmt(foldDb, 7, 'dB')}`,
      },
      {
        label: <>折返相對 shaped in-band tone 的裕度</>,
        value: fmt(marginDb, 7, 'dB'),
      },
    ],
    answer: (
      <>
        shaped tone = {fmt(dbcShaped, 7, 'dBc')}(NTF 抑制 {fmt(hDb, 7, 'dB')});三階折返{' '}
        {fmt(foldDb, 7, 'dB')},比 shaped tone 低 {fmt(-marginDb, 6, 'dB')} →{' '}
        {marginDb < 0 ? 'shaping 在 in-band 存活' : '折返主導,shaping 失效'}
      </>
    ),
    warn:
      marginDb >= 0
        ? `折返項高於 shaped in-band tone(裕度 ${fmt(marginDb, 4)} dB):injection 非線性把高頻 shaped noise 折回 in-band,量到的 floor 不再是 (2sin)^m`
        : undefined,
  };
}

export default function Chapter16() {
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const [sigId, setSigId] = useState<SigId>('spur');
  const [nCyclesStr, setNCyclesStr] = useState<NCyclesStr>('1024');
  const [thresholdDb, setThresholdDb] = useState(30);
  const [showMarkers, setShowMarkers] = useState(true);

  const preset = SIG_PRESETS.find((p) => p.id === sigId) ?? SIG_PRESETS[0];
  const nCycles = Number(nCyclesStr);

  // 模擬 + PSD(fixed seed 12345:每次重跑逐位一致)
  const sim = useMemo(() => {
    const cfg = fromPartial({ ...preset.partial, n_cycles: nCycles });
    const res = simulate(cfg);
    const eZc = res.data.e_ZC_total; // cycles
    const phi = Float64Array.from(eZc, (v) => TWO_PI * v); // rad
    const { freqsHz, psd } = periodogramPsd(phi, cfg.f_ref_hz);
    const dbc = psdToDbcPerHz(psd);
    return {
      cfg,
      tVco: res.t_vco_s,
      eZc,
      rmsCycles: rms(eZc),
      freqsHz,
      psd,
      dbc,
    };
  }, [preset, nCycles]);

  const spurs: Spur[] = useMemo(
    () => detectSpurs(sim.freqsHz, sim.psd, thresholdDb),
    [sim, thresholdDb],
  );

  useEffect(() => {
    setStatus('done', `${preset.label}: ${nCycles} cycles → PSD(fs = f_ref = 4 GHz)`);
  }, [preset, nCycles, setStatus]);

  /* -------------------------------------- spur summary table(全 N presets) */

  // job = 使用者按下按鈕當下的 snapshot(threshold 用當時的值,之後滑動
  // slider 不會偷偷重跑);null = 尚未執行過。
  const [spurSummaryJob, setSpurSummaryJob] = useState<{ token: number; thresholdDb: number } | null>(
    null,
  );
  const [spurSummaryRows, setSpurSummaryRows] = useState<SpurSummaryRow[] | null>(null);
  const [spurSummaryPending, setSpurSummaryPending] = useState(false);

  useEffect(() => {
    if (spurSummaryJob === null) return;
    setSpurSummaryPending(true);
    setStatus(
      'running',
      `spur summary:掃描全部 ${N_DIV_ALL_PRESETS.length} 個 N presets(${SPUR_SUMMARY_N_CYCLES} cycles)…`,
    );
    // post-paint:先讓 spinner 畫出來,再跑 13 次 simulate()。
    const id = window.setTimeout(() => {
      const rows = computeSpurSummary(spurSummaryJob.thresholdDb);
      setSpurSummaryRows(rows);
      setSpurSummaryPending(false);
      setStatus(
        'done',
        `spur summary:${N_DIV_ALL_PRESETS.length} 個 N presets(threshold = median + ${spurSummaryJob.thresholdDb} dB)`,
      );
    }, 0);
    return () => window.clearTimeout(id);
  }, [spurSummaryJob, setStatus]);

  const spurSummaryTableRows = useMemo(() => {
    if (spurSummaryRows === null) return [];
    const out: Record<string, unknown>[] = [];
    for (const r of spurSummaryRows) {
      if (r.detections.length === 0) {
        out.push({
          id: r.id,
          n_label: r.nLabel,
          P: r.P ?? '—',
          spacing_mhz: r.spacingMhz,
          rank: '—',
          f_mhz: null,
          level_dbc_hz: null,
          note: '(無 spur ≥ threshold)',
        });
        continue;
      }
      r.detections.forEach((d, i) => {
        out.push({
          id: r.id,
          n_label: r.nLabel,
          P: r.P ?? '—',
          spacing_mhz: r.spacingMhz,
          rank: i + 1,
          f_mhz: d.fMhz,
          level_dbc_hz: d.levelDbcHz,
          note: '',
        });
      });
    }
    return out;
  }, [spurSummaryRows]);

  /* ------------------------------------------------------------ 圖表選項 */

  // 時域:前 128 拍
  const timeOption = useMemo(() => {
    const m = Math.min(128, sim.eZc.length);
    const data: [number, number][] = [];
    for (let k = 0; k < m; k++) {
      data.push([k, sim.eZc[k]]);
    }
    return makeLineOption({
      xLabel: 'k(reference cycle;sample rate = f_ref,非 f_vco)',
      yLabel: phaseAxisLabel('e_ZC_total', unit, sim.tVco),
      yTickFormatter: makePhaseTickFormatter(unit, sim.tVco),
      zoom: false,
      series: [
        {
          name: preset.label,
          data,
          step: 'middle',
          showSymbol: false,
          color: ct.accent,
        },
      ],
    });
  }, [sim, preset, unit, ct]);

  // #17 PSD + #18 spur markers
  const psdOption = useMemo(() => {
    const line: [number, number][] = [];
    for (let i = 1; i < sim.freqsHz.length; i++) {
      line.push([sim.freqsHz[i] / 1e6, Math.max(sim.dbc[i], FLOOR_DB)]);
    }
    const spurPts: [number, number][] = spurs.map((s) => [
      s.freqHz / 1e6,
      Math.max(s.psdDb - LOG2_DB, FLOOR_DB),
    ]);
    const opt = makeLineOption({
      xLabel: 'frequency(MHz;Nyquist = f_ref/2 = 2000 MHz)',
      yLabel: 'S_phi / 2(dBc/Hz)',
      yMin: FLOOR_DB,
      series: [
        { name: 'Hann PSD(dBc/Hz)', data: line, color: ct.accent, width: 1.2 },
        {
          name: `detected spurs(> median + ${trimNumber(thresholdDb, 3)} dB)`,
          data: spurPts,
          type: 'scatter',
          symbolSize: 8,
          color: ct.bad,
        },
      ],
    });
    if (showMarkers && preset.P !== null) {
      const P = preset.P;
      const fRefMhz = sim.cfg.f_ref_hz / 1e6;
      const mMax = Math.min(8, Math.floor(P / 2));
      const marks = Array.from({ length: mMax }, (_, i) => ({
        x: ((i + 1) / P) * fRefMhz,
        label: `m=${i + 1}`,
        color: ct.warn,
      }));
      (opt as unknown as { series: Record<string, unknown>[] }).series[0].markLine =
        makeMarkLine(marks);
    }
    return opt;
  }, [sim, spurs, preset, showMarkers, thresholdDb, ct]);

  // spur 表(前 12 個,依強度排序)
  const spurRows = useMemo(
    () =>
      spurs.slice(0, 12).map((s, i) => {
        const mEst =
          preset.P !== null ? Math.round(s.freqHz / (sim.cfg.f_ref_hz / preset.P)) : null;
        return {
          rank: i + 1,
          f_mhz: s.freqHz / 1e6,
          level_dbc_hz: s.psdDb - LOG2_DB,
          m_over_P: mEst !== null && preset.P !== null ? `${mEst}/${preset.P}` : '—',
        };
      }),
    [spurs, preset, sim],
  );

  /* ------------------------------ shaped-noise folding(圖 #17b)------- */

  const [foldSigma, setFoldSigma] = useState<FoldSigmaStr>('0');
  const [foldGate, setFoldGate] = useState(false);

  const foldSims = useMemo(() => {
    const sigma = Number(foldSigma);
    const run = (q: FoldQ, gated: boolean) => {
      const cfg = fromPartial({
        n_div: 3.13,
        arch_mode: 'D',
        quantizer: q,
        inj_model: 'sin',
        k_inj: 0.3,
        delta_f_hz: 1e6,
        sigma_vco_w_rad: sigma,
        n_cycles: FOLD_N,
        ...(gated
          ? { inj_gate_mode: 'threshold' as const, inj_gate_threshold_cycles: 0.002 }
          : {}),
      });
      const res = simulate(cfg);
      // steady state:後 1024 拍;移除 mean(靜態 offset 歸 DC,見 exp16)
      const tail = res.data.e_ZC_total.subarray(FOLD_N - 1024);
      const mu = mean(tail);
      const phi = Float64Array.from(tail, (v) => TWO_PI * (v - mu)); // rad
      const { freqsHz, psd } = periodogramPsd(phi, cfg.f_ref_hz);
      const f = res.data.inj_fired.subarray(FOLD_N - 1024);
      let fired = 0;
      for (let i = 0; i < f.length; i++) fired += f[i];
      return {
        label: gated ? 'mash111 + gate th=0.002' : q,
        freqsHz,
        dbc: psdToDbcPerHz(psd),
        inbandRad: integratedPhase(freqsHz, psd, 1.0, 200e6),
        hibandRad: integratedPhase(freqsHz, psd, 1.5e9, 2.0e9),
        rmsRad: rms(phi),
        fired,
      };
    };
    return { rows: FOLD_QS.map((q) => run(q, false)), gated: run('mash111', true) };
  }, [foldSigma]);

  useEffect(() => {
    setStatus('done', `folding:5 configs × ${FOLD_N} cycles(σ_vco_w = ${foldSigma} rad)`);
  }, [foldSims, foldSigma, setStatus]);

  const foldOption = useMemo(() => {
    const mkLine = (s: { freqsHz: Float64Array; dbc: Float64Array }) => {
      const pts: [number, number][] = [];
      for (let i = 1; i < s.freqsHz.length; i++) {
        pts.push([s.freqsHz[i] / 1e6, Math.max(s.dbc[i], FLOOR_DB)]);
      }
      return pts;
    };
    const series = foldSims.rows.map((r, i) => ({
      name: r.label,
      data: mkLine(r),
      color: ct.series[i],
      width: 1.1,
    }));
    if (foldGate) {
      series.push({
        name: foldSims.gated.label,
        data: mkLine(foldSims.gated),
        color: ct.bad,
        width: 1.6,
      });
    }
    return makeLineOption({
      xLabel: 'frequency(MHz;steady-state 後 1024 拍,mean 已移除)',
      yLabel: 'S_phi / 2(dBc/Hz)',
      yMin: FLOOR_DB,
      series,
    });
  }, [foldSims, foldGate, ct]);

  const foldRows = useMemo(() => {
    const rows = foldSims.rows.map((r) => ({
      config: r.label,
      inband_urad: r.inbandRad * 1e6,
      hiband_mrad: r.hibandRad * 1e3,
      rms_mrad: r.rmsRad * 1e3,
      fired: r.fired,
    }));
    if (foldGate) {
      const g = foldSims.gated;
      rows.push({
        config: g.label,
        inband_urad: g.inbandRad * 1e6,
        hiband_mrad: g.hibandRad * 1e3,
        rms_mrad: g.rmsRad * 1e3,
        fired: g.fired,
      });
    }
    return rows;
  }, [foldSims, foldGate]);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            per-reference-cycle 誤差序列的取樣率是多少?為什麼是 f_ref 而
            <strong>不是</strong> f_vco?<EpistemicTag kind="EXACT" />
          </li>
          <li>
            週期 P 的 deterministic 誤差,spur 會出現在哪些頻率?
            (<M>{'f_{spur,m} = \\tfrac{m}{P} f_{ref}'}</M>)<EpistemicTag kind="EXACT" />
          </li>
          <li>
            Hann-window periodogram 怎麼正規化?dBc 與 dBc/Hz 的標示規則是什麼、
            何時<strong>不可</strong>標 dBc?<EpistemicTag kind="EXACT" />
          </li>
          <li>
            五種 error signature(deterministic spur / broadband / static offset /
            random jitter / periodic jitter)在時域與 PSD 上各長什麼樣?
            <EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          Scheduler 每個 reference edge 只做<strong>一次</strong>決策、產生一筆誤差樣本,
          所以 <M>{'e_{ZC}[k]'}</M> 這類序列天生就是取樣率 <M>{'f_{ref}'}</M>(預設 4 GHz)
          的離散訊號 — 兩個 reference edge 之間沒有其他觀測點,VCO 在中間跑了幾個
          cycle 都不會增加樣本數。Nyquist 因此是 <M>{'f_{ref}/2 = 2\\,\\mathrm{GHz}'}</M>。
        </p>
        <p>
          誤差的<strong>性質</strong>決定頻譜的<strong>簽名</strong>(MODEL_SPEC §15):
          固定誤差 → 靜態 phase offset(能量在 DC);週期誤差 → deterministic spur
          (能量集中在 <M>{'m/P \\cdot f_{ref}'}</M> 的離散 tone);
          noise-like 誤差 → phase-noise floor(能量攤平)。<EpistemicTag kind="INFERENCE" />
          反過來,看 PSD 就能推斷誤差來源:本章把 Ch11(量化)、Ch14(誤差性質)、
          Ch15(mismatch)全部接到頻域,用同一把尺(§17 conventions)量。
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>
          <strong>取樣率。</strong>MODEL_SPEC §17 原文:「per-reference-cycle sequence
          的 sample rate = <strong>f_ref</strong>(<strong>不是</strong> f_vco)」。
          <EpistemicTag kind="EXACT" /> 長度 N 的序列 FFT 後 bin 間距為
          <M>{'\\Delta f = f_{ref}/N'}</M>,最高頻率恰為 <M>{'f_{ref}/2'}</M>。
        </p>
        <p>
          <strong>週期序列的 spur 位置。</strong>若 <M>{'\\varphi[k] = \\varphi[k+P]'}</M>
          (週期 P 拍),頻譜只在基頻 <M>{'f_{ref}/P'}</M> 的整數倍有能量:
          <EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {'f_{spur,m} = \\frac{m}{P}\\, f_{ref}, \\qquad m = 1, 2, \\ldots, \\lfloor P/2 \\rfloor'}
        </MathBlock>
        <p>
          <strong>Hann periodogram(one-sided)。</strong>序列先截為 2 的冪長度 N,
          乘上 periodic Hann window 後取 FFT:<EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {'w[n] = 0.5 - 0.5\\cos\\!\\Big(\\frac{2\\pi n}{N}\\Big), \\qquad U = \\frac{1}{N}\\sum_{n=0}^{N-1} w[n]^2'}
        </MathBlock>
        <MathBlock>
          {'S_{\\varphi}[i] = \\frac{2\\,\\big|\\mathrm{FFT}(\\varphi w)[i]\\big|^2}{f_{ref}\\, N\\, U}'}
        </MathBlock>
        <p>
          (DC 與 Nyquist bin 不乘 2。)正規化 <M>{'U'}</M> 使 white noise 的 PSD
          積分後回到其 variance。<strong>dBc convention</strong> — MODEL_SPEC §17
          全文引用:
        </p>
        <Callout type="note" title="MODEL_SPEC §17 — dBc convention(逐字引用)">
          <p>
            「<strong>dBc convention</strong>:phase sequence <code>phi[k]</code>(rad)中幅度{' '}
            <code>a</code> rad 的 tone,small-angle 下 SSB spur ={' '}
            <code>20*log10(a/2)</code> dBc;PSD 曲線標 <code>10*log10(S_phi/2)</code> dBc/Hz
            (<code>S_phi</code> 單位 rad²/Hz)。未經 carrier normalization 的 phase PSD{' '}
            <strong>不可</strong>直接標 dBc。」<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
        <p>來源是 narrowband FM 的一階展開(small-angle):</p>
        <MathBlock>
          {'e^{j(\\omega_c t + a\\cos 2\\pi f_m t)} \\approx e^{j\\omega_c t}\\Big(1 + j\\frac{a}{2}e^{j2\\pi f_m t} + j\\frac{a}{2}e^{-j2\\pi f_m t}\\Big)'}
        </MathBlock>
        <p>
          兩個 sideband 相對 carrier 各為 <M>{'a/2'}</M>,故 SSB spur ={' '}
          <M>{'20\\log_{10}(a/2)'}</M> dBc。<EpistemicTag kind="EXACT" />
        </p>
      </SectionMath>

      <SectionMath>
        <p>
          <strong>Shaped noise 與 injection 非線性的 folding。</strong>phase DSM 的
          quantization error 是 <strong>high-pass shaped</strong> 的:ef1 / mash11 / mash111
          的遞迴(MODEL_SPEC §6)使誤差序列帶 noise transfer function{' '}
          <M>{'(1-z^{-1})^m'}</M>,<M>{'m = 1, 2, 3'}</M>。<EpistemicTag kind="EXACT" />{' '}
          in-band 振幅抑制因子:
        </p>
        <MathBlock>
          {
            '\\big|1 - e^{-j2\\pi f/f_{ref}}\\big|^{m} = \\Big(2\\sin\\frac{\\pi f}{f_{ref}}\\Big)^{m} \\;\\xrightarrow{f = 100\\,\\mathrm{MHz}}\\; -16.1 / -32.2 / -48.3\\ \\mathrm{dB}\\;(m=1/2/3)'
          }
        </MathBlock>
        <p>
          這個抑制只在<strong>線性</strong>系統中守得住。injection 每個 reference cycle 對
          error <M>{'e'}</M> 取樣一次並套用 memoryless 的 map <M>{'g(e)'}</M>;任何非線性的{' '}
          <M>{'g'}</M> 都會把 shaped noise 的高頻成分互調(intermodulation)後折回
          in-band — 高頻 tone 的乘積落在差頻上,表現為 spur skirts 或 floor lift。
          對 sin map 展開:<EpistemicTag kind="APPROX" />
        </p>
        <MathBlock>
          {
            'g(e) = -K_{inj}\\sin e = -K_{inj}\\Big(e - \\frac{e^{3}}{6} + \\cdots\\Big) \\quad\\text{(奇函數,無 } e^{2} \\text{ 項)}'
          }
        </MathBlock>
        <p>
          最低階折返項是 <M>{'e^{3}'}</M>,相對線性項的量級 <M>{'\\le e_{pk}^{2}/6'}</M>。full
          actuator 下振幅很小:exp22 實測 mash111 的 peak |e_FB_abs| = 1.76 LSB →{' '}
          <M>{'\\varepsilon_{pk} = 2\\pi\\cdot 1.76/256 = 0.0432'}</M> rad →{' '}
          <M>{'\\varepsilon_{pk}^{2}/6 = 3.1\\times10^{-4}'}</M>(−70 dB)— 預期折返低於
          deterministic tone floor,量測應看到 shaping 在 in-band 完整存活(圖 #17b 證實)。
          <EpistemicTag kind="EXPERIMENT" />
        </p>
        <p>
          <strong>Gating 是更兇的非線性。</strong>threshold gate(第 13 章)等效把 kick 乘上
          indicator function <M>{'\\mathbb{1}\\big[|e_{ZC,hw}| \\le \\mathrm{th}\\big]'}</M> —
          不連續、含所有階次,且 fired mask 本身就是 shaped noise 的函數;fire 稀疏時
          detuning 在 fire 間隔累積,兩個機制一起把能量搬回 in-band。
          <EpistemicTag kind="INFERENCE" />
        </p>
      </SectionMath>

      <SectionExample>
        <p>三個手算可驗的數字:</p>
        <ol>
          <li>
            <strong>tone → dBc:</strong>幅度 a = 0.01 rad 的 tone:
            <M>{'20\\log_{10}(0.005) = -46.02\\ \\mathrm{dBc}'}</M>。模型計算:
            toneAmpToDbc(0.01) = {trimNumber(toneAmpToDbc(0.01), 6)} dBc。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            <strong>spur 位置:</strong>preset「deterministic spur」的 N = 3 + 32.125/256:
            fine code 每拍走 <M>{'G \\cdot N = 800.125'}</M> LSB,小數部分 0.125 LSB;
            8 拍恰累積 1 LSB 整數 → 誤差 pattern 週期 P = 8(模擬驗證:序列
            e_ZC_total 逐位以 8 為週期)→ spur 在 m·(4 GHz/8) =
            <strong> m·500 MHz</strong>,m = 1..4(m=4 恰為 Nyquist)。
            同法可算 PJ preset:N=3.13 → 小數增量 0.28 = 7/25 → P = 25 →
            tone 間距 160 MHz。<EpistemicTag kind="EXACT" />
          </li>
          <li>
            <strong>static offset:</strong>route 2 LSB = 2/256 cycle →
            φ = 2π·2/256 = {trimNumber(TWO_PI * 2 * LSB, 4)} rad 的 DC 值;
            能量集中於 DC,不產生 spur 也不抬 floor。<EpistemicTag kind="EXACT" />
          </li>
        </ol>

        <ExampleProblem
          index={1}
          tag="EXACT"
          title="tone 幅度 → dBc,以及 FFT 的頻率刻度"
          prompt={
            <>
              phase 序列裡有一根幅度 <M>{'a'}</M> 的 tone(以 fine LSB 給定,
              <M>{'1\\,\\mathrm{LSB}=1/G'}</M> cycle)。先換成 rad
              (<M>{'1'}</M> cycle <M>{'=2\\pi'}</M> rad),再用 §17 的 dBc convention{' '}
              <M>{'\\mathrm{SSB}=20\\log_{10}(a/2)'}</M> 求 spur 位準;同時算出取樣率{' '}
              <M>{'=f_{ref}'}</M> 下長度 <M>{'N'}</M> 的 FFT bin 間距 <M>{'f_{ref}/N'}</M>。
            </>
          }
          inputs={EX_DBC_INPUTS}
          compute={exDbcCompute}
        />

        <ExampleProblem
          index={2}
          tag="EXPERIMENT"
          title="量化誤差的週期 P 與 spur 間距"
          prompt={
            <>
              給定 <M>{'N'}</M>,fine code 每拍前進 <M>{'G N'}</M> LSB,其小數部分決定量化誤差的
              重複週期。跑 {EX_N_SIM} 拍模擬(<code>quantizer=&apos;nearest&apos;</code>),
              直接從 <M>{'e_{ZC,hw}'}</M> 序列找最小的 <M>{'P'}</M>,再依{' '}
              <M>{'f_{spur,m}=\\frac{m}{P}f_{ref}'}</M>、<M>{'m=1..\\lfloor P/2\\rfloor'}</M>{' '}
              算出 spur 位置。
            </>
          }
          inputs={EX_SPUR_INPUTS}
          compute={exSpurCompute}
        />

        <ExampleProblem
          index={3}
          tag="APPROX"
          title="Shaping 預算:NTF 抑制 vs injection 非線性折返"
          prompt={
            <>
              m 階 phase DSM 的 in-band 抑制為{' '}
              <M>{'|1-e^{-j2\\pi f/f_{ref}}|^{m}=(2\\sin(\\pi f/f_{ref}))^{m}'}</M>;
              但 sin injection map 的三階項會把高頻 shaped noise 折回 in-band,相對量約{' '}
              <M>{'\\varepsilon_{pk}^{2}/6'}</M>。給定 peak 量化誤差(LSB)、DSM 階數與 offset
              頻率,算出 shaped in-band tone 的 dBc、折返的 dB,以及兩者的裕度 — 判斷 shaping
              是否在 in-band 存活。
            </>
          }
          inputs={EX_FOLD_INPUTS}
          compute={exFoldCompute}
        />
      </SectionExample>

      <SectionFigure
        title={`五種 error signature — 時域(目前:${preset.zh})`}
        caption={
          <span>
            橫軸 k(取樣率 = f_ref = 4 GHz;只畫前 128 拍),縱軸 e_ZC_total
            (單位:<UnitSwitch />)。目前 preset:{preset.mechanism};rms ={' '}
            {formatPhase(sim.rmsCycles, unit, sim.tVco)}。右側面板可一鍵切換
            五種 signature(config 見下表)。<EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <EChart option={timeOption} height={260} group="ch16" />
        <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>分類</th>
                <th>機制(config)</th>
                <th>預期頻譜簽名</th>
                <th>P</th>
              </tr>
            </thead>
            <tbody>
              {SIG_PRESETS.map((p) => (
                <tr key={p.id} style={p.id === sigId ? { fontWeight: 600 } : undefined}>
                  <td>
                    {p.zh}({p.label})
                  </td>
                  <td>{p.mechanism}</td>
                  <td>{p.signature}</td>
                  <td>{p.P ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionFigure>

      <SectionFigure
        title="圖 #17 + #18 — Hann PSD 與 spur markers"
        caption={
          <span>
            橫軸 MHz(bin 間距 f_ref/N = {trimNumber(4000 / nCycles, 4)} MHz,
            最右端 = Nyquist 2000 MHz),縱軸 10·log10(S_phi/2) dBc/Hz
            (φ 以 rad 計,已依 §17 convention 正規化)。紅點 = detectSpurs
            找到的 local maxima(高於 median + threshold);黃虛線 ={' '}
            <M>{'m/P \\cdot f_{ref}'}</M> 預測位置(只標前 8 個 m;deterministic
            periodic preset 才有)。DC bin 不畫;低於 {FLOOR_DB} dB 截斷顯示。
            deterministic preset 的低階「floor」來自 float64 數值精度與
            window leakage,不是物理雜訊。
          </span>
        }
      >
        <EChart option={psdOption} height={340} group="ch16" />
        <div style={{ marginTop: '0.75rem' }}>
          <DebugTable
            columns={[
              { key: 'rank', label: '#' },
              { key: 'f_mhz', label: 'f (MHz)', fmt: (v) => trimNumber(Number(v), 6) },
              {
                key: 'level_dbc_hz',
                label: 'level (dBc/Hz)',
                fmt: (v) => trimNumber(Number(v), 5),
              },
              { key: 'm_over_P', label: 'm/P' },
            ]}
            rows={spurRows}
            maxHeight={240}
            exportName="ch16_spurs.csv"
          />
        </div>
        <Callout type="note" title="固定 seed 之可重現性">
          <p>
            所有含 noise 的 preset 都用 base_seed = 12345 的 named PRNG streams
            (mulberry32;ref:1、vco_w:2、vco_rw:3、…,MODEL_SPEC §12)。
            重新整理頁面、或改用 Python golden model 跑同一 config,得到的時域序列與
            PSD <strong>逐位一致</strong>(純數位路徑 tolerance 1e-12,含 noise
            路徑 1e-9,libm 差異)。<EpistemicTag kind="EXACT" /> 表格的 CSV export
            可直接 diff 對照。
          </p>
        </Callout>
      </SectionFigure>

      <SectionFigure
        title="圖 #18b — Spur Summary Table:全部 N presets 一鍵掃描"
        caption={
          <span>
            一鍵對 lib/globalParams 的全部 {N_DIV_ALL_PRESETS.length} 個 N presets(基本
            5 個 + sub-LSB 階梯 4 個 + 特殊 4 個)各重跑一次模擬 —— quantizer =
            nearest(章節目前所有 error-signature preset 明講或預設都落在這個值)、
            其餘欄位 defaultConfig(無 injection/noise,純 feedback quantization),
            {SPUR_SUMMARY_N_CYCLES} cycles(Δf = {trimNumber(4000 / SPUR_SUMMARY_N_CYCLES, 4)} MHz)。
            對每個 N 的 e_ZC_total 跑 detectSpurs(threshold 取自上方 spur threshold
            slider,按下當下的值),表列 top-5(依 level 降冪)。「predicted f_ref/P」
            欄位是 MODEL_SPEC §1.1 的封閉式公式(P = q/gcd(q, 256),
            <M>{'\\alpha = N - 3'}</M> 約分 p/q);P = 1 表示 on-grid、e_FB ≡ 0、
            <strong>沒有</strong> fractional spur,顯示「—」。<EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <div style={{ marginBottom: '0.75rem' }}>
          <button
            type="button"
            className="preset-button"
            disabled={spurSummaryPending}
            onClick={() => setSpurSummaryJob({ token: Date.now(), thresholdDb })}
          >
            {spurSummaryPending
              ? '掃描中…'
              : spurSummaryRows === null
                ? `掃描全部 ${N_DIV_ALL_PRESETS.length} 個 N presets`
                : `重新掃描(threshold = median + ${trimNumber(thresholdDb, 3)} dB)`}
          </button>
        </div>
        {spurSummaryRows === null && !spurSummaryPending && (
          <p style={{ opacity: 0.75 }}>尚未執行 —— 按上方按鈕開始(13 次 simulate(),post-paint)。</p>
        )}
        {spurSummaryTableRows.length > 0 && (
          <div style={{ marginTop: '0.5rem' }}>
            <DebugTable
              columns={[
                { key: 'id', label: 'id' },
                { key: 'n_label', label: 'N' },
                { key: 'P', label: 'P(DTC grid)' },
                {
                  key: 'spacing_mhz',
                  label: 'predicted f_ref/P(MHz)',
                  fmt: (v) => (v === null || v === undefined ? '—' : trimNumber(Number(v), 6)),
                },
                { key: 'rank', label: '#' },
                {
                  key: 'f_mhz',
                  label: 'f(MHz)',
                  fmt: (v) => (v === null || v === undefined ? '—' : trimNumber(Number(v), 6)),
                },
                {
                  key: 'level_dbc_hz',
                  label: 'level(dBc/Hz)',
                  fmt: (v) => (v === null || v === undefined ? '—' : trimNumber(Number(v), 5)),
                },
                { key: 'note', label: '備註' },
              ]}
              rows={spurSummaryTableRows}
              maxHeight={420}
              exportName="ch16_spur_summary.csv"
            />
          </div>
        )}
        <Callout type="note" title="F8 與 on-grid 列的預期結果(讀表前先看這裡)">
          <p>
            <strong>F8(3.1545084971874737,irrational α)</strong>:MODEL_SPEC §1.1 標註
            quasi-periodic、<strong>無離散 spur</strong>——float64 嚴格來說仍是有理數
            (週期 <M>{'P = 2^{43}'}</M>),但遠長於任何模擬長度,實務上等同無理數,
            合理地<strong>沒有穩定的 discrete comb</strong>可供 predicted f_ref/P 對照;
            表中該列會列出 detectSpurs 抓到的 local maxima(若有),但那是有限視窗
            leakage 造成的統計突起,不是可重現的 tone —— 這正是它與其他列的本質差異。
            <EpistemicTag kind="APPROX" />
          </p>
          <p>
            <strong>on-grid 列(F6 = 3.22265625、3.000、3.125,以及 3.25)</strong>:
            P = 1 表示 α·G 恰為整數、DTC grid 上 e_FB_abs ≡ 0 逐拍精確成立,
            e_ZC_total 全序列為 0 —— PSD 沒有能量、detectSpurs
            <strong>什麼都找不到</strong>,表中顯示「(無 spur ≥ threshold)」。
            <EpistemicTag kind="EXACT" />
          </p>
          <p>
            <strong>額外一個邊界情況:F1</strong>(3.126953125,半 LSB tie,P = 2)predicted
            f_ref/P 恰好等於 <strong>Nyquist</strong>(2000 MHz)—— 與本章圖 #17+#18
            討論過的「Nyquist 端點無紅點」是同一個 detectSpurs 邊界(local-maximum
            定義不含端點),所以 F1 這列也常顯示「無 spur」,並非模型算錯,
            而是偵測方法的已知限制。<EpistemicTag kind="EXPERIMENT" />
          </p>
        </Callout>
      </SectionFigure>

      <SectionFigure
        title="圖 #17b — Shaped-noise folding:e_ZC_total PSD(nearest / ef1 / mash11 / mash111)"
        caption={
          <span>
            共同 config:N=3.13、mode D、full actuator、sin injection K_inj=0.3、Δf=1 MHz、
            seed 12345;模擬 {FOLD_N} 拍,PSD 取 steady-state 後 1024 拍(mean 已移除)。
            σ_vco_w=0(deterministic)時量測 <EpistemicTag kind="EXPERIMENT" />:in-band
            integrated phase(1 Hz–200 MHz)= 617 / 340 / 99 / 33 µrad(nearest→mash111,
            18.7× = 25.4 dB 改善)— DSM 階數越高 in-band 越乾淨,sin map 沒有抹掉 shaping;
            近 Nyquist(1.5–2 GHz)= 3.68 / 9.16 / 18.3 / 32.5 mrad(+18.9 dB)— 代價全在
            out-of-band。每一階的 in-band 輸出都約為輸入 e_ZC_hw 的 0.69–0.76 倍(縮放,
            非折返):sin 折返項 −70 dB,低於 tone floor。σ_vco_w=0.002 rad 時四條曲線的
            in-band 被 white noise floor 齊平(≈1.47–1.54 mrad),差異只剩近 Nyquist。
            勾選 gated overlay:mash111 加 th=0.002 cycle 的 gate(fire 41/1024 = 4%)後,
            in-band 從 33 µrad 回升到 8.82 mrad(×267 ≈ +48.5 dB)— 硬非線性 + 稀疏修正把
            shaped noise 的好處收回。
          </span>
        }
      >
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
          <SelectControl<FoldSigmaStr>
            label="σ_vco_w(rad)"
            value={foldSigma}
            options={[
              { value: '0', label: '0(deterministic)' },
              { value: '0.002', label: '0.002(small noise)' },
            ]}
            onChange={setFoldSigma}
          />
          <Toggle
            label="overlay:mash111 + gate th=0.002"
            checked={foldGate}
            onChange={setFoldGate}
          />
        </div>
        <EChart option={foldOption} height={340} />
        <div style={{ marginTop: '0.75rem' }}>
          <DebugTable
            columns={[
              { key: 'config', label: 'config' },
              {
                key: 'inband_urad',
                label: 'in-band 1Hz–200MHz(µrad)',
                fmt: (v) => trimNumber(Number(v), 5),
              },
              {
                key: 'hiband_mrad',
                label: '1.5–2GHz(mrad)',
                fmt: (v) => trimNumber(Number(v), 5),
              },
              { key: 'rms_mrad', label: 'total rms(mrad)', fmt: (v) => trimNumber(Number(v), 5) },
              { key: 'fired', label: 'fired /1024' },
            ]}
            rows={foldRows}
            maxHeight={220}
            exportName="ch16_folding.csv"
          />
        </div>
        <Callout type="honesty" title="折返量是 sin map 的下界(APPROX)">
          <p>
            此處量到「幾乎無折返」依賴兩件事:sin 是<strong>奇函數</strong>(無 <M>{'e^2'}</M>{' '}
            項),且 full-actuator 振幅小(|ε_hw| ≤ 0.043 rad,非線性偏差 ≤ 3.1×10⁻⁴)。
            真實 VCO 的 PDR 通常<strong>非對稱</strong>(偶次項不為零)、斜率更陡、且隨
            amplitude/注入點變化 — 偶次項會把 shaped noise 的平方(其頻譜為自相關摺積,
            含強 DC/低頻成分)直接折回 in-band,效率遠高於 sin 的三次項。確切 folding
            取決於真實 PDR 形狀,需 transistor-level 萃取(第 13 章 LUT 介面)。
            <EpistemicTag kind="APPROX" />
          </p>
        </Callout>
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model/measurements.ts(真實碼節錄)"
        code={CODE_EXCERPT}
      >
        <p>
          這是網站與 Python golden model 共用定義的 PSD(radix-2 FFT 自含實作,
          無外部相依);dBc 換算不藏在繪圖層,而是 model 的 export。
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'const xt = pow2Truncate(x);',
            explain: '截為 2 的冪長度(§17:FFT 截為 2 的冪),bin 間距 f_ref/N 為精確二進位數。',
          },
          {
            code: 'w[i] = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / n);',
            explain: (
              <span>
                periodic Hann window:壓 spectral leakage(第一 sidelobe 約 −31 dB),
                代價是 main lobe 寬約 2 bins — 所以 static offset 的 DC 能量會
                「暈」到鄰近幾個 bin。
              </span>
            ),
          },
          {
            code: 'u += w[i] * w[i];  …  u /= n;',
            explain: (
              <span>
                <M>{'U = \\mathrm{mean}(w^2)'}</M>:window power 正規化,
                使 white noise 的 PSD 積分回到 variance(能量守恆)。
              </span>
            ),
          },
          {
            code: 'xw[i] = xt[i] * w[i];',
            explain: '先加窗再 FFT;輸入 φ[k] 單位是 rad,PSD 單位因此是 rad²/Hz。',
          },
          {
            code: 'psd[i] = (re[i] * re[i] + im[i] * im[i]) / (fs * n * u);',
            explain: (
              <span>
                periodogram 正規化:除以 <M>{'f_s N U'}</M>。此處 fs 一律傳入
                f_ref = 4 GHz — 這一行就是「sample rate = f_ref」convention 的落點
                (acceptance test 12)。
              </span>
            ),
          },
          {
            code: 'psd[i] *= 2.0; // one-sided (DC and Nyquist not doubled)',
            explain: 'one-sided 慣例:正頻率 bin 乘 2,DC 與 Nyquist 不乘(它們沒有鏡像 bin)。',
          },
          {
            code: 'freqsHz[i] = i * (fs / n);',
            explain: '頻率軸由 0 到 fs/2 = 2 GHz;spur 預測位置 m/P·f_ref 直接落在這條軸上。',
          },
          {
            code: 'return 20.0 * Math.log10(aRad / 2.0);',
            explain: (
              <span>
                SSB spur dBc:tone 幅度 a rad 的 sideband 是 a/2 —
                手算例 a = 0.01 → −46.02 dBc。small-angle 假設,a 接近 1 rad 時失效。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            <strong>deterministic spur(P=8)</strong>:恰好 4 根 tone,位置
            500 / 1000 / 1500 / 2000 MHz,與黃色 m/P 虛線逐根重合;
            0.125 是 dyadic 數,tone 恰落在 FFT 整數 bin 上,bin 之間的 floor
            低於 −300 dB(float64 數值精度)。注意 2000 MHz 那根在 Nyquist
            端點 — detectSpurs 的 local-maximum 定義不含端點,所以它沒有紅點。
          </li>
          <li>
            <strong>對照:</strong>若改用 exp07 的 0.3 LSB(P=10,tone 在
            m·400 MHz),因 400 MHz = 102.4 bin 不是整數,Hann leakage 會把
            tone 攤成 skirt、floor 升到約 −150 dBc/Hz — spur 位置公式不變,
            差別只在 FFT 取樣格點的呈現。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            <strong>periodic jitter(P=25)</strong>:tone 間距縮成 160 MHz、
            數量變多且更密;黃虛線只標前 8 根(至 1280 MHz),其餘 tone 仍準確
            落在 160 MHz 格點上(用 zoom 拉近驗證)。
          </li>
          <li>
            <strong>static offset</strong>:時域是一條 2 LSB 的水平線;
            PSD 只剩近 DC 的 Hann main lobe,中高頻什麼都沒有 —
            固定誤差不產生 spur。
          </li>
          <li>
            <strong>broadband / random jitter</strong>:時域雜亂、PSD 是連續 floor,
            detectSpurs 幾乎找不到穩定 local maxima(把 threshold slider 調低,
            會開始抓到統計突波 — 這不是 spur)。
          </li>
          <li>
            n_cycles 從 256 → 1024:bin 間距變細(15.6 → 3.9 MHz),tone 變「尖」
            但位置不變;noise floor 則因單一 periodogram 無 averaging 而抖動。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解一:PSD 的頻率軸應該延伸到 f_vco/2">
          <p>
            錯。誤差序列每個 <strong>reference</strong> cycle 只有一個樣本,
            取樣率是 f_ref = 4 GHz,Nyquist = 2 GHz。f_vco(約 12.5 GHz)的載波與其
            harmonics 根本不在這個序列裡;把這條 PSD 當成 VCO 輸出頻譜、或把軸標到
            f_vco,都是單位錯誤(MODEL_SPEC §17、acceptance test 12)。
          </p>
        </Callout>
        <Callout type="warn" title="誤解二:任何 phase PSD 都可以標 dBc">
          <p>
            錯。dBc 是「相對 carrier」的量,只有把 φ 以 rad 表示、經 small-angle
            換算(SSB = 20·log10(a/2)、PSD 標 10·log10(S_phi/2))之後才成立。
            未經 carrier normalization 的 PSD(例如單位是 cycles²/Hz 或 fs²/Hz)
            <strong>不可</strong>直接寫 dBc — 這正是 §17 引文的最後一句。
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>
            誤差性質 → 頻譜簽名是設計診斷表:DC(offset)/ 離散 tone(periodic,
            位置由 <M>{'m/P \\cdot f_{ref}'}</M> 完全預測)/ floor(random)。
            看到 spur 先算 P,就知道去哪一級找 bug。<EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            fractional spur 的<strong>位置</strong>只由 α 的有理結構(pattern 週期 P)
            決定,與 mismatch 大小無關 — mismatch 只決定 tone 的<strong>高度</strong>。
            <EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            量測 convention 要釘死:sample rate = f_ref、Hann one-sided periodogram、
            dBc 依 §17 — 否則跨團隊 / 跨語言的 dB 數字無法互相比對。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            固定 seed(12345)讓 spur 表可以進 regression:數字變了就是 model 變了,
            不是運氣變了。<EpistemicTag kind="EXACT" />
          </li>
          <li>
            高階 DSM 是「用 out-of-band 換 in-band」的交易:本 model 的 sin injection map
            在 full-actuator 振幅下夠線性,shaping 存活(in-band 617→33 µrad,near-Nyquist
            3.7→32.5 mrad,nearest→mash111,σ=0)。任何更硬的非線性 — gating、真實 PDR 的
            偶次項 — 都可能把這筆帳收回(gated mash111:in-band ×267)。評估 DSM 階數時
            必須連同 injection 非線性一起看,不能只看 NTF。<EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <ul>
            <li>
              此處的 PSD 是 <strong>scheduler 誤差序列</strong>的頻譜,不是鎖相後
              VCO 輸出的 phase noise:沒有 PLL loop shaping,injection 的 tracking
              行為本身也是近似(Ch13)。<EpistemicTag kind="APPROX" />
            </li>
            <li>
              單一 Hann periodogram 無 averaging:noise floor 每個 bin 的 variance
              很大;要平滑需 Welch-type 平均,model 刻意不做,以維持
              「一次模擬 = 一份可逐位重現的資料」。
            </li>
            <li>
              dBc 換算依 small-angle 近似<EpistemicTag kind="APPROX" />;
              φ 幅度接近 1 rad 時 Bessel 高階項不可忽略。
            </li>
            <li>
              圖 #17b 的 folding 結論只對 sin map 成立,且是<strong>下界</strong>:真實 PDR
              的非對稱性與 amplitude 相依性會折返更多 shaped noise;確切數字需 PDR
              extraction 後以 LUT 重跑。單次 periodogram、單一 seed,in-band 積分值有
              statistical scatter。<EpistemicTag kind="APPROX" />
            </li>
            <li>本專案未執行 Spectre;行為級頻譜 ≠ silicon 量測(MODEL_SPEC §20)。</li>
          </ul>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="Ch16 參數">
        <PresetButtons
          label="Error signature(一鍵切換)"
          presets={SIG_PRESETS.map((p) => ({
            label: p.zh,
            onClick: () => setSigId(p.id),
          }))}
        />
        <SelectControl<NCyclesStr>
          label="n_cycles"
          value={nCyclesStr}
          options={[
            { value: '256', label: '256(Δf = 15.6 MHz)' },
            { value: '512', label: '512(Δf = 7.8 MHz)' },
            { value: '1024', label: '1024(Δf = 3.9 MHz)' },
          ]}
          onChange={setNCyclesStr}
        />
        <Slider
          label="spur threshold(median +)"
          value={thresholdDb}
          min={6}
          max={60}
          step={1}
          unit="dB"
          onChange={setThresholdDb}
        />
        <Toggle label="顯示 m/P·f_ref markers" checked={showMarkers} onChange={setShowMarkers} />
      </ParamPanel>
    </ChapterShell>
  );
}
