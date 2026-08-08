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
import { ParamPanel, Slider, SelectControl, Toggle, PresetButtons } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import PhaseWheel from '../components/PhaseWheel';
import DebugTable from '../components/DebugTable';
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
import { DTCModel, decompose, fromPartial, rms, simulate, configTVcoS } from '../model';
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

/* ---------------------------------------------------------------- 章節主體 */

type NDivStr = '3.125' | '3.13' | '3.1375';
type SignalName = 'e_ZC_hw' | 'e_ZC_total';

export default function Chapter15() {
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const [nDivStr, setNDivStr] = useState<NDivStr>('3.13');
  const [tapDeg, setTapDeg] = useState(1.0);
  const [tapPattern, setTapPattern] = useState<'uniform' | 'alt'>('uniform');
  const [gainPct, setGainPct] = useState(1.0);
  const [inlAmpLsb, setInlAmpLsb] = useState(0.5);
  const [exag, setExag] = useState(20);
  const [signal, setSignal] = useState<SignalName>('e_ZC_hw');
  const [enabled, setEnabled] = useState<Record<string, boolean>>(DEFAULT_ENABLED);

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

  useEffect(() => {
    setStatus(
      'done',
      `decompose: 13 × ${N_CYCLES} cycles;mapping 比較 2 × ${N_CYCLES} cycles`,
    );
  }, [decomp, nvc, setStatus]);

  /* ------------------------------------------------------------ 圖表選項 */

  // decomposition 逐項貢獻 bar chart
  const decompOption = useMemo(() => {
    const cats = [...TERM_LABELS.map((t) => t.label), 'RSS', 'joint'];
    const contrib: (number | null)[] = TERM_LABELS.map(
      (t) => decomp.contributions[t.key] ?? 0,
    );
    contrib.push(null, null);
    const totals: (number | null)[] = TERM_LABELS.map(() => null);
    totals.push(decomp.sum_of_contributions_rms, decomp.joint_total_rms_cycles);
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
            (各項平方和開根號)與 jointly-simulated total。additivity gap ={' '}
            {formatPhase(decomp.additivity_gap_cycles, unit, tVco)}
            (joint − RSS;linear regime 下應接近 0<EpistemicTag kind="APPROX" />)。
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

      <SectionCode
        language="typescript"
        title="web/src/model — tapModel.ts / dtcModel.ts / injectionScheduler.ts(真實碼節錄)"
        code={CODE_EXCERPT}
      >
        <p>
          三段節錄對應本章三個層次:tap 位置模型、DTC delay 表(§10 之 3–9 項
          全部凍結成 64-entry table)、以及 calibrated mapping 如何把「實測」表
          放進 argmin。
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
              <EpistemicTag kind="APPROX" />;joint 與 RSS 的差距已如實顯示。
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
