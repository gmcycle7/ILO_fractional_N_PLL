/**
 * Chapter 6 — Reverse Injection Geometry 反向注入幾何
 *
 * MODEL_SPEC.md §5 全文:zero-crossing condition 出發推導
 * u_INJ_ideal = wrap01(z0 - x_nominal),雙 phase wheel 反向旋轉動畫,
 * 七類誤差分類,DSM 只能預測 deterministic 部分。
 */

import { useEffect, useMemo, useState } from 'react';
import { useChapterAlpha } from '../lib/globalParams';
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
import { makeLineOption, makeMarkLine, type LineSeriesSpec } from '../lib/chartOptions';
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
  simulate,
  fromPartial,
  xIdeal,
  uInjIdeal,
  wrap01,
  wrapCycles,
  type Quantizer,
} from '../model';

const meta = chapterById(6)!;

const N_WHEEL = 200; // wheel 動畫長度(α=0.13 時 100 拍回歸)
const N_SIM = 256; // 互動模擬長度(<= 1024)
const HALF_LSB_CYC = 1 / 512; // half-LSB, cycles

function toXY(a: ArrayLike<number>): [number, number][] {
  return Array.from(a as ArrayLike<number>, (v, i) => [i, v] as [number, number]);
}

/** 把 makeMarkLine 的結果掛到第 idx 條 series 上(display-only)。 */
function withMarkLine(
  option: ReturnType<typeof makeLineOption>,
  idx: number,
  ml: Record<string, unknown>,
): ReturnType<typeof makeLineOption> {
  const s = (option as unknown as { series?: Record<string, unknown>[] }).series;
  if (s && s[idx]) s[idx].markLine = ml;
  return option;
}

/**
 * 時域波形落點動畫的純 SVG 渲染(SSR-safe:無 window / timer 存取;
 * 動畫狀態由 Chapter06 的既有 Play/Pause/Step pattern 驅動)。
 * 所有落點數值(u_FB_digital、u_INJ_digital、x_ideal、u_INJ_ideal)皆來自 ../model。
 */
interface LandingWaveformProps {
  k: number;
  nDiv: number;
  z0: number;
  xNow: number; // x_ideal[k]
  uIdealNow: number; // u_INJ_ideal[k] = wrap01(z0 − x_ideal[k])
  uFb: number; // u_FB_digital[k] (cycles)
  uInj: number; // u_INJ_digital[k] (cycles)
  uFbHist: number[]; // 最近 ≤8 拍(含當拍)
  uInjHist: number[];
  kLo: number; // uFbHist/uInjHist 第一筆對應的 k
  tVcoS: number;
  tRefS: number;
}

function LandingWaveform(p: LandingWaveformProps) {
  const L = 48;
  const R = 706;
  const W = R - L;
  const Y0 = 78;
  const AMP = 44;
  const xOf = (tauCyc: number) => L + (tauCyc / p.nDiv) * W;
  const clampX = (px: number) => Math.min(Math.max(px, L + 16), R - 16);
  const psOf = (cyc: number) => formatSiTime(cyc * p.tVcoS);

  // VCO differential sinusoid(示意渲染):v(τ) = sin(2π(x_ideal[k] + τ − z0)),
  // rising zero crossings 落在 absolute phase 整數 + z0。
  const NPTS = 220;
  const pts: string[] = [];
  for (let i = 0; i <= NPTS; i++) {
    const tau = (p.nDiv * i) / NPTS;
    const v = Math.sin(2 * Math.PI * (p.xNow + tau - p.z0));
    pts.push(`${i === 0 ? 'M' : 'L'}${xOf(tau).toFixed(2)},${(Y0 - AMP * v).toFixed(2)}`);
  }

  // 視窗內全部 rising zero crossings:τ = wrap01(z0 − x) + j = u_INJ_ideal[k] + j
  const crossings: number[] = [];
  for (let t = p.uIdealNow; t <= p.nDiv + 1e-9; t += 1) crossings.push(t);
  // INJ pulse 對準的 target crossing(modular nearest;nearest quantizer 下即 j=0)
  const tTarget = p.uInj + wrapCycles(p.uIdealNow - p.uInj);

  // 下三列 timeline strip:絕對時間 t ∈ [k−7, k+1](單位 T_ref)
  const sX = (t: number) => L + ((t - (p.k - 7)) / 8) * W;
  const fade = (j: number) => Math.max(0.15, 1 - Math.max(0, p.k - j) * 0.12);
  const ROW_REF = 224;
  const ROW_FB = 248;
  const ROW_INJ = 272;

  const fbX = xOf(p.uFb);
  const injX = xOf(p.uInj);
  const refTicks = Array.from({ length: p.k + 2 - p.kLo }, (_, i) => p.kLo + i);

  return (
    <svg
      viewBox="0 0 720 292"
      style={{ width: '100%', height: 'auto', display: 'block' }}
      role="img"
      aria-label="單一 T_ref 視窗內的 VCO 波形與 FB/INJ edge 落點動畫"
    >
      {/* ── 上圖:第 k 個 T_ref 視窗 ── */}
      <text x={L} y={16} fontSize={11} fill="var(--fg-subtle)">
        REF edge k = {p.k}
      </text>
      <text x={R} y={16} fontSize={11} fill="var(--fg-faint)" textAnchor="end">
        REF edge k+1
      </text>
      <line x1={L} y1={22} x2={L} y2={150} stroke="var(--fg)" strokeWidth={1.6} />
      <line
        x1={R}
        y1={22}
        x2={R}
        y2={150}
        stroke="var(--border-strong)"
        strokeWidth={1.2}
        strokeDasharray="5 4"
      />
      <line x1={L} y1={Y0} x2={R} y2={Y0} stroke="var(--border)" strokeWidth={1} />
      <path d={pts.join('')} fill="none" stroke="var(--fg-subtle)" strokeWidth={1.3} />
      {crossings.map((t, i) => (
        <circle key={`zc-${i}`} cx={xOf(t)} cy={Y0} r={3} fill="var(--fg-faint)" />
      ))}
      {tTarget >= 0 && tTarget <= p.nDiv && (
        <circle
          cx={xOf(tTarget)}
          cy={Y0}
          r={7}
          fill="none"
          stroke="var(--accent-strong)"
          strokeWidth={1.8}
        />
      )}
      {/* INJ pulse:垂直虛線,穿過 target crossing */}
      <line
        x1={injX}
        y1={26}
        x2={injX}
        y2={150}
        stroke="var(--fg)"
        strokeWidth={1.4}
        strokeDasharray="4 3"
      />
      <polygon points={`${injX - 4},158 ${injX + 4},158 ${injX},150`} fill="var(--fg)" />
      {/* FB fractional delay 命令:marker row 上的 accent 刻度 */}
      <line x1={fbX} y1={134} x2={fbX} y2={150} stroke="var(--accent)" strokeWidth={2.2} />
      <line x1={L} y1={150} x2={R} y2={150} stroke="var(--border)" strokeWidth={1} />
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const px = L + (i / 5) * W;
        return (
          <g key={`tick-${i}`}>
            <line x1={px} y1={150} x2={px} y2={154} stroke="var(--fg-faint)" strokeWidth={1} />
            <text x={px} y={166} fontSize={10} fill="var(--fg-faint)" textAnchor="middle">
              {trimNumber((p.tRefS * 1e12 * i) / 5, 4)}
              {i === 5 ? ' ps' : ''}
            </text>
          </g>
        );
      })}
      <text x={clampX(fbX)} y={180} fontSize={10.5} fill="var(--accent)" textAnchor="middle">
        FB {psOf(p.uFb)}
      </text>
      <text x={clampX(injX)} y={193} fontSize={10.5} fill="var(--fg)" textAnchor="middle">
        INJ {psOf(p.uInj)}
      </text>
      <text
        x={14}
        y={Y0}
        fontSize={10}
        fill="var(--fg-faint)"
        transform={`rotate(-90 14 ${Y0})`}
        textAnchor="middle"
      >
        V_diff (a.u.)
      </text>
      {/* ── 下三列:最近 8 拍 edge 落點(絕對時間) ── */}
      <text x={L} y={210} fontSize={10} fill="var(--fg-subtle)">
        最近 8 拍 edge 落點(絕對時間,單位 T_ref;越舊越淡)
      </text>
      <rect
        x={sX(p.k)}
        y={214}
        width={sX(p.k + 1) - sX(p.k)}
        height={66}
        fill="var(--accent-soft)"
      />
      <line x1={L} y1={ROW_REF} x2={R} y2={ROW_REF} stroke="var(--border)" strokeWidth={1} />
      <line x1={L} y1={ROW_FB} x2={R} y2={ROW_FB} stroke="var(--border)" strokeWidth={1} />
      <line x1={L} y1={ROW_INJ} x2={R} y2={ROW_INJ} stroke="var(--border)" strokeWidth={1} />
      <text x={8} y={ROW_REF + 3} fontSize={10} fill="var(--fg-subtle)">
        REF
      </text>
      <text x={8} y={ROW_FB + 3} fontSize={10} fill="var(--accent)">
        FB
      </text>
      <text x={8} y={ROW_INJ + 3} fontSize={10} fill="var(--fg-subtle)">
        INJ
      </text>
      {refTicks.map((j) => (
        <line
          key={`ref-${j}`}
          x1={sX(j)}
          y1={ROW_REF - 7}
          x2={sX(j)}
          y2={ROW_REF + 7}
          stroke="var(--fg-faint)"
          strokeWidth={1.4}
          opacity={fade(j)}
        />
      ))}
      {p.uFbHist.map((u, i) => {
        const j = p.kLo + i;
        const px = sX(j + u / p.nDiv);
        return (
          <line
            key={`fb-${j}`}
            x1={px}
            y1={ROW_FB - 7}
            x2={px}
            y2={ROW_FB + 7}
            stroke="var(--accent)"
            strokeWidth={1.6}
            opacity={fade(j)}
          />
        );
      })}
      {p.uInjHist.map((u, i) => {
        const j = p.kLo + i;
        const px = sX(j + u / p.nDiv);
        return (
          <line
            key={`inj-${j}`}
            x1={px}
            y1={ROW_INJ - 7}
            x2={px}
            y2={ROW_INJ + 7}
            stroke="var(--fg)"
            strokeWidth={1.6}
            opacity={fade(j)}
          />
        );
      })}
    </svg>
  );
}

const QUANTIZER_OPTIONS: { value: Quantizer; label: string }[] = [
  { value: 'nearest', label: 'nearest' },
  { value: 'floor', label: 'floor' },
  { value: 'truncate', label: 'truncate' },
  { value: 'ef1', label: 'ef1 (DSM)' },
  { value: 'mash11', label: 'mash11 (DSM)' },
];

export default function Chapter06() {
  const [alpha, setAlpha] = useChapterAlpha();
  const [z0, setZ0] = useState(0);
  const [quantizer, setQuantizer] = useState<Quantizer>('nearest');
  const [tapMm, setTapMm] = useState(false); // 1° all-tap mismatch
  const [gainMm, setGainMm] = useState(false); // 1% INJ DTC gain
  const [sigmaVco, setSigmaVco] = useState(0); // rad, VCO white phase step
  const [wheelK, setWheelK] = useState(0);
  const [playing, setPlaying] = useState(false);
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const nDiv = 3 + alpha;

  // --- 雙 wheel 軌跡(直接取自 model 的 exact 函式) ---
  const wheel = useMemo(() => {
    const x = xIdeal(N_WHEEL, nDiv, 0);
    const u = uInjIdeal(x, z0);
    return { x, u };
  }, [nDiv, z0]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setWheelK((k) => (k + 1) % N_WHEEL), 600);
    return () => window.clearInterval(id);
  }, [playing]);

  // --- e_ZC 分解模擬:目前設定 vs 僅 quantization 的 baseline ---
  const sims = useMemo(() => {
    const mm = Array.from({ length: 8 }, () => (tapMm ? 1 / 360 : 0));
    const cur = simulate(
      fromPartial({
        n_div: nDiv,
        n_cycles: N_SIM,
        quantizer,
        z0_cycles: z0,
        r_zero: Math.round(256 * z0), // mode-D 硬體目標跟著 z0(slider step = 1/256 → 恰為整數)
        tap_mismatch_cycles: mm,
        dtc_inj_gain: gainMm ? 1.01 : 1.0,
        sigma_vco_w_rad: sigmaVco,
        inj_model: 'none',
      }),
    );
    const base = simulate(
      fromPartial({ n_div: nDiv, n_cycles: N_SIM, quantizer, z0_cycles: z0, r_zero: Math.round(256 * z0) }),
    );
    return { cur, base };
  }, [nDiv, z0, quantizer, tapMm, gainMm, sigmaVco]);

  useEffect(() => {
    setStatus('done', `Ch6: 2 configs × ${N_SIM} cycles`);
  }, [sims, setStatus]);

  const tVco = sims.cur.t_vco_s;
  const tRef = sims.cur.t_ref_s;
  const xNow = wheel.x[wheelK];
  const uNow = wheel.u[wheelK];

  // --- 時域落點動畫:與雙輪共用 wheelK(N_WHEEL <= N_SIM,可直接索引模擬輸出) ---
  const landing = useMemo(() => {
    const d = sims.cur.data;
    const k = Math.min(wheelK, N_SIM - 1);
    const kLo = Math.max(0, k - 7);
    return {
      uFb: d.u_FB_digital[k],
      uInj: d.u_INJ_digital[k],
      uFbHist: Array.from(d.u_FB_digital.subarray(kLo, k + 1)),
      uInjHist: Array.from(d.u_INJ_digital.subarray(kLo, k + 1)),
      kLo,
    };
  }, [sims, wheelK]);

  const zcOption = useMemo(() => {
    const series: LineSeriesSpec[] = [
      {
        name: 'e_ZC_hw(目前設定)',
        data: toXY(sims.cur.data.e_ZC_hw),
        color: ct.series[0],
        step: 'middle',
        width: 1.6,
      },
      {
        name: 'e_ZC_hw(僅 quantization)',
        data: toXY(sims.base.data.e_ZC_hw),
        color: ct.series[5],
        step: 'middle',
        dashed: true,
        width: 1.1,
      },
    ];
    if (sigmaVco > 0) {
      series.push({
        name: 'e_ZC_total(含 η_vco,無 injection 修正)',
        data: toXY(sims.cur.data.e_ZC_total),
        color: ct.bad,
        width: 1.0,
      });
    }
    const opt = makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: phaseAxisLabel('e_ZC', unit, tVco),
      yTickFormatter: makePhaseTickFormatter(unit, tVco),
      series,
    });
    return withMarkLine(
      opt,
      0,
      makeMarkLine([
        { y: HALF_LSB_CYC, label: '+half-LSB' },
        { y: -HALF_LSB_CYC, label: '-half-LSB' },
      ]),
    );
  }, [sims, sigmaVco, unit, tVco, ct]);

  const tableRows = useMemo(() => {
    const d = sims.cur.data;
    return Array.from({ length: 16 }, (_, i) => ({
      k: i,
      x_ideal: d.x_ideal[i],
      u_INJ_ideal: d.u_INJ_ideal[i],
      R_FB: d.R_FB[i],
      R_INJ: d.R_INJ[i],
      e_ZC_hw: d.e_ZC_hw[i],
    }));
  }, [sims]);

  const fmt6 = (v: unknown) => trimNumber(v as number, 6);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            injection pulse 要落在 VCO 波形的哪個 phase?「zero-crossing condition」的精確數學形式是什麼?
          </li>
          <li>
            為什麼 injection command 相對 reference 必須<strong>反向</strong>旋轉(每拍{' '}
            <M>{'-\\alpha'}</M>),而 VCO fractional phase 是正向(每拍 <M>{'+\\alpha'}</M>)?
          </li>
          <li>
            <M>{'u_{INJ,ideal}[k] = \\operatorname{wrap01}(z_0 - x_{nominal}[k])'}</M>{' '}
            這條核心公式如何從 zero-crossing condition 一步一步推出來?
          </li>
          <li>七類誤差(deterministic / random / quantization / tap / DTC / ref jitter / latency)如何嚴格區分?</li>
          <li>為什麼 DSM/accumulator 只能預測 deterministic 部分,而 VCO random noise 正是 injection 要修的對象?</li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          把 VCO 的 fractional phase 想成一根每拍順時針多轉 <M>{'\\alpha'}</M> 圈的指針:第 k 個
          reference edge 到來時,VCO 已走過 <M>{'3+\\alpha'}</M> 圈,留下 fractional 殘量{' '}
          <M>{'x_{ideal}[k]'}</M>。injection pulse 的任務是在 reference edge 附近「短路」VCO
          differential 節點,而短路只有落在 VCO 波形的 zero crossing(校正後的目標 phase 記為{' '}
          <M>{'z_0'}</M>)才不會抽走能量(Ch14)。
        </p>
        <p>
          從 reference 的座標系看:VCO 的 zero crossing 每拍往「晚」漂移 <M>{'+\\alpha'}</M> cycle,
          所以要命中它,injection delay(tap + DTC 合成的 <M>{'u_{INJ}'}</M>)每拍必須往「早」退{' '}
          <M>{'\\alpha'}</M> cycle —— 兩根指針以相同速率、相反方向旋轉,任意時刻兩角相加恆等於{' '}
          <M>{'z_0'}</M>(mod 1)。這就是「reverse injection」的全部幾何內容。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>
          注意「可預測」與「不可預測」的分工:fractional 漂移 <M>{'+\\alpha'}</M> 是 deterministic
          的,digital scheduler(master accumulator)可以精確倒轉它;VCO 自己的 random phase noise{' '}
          <M>{'\\eta_{vco}'}</M> 沒有任何 digital 電路能預知 —— injection 的物理價值正是把這個
          random 分量拉回 zero crossing。scheduler 的職責是「不要瞄歪」,injection 的職責是「把亂走的拉回來」。
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>
          <strong>Step 1 — 第 k 拍的 VCO 實際 phase(MODEL_SPEC §5.1)。</strong>reference edge
          到來時,VCO base phase 分成 deterministic 與 random 兩部分:
        </p>
        <MathBlock>{'x_{vco,actual}[k] = x_{nominal}[k] + \\eta_{vco}[k]'}</MathBlock>
        <p>
          其中 <M>{'x_{nominal}[k]'}</M> 是 deterministic fractional trajectory(理想情況即{' '}
          <M>{'x_{ideal}[k]'}</M>)<EpistemicTag kind="EXACT" />;<M>{'\\eta_{vco}[k]'}</M> 是 VCO
          noise / PLL residual / detuning 造成的 random deviation(cycles)。
          <EpistemicTag kind="ASSUMPTION" />
        </p>
        <p>
          <strong>Step 2 — actuator 幾何。</strong>第 j 個 injection tap 與 injection DTC delay:
        </p>
        <MathBlock>
          {'\\varphi_{tap}[j] = j/8, \\qquad \\varphi_{tap,actual}[j] = j/8 + \\delta_{tap}[j], \\qquad d_{INJ}[k] = \\tau_{INJ}[k]/T_{vco}'}
        </MathBlock>
        <p>
          <strong>Step 3 — zero-crossing alignment error 的定義。</strong>pulse 實際落點與想要的
          zero crossing <M>{'z_0'}</M> 之差(wrap 到 <M>{'(-\\tfrac12, \\tfrac12]'}</M>):
        </p>
        <MathBlock>
          {'e_{ZC}[k] = \\operatorname{wrapCycles}\\big(x_{vco,actual}[k] + \\varphi_{tap,actual}[j[k]] + d_{INJ}[k] - z_0\\big), \\qquad \\theta_{ZC}[k] = 2\\pi\\, e_{ZC}[k]'}
        </MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> 符號慣例依 §2:phase 增加 = edge 較晚;error = actual −
          ideal;delay 為正。
        </p>
        <p>
          <strong>Step 4 — 令 deterministic 部分歸零,解出 scheduler 條件。</strong>把可預測的部分(
          <M>{'\\eta_{vco} = 0'}</M>、<M>{'\\delta_{tap} = 0'}</M>、DTC exact)代入並要求{' '}
          <M>{'e_{ZC} = 0'}</M>;wrapCycles 為零等價於引數為整數:
        </p>
        <MathBlock>
          {'x_{nominal}[k] + \\varphi_{tap}[j[k]] + d_{INJ,ideal}[k] - z_0 \\in \\mathbb{Z}'}
        </MathBlock>
        <MathBlock>
          {'\\Rightarrow\\; \\varphi_{tap}[j[k]] + d_{INJ,ideal}[k] = z_0 - x_{nominal}[k] + m, \\qquad m \\in \\mathbb{Z}'}
        </MathBlock>
        <p>
          actuator 的可達範圍是一圈之內(fractional 表示 <M>{'\\varphi_{tap} + d_{INJ} \\in [0, 1)'}</M>),
          因此整數 <M>{'m'}</M> 唯一地被「落在 <M>{'[0,1)'}</M>」這個條件選定 —— 這正是{' '}
          <M>{'\\operatorname{wrap01}'}</M> 的定義:
        </p>
        <MathBlock>
          {'\\varphi_{tap}[j[k]] + d_{INJ,ideal}[k] = \\operatorname{wrap01}\\big(z_0 - x_{nominal}[k]\\big)'}
        </MathBlock>
        <p>
          <strong>Step 5 — 理想 normalized injection command。</strong>左邊整體就是 injection
          路徑要合成的 fractional 命令:
        </p>
        <MathBlock>
          {'u_{INJ,ideal}[k] = \\operatorname{wrap01}\\big(z_0 - x_{nominal}[k]\\big), \\qquad z_0 = 0 \\;\\Rightarrow\\; u_{INJ,ideal}[k] = \\operatorname{wrap01}\\big(-x_{nominal}[k]\\big)'}
        </MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> <strong>Step 6 — 反向旋轉由此自動出現。</strong>由{' '}
          <M>{'x_{nominal}[k+1] = \\operatorname{wrap01}(x_{nominal}[k] + \\alpha)'}</M>:
        </p>
        <MathBlock>
          {'u_{INJ,ideal}[k+1] = \\operatorname{wrap01}\\big(z_0 - x[k] - \\alpha\\big) = \\operatorname{wrap01}\\big(u_{INJ,ideal}[k] - \\alpha\\big)'}
        </MathBlock>
        <p>
          VCO 每拍 <M>{'+\\alpha'}</M>,injection command 每拍 <M>{'-\\alpha'}</M>:這就是 reverse
          injection 的物理來源。<EpistemicTag kind="EXACT" />
        </p>
        <p>
          <strong>七類必須嚴格區分的誤差(MODEL_SPEC §5.3)</strong>,以及 digital 端能否預測:
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>誤差類別</th>
                <th>來源</th>
                <th>DSM/accumulator 可否預測</th>
                <th>標記</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>1</td>
                <td>deterministic fractional phase</td>
                <td><M>{'k\\alpha'}</M> 累積(§3)</td>
                <td><strong>可</strong> —— scheduler 的本職</td>
                <td><EpistemicTag kind="EXACT" /></td>
              </tr>
              <tr>
                <td>2</td>
                <td>VCO random phase noise <M>{'\\eta_{vco}'}</M></td>
                <td>VCO 本身 / PLL residual / detuning</td>
                <td><strong>不可</strong> —— 正是 injection 要修的對象</td>
                <td><EpistemicTag kind="ASSUMPTION" /></td>
              </tr>
              <tr>
                <td>3</td>
                <td>scheduler quantization error</td>
                <td>G=256 有限解析度(§6)</td>
                <td>可(給定 quantizer state 完全 deterministic)</td>
                <td><EpistemicTag kind="EXACT" /></td>
              </tr>
              <tr>
                <td>4</td>
                <td>injection tap mismatch <M>{'\\delta_{tap}[j]'}</M></td>
                <td>analog 8-phase 產生電路</td>
                <td>不可(可校正,不可預測)</td>
                <td><EpistemicTag kind="ASSUMPTION" /></td>
              </tr>
              <tr>
                <td>5</td>
                <td>DTC error(gain/offset/INL/DNL)</td>
                <td>analog DTC(§10、§11)</td>
                <td>不可(可校正)</td>
                <td><EpistemicTag kind="ASSUMPTION" /></td>
              </tr>
              <tr>
                <td>6</td>
                <td>reference jitter</td>
                <td>reference 路徑雜訊</td>
                <td>不可</td>
                <td><EpistemicTag kind="ASSUMPTION" /></td>
              </tr>
              <tr>
                <td>7</td>
                <td>digital latency error</td>
                <td>pipeline delay L(§13)</td>
                <td>可 —— 用 look-ahead 消除,否則 <M>{'\\operatorname{wrapCycles}(-L\\alpha)'}</M></td>
                <td><EpistemicTag kind="EXACT" /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          結論:DSM(或任何 digital 預測器)只涵蓋第 1、3、7 類 —— 也就是 deterministic 部分;
          第 2 類是 injection 存在的理由;第 4、5、6 類靠校正與電路設計,digital 無法事先算出。
          <EpistemicTag kind="EXACT" />
        </p>
      </SectionMath>

      <SectionExample>
        <p>
          取 <M>{'N = 3.13'}</M>(<M>{'\\alpha = 0.13'}</M>)、<M>{'z_0 = 0'}</M>,手算前五拍:
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>k</th>
                <th><M>{'x_{ideal}[k]'}</M></th>
                <th><M>{'u_{INJ,ideal}[k] = \\operatorname{wrap01}(-x)'}</M></th>
                <th><M>{'\\operatorname{wrap01}(x+u)'}</M></th>
              </tr>
            </thead>
            <tbody>
              <tr><td>0</td><td>0.00</td><td>0.00</td><td>0</td></tr>
              <tr><td>1</td><td>0.13</td><td>0.87</td><td>0</td></tr>
              <tr><td>2</td><td>0.26</td><td>0.74</td><td>0</td></tr>
              <tr><td>3</td><td>0.39</td><td>0.61</td><td>0</td></tr>
              <tr><td>4</td><td>0.52</td><td>0.48</td><td>0</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          驗算 k=1:<M>{'\\operatorname{wrap01}(0 - 0.13) = -0.13 - \\lfloor -0.13 \\rfloor = -0.13 + 1 = 0.87'}</M>;
          且 <M>{'0.13 + 0.87 = 1.00 \\Rightarrow \\operatorname{wrap01} = 0 = z_0'}</M>。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>
          再往量化走一步(Ch5/Ch7 詳談):<M>{'u = 0.87'}</M> 的 ideal fine code 為{' '}
          <M>{'256 \\times 0.87 = 222.72'}</M>,nearest 得 <M>{'R_{INJ} = 223'}</M>,實際{' '}
          <M>{'u = 223/256 = 0.87109375'}</M>,quantization error <M>{'+0.28'}</M> LSB{' '}
          <M>{'= +0.00109375'}</M> cycle(= {formatPhase(0.00109375, unit, tVco)}),仍在 half-LSB
          範圍內。<EpistemicTag kind="EXACT" />
        </p>
      </SectionExample>

      <SectionFigure
        title="雙反向旋轉 phase wheel:x_ideal 正轉 +α/拍,u_INJ_ideal 反轉 −α/拍"
        caption={
          <span>
            左輪:VCO fractional phase <M>{'x_{ideal}[k]'}</M>(順時針 = phase 增加 = edge 較晚);
            右輪:injection command <M>{'u_{INJ,ideal}[k]'}</M>,逐拍逆時針退 <M>{'\\alpha'}</M>。
            兩輪角度相加恆為 <M>{'z_0'}</M>(讀值列即時驗證)。角度單位 cycles(一圈 = 1 cycle =
            360°);顯示單位:<UnitSwitch />
          </span>
        }
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <PhaseWheel
            size={240}
            animateToMarker
            title={<span>x_ideal[k]:每拍 +{trimNumber(alpha, 4)} cycle(正轉)</span>}
            markers={[
              { angleCycles: xNow, label: 'x', color: 'var(--accent)' },
              { angleCycles: z0, label: 'z0', color: 'var(--fg-faint)', r: 1.0 },
            ]}
            arcs={[
              { fromCycles: xNow - alpha, toCycles: xNow, color: 'var(--accent)', r: 0.62 },
            ]}
          />
          <PhaseWheel
            size={240}
            animateToMarker
            title={<span>u_INJ_ideal[k]:每拍 −{trimNumber(alpha, 4)} cycle(反轉)</span>}
            markers={[
              { angleCycles: uNow, label: 'u_INJ', color: 'var(--fg)' },
              { angleCycles: z0, label: 'z0', color: 'var(--fg-faint)', r: 1.0 },
            ]}
            arcs={[
              { fromCycles: uNow, toCycles: uNow + alpha, color: 'var(--fg-subtle)', r: 0.62 },
            ]}
          />
          <div style={{ minWidth: 240, fontSize: '0.9rem', lineHeight: 1.9 }}>
            <div>
              k = <strong>{wheelK}</strong>
            </div>
            <div>
              x_ideal[k] = <strong>{formatPhase(xNow, unit, tVco)}</strong>
            </div>
            <div>
              u_INJ_ideal[k] = <strong>{formatPhase(uNow, unit, tVco)}</strong>
            </div>
            <div>
              wrap01(x + u) = <strong>{formatPhase(wrap01(xNow + uNow), unit, tVco)}</strong>{' '}
              (= z<sub>0</sub>,恆成立)
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button type="button" className="preset-button" onClick={() => setPlaying((p) => !p)}>
                {playing ? '暫停' : '播放'}
              </button>
              <button
                type="button"
                className="preset-button"
                onClick={() => {
                  setPlaying(false);
                  setWheelK((k) => (k + 1) % N_WHEEL);
                }}
              >
                步進 +1
              </button>
              <button
                type="button"
                className="preset-button"
                onClick={() => {
                  setPlaying(false);
                  setWheelK(0);
                }}
              >
                重設 k=0
              </button>
            </div>
          </div>
        </div>
      </SectionFigure>

      <SectionFigure
        title="時域波形落點動畫:單一 T_ref 視窗內,INJ pulse 逐拍追著 zero crossing 跑"
        caption={
          <span>
            上圖 x 軸:第 k 個 reference 視窗內的時間 τ(單位 ps;τ=0 為第 k 個 ref edge,右緣虛線為第
            k+1 個),y 軸:VCO differential 波形(任意振幅)。正弦波形只是 phase 的示意渲染 —— model
            是 phase-domain timing model,不含波形形狀 <EpistemicTag kind="ASSUMPTION" />。灰點:視窗內
            全部 rising zero crossings(τ = <M>{'\\operatorname{wrap01}(z_0 - x_{ideal}[k]) + j'}</M>,
            即 absolute phase 整數 + z<sub>0</sub>);accent 圓圈:INJ pulse 對準的 target crossing;
            垂直虛線:injection pulse,位置 <M>{'u_{INJ,digital}[k] \\cdot T_{vco}'}</M>;accent 刻度:
            feedback 路徑的 fractional delay 命令 <M>{'u_{FB,digital}[k] \\cdot T_{vco}'}</M>(其實體
            anchor 是 VCO integer-cycle boundary,鎖定時 divider edge 本身與 ref edge 對齊;此處與
            u_INJ 畫在同一軸,以顯示 +α/−α 鏡像)。所有落點數值皆取自 simulate() 輸出{' '}
            <EpistemicTag kind="EXACT" />。下三列:最近 8 拍 REF/FB/INJ edge 的絕對時間(x 軸單位
            T_ref,越舊越淡)。例:N=3.13 時 T_vco ≈ 79.87 ps,每拍漂移 α·T_vco ≈ 10.38 ps。本圖時間
            軸固定以 ps 顯示,不隨 UnitSwitch 切換。
          </span>
        }
      >
        <LandingWaveform
          k={wheelK}
          nDiv={nDiv}
          z0={z0}
          xNow={xNow}
          uIdealNow={uNow}
          uFb={landing.uFb}
          uInj={landing.uInj}
          uFbHist={landing.uFbHist}
          uInjHist={landing.uInjHist}
          kLo={landing.kLo}
          tVcoS={tVco}
          tRefS={tRef}
        />
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            alignItems: 'center',
            marginTop: 8,
          }}
        >
          <div style={{ minWidth: 260, fontSize: '0.9rem', lineHeight: 1.9 }}>
            <div>
              k = <strong>{wheelK}</strong>,N = {trimNumber(nDiv, 6)},T_vco ={' '}
              {formatSiTime(tVco)}
            </div>
            <div>
              u_FB_digital[k] = {trimNumber(landing.uFb, 6)} cyc ={' '}
              <strong>{formatSiTime(landing.uFb * tVco)}</strong>
            </div>
            <div>
              u_INJ_digital[k] = {trimNumber(landing.uInj, 6)} cyc ={' '}
              <strong>{formatSiTime(landing.uInj * tVco)}</strong>
            </div>
            <div>
              每拍漂移:INJ pulse 與 target crossing{' '}
              <strong>
                {alpha === 0 ? '0(N 為整數,無漂移)' : `−α·T_vco = −${formatSiTime(alpha * tVco)}`}
              </strong>
              (往早);FB 刻度{' '}
              <strong>{alpha === 0 ? '0' : `+α·T_vco = +${formatSiTime(alpha * tVco)}`}</strong>
              (往晚)
            </div>
          </div>
          <div style={{ flex: '1 1 260px', maxWidth: 420 }}>
            <Slider
              label="k"
              value={wheelK}
              min={0}
              max={N_WHEEL - 1}
              step={1}
              onChange={(v) => {
                setPlaying(false);
                setWheelK(Math.round(v) % N_WHEEL);
              }}
              fmt={(v) => String(Math.round(v))}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button type="button" className="preset-button" onClick={() => setPlaying((p) => !p)}>
                {playing ? '暫停' : '播放'}
              </button>
              <button
                type="button"
                className="preset-button"
                onClick={() => {
                  setPlaying(false);
                  setWheelK((k) => (k + 1) % N_WHEEL);
                }}
              >
                步進 +1
              </button>
              <button
                type="button"
                className="preset-button"
                onClick={() => {
                  setPlaying(false);
                  setWheelK(0);
                }}
              >
                重設 k=0
              </button>
            </div>
            <p style={{ fontSize: '0.82rem', color: 'var(--fg-subtle)', marginTop: 8 }}>
              與上方雙輪共用同一個 k:播放/步進時兩個圖同步前進。
            </p>
          </div>
        </div>
      </SectionFigure>

      <SectionFigure
        title="e_ZC 公式分解:deterministic scheduling error 與 random η_vco"
        caption={
          <span>
            x 軸:reference cycle k(sample rate = f_ref,§17)。實線:目前設定的 deterministic
            hardware error <M>{'e_{ZC,hw}'}</M>;虛線:僅 quantization 的 baseline;兩者之差即
            tap/DTC 等 analog 項的貢獻。開啟 σ_vco 後的第三條曲線是含 random noise、且無 injection
            修正(inj_model = none)時的 <M>{'e_{ZC,total}'}</M> —— DSM 對它無能為力。y 軸單位隨{' '}
            <UnitSwitch /> 切換。
          </span>
        }
      >
        <EChart option={zcOption} height={320} group="ch6" />
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model/injectionScheduler.ts · simulate.ts(真實節錄)"
        code={`// injectionScheduler.ts — 理想 normalized injection command (MODEL_SPEC §5.2)
/** Ideal normalized injection command: wrap01(z0 - x_nominal). */
export function uInjIdeal(xNominal: ArrayLike<number>, z0: number): Float64Array {
  const out = new Float64Array(xNominal.length);
  for (let k = 0; k < xNominal.length; k++) {
    out[k] = wrap01(z0 - xNominal[k]);
  }
  return out;
}

// injectionScheduler.ts — analog 層的實際 injection 落點 (tap + DTC + route)
uInjAnalog[k] = tapTbl[jInj[k]] + dtcInj.delayCycles(cInj[k]) + cfg.route_inj_cycles;

// simulate.ts — deterministic hardware zero-crossing error (MODEL_SPEC §5.1)
const eZcHw = new Float64Array(n);
for (let k = 0; k < n; k++) {
  eZcHw[k] = wrapCycles(xId[k] + uInjAn[k] - cfg.z0_cycles);
}`}
      >
        <p>
          注意 <M>{'\\eta_{vco}'}</M> 不在 <code>e_ZC_hw</code> 裡:random noise 於{' '}
          <code>runDynamics()</code>(§14)另行注入 <M>{'\\theta'}</M> 迴圈,對應{' '}
          <code>e_ZC_total</code>(= e_inj / 2π)。deterministic 與 random 在 code 裡就是分開的兩層。
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'out[k] = wrap01(z0 - xNominal[k]);',
            explain: (
              <span>
                整章推導濃縮成一行:reverse 不是「把 DTC 反接」,而是命令值取 <M>{'z_0 - x'}</M> 再
                wrap 回 <M>{'[0,1)'}</M>。<M>{'x'}</M> 每拍 +α,這個值就自動每拍 −α。
              </span>
            ),
          },
          {
            code: 'uInjAnalog[k] = tapTbl[jInj[k]] + dtcInj.delayCycles(cInj[k]) + cfg.route_inj_cycles;',
            explain: (
              <span>
                actuator 合成:粗調 tap(第 4 類誤差藏在 <code>tapTbl</code>)、細調 DTC(第 5 類在{' '}
                <code>delayCycles</code>)、固定 route skew。三項都是 delay,依 §2 慣例為正的 phase
                增量。
              </span>
            ),
          },
          {
            code: 'eZcHw[k] = wrapCycles(xId[k] + uInjAn[k] - cfg.z0_cycles);',
            explain: (
              <span>
                §5.1 的 <M>{'e_{ZC}'}</M> 公式在 deterministic 層的實作:VCO nominal phase + 實際
                injection delay − 目標 <M>{'z_0'}</M>,wrap 到 <M>{'(-\\tfrac12,\\tfrac12]'}</M>。
                理想 mapping 下此值為 0;nearest quantization 讓它在 ±half-LSB 內跳動
                (floor/truncate 為單邊 [0, 1 LSB);ef1/mash11 可達數個 half-LSB)。
              </span>
            ),
          },
          {
            code: "sigma_vco_w_rad: sigmaVco, inj_model: 'none'",
            explain: (
              <span>
                本章互動圖的設定:打開 VCO white noise 但關掉 injection 修正,讓 <M>{'\\eta_{vco}'}</M>{' '}
                以 random walk 形式累積 —— 示範「digital 預測不了、只有 injection 能修」的那一類誤差
                (修正動態見 Ch13)。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            <strong>雙輪動畫</strong>:兩根指針對 <M>{'z_0/2'}</M> 軸鏡像對稱(等價於兩角相加恆為{' '}
            <M>{'z_0'}</M>;預設 <M>{'z_0=0'}</M> 時鏡射軸即 12 點鐘方向);按「步進 +1」左輪順時針
            +α、右輪逆時針 −α。α=0.13 時第 100 拍兩輪同時回到起點(0.13 的循環長度)。讀值列的{' '}
            <M>{'\\operatorname{wrap01}(x+u)'}</M> 永遠等於 <M>{'z_0'}</M> —— 這是 identity,不是巧合。
          </li>
          <li>
            <strong>時域落點動畫</strong>:按播放,INJ pulse(垂直虛線)與它對準的 target
            crossing(accent 圓圈)黏在一起、每拍一同往「早」移 α·T_vco(N=3.13 時 ≈ 10.38 ps,
            N=3.25 時 ≈ 19.23 ps;N=3.000 時全部靜止),而 FB 刻度反向每拍往「晚」移 α·T_vco ——
            雙輪的 +α/−α 鏡像直接呈現在時間軸上。u_INJ 從近 0 wrap 回近 1 的那一拍,正是 divider
            多吞一個 VCO cycle(n_int = 4)的時刻。nearest quantizer 下 pulse 對 crossing 的偏差
            ≤ half-LSB(sub-ps,在 250 ps 視窗尺度下不可見)—— 其實際大小要看下方 e_ZC 分解圖。
          </li>
          <li>
            <strong>分解圖(全 ideal analog,quantizer = nearest)</strong>:實線與虛線重合,且被
            ±half-LSB({formatPhase(HALF_LSB_CYC, unit, tVco)})參考線夾住 —— 只剩第 3 類
            quantization error。切 floor/truncate 時誤差變單邊 [0, 1 LSB);ef1/mash11 的瞬時誤差
            可達數個 half-LSB(被 noise-shape,不是被夾住)。
          </li>
          <li>
            <strong>開 1° tap mismatch 或 1% DTC gain</strong>:實線離開虛線,出現超出 half-LSB
            的規律圖樣(週期跟著 fractional sequence)—— 第 4、5 類誤差,digital 預測不了,只能校正
            (Ch7 calibrated mapping、Ch15)。
          </li>
          <li>
            <strong>拉大 σ_vco</strong>:第三條 <M>{'e_{ZC,total}'}</M> 曲線相對平坦的 deterministic
            誤差呈 random walk 漂走(inj_model = none,沒有任何修正)—— 第 2 類誤差的樣貌。把它拉
            回來是 injection dynamics 的工作(Ch13),不是 scheduler 的。
          </li>
          <li>
            切 quantizer 到 ef1/mash11:<M>{'e_{ZC,hw}'}</M> 的圖樣改變(誤差被 noise-shape)、瞬時值
            超出 ±half-LSB 參考線(mash11 在 N=3.001 時至 ~3.7× half-LSB),但仍是
            deterministic —— 給定 state 完全可重現。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解一:「DSM 已經知道 fractional phase,所以 injection 是多餘的」">
          <p>
            錯。DSM/accumulator 知道的是<strong>第 1 類</strong>(deterministic trajectory)——
            它只能保證 pulse「瞄得準」。VCO 的 random noise <M>{'\\eta_{vco}'}</M>(第 2 類)在
            pulse 發出之前沒有任何 digital 電路能得知;把 VCO 從 <M>{'\\eta_{vco}'}</M> 拉回 zero
            crossing 是 injection 的物理功能,兩者是互補而非替代。
            <EpistemicTag kind="EXACT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解二:「reverse 就是把某個訊號取負號 / 硬體反接」">
          <p>
            錯。reverse 是 modular 幾何:<M>{'u_{INJ,ideal} = \\operatorname{wrap01}(z_0 - x)'}</M>。
            它不是 <M>{'-x'}</M>(delay 不能為負,§2),而是「往一圈內的補角走」。z<sub>0</sub>=0、
            x=0.13 時命令是 0.87 cycle 的正 delay,不是 −0.13。
            <EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>
            injection command 必須由與 feedback <strong>同一份</strong> phase state 導出(
            <M>{'u_{INJ,ideal} = \\operatorname{wrap01}(z_0 - x_{nominal})'}</M>),每拍反向旋轉{' '}
            <M>{'-\\alpha'}</M>;任何獨立重算 fractional phase 的實作都會引入兩邊不一致(Ch8)。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            設計檢討時先問「這個誤差屬於七類中的哪一類」:第 1、3、7 類用 digital(accumulator、
            look-ahead)解;第 4、5 類用校正解(Ch7、Ch15);第 2、6 類是 injection 與電路雜訊設計的
            範疇。用錯工具(例如想用 DSM 修 tap mismatch)不會有效果。
            <EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            <M>{'z_0'}</M> 是單一全域校正參數:它平移所有拍的目標 zero crossing,但不改變反向旋轉
            結構(兩輪讀值和恆為 <M>{'z_0'}</M>)。<EpistemicTag kind="EXACT" />
          </li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            本章的 <M>{'e_{ZC,hw}'}</M> 是 <strong>exact digital timing model</strong>:它描述
            scheduler + behavioral tap/DTC 的 deterministic 對位誤差,不含 pulse 與 VCO 的實際交互
            作用(那是 Ch13 的 injection dynamics,標 APPROX)。<M>{'\\eta_{vco}'}</M> 以 §12 固定
            seed 的 Gaussian stream 建模(ASSUMPTION),不是量測到的 VCO noise profile;tap/DTC
            mismatch 為 behavioral 模型(§10)。行為級結果不等同 silicon(§20)。
          </p>
        </Callout>
      </SectionLimitation>

      <DebugTable
        columns={[
          { key: 'k', label: 'k' },
          { key: 'x_ideal', label: 'x_ideal', fmt: fmt6 },
          { key: 'u_INJ_ideal', label: 'u_INJ_ideal', fmt: fmt6 },
          { key: 'R_FB', label: 'R_FB' },
          { key: 'R_INJ', label: 'R_INJ' },
          { key: 'e_ZC_hw', label: 'e_ZC_hw (cyc)', fmt: fmt6 },
        ]}
        rows={tableRows}
        exportName="ch6_reverse_geometry.csv"
      />

      <ParamPanel title="Ch6 參數">
        <Slider
          label="α (fractional)"
          value={alpha}
          min={0}
          max={0.25}
          step={0.0005}
          onChange={(v) => setAlpha(v)}
        />
        <PresetButtons
          label="Preset N"
          presets={[3.0, 3.125, 3.13, 3.1375, 3.25].map((n) => ({
            label: n.toFixed(4),
            onClick: () => setAlpha(Number((n - 3).toFixed(4))),
          }))}
        />
        <Slider label="z0 (cycles)" value={z0} min={0} max={0.5} step={1 / 256} onChange={setZ0} />
        <SelectControl<Quantizer>
          label="Quantizer"
          value={quantizer}
          options={QUANTIZER_OPTIONS}
          onChange={setQuantizer}
        />
        <Toggle label="1° tap mismatch(全部 taps)" checked={tapMm} onChange={setTapMm} />
        <Toggle label="1% INJ DTC gain error" checked={gainMm} onChange={setGainMm} />
        <Slider
          label="σ_vco_w"
          value={sigmaVco}
          min={0}
          max={0.3}
          step={0.01}
          unit="rad"
          onChange={setSigmaVco}
        />
      </ParamPanel>
    </ChapterShell>
  );
}
