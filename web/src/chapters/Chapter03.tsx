/**
 * Chapter 3 — Ideal Fractional Phase Trajectory 理想分數相位軌跡
 *
 * Content contract: CHAPTER_GUIDE.md Ch3; math contract MODEL_SPEC.md §3.
 * Figures: #2 animated phase wheel (+alpha per cycle, play/pause/step),
 * #2b gear/odometer animation (3 full turns + alpha per tick, n_int counter),
 * #5 absolute coordinate staircase, #6 fractional accumulator plot,
 * cycle-by-cycle table. 5 preset N values.
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
import { ParamPanel, Slider, PresetButtons } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import PhaseWheel from '../components/PhaseWheel';
import DebugTable from '../components/DebugTable';
import { makeLineOption } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { formatPhase, phaseAxisLabel, makePhaseTickFormatter, trimNumber } from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import { simulate, fromPartial, configTVcoS, configAlpha, qFloor } from '../model';

const meta = chapterById(3)!;

const N_CYCLES = 128; // interactive figures stay <= 1024 cycles
const STAIR_CYCLES = 24;

// ---- figure #2b (gear / odometer) geometry + timing ----
const GEAR_CYCLES = 32; // beats shown by the odometer strip
const GEAR_PERIOD_MS = 900; // Play cadence: one reference beat
const GEAR_SPIN_MS = 520; // dial spin duration (ease-out), < GEAR_PERIOD_MS
const CLK_PITCH = 9; // px per reference period in the REF clock SVG
const CLK_X0 = 6;
const CLK_HI = 18;
const CLK_LO = 36;
const CLK_W = CLK_X0 + GEAR_CYCLES * CLK_PITCH + 6;
const DIAL_VB = 200;
const DIAL_C = DIAL_VB / 2;
const DIAL_R = 72;

/** REF clock square wave path — display packaging only, no math */
function refClockPath(): string {
  const parts: string[] = [`M ${CLK_X0 - CLK_PITCH / 2} ${CLK_LO}`];
  for (let i = 0; i < GEAR_CYCLES; i++) {
    const x = CLK_X0 + i * CLK_PITCH;
    parts.push(`L ${x} ${CLK_LO}`, `L ${x} ${CLK_HI}`);
    parts.push(`L ${x + CLK_PITCH / 2} ${CLK_HI}`, `L ${x + CLK_PITCH / 2} ${CLK_LO}`);
  }
  return parts.join(' ');
}

/** dial angle (cycles) -> point; 0 cycles at 12 o'clock, clockwise positive */
function dialPt(angleCycles: number, r: number): { x: number; y: number } {
  const a = 2 * Math.PI * angleCycles;
  return { x: DIAL_C + r * Math.sin(a), y: DIAL_C - r * Math.cos(a) };
}

const DIAL_LABELS = ['0', '1/8', '1/4', '3/8', '1/2', '5/8', '3/4', '7/8'];

/** odometer 讀數格(純顯示;數值一律由 model 算好後傳入) */
function OdoCell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-alt)',
        padding: '8px 14px',
        minWidth: 160,
      }}
    >
      <div style={{ fontSize: '0.75rem', color: 'var(--fg-subtle)' }}>{label}</div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '1.35rem',
          lineHeight: 1.5,
          color: accent ? 'var(--accent)' : 'var(--fg)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

const PRESET_N: { label: string; value: number }[] = [
  { label: '3.000', value: 3.0 },
  { label: '3.125', value: 3.125 },
  { label: '3.130', value: 3.13 },
  { label: '3.1375', value: 3.1375 },
  { label: '3.250', value: 3.25 },
];

/** pack (k, y) pairs for chart series — display packaging only, no math */
function pairs(ks: Float64Array, ys: Float64Array, count?: number): [number, number][] {
  const n = count === undefined ? ys.length : Math.min(count, ys.length);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    out.push([ks[i], ys[i]]);
  }
  return out;
}

const CODE_EXCERPT = `// web/src/model/phaseAccumulator.ts  (MODEL_SPEC §3)
/**
 * Absolute VCO phase coordinate at reference edge k (cycles).
 *
 * s_ideal[k] = s0 + k * N   (multiplication, not accumulation)
 */
export function sIdeal(nCycles: number, nDiv: number, s0: number = 0.0): Float64Array {
  const out = new Float64Array(nCycles);
  for (let k = 0; k < nCycles; k++) {
    out[k] = s0 + k * nDiv;
  }
  return out;
}

/** Fractional phase state x_ideal[k] = wrap01(s_ideal[k]). */
export function xIdeal(nCycles: number, nDiv: number, s0: number = 0.0): Float64Array {
  return wrap01Arr(sIdeal(nCycles, nDiv, s0));
}

// web/src/model/phaseMath.ts  (MODEL_SPEC §2)
/** x - floor(x)  ->  [0, 1). */
export function wrap01(x: number): number {
  return x - Math.floor(x);
}`;

export default function Chapter03() {
  const [alpha, setAlpha] = useChapterAlpha();
  const [wheelK, setWheelK] = useState(0);
  const [playing, setPlaying] = useState(false);
  // figure #2b: { k, snap } — snap = true 時不做 CSS transition(reset / 回捲那拍)
  const [gear, setGear] = useState<{ k: number; snap: boolean }>({ k: 0, snap: true });
  const [gearPlaying, setGearPlaying] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const cfg = useMemo(
    () => fromPartial({ n_div: 3 + alpha, n_cycles: N_CYCLES }),
    [alpha],
  );
  const result = useMemo(() => simulate(cfg), [cfg]);
  const tVco = configTVcoS(cfg);
  const alphaEff = configAlpha(cfg);

  useEffect(() => {
    setStatus('done', `N = ${trimNumber(3 + alpha, 6)}, ${N_CYCLES} cycles`);
  }, [alpha, setStatus]);

  // ---- figure #2: animated phase wheel state ----
  useEffect(() => {
    if (!playing) return undefined;
    const id = window.setInterval(() => {
      setWheelK((p) => (p + 1) % N_CYCLES);
    }, 700);
    return () => window.clearInterval(id);
  }, [playing]);

  // ---- figure #2b: gear / odometer animation state ----
  useEffect(() => {
    if (!gearPlaying) return undefined;
    const id = window.setInterval(() => {
      setGear((p) => {
        const next = p.k + 1;
        return next >= GEAR_CYCLES ? { k: 0, snap: true } : { k: next, snap: false };
      });
    }, GEAR_PERIOD_MS);
    return () => window.clearInterval(id);
  }, [gearPlaying]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduceMotion(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const sArr = result.data.s_ideal;
  const xArr = result.data.x_ideal;
  const xNow = xArr[wheelK];

  const wheelMarkers: { angleCycles: number; label?: string; color?: string; r?: number }[] = [
    { angleCycles: xNow, label: `x[${wheelK}]`, r: 0.8 },
  ];
  if (wheelK > 0) {
    wheelMarkers.push({
      angleCycles: xArr[wheelK - 1],
      label: `x[${wheelK - 1}]`,
      color: 'var(--fg-faint)',
      r: 0.58,
    });
  }

  // ---- figure #2b: odometer = qFloor(s_ideal) 與其每拍增量 n_int ----
  const gearData = useMemo(() => {
    const iFloor = new Float64Array(GEAR_CYCLES);
    const nInt = new Float64Array(GEAR_CYCLES);
    for (let k = 0; k < GEAR_CYCLES; k++) {
      iFloor[k] = qFloor(sArr[k]); // 已消化的完整 VCO cycle 數
      nInt[k] = k === 0 ? Number.NaN : iFloor[k] - iFloor[k - 1]; // /3-/4 divider 指令
    }
    return { iFloor, nInt };
  }, [sArr]);

  const gearK = gear.k;
  const gearDeg = 360 * sArr[gearK]; // 累積轉角(度):每拍前進 360N,故實轉 3 圈 + α
  const gearSpin = gear.snap || reduceMotion ? 'none' : `transform ${GEAR_SPIN_MS}ms ease-out`;
  const gearNInt = gearData.nInt[gearK];

  const stepGear = () =>
    setGear((p) => {
      const next = p.k + 1;
      return next >= GEAR_CYCLES ? { k: 0, snap: true } : { k: next, snap: false };
    });

  // ---- figure #5: absolute coordinate staircase ----
  const stairOption = useMemo(() => {
    const iFloor = new Float64Array(STAIR_CYCLES);
    for (let k = 0; k < STAIR_CYCLES; k++) {
      iFloor[k] = qFloor(sArr[k]); // integer cycle count consumed so far
    }
    return makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: 's (VCO cycles, absolute)',
      series: [
        {
          name: 's_ideal = s0 + kN',
          data: pairs(result.data.k, sArr, STAIR_CYCLES),
          showSymbol: true,
          symbolSize: 5,
        },
        {
          name: 'floor(s_ideal)',
          data: pairs(result.data.k, iFloor, STAIR_CYCLES),
          step: 'start',
          dashed: true,
          showSymbol: false,
        },
      ],
      zoom: false,
    });
  }, [result, ct]);

  // ---- figure #6: fractional accumulator plot ----
  const accOption = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: phaseAxisLabel('x_ideal', unit, tVco),
        yTickFormatter: makePhaseTickFormatter(unit, tVco),
        yMin: 0,
        yMax: 1,
        series: [
          {
            name: 'x_ideal',
            data: pairs(result.data.k, xArr),
            step: 'middle',
            showSymbol: true,
            symbolSize: 4,
          },
        ],
      }),
    [result, unit, tVco, ct, xArr],
  );

  const tableRows = useMemo(() => {
    const rows: Record<string, unknown>[] = [];
    for (let k = 0; k < Math.min(24, N_CYCLES); k++) {
      rows.push({ k, s_ideal: sArr[k], x_ideal: xArr[k] });
    }
    return rows;
  }, [sArr, xArr]);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            off-grid 的 <M>{'\\alpha'}</M>(例如 0.13)如何產生一條連續且完全 deterministic 的
            fractional phase trajectory?<EpistemicTag kind="EXACT" />
          </li>
          <li>
            integer part 3 與 fractional part <M>{'\\alpha'}</M> 在物理上各代表什麼?
          </li>
          <li>
            為什麼 <M>{'s_{ideal}[k] = s_0 + kN'}</M> 要用乘法而不是逐拍累加來實作?
          </li>
          <li>
            「off-grid」的正確理解是什麼——是 phase 不存在,還是 actuator 表示不了?
          </li>
          <li>
            不同 preset N(3.000 / 3.125 / 3.130 / 3.1375 / 3.250)的 trajectory 週期性有何差異?
          </li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          把 VCO 的 phase 想成一個每 <M>{'T_{vco}'}</M> 轉一圈的輪子。每個 reference edge
          到來時,VCO 已經轉了 <M>{'N = 3 + \\alpha'}</M> 圈:整數的 3 圈回到原點,肉眼看不出差別;
          真正留下痕跡的是多轉的 <M>{'\\alpha'}</M> 圈。所以「相對 VCO phase grid」來看,
          每個 reference cycle,VCO 的 fractional phase 前進 <M>{'+\\alpha'}</M>(輪子順時針多轉{' '}
          <M>{'\\alpha'}</M> 圈)。<EpistemicTag kind="EXACT" />
        </p>
        <p>
          這條軌跡完全由 <M>{'N'}</M> 決定,沒有任何隨機性:給定 k 就能閉式算出 phase。
          即使 <M>{'\\alpha = 0.13'}</M> 對應的 fine code <M>{'\\alpha G = 33.28'}</M> 不是整數
          (落在 256 格 grid 之外,off-grid),phase 本身仍然一拍一拍準確存在——只是 PMUX+DTC
          這組 actuator 無法每拍精確「指到」它。這正是後面所有 quantization 章節的出發點。
          <EpistemicTag kind="EXACT" />
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>
          第 k 個 reference edge(k = 0, 1, 2, …)時的 VCO absolute phase coordinate(單位:VCO
          cycles;MODEL_SPEC §3)<EpistemicTag kind="EXACT" />:
        </p>
        <MathBlock>{'s_{ideal}[k] = s_0 + kN, \\qquad N = 3 + \\alpha'}</MathBlock>
        <p>
          fractional phase state 是它對 1 cycle 取 wrap(<M>{'\\operatorname{wrap01}(x) = x - \\lfloor x \\rfloor \\in [0, 1)'}</M>,MODEL_SPEC §2)
          <EpistemicTag kind="EXACT" />:
        </p>
        <MathBlock>{'x_{ideal}[k] = \\operatorname{wrap01}(s_{ideal}[k])'}</MathBlock>
        <p>遞迴形式的等價推導(<M>{'s_0 = 0'}</M> 時):整數 3 在 wrap01 之下被丟棄,</p>
        <MathBlock>
          {'x_{ideal}[k+1] = \\operatorname{wrap01}(x_{ideal}[k] + N) = \\operatorname{wrap01}(x_{ideal}[k] + 3 + \\alpha) = \\operatorname{wrap01}(x_{ideal}[k] + \\alpha)'}
        </MathBlock>
        <p>
          <strong>integer 3 的意義</strong>:每個 reference period,VCO 至少走完 3 個完整 cycles
          (這由 /3-/4 divider 消化,見 Ch4)。<strong><M>{'\\alpha'}</M> 的意義</strong>:每拍相對
          VCO phase grid 的額外 phase rotation,是 fractional-N 操作全部「新資訊」的來源。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>
          <strong>週期性</strong>:若 <M>{'\\alpha = p/q'}</M>(最簡分數),則{' '}
          <M>{'x_{ideal}'}</M> 以 q 拍為週期。例如 <M>{'0.13 = 13/100 \\Rightarrow q = 100'}</M>、
          <M>{'0.125 = 1/8 \\Rightarrow q = 8'}</M>、<M>{'0.1375 = 11/80 \\Rightarrow q = 80'}</M>、
          <M>{'0.25 = 1/4 \\Rightarrow q = 4'}</M>。<EpistemicTag kind="EXACT" />
        </p>
        <p>
          <strong>on-grid / off-grid</strong>:G = 256 的 fine grid 上,一拍的位移是{' '}
          <M>{'\\alpha G'}</M> 個 LSB。<M>{'N = 3.125 \\Rightarrow \\alpha G = 32'}</M>(整數,
          on-grid,actuator 可每拍精確表示);<M>{'N = 3.13 \\Rightarrow \\alpha G = 33.28'}</M>
          (非整數,off-grid)。off-grid 不代表 phase 不存在——trajectory 依然連續、deterministic,
          只是 quantizer 每拍必須捨入。<EpistemicTag kind="EXACT" />
        </p>
        <Callout type="note" title="實作註記">
          <p>
            <M>{'s_{ideal}[k] = s_0 + kN'}</M> 必須用<strong>乘法</strong>(非逐拍累加)計算:
            float64 下乘法對每個 k 各自捨入一次,Python 與 TypeScript 逐位一致;
            逐拍累加則會讓 rounding error 隨 k 積累且依賴運算順序。(MODEL_SPEC §3 實作註記)
            <EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionMath>

      <SectionExample>
        <p>
          取 <M>{'N = 3.13'}</M>(<M>{'\\alpha = 0.13'}</M>),<M>{'s_0 = 0'}</M>。逐拍 fractional
          phase(MODEL_SPEC §3 的例子)<EpistemicTag kind="EXACT" />:
        </p>
        <p>
          <code>x_ideal = 0, 0.13, 0.26, 0.39, 0.52, 0.65, 0.78, 0.91, 0.04, …</code>
        </p>
        <p>手算驗證 k = 8 的 wrap:</p>
        <MathBlock>{'x[8] = \\operatorname{wrap01}(0.91 + 0.13) = \\operatorname{wrap01}(1.04) = 0.04'}</MathBlock>
        <p>
          absolute coordinate 驗證:<M>{'s[8] = 8 \\times 3.13 = 25.04'}</M>,整數部分 25 表示已消化
          25 個完整 VCO cycles,fractional 部分 0.04 與遞迴結果一致。再看週期:
          <M>{'s[100] = 313'}</M> 為整數,所以 <M>{'x[100] = 0'}</M>——N = 3.13 的 trajectory 每 100
          拍整除回到 0。目前參數下,當前顯示單位的一步大小為{' '}
          {formatPhase(alphaEff, unit, tVco)}(= <M>{'\\alpha'}</M>)。
          <EpistemicTag kind="EXACT" />
        </p>
      </SectionExample>

      <SectionFigure
        title="圖 #2 — 動畫 phase wheel:每拍 +α"
        caption={
          <span>
            輪面 0 在 12 點鐘方向,phase 增加為順時針(later edge)。實心 needle 是{' '}
            <code>x_ideal[k]</code>,淡色 needle 是前一拍;內圈弧線標出這一拍轉過的 +α。
            Play 以每 0.7 s 一拍前進;Step 單步;到 k = {N_CYCLES - 1} 後回到 k = 0。
          </span>
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
          <PhaseWheel
            markers={wheelMarkers}
            arcs={
              wheelK > 0 && alphaEff > 0
                ? [{ fromCycles: xArr[wheelK - 1], toCycles: xNow, r: 0.42 }]
                : undefined
            }
            size={280}
            animateToMarker
            title={
              <span>
                k = {wheelK}, x_ideal = {formatPhase(xNow, unit, tVco)}, s_ideal ={' '}
                {trimNumber(sArr[wheelK], 6)} cyc
              </span>
            }
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="preset-button"
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? 'Pause' : 'Play'}
              </button>
              <button
                type="button"
                className="preset-button"
                onClick={() => {
                  setPlaying(false);
                  setWheelK((p) => (p + 1) % N_CYCLES);
                }}
              >
                Step +1
              </button>
              <button
                type="button"
                className="preset-button"
                onClick={() => {
                  setPlaying(false);
                  setWheelK(0);
                }}
              >
                Reset
              </button>
            </div>
            <p>
              每拍旋轉 +α = {trimNumber(alphaEff, 6)} cycle = {trimNumber(360 * alphaEff, 6)}°。
              α = 0(N = 3.000)時 needle 靜止不動;α 越大,每拍跨步越大。
            </p>
          </div>
        </div>
      </SectionFigure>

      <SectionFigure
        title="圖 #2b — 齒輪 / 里程計:每拍轉 3 圈 + α"
        caption={
          <span>
            左邊 REF clock 的 x 軸是 reference cycle k(每個 pulse = 一拍,sample rate = f_ref,
            無量綱計數);右邊 VCO 錶盤的角度單位是 VCO cycle(整圈 = 1 cycle = 360°),needle 的
            累積轉角為 <code>360 × s_ideal[k]</code> 度——每按一拍它會真的轉過 3 整圈再多 α 圈,
            最後落在 <code>x_ideal[k]</code>。下方 odometer:左格是{' '}
            <code>floor(s_ideal[k])</code>(單位 VCO cycles,到第 k 拍為止已消化的完整 cycle 數),
            中格是它的每拍增量,也就是 /3-/4 divider 的指令 <code>n_int</code>
            (單位 VCO cycles/拍,只會是 3 或 4,4 以 accent 標色),右格是餘數{' '}
            <code>x_ideal[k]</code>(顯示單位隨 <UnitSwitch /> 切換)。
            <strong>
              wrap01 丟掉的正是這些整圈,而 /3-/4 divider 負責把它們吞掉——上面那個 phase wheel
              永遠只看得到餘數。
            </strong>
            這裡的 <code>n_int</code> 由 <code>qFloor(s_ideal)</code> 的逐拍差分算出;以 nearest
            quantizer、5 個 preset、512 拍實算比對,與 Ch4 由 <M>{'I_{FB}'}</M> 差分得到的{' '}
            <code>n_int</code> 逐拍相同(僅索引差一拍:此處記在「抵達」的那一拍)。
            <EpistemicTag kind="EXACT" /> Play 每 {GEAR_PERIOD_MS / 1000} s 前進一拍(轉盤動畫{' '}
            {GEAR_SPIN_MS / 1000} s ease-out);到 k = {GEAR_CYCLES - 1} 後回到 0 且不做反向動畫;
            系統設為 reduced motion 時直接跳格。N 由右側 α slider / preset N 控制。
          </span>
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
          {/* --- REF clock:每拍一個 pulse --- */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <svg
              width={CLK_W}
              height={62}
              viewBox={`0 0 ${CLK_W} 62`}
              role="img"
              aria-label="reference clock"
            >
              <path d={refClockPath()} fill="none" className="wheel-tick" />
              <line
                x1={CLK_X0 + gearK * CLK_PITCH}
                y1={10}
                x2={CLK_X0 + gearK * CLK_PITCH}
                y2={44}
                stroke="var(--accent)"
                strokeWidth={1.5}
              />
              <circle
                cx={CLK_X0 + gearK * CLK_PITCH}
                cy={CLK_HI}
                r={3.2}
                fill="var(--accent)"
              />
              {[0, 8, 16, 24].map((k) => (
                <text
                  key={`ck${k}`}
                  x={CLK_X0 + k * CLK_PITCH}
                  y={58}
                  className="wheel-tick-label"
                >
                  {k}
                </text>
              ))}
            </svg>
            <div className="phase-wheel-title">
              REF clock:第 <strong>k = {gearK}</strong> 個 reference edge
            </div>
          </div>

          {/* --- VCO 錶盤:累積轉角 360·s_ideal[k] --- */}
          <figure className="phase-wheel">
            <svg
              width={220}
              height={220}
              viewBox={`0 0 ${DIAL_VB} ${DIAL_VB}`}
              role="img"
              aria-label="VCO revolution dial"
            >
              <circle cx={DIAL_C} cy={DIAL_C} r={DIAL_R} className="wheel-ring" />
              {Array.from({ length: 32 }, (_, i) => {
                if (i % 4 === 0) return null;
                const p1 = dialPt(i / 32, DIAL_R - 4);
                const p2 = dialPt(i / 32, DIAL_R);
                return (
                  <line
                    key={`dmi${i}`}
                    x1={p1.x}
                    y1={p1.y}
                    x2={p2.x}
                    y2={p2.y}
                    className="wheel-tick"
                  />
                );
              })}
              {Array.from({ length: 8 }, (_, i) => {
                const p1 = dialPt(i / 8, DIAL_R - 9);
                const p2 = dialPt(i / 8, DIAL_R);
                const lp = dialPt(i / 8, DIAL_R + 15);
                return (
                  <g key={`dma${i}`}>
                    <line
                      x1={p1.x}
                      y1={p1.y}
                      x2={p2.x}
                      y2={p2.y}
                      className="wheel-tick wheel-tick-major"
                    />
                    <text x={lp.x} y={lp.y + 3} className="wheel-tick-label">
                      {DIAL_LABELS[i]}
                    </text>
                  </g>
                );
              })}
              {/* 12 點鐘 datum:α = 0 時 needle 每拍都停在這裡 */}
              <line
                x1={DIAL_C}
                y1={DIAL_C - DIAL_R - 6}
                x2={DIAL_C}
                y2={DIAL_C - DIAL_R + 12}
                stroke="var(--fg)"
                strokeWidth={2}
              />
              <g
                style={{
                  transform: `rotate(${gearDeg}deg)`,
                  transformOrigin: '50% 50%',
                  transformBox: 'view-box',
                  transition: gearSpin,
                }}
              >
                <line
                  x1={DIAL_C}
                  y1={DIAL_C}
                  x2={DIAL_C}
                  y2={DIAL_C - DIAL_R * 0.82}
                  stroke="var(--accent)"
                  strokeWidth={2}
                />
                <circle
                  cx={DIAL_C}
                  cy={DIAL_C - DIAL_R * 0.82}
                  r={4.5}
                  fill="var(--accent)"
                />
              </g>
              <circle cx={DIAL_C} cy={DIAL_C} r={2.5} className="wheel-center" />
            </svg>
            <figcaption className="phase-wheel-title">
              s_ideal[{gearK}] = {trimNumber(sArr[gearK], 6)} cyc → 累積轉角{' '}
              {trimNumber(gearDeg, 8)}°
            </figcaption>
          </figure>

          {/* --- 控制 --- */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 250 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="preset-button"
                onClick={() => setGearPlaying((p) => !p)}
              >
                {gearPlaying ? 'Pause' : 'Play'}
              </button>
              <button
                type="button"
                className="preset-button"
                onClick={() => {
                  setGearPlaying(false);
                  stepGear();
                }}
              >
                Step +1
              </button>
              <button
                type="button"
                className="preset-button"
                onClick={() => {
                  setGearPlaying(false);
                  setGear({ k: 0, snap: true });
                }}
              >
                Reset
              </button>
            </div>
            <p style={{ margin: 0 }}>
              每拍 needle 實際轉 <strong>{trimNumber(cfg.n_div, 6)}</strong> 圈 ={' '}
              {trimNumber(360 * cfg.n_div, 7)}°:前 3 整圈被 /3-/4 divider 吞掉(記進 odometer),
              只有多出來的 α = {trimNumber(alphaEff, 6)} 圈留在錶面上。
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 12 }}>
          <OdoCell
            label="odometer:floor(s_ideal[k]) (VCO cycles)"
            value={String(gearData.iFloor[gearK])}
          />
          <OdoCell
            label="本拍增量 = divider 指令 n_int"
            value={Number.isNaN(gearNInt) ? '—' : String(gearNInt)}
            accent={gearNInt === 4}
          />
          <OdoCell
            label="餘數 x_ideal[k] = wrap01(s_ideal[k])"
            value={formatPhase(xArr[gearK], unit, tVco)}
          />
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--fg-subtle)', marginBottom: 4 }}>
            n_int[k],k = 0…{GEAR_CYCLES - 1}(4 = 這一拍 divider 吞掉 4 個 VCO cycles;
            底線標出目前拍)
          </div>
          <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                width: GEAR_CYCLES * 25 - 3,
              }}
            >
              <div style={{ display: 'flex', gap: 3 }}>
                {Array.from({ length: GEAR_CYCLES }, (_, k) => {
                  const v = gearData.nInt[k];
                  const isFour = v === 4;
                  return (
                    <div
                      key={`ni${k}`}
                      title={`k = ${k}`}
                      style={{
                        flex: '0 0 auto',
                        width: 22,
                        textAlign: 'center',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.7rem',
                        padding: '2px 0',
                        borderRadius: 3,
                        border: `1px solid ${isFour ? 'var(--accent)' : 'var(--border)'}`,
                        background: isFour ? 'var(--accent-soft)' : 'var(--bg)',
                        color: isFour ? 'var(--accent)' : 'var(--fg-subtle)',
                        fontWeight: isFour ? 600 : 400,
                        boxShadow: k === gearK ? 'inset 0 -3px 0 0 var(--fg)' : undefined,
                      }}
                    >
                      {Number.isNaN(v) ? '—' : v}
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 3 }}>
                {Array.from({ length: GEAR_CYCLES }, (_, k) => (
                  <div
                    key={`nk${k}`}
                    style={{
                      flex: '0 0 auto',
                      width: 22,
                      textAlign: 'center',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.65rem',
                      color: 'var(--fg-faint)',
                    }}
                  >
                    {k % 4 === 0 ? k : ''}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </SectionFigure>

      <SectionFigure
        title="圖 #5 — absolute coordinate staircase"
        caption={
          <span>
            實線是 <code>s_ideal[k] = s0 + kN</code>(斜率恰為 N);虛線階梯是{' '}
            <code>floor(s_ideal)</code>,即到第 k 拍為止已消化的完整 VCO cycle 數。兩線的垂直距離就是
            fractional part <code>x_ideal[k]</code>。前 {STAIR_CYCLES} 拍。
          </span>
        }
      >
        <EChart option={stairOption} height={300} group="ch3" />
      </SectionFigure>

      <SectionFigure
        title="圖 #6 — fractional accumulator plot"
        caption={
          <span>
            <code>x_ideal[k]</code> 的鋸齒:斜率為 α,碰到 1 就 wrap 回 [0, 1)。拖動 α slider
            觀察斜率與 wrap 間距的變化;preset N 觀察週期(3.125 → 8 拍、3.130 → 100 拍)。單位:
            <UnitSwitch />
          </span>
        }
      >
        <EChart option={accOption} height={300} group="ch3" />
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model — 理想軌跡(真實碼節錄)"
        code={CODE_EXCERPT}
      />

      <SectionLineByLine
        items={[
          {
            code: 'out[k] = s0 + k * nDiv;',
            explain: (
              <span>
                MODEL_SPEC §3 的核心:absolute coordinate 用<strong>乘法</strong>閉式計算。
                每個 k 只捨入一次,float64 結果與 Python golden model 逐位一致;
                若寫成 <code>out[k] = out[k-1] + nDiv</code>,誤差會逐拍累積。
              </span>
            ),
          },
          {
            code: 'sIdeal(nCycles, nDiv, s0)',
            explain: (
              <span>
                參數就是 <M>{'s_0 + kN'}</M> 的三個自由度:模擬長度、divide ratio N、初始
                phase。回傳 <code>Float64Array</code>,單位為 VCO cycles。
              </span>
            ),
          },
          {
            code: 'return wrap01Arr(sIdeal(nCycles, nDiv, s0));',
            explain: (
              <span>
                fractional state 直接定義為 absolute coordinate 的 wrap01,而不是另外維護一個
                遞迴 accumulator——兩者數學等價(§3),但單一來源避免兩份 state 漂移。
              </span>
            ),
          },
          {
            code: 'return x - Math.floor(x);',
            explain: (
              <span>
                <code>wrap01</code> 的定義:<M>{'x - \\lfloor x \\rfloor \\to [0,1)'}</M>。
                對負輸入也正確(floor 向負無窮取整),與 Python 版逐字元同義。
              </span>
            ),
          },
          {
            code: '// multiplication, not accumulation',
            explain: (
              <span>
                模型內的註解即規格條文:這行註解對應 MODEL_SPEC §3 的實作註記,是跨語言
                bit-exact 測試(tolerance 1e-12)能通過的前提。
              </span>
            ),
          },
          {
            code: 'const sId = sIdealFn(n, cfg.n_div, cfg.s0);',
            explain: (
              <span>
                <code>simulate()</code>(simulate.ts)的第一步就是產生這條理想軌跡;後續
                feedback quantize(Ch4)、injection scheduling(Ch6)全部從同一組{' '}
                <code>s_ideal / x_ideal</code> 導出——這就是「master accumulator」共享的雛形。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            圖 #2:N = 3.130 時 needle 每拍順時針走 46.8°(0.13 cycle),第 8 拍從 0.91 wrap 到
            0.04;N = 3.000 時 needle 完全靜止(α = 0);N = 3.250 時每 4 拍回到原位。
          </li>
          <li>
            圖 #2b:N = 3.130 時 needle 每拍實轉 3.13 圈(1126.8°),odometer 大多每拍 +3,只有
            wrap 那拍 +4;前四個 4-command 落在 k = 8、16、24、31(注意不是 32:0.13 × 31 = 4.03
            已跨過第 4 個整圈),100 拍裡恰有 13 個 4。N = 3.000 時 needle 每拍精確轉 3 整圈、
            每次都停回 12 點鐘 datum,n_int 恆為 3、餘數恆為 0——錶面完全看不出 VCO 轉了多少圈,
            只有 odometer 記得。<EpistemicTag kind="EXACT" />
          </li>
          <li>
            圖 #5:實線斜率恰為 N(每拍 +3.13 cycles),階梯每拍升 3 格、偶爾升 4 格——升 4
            的位置正是圖 #6 wrap 的位置(fraction 累積滿 1 cycle)。
          </li>
          <li>
            圖 #6:鋸齒斜率 = α。N = 3.125 時序列 8 拍循環(0, 0.125, …, 0.875);N = 3.130 時
            100 拍才回到 0,zoom out 可看到掃過 [0, 1) 的緻密程度不同。
          </li>
          <li>
            單位切換:cycles → deg 時 y 軸乘 360;→ time 時乘 T_vco(N = 3.125 時 1 cycle = 80
            ps)。數值變了,曲線形狀不變——內部一律以 cycles 計算。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解 1:「off-grid 的 α 表示 phase 不存在 / 沒有意義」">
          <p>
            錯。<M>{'x_{ideal}[k]'}</M> 對任何實數 α 都是連續、deterministic、可閉式計算的序列;
            off-grid 只代表 <strong>actuator(PMUX+DTC 的 256 格 grid)無法每拍精確表示它</strong>,
            所以需要 quantizer(Ch4–Ch5)。把「表示不了」誤當「不存在」,會導致錯誤的結論:
            以為 injection timing 不需要追這條軌跡。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解 2:「用 x[k+1] = x[k] + α 逐拍累加實作即可」">
          <p>
            數學上等價,數值上不等價:float64 累加的 rounding error 隨 k 積累,且 Python/TS
            的求和順序差異會讓跨語言 bit-exact 驗證失敗。規格強制用乘法{' '}
            <M>{'s_0 + kN'}</M>。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <p>
          這條 ideal trajectory 是整個架構唯一的 deterministic phase 資訊來源:feedback path 要它
          來決定 /3-/4、PMUX、DTC 的每拍 code(Ch4–Ch5);injection path 要它的<strong>反向</strong>
          (<M>{'-x_{ideal}'}</M>)來對準 zero crossing(Ch6)。設計上必須讓兩條 path 從{' '}
          <strong>同一個 master accumulator</strong> 取值,而不是各自重算或只看 DSM 的瞬時輸出
          (Ch8–Ch9)。<EpistemicTag kind="INFERENCE" />
        </p>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            本章是純 exact digital model:不含 quantization(Ch4–Ch5)、analog mismatch(Ch15)、
            VCO noise 與 injection dynamics(Ch13)。「VCO 每拍精確轉 N 圈」本身是 locked
            穩態的理想化——真實 VCO 有 random phase noise,那正是 injection 要修正的對象
            (MODEL_SPEC §5.3)。<EpistemicTag kind="ASSUMPTION" />
          </p>
        </Callout>
      </SectionLimitation>

      <DebugTable
        columns={[
          { key: 'k', label: 'k' },
          { key: 's_ideal', label: 's_ideal (cyc)' },
          { key: 'x_ideal', label: 'x_ideal (cyc)' },
        ]}
        rows={tableRows}
        exportName="ch3_ideal_trajectory.csv"
      />

      <ParamPanel title="參數 Parameters">
        <Slider
          label="α (N − 3)"
          value={alpha}
          min={0}
          max={0.25}
          step={0.0005}
          onChange={setAlpha}
          fmt={(v) => `${trimNumber(v, 4)} (N=${trimNumber(3 + v, 6)})`}
        />
        <PresetButtons
          label="Preset N"
          presets={PRESET_N.map((p) => ({
            label: p.label,
            onClick: () => setAlpha(p.value - 3),
          }))}
        />
      </ParamPanel>
    </ChapterShell>
  );
}
