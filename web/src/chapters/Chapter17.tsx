/**
 * Chapter 17 — Interactive Architecture Comparisons 互動式架構比較
 *
 * 內容契約:CHAPTER_GUIDE.md Ch17;數學契約:MODEL_SPEC.md §6–§17。
 * 互動圖 #29 comparison dashboard、#30 cycle-by-cycle debug table。
 * 所有計算一律經由 ../model(simulate / getPreset / presetConfigs / summary /
 * periodogramPsd);本檔不重新實作任何 wrap / quantizer / DSM 數學。
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
import { ParamPanel, PresetButtons, SelectControl, Slider, Toggle } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import DebugTable from '../components/DebugTable';
import { makeLineOption } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { trimNumber } from '../lib/format';
import { chapterHref } from '../lib/router';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  COLUMNS,
  EXPERIMENTS,
  configAlpha,
  configTVcoS,
  cyclesToDegrees,
  defaultConfig,
  fromPartial,
  getPreset,
  periodogramPsd,
  presetConfigs,
  replaceConfig,
  simulate,
  summary,
  wrapCycles,
} from '../model';
import type { ColumnName, Experiment, SimConfig, SimResult, SimSummary } from '../model';

const meta = chapterById(17)!;

/* ------------------------------------------------------------------ */
/* per-experiment瀏覽器 metadata(圖上畫哪個 signal、連到哪些章的公式) */

type MetricName =
  | 'e_FB_abs'
  | 'e_INJ_abs'
  | 'e_pair_digital'
  | 'e_pair_analog'
  | 'e_ZC_hw'
  | 'e_ZC_total';

interface ExpMeta {
  /** 圖上畫的欄位 */
  plot: ColumnName;
  /** metrics 摘要用的 error signal */
  metric: MetricName;
  /** governing equations 所在章(id) */
  chapters: number[];
  /** 圖上應觀察什麼(zh-Hant) */
  observe: string;
  /** engineering conclusion(zh-Hant) */
  conclusion: string;
}

const EXP_META: Record<string, ExpMeta> = {
  exp01: {
    plot: 'e_FB_abs',
    metric: 'e_FB_abs',
    chapters: [3, 5],
    observe: 'e_FB_abs 整條線精確為 0;debug table 中 R_FB 為靜態常數、n_int 恆為 3。',
    conclusion: 'integer-N 是 sanity check:此 preset 下任何非零誤差都代表實作 bug,而非物理效應。',
  },
  exp02: {
    plot: 'j_INJ',
    metric: 'e_pair_digital',
    chapters: [3, 7],
    observe: 'j_INJ 每拍固定 −1 tap(mod 8)遞減;e_FB_abs 與 e_pair 皆為 0(on-grid)。',
    conclusion: 'α=1/8 恰好等於 tap 間距:injection 反向旋轉完全由 tap select 承擔,DTC 不需內插。',
  },
  exp03: {
    plot: 'e_FB_abs',
    metric: 'e_FB_abs',
    chapters: [5, 10],
    observe: 'e_FB_abs 呈 deterministic 鋸齒,幅度有界於 ±0.5 LSB(N=3.13 時約 ±156 fs)。',
    conclusion: 'off-grid α 的 nearest baseline:誤差有界、可預測,是所有比較的參考點。',
  },
  exp04: {
    plot: 'e_pair_digital',
    metric: 'e_pair_digital',
    chapters: [8],
    observe: '雖然兩路共用 master accumulator,e_pair_digital 仍在部分 cycle 非零(獨立 rounding)。',
    conclusion: '共享 state 但獨立量化(mode C)不保證逐拍 reverse;要 exact 必須共用 final code。',
  },
  exp05: {
    plot: 'e_pair_digital',
    metric: 'e_pair_digital',
    chapters: [8, 9],
    observe: 'e_pair_digital 頻繁跳動(±1 LSB 級),即使長期平均正確。',
    conclusion: '獨立 DSM(mode B)平均對、逐拍錯,破壞 reverse pairing —— 不建議。',
  },
  exp06: {
    plot: 'e_pair_digital',
    metric: 'e_pair_digital',
    chapters: [8, 12],
    observe: 'e_pair_digital 整條線為位元精確的 0;L=1 latency 已被 look-ahead 完全補償。',
    conclusion: '推薦架構:quantize once + modular reverse + fixed-latency look-ahead。',
  },
  exp07: {
    plot: 'e_FB_abs',
    metric: 'e_FB_abs',
    chapters: [11],
    observe: '誤差為固定 −0.3 LSB 的週期 pattern(週期 10 拍)→ 頻譜上是離散 spur。',
    conclusion: '固定捨入的誤差是 deterministic spur,平均不為 0;適合當 DSM 比較的對照組。',
  },
  exp08: {
    plot: 'e_FB_abs',
    metric: 'e_FB_abs',
    chapters: [11],
    observe: '誤差在 −0.3 與 +0.7 LSB 之間切換(pattern 0,0,0,1 循環),長期平均趨近 0。',
    conclusion: 'ef1 DSM 用較大的瞬時 peak 換取零平均與 noise shaping —— 頻譜與時域要一起看。',
  },
  exp09: {
    plot: 'e_pair_digital',
    metric: 'e_pair_digital',
    chapters: [8, 9],
    observe: '兩條線對照:mode D 恆為 0,mode B 頻繁非零 —— 同為 ef1、只差共享與否。',
    conclusion: 'shared final code 是逐拍 exact reverse 的唯一保證,與 quantizer 種類無關。',
  },
  exp10: {
    plot: 'e_FB_abs',
    metric: 'e_FB_abs',
    chapters: [12],
    observe: 'e_FB_abs 恆為 +0.13 cycle = 46.8°,是 half-LSB(0.703°)的 66.6 倍。',
    conclusion: 'latency bug 的誤差比量化誤差大近兩個數量級:pipeline 對齊是第一優先。',
  },
  exp11: {
    plot: 'e_FB_abs',
    metric: 'e_FB_abs',
    chapters: [12],
    observe: '同樣 L=1,誤差回到 ±half-LSB 內 —— 與 exp10 唯一差別是 lookahead=true。',
    conclusion: '正確 look-ahead(以 s_ideal[k+L] 計算 command)完全移除 latency 項。',
  },
  exp12: {
    plot: 'e_ZC_hw',
    metric: 'e_ZC_hw',
    chapters: [15, 14],
    observe: 'e_ZC_hw 出現靜態偏移 222.2 fs(0.711 LSB),大於 half-LSB 156.25 fs。',
    conclusion: '1° tap mismatch 單獨就超過量化預算 —— tap 需要 calibration,不能只靠 DTC。',
  },
  exp13: {
    plot: 'e_ZC_hw',
    metric: 'e_ZC_hw',
    chapters: [15],
    observe: '誤差隨 c_INJ code 變動(code-dependent),full range 處最大約 200 fs。',
    conclusion: '1% DTC gain mismatch 是 code-dependent、可校正項;比較 naive/calibrated 見 exp19。',
  },
  exp14: {
    plot: 'e_ZC_hw',
    metric: 'e_ZC_hw',
    chapters: [15, 16],
    observe: 'code-periodic 的 INL 誤差在 PSD 上形成 fractional spur,而非白色 noise floor。',
    conclusion: 'INL 直接轉成 deterministic spur:INL 形狀決定 spur 位置與大小。',
  },
  exp15: {
    plot: 'e_ZC_total',
    metric: 'e_ZC_total',
    chapters: [13],
    observe: 'K_inj=0.6 收斂快、steady-state residual 小;K_inj=0.05 收斂慢且 residual 大。',
    conclusion: 'injection strength 決定收斂速度與 residual;先用 lock condition |2πΔf·T_ref| ≤ K_inj 檢查。',
  },
  exp16: {
    plot: 'e_ZC_total',
    metric: 'e_ZC_total',
    chapters: [14, 16],
    observe: '固定 route offset → 靜態 offset;週期量化誤差 → spur;隨機 ref jitter → noise floor。',
    conclusion: '誤差的「性質」(固定/週期/隨機)決定頻譜後果,不只是 RMS 大小。',
  },
  exp17: {
    plot: 'e_ZC_total',
    metric: 'e_ZC_total',
    chapters: [13],
    observe: 'inj_model=none 時 residual 隨機遊走發散;reset 與 sin 都把它壓成有界 residual。',
    conclusion: 'injection 的價值在把 unbounded VCO noise 變成 bounded residual;sin map 是現實近似。',
  },
  exp18: {
    plot: 'e_FB_abs',
    metric: 'e_FB_abs',
    chapters: [5],
    observe: 'normalized DTC 的 phase LSB 恆為 1.40625°;fixed-time DTC 的誤差幅度隨 f_vco 改變。',
    conclusion: 'DTC 標定方式(normalized vs fixed-time)決定跨頻率行為,12–13 GHz 掃描一目了然。',
  },
  exp19: {
    plot: 'e_ZC_hw',
    metric: 'e_ZC_hw',
    chapters: [7, 15],
    observe: '同一組 mismatch 下,calibrated mapping 的 e_ZC_hw RMS 低於 naive(利用 tap/DTC redundancy)。',
    conclusion: 'redundancy + calibrated joint (j,c) 搜尋可吃掉部分 analog mismatch,是免費的精度。',
  },
  exp20: {
    plot: 'e_pair_digital',
    metric: 'e_pair_digital',
    chapters: [9],
    observe: 'mode D(accumulated shared state)恆 0;mode A(逐拍 bit-stream 獨立量化)非零。',
    conclusion: 'injection 要拉的是 accumulated phase state / final common code,不是瞬時 DSM bit。',
  },
};

/* ------------------------------------------------------------------ */
/* config diff(setup 表格)與 series label                            */

interface DiffEntry {
  key: string;
  defVal: string;
  val: string;
}

function fmtVal(v: unknown): string {
  if (typeof v === 'number') return trimNumber(v, 6);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    return `[${v.map((x) => (typeof x === 'number' ? trimNumber(x, 3) : String(x))).join(', ')}]`;
  }
  if (v === null) return 'null';
  return String(v);
}

/** 與 defaultConfig() 逐欄比較(n_cycles 為顯示端覆寫,略過)。 */
function configDiff(cfg: SimConfig): DiffEntry[] {
  const def = defaultConfig() as unknown as Record<string, unknown>;
  const cur = cfg as unknown as Record<string, unknown>;
  const out: DiffEntry[] = [];
  for (const key of Object.keys(def)) {
    if (key === 'n_cycles') continue;
    if (JSON.stringify(def[key]) !== JSON.stringify(cur[key])) {
      out.push({ key, defVal: fmtVal(def[key]), val: fmtVal(cur[key]) });
    }
  }
  return out;
}

/** 由 diff 自動產生簡短 series 名稱。 */
function seriesLabel(cfg: SimConfig, i: number): string {
  const d = defaultConfig();
  const parts: string[] = [];
  if (cfg.n_div !== d.n_div) parts.push(`N=${cfg.n_div}`);
  if (cfg.arch_mode !== d.arch_mode) parts.push(`mode ${cfg.arch_mode}`);
  if (cfg.quantizer !== d.quantizer) parts.push(cfg.quantizer);
  if (cfg.latency_cycles !== d.latency_cycles) parts.push(`L=${cfg.latency_cycles}`);
  if (cfg.lookahead !== d.lookahead) parts.push(cfg.lookahead ? 'LA' : 'no-LA');
  if (cfg.inj_mapping !== d.inj_mapping) parts.push(cfg.inj_mapping);
  if (cfg.dtc_mode !== d.dtc_mode) parts.push(cfg.dtc_mode);
  if (cfg.inj_model !== d.inj_model) parts.push(cfg.inj_model);
  if (cfg.k_inj !== d.k_inj) parts.push(`K=${cfg.k_inj}`);
  if (cfg.delta_f_hz !== d.delta_f_hz) parts.push(`Δf=${trimNumber(cfg.delta_f_hz / 1e6, 3)}MHz`);
  if (cfg.dtc_inj_gain !== d.dtc_inj_gain) parts.push(`g_INJ=${cfg.dtc_inj_gain}`);
  if (cfg.sigma_ref_s !== d.sigma_ref_s) parts.push('ref jitter');
  if (cfg.sigma_vco_w_rad !== d.sigma_vco_w_rad) parts.push('VCO noise');
  if (cfg.route_inj_cycles !== d.route_inj_cycles) parts.push('route offset');
  if (cfg.inl_sin_amp_cycles !== d.inl_sin_amp_cycles) parts.push('sin INL');
  if (cfg.tap_mismatch_cycles.some((v) => v !== 0)) parts.push('tap mm');
  return `#${i + 1} ${parts.length > 0 ? parts.join(', ') : 'default (N=3.125)'}`;
}

/* ------------------------------------------------------------------ */
/* comparison dashboard(圖 #29)的固定候選 config 清單                */

interface DashEntry {
  key: string;
  id: string;
  label: string;
}

const DASH_ENTRIES: DashEntry[] = [
  { key: 'base', id: 'exp03', label: 'N=3.13 nearest baseline' },
  { key: 'modeD', id: 'exp06', label: 'mode D + look-ahead (exp06)' },
  { key: 'modeB', id: 'exp05', label: 'mode B 獨立 DSM (exp05)' },
  { key: 'ef1', id: 'exp08', label: 'ef1 DSM, 0.3 LSB (exp08)' },
  { key: 'latbug', id: 'exp10', label: 'latency bug L=1 (exp10)' },
  { key: 'tap', id: 'exp12', label: '1° tap mismatch (exp12)' },
  { key: 'gain', id: 'exp13', label: '1% DTC gain (exp13)' },
  { key: 'inl', id: 'exp14', label: 'sin INL 0.5 LSB (exp14)' },
];

const DEFAULT_ACTIVE: Record<string, boolean> = Object.fromEntries(
  DASH_ENTRIES.map((e) => [e.key, ['base', 'modeD', 'modeB', 'tap'].includes(e.key)]),
);

type DashSignal = 'e_FB_abs' | 'e_pair_digital' | 'e_ZC_hw';

const DASH_SIGNAL_OPTIONS: { value: DashSignal; label: string }[] = [
  { value: 'e_FB_abs', label: 'e_FB_abs(absolute)' },
  { value: 'e_pair_digital', label: 'e_pair_digital(pairwise)' },
  { value: 'e_ZC_hw', label: 'e_ZC_hw(ZC miss)' },
];

/* ------------------------------------------------------------------ */
/* 手算數值例(§4)—— 全部經由 model 函式計算,非硬編                  */

const EX_CFG = fromPartial({ n_div: 3.13 });
const EX_TVCO_S = configTVcoS(EX_CFG); // 79.872 ps
const EX_E_LAT = wrapCycles(1 * configAlpha(EX_CFG)); // wrapCycles(L*alpha) = 0.13
const EX_E_LAT_DEG = cyclesToDegrees(EX_E_LAT); // 46.8°
const HALF_LSB_DEG = 360 / 512; // 0.703125° [EXACT, MODEL_SPEC §9]

/* ------------------------------------------------------------------ */
/* 真實程式碼節錄(web/src/model,勿改動內容)                          */

const CODE_EXPERIMENTS = `// web/src/model/experiments.ts(節錄)
{
  id: 'exp06',
  name_zh: 'N=3.130 一次量化模組化反向 (mode D)',
  name_en: 'N=3.130 quantize-once modular reverse (mode D)',
  description:
    'Recommended architecture: R_INJ=(R_zero-R_FB) mod 256, ' +
    'with L=1 look-ahead pipeline.',
  config: mk({
    n_div: 3.13,
    arch_mode: 'D',
    quantizer: 'nearest',
    latency_cycles: 1,
    lookahead: true,
  }),
  expected_result:
    'e_pair_digital == 0 exactly for every cycle; look-ahead removes the latency error.',
},

export function getPreset(presetId: string): Experiment {
  const p = PRESETS[presetId];
  if (p === undefined) {
    throw new Error(\`unknown preset '\${presetId}'\`);
  }
  return p;
}

/** Normalized list of configs for a preset (single or comparison). */
export function presetConfigs(preset: Experiment): SimConfig[] {
  if (preset.configs !== undefined) {
    return [...preset.configs];
  }
  return [preset.config as SimConfig];
}`;

const CODE_SUMMARY = `// web/src/model/simulate.ts(節錄)
/** rms / peak-to-peak / mean of the key error signals (mirror of summary). */
export function summary(res: SimResult): SimSummary {
  const fsPerCycle = res.t_vco_s / 1e-15;
  const out: Record<string, SignalSummary | number> = {};
  for (const name of SUMMARY_SIGNALS) {
    const x = res.data[name];
    out[name] = {
      rms_cycles: meas.rms(x),
      p2p_cycles: meas.peakToPeak(x),
      mean_cycles: meas.mean(x),
      rms_fs: meas.rms(x) * fsPerCycle,
      p2p_fs: meas.peakToPeak(x) * fsPerCycle,
      mean_fs: meas.mean(x) * fsPerCycle,
      rms_deg: meas.rms(x) * 360.0,
      p2p_deg: meas.peakToPeak(x) * 360.0,
      mean_deg: meas.mean(x) * 360.0,
    };
  }
  out.t_vco_s = res.t_vco_s;
  out.t_ref_s = res.t_ref_s;
  out.f_vco_hz = 1.0 / res.t_vco_s;
  return out as unknown as SimSummary;
}`;

/* ------------------------------------------------------------------ */

interface RunInfo {
  cfg: SimConfig;
  res: SimResult;
  sum: SimSummary;
  label: string;
  diff: DiffEntry[];
}

const numFmt = (value: unknown): string =>
  typeof value === 'number' ? trimNumber(value, 4) : String(value ?? '');

const METRIC_COLUMNS = [
  { key: 'config', label: 'config' },
  { key: 'eFB_rms_fs', label: 'e_FB_abs rms (fs)', fmt: numFmt },
  { key: 'eFB_p2p_fs', label: 'e_FB_abs p2p (fs)', fmt: numFmt },
  { key: 'eFB_rms_deg', label: 'e_FB_abs rms (°)', fmt: numFmt },
  { key: 'eFB_p2p_deg', label: 'e_FB_abs p2p (°)', fmt: numFmt },
  { key: 'pair_rms_fs', label: 'e_pair rms (fs)', fmt: numFmt },
  { key: 'pair_p2p_fs', label: 'e_pair p2p (fs)', fmt: numFmt },
  { key: 'pair_rms_deg', label: 'e_pair rms (°)', fmt: numFmt },
  { key: 'pair_p2p_deg', label: 'e_pair p2p (°)', fmt: numFmt },
  { key: 'zc_rms_fs', label: 'e_ZC_hw rms (fs)', fmt: numFmt },
  { key: 'zc_p2p_fs', label: 'e_ZC_hw p2p (fs)', fmt: numFmt },
  { key: 'zc_rms_deg', label: 'e_ZC_hw rms (°)', fmt: numFmt },
  { key: 'zc_p2p_deg', label: 'e_ZC_hw p2p (°)', fmt: numFmt },
];

const DEBUG_COLUMNS = COLUMNS.map((c) => ({ key: c, label: c }));

const EXP_OPTIONS = EXPERIMENTS.map((e) => ({ value: e.id, label: `${e.id} ${e.name_zh}` }));

/** PSD → dB(10·log10),避免 log(0)。 */
function psdSeriesData(freqsHz: Float64Array, psd: Float64Array): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 1; i < freqsHz.length; i++) {
    pts.push([freqsHz[i] / 1e6, 10 * Math.log10(Math.max(psd[i], 1e-32))]);
  }
  return pts;
}

export default function Chapter17() {
  const [presetId, setPresetId] = useState<string>('exp06');
  const [browserCycles, setBrowserCycles] = useState(256);
  const [dashActive, setDashActive] = useState<Record<string, boolean>>(DEFAULT_ACTIVE);
  const [dashSignal, setDashSignal] = useState<DashSignal>('e_FB_abs');
  const [debugCycles, setDebugCycles] = useState(128);
  const [debugCfgIdx, setDebugCfgIdx] = useState(0);

  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  /* 依 unit 的轉換(display only;內部一律 cycles) */
  const conv = useMemo(() => {
    if (unit === 'cycles') return (v: number) => v;
    if (unit === 'deg') return (v: number) => 360 * v;
    return (v: number, tVcoS: number) => (v * tVcoS) / 1e-15; // fs
  }, [unit]) as (v: number, tVcoS: number) => number;
  const unitSuffix = unit === 'cycles' ? 'cycles' : unit === 'deg' ? 'deg' : 'fs';

  /* ---------------- experiment browser(20 presets 一鍵切換) -------- */

  const preset: Experiment = useMemo(() => getPreset(presetId), [presetId]);
  const expMeta = EXP_META[preset.id];

  const browserRuns: RunInfo[] = useMemo(
    () =>
      presetConfigs(preset).map((cfg, i) => {
        const res = simulate(replaceConfig(cfg, { n_cycles: browserCycles }));
        return { cfg, res, sum: summary(res), label: seriesLabel(cfg, i), diff: configDiff(cfg) };
      }),
    [preset, browserCycles],
  );

  const isPhasePlot = expMeta.plot !== 'j_INJ';

  const browserOption = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: isPhasePlot ? `${expMeta.plot} (${unitSuffix})` : 'j_INJ (tap index)',
        series: browserRuns.map((r) => {
          const col = r.res.data[expMeta.plot];
          const pts: [number, number][] = [];
          for (let i = 0; i < col.length; i++) {
            pts.push([i, isPhasePlot ? conv(col[i], r.res.t_vco_s) : col[i]]);
          }
          return { name: r.label, data: pts, step: 'middle' as const, showSymbol: false };
        }),
      }),
    [browserRuns, expMeta.plot, isPhasePlot, conv, unitSuffix, ct],
  );

  /* ---------------- 圖 #29 comparison dashboard --------------------- */

  const dashRuns = useMemo(
    () =>
      DASH_ENTRIES.filter((e) => dashActive[e.key]).map((e) => {
        const cfg = presetConfigs(getPreset(e.id))[0];
        const res = simulate(replaceConfig(cfg, { n_cycles: 512 }));
        return { entry: e, res, sum: summary(res) };
      }),
    [dashActive],
  );

  const metricRows = useMemo(
    () =>
      dashRuns.map((r) => ({
        config: r.entry.label,
        eFB_rms_fs: r.sum.e_FB_abs.rms_fs,
        eFB_p2p_fs: r.sum.e_FB_abs.p2p_fs,
        eFB_rms_deg: r.sum.e_FB_abs.rms_deg,
        eFB_p2p_deg: r.sum.e_FB_abs.p2p_deg,
        pair_rms_fs: r.sum.e_pair_digital.rms_fs,
        pair_p2p_fs: r.sum.e_pair_digital.p2p_fs,
        pair_rms_deg: r.sum.e_pair_digital.rms_deg,
        pair_p2p_deg: r.sum.e_pair_digital.p2p_deg,
        zc_rms_fs: r.sum.e_ZC_hw.rms_fs,
        zc_p2p_fs: r.sum.e_ZC_hw.p2p_fs,
        zc_rms_deg: r.sum.e_ZC_hw.rms_deg,
        zc_p2p_deg: r.sum.e_ZC_hw.p2p_deg,
      })),
    [dashRuns],
  );

  const dashTimeOption = useMemo(
    () =>
      makeLineOption({
        title: `${dashSignal}[k](time domain)`,
        xLabel: 'k (reference cycle)',
        yLabel: `${dashSignal} (${unitSuffix})`,
        series: dashRuns.map((r) => {
          const col = r.res.data[dashSignal];
          const pts: [number, number][] = [];
          for (let i = 0; i < col.length; i++) {
            pts.push([i, conv(col[i], r.res.t_vco_s)]);
          }
          return { name: r.entry.label, data: pts, showSymbol: false };
        }),
      }),
    [dashRuns, dashSignal, conv, unitSuffix, ct],
  );

  const psdData = useMemo(
    () =>
      dashRuns.map((r) => ({
        label: r.entry.label,
        a: periodogramPsd(r.res.data.e_FB_abs, r.res.config.f_ref_hz),
        b: periodogramPsd(r.res.data.e_ZC_hw, r.res.config.f_ref_hz),
      })),
    [dashRuns],
  );

  const psdAOption = useMemo(
    () =>
      makeLineOption({
        title: 'PSD of e_FB_abs(Hann periodogram)',
        xLabel: 'f (MHz)',
        yLabel: 'PSD (dB re cycles²/Hz)',
        series: psdData.map((p) => ({
          name: p.label,
          data: psdSeriesData(p.a.freqsHz, p.a.psd),
          showSymbol: false,
        })),
      }),
    [psdData, ct],
  );

  const psdBOption = useMemo(
    () =>
      makeLineOption({
        title: 'PSD of e_ZC_hw(Hann periodogram)',
        xLabel: 'f (MHz)',
        yLabel: 'PSD (dB re cycles²/Hz)',
        series: psdData.map((p) => ({
          name: p.label,
          data: psdSeriesData(p.b.freqsHz, p.b.psd),
          showSymbol: false,
        })),
      }),
    [psdData, ct],
  );

  /* ---------------- 圖 #30 cycle-by-cycle debug table ---------------- */

  const debugCfgs = useMemo(() => presetConfigs(preset), [preset]);
  const effDebugIdx = Math.min(debugCfgIdx, debugCfgs.length - 1);

  const debugRun = useMemo(
    () => simulate(replaceConfig(debugCfgs[effDebugIdx], { n_cycles: debugCycles })),
    [debugCfgs, effDebugIdx, debugCycles],
  );

  const debugRows = useMemo(() => {
    const n = debugRun.data.k.length;
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < n; i++) {
      const row: Record<string, unknown> = {};
      for (const c of COLUMNS) row[c] = debugRun.data[c][i];
      rows.push(row);
    }
    return rows;
  }, [debugRun]);

  /* ---------------- simulation status(top bar) --------------------- */

  const totalCycles =
    browserRuns.reduce((a, r) => a + r.res.data.k.length, 0) +
    dashRuns.reduce((a, r) => a + r.res.data.k.length, 0) +
    debugRun.data.k.length;

  useEffect(() => {
    setStatus('done', `${presetId}:共 ${totalCycles} cycles(seed 12345)`);
  }, [setStatus, presetId, totalCycles]);

  /* ------------------------------------------------------------------ */

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            20 個 canonical experiments(exp01–exp20)各自隔離哪一個機制?一鍵 preset 的
            setup(config diff)、expected、live result 如何逐字對照?
            <EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            不同架構選擇(mode A/B/C/D、quantizer、latency、mismatch、injection model)
            在同一組指標 —— RMS 與 peak-to-peak 的 absolute error、pair error、zero-crossing
            miss,同時以 fs 與 degree 表示 —— 下如何量化比較?
          </li>
          <li>
            疊圖 PSD(cursor 同步)如何一眼分辨 deterministic spur 與 broadband noise floor?
          </li>
          <li>
            逐拍 debug table(SimResult 全部 {COLUMNS.length} 欄)如何驗證 Mode D identity、
            latency metadata,並以 CSV 全精度輸出與 Python golden model 交叉比對?
          </li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          前面各章逐一建立單一機制的公式與圖像;本章把它們收斂成<strong>可重現的比較</strong>。
          每個 experiment 是一份 <code>SimConfig</code>:與 default 的差異(config diff)就是
          「這個實驗在問什麼」的完整描述。所有 run 共用同一個 golden model 與固定 seed
          12345,因此任何兩個 preset 之間的差異<em>只</em>來自 config diff,不來自隨機性。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>
          比較的紀律:一次只動一個機制;先讀 expected(實驗設計時寫下的預期)再看 live
          result;同時看三個視角 —— 時域(誤差軌跡)、頻域(PSD)、逐拍表(位元級驗證)。
        </p>
        <svg viewBox="0 0 720 150" role="img" aria-label="experiment flow" style={{ maxWidth: '100%', height: 'auto', display: 'block' }}>
          <rect x="10" y="45" width="170" height="60" rx="6" fill="var(--bg-panel)" stroke="var(--border-strong)" />
          <text x="95" y="70" textAnchor="middle" fill="var(--fg)" fontSize="13">Experiment preset</text>
          <text x="95" y="90" textAnchor="middle" fill="var(--fg-subtle)" fontSize="11">config diff vs default</text>
          <rect x="250" y="45" width="160" height="60" rx="6" fill="var(--bg-panel)" stroke="var(--accent)" />
          <text x="330" y="70" textAnchor="middle" fill="var(--fg)" fontSize="13">simulate(cfg)</text>
          <text x="330" y="90" textAnchor="middle" fill="var(--fg-subtle)" fontSize="11">fixed seed 12345</text>
          <rect x="480" y="8" width="230" height="36" rx="6" fill="var(--bg-panel)" stroke="var(--border)" />
          <text x="595" y="31" textAnchor="middle" fill="var(--fg)" fontSize="12">summary():rms / p2p(fs, deg)</text>
          <rect x="480" y="57" width="230" height="36" rx="6" fill="var(--bg-panel)" stroke="var(--border)" />
          <text x="595" y="80" textAnchor="middle" fill="var(--fg)" fontSize="12">periodogramPsd() @ f_ref</text>
          <rect x="480" y="106" width="230" height="36" rx="6" fill="var(--bg-panel)" stroke="var(--border)" />
          <text x="595" y="129" textAnchor="middle" fill="var(--fg)" fontSize="12">per-cycle columns → CSV</text>
          <line x1="180" y1="75" x2="250" y2="75" stroke="var(--fg-subtle)" strokeWidth="1.5" />
          <polygon points="250,75 242,71 242,79" fill="var(--fg-subtle)" />
          <line x1="410" y1="75" x2="480" y2="26" stroke="var(--fg-subtle)" strokeWidth="1.5" />
          <polygon points="480,26 470,26 474,33" fill="var(--fg-subtle)" />
          <line x1="410" y1="75" x2="480" y2="75" stroke="var(--fg-subtle)" strokeWidth="1.5" />
          <polygon points="480,75 472,71 472,79" fill="var(--fg-subtle)" />
          <line x1="410" y1="75" x2="480" y2="124" stroke="var(--fg-subtle)" strokeWidth="1.5" />
          <polygon points="480,124 470,124 474,117" fill="var(--fg-subtle)" />
        </svg>
      </SectionIntuition>

      <SectionMath>
        <p>
          比較用的三個 error 家族(MODEL_SPEC §16,<strong>不可混淆</strong>)
          <EpistemicTag kind="EXACT" />:
        </p>
        <MathBlock>{'e_{\\mathrm{abs}}[k] = \\operatorname{wrapCycles}\\big(s_{\\mathrm{actual}}[k] - s_{\\mathrm{ideal}}[k]\\big)'}</MathBlock>
        <MathBlock>{'e_{\\mathrm{pair}}[k] = \\operatorname{wrapCycles}\\big(u_{\\mathrm{FB}}[k] + u_{\\mathrm{INJ}}[k] - R_{\\mathrm{zero}}/G\\big)'}</MathBlock>
        <MathBlock>{'e_{\\mathrm{ZC}}[k] = \\operatorname{wrapCycles}\\big(x_{\\mathrm{vco}}[k] + \\varphi_{\\mathrm{tap}}[j[k]] + d_{\\mathrm{INJ}}[k] - z_0\\big)'}</MathBlock>
        <p>
          Mode D 的 pairwise identity(exp06/09/20 驗證的對象)
          <EpistemicTag kind="EXACT" />:
        </p>
        <MathBlock>{'(R_{FB}[k] + R_{INJ}[k]) \\bmod 256 = R_{\\mathrm{zero}} \\;\\Rightarrow\\; e_{\\mathrm{pair,digital}}[k] \\equiv 0'}</MathBlock>
        <p>metrics 表的統計量與單位換算(內部一律 cycles,顯示時換算)<EpistemicTag kind="EXACT" />:</p>
        <MathBlock>{'x_{\\mathrm{rms}} = \\sqrt{\\tfrac{1}{n}\\textstyle\\sum_k x[k]^2}, \\qquad x_{\\mathrm{p2p}} = \\max_k x[k] - \\min_k x[k]'}</MathBlock>
        <MathBlock>{'\\Delta t = x \\cdot T_{\\mathrm{vco}}, \\qquad \\theta_{\\mathrm{deg}} = 360\\,x'}</MathBlock>
        <p>
          頻域(MODEL_SPEC §17):per-cycle sequence 的 sample rate 是 <M>{'f_{\\mathrm{ref}}'}</M>
          (不是 <M>{'f_{\\mathrm{vco}}'}</M>);週期 <M>{'P'}</M> 的 pattern 產生的 spur 在
          <EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>{'f_{\\mathrm{spur},m} = \\frac{m}{P}\\, f_{\\mathrm{ref}}, \\qquad m = 1, 2, \\dots'}</MathBlock>
        <p>
          latency bug 的誤差(exp10 的 governing equation,詳見 Ch12)
          <EpistemicTag kind="EXACT" />:
        </p>
        <MathBlock>{'e_{\\mathrm{lat}} = \\operatorname{wrapCycles}(L\\,\\alpha)'}</MathBlock>
        <p>
          dBc 標示規則:small-angle 下幅度 <M>{'a'}</M> rad 的 phase tone,SSB spur =
          <M>{'20\\log_{10}(a/2)'}</M> dBc;未經 carrier normalization 的 PSD(本章 y 軸為
          cycles²/Hz 取 dB)<strong>不可</strong>直接讀作 dBc。<EpistemicTag kind="EXACT" />
        </p>
      </SectionMath>

      <SectionExample>
        <p>
          以 exp10(latency bug)為例,手算可驗 <EpistemicTag kind="EXACT" />:
        </p>
        <ul>
          <li>
            <M>{'\\alpha = 0.13,\\ L = 1'}</M> →{' '}
            <M>{'e_{\\mathrm{lat}} = \\operatorname{wrapCycles}(1 \\times 0.13)'}</M> ={' '}
            {trimNumber(EX_E_LAT, 4)} cycle(模型 <code>wrapCycles</code> 實算)。
          </li>
          <li>
            度數:360 × {trimNumber(EX_E_LAT, 4)} = {trimNumber(EX_E_LAT_DEG, 4)}°。
          </li>
          <li>
            時間:T_vco = 1/(3.13 × 4 GHz) = {trimNumber(EX_TVCO_S / 1e-12, 5)} ps →{' '}
            {trimNumber(EX_E_LAT, 4)} × {trimNumber(EX_TVCO_S / 1e-12, 5)} ps ={' '}
            {trimNumber((EX_E_LAT * EX_TVCO_S) / 1e-12, 4)} ps。
          </li>
          <li>
            對照 half-LSB:T_vco/512 = {trimNumber(EX_TVCO_S / 512 / 1e-15, 4)} fs ={' '}
            {trimNumber(HALF_LSB_DEG, 6)}°;比值 {trimNumber(EX_E_LAT_DEG, 4)}° /{' '}
            {trimNumber(HALF_LSB_DEG, 6)}° = {trimNumber(EX_E_LAT_DEG / HALF_LSB_DEG, 4)} ≈ 66.6
            倍 —— 與 MODEL_SPEC §13 的 canonical 檢查值一致。
          </li>
          <li>
            對照 exp03(nearest baseline):誤差有界 |e_FB_abs| ≤ 0.5 LSB;在 N=3.13 下 0.5 LSB
            = T_vco/512 = {trimNumber(EX_TVCO_S / 512 / 1e-15, 4)} fs。
            <EpistemicTag kind="EXACT" />
          </li>
        </ul>
      </SectionExample>

      <SectionFigure
        title={`Experiment browser — ${preset.id}:${preset.name_zh}(${preset.name_en})`}
        caption={
          <span>
            x 軸:reference cycle index k(sample rate = f_ref);y 軸:
            {isPhasePlot ? `${expMeta.plot},單位隨切換(cycles / deg / fs,依各 config 自身 T_vco 換算)` : 'j_INJ(tap index 0–7,無單位)'}
            。單位:<UnitSwitch />。切換 preset 用右側 ParamPanel 的 20 個一鍵按鈕。
          </span>
        }
      >
        <p style={{ marginTop: 0 }}>{preset.description}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
          {browserRuns.map((r, i) => (
            <div key={i} style={{ overflowX: 'auto' }}>
              <p style={{ margin: '4px 0', fontWeight: 600 }}>
                setup {r.label}
              </p>
              {r.diff.length === 0 ? (
                <p style={{ margin: '4px 0' }}>與 default 完全相同(N=3.125 baseline)。</p>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>欄位</th>
                      <th>default</th>
                      <th>此 config</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.diff.map((d) => (
                      <tr key={d.key}>
                        <td><code>{d.key}</code></td>
                        <td>{d.defVal}</td>
                        <td><strong>{d.val}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
        <p>
          governing equations:
          <span style={{ display: 'inline-flex', gap: '0.9em', flexWrap: 'wrap', marginLeft: 8 }}>
            {expMeta.chapters.map((id) => {
              const c = chapterById(id);
              return c ? (
                <a key={id} href={chapterHref(c.slug)}>
                  Ch{id} {c.titleZh}
                </a>
              ) : null;
            })}
          </span>
        </p>
        <p>
          expected:<em>{preset.expected_result}</em> <EpistemicTag kind="EXPERIMENT" />
        </p>
        <EChart option={browserOption} height={300} group="ch17-browser" />
        <p style={{ marginBottom: 4 }}>
          live result(metric = <code>{expMeta.metric}</code>,{browserCycles} cycles)
          <EpistemicTag kind="EXPERIMENT" />:
        </p>
        <ul style={{ marginTop: 0 }}>
          {browserRuns.map((r, i) => {
            const s = r.sum[expMeta.metric];
            return (
              <li key={i}>
                {r.label}:rms = {trimNumber(s.rms_fs, 4)} fs({trimNumber(s.rms_deg, 4)}°),p2p ={' '}
                {trimNumber(s.p2p_fs, 4)} fs({trimNumber(s.p2p_deg, 4)}°),mean ={' '}
                {trimNumber(s.mean_fs, 4)} fs
              </li>
            );
          })}
        </ul>
        <p>
          what to observe:{expMeta.observe} <EpistemicTag kind="EXPERIMENT" />
        </p>
        <p>
          engineering conclusion:{expMeta.conclusion} <EpistemicTag kind="INFERENCE" />
        </p>
      </SectionFigure>

      <SectionFigure
        title="圖 #29 — Comparison dashboard(多 config 同跑,512 cycles)"
        caption={
          <span>
            上:時域誤差疊圖(y 單位隨 <UnitSwitch /> 切換,各 config 依自身 T_vco 換算)。
            下:e_FB_abs 與 e_ZC_hw 的 Hann periodogram PSD 疊圖,x 軸 MHz(DC bin 略去),
            y 軸 10·log10(S)(dB re cycles²/Hz,未 carrier normalize,故不標 dBc)。
            兩張 PSD 共用 EChart group,cursor 與 zoom 同步。metrics 表可匯出 CSV。
          </span>
        }
      >
        <EChart option={dashTimeOption} height={280} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
          <EChart option={psdAOption} height={280} group="ch17-psd" />
          <EChart option={psdBOption} height={280} group="ch17-psd" />
        </div>
        <p style={{ marginBottom: 4 }}>
          metrics(RMS / peak-to-peak;absolute、pair、ZC miss;fs 與 deg 並列)
          <EpistemicTag kind="EXPERIMENT" />:
        </p>
        <DebugTable
          columns={METRIC_COLUMNS}
          rows={metricRows}
          maxHeight={260}
          exportName="ch17_dashboard_metrics.csv"
        />
      </SectionFigure>

      <SectionFigure
        title={`圖 #30 — Cycle-by-cycle debug table(${preset.id} config #${effDebugIdx + 1},全部 ${COLUMNS.length} 欄)`}
        caption={
          <span>
            SimResult 全欄位:codes(A_FB、R_FB、m_FB、c_FB、R_INJ、j_INJ、c_INJ)為整數;
            u_*、e_*、s_*、x_* 為 cycles;theta_minus、e_inj、delta_theta、theta_plus 為
            rad(§14);seq_id / k_computed / k_applied 為 latency pipeline metadata(§13)。
            「匯出 CSV」輸出<strong>全精度原始值</strong>(以欄位 key 為 header),可直接與
            Python golden model 的輸出逐位 diff。
          </span>
        }
      >
        <DebugTable
          columns={DEBUG_COLUMNS}
          rows={debugRows}
          maxHeight={380}
          exportName={`ch17_debug_${preset.id}_cfg${effDebugIdx + 1}.csv`}
        />
      </SectionFigure>

      <SectionCode
        title="web/src/model/experiments.ts(真實碼節錄)"
        language="typescript"
        code={CODE_EXPERIMENTS}
      >
        <p>
          20 個 experiment 與 Python <code>model/python/experiments.py</code> 共用相同 id 與
          config;別名 preset <code>n3p13_shared_reverse</code> 即 exp06 式推薦組態。
        </p>
      </SectionCode>

      <SectionCode
        title="web/src/model/simulate.ts — summary()(真實碼節錄)"
        language="typescript"
        code={CODE_SUMMARY}
      />

      <SectionLineByLine
        items={[
          {
            code: "config: mk({ n_div: 3.13, arch_mode: 'D', quantizer: 'nearest', latency_cycles: 1, lookahead: true })",
            explain:
              'exp06 的完整 setup。mk() 即 fromPartial():只覆寫與 default 不同的欄位 —— 本章 setup 表格顯示的 config diff 正是這組覆寫。',
          },
          {
            code: "expected_result: 'e_pair_digital == 0 exactly for every cycle; ...'",
            explain:
              '每個 experiment 內建 expected 文字:實驗設計時先寫預期,再跑模擬對照 —— 瀏覽器面板把兩者並排。',
          },
          {
            code: 'const p = PRESETS[presetId];',
            explain: 'PRESETS 是由 20 個 EXPERIMENTS 加一個別名建成的 id → Experiment 查表。',
          },
          {
            code: "if (p === undefined) { throw new Error(`unknown preset '${presetId}'`); }",
            explain: '未知 preset 直接 throw,不靜默 fallback 到 default —— 避免產生「假比較」。',
          },
          {
            code: 'if (preset.configs !== undefined) { return [...preset.configs]; }',
            explain:
              '比較型 experiment(exp09/15/16/17/18/19/20)帶 configs 陣列;presetConfigs() 把單一與多重統一為陣列,dashboard 迴圈直接可用。',
          },
          {
            code: 'return [preset.config as SimConfig];',
            explain: '單 config preset 包成長度 1 的陣列;瀏覽器與 Python CLI --preset 共用同一資料。',
          },
          {
            code: 'const fsPerCycle = res.t_vco_s / 1e-15;',
            explain:
              'cycles → fs 的轉換係數 = T_vco / 1 fs。metrics 表的 fs 欄位由此而來;每個 config 用自己的 T_vco(exp18 的 12/12.5/13 GHz 各不相同)。',
          },
          {
            code: 'rms_deg: meas.rms(x) * 360.0,',
            explain:
              'cycles → deg 只乘 360。同一數字以 fs 與 deg 並列,方便對照 1 LSB = 1.40625°(N=3.125)。',
          },
          {
            code: 'for (const name of SUMMARY_SIGNALS) {',
            explain:
              '六個 error signal(e_FB_abs、e_INJ_abs、e_pair_digital、e_pair_analog、e_ZC_hw、e_ZC_total)各算 rms / p2p / mean —— dashboard metrics 表逐欄對應。',
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            exp06 / exp09 / exp20:mode D 的 e_pair_digital 是<strong>位元精確的 0</strong>
            (不是「很小」)<EpistemicTag kind="EXACT" />;切到 mode B(exp05/09)立即在多數
            cycle 非零 <EpistemicTag kind="EXPERIMENT" />。
          </li>
          <li>
            exp10 → exp11:e_FB_abs 從恆定 0.13 cycle(46.8°)回到 ±half-LSB 內 —— 兩個 preset
            的 config diff 只差 <code>lookahead</code> 一個欄位。
          </li>
          <li>
            dashboard PSD:N=3.13 時 α = 13/100,量化誤差 pattern 週期 P = 100 拍 → spur 間距
            f_ref/100 = 40 MHz <EpistemicTag kind="EXACT" />;移動游標時兩張 PSD 的
            axisPointer 同步指到同一頻率。
          </li>
          <li>
            metrics 表交叉檢查:同一 signal 的 deg 與 fs 欄位比值固定為 360/(T_vco/1 fs);
            N=3.13 時 1° ≈ {trimNumber(EX_TVCO_S / 360 / 1e-15, 4)} fs。
          </li>
          <li>
            exp12(1° tap mismatch):e_ZC_hw 是靜態 222.2 fs 偏移(0.711 LSB),在 PSD 上
            表現為 DC 項而非 spur —— 對照 exp14(INL)的 code-periodic spur。
          </li>
          <li>
            debug table:mode D 時逐拍檢查 (R_FB + R_INJ) mod 256 = 0;seq_id / k_computed /
            k_applied 三欄顯示 latency pipeline 的對齊(L=1 時 k_applied = k_computed + 1)。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解一:「RMS 相近,架構就等價」">
          <p>
            錯。exp07(nearest,固定 −0.3 LSB)與 exp08(ef1)的 RMS 同量級,但 exp07 的能量
            集中在離散 spur 且 mean ≠ 0,exp08 攤成 noise floor、mean → 0、瞬時 peak 反而變大
            (0.7 LSB)。單一 scalar 指標不能決定架構;要同時看 metrics 表(rms / p2p / mean)
            與 PSD 形狀。<EpistemicTag kind="EXPERIMENT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解二:「mode D 的 e_pair ≡ 0 代表沒有誤差」">
          <p>
            錯。e_pair ≡ 0 只說明 FB 與 INJ 的<strong>數位相對</strong>關係 exact;absolute
            quantization error 仍有 ±half-LSB,tap / DTC / route 的 analog mismatch 與 VCO
            random noise 完全不受 shared code 影響(dashboard 中 mode D 的 e_ZC_hw 在開
            mismatch 的 config 下依然非零)。三種 error 家族必須分開讀(§16)。
            <EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>
            推薦架構鏈由實驗逐步支持:shared master accumulator(exp04/20)→ quantize once +
            modular reverse(exp06/09)→ fixed-latency look-ahead(exp10/11)→ calibrated
            tap/DTC mapping(exp12/13/19)→ nearest baseline,評估後才考慮 DSM(exp07/08)。
            <EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            比較方法論:單一變因(config diff 最小化)、固定 seed、fs 與 deg 雙單位並列、
            時域 + 頻域 + 逐拍表三視角 —— 任何架構結論都應能在這個 dashboard 上重現。
          </li>
          <li>
            量級排序(N=3.13 系列):latency bug 46.8° ≫ 1° tap mismatch 0.711 LSB ≈ 1% DTC
            gain 0.64 LSB &gt; half-LSB 量化 0.703°/2 —— 修 bug 先於修 mismatch,修 mismatch
            先於換 quantizer。<EpistemicTag kind="INFERENCE" />
          </li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <ul>
            <li>
              互動模擬每 run ≤ 512 cycles(切 preset 才能即時),PSD bin 寬 = f_ref/512 ≈
              7.8125 MHz;長序列與更細頻率解析度請用 Python golden model CLI
              (<code>--preset</code> 同一組 id)。
            </li>
            <li>
              scheduler 誤差是 exact digital model;injection dynamics(exp15/16/17 的
              e_ZC_total)是 sinusoidal / linear map 近似 <EpistemicTag kind="APPROX" />,
              不宣稱等同 transistor-level shorting。
            </li>
            <li>
              PSD y 軸為 cycles²/Hz 取 10·log10,未經 carrier normalization,依 MODEL_SPEC §17
              不得標示或解讀為 dBc。
            </li>
            <li>behavioral 結果不等同 silicon;本專案未執行 Spectre 驗證。</li>
          </ul>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="Ch17 參數">
        <PresetButtons
          label="Experiment preset(一鍵)"
          presets={EXPERIMENTS.map((e) => ({
            label: e.id.replace('exp', ''),
            onClick: () => {
              setPresetId(e.id);
              setDebugCfgIdx(0);
            },
          }))}
        />
        <SelectControl
          label="Experiment"
          value={presetId}
          options={EXP_OPTIONS}
          onChange={(v) => {
            setPresetId(v);
            setDebugCfgIdx(0);
          }}
        />
        <Slider
          label="browser n_cycles"
          value={browserCycles}
          min={64}
          max={512}
          step={64}
          onChange={(v) => setBrowserCycles(Math.round(v))}
        />
        <p style={{ margin: '10px 0 2px', fontWeight: 600 }}>Dashboard configs(圖 #29)</p>
        {DASH_ENTRIES.map((e) => (
          <Toggle
            key={e.key}
            label={e.label}
            checked={dashActive[e.key]}
            onChange={(checked) => setDashActive((prev) => ({ ...prev, [e.key]: checked }))}
          />
        ))}
        <SelectControl
          label="時域 signal"
          value={dashSignal}
          options={DASH_SIGNAL_OPTIONS}
          onChange={setDashSignal}
        />
        <p style={{ margin: '10px 0 2px', fontWeight: 600 }}>Debug table(圖 #30)</p>
        {debugCfgs.length > 1 && (
          <SelectControl
            label="config"
            value={String(effDebugIdx)}
            options={debugCfgs.map((_, i) => ({ value: String(i), label: `config #${i + 1}` }))}
            onChange={(v) => setDebugCfgIdx(Number(v))}
          />
        )}
        <Slider
          label="table n_cycles"
          value={debugCycles}
          min={32}
          max={512}
          step={32}
          onChange={(v) => setDebugCycles(Math.round(v))}
        />
      </ParamPanel>
    </ChapterShell>
  );
}
