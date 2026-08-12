/**
 * Chapter 14 — Zero-Crossing Miss and Shorting Energy (MODEL_SPEC §15).
 * Figure #23: differential voltage vs timing offset; figure #24: sin^2 energy
 * proxy; figure #15: actual zero-crossing miss time series + PSD, with the
 * fixed / periodic / random -> offset / spur / floor comparison (experiment 16).
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
import { ParamPanel, Slider, PresetButtons } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import { makeLineOption, makeMarkLine } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { formatSiTime, phaseAxisLabel, makePhaseTickFormatter, trimNumber } from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  simulate,
  getPreset,
  presetConfigs,
  summary,
  mean,
  periodogramPsd,
  psdToDbcPerHz,
  detectSpurs,
  db10,
  dtcLsbS,
  tVcoS,
  configTVcoS,
  configG,
  fromPartial,
  wrap01,
  wrapCycles,
  uInjIdeal,
  qNearest,
  pymod,
  cyclesToTime,
  cyclesToRadians,
  timeToCycles,
} from '../model';
import type { SimResult } from '../model';

const meta = chapterById(14)!;

const F_REF = 4e9;
const N_REF = 3.125; // canonical numbers use T_vco = 80 ps
const T_VCO = tVcoS(N_REF, F_REF); // 80 ps
const LSB_S = dtcLsbS(N_REF, F_REF); // 312.5 fs

const ZC_CODE = `// web/src/model/simulate.ts
// deterministic hardware zero-crossing error (sections 5.1, 14)
const eZcHw = new Float64Array(n);
for (let k = 0; k < n; k++) {
  eZcHw[k] = wrapCycles(xId[k] + uInjAn[k] - cfg.z0_cycles);
}

// web/src/model/injectionDynamics.ts
for (let k = 0; k < n; k++) {
  epsilonHw[k] = twoPi * eZcHwCycles[k];
}
/* ... per-cycle loop ... */
const e = wrapRadians(tm + epsilonHw[k] + epsRand);
const dth = deltaTheta(cfg.inj_model, cfg.k_inj, e, lutE, lutD);
const tp = wrapRadians(tm + dth);

thetaMinus[k] = tm;
eInj[k] = e;
dTheta[k] = dth;
thetaPlus[k] = tp;
eZcTotal[k] = e / twoPi;`;

/** Small waveform illustration for the intuition section (display only). */
function ZcWaveform({ epsCycles, accent, bad }: { epsCycles: number; accent: string; bad: string }) {
  const W = 360;
  const H = 120;
  const x0 = 16;
  const plotW = W - 32;
  const midY = H / 2;
  const amp = 42;
  // v_d over one T_vco, rising zero crossing at the center t = 0.5
  const pts = Array.from({ length: 97 }, (_, i) => {
    const t = i / 96;
    const x = x0 + t * plotW;
    const y = midY - amp * Math.sin(2 * Math.PI * (t - 0.5));
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const tPulse = Math.min(0.98, Math.max(0.02, 0.5 + epsCycles));
  const xPulse = x0 + tPulse * plotW;
  const vd = -Math.sin(2 * Math.PI * (tPulse - 0.5));
  const yPulse = midY + amp * vd;
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg
        viewBox={`0 0 ${W} ${H + 22}`}
        style={{ width: '100%', maxWidth: 460, height: 'auto', display: 'block' }}
        role="img"
        aria-label="differential waveform and injection pulse"
      >
        <line x1={x0} y1={midY} x2={x0 + plotW} y2={midY} stroke="var(--border)" />
        <polyline points={pts} fill="none" stroke={accent} strokeWidth={1.8} />
        {/* ideal zero crossing */}
        <circle cx={x0 + 0.5 * plotW} cy={midY} r={3.5} fill={accent} />
        <text
          x={x0 + 0.5 * plotW}
          y={H + 14}
          textAnchor="middle"
          style={{ fill: 'var(--fg-subtle)', fontSize: 10 }}
        >
          zero crossing t_z
        </text>
        {/* injection pulse at t_z + eps */}
        <line x1={xPulse} y1={14} x2={xPulse} y2={H - 6} stroke={bad} strokeWidth={2} />
        <circle cx={xPulse} cy={yPulse} r={3.5} fill={bad} />
        <text x={xPulse + 4} y={20} style={{ fill: bad, fontSize: 10 }}>
          pulse @ t_z+ε_t
        </text>
        <text x={xPulse + 4} y={yPulse - 6} style={{ fill: bad, fontSize: 10 }}>
          v_d/V_p = {trimNumber(Math.sin(2 * Math.PI * epsCycles), 3)}
        </text>
      </svg>
    </div>
  );
}

interface CaseRow {
  label: string;
  res: SimResult;
}

/* ---------------------------------------------------------------------------
 * 數值例子(SectionExample):三個互動 worked example。
 * compute 皆為 pure function,時間/相位換算與 scheduler 鏈全部走 ../model
 * (tVcoS / dtcLsbS / timeToCycles / cyclesToTime / cyclesToRadians / wrap01 /
 * uInjIdeal / qNearest / pymod / wrapCycles);§15 的 sin / sin² 是 display 層
 * 的 proxy 公式,依章節慣例在此就地評估,沒有寫死的答案常數。
 * ------------------------------------------------------------------------- */

/** §15 proxy:v_d/V_p = sin(2π ε_t / T_vco)(ε_t 以 cycles 表示)。 */
function vdRatio(epsCycles: number): number {
  return Math.sin(cyclesToRadians(epsCycles));
}

const EX_VD_INPUTS = [
  {
    key: 'epsFs',
    label: <M>{'\\varepsilon_t'}</M>,
    def: 156.25,
    min: -20000,
    max: 20000,
    step: 1,
    unit: 'fs',
  },
  { key: 'nDiv', label: <M>{'N'}</M>, def: 3.125, min: 2, max: 8, step: 0.001 },
  { key: 'frefGHz', label: <M>{'f_{ref}'}</M>, def: 4, min: 0.1, max: 20, step: 0.1, unit: 'GHz' },
];

function exVdCompute(v: Record<string, number>) {
  const fRefHz = v.frefGHz * 1e9;
  const tVco = tVcoS(v.nDiv, fRefHz);
  const lsbS = dtcLsbS(v.nDiv, fRefHz);
  const epsS = v.epsFs * 1e-15;
  const epsCyc = timeToCycles(epsS, tVco);
  const ratio = vdRatio(epsCyc);
  const energy = ratio * ratio;
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
        label: <>1 LSB = T_vco/256 / half-LSB</>,
        value: `${fmt(lsbS * 1e15, 6, 'fs')} / ${fmt(lsbS * 0.5e15, 6, 'fs')}`,
      },
      {
        label: (
          <>
            <M>{'\\varepsilon_t'}</M> 換算成 LSB
          </>
        ),
        value: fmt(epsS / lsbS, 6, 'LSB'),
      },
      {
        label: (
          <>
            <M>{'\\varepsilon_t/T_{vco}'}</M>
          </>
        ),
        value: fmt(epsCyc, 8, 'cyc'),
      },
      {
        label: (
          <>
            <M>{'2\\pi\\varepsilon_t/T_{vco}'}</M>
          </>
        ),
        value: fmt(cyclesToRadians(epsCyc), 8, 'rad'),
      },
      {
        label: (
          <>
            <M>{'v_d/V_p = \\sin(2\\pi\\varepsilon_t/T_{vco})'}</M>
          </>
        ),
        value: fmt(ratio * 100, 6, '%'),
      },
      {
        label: (
          <>
            <M>{'E_{short,norm} = \\sin^2(\\cdot)'}</M>
          </>
        ),
        value: fmt(energy, 6),
      },
    ],
    answer: (
      <>
        <M>{'|v_d|/V_p'}</M> = {fmt(Math.abs(ratio) * 100, 6, '%')},
        <M>{'E_{short,norm}'}</M> = {fmt(energy, 6)}
      </>
    ),
    warn:
      Math.abs(epsCyc) > 0.25
        ? `|ε_t| 已超過 T_vco/4(pulse 打在波峰附近),E 從最大值 1 折返,proxy 在此區間只有定性意義`
        : undefined,
  };
}

const EX_SCHED_INPUTS = [
  { key: 'nDiv', label: <M>{'N'}</M>, def: 3.13, min: 3, max: 3.25, step: 0.001 },
  { key: 'k', label: <M>{'k'}</M>, def: 5, min: 0, max: 1023, step: 1 },
  {
    key: 'z0',
    label: <M>{'z_0'}</M>,
    def: 0,
    min: -1,
    max: 1,
    step: 0.01,
    unit: 'cyc',
  },
  { key: 'frefGHz', label: <M>{'f_{ref}'}</M>, def: 4, min: 0.1, max: 20, step: 0.1, unit: 'GHz' },
];

function exSchedCompute(v: Record<string, number>) {
  const cfg = fromPartial({
    n_div: v.nDiv,
    f_ref_hz: v.frefGHz * 1e9,
    z0_cycles: v.z0,
  });
  const g = configG(cfg);
  const tVco = configTVcoS(cfg);
  const x = wrap01(v.k * cfg.n_div); // x_ideal[k] (MODEL_SPEC §3)
  const uIdeal = uInjIdeal([x], cfg.z0_cycles)[0]; // §5:wrap01(z0 - x)
  const rInj = pymod(qNearest(g * uIdeal), g); // §6 half-up 量化
  const uDigital = rInj / g;
  const eZc = wrapCycles(x + uDigital - cfg.z0_cycles); // §5.1
  const epsS = cyclesToTime(eZc, tVco);
  const ratio = vdRatio(eZc);
  return {
    steps: [
      {
        label: (
          <>
            <M>{'x_{ideal}[k] = \\operatorname{wrap01}(kN)'}</M>
          </>
        ),
        value: fmt(x, 8, 'cyc'),
      },
      {
        label: (
          <>
            <M>{'u_{INJ,ideal} = \\operatorname{wrap01}(z_0 - x)'}</M>
          </>
        ),
        value: fmt(uIdeal, 8, 'cyc'),
      },
      {
        label: (
          <>
            量化前的實數 <M>{'G\\,u_{INJ,ideal}'}</M>
          </>
        ),
        value: fmt(g * uIdeal, 8),
      },
      {
        label: (
          <>
            <M>{'R_{INJ} = \\operatorname{qNearest}(G u) \\bmod G'}</M>
          </>
        ),
        value: `${rInj} / ${g} LSB`,
      },
      {
        label: (
          <>
            <M>{'e_{ZC} = \\operatorname{wrapCycles}(x + R_{INJ}/G - z_0)'}</M>
          </>
        ),
        value: `${fmt(eZc, 8, 'cyc')} = ${fmt(eZc * g, 6, 'LSB')}`,
      },
      {
        label: (
          <>
            <M>{'\\varepsilon_t = e_{ZC}\\,T_{vco}'}</M>(<M>{'T_{vco}'}</M> ={' '}
            {fmt(tVco * 1e12, 6)} ps)
          </>
        ),
        value: fmt(epsS * 1e15, 6, 'fs'),
      },
      {
        label: (
          <>
            <M>{'v_d/V_p'}</M> 與 <M>{'E'}</M>(§15 proxy,[APPROX])
          </>
        ),
        value: `${fmt(ratio * 100, 6, '%')} / ${fmt(ratio * ratio, 6)}`,
      },
    ],
    answer: (
      <>
        <M>{'e_{ZC}'}</M> = {fmt(eZc * g, 6, 'LSB')},<M>{'\\varepsilon_t'}</M> ={' '}
        {fmt(epsS * 1e15, 6, 'fs')}
      </>
    ),
    warn:
      Math.abs(eZc * g) > 0.5
        ? `|e_ZC| = ${fmt(Math.abs(eZc) * g, 4)} LSB 超過 half-LSB — 純量化不該做到這麼差,請檢查 z_0 是否落在非 LSB 的格點上`
        : undefined,
  };
}

const EX_BUDGET_INPUTS = [
  {
    key: 'tapDeg',
    label: <>tap mismatch</>,
    def: 1,
    min: -45,
    max: 45,
    step: 0.05,
    unit: '°',
  },
  { key: 'routeLsb', label: <>route skew</>, def: 0.5, min: -32, max: 32, step: 0.05, unit: 'LSB' },
  {
    key: 'jitterFs',
    label: <>ref jitter(rms)</>,
    def: 100,
    min: 0,
    max: 5000,
    step: 5,
    unit: 'fs',
  },
  { key: 'nDiv', label: <M>{'N'}</M>, def: 3.125, min: 2, max: 8, step: 0.001 },
];

function exBudgetCompute(v: Record<string, number>) {
  const tVco = tVcoS(v.nDiv, F_REF);
  const lsbS = dtcLsbS(v.nDiv, F_REF);
  const tapS = cyclesToTime(v.tapDeg / 360, tVco); // 1 cycle = 360°
  const routeS = v.routeLsb * lsbS;
  const jitS = v.jitterFs * 1e-15;
  const worstS = Math.abs(tapS) + Math.abs(routeS) + Math.abs(jitS);
  const rssS = Math.sqrt(tapS * tapS + routeS * routeS + jitS * jitS);
  const eRss = vdRatio(timeToCycles(rssS, tVco)) ** 2;
  const eHalf = vdRatio(timeToCycles(0.5 * lsbS, tVco)) ** 2;
  const eTerms =
    vdRatio(timeToCycles(tapS, tVco)) ** 2 +
    vdRatio(timeToCycles(routeS, tVco)) ** 2 +
    vdRatio(timeToCycles(jitS, tVco)) ** 2;
  return {
    steps: [
      {
        label: <>1 LSB / half-LSB(預算基準)</>,
        value: `${fmt(lsbS * 1e15, 6, 'fs')} / ${fmt(lsbS * 0.5e15, 6, 'fs')}`,
      },
      {
        label: (
          <>
            tap 項 <M>{'\\theta\\,T_{vco}/360'}</M>
          </>
        ),
        value: `${fmt(tapS * 1e15, 6, 'fs')} = ${fmt(tapS / lsbS, 6, 'LSB')}`,
      },
      {
        label: <>route 項</>,
        value: `${fmt(routeS * 1e15, 6, 'fs')} = ${fmt(v.routeLsb, 6, 'LSB')}`,
      },
      { label: <>jitter 項(1σ)</>, value: `${fmt(jitS * 1e15, 6, 'fs')} = ${fmt(jitS / lsbS, 6, 'LSB')}` },
      {
        label: <>worst-case(絕對值直接相加)</>,
        value: `${fmt(worstS * 1e15, 6, 'fs')} = ${fmt(worstS / lsbS, 6, 'LSB')}`,
      },
      {
        label: <>RSS(平方和開根號)</>,
        value: `${fmt(rssS * 1e15, 6, 'fs')} = ${fmt(rssS / lsbS, 6, 'LSB')}`,
      },
      {
        label: (
          <>
            <M>{'E'}</M>(RSS 點)vs <M>{'E'}</M>(half-LSB 預算)
          </>
        ),
        value: `${fmt(eRss, 6)} / ${fmt(eHalf, 6)} = ${fmt(eRss / eHalf, 6)}×`,
      },
      {
        label: (
          <>
            逐項 <M>{'E'}</M> 之和(對照:<M>{'\\sin^2'}</M> 非線性,不可加)
          </>
        ),
        value: fmt(eTerms, 6),
      },
    ],
    answer: (
      <>
        RSS <M>{'\\varepsilon_t'}</M> = {fmt(rssS * 1e15, 6, 'fs')} = {fmt(rssS / lsbS, 6, 'LSB')},
        <M>{'E_{short,norm}'}</M> = {fmt(eRss, 6)}(half-LSB 預算的 {fmt(eRss / eHalf, 6)} 倍)
      </>
    ),
    warn:
      rssS > 0.5 * lsbS
        ? `RSS 已超出 half-LSB 預算(${fmt(rssS / (0.5 * lsbS), 4)}×):單靠量化解析度救不回來,需要第 15 章的 calibrated mapping`
        : undefined,
  };
}

export default function Chapter14() {
  const [epsLsb, setEpsLsb] = useState(0.5); // timing offset in LSB (1 LSB = 312.5 fs)
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const epsS = epsLsb * LSB_S; // seconds
  const epsCycles = epsS / T_VCO;
  const ratio = Math.sin(2 * Math.PI * epsCycles); // v_d / V_p  [APPROX]
  const energy = ratio * ratio; // E_short_norm    [APPROX]
  const halfLsbPs = (T_VCO / 512) * 1e12; // 0.15625 ps

  // --- experiment 16: fixed / periodic / random through a linear map ---
  const cases: CaseRow[] = useMemo(() => {
    const cfgs = presetConfigs(getPreset('exp16'));
    const labels = ['fixed(route +2 LSB)', 'periodic(N=3.13 量化)', 'random(σ_ref=100 fs)'];
    return cfgs.map((c, i) => ({ label: labels[i], res: simulate(c) }));
  }, []);

  useEffect(() => {
    setStatus('done', `experiment 16:3 × 512 cycles(linear map, K=0.3)`);
  }, [cases, setStatus]);

  const tVcoSim = configTVcoS(cases[0].res.config);

  // --- figure #23: differential voltage vs timing offset ---
  const voltOption = useMemo(() => {
    const n = 321;
    const sine: [number, number][] = [];
    const lin: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const c = -0.5 + i / (n - 1); // cycles
      const xPs = c * T_VCO * 1e12;
      sine.push([xPs, Math.sin(2 * Math.PI * c)]);
      lin.push([xPs, 2 * Math.PI * c]);
    }
    const opt = makeLineOption({
      xLabel: 'ε_t (ps)',
      yLabel: 'v_d / V_p',
      xTickFormatter: (v) => trimNumber(v, 4),
      yTickFormatter: (v) => trimNumber(v, 3),
      yMin: -1.6,
      yMax: 1.6,
      series: [
        { name: 'sin(2π ε_t/T_vco)', data: sine, color: ct.accent, width: 2 },
        { name: 'small-signal 2π ε_t/T_vco', data: lin, color: ct.series[1], dashed: true },
        {
          name: '目前 ε_t',
          data: [[epsS * 1e12, ratio]],
          type: 'scatter',
          color: ct.bad,
          symbolSize: 10,
        },
      ],
    });
    const o = opt as unknown as { series?: Record<string, unknown>[] };
    if (o.series && o.series[0]) {
      o.series[0].markLine = makeMarkLine([
        { x: halfLsbPs, label: '+half-LSB' },
        { x: -halfLsbPs, label: '−half-LSB' },
      ]);
    }
    return opt;
  }, [epsS, ratio, halfLsbPs, ct]);

  // --- figure #24: normalized shorting-energy proxy ---
  const energyOption = useMemo(() => {
    const n = 321;
    const data: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const c = -0.5 + i / (n - 1);
      const s = Math.sin(2 * Math.PI * c);
      data.push([c * T_VCO * 1e12, s * s]);
    }
    const opt = makeLineOption({
      xLabel: 'ε_t (ps)',
      yLabel: 'E_short_norm = sin²(2π ε_t/T_vco)',
      xTickFormatter: (v) => trimNumber(v, 4),
      yTickFormatter: (v) => trimNumber(v, 3),
      yMin: 0,
      yMax: 1.05,
      series: [
        { name: 'E_short_norm', data, color: ct.accent, width: 2, area: true },
        {
          name: '目前 ε_t',
          data: [[epsS * 1e12, energy]],
          type: 'scatter',
          color: ct.bad,
          symbolSize: 10,
        },
      ],
    });
    const o = opt as unknown as { series?: Record<string, unknown>[] };
    if (o.series && o.series[0]) {
      o.series[0].markLine = makeMarkLine([
        { x: halfLsbPs, label: 'half-LSB → E≈1.5e-4' },
        { x: -halfLsbPs },
      ]);
    }
    return opt;
  }, [epsS, energy, halfLsbPs, ct]);

  // --- figure #15: e_ZC_total time series + theta_plus (static offset view) ---
  const zcSeriesOption = useMemo(() => {
    const xy = (arr: Float64Array) => Array.from(arr, (v, k) => [k, v] as [number, number]);
    return makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: phaseAxisLabel('e_ZC_total', unit, tVcoSim),
      yTickFormatter: makePhaseTickFormatter(unit, tVcoSim),
      series: cases.map((c, i) => ({
        name: c.label,
        data: xy(c.res.data.e_ZC_total),
        color: [ct.series[5], ct.accent, ct.series[1]][i],
        width: 1.4,
      })),
    });
  }, [cases, unit, tVcoSim, ct]);

  const thetaOption = useMemo(() => {
    const xy = (arr: Float64Array) => Array.from(arr, (v, k) => [k, v] as [number, number]);
    return makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: 'θ⁺[k] (rad)',
      yTickFormatter: (v) => trimNumber(v, 3),
      series: cases.map((c, i) => ({
        name: c.label,
        data: xy(c.res.data.theta_plus),
        color: [ct.series[5], ct.accent, ct.series[1]][i],
        width: 1.4,
      })),
    });
  }, [cases, ct]);

  const psdOption = useMemo(() => {
    // PSD of theta_plus (rad) for the periodic and random cases; the fixed
    // case is a DC offset and belongs to the time domain, not the PSD.
    const mk = (c: CaseRow) => {
      const { freqsHz, psd } = periodogramPsd(c.res.data.theta_plus, F_REF);
      const db = psdToDbcPerHz(psd);
      const data: [number, number][] = [];
      for (let i = 1; i < freqsHz.length; i++) {
        data.push([freqsHz[i] / 1e6, db[i]]);
      }
      return { freqsHz, psd, data };
    };
    const per = mk(cases[1]);
    const rnd = mk(cases[2]);
    const spurs = detectSpurs(per.freqsHz, per.psd, 10)
      .slice(0, 6)
      .map((s) => [s.freqHz / 1e6, s.psdDb - db10(2)] as [number, number]);
    return makeLineOption({
      xLabel: 'f (MHz)  — sample rate = f_ref',
      yLabel: 'S_θ⁺ (dBc/Hz, small-angle)',
      xTickFormatter: (v) => trimNumber(v, 5),
      yTickFormatter: (v) => trimNumber(v, 4),
      series: [
        { name: 'periodic(N=3.13)', data: per.data, color: ct.accent, width: 1.4 },
        { name: 'random(σ_ref)', data: rnd.data, color: ct.series[1], width: 1.4 },
        {
          name: 'spurs(m·160 MHz)',
          data: spurs,
          type: 'scatter',
          color: ct.bad,
          symbolSize: 9,
        },
      ],
    });
  }, [cases, ct]);

  // summary table for the three cases
  const caseStats = useMemo(
    () =>
      cases.map((c) => {
        const s = summary(c.res).e_ZC_total;
        const e = c.res.data.e_ZC_total;
        const eSq = new Float64Array(e.length);
        for (let i = 0; i < e.length; i++) {
          const v = Math.sin(2 * Math.PI * e[i]);
          eSq[i] = v * v;
        }
        return {
          label: c.label,
          meanDeg: s.mean_deg,
          rmsDeg: s.rms_deg,
          p2pDeg: s.p2p_deg,
          meanE: mean(eSq),
          thetaPlusMean: mean(c.res.data.theta_plus),
        };
      }),
    [cases],
  );

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            injection pulse 沒有正中 zero crossing(timing error <M>{'\\varepsilon_t'}</M>)時,
            被短路的 differential 電壓有多大?<EpistemicTag kind="APPROX" />
          </li>
          <li>
            shorting 能量的 normalized proxy <M>{'E \\propto \\sin^2'}</M> 怎麼來?half-LSB 的
            miss 對應多小的數字?(1.227%、1.5×10⁻⁴)<EpistemicTag kind="EXACT" />
          </li>
          <li>
            固定 / 週期 / 隨機三種 scheduling error 分別在頻譜上留下什麼?(offset / spur /
            noise floor,experiment 16)<EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            <M>{'e_{ZC}'}</M> 與 <M>{'e_{abs}'}</M>、<M>{'e_{pair}'}</M> 有何不同?為什麼它才是
            最終物理量?
          </li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          shorting injection 在 pulse 期間把 VCO 的 differential 節點短路。若 pulse 正中 zero
          crossing,<M>{'v_d=0'}</M>:短路只「重整相位」,幾乎不搬動能量。pulse 偏了{' '}
          <M>{'\\varepsilon_t'}</M>,短路瞬間節點上有電壓{' '}
          <M>{'v_d = V_p\\sin(2\\pi\\varepsilon_t/T_{vco})'}</M>,短路把{' '}
          <M>{'\\tfrac{1}{2}CV_d^2'}</M> 型的能量打掉 — 擾動振幅、拉動相位、產生 spur。所以
          disturbance 的 proxy 隨 <M>{'\\sin^2'}</M> 走:對小 miss 是二次方地寬容,對大 miss
          迅速惡化。<EpistemicTag kind="APPROX" />
        </p>
        <ZcWaveform epsCycles={epsCycles} accent={ct.accent} bad={ct.bad} />
        <p>
          上圖:一個 <M>{'T_{vco}'}</M> 的 differential 波形;紅線 = 目前 slider 的 pulse 位置
          (ε_t = {formatSiTime(epsS)}),紅點電壓即被短路的 <M>{'v_d/V_p'}</M>。
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>
          differential waveform(MODEL_SPEC §15)<EpistemicTag kind="APPROX" />:
        </p>
        <MathBlock>{'v_d(t) = V_p\\,\\sin\\!\\big(2\\pi\\,(t - t_z)/T_{vco}\\big)'}</MathBlock>
        <p>
          pulse 在 <M>{'t_z+\\varepsilon_t'}</M> 短路時的 normalized 電壓與 small-signal 近似:
        </p>
        <MathBlock>
          {
            '\\frac{v_d}{V_p} = \\sin\\!\\Big(\\frac{2\\pi\\varepsilon_t}{T_{vco}}\\Big) \\;\\approx\\; \\frac{2\\pi\\varepsilon_t}{T_{vco}} \\quad (\\text{small signal})'
          }
        </MathBlock>
        <p>
          能量 proxy(normalized,<em>非</em>真實 energy)<EpistemicTag kind="APPROX" />:
        </p>
        <MathBlock>
          {'E_{short,norm} = \\sin^2\\!\\Big(\\frac{2\\pi\\varepsilon_t}{T_{vco}}\\Big)'}
        </MathBlock>
        <p>
          half-LSB 檢查值 <EpistemicTag kind="EXACT" />:<M>{'\\varepsilon_t = T_{vco}/512'}</M>{' '}
          時
        </p>
        <MathBlock>
          {
            '\\frac{|v_d|}{V_p} \\approx \\frac{2\\pi}{512} = 1.227\\%,\\qquad E \\approx \\Big(\\frac{2\\pi}{512}\\Big)^2 = 1.5\\times10^{-4}'
          }
        </MathBlock>
        <p>
          與 scheduler 的連結:<M>{'\\varepsilon_t = e_{ZC}\\cdot T_{vco}'}</M>,其中{' '}
          <M>{'e_{ZC}'}</M> 是第 6 章的 zero-crossing alignment error(§5.1),在 model 中即{' '}
          <code>e_ZC_hw</code>(deterministic)與 <code>e_ZC_total</code>(含 noise 與
          dynamics)。error 的統計性質決定頻譜後果 <EpistemicTag kind="INFERENCE" />:
          固定 error → static phase offset;periodic error → deterministic spur(
          <M>{'f_{spur}=\\tfrac{m}{P}f_{ref}'}</M>);noise-like error → phase-noise floor。
        </p>
      </SectionMath>

      <SectionExample>
        <p>
          手算(N=3.125,<M>{'T_{vco}'}</M> = 80 ps,LSB = 312.5 fs,half-LSB = 156.25 fs):
        </p>
        <ul>
          <li>
            <M>{'2\\pi\\times156.25\\,\\mathrm{fs}/80\\,\\mathrm{ps} = 2\\pi/512 = 0.012272'}</M>{' '}
            rad → <M>{'|v_d|/V_p = \\sin(0.012272) = 0.012271 \\approx 1.227\\%'}</M>。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            <M>{'E = (2\\pi/512)^2 = 1.506\\times10^{-4} \\approx 1.5\\times10^{-4}'}</M>。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            對照:1 LSB miss → 2.45%、E = 6.0×10⁻⁴;1° tap mismatch(0.711 LSB)→ sin(1°) =
            1.745%、E = 3.05×10⁻⁴ ≈ half-LSB 的 2 倍。
          </li>
        </ul>
        <p>
          目前 slider:ε_t = {trimNumber(epsLsb, 4)} LSB = {formatSiTime(epsS)} →{' '}
          <M>{'v_d/V_p'}</M> = {trimNumber(ratio * 100, 4)}%,E = {trimNumber(energy, 4)}。
          <EpistemicTag kind="APPROX" />
        </p>

        <ExampleProblem
          index={1}
          tag="APPROX"
          title="一個 timing miss 對應多少被短路的電壓與能量"
          prompt={
            <>
              injection pulse 偏離 zero crossing <M>{'\\varepsilon_t'}</M>。用{' '}
              <M>{'v_d/V_p=\\sin(2\\pi\\varepsilon_t/T_{vco})'}</M> 與{' '}
              <M>{'E_{short,norm}=\\sin^2(\\cdot)'}</M> 算出這一拍被短路的 normalized 電壓與能量
              proxy,並把 <M>{'\\varepsilon_t'}</M> 換算成 LSB 以便和 half-LSB 預算比較(
              <M>{'T_{vco}=1/(N f_{ref})'}</M>,1 LSB <M>{'=T_{vco}/256'}</M>)。
            </>
          }
          inputs={EX_VD_INPUTS}
          compute={exVdCompute}
        />

        <ExampleProblem
          index={2}
          tag="EXACT"
          title="從 x_ideal[k] 到 ε_t:量化殘差怎麼變成被短路的電壓"
          prompt={
            <>
              第 k 拍的 <M>{'x_{ideal}[k]=\\operatorname{wrap01}(kN)'}</M> 決定 injection
              命令 <M>{'u_{INJ,ideal}=\\operatorname{wrap01}(z_0-x)'}</M>;它被量化成 fine code{' '}
              <M>{'R_{INJ}=\\operatorname{qNearest}(G u)\\bmod G'}</M>。請算出殘留的{' '}
              <M>{'e_{ZC}=\\operatorname{wrapCycles}(x+R_{INJ}/G-z_0)'}</M>,再用{' '}
              <M>{'\\varepsilon_t=e_{ZC}\\,T_{vco}'}</M> 換成時間,並回報對應的 §15 proxy。
            </>
          }
          inputs={EX_SCHED_INPUTS}
          compute={exSchedCompute}
        />

        <ExampleProblem
          index={3}
          tag="APPROX"
          title="Error budget roll-up:三項 miss 合起來吃掉多少預算"
          prompt={
            <>
              三個獨立誤差同時存在:tap mismatch(以角度給定,
              <M>{'\\theta\\,T_{vco}/360'}</M>)、route skew(以 LSB 給定)、reference jitter
              (rms,fs)。請分別換成時間,做 worst-case 相加與 RSS,再把 RSS 的{' '}
              <M>{'\\varepsilon_t'}</M> 代入 <M>{'E_{short,norm}'}</M>,與 half-LSB 預算對應的{' '}
              <M>{'E'}</M> 相除得到超標倍數。順便對照「逐項 <M>{'E'}</M> 之和」— 因為{' '}
              <M>{'\\sin^2'}</M> 非線性,兩者不相等。
            </>
          }
          inputs={EX_BUDGET_INPUTS}
          compute={exBudgetCompute}
        />
      </SectionExample>

      <SectionFigure
        title="圖 #23 — Differential voltage vs timing offset"
        caption={
          <span>
            橫軸 ε_t(ps,±T_vco/2 @ 80 ps),縱軸 v_d/V_p。實線 = sin 全式;虛線 =
            small-signal 線性近似(在 ±數 LSB 內幾乎重合);垂直虛線 = ±half-LSB(±
            {trimNumber(halfLsbPs, 4)} ps);紅點 = 目前 slider 的 ε_t。用 toolbox 放大 0
            附近可讀出 1.227%。<EpistemicTag kind="APPROX" />
          </span>
        }
      >
        <EChart option={voltOption} height={300} group="ch14geom" />
      </SectionFigure>

      <SectionFigure
        title="圖 #24 — Normalized shorting-energy proxy"
        caption={
          <span>
            E_short_norm = sin²(2πε_t/T_vco):在 zero crossing 附近二次方地小(half-LSB 處僅
            1.5×10⁻⁴,線性刻度下貼著 0 — 這正是重點),在 ±T_vco/4(pulse 打在波峰)達最大值
            1。proxy 僅供架構相對比較,非真實能量。<EpistemicTag kind="APPROX" />
          </span>
        }
      >
        <EChart option={energyOption} height={300} group="ch14geom" />
      </SectionFigure>

      <SectionFigure
        title="圖 #15 — Zero-crossing miss 時序與頻譜(experiment 16:fixed / periodic / random)"
        caption={
          <span>
            三個 config 皆走 linear injection map(K=0.3):灰 = 固定 route offset(+2
            LSB);藍 = N=3.13 nearest 量化(fine-code 誤差週期 P=25);橘 = reference jitter
            100 fs rms。上圖 e_ZC_total(單位:<UnitSwitch />):fixed 的 miss 被 loop 收斂到
            0,代價是 θ⁺(中圖)停在 −2π·(2/256) ≈ −0.049 rad 的 static offset;periodic 留下
            週期 ripple;random 留下 noise。下圖為 θ⁺ 的 PSD(Hann periodogram,sample rate =
            f_ref):periodic → m×160 MHz 的 spurs(紅點,f_spur = m/P·f_ref,P=25);random →
            平坦 floor;fixed 是 DC offset,不出現在 PSD。
            <EpistemicTag kind="EXPERIMENT" /> <EpistemicTag kind="INFERENCE" />
          </span>
        }
      >
        <EChart option={zcSeriesOption} height={280} group="ch14ts" />
        <EChart option={thetaOption} height={280} group="ch14ts" />
        <EChart option={psdOption} height={300} />
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>config</th>
                <th>mean e_ZC_total (°)</th>
                <th>rms (°)</th>
                <th>p2p (°)</th>
                <th>mean E_short_norm</th>
                <th>mean θ⁺ (rad)</th>
              </tr>
            </thead>
            <tbody>
              {caseStats.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td>{trimNumber(r.meanDeg, 4)}</td>
                  <td>{trimNumber(r.rmsDeg, 4)}</td>
                  <td>{trimNumber(r.p2pDeg, 4)}</td>
                  <td>{trimNumber(r.meanE, 4)}</td>
                  <td>{trimNumber(r.thetaPlusMean, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model — e_ZC_hw 與 e_ZC_total 的計算(節錄)"
        code={ZC_CODE}
      >
        <p>
          注意:model 裡<em>沒有</em> v_d 或 E 的欄位 — §15 的兩條式子是 display 層的
          proxy,由 <code>e_ZC</code> 換算而得;本頁圖 #23/#24 即直接畫這兩條 [APPROX] 公式。
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'eZcHw[k] = wrapCycles(xId[k] + uInjAn[k] - cfg.z0_cycles);',
            explain: (
              <span>
                §5.1 的 zero-crossing alignment error:VCO base phase + 實際 injection 位置(tap
                + DTC + route,含 mismatch)− 目標 <M>{'z_0'}</M>,wrap 到 (−0.5, 0.5]。這是純
                deterministic 的硬體排程誤差。<EpistemicTag kind="EXACT" />
              </span>
            ),
          },
          {
            code: 'epsilonHw[k] = twoPi * eZcHwCycles[k];',
            explain: <span>cycles → rad,交給 dynamics 迴圈(§14)。</span>,
          },
          {
            code: 'const e = wrapRadians(tm + epsilonHw[k] + epsRand);',
            explain: (
              <span>
                pulse 時刻的總 miss:VCO random residual(θ⁻)+ deterministic 排程誤差 +
                ref/pulse jitter。<M>{'\\varepsilon_t = e/(2\\pi)\\cdot T_{vco}'}</M> 就是圖
                #23/#24 的橫軸。
              </span>
            ),
          },
          {
            code: 'const dth = deltaTheta(cfg.inj_model, cfg.k_inj, e, lutE, lutD);',
            explain: (
              <span>
                injection 依 miss 修正相位(第 13 章)— 同一個 <M>{'e'}</M> 既決定 phase
                correction,也決定被短路的 <M>{'v_d'}</M>。
              </span>
            ),
          },
          {
            code: 'eZcTotal[k] = e / twoPi;',
            explain: (
              <span>
                存回 cycles,即 SimResult 的 <code>e_ZC_total</code> 欄位 — 圖 #15 的時序資料
                來源;§16 三種 error 中「最終物理量」的那一個。
              </span>
            ),
          },
          {
            code: '(display) ratio = Math.sin(2 * Math.PI * epsCycles); energy = ratio * ratio;',
            explain: (
              <span>
                §15 proxy 在本頁的落點:只在 display 層由 e_ZC 換算,不迴寫 model — 模型誠實地
                不宣稱知道真實 shorting energy。<EpistemicTag kind="APPROX" />
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            圖 #23:0 附近 sin 與線性近似重合,斜率 <M>{'2\\pi/T_{vco}'}</M>;half-LSB
            垂直線與曲線交點讀值 ≈ 0.0123 = 1.227%。<EpistemicTag kind="EXACT" />
          </li>
          <li>
            圖 #24:能量在 ±T_vco/4 達 1(pulse 打在波峰);half-LSB 處 1.5×10⁻⁴,約為波峰的
            1/6600 — 架構鏈把 miss 壓進 sub-LSB 後,shorting disturbance 是二次方地小。
          </li>
          <li>
            圖 #15 上圖:fixed(灰)在前 ~30 拍收斂到 0 — miss 被 loop 吃掉;代價在中圖:θ⁺
            停在 −0.049 rad(static offset,表格 mean θ⁺ 欄)。
            <EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            periodic(藍):e_ZC_total 呈 ±half-LSB 內的週期 ripple;PSD 出現 m×160 MHz spurs
            (fine-code 誤差週期 P=25 → f_ref/P = 160 MHz;0.28 LSB/拍 = 7/25)。
            <EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            random(橘):時域無結構,PSD 為平坦 floor — 三種 error 性質對應三種頻譜後果。
            <EpistemicTag kind="INFERENCE" />
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解 1:「E ∝ sin² 可以直接換算成 mW / dBm」">
          <p>
            不行。E_short_norm 是 normalized proxy:真實 shorting energy 取決於 V_p、短路開關的
            on-resistance、pulse 寬度、tank 阻抗與非線性 clipping,全部不在 behavioral model
            內。proxy 只能做<em>相對</em>比較(架構 A vs B、miss 大 vs 小),不能做絕對功耗
            預測。<EpistemicTag kind="APPROX" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解 2:「DSM 把平均 error 做到 0,shorting 就沒事」">
          <p>
            <M>{'\\sin^2'}</M> 恆正且非線性:error 平均為 0 不代表能量平均為 0(表格的 mean
            E_short_norm 欄全部 &gt; 0)。而且 periodic 的 zero-mean error 會變成
            deterministic spur — 頻譜在意的是 error 的<em>結構</em>,不是平均值。
            <EpistemicTag kind="INFERENCE" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>
            設計目標:把 <M>{'|e_{ZC}|'}</M> 壓在 half-LSB 內 → 每拍被短路的電壓 ≤ 1.227%
            V_p、能量 proxy ≤ 1.5×10⁻⁴ — shorting injection 對 sub-LSB 的排程殘差是二次方地
            寬容。<EpistemicTag kind="EXACT" />
          </li>
          <li>
            error budget 要按性質分類列帳:deterministic 固定項(tap/route/gain)→ offset,可
            校正;periodic 項(量化、INL)→ spur,選 quantizer/DSM 時要看頻譜;random 項
            (jitter)→ floor。同樣的 rms,後果完全不同。<EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            1° tap mismatch 的能量 proxy 已是 half-LSB 的 2 倍 — 第 15 章的 calibrated mapping
            因此值得做。<EpistemicTag kind="INFERENCE" />
          </li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <ul>
            <li>
              <M>{'v_d/V_p'}</M> 假設理想弦波 differential waveform;真實 VCO 波形含諧波與
              amplitude noise。<EpistemicTag kind="ASSUMPTION" />
            </li>
            <li>
              E ∝ sin² 是 normalized proxy,非真實 energy;未建模 pulse 寬度內的波形變化與
              開關電阻。<EpistemicTag kind="APPROX" />
            </li>
            <li>
              「offset / spur / floor」對應是由 behavioral experiment 支持的 inference,
              spur 絕對位準仍需電晶體級與量測確認。<EpistemicTag kind="INFERENCE" />
            </li>
            <li>本專案未執行 Spectre;behavioral result 不等同 silicon result(MODEL_SPEC §20)。</li>
          </ul>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="參數 — Chapter 14">
        <Slider
          label="ε_t(timing offset)"
          value={epsLsb}
          min={-128}
          max={128}
          step={0.25}
          unit="LSB"
          onChange={setEpsLsb}
          fmt={(v) => trimNumber(v, 4)}
        />
        <PresetButtons
          label="Preset ε_t"
          presets={[
            { label: 'half-LSB(0.5)', onClick: () => setEpsLsb(0.5) },
            { label: '1 LSB', onClick: () => setEpsLsb(1) },
            { label: '1°(0.711 LSB)', onClick: () => setEpsLsb(256 / 360) },
            { label: '波峰(64 LSB)', onClick: () => setEpsLsb(64) },
          ]}
        />
        <p style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 8 }}>
          1 LSB = {formatSiTime(LSB_S)}(N=3.125);ε_t = {formatSiTime(epsS)}。時序/頻譜圖固定使用
          experiment 16 的三個 config(512 cycles,seed 12345)。
        </p>
      </ParamPanel>
    </ChapterShell>
  );
}
