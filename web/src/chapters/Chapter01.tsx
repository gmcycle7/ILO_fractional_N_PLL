/**
 * Chapter 1 — 系統架構 System Architecture.
 *
 * Interactive figure #1: SVG system block diagram with hover/click
 * explanations, path highlighting (feedback / injection / shared state),
 * plus a cycle-by-cycle table from the real simulate() engine.
 */

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
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
import EpistemicTag from '../components/EpistemicTag';
import Callout from '../components/Callout';
import { M, MathBlock } from '../components/Math';
import { ParamPanel, PresetButtons, SelectControl, Slider } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import DebugTable from '../components/DebugTable';
import { useChartTheme } from '../lib/useChartTheme';
import { formatPhase, trimNumber } from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import { simulate, fromPartial } from '../model';

const meta = chapterById(1)!;

/* ------------------------------------------------------------- diagram */

type PathKind = 'core' | 'fb' | 'inj' | 'shared';
type HighlightMode = 'all' | 'fb' | 'inj' | 'shared';

interface BlockDef {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  paint: PathKind;
  /** highlight modes (besides 'all') in which this block stays opaque */
  vis: HighlightMode[];
  desc: string;
  ref: string;
}

interface EdgeDef {
  pts: string;
  paint: PathKind;
  vis: HighlightMode[];
  dashed?: boolean;
  label?: string;
  lx?: number;
  ly?: number;
}

const BLOCKS: BlockDef[] = [
  {
    id: 'REF', x: 30, y: 330, w: 110, h: 60, title: 'REF 4 GHz', sub: 'reference',
    paint: 'core', vis: ['fb', 'inj', 'shared'],
    desc: '理想 4 GHz reference,只用上升緣。它同時是 analog loop 的相位基準、digital scheduler 的時脈,也是 injection 的每拍觸發(每個 T_ref 恰一次 injection)。所有 per-cycle 序列以 f_ref 為 sample rate。',
    ref: 'MODEL_SPEC §1 · ASSUMPTION A1, A4',
  },
  {
    id: 'PFD', x: 190, y: 330, w: 110, h: 60, title: 'PFD / sampler', sub: 'phase detector',
    paint: 'core', vis: ['fb', 'inj'],
    desc: '比較 reference 上升緣與 feedback edge 的相位差。屬於傳統 PLL 迴路;本 behavioral model 不建其電路細節 — model 假設 loop 已鎖定在 deterministic trajectory 上,PFD/LF 的殘餘動態歸入 VCO noise 項 eta_vco。',
    ref: 'MODEL_SPEC §5.1 · ASSUMPTION(loop 已鎖定)',
  },
  {
    id: 'LF', x: 350, y: 330, w: 110, h: 60, title: 'Loop filter', sub: 'analog LF',
    paint: 'core', vis: ['fb', 'inj'],
    desc: '迴路濾波器,決定 PLL 頻寬(慢迴路:鎖平均頻率)。不在 behavioral model 範圍內;它與 injection(快路徑:每拍修 random phase)是互補分工。',
    ref: 'ASSUMPTION(未建模)',
  },
  {
    id: 'VCO', x: 820, y: 300, w: 130, h: 100, title: 'VCO 12–13 GHz', sub: '8-phase taps φ_j = j/8',
    paint: 'core', vis: ['fb', 'inj'],
    desc: '8-phase VCO,f_vco = N·f_ref。理想 fractional trajectory 為 s_ideal[k] = s0 + kN;random noise(white + random walk)與 detuning 由 injection 每拍修正。8 個 taps(45° 間距)同時是 injection tap mux 的輸入。injection dynamics 用 reset / linear / sin 三種 per-cycle phase map 近似。',
    ref: 'MODEL_SPEC §3, §14 · ASSUMPTION A2 · APPROX(dynamics)',
  },
  {
    id: 'ACC', x: 430, y: 28, w: 160, h: 56, title: 'Master accumulator', sub: 's_ideal[k] = s0 + kN',
    paint: 'shared', vis: ['fb', 'inj', 'shared'],
    desc: '整個架構唯一的 phase 真值來源:s_ideal[k] = s0 + kN(乘法計算,非累加),A_ideal = G·s_ideal。feedback 與 injection 的所有 command 都由這一個 state 導出 — 這裡就是「兩條路徑共享 phase 資訊的位置」。若兩邊各自維護 state(Mode B),cycle-by-cycle 的 reverse 關係即被破壞。',
    ref: 'MODEL_SPEC §3, §7 · EXACT',
  },
  {
    id: 'FBDEC', x: 560, y: 110, w: 170, h: 54, title: 'Q_FB + decode', sub: 'A_FB → I, R, m, c',
    paint: 'fb', vis: ['fb', 'shared'],
    desc: '對 A_ideal 做一次量化 A_FB = Q_FB(A_ideal)(nearest / floor / ef1 / mash11),再純位元切割:I_FB = floor(A_FB/256)(integer cycle)、R_FB = A_FB mod 256(final common code)、m_FB = floor(R_FB/64)(PMUX)、c_FB = R_FB mod 64(DTC)。divider 命令 n_int[k] = I_FB[k+1] − I_FB[k]。',
    ref: 'MODEL_SPEC §4, §6 · EXACT',
  },
  {
    id: 'INJDEC', x: 280, y: 110, w: 170, h: 54, title: 'Modular reverse + decode', sub: 'R_INJ → (j, c)',
    paint: 'inj', vis: ['inj', 'shared'],
    desc: 'Mode D(預設):R_INJ = (R_zero − R_FB) mod 256 — 對 final code 做一次模反向,不再獨立量化,故 (R_FB+R_INJ) mod 256 = R_zero 恆成立、pairwise digital error ≡ 0。再 decode 成 tap 選擇 j 與 injection DTC code c(naive:j = floor(R_INJ/32)、c = R_INJ mod 32;或 nearest / calibrated argmin)。',
    ref: 'MODEL_SPEC §7, §8 · EXACT',
  },
  {
    id: 'TAPSEL', x: 300, y: 214, w: 130, h: 56, title: '8-tap select', sub: 'φ_j = j/8 + δ_tap[j]',
    paint: 'inj', vis: ['inj'],
    desc: '從 VCO 的 8 個 phase taps 中選第 j 個做 injection 粗相位(粒度 1/8 cycle = 32 LSB)。tap mismatch δ_tap[j] 是 static per-tap offset;1° 的失配 = 222 fs,已超過 half-LSB 156.25 fs。',
    ref: 'MODEL_SPEC §5, §8, §10 · ASSUMPTION A2, C1',
  },
  {
    id: 'INJDTC', x: 470, y: 214, w: 120, h: 56, title: '6-bit DTC (INJ)', sub: 'c ∈ 0..63,range T_vco/4',
    paint: 'inj', vis: ['inj'],
    desc: 'injection 細相位:c × LSB,LSB = T_vco/256,range 64 LSB = 1/4 cycle。tap 間距 32 LSB < range 64 LSB → 同一 target 有 (j,c) 與 (j−1, c+32) 兩種 redundant 表示,calibrated mapping 據此避開壞 tap。gain / offset / INL / DNL 為 behavioral 模型。',
    ref: 'MODEL_SPEC §8, §10, §11 · ASSUMPTION B1',
  },
  {
    id: 'PULSE', x: 620, y: 214, w: 110, h: 56, title: 'Pulse gen', sub: '1 pulse / T_ref',
    paint: 'inj', vis: ['inj'],
    desc: '每個 reference cycle 產生一個 injection pulse,在排定時刻對 VCO differential 節點 shorting。若時刻正中 zero crossing,擾動能量 ∝ sin²(2π·ε_t/T_vco) ≈ 0;偏差的頻譜後果(offset / spur / noise floor)見 Ch14、Ch16。',
    ref: 'MODEL_SPEC §15 · ASSUMPTION A4 · APPROX(能量 proxy)',
  },
  {
    id: 'DIV', x: 740, y: 470, w: 120, h: 56, title: '/3-/4 divider', sub: 'n_int ∈ {3, 4}',
    paint: 'fb', vis: ['fb'],
    desc: 'multi-modulus divider,由 n_int[k] = I_FB[k+1] − I_FB[k] 控制本拍吞掉 3 或 4 個 VCO cycles,長期平均 = N。nearest/floor quantizer 下 n_int ∈ {3,4};DSM quantizer 允許暫態 {2..5}。',
    ref: 'MODEL_SPEC §4 · EXACT',
  },
  {
    id: 'PMUX', x: 560, y: 470, w: 120, h: 56, title: '4-phase PMUX', sub: 'm × T_vco/4 + δ_pmux[m]',
    paint: 'fb', vis: ['fb'],
    desc: 'feedback 粗相位:在 4 個 VCO quadrature 相位中選一個(粒度 1/4 cycle = 64 LSB),m_FB = floor(R_FB/64)。PMUX wrap 時 /3-/4 以 n_int 自動補整數 cycle。',
    ref: 'MODEL_SPEC §4 · EXACT · ASSUMPTION A3',
  },
  {
    id: 'FBDTC', x: 380, y: 470, w: 120, h: 56, title: '6-bit DTC (FB)', sub: 'c_FB ∈ 0..63',
    paint: 'fb', vis: ['fb'],
    desc: 'feedback 細相位:c_FB × LSB 的可調延遲(delay 為正的 phase 增量),輸出即送 PFD 的 feedback edge:u_FB = m/4 + c/256(+ analog 誤差)。與 injection DTC 同規格但獨立 instance(獨立 gain/INL/DNL)。',
    ref: 'MODEL_SPEC §4, §10, §11 · EXACT(digital)',
  },
];

const EDGES: EdgeDef[] = [
  // analog core
  { pts: '140,360 190,360', paint: 'core', vis: ['fb', 'inj'] },
  { pts: '300,360 350,360', paint: 'core', vis: ['fb', 'inj'] },
  { pts: '460,360 820,360', paint: 'core', vis: ['fb', 'inj'], label: 'V_ctrl', lx: 620, ly: 352 },
  // feedback hardware ring
  { pts: '885,400 885,498 860,498', paint: 'fb', vis: ['fb'] },
  { pts: '740,498 680,498', paint: 'fb', vis: ['fb'] },
  { pts: '560,498 500,498', paint: 'fb', vis: ['fb'] },
  { pts: '380,498 245,498 245,390', paint: 'fb', vis: ['fb'], label: 'FB edge → PFD', lx: 252, ly: 452 },
  // feedback command trunk (digital -> hardware)
  {
    pts: '690,164 690,190 770,190 770,470', paint: 'fb', vis: ['fb'], dashed: true,
    label: 'n_int · m_FB · c_FB', lx: 778, ly: 214,
  },
  // injection command path
  { pts: '365,164 365,214', paint: 'inj', vis: ['inj'], label: 'j', lx: 372, ly: 196 },
  { pts: '430,164 430,190 530,190 530,214', paint: 'inj', vis: ['inj'], label: 'c_INJ', lx: 448, ly: 185 },
  { pts: '430,242 470,242', paint: 'inj', vis: ['inj'] },
  { pts: '590,242 620,242', paint: 'inj', vis: ['inj'] },
  {
    pts: '730,242 885,242 885,300', paint: 'inj', vis: ['inj'],
    label: 'inject @ zero crossing', lx: 736, ly: 234,
  },
  {
    pts: '820,320 790,320 790,196 348,196 348,214', paint: 'inj', vis: ['inj'], dashed: true,
    label: '8 taps', lx: 600, ly: 191,
  },
  // shared digital state
  { pts: '85,330 85,56 430,56', paint: 'shared', vis: ['fb', 'inj', 'shared'], label: 'f_ref', lx: 95, ly: 70 },
  { pts: '470,84 470,96 365,96 365,110', paint: 'shared', vis: ['inj', 'shared'] },
  { pts: '550,84 550,96 645,96 645,110', paint: 'shared', vis: ['fb', 'shared'] },
  {
    pts: '560,137 450,137', paint: 'shared', vis: ['inj', 'shared'],
    label: 'R_FB(Mode D)', lx: 505, ly: 130,
  },
];

const PATH_LABEL: Record<PathKind, string> = {
  core: '類比核心 analog core',
  fb: 'feedback path',
  inj: 'injection path',
  shared: '共享數位狀態 shared state',
};

const infoPanelStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  background: 'var(--bg-panel)',
  padding: '10px 12px',
  marginTop: 10,
  minHeight: 88,
  fontSize: 13,
  lineHeight: 1.55,
};

/* ------------------------------------------------- quoted model source */

const SIMULATE_SRC = `// web/src/model/simulate.ts — simulate() 主流程(節錄)
// --- ideal trajectory (section 3; multiplication, not accumulation) ---
const sId = sIdealFn(n, cfg.n_div, cfg.s0);
const xId = new Float64Array(n);
const aId = new Float64Array(n);
for (let k = 0; k < n; k++) {
  xId[k] = wrap01(sId[k]);
  aId[k] = g * sId[k];
}

// --- analog element models (frozen per instance) ---
const dtcFb = makeDtc(cfg, 'fb', streams);
const dtcInj = makeDtc(cfg, 'inj', streams);
const tapTbl = tapTable(cfg.n_tap, cfg.tap_mismatch_cycles);
const pmuxTbl = pmuxTable(cfg.n_pmux, cfg.pmux_mismatch_cycles);

// --- computed-domain command streams ---
const fb = runFeedback(cfg, aId, sId, streams.dither_fb);
const inj = runInjection(cfg, xId, fb.R_FB, dtcInj, tapTbl, streams.dither_inj);

// --- latency pipeline (section 13) ---
const lat = applyLatency(cfg, n, streams.lat);
// ...
// --- injection dynamics (section 14) ---
const dyn = runDynamics(cfg, eZcHw, streams);`;

export default function Chapter01() {
  const [highlight, setHighlight] = useState<HighlightMode>('all');
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pinId, setPinId] = useState<string | null>(null);
  const [alpha, setAlpha] = useState(0.125);
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const selectedId = hoverId ?? pinId;
  const selected = BLOCKS.find((b) => b.id === selectedId);

  const pathColor = (p: PathKind): string =>
    p === 'fb' ? ct.series[1] : p === 'inj' ? ct.series[2] : p === 'shared' ? ct.accent : ct.textSubtle;

  const nDiv = 3 + alpha;
  const res = useMemo(() => simulate(fromPartial({ n_div: nDiv, n_cycles: 10 })), [nDiv]);
  const tv = res.t_vco_s;

  useEffect(() => {
    setStatus('done', `command table:N=${trimNumber(nDiv, 6)}, 10 cycles`);
  }, [res, nDiv, setStatus]);

  const tableRows = useMemo(() => {
    const d = res.data;
    const rows: Record<string, unknown>[] = [];
    for (let k = 0; k < d.k.length; k++) {
      rows.push({
        k,
        A_FB: d.A_FB[k],
        I_FB: d.I_FB[k],
        R_FB: d.R_FB[k],
        m_FB: d.m_FB[k],
        c_FB: d.c_FB[k],
        n_int: d.n_int[k],
        R_INJ: d.R_INJ[k],
        j_INJ: d.j_INJ[k],
        c_INJ: d.c_INJ[k],
        u_FB_digital: d.u_FB_digital[k],
        u_INJ_digital: d.u_INJ_digital[k],
        e_pair_digital: d.e_pair_digital[k],
      });
    }
    return rows;
  }, [res]);

  const blockActive = (b: BlockDef): boolean => highlight === 'all' || b.vis.includes(highlight);
  const edgeActive = (e: EdgeDef): boolean => highlight === 'all' || e.vis.includes(highlight);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>整個 reverse-injection fractional-N 系統由哪些 blocks 組成?訊號怎麼流?</li>
          <li>feedback path(慢迴路)與 injection path(快路徑)各負責修正什麼?</li>
          <li>
            兩條路徑在<strong>哪裡</strong>共享 phase 資訊?為什麼必須共享(而不是各算各的)?
          </li>
          <li>這張圖背後的 modeling assumptions(ASSUMPTIONS.md A1–A6)是什麼?</li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          把系統想成兩個時間尺度的分工。<strong>Feedback loop</strong>(REF → PFD → LF → VCO →
          /3-/4 → PMUX → DTC → PFD)是慢迴路:它只保證 VCO 的<strong>平均</strong>頻率是{' '}
          <M>{'N f_{ref}'}</M>,頻寬受 loop filter 限制,對每一拍的 random phase
          擾動無能為力。<strong>Injection path</strong>(scheduler → 8-tap select → DTC →
          pulse gen → VCO 節點)是快路徑:每個 reference cycle 直接在 VCO zero crossing 上
          shorting 一次,把當拍的 random phase error 拉回。<EpistemicTag kind="ASSUMPTION" />
        </p>
        <p>
          兩條路徑要協同,前提是對「VCO 現在轉到哪裡」有<strong>同一份</strong>認知。
          fractional phase <M>{'x_{ideal}[k]'}</M> 每拍前進 <M>{'+\\alpha'}</M>,feedback
          要正向追它,injection 要反向排程 <M>{'-\\alpha'}</M>;這份認知存在圖中央的{' '}
          <strong>master accumulator</strong> — 唯一的 phase 真值。兩邊若各自量化、各自累加
          (Mode B),兩個 quantizer 的進位取捨在每一拍都可能不同,cycle-by-cycle 的 reverse
          關係即被破壞(Ch8 量化這個代價)。<EpistemicTag kind="EXACT" />
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>沿著方塊圖走一遍,整個 digital 架構只需六條式子(細節分別在 Ch3–Ch8 推導):</p>
        <MathBlock>{'f_{vco} = N f_{ref}, \\qquad s_{ideal}[k] = s_0 + kN, \\qquad A_{ideal}[k] = G\\, s_{ideal}[k],\\; G = 256'}</MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> master accumulator(乘法計算,float64 跨語言逐位一致)。
          feedback 對它做一次量化與純位元 decode:
        </p>
        <MathBlock>{'A_{FB} = Q_{FB}(A_{ideal}), \\quad I_{FB} = \\lfloor A_{FB}/G \\rfloor, \\quad R_{FB} = A_{FB} \\bmod G'}</MathBlock>
        <MathBlock>{'m_{FB} = \\lfloor R_{FB}/64 \\rfloor \\in \\{0,\\dots,3\\}, \\qquad c_{FB} = R_{FB} \\bmod 64 \\in \\{0,\\dots,63\\}'}</MathBlock>
        <MathBlock>{'n_{int}[k] = I_{FB}[k+1] - I_{FB}[k] \\in \\{3, 4\\}'}</MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> injection 的理想 command 是 fractional phase 的反向,
          Mode D 直接對 final code 做 modular reverse:
        </p>
        <MathBlock>{'u_{INJ,ideal}[k] = \\operatorname{wrap01}(z_0 - x_{nominal}[k]), \\qquad R_{INJ}[k] = (R_{zero} - R_{FB}[k]) \\bmod 256'}</MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> 最後 decode 到硬體:tap <M>{'j'}</M>(32 LSB 粗步階)與
          injection DTC code <M>{'c'}</M>(1 LSB 細步階),naive mapping 為{' '}
          <M>{'j = \\lfloor R_{INJ}/32 \\rfloor,\\; c = R_{INJ} \\bmod 32'}</M>。
        </p>
      </SectionMath>

      <SectionExample>
        <p>
          手算一拍(<M>{'N = 3.125'}</M>、<M>{'s_0=0'}</M>、nearest、Mode D、naive mapping),
          可與下方表格逐項對照:
        </p>
        <ul>
          <li>
            <M>{'k=1'}</M>:<M>{'s_{ideal}=3.125 \\Rightarrow A_{ideal}=256 \\times 3.125 = 800.0'}</M>,
            on-grid,故 <M>{'A_{FB}=800'}</M>。
          </li>
          <li>
            decode:<M>{'I_{FB} = \\lfloor 800/256 \\rfloor = 3'}</M>,
            <M>{'R_{FB} = 800 - 3\\times 256 = 32'}</M>,
            <M>{'m_{FB} = \\lfloor 32/64 \\rfloor = 0'}</M>,<M>{'c_{FB} = 32'}</M>;
            divider:<M>{'n_{int}[0] = I_{FB}[1]-I_{FB}[0] = 3 - 0 = 3'}</M>。
          </li>
          <li>
            injection:<M>{'x_{ideal}[1] = 0.125 \\Rightarrow u_{INJ,ideal} = \\operatorname{wrap01}(0-0.125) = 0.875'}</M>;
            Mode D:<M>{'R_{INJ} = (0 - 32) \\bmod 256 = 224'}</M> →{' '}
            <M>{'j = \\lfloor 224/32 \\rfloor = 7'}</M>,<M>{'c = 224 \\bmod 32 = 0'}</M>,
            <M>{'u_{INJ,digital} = 224/256 = 0.875'}</M> ✓。
          </li>
          <li>
            pairwise 檢查:<M>{'u_{FB} + u_{INJ} = 0.125 + 0.875 = 1.0'}</M> →{' '}
            <M>{'e_{pair} = \\operatorname{wrapCycles}(1.0) = 0'}</M>。
            <EpistemicTag kind="EXACT" />
          </li>
        </ul>
      </SectionExample>

      <SectionFigure
        title="互動圖 #1 — System block diagram(hover / 點選任一 block)"
        caption={
          <span>
            實線 = 訊號/edge 流;虛線 = digital command 或 multi-phase tap bus。顏色:
            <span style={{ color: pathColor('core') }}> ■ analog core</span>、
            <span style={{ color: pathColor('fb') }}> ■ feedback</span>、
            <span style={{ color: pathColor('inj') }}> ■ injection</span>、
            <span style={{ color: pathColor('shared') }}> ■ shared phase state</span>。
            右側 panel 可只 highlight 單一路徑;點選 block 可固定說明。
          </span>
        }
      >
        <svg
          viewBox="0 0 980 560"
          style={{ width: '100%', height: 'auto', display: 'block' }}
          role="img"
          aria-label="system block diagram"
        >
          <defs>
            {(['core', 'fb', 'inj', 'shared'] as PathKind[]).map((p) => (
              <marker
                key={p}
                id={`ch1-arr-${p}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={pathColor(p)} />
              </marker>
            ))}
          </defs>

          {/* digital scheduler region */}
          <rect
            x={260}
            y={16}
            width={490}
            height={160}
            fill="var(--accent-soft)"
            stroke="var(--border-strong)"
            strokeDasharray="6 5"
            rx={8}
          />
          <text x={272} y={36} fontSize={11} fill="var(--fg-subtle)">
            Digital scheduler — shared phase state(Ch8)
          </text>

          {/* edges */}
          {EDGES.map((e, i) => (
            <g key={i} opacity={edgeActive(e) ? 1 : 0.18}>
              <polyline
                points={e.pts}
                fill="none"
                stroke={pathColor(e.paint)}
                strokeWidth={1.7}
                strokeDasharray={e.dashed ? '5 4' : undefined}
                markerEnd={`url(#ch1-arr-${e.paint})`}
              />
              {e.label !== undefined && (
                <text x={e.lx} y={e.ly} fontSize={9.5} fill="var(--fg-subtle)">
                  {e.label}
                </text>
              )}
            </g>
          ))}

          {/* blocks */}
          {BLOCKS.map((b) => {
            const isSel = b.id === selectedId;
            return (
              <g
                key={b.id}
                opacity={blockActive(b) ? 1 : 0.22}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHoverId(b.id)}
                onMouseLeave={() => setHoverId(null)}
                onClick={() => setPinId((p) => (p === b.id ? null : b.id))}
              >
                <rect
                  x={b.x}
                  y={b.y}
                  width={b.w}
                  height={b.h}
                  rx={6}
                  fill={isSel ? 'var(--accent-soft)' : 'var(--bg-panel)'}
                  stroke={isSel ? 'var(--accent)' : pathColor(b.paint)}
                  strokeWidth={isSel ? 2.4 : 1.5}
                />
                <text
                  x={b.x + b.w / 2}
                  y={b.y + (b.sub !== undefined ? b.h / 2 - 3 : b.h / 2 + 4)}
                  fontSize={12}
                  fontWeight={600}
                  fill="var(--fg)"
                  textAnchor="middle"
                >
                  {b.title}
                </text>
                {b.sub !== undefined && (
                  <text
                    x={b.x + b.w / 2}
                    y={b.y + b.h / 2 + 14}
                    fontSize={9.5}
                    fill="var(--fg-subtle)"
                    textAnchor="middle"
                  >
                    {b.sub}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        <div style={infoPanelStyle}>
          {selected ? (
            <>
              <div style={{ marginBottom: 4 }}>
                <strong>{selected.title}</strong>
                <span
                  style={{
                    fontSize: 11,
                    color: pathColor(selected.paint),
                    border: `1px solid ${pathColor(selected.paint)}`,
                    borderRadius: 4,
                    padding: '1px 6px',
                    marginLeft: 8,
                  }}
                >
                  {PATH_LABEL[selected.paint]}
                </span>
              </div>
              <div>{selected.desc}</div>
              <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--fg-faint)' }}>
                {selected.ref}
              </div>
            </>
          ) : (
            <span style={{ color: 'var(--fg-subtle)' }}>
              將滑鼠移到(或點選)任一 block 查看說明、對應的 MODEL_SPEC 章節與 assumptions。
            </span>
          )}
        </div>
      </SectionFigure>

      <SectionFigure
        title="Cycle-by-cycle command 對照表(真實 simulate() 輸出)"
        caption={
          <span>
            上圖每個 digital block 的輸出逐拍列出(<M>{'N'}</M> 可在右側調整)。u 欄單位:
            <UnitSwitch />;整數 code 欄為精確整數。注意 e_pair 欄全為 0(Mode D)。
          </span>
        }
      >
        <DebugTable
          columns={[
            { key: 'k', label: 'k' },
            { key: 'A_FB', label: 'A_FB' },
            { key: 'I_FB', label: 'I_FB' },
            { key: 'R_FB', label: 'R_FB' },
            { key: 'm_FB', label: 'm_FB' },
            { key: 'c_FB', label: 'c_FB' },
            { key: 'n_int', label: 'n_int' },
            { key: 'R_INJ', label: 'R_INJ' },
            { key: 'j_INJ', label: 'j' },
            { key: 'c_INJ', label: 'c' },
            {
              key: 'u_FB_digital',
              label: 'u_FB',
              fmt: (v) => formatPhase(v as number, unit, tv, 6),
            },
            {
              key: 'u_INJ_digital',
              label: 'u_INJ',
              fmt: (v) => formatPhase(v as number, unit, tv, 6),
            },
            {
              key: 'e_pair_digital',
              label: 'e_pair',
              fmt: (v) => formatPhase(v as number, unit, tv, 6),
            },
          ]}
          rows={tableRows}
          exportName="ch1_command_table.csv"
        />
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model/simulate.ts — 主流程(真實碼節錄)"
        code={SIMULATE_SRC}
      >
        <p>
          simulate() 的呼叫順序就是上圖的資料流:ideal trajectory(ACC)→ feedback
          quantize/decode(FBDEC → DIV/PMUX/DTC)→ injection mode + tap/DTC decode(INJDEC →
          TAPSEL/DTC)→ latency pipeline → injection dynamics(VCO)。
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'const sId = sIdealFn(n, cfg.n_div, cfg.s0);',
            explain: (
              <span>
                Master accumulator(圖中 ACC):<M>{'s_{ideal}[k]=s_0+kN'}</M> 以乘法一次算出,
                避免累加造成的浮點 drift — 這是 Python/TS 逐位一致的關鍵。
                <EpistemicTag kind="EXACT" />
              </span>
            ),
          },
          {
            code: 'xId[k] = wrap01(sId[k]);\naId[k] = g * sId[k];',
            explain: (
              <span>
                同一個 state 導出兩個視角:fractional phase <M>{'x_{ideal}'}</M>(injection 用)
                與 fine code <M>{'A_{ideal}=G\\,s_{ideal}'}</M>(feedback 用)。共享點就在這兩行。
              </span>
            ),
          },
          {
            code: "const dtcFb = makeDtc(cfg, 'fb', streams);\nconst dtcInj = makeDtc(cfg, 'inj', streams);",
            explain: (
              <span>
                兩顆 DTC 是<strong>獨立 instance</strong>(獨立 gain/INL/DNL 與 PRNG stream)—
                shared digital code 消不掉這種 analog 差異(Ch8、Ch15)。
              </span>
            ),
          },
          {
            code: 'const fb = runFeedback(cfg, aId, sId, streams.dither_fb);',
            explain: (
              <span>
                FBDEC + 硬體命令:quantize 一次得 <M>{'A_{FB}'}</M>,decode 出 <M>{'I/R/m/c'}</M>{' '}
                與 <M>{'n_{int}'}</M>,並檢查 edge monotonic、code range 等 assertions
                (MODEL_SPEC §4)。
              </span>
            ),
          },
          {
            code: 'const inj = runInjection(cfg, xId, fb.R_FB, dtcInj, tapTbl, streams.dither_inj);',
            explain: (
              <span>
                注意參數 <code>fb.R_FB</code>:injection scheduler 拿的是 feedback 的{' '}
                <strong>final common code</strong>,Mode D 對它 modular reverse — 這一行就是
                「共享」在程式碼上的位置。
              </span>
            ),
          },
          {
            code: 'const lat = applyLatency(cfg, n, streams.lat);',
            explain: (
              <span>
                Command 產生(computed domain)與生效(applied domain)之間隔 <M>{'L'}</M> 拍;
                look-ahead 正確與否差 46.8°(Ch12)。
              </span>
            ),
          },
          {
            code: 'const dyn = runDynamics(cfg, eZcHw, streams);',
            explain: (
              <span>
                VCO 對 injection pulse 的 phase response(reset / linear / sin 三種近似,Ch13)。
                <EpistemicTag kind="APPROX" />
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            Hover <strong>Master accumulator</strong>:兩條箭頭分別指向 Q_FB decode 與 modular
            reverse — 全系統只有這一份 phase state。切到「shared phase state」highlight 看最清楚。
          </li>
          <li>
            Hover <strong>Modular reverse</strong>:它的輸入箭頭來自 FBDEC(標注 R_FB),不是
            來自另一個 accumulator — Mode D 的反向是對 final code 做的,不重新量化。
          </li>
          <li>
            用「feedback path」highlight 追迴路:REF → PFD → LF → VCO → /3-/4 → PMUX → DTC →
            PFD 是<strong>閉迴路</strong>;切「injection path」看 injection 是從 digital state
            前饋進 VCO 的<strong>開路徑</strong>(不經 PFD)。
          </li>
          <li>
            表格在 <M>{'N=3.125'}</M> 時:R_FB 逐拍 +32 mod 256、R_INJ 逐拍 −32 mod 256,兩者和
            恆 ≡ 0(mod 256);n_int 在 k=7 出現一次 4(R_FB wrap 回 0,/3-/4 補整數 cycle)。
            把 α 拉到 0.13(off-grid)再看 e_pair 欄 — 仍然全 0。<EpistemicTag kind="EXACT" />
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout
          type="warn"
          title="誤解:「feedback 與 injection 是兩個獨立子系統,各自維護自己的 phase accumulator 就好」"
        >
          <p>
            錯。兩個獨立 quantizer(即使輸入同樣的 ideal 值)在每一拍的進位取捨可以不同,造成
            cycle-by-cycle 的 pairwise error(Mode B;Ch8 實測非零)。反向關係要成立,必須從
            <strong>同一個</strong> master state 導出、且只 quantize 一次再 modular reverse
            (Mode D,pairwise digital error ≡ 0 <EpistemicTag kind="EXACT" />)。
            「平均值正確」不等於「每一拍都正確」。
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>
            架構的核心不是任何單一 block,而是 phase 真值的<strong>單一來源</strong>:master
            accumulator → 單次量化 → 兩路 decode。
          </li>
          <li>feedback 管平均頻率(慢),injection 管每拍 random phase(快);兩者互補,不重疊。</li>
          <li>
            硬體粒度階梯:/3-/4(整數 cycle)→ PMUX(1/4 cycle)→ DTC(1/256 cycle);injection
            側為 tap(1/8 cycle)+ DTC(1/256 cycle)— 所有 command 都是同一個 code 的位元切割。
          </li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            此圖是 behavioral 抽象:PFD、loop filter 與 charge pump 未建模(model 假設 loop 已
            鎖定於 deterministic trajectory,殘餘動態併入 VCO noise 項)。VCO 的 injection
            response 是 per-cycle phase map 近似(ASSUMPTIONS D1–D3),不是 continuous-time
            ILO 模型;shorting 能量為 normalized proxy。
          </p>
        </Callout>
        <p>本章依賴的 ASSUMPTIONS.md 條目:</p>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>假設</th>
              <th>預設</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>A1</td><td>reference 為理想 4 GHz 方波,只用上升緣</td><td>f_ref = 4 GHz</td></tr>
            <tr><td>A2</td><td>VCO 為 8-phase oscillator,tap nominal 間距 45°</td><td>N_TAP = 8</td></tr>
            <tr><td>A3</td><td>feedback PMUX 為 4-phase,間距 T_vco/4</td><td>N_PMUX = 4</td></tr>
            <tr><td>A4</td><td>每個 reference cycle 恰好一次 injection</td><td>1 pulse / T_ref</td></tr>
            <tr><td>A5</td><td>期望 zero-crossing 相位 z0 可校正</td><td>z0 = 0</td></tr>
            <tr><td>A6</td><td>modular reverse 的 digital zero offset R_zero</td><td>R_zero = 0</td></tr>
          </tbody>
        </table>
      </SectionLimitation>

      <ParamPanel title="參數">
        <SelectControl<HighlightMode>
          label="路徑 highlight"
          value={highlight}
          options={[
            { value: 'all', label: '全部' },
            { value: 'fb', label: 'feedback path' },
            { value: 'inj', label: 'injection path' },
            { value: 'shared', label: 'shared phase state' },
          ]}
          onChange={setHighlight}
        />
        <Slider
          label="α(表格用,N = 3 + α)"
          value={alpha}
          min={0}
          max={0.25}
          step={0.0005}
          onChange={setAlpha}
        />
        <PresetButtons
          label="Preset N"
          presets={[3.0, 3.125, 3.13, 3.1375, 3.25].map((n) => ({
            label: String(n),
            onClick: () => setAlpha(n - 3),
          }))}
        />
      </ParamPanel>
    </ChapterShell>
  );
}
