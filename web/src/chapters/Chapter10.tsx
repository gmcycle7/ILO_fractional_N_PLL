/**
 * Chapter 10 — Sub-LSB Quantization Sub-LSB 量化
 *
 * Content contract: CHAPTER_GUIDE.md Ch10; math contract: MODEL_SPEC.md
 * section 9 (0.337 -> 86/170 -> -85 fs/+85 fs -> pair = 0), section 7
 * (mode D identity), section 2 (qNearest / wrap conventions).
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
import ExampleProblem, { fmt } from '../components/ExampleProblem';
import { M, MathBlock } from '../components/Math';
import { ParamPanel, Slider, PresetButtons } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import DebugTable from '../components/DebugTable';
import { makeLineOption, makeMarkLine } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import {
  phaseAxisLabel,
  makePhaseTickFormatter,
  formatPhase,
  formatSiTime,
  trimNumber,
} from '../lib/format';
import type { PhaseUnit } from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  simulate,
  fromPartial,
  qNearest,
  pymod,
  wrap01,
  wrapCycles,
  tVcoS,
  uInjIdeal,
  ePair,
} from '../model';

const meta = chapterById(10)!;
const G = 256;
const N_EX = 3.125; // MODEL_SPEC section 9 canonical frequency (T_vco = 80 ps)
const N_SIM = 3.13; // off-grid trajectory for the tracking figure
const N_CYCLES = 128;
const HALF_LSB_CYC = 0.5 / G;

function toXY(ys: ArrayLike<number>): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < ys.length; k++) {
    out.push([k, ys[k]]);
  }
  return out;
}

interface LiveValues {
  fine: number; // G * u (real LSB)
  aFb: number; // qNearest(fine), unwrapped
  rFb: number; // mod G
  uFbAct: number;
  eFb: number; // cycles
  fineInj: number; // G * wrap01(-u)
  uInjIdeal: number;
  rInj: number;
  uInjAct: number;
  eInj: number; // cycles
  sum: number;
  pair: number; // cycles
}

/** MODEL_SPEC section 9 walkthrough for one u value (all via ../model math). */
function computeLive(u: number): LiveValues {
  const fine = G * u;
  const aFb = qNearest(fine);
  const rFb = pymod(aFb, G);
  const uFbAct = rFb / G;
  const eFb = wrapCycles(uFbAct - u);
  const uInjIdeal = wrap01(-u);
  const fineInj = G * uInjIdeal;
  const rInj = pymod(-rFb, G);
  const uInjAct = rInj / G;
  const eInj = wrapCycles(uInjAct - uInjIdeal);
  const sum = uFbAct + uInjAct;
  const pair = wrapCycles(sum);
  return { fine, aFb, rFb, uFbAct, eFb, fineInj, uInjIdeal, rInj, uInjAct, eInj, sum, pair };
}

/** Sub-LSB magnifier (hand-rolled SVG, theme-token colors only). */
function Magnifier({
  live,
  unit,
  tVco,
}: {
  live: LiveValues;
  unit: PhaseUnit;
  tVco: number;
}) {
  const W = 660;
  const H = 250;
  const X0 = 30;
  const X1 = 630;
  const span = X1 - X0;

  // top strip: full cycle 0..1
  const yStrip = 34;
  const xu = X0 + span * (live.fine / G);

  // one row of zoomed axis: center c (LSB), half-window 1.8 LSB
  const HW = 1.8;
  const row = (cLsb: number, actLsb: number, y: number, name: string) => {
    const w0 = cLsb - HW;
    const w1 = cLsb + HW;
    const x = (t: number) => X0 + (span * (t - w0)) / (w1 - w0);
    const ticks: number[] = [];
    for (let t = Math.ceil(w0); t <= Math.floor(w1); t++) ticks.push(t);
    const xi = x(cLsb);
    const xa = x(actLsb);
    return (
      <g key={name}>
        {/* sub-LSB gap shading between ideal and actual */}
        <rect
          x={Math.min(xi, xa)}
          y={y - 9}
          width={Math.max(Math.abs(xa - xi), 1)}
          height={18}
          fill="var(--accent-soft)"
        />
        <line x1={X0} y1={y} x2={X1} y2={y} stroke="var(--border-strong)" strokeWidth={1} />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} y1={y - 7} x2={x(t)} y2={y + 7} stroke="var(--fg-faint)" />
            <text
              x={x(t)}
              y={y + 22}
              textAnchor="middle"
              fontSize={10}
              fill="var(--fg-subtle)"
            >
              {pymod(t, G)}
            </text>
          </g>
        ))}
        {/* actual quantized edge */}
        <line x1={xa} y1={y - 14} x2={xa} y2={y + 10} stroke="var(--fg)" strokeWidth={2} />
        <text x={xa} y={y - 20} textAnchor="middle" fontSize={10} fill="var(--fg)">
          actual (code)
        </text>
        {/* ideal position */}
        <circle cx={xi} cy={y} r={4.5} fill="var(--accent)" />
        <text x={xi} y={y + 36} textAnchor="middle" fontSize={10} fill="var(--accent)">
          ideal {trimNumber(cLsb, 6)} LSB
        </text>
        <text x={X1 + 4} y={y + 3} textAnchor="start" fontSize={10} fill="var(--fg-subtle)">
          {name}
        </text>
      </g>
    );
  };

  // plot the actual edge next to the ideal one, unwrapped via the pair error
  const fbAct = live.fine + G * live.eFb;
  const injAct = live.fineInj + G * live.eInj;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', maxWidth: 720, height: 'auto', display: 'block' }}
      role="img"
      aria-label="sub-LSB magnifier"
    >
      {/* full-range strip */}
      <line x1={X0} y1={yStrip} x2={X1} y2={yStrip} stroke="var(--border-strong)" />
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line
            x1={X0 + span * t}
            y1={yStrip - 5}
            x2={X0 + span * t}
            y2={yStrip + 5}
            stroke="var(--fg-faint)"
          />
          <text
            x={X0 + span * t}
            y={yStrip + 18}
            textAnchor="middle"
            fontSize={10}
            fill="var(--fg-subtle)"
          >
            {trimNumber(t * G, 4)}
          </text>
        </g>
      ))}
      <circle cx={xu} cy={yStrip} r={4} fill="var(--accent)" />
      <rect
        x={Math.max(X0, xu - 12)}
        y={yStrip - 10}
        width={24}
        height={20}
        fill="none"
        stroke="var(--accent)"
        strokeDasharray="3 2"
      />
      <text x={X0} y={14} fontSize={11} fill="var(--fg-subtle)">
        full range 0..255 LSB(1 VCO cycle);虛線框 = 下方放大區
      </text>

      {/* zoomed rows */}
      <text x={X0} y={78} fontSize={11} fill="var(--fg-subtle)">
        放大 ×{trimNumber(G / (2 * 1.8), 3)}:格點 = 可用 code(間距 1 LSB ={' '}
        {formatSiTime(tVco / G)})
      </text>
      {row(live.fine, fbAct, 110, 'FB')}
      {row(live.fineInj, injAct, 190, 'INJ')}
      <text x={X0} y={H - 6} fontSize={11} fill="var(--fg-subtle)">
        陰影 = sub-LSB gap:FB {formatPhase(live.eFb, unit, tVco)} / INJ{' '}
        {formatPhase(live.eInj, unit, tVco)};兩者等大反號,pair ={' '}
        {trimNumber(live.pair, 3)}
      </text>
    </svg>
  );
}

export default function Chapter10() {
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();
  const [u, setU] = useState(0.337);

  const tVcoEx = tVcoS(N_EX); // 80 ps [EXACT]
  const live = useMemo(() => computeLive(u), [u]);

  // tracking figure: N=3.13, nearest, mode D
  const sim = useMemo(
    () => simulate(fromPartial({ n_div: N_SIM, quantizer: 'nearest', n_cycles: N_CYCLES })),
    [],
  );
  useEffect(() => {
    setStatus('done', `${N_CYCLES} cycles (N=${N_SIM})`);
  }, [sim, setStatus]);
  const tVcoSim = sim.t_vco_s;

  const optTraj = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: phaseAxisLabel('u_FB', unit, tVcoSim),
        yTickFormatter: makePhaseTickFormatter(unit, tVcoSim),
        series: [
          {
            name: 'x_ideal(理想軌跡)',
            data: toXY(sim.data.x_ideal),
            showSymbol: false,
            color: ct.accent,
          },
          {
            name: 'u_FB_digital(quantized common trajectory)',
            data: toXY(sim.data.u_FB_digital),
            step: 'middle',
            showSymbol: false,
            color: ct.warn,
          },
        ],
      }),
    [sim, unit, tVcoSim, ct],
  );

  const optErr = useMemo(() => {
    const o = makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: phaseAxisLabel('error', unit, tVcoSim),
      yTickFormatter: makePhaseTickFormatter(unit, tVcoSim),
      series: [
        {
          name: 'e_FB_abs',
          data: toXY(sim.data.e_FB_abs),
          step: 'middle',
          showSymbol: false,
          color: ct.accent,
        },
        {
          name: 'e_INJ_abs',
          data: toXY(sim.data.e_INJ_abs),
          step: 'middle',
          showSymbol: false,
          color: ct.warn,
        },
        {
          name: 'e_pair_digital',
          data: toXY(sim.data.e_pair_digital),
          step: 'middle',
          showSymbol: false,
          color: ct.good,
          width: 2.2,
        },
      ],
    });
    const series = o.series as Record<string, unknown>[];
    series[0].markLine = makeMarkLine([
      { y: HALF_LSB_CYC, label: '+half-LSB' },
      { y: -HALF_LSB_CYC, label: '−half-LSB' },
    ]);
    return o;
  }, [sim, unit, tVcoSim, ct]);

  const debugRows = useMemo(() => {
    const d = sim.data;
    const m = Math.min(24, d.k.length);
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < m; i++) {
      rows.push({
        k: d.k[i],
        x_ideal: d.x_ideal[i],
        R_FB: d.R_FB[i],
        u_FB_digital: d.u_FB_digital[i],
        R_INJ: d.R_INJ[i],
        u_INJ_digital: d.u_INJ_digital[i],
        e_FB_abs: d.e_FB_abs[i],
        e_INJ_abs: d.e_INJ_abs[i],
        e_pair_digital: d.e_pair_digital[i],
      });
    }
    return rows;
  }, [sim]);

  const fmt6 = (v: unknown) => trimNumber(Number(v), 6);
  const fp = (x: number) => formatPhase(x, unit, tVcoEx);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            當理想 phase 落在兩個 code 之間(sub-LSB gap)時,quantizer 到底把 edge
            放在哪裡?誤差多大?<EpistemicTag kind="EXACT" />
          </li>
          <li>
            MODEL_SPEC §9 的 canonical 例:u = 0.337 為何變成 86 / 170、產生 ∓85 fs、
            而 pair error 恰為 0?
          </li>
          <li>
            「shared code 讓 pair = 0」與「absolute error 各 85 fs」如何同時成立?
            shared code 到底消除了什麼、沒消除什麼?<EpistemicTag kind="EXACT" />
          </li>
          <li>
            VCO 實際追蹤(track)的是哪一條軌跡 — ideal trajectory 還是 quantized
            common trajectory?<EpistemicTag kind="INFERENCE" />
          </li>
          <li>shared code 能不能「創造」一個 sub-LSB 的 analog delay?(不能。)</li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          6-bit DTC + 4-phase PMUX 給出的 phase 解析度是 1/256 cycle:在 N=3.125
          (T_vco = 80 ps)時 1 LSB = 312.5 fs。actuator 只能把 edge 放在這 256 個
          格點上;理想 phase 0.337 cycle 落在格點 86(0.3359 cycle)與 87(0.3398
          cycle)之間 — 它「存在」,但<b>沒有任何 code 能表示它</b>。這個表示不了的
          縫隙就是 sub-LSB gap。<EpistemicTag kind="EXACT" />
        </p>
        <p>
          關鍵直覺:feedback 與 injection 兩邊用<b>同一個</b>量化決策(mode D 共享
          final code),所以兩邊「掉進同一個格點」。feedback edge 早了 85 fs,
          injection command 就晚了 85 fs — 相對關係精確互補(pair = 0),但兩邊對
          ideal 都各差 85 fs。就像兩支錶都對同一個慢 85 fs 的時鐘校時:彼此完全同步,
          但都不是「真時間」。
        </p>
        <p>
          於是 VCO 追蹤的不是理想軌跡,而是<b>量化後的共同軌跡</b>(quantized common
          trajectory):一條每拍最多偏離 ideal half-LSB、但 feedback / injection
          完全一致的階梯。injection 對準的是這條階梯的 zero crossing — 這正是我們
          要的,因為 PLL loop(feedback)鎖定的也是同一條階梯。
          <EpistemicTag kind="INFERENCE" />
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>單位與檢查值(MODEL_SPEC §9,N = 3.125、f_vco = 12.5 GHz、T_vco = 80 ps):</p>
        <MathBlock>
          {
            '1\\,\\mathrm{LSB}=\\frac{T_{vco}}{256}=312.5\\,\\mathrm{fs}=1.40625^{\\circ},\\qquad \\tfrac{1}{2}\\,\\mathrm{LSB}=156.25\\,\\mathrm{fs}=0.703125^{\\circ}'
          }
        </MathBlock>
        <p>feedback 側 quantize 與 decode(§4、§6,quantizer = nearest):</p>
        <MathBlock>
          {
            'R_{FB}=\\bigl\\lfloor G\\,u_{FB,ideal}+0.5\\bigr\\rfloor \\bmod G,\\qquad u_{FB,actual}=\\frac{R_{FB}}{G},\\qquad e_{FB}=\\operatorname{wrapCycles}(u_{FB,actual}-u_{FB,ideal})'
          }
        </MathBlock>
        <p>
          nearest 的絕對誤差界:<M>{'|e_{FB}|\\le \\tfrac{1}{2G}'}</M> cycle(half-LSB)
          <EpistemicTag kind="EXACT" />。injection 側(mode D,§7)不再量化,直接
          modular reverse:
        </p>
        <MathBlock>
          {'R_{INJ}=(R_{zero}-R_{FB})\\bmod G \\;\\Rightarrow\\; (R_{FB}+R_{INJ})\\bmod G = R_{zero}'}
        </MathBlock>
        <p>
          pair error(§7)因此逐拍為零:<EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {
            'e_{pair}=\\operatorname{wrapCycles}\\!\\Bigl(u_{FB,actual}+u_{INJ,actual}-\\tfrac{R_{zero}}{G}\\Bigr)\\equiv 0'
          }
        </MathBlock>
        <p>
          兩側絕對誤差鏡像:由 <M>{'u_{INJ,ideal}=\\operatorname{wrap01}(-u_{FB,ideal})'}</M>{' '}
          與上式,
        </p>
        <MathBlock>{'e_{INJ}=\\operatorname{wrapCycles}(u_{INJ,actual}-u_{INJ,ideal})=-\\,e_{FB}'}</MathBlock>
        <p>
          (digital 層、mode D、<M>{'z_0=0'}</M>)<EpistemicTag kind="EXACT" />。
          注意:這裡沒有任何機制能把 edge 放到格點之間 — shared code 改變的是「兩邊
          選同一個格點」,不是「格點變密」。sub-LSB 的 analog delay 不存在,也沒有被
          創造出來。<EpistemicTag kind="EXACT" />
        </p>
      </SectionMath>

      <SectionExample>
        <p>MODEL_SPEC §9 全例(Test 1、3),u_FB_ideal = 0.337,逐步:</p>
        <ol>
          <li>
            ideal fine code:<M>{'256\\times 0.337 = 86.272'}</M> — 落在 code 86 與 87
            之間,離 86 為 0.272 LSB、離 87 為 0.728 LSB。
          </li>
          <li>
            nearest:<M>{'R_{FB}=\\lfloor 86.272+0.5\\rfloor = 86'}</M>;
            <M>{'u_{FB,actual}=86/256=0.3359375'}</M>。
          </li>
          <li>
            <M>{'e_{FB}=0.3359375-0.337=-0.0010625'}</M> cycle;×80 ps ={' '}
            <b>−85 fs</b>(edge 提早)。
          </li>
          <li>
            modular reverse:<M>{'R_{INJ}=(0-86)\\bmod 256=170'}</M>;
            <M>{'u_{INJ,actual}=170/256=0.6640625'}</M>,而 ideal ={' '}
            <M>{'1-0.337=0.663'}</M>。
          </li>
          <li>
            <M>{'e_{INJ}=0.6640625-0.663=+0.0010625'}</M> cycle = <b>+85 fs</b>(等大
            反號)。
          </li>
          <li>
            <M>{'u_{FB,actual}+u_{INJ,actual}=0.3359375+0.6640625=1.0'}</M> →{' '}
            <M>{'e_{pair,digital}=\\operatorname{wrapCycles}(1.0)=0'}</M>。
            <EpistemicTag kind="EXACT" />
          </li>
        </ol>
        <p>
          結論:absolute phase 各差 85 fs,但 pair 數位上 exact reverse — 下方互動圖
          把滑桿設回 0.337 可即時重現整條計算。
        </p>

        <ExampleProblem
          index={1}
          tag="EXACT"
          title="Feedback 側量化任意 ideal phase u"
          prompt={
            <>
              給定 <M>{'N'}</M>、<M>{'f_{ref}'}</M> 與 ideal fractional phase{' '}
              <M>{'u\\in[0,1)'}</M>,算出 fine code <M>{'G\\,u'}</M>、nearest 量化後的{' '}
              <M>{'R_{FB}=\\operatorname{qNearest}(G\\,u)\\bmod G'}</M>、實際相位{' '}
              <M>{'u_{FB,actual}=R_{FB}/G'}</M> 與絕對誤差{' '}
              <M>{'e_{FB}=\\operatorname{wrapCycles}(u_{FB,actual}-u)'}</M>(換算成時間)。
            </>
          }
          inputs={[
            { key: 'N', label: <M>{'N'}</M>, def: 3.125, min: 2, max: 8, step: 0.001 },
            { key: 'fref', label: <M>{'f_{ref}'}</M>, def: 4, min: 0.5, max: 20, step: 0.1, unit: 'GHz' },
            { key: 'u', label: <M>{'u'}</M>, def: 0.61, min: 0, max: 1, step: 0.001, unit: 'cyc' },
          ]}
          compute={(v) => {
            const { N, fref, u } = v;
            const tVco = tVcoS(N, fref * 1e9);
            const fine = G * u;
            const rFb = pymod(qNearest(fine), G);
            const uFbAct = rFb / G;
            const eFb = wrapCycles(uFbAct - u);
            const eFbTime = eFb * tVco;
            return {
              steps: [
                { label: <><M>{'G\\,u'}</M>(fine code)</>, value: fmt(fine, 8, 'LSB') },
                { label: <><M>{'R_{FB}=\\operatorname{qNearest}(G\\,u)\\bmod G'}</M></>, value: `${rFb}` },
                { label: <><M>{'u_{FB,actual}=R_{FB}/G'}</M></>, value: fmt(uFbAct, 8, 'cyc') },
                { label: <><M>{'e_{FB}=\\operatorname{wrapCycles}(u_{FB,actual}-u)'}</M></>, value: fmt(eFb, 6, 'cyc') },
                { label: <>換算時間 <M>{'e_{FB}\\times T_{vco}'}</M></>, value: fmt(eFbTime * 1e15, 5, 'fs') },
              ],
              answer: (
                <>
                  <M>{'R_{FB}'}</M> = {rFb},<M>{'u_{FB,actual}'}</M> = {fmt(uFbAct, 6, 'cyc')},
                  絕對誤差 <M>{'e_{FB}'}</M> = {fmt(eFb, 5, 'cyc')} cyc = {fmt(eFbTime * 1e15, 4, 'fs')}
                </>
              ),
            };
          }}
        />

        <ExampleProblem
          index={2}
          tag="EXACT"
          title="Mode D modular reverse 與 pair identity(任意 R_zero)"
          prompt={
            <>
              沿用上例的 <M>{'R_{FB}'}</M>,mode D 不再量化,直接{' '}
              <M>{'R_{INJ}=(R_{zero}-R_{FB})\\bmod G'}</M>。取{' '}
              <M>{'z_0=R_{zero}/G'}</M> 算出 ideal target{' '}
              <M>{'u_{INJ,ideal}=\\operatorname{wrap01}(z_0-u)'}</M> 與絕對誤差{' '}
              <M>{'e_{INJ}'}</M>,並用 <code>ePair</code> 驗證{' '}
              <M>{'e_{pair}=\\operatorname{wrapCycles}(u_{FB,actual}+u_{INJ,actual}-z_0)'}</M> 是否恆為 0。
            </>
          }
          inputs={[
            { key: 'u', label: <M>{'u'}</M>, def: 0.61, min: 0, max: 1, step: 0.001, unit: 'cyc' },
            { key: 'Rzero', label: <M>{'R_{zero}'}</M>, def: 0, min: 0, max: 255, step: 1 },
          ]}
          compute={(v) => {
            const { u } = v;
            const rZero = Math.round(v.Rzero);
            const fine = G * u;
            const rFb = pymod(qNearest(fine), G);
            const uFbAct = rFb / G;
            const eFb = wrapCycles(uFbAct - u);
            const rInj = pymod(rZero - rFb, G);
            const uInjAct = rInj / G;
            const z0 = rZero / G;
            const uInjIdealVal = uInjIdeal([u], z0)[0];
            const eInj = wrapCycles(uInjAct - uInjIdealVal);
            const ePairVal = ePair([uFbAct], [uInjAct], rZero, G)[0];
            return {
              steps: [
                { label: <><M>{'R_{FB}'}</M>(同上例)</>, value: `${rFb}` },
                { label: <><M>{'R_{INJ}=(R_{zero}-R_{FB})\\bmod G'}</M></>, value: `${rInj}` },
                { label: <><M>{'u_{INJ,actual}=R_{INJ}/G'}</M></>, value: fmt(uInjAct, 8, 'cyc') },
                { label: <><M>{'u_{INJ,ideal}=\\operatorname{wrap01}(z_0-u)'}</M></>, value: fmt(uInjIdealVal, 8, 'cyc') },
                { label: <><M>{'e_{INJ}=\\operatorname{wrapCycles}(u_{INJ,actual}-u_{INJ,ideal})'}</M></>, value: fmt(eInj, 6, 'cyc') },
                { label: <>鏡像檢查 <M>{'e_{INJ}+e_{FB}'}</M></>, value: fmt(eInj + eFb, 8, 'cyc') },
                { label: <><M>{'e_{pair}'}</M>(<code>ePair</code>)</>, value: fmt(ePairVal, 8, 'cyc') },
              ],
              answer: (
                <>
                  <M>{'R_{INJ}'}</M> = {rInj},<M>{'e_{pair,digital}'}</M> = {fmt(ePairVal, 6, 'cyc')}
                  (mode D identity 恆為 0);<M>{'e_{INJ}=-e_{FB}'}</M> 鏡像:{fmt(eInj, 5, 'cyc')} vs{' '}
                  {fmt(-eFb, 5, 'cyc')}
                </>
              ),
            };
          }}
        />

        <ExampleProblem
          index={3}
          tag="EXPERIMENT"
          title="短程模擬驗證 max|e_FB_abs| ≤ half-LSB(多步驟 error budget)"
          prompt={
            <>
              跑 <M>{'N_{cyc}'}</M> 拍(最多 128 拍)的 nearest、mode D 模擬,取{' '}
              <M>{'e_{FB,abs}[k]'}</M> 的最大絕對值,與 half-LSB 界{' '}
              <M>{'1/(2G)'}</M> 比較,確認 nearest quantizer 的誤差界不被違反。
            </>
          }
          inputs={[
            { key: 'N', label: <M>{'N'}</M>, def: 3.13, min: 3, max: 3.25, step: 0.001 },
            { key: 'fref', label: <M>{'f_{ref}'}</M>, def: 4, min: 0.5, max: 20, step: 0.1, unit: 'GHz' },
            { key: 's0', label: <M>{'s_0'}</M>, def: 0, min: -10, max: 10, step: 0.01, unit: 'cyc' },
            { key: 'cycles', label: <M>{'N_{cyc}'}</M>, def: 64, min: 2, max: 128, step: 1 },
          ]}
          compute={(v) => {
            const { N, fref, s0 } = v;
            const nCycles = Math.min(128, Math.max(2, Math.round(v.cycles)));
            const cfg = fromPartial({
              n_div: N,
              f_ref_hz: fref * 1e9,
              s0,
              n_cycles: nCycles,
              quantizer: 'nearest',
              arch_mode: 'D',
            });
            const sim = simulate(cfg);
            const g = sim.g;
            const tVco = sim.t_vco_s;
            const eArr = sim.data.e_FB_abs;
            let maxAbs = 0;
            let argk = 0;
            for (let i = 0; i < eArr.length; i++) {
              const a = Math.abs(eArr[i]);
              if (a > maxAbs) {
                maxAbs = a;
                argk = i;
              }
            }
            const halfLsb = 1 / (2 * g);
            const ratio = maxAbs / halfLsb;
            const within = maxAbs <= halfLsb + 1e-9;
            return {
              steps: [
                { label: <>fine LSB 數 <M>{'G'}</M></>, value: `${g}` },
                { label: <>half-LSB(cycle)</>, value: fmt(halfLsb, 6, 'cyc') },
                { label: <>half-LSB(時間)</>, value: fmt((halfLsb * tVco) * 1e15, 5, 'fs') },
                { label: <><M>{'\\max_k |e_{FB,abs}[k]|'}</M></>, value: `${fmt(maxAbs, 6, 'cyc')}(k=${argk})` },
                { label: <>同上,換算時間</>, value: fmt(maxAbs * tVco * 1e15, 5, 'fs') },
                { label: <>對 half-LSB 的比例</>, value: fmt(ratio, 5) },
              ],
              answer: (
                <>
                  {nCycles} 拍內 <M>{'\\max|e_{FB,abs}|'}</M> = {fmt(maxAbs, 5, 'cyc')} ={' '}
                  {fmt(maxAbs * tVco * 1e15, 4, 'fs')},為 half-LSB 的 {fmt(ratio, 4)}
                  倍 — {within ? '確認未超出界限' : '超出界限(不應發生於 nearest)'}
                </>
              ),
              warn: within ? undefined : `max|e_FB_abs| 超出 half-LSB 界 — 請確認 quantizer 設定`,
            };
          }}
        />
      </SectionExample>

      <SectionFigure
        title="互動 sub-LSB walkthrough:u_ideal 滑桿即時計算(MODEL_SPEC §9)"
        caption={
          <span>
            所有值由 <code>qNearest / pymod / wrap01 / wrapCycles</code>(model 函數)
            即時算出;phase 欄位顯示單位:<UnitSwitch />(N=3.125,T_vco = 80 ps)。
            試試 preset「86.5/256」:ideal 恰在兩格點正中間,half-up 規則把 FB 推上
            87,mode D 令 INJ = 169 — pair 仍為 0。
          </span>
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>量</th>
                <th>Feedback 側</th>
                <th>Injection 側(mode D)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>ideal(cycles)</td>
                <td>
                  u = {trimNumber(u, 6)}({fp(u)})
                </td>
                <td>
                  wrap01(−u) = {trimNumber(live.uInjIdeal, 6)}({fp(live.uInjIdeal)})
                </td>
              </tr>
              <tr>
                <td>ideal fine code(LSB)</td>
                <td>{trimNumber(live.fine, 7)}</td>
                <td>{trimNumber(live.fineInj, 7)}</td>
              </tr>
              <tr>
                <td>integer code</td>
                <td>
                  R_FB = qNearest = <b>{live.rFb}</b>
                </td>
                <td>
                  R_INJ = (0 − R_FB) mod 256 = <b>{live.rInj}</b>
                </td>
              </tr>
              <tr>
                <td>actual(cycles)</td>
                <td>{trimNumber(live.uFbAct, 7)}</td>
                <td>{trimNumber(live.uInjAct, 7)}</td>
              </tr>
              <tr>
                <td>absolute error</td>
                <td>
                  <b>{fp(live.eFb)}</b>({trimNumber(live.eFb * G, 4)} LSB)
                </td>
                <td>
                  <b>{fp(live.eInj)}</b>({trimNumber(live.eInj * G, 4)} LSB)
                </td>
              </tr>
              <tr>
                <td>pair</td>
                <td colSpan={2}>
                  u_FB + u_INJ = {trimNumber(live.sum, 7)} → e_pair_digital ={' '}
                  <b>{trimNumber(live.pair, 4)}</b>(恆 0,mode D identity)
                  <EpistemicTag kind="EXACT" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </SectionFigure>

      <SectionFigure
        title="放大鏡:sub-LSB gap(上:整圈;下:FB / INJ 各放大至 ±1.8 LSB)"
        caption={
          <span>
            格點 = 256 個可用 code(間距 1 LSB = {formatSiTime(tVcoEx / G)});藍點 =
            ideal phase,黑短線 = 量化後實際 edge,陰影 = 表示不了的 sub-LSB gap。
            注意 FB 與 INJ 的陰影等寬、方向相反 — 這就是「等大反號」的幾何意義。
            拖動滑桿讓 ideal 靠近格點:gap → 0;靠近兩格點中點:gap → half-LSB(最壞
            情況)。
          </span>
        }
      >
        <Magnifier live={live} unit={unit} tVco={tVcoEx} />
      </SectionFigure>

      <SectionFigure
        title="VCO 追蹤 quantized common trajectory(N=3.13, nearest, mode D)"
        caption={
          <span>
            上圖:理想軌跡 x_ideal(連續斜坡)vs 量化後的共同軌跡
            u_FB_digital(階梯)— VCO/loop 鎖定的是後者。單位:<UnitSwitch />
          </span>
        }
      >
        <EChart option={optTraj} height={280} group="ch10-k" />
      </SectionFigure>

      <SectionFigure
        title="絕對誤差鏡像與 pair ≡ 0(N=3.13, nearest, mode D)"
        caption={
          <span>
            e_FB_abs(藍)與 e_INJ_abs(橘)逐拍等大反號,皆被 ±half-LSB 虛線包住
            <EpistemicTag kind="EXACT" />;綠線 e_pair_digital 恆 0。下表為前 24 拍
            逐欄數據(CSV 可與 Python golden model 比對)。單位:<UnitSwitch />
          </span>
        }
      >
        <EChart option={optErr} height={300} group="ch10-k" />
        <DebugTable
          columns={[
            { key: 'k', label: 'k' },
            { key: 'x_ideal', label: 'x_ideal', fmt: fmt6 },
            { key: 'R_FB', label: 'R_FB' },
            { key: 'u_FB_digital', label: 'u_FB_dig', fmt: fmt6 },
            { key: 'R_INJ', label: 'R_INJ' },
            { key: 'u_INJ_digital', label: 'u_INJ_dig', fmt: fmt6 },
            { key: 'e_FB_abs', label: 'e_FB_abs', fmt: fmt6 },
            { key: 'e_INJ_abs', label: 'e_INJ_abs', fmt: fmt6 },
            { key: 'e_pair_digital', label: 'e_pair', fmt: fmt6 },
          ]}
          rows={debugRows}
          maxHeight={280}
          exportName="ch10_sub_lsb.csv"
        />
      </SectionFigure>

      <SectionCode
        title="web/src/model — 真實碼節錄:qNearest、mode D reverse、e_pair"
        language="typescript"
        code={`// web/src/model/phaseMath.ts
/**
 * Half-up nearest quantizer: floor(x + 0.5).
 *
 * NEVER use a language round() (Python round is banker's rounding) —
 * qNearest(2.5) === 3 in both languages.
 */
export function qNearest(x: number): number {
  return Math.floor(x + 0.5);
}

// web/src/model/injectionScheduler.ts — mode D branch
if (cfg.arch_mode === 'D') {
  for (let k = 0; k < n; k++) {
    rInj[k] = pymod(cfg.r_zero - rFb[k], g);
  }
}

// web/src/model/injectionScheduler.ts — pairwise reverse error
export function ePair(
  uFb: ArrayLike<number>,
  uInj: ArrayLike<number>,
  rZero: number,
  g: number,
): Float64Array {
  const tmp = new Float64Array(uFb.length);
  for (let k = 0; k < uFb.length; k++) {
    tmp[k] = uFb[k] + uInj[k] - rZero / g;
  }
  return wrapCyclesArr(tmp);
}`}
      >
        <p>
          三段皆為 <code>web/src/model</code> 實際原始碼。本章互動 walkthrough 直接
          呼叫這些函數 — 頁面上沒有任何自行重算的量化數學。
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'return Math.floor(x + 0.5);',
            explain: (
              <span>
                half-up nearest:0.272 LSB 的 gap 使 86.272 → 86(向下),0.728 →
                進位到 87 的條件是 gap ≥ 0.5。禁止語言內建 round():Python 是
                banker's rounding(2.5 → 2),JS 是 half-up(2.5 → 3),跨語言
                bit-exact 會被破壞(MODEL_SPEC §2)。
              </span>
            ),
          },
          {
            code: 'rInj[k] = pymod(cfg.r_zero - rFb[k], g);',
            explain: (
              <span>
                injection 側<b>不做第二次量化</b>:R_INJ 由已量化的 R_FB 模減導出,
                (0 − 86) mod 256 = 170。兩邊共享同一次捨入決策 — 這是 pair ≡ 0 的
                全部來源。<EpistemicTag kind="EXACT" />
              </span>
            ),
          },
          {
            code: 'tmp[k] = uFb[k] + uInj[k] - rZero / g;',
            explain: (
              <span>
                pair error 的定義式(§7):0.3359375 + 0.6640625 − 0 = 1.0,整數
                cycle。
              </span>
            ),
          },
          {
            code: 'return wrapCyclesArr(tmp);',
            explain: (
              <span>
                wrapCycles(1.0) = 0:整數 cycle 差不是 timing 誤差(edge 對齊到下一個
                VCO cycle 的同一位置)。e_pair_digital = 0 的「0」是這樣算出來的。
              </span>
            ),
          },
          {
            code: 'const eFb = wrapCycles(uFbAct - u);',
            explain: (
              <span>
                (本章 walkthrough)error = actual − ideal 的符號慣例(§2):
                −0.0010625 cycle 表示實際 edge <b>早</b> 85 fs。
              </span>
            ),
          },
          {
            code: 'const uInjIdeal = wrap01(-u);',
            explain: (
              <span>
                reverse 幾何(§5.2):z0 = 0 時 u_INJ_ideal = wrap01(−u) = 0.663。
                注意 0.663 的 fine code 169.728 與 FB 的 86.272 相加恰為 256 —
                ideal 本身就互補,量化決策共享後互補性被完整保留。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            walkthrough 表:u = 0.337 時四個關鍵數字 86 / 170 / −85 fs / +85 fs 與
            MODEL_SPEC §9 完全一致;pair 恆 0,不論滑桿在哪。
          </li>
          <li>
            放大鏡:FB 陰影(gap)與 INJ 陰影永遠等寬反向;u 掃過 0 → 1 時 gap 以
            1 LSB 為週期收縮-張開,在格點中點(如 86.5/256)達到最大 half-LSB。
          </li>
          <li>
            軌跡圖:階梯(u_FB_digital)緊貼斜坡(x_ideal),垂直偏差永不超過
            half-LSB — 這條階梯才是 VCO 實際鎖定的軌跡。
          </li>
          <li>
            誤差圖:e_FB_abs 與 e_INJ_abs 互為鏡像(相加恆 0);兩者的包絡由 α 的
            fractional 走位決定,呈週期性 pattern(N=3.13 → 週期 25 拍,因 fine-code
            每拍走 0.28 LSB = 7/25;x_ideal 本身則因 α = 13/100 而是 100 拍一循環)
            <EpistemicTag kind="EXPERIMENT" />。
          </li>
          <li>
            DebugTable 的 R_FB + R_INJ 欄:每一列相加 mod 256 = 0(R_zero)—
            identity 逐拍可驗。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout
          type="warn"
          title="誤解:「pair = 0 表示 injection 完美,85 fs 誤差被 shared code 修掉了」"
        >
          <p>
            錯。pair = 0 只說明兩邊<b>相對</b>數位關係 exact reverse;對 ideal 的
            absolute error ±85 fs 依然存在(它是 quantization 的必然,受 half-LSB
            界限)。shared code 消除的是「兩邊各自捨入不同步」的相對誤差,不是
            absolute quantization error — 後者要靠更高解析度(更多 DTC bits)或
            DSM 的時間平均(Ch11)處理。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解:「shared code 能創造 sub-LSB 的 analog delay」">
          <p>
            不能。edge 只能落在 256 個格點上;0.337 cycle 這個位置物理上沒有對應的
            code。shared code 不增加解析度,只保證兩邊選同一格點。「VCO 追蹤 quantized
            common trajectory」是這件事的正面表述。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>
            量化誤差分兩層:<b>absolute</b>(每邊 ≤ half-LSB,無法用架構消除)與{' '}
            <b>relative / pair</b>(mode D 下恆 0)。設計時先把 pair 錯誤歸零(免費,
            純數位),再評估 absolute 是否需要更多 bits。
            <EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            injection 對準 quantized common trajectory 即可:loop 鎖定的就是它。追求
            「對準 ideal」而在 injection 端另外補償 sub-LSB,反而破壞 pair identity。
            <EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            half-LSB(156.25 fs / 0.703°)是所有 analog 誤差的比較基準:1° tap
            mismatch(222 fs)與 1% DTC gain(200 fs)都比它大(Ch15)—
            解析度不是目前的瓶頸。<EpistemicTag kind="INFERENCE" />
          </li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            本章為 exact digital model:DTC 視為理想(無 gain/INL/DNL)、tap 無
            mismatch、無 route skew — 這些 analog 項會破壞 e_INJ = −e_FB 的鏡像與
            analog 層的 pair = 0(見 Ch15 的 e_pair_analog)。「VCO 追蹤 quantized
            common trajectory」在此是 scheduler 層敘述:實際 VCO 對每拍 pulse 的
            response 是有限強度的 dynamics(Ch13,[APPROX]),不是瞬時貼齊。85 fs
            等檢查值取 N=3.125(T_vco = 80 ps);其他 N 下 LSB 時間值不同
            (MODEL_SPEC §11)。
          </p>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="參數 Parameters">
        <Slider
          label="u_FB_ideal(cycles)"
          value={u}
          min={0}
          max={1}
          step={0.001}
          onChange={setU}
          fmt={(v) => trimNumber(v, 6)}
        />
        <PresetButtons
          label="Preset u"
          presets={[
            { label: '0.337(§9)', onClick: () => setU(0.337) },
            { label: '0.13', onClick: () => setU(0.13) },
            { label: '86.5/256(中點)', onClick: () => setU(86.5 / 256) },
            { label: '0.5', onClick: () => setU(0.5) },
            { label: '0.663', onClick: () => setU(0.663) },
          ]}
        />
        <p style={{ fontSize: 12, opacity: 0.75 }}>
          walkthrough / 放大鏡用 N=3.125(80 ps);軌跡與誤差圖固定 N=3.13(off-grid
          才有非零量化誤差)、nearest、mode D、{N_CYCLES} cycles。
        </p>
      </ParamPanel>
    </ChapterShell>
  );
}
