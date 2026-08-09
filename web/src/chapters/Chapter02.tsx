/**
 * Chapter 2 — 時序與符號慣例 Timing and Sign Convention.
 *
 * MODEL_SPEC §2 in full: cycles as the internal unit, wrap01 / wrapCycles /
 * wrapRadians, error = actual - ideal, delays positive, and why the built-in
 * round() is banned. Interactive figure #4: EdgeTimeline of ref / VCO /
 * feedback / injection edges from the real simulate() engine.
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
import EpistemicTag from '../components/EpistemicTag';
import Callout from '../components/Callout';
import { M, MathBlock } from '../components/Math';
import PhaseWheel from '../components/PhaseWheel';
import EdgeTimeline from '../components/EdgeTimeline';
import type { TimelineRow } from '../components/EdgeTimeline';
import EChart from '../components/EChart';
import DebugTable from '../components/DebugTable';
import { ParamPanel, PresetButtons, Slider } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import { makeLineOption } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { formatPhase, trimNumber } from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import { simulate, fromPartial, wrap01, wrapCycles, qNearest } from '../model';

const meta = chapterById(2)!;

/* --------------------------------------------------- quoted model source */

const PHASE_MATH_SRC = `/** x - floor(x)  ->  [0, 1). */
export function wrap01(x: number): number {
  return x - Math.floor(x);
}

/** y = x - floor(x); if y > 0.5: y -= 1  ->  (-0.5, 0.5]. */
export function wrapCycles(x: number): number {
  let y = x - Math.floor(x);
  if (y > 0.5) {
    y -= 1.0;
  }
  return y;
}

/** 2*pi * wrapCycles(t / (2*pi))  ->  (-pi, pi]. */
export function wrapRadians(t: number): number {
  return TWO_PI * wrapCycles(t / TWO_PI);
}

/**
 * Half-up nearest quantizer: floor(x + 0.5).
 *
 * NEVER use a language round() (Python round is banker's rounding) —
 * qNearest(2.5) === 3 in both languages.
 */
export function qNearest(x: number): number {
  return Math.floor(x + 0.5);
}`;

/** sample points for the wrap-behavior number-line table */
const WRAP_SAMPLES = [-1.2, -0.5, -0.3, 0.3, 0.5, 0.7, 1.2];

/** ties where Python round() (banker's) and half-up disagree; Python column
 *  quoted from CPython semantics (round-half-to-even), documented [EXACT]. */
const ROUND_TIES: { u: number; py: number }[] = [
  { u: 0.5, py: 0 },
  { u: 1.5, py: 2 },
  { u: 2.5, py: 2 },
  { u: 3.5, py: 4 },
];

/* --------------------------------------------------- notation table (全站) */

interface NotationRow {
  /** KaTeX source for the symbol */
  tex: string;
  /** ASCII name(s) used in code / test-vector columns; also the search key */
  ascii: string;
  /** meaning (zh-Hant, searchable) */
  zh: string;
  unit: string;
  /** defining MODEL_SPEC section */
  spec: string;
  /** chapter where the symbol is introduced */
  ch: string;
}

/**
 * Every symbol used across the site, mapped back to its defining MODEL_SPEC
 * section and the chapter that introduces it.  Definitions are quoted from
 * MODEL_SPEC (EXACT); this table adds no new math.
 */
const NOTATION: NotationRow[] = [
  // ---- §1 system parameters
  { tex: 'f_{ref}', ascii: 'f_ref', zh: 'reference 頻率(預設 4 GHz)', unit: 'Hz', spec: '§1', ch: 'Ch0' },
  { tex: 'T_{ref} = 1/f_{ref}', ascii: 'T_ref', zh: 'reference 週期(250 ps)', unit: 's', spec: '§1', ch: 'Ch0' },
  { tex: 'N = 3 + \\alpha', ascii: 'N n_div', zh: 'fractional divide ratio(= f_vco/f_ref)', unit: '無因次', spec: '§1', ch: 'Ch0' },
  { tex: '\\alpha', ascii: 'alpha', zh: 'N 的小數部分;每拍相對 VCO phase grid 多轉的量', unit: 'cycles/拍', spec: '§1, §3', ch: 'Ch3' },
  { tex: 'f_{vco} = N f_{ref}', ascii: 'f_vco', zh: 'VCO 頻率(12–13 GHz)', unit: 'Hz', spec: '§1', ch: 'Ch0' },
  { tex: 'T_{vco} = 1/f_{vco}', ascii: 'T_vco', zh: 'VCO 週期(76.9–83.3 ps);phase 單位換算基準', unit: 's', spec: '§1', ch: 'Ch0' },
  { tex: 'B_{DTC} = 6', ascii: 'B_DTC b_dtc', zh: 'feedback 與 injection DTC 位元數', unit: 'bit', spec: '§1', ch: 'Ch5' },
  { tex: 'G = 4 \\cdot 2^{B_{DTC}} = 256', ascii: 'G LSB', zh: '每 T_vco 的 fine phase 單位數;1 LSB = 1/256 cycle', unit: 'LSB/cycle', spec: '§1', ch: 'Ch0' },
  { tex: 'N_{TAP} = 8', ascii: 'N_TAP n_tap', zh: 'injection tap 數(0°, 45°, …, 315°;間距 32 LSB)', unit: '無因次', spec: '§1', ch: 'Ch7' },
  { tex: 'N_{PMUX} = 4', ascii: 'N_PMUX n_pmux', zh: 'feedback PMUX 相位數(間距 T_vco/4)', unit: '無因次', spec: '§1', ch: 'Ch4' },
  { tex: 'z_0', ascii: 'z0 z0_cycles', zh: '期望 injection zero-crossing phase(可校正參數)', unit: 'cycles', spec: '§1, §5', ch: 'Ch6' },
  { tex: 'R_{zero}', ascii: 'R_zero r_zero', zh: 'modular reverse 的 digital zero offset code', unit: 'LSB(整數)', spec: '§1, §7', ch: 'Ch8' },
  { tex: 's_0', ascii: 's0', zh: '初始 absolute phase coordinate', unit: 'cycles', spec: '§1, §3', ch: 'Ch3' },
  // ---- §2 wrap / quantize primitives
  { tex: '\\operatorname{wrap01}(x)', ascii: 'wrap01', zh: '位置 wrap:x − ⌊x⌋ → [0,1);位置/command 用它', unit: 'cycles', spec: '§2', ch: 'Ch2' },
  { tex: '\\operatorname{wrapCycles}(x)', ascii: 'wrapCycles wrap_cycles', zh: '帶符號最短差 wrap → (−0.5, 0.5];誤差一律用它', unit: 'cycles', spec: '§2', ch: 'Ch2' },
  { tex: '\\operatorname{wrapRadians}(t)', ascii: 'wrapRadians wrap_radians', zh: 'radians 版 wrap → (−π, π](dynamics 介面)', unit: 'rad', spec: '§2', ch: 'Ch2' },
  { tex: '\\operatorname{qNearest}, \\operatorname{qFloor}', ascii: 'qNearest qFloor round', zh: '量化 primitives:⌊x+0.5⌋(half-up)與 ⌊x⌋;禁止內建 round()', unit: 'LSB', spec: '§2', ch: 'Ch2' },
  // ---- §3 ideal trajectory
  { tex: 's_{ideal}[k] = s_0 + kN', ascii: 's_ideal', zh: '第 k 個 ref edge 的理想 VCO absolute phase coordinate(乘法計算,非累加)', unit: 'cycles', spec: '§3', ch: 'Ch3' },
  { tex: 'x_{ideal}[k]', ascii: 'x_ideal', zh: '理想 fractional phase state = wrap01(s_ideal[k])', unit: 'cycles', spec: '§3', ch: 'Ch3' },
  // ---- §4 feedback path
  { tex: 'A_{ideal}[k] = G\\, s_{ideal}[k]', ascii: 'A_ideal', zh: '高解析理想 fine code(實數,量化前)', unit: 'LSB', spec: '§4', ch: 'Ch4' },
  { tex: 'A_{FB}[k]', ascii: 'A_FB', zh: '量化後 absolute fine code = Q_FB(A_ideal)(非負整數,嚴格遞增)', unit: 'LSB', spec: '§4', ch: 'Ch4' },
  { tex: 'I_{FB}[k]', ascii: 'I_FB', zh: 'integer cycle index = ⌊A_FB/G⌋', unit: 'cycle', spec: '§4', ch: 'Ch4' },
  { tex: 'R_{FB}[k]', ascii: 'R_FB', zh: 'feedback fine code = A_FB mod G ∈ {0..255}', unit: 'LSB', spec: '§4', ch: 'Ch4' },
  { tex: 'm_{FB}[k]', ascii: 'm_FB', zh: 'PMUX code = ⌊R_FB/64⌋ ∈ {0..3}', unit: 'code', spec: '§4', ch: 'Ch4' },
  { tex: 'c_{FB}[k]', ascii: 'c_FB', zh: 'feedback DTC code = R_FB mod 64 ∈ {0..63}', unit: 'code', spec: '§4', ch: 'Ch5' },
  { tex: 'n_{int}[k]', ascii: 'n_int n_integer', zh: '瞬時 divider 動作 = I_FB[k+1] − I_FB[k] ∈ {3,4}(DSM quantizer:{2,3,4})', unit: 'cycle', spec: '§4', ch: 'Ch4' },
  { tex: 's_{FB,actual},\\ t_{FB,actual}', ascii: 's_FB_actual t_FB_actual', zh: '實際 feedback edge:A_FB/G(cycles)與 × T_vco(秒)', unit: 'cycles / s', spec: '§4', ch: 'Ch2' },
  { tex: 'u_{FB,ideal}[k]', ascii: 'u_FB_ideal', zh: 'feedback 理想 fractional 目標(= x_ideal[k])', unit: 'cycles', spec: '§4', ch: 'Ch5' },
  { tex: 'u_{FB,digital}[k]', ascii: 'u_FB_digital', zh: 'feedback fractional digital 值 = R_FB/G', unit: 'cycles', spec: '§4', ch: 'Ch4' },
  { tex: 'u_{FB,analog}[k]', ascii: 'u_FB_analog u_FB_actual', zh: '含 analog 誤差的 feedback phase = pmux_actual(m_FB) + dtc_fb_actual(c_FB) + route_FB', unit: 'cycles', spec: '§4, §10', ch: 'Ch5' },
  { tex: 'e_{FB,abs}[k]', ascii: 'e_FB_abs', zh: 'feedback absolute 誤差 = wrapCycles(s_FB_actual − s_ideal)', unit: 'cycles', spec: '§4', ch: 'Ch5' },
  // ---- §5 injection geometry
  { tex: 'x_{nominal}[k]', ascii: 'x_nominal', zh: 'deterministic fractional trajectory(通常 = x_ideal)', unit: 'cycles', spec: '§5.1', ch: 'Ch6' },
  { tex: '\\eta_{vco}[k]', ascii: 'eta_vco eta', zh: 'VCO random 偏移(noise / PLL residual / detuning)— injection 要修正的對象', unit: 'cycles', spec: '§5.1', ch: 'Ch6' },
  { tex: 'x_{vco,actual}[k]', ascii: 'x_vco_actual', zh: '實際 VCO base phase = x_nominal + η_vco', unit: 'cycles', spec: '§5.1', ch: 'Ch6' },
  { tex: '\\varphi_{tap}[j],\\ \\delta_{tap}[j]', ascii: 'phi_tap delta_tap tap_mismatch', zh: '第 j 個 tap 的 nominal phase j/8 與 mismatch 偏移(actual = j/8 + δ_tap)', unit: 'cycles', spec: '§5.1, §10', ch: 'Ch7' },
  { tex: '\\tau_{INJ}[k],\\ d_{INJ}[k]', ascii: 'tau_INJ d_INJ', zh: 'injection DTC delay(秒)與 normalized 版 τ_INJ/T_vco', unit: 's / cycles', spec: '§5.1', ch: 'Ch7' },
  { tex: 'u_{INJ,ideal}[k]', ascii: 'u_INJ_ideal', zh: 'injection 理想 command = wrap01(z0 − x_nominal);反向(−α/拍)的來源', unit: 'cycles', spec: '§5.2', ch: 'Ch6' },
  { tex: 'e_{ZC}[k],\\ \\theta_{ZC}[k]', ascii: 'e_ZC theta_ZC', zh: 'zero-crossing alignment error = wrapCycles(x_vco_actual + φ_tap_actual + d_INJ − z0);θ_ZC = 2π e_ZC', unit: 'cycles / rad', spec: '§5.1', ch: 'Ch6' },
  // ---- §6 quantizers
  { tex: 'Q_{FB},\\ Q_{INJ}', ascii: 'Q_FB Q_INJ quantizer', zh: 'final phase quantizer instance(floor / nearest / truncate / ef1 / mash11 / mash111)', unit: '無因次', spec: '§6', ch: 'Ch5' },
  { tex: 'e\\ (\\text{ef1 state})', ascii: 'dsm_state ef1 state e', zh: 'error-feedback DSM 殘差 state ∈ [0,1)(v = u + e;y = ⌊v⌋;e = v − y)', unit: 'LSB', spec: '§6', ch: 'Ch11' },
  { tex: '\\mathrm{dsm\\_out}[k]', ascii: 'dsm_out', zh: 'quantizer 每拍整數輸出(full:= A_FB;dsm_only:整數 cycle 數 Q(A_ideal/G))', unit: 'LSB 或 cycle', spec: '§6, §7.1', ch: 'Ch11' },
  // ---- §7 architecture modes
  { tex: 'R_{INJ}[k]', ascii: 'R_INJ', zh: 'injection fine code ∈ {0..255};Mode D:(R_zero − R_FB) mod 256', unit: 'LSB', spec: '§7', ch: 'Ch7' },
  { tex: 'P[k]', ascii: 'P master accumulator P_state', zh: 'shared master accumulator state = A_ideal[k](mode C/D 兩路共用的真值)', unit: 'LSB', spec: '§7', ch: 'Ch8' },
  { tex: 'e_{pair}[k]', ascii: 'e_pair e_pair_digital e_pair_analog', zh: '成對反向誤差 = wrapCycles(u_FB_actual + u_INJ_actual − u_zero_offset);digital / analog 兩層', unit: 'cycles', spec: '§7', ch: 'Ch8' },
  { tex: 'u_{zero\\_offset} = R_{zero}/G', ascii: 'u_zero_offset', zh: 'pair 誤差的 digital 零點', unit: 'cycles', spec: '§7', ch: 'Ch8' },
  // ---- §8 tap + DTC decode
  { tex: 'j[k]', ascii: 'j_INJ tap index', zh: '選中 injection tap index ∈ {0..7}', unit: 'code', spec: '§8', ch: 'Ch7' },
  { tex: 'c[k]', ascii: 'c_INJ', zh: 'injection DTC code ∈ {0..63}(range 64 LSB = 2× tap spacing → redundancy)', unit: 'code', spec: '§8', ch: 'Ch7' },
  { tex: 'u_{INJ,digital}[k]', ascii: 'u_INJ_digital', zh: '= wrap01((32j + c)/256)', unit: 'cycles', spec: '§8', ch: 'Ch7' },
  { tex: 'u_{INJ,analog}[k]', ascii: 'u_INJ_analog u_INJ_actual', zh: '含 analog 誤差的 injection phase = tap_actual[j] + DTC_actual(c) + route_INJ', unit: 'cycles', spec: '§8, §10', ch: 'Ch7' },
  { tex: 'e_{INJ,abs}[k]', ascii: 'e_INJ_abs', zh: 'injection absolute 誤差 = wrapCycles(u_INJ_digital − u_INJ_ideal)', unit: 'cycles', spec: '§9', ch: 'Ch7' },
  // ---- §10 analog non-idealities
  { tex: 'g_{FB},\\ g_{INJ}', ascii: 'g_FB g_INJ dtc gain', zh: 'DTC gain error(1% × 20 ps range → 最大 200 fs ≈ 0.64 LSB)', unit: '無因次', spec: '§10', ch: 'Ch15' },
  { tex: 'route_{FB},\\ route_{INJ}', ascii: 'route_FB route_INJ route skew', zh: 'route skew(固定 delay,正值)', unit: 'cycles', spec: '§10', ch: 'Ch15' },
  { tex: '\\sigma_{ref},\\ \\sigma_{pulse}', ascii: 'sigma_ref sigma_pulse jitter', zh: 'reference / injection pulse timing jitter(rms,white)', unit: 's', spec: '§10', ch: 'Ch15' },
  { tex: '\\sigma_{vco,w},\\ \\sigma_{vco,rw}', ascii: 'sigma_vco_w sigma_vco_rw', zh: 'VCO white / random-walk phase noise 強度', unit: 'rad, rad/√cycle', spec: '§10', ch: 'Ch13' },
  // ---- §13 latency
  { tex: 'L', ascii: 'L latency_cycles lookahead', zh: 'pipeline latency:cycle k 算的 command 於 k+L apply;look-ahead 用 x[k+L] = wrap01(x[k] + Lα)', unit: 'ref cycles', spec: '§13', ch: 'Ch12' },
  // ---- §14 injection dynamics
  { tex: '\\theta_{-}[k],\\ \\theta_{+}[k]', ascii: 'theta theta_minus theta_plus', zh: 'injection 前/後 residual phase(deterministic trajectory 已移除)', unit: 'rad', spec: '§14', ch: 'Ch13' },
  { tex: '\\Delta f', ascii: 'delta_f detuning', zh: 'VCO free-running detuning(相對 N·f_ref)', unit: 'Hz', spec: '§14', ch: 'Ch13' },
  { tex: 'K_{inj}', ascii: 'K_inj k_inj', zh: 'injection 強度 ∈ [0,1](linear / sin map 的 kick 增益)', unit: '無因次', spec: '§14', ch: 'Ch13' },
  { tex: 'e_{ZC,hw}[k],\\ \\varepsilon_{hw}[k]', ascii: 'e_ZC_hw epsilon_hw', zh: 'deterministic hardware scheduling 誤差 = wrapCycles(x_ideal + u_INJ_analog − z0);ε_hw = 2π e_ZC_hw;gating 判準', unit: 'cycles / rad', spec: '§5.1, §14', ch: 'Ch6' },
  { tex: 'e_{inj}[k]', ascii: 'e_inj', zh: 'pulse 當下實際看到的總誤差 = wrapRadians(θ_− + ε_hw)(含 noise)', unit: 'rad', spec: '§14', ch: 'Ch13' },
  { tex: '\\Delta\\theta[k]', ascii: 'delta_theta kick', zh: 'injection phase kick(reset:−e_inj;linear:−K_inj e_inj;sin:−K_inj sin(e_inj))', unit: 'rad', spec: '§14', ch: 'Ch13' },
  { tex: 'e_{ZC,total}[k]', ascii: 'e_ZC_total', zh: '最終 zero-crossing 誤差(含 dynamics 與 noise)= e_inj/(2π)', unit: 'cycles', spec: '§14, §16', ch: 'Ch6' },
  { tex: '\\mathrm{inj\\_fired}[k]', ascii: 'inj_fired inj_gate', zh: '該拍是否施打 pulse(gating;threshold mode:|e_ZC_hw| ≤ 門檻才 fire)', unit: '0/1', spec: '§14', ch: 'Ch13' },
  // ---- §15 shorting proxy
  { tex: 'v_d,\\ V_p', ascii: 'v_d V_p', zh: 'differential 波形與峰值(shorting 能量 proxy 用)', unit: 'V', spec: '§15', ch: 'Ch14' },
  { tex: '\\varepsilon_t', ascii: 'epsilon_t', zh: 'shorting 時刻的 timing 誤差', unit: 's', spec: '§15', ch: 'Ch14' },
  { tex: 'E_{short,norm}', ascii: 'E_short E_short_norm', zh: 'normalized shorting energy proxy = sin²(2π ε_t/T_vco)(非真實能量)', unit: '無因次', spec: '§15', ch: 'Ch14' },
];

export default function Chapter02() {
  const [alpha, setAlpha] = useChapterAlpha();
  const [kShow, setKShow] = useState(4);
  const [notationFilter, setNotationFilter] = useState('');
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const nDiv = 3 + alpha;
  const res = useMemo(() => simulate(fromPartial({ n_div: nDiv, n_cycles: 16 })), [nDiv]);
  const tv = res.t_vco_s;
  const tVcoPs = res.t_vco_s / 1e-12;
  const tRefPs = res.t_ref_s / 1e-12;

  useEffect(() => {
    setStatus('done', `EdgeTimeline:N=${trimNumber(nDiv, 6)}, 16 cycles`);
  }, [res, nDiv, setStatus]);

  /* ------------------------- figure: wrap01 vs wrapCycles over a number line */
  const wrapOption = useMemo(() => {
    const w01: [number, number][] = [];
    const wc: [number, number][] = [];
    for (let i = 0; i <= 400; i++) {
      const x = -2 + i * 0.01;
      w01.push([x, wrap01(x)]);
      wc.push([x, wrapCycles(x)]);
    }
    return makeLineOption({
      xLabel: 'x(cycles,未 wrap)',
      yLabel: 'wrapped value(cycles)',
      series: [
        { name: 'wrap01(x) ∈ [0,1)', data: w01, color: ct.accent, width: 2 },
        { name: 'wrapCycles(x) ∈ (−0.5,0.5]', data: wc, color: ct.series[1], width: 2 },
      ],
      zoom: false,
      yMin: -0.6,
      yMax: 1.05,
    });
  }, [ct]);

  /* --------------------------------- figure #4: EdgeTimeline rows (unit ps) */
  const timeline = useMemo(() => {
    const d = res.data;
    const tMax = kShow * tRefPs;
    const refEdges = [];
    const vcoEdges = [];
    const fbEdges = [];
    const injEdges = [];
    for (let k = 0; k <= kShow && k < d.k.length; k++) {
      refEdges.push({ t: k * tRefPs, tag: `k=${k}`, color: ct.accent });
      // t_FB_actual = s_FB_actual * T_vco = (A_FB / G) * T_vco   (MODEL_SPEC §4)
      fbEdges.push({ t: (d.A_FB[k] / res.g) * tVcoPs, tag: `k=${k}`, color: ct.series[1] });
      // injection pulse: ref edge + u_INJ_digital * T_vco  (lands on VCO grid)
      injEdges.push({
        t: k * tRefPs + d.u_INJ_digital[k] * tVcoPs,
        tag: `k=${k}`,
        color: ct.series[2],
      });
    }
    const nVco = Math.floor(tMax / tVcoPs);
    for (let m = 0; m <= nVco; m++) {
      vcoEdges.push({ t: m * tVcoPs, color: ct.textSubtle });
    }
    const rows: TimelineRow[] = [
      { label: 'REF(4 GHz)', edges: refEdges },
      { label: 'VCO grid', edges: vcoEdges },
      { label: 'FB edge', edges: fbEdges },
      { label: 'INJ pulse', edges: injEdges },
    ];
    return { tMax, rows };
  }, [res, kShow, ct, tRefPs, tVcoPs]);

  /* ------------------------------------- notation table client-side filter */
  const notationRows = useMemo(() => {
    const q = notationFilter.trim().toLowerCase();
    if (q === '') return NOTATION;
    const terms = q.split(/\s+/);
    return NOTATION.filter((r) => {
      const hay = `${r.ascii} ${r.zh} ${r.unit} ${r.spec} ${r.ch}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [notationFilter]);

  /* ------------------------------------------------ cycle-by-cycle table */
  const tableRows = useMemo(() => {
    const d = res.data;
    const rows: Record<string, unknown>[] = [];
    for (let k = 0; k < Math.min(8, d.k.length); k++) {
      rows.push({
        k,
        t_ref_ps: k * tRefPs,
        x_ideal: d.x_ideal[k],
        A_FB: d.A_FB[k],
        t_FB_ps: (d.A_FB[k] / res.g) * tVcoPs,
        u_INJ_digital: d.u_INJ_digital[k],
        t_INJ_ps: k * tRefPs + d.u_INJ_digital[k] * tVcoPs,
        e_FB_abs: d.e_FB_abs[k],
      });
    }
    return rows;
  }, [res, tRefPs, tVcoPs]);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>為什麼內部 phase 單位一律用 VCO cycles(而不是秒、度或 radians)?</li>
          <li>
            <M>{'\\operatorname{wrap01}'}</M> / <M>{'\\operatorname{wrapCycles}'}</M> /{' '}
            <M>{'\\operatorname{wrapRadians}'}</M> 差在哪裡?何時用哪一個?
          </li>
          <li>error 與 delay 的正負號慣例是什麼?負號寫在哪裡?</li>
          <li>為什麼禁止使用語言內建的 round()?</li>
          <li>ref / VCO / feedback / injection 四種 edge 在時間軸上實際落在哪裡?</li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          所有硬體步階都是 <M>{'T_{vco}'}</M> 的簡單分數:injection tap = 1/8 cycle、PMUX =
          1/4 cycle、DTC LSB = 1/256 cycle。以 VCO cycles 為內部單位,這些量全部變成常數
          (1/8、1/4、1/256),與 <M>{'N'}</M> 無關;換成秒或度,每改一次頻率所有常數都要重算。
          換算(<M>{'\\times T_{vco}'}</M>、<M>{'\\times 360^\\circ'}</M>)只在顯示時做。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>
          Phase 是圓上的量,同一個點有無限多種座標表示。<M>{'\\operatorname{wrap01}'}</M>{' '}
          回答「<strong>位置</strong>在哪」(圓上絕對位置,<M>{'[0,1)'}</M>);
          <M>{'\\operatorname{wrapCycles}'}</M> 回答「<strong>差多遠</strong>」
          (帶符號的最短弧長,<M>{'(-0.5, 0.5]'}</M>)。下方 wheel:+0.7 與 −0.3 是同一個點 —
          當它是誤差時,我們要的是「往回 0.3」而不是「往前 0.7」。
        </p>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <PhaseWheel
            size={240}
            markers={[{ angleCycles: 0.7, label: '0.7 ≡ −0.3', color: ct.accent }]}
            arcs={[
              { fromCycles: 0, toCycles: 0.7, color: ct.series[1], r: 0.5 },
              { fromCycles: 0.7, toCycles: 1.0, color: ct.accent, r: 0.72 },
            ]}
            title="同一點的兩種表示:順時針 +0.7(外弧的補)vs 逆時針 −0.3;wrapCycles 取短的那段"
          />
        </div>
      </SectionIntuition>

      <SectionMath>
        <p>單位恆等式(內部一律 float64 cycles,顯示時才換算):</p>
        <MathBlock>{'1\\ \\text{cycle} = 2\\pi\\ \\text{rad} = T_{vco}\\ \\text{s} = 360^\\circ'}</MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> 三個 wrap(MODEL_SPEC §2,Python 與 TypeScript
          必須逐字元同義實作):
        </p>
        <MathBlock>{'\\operatorname{wrap01}(x) = x - \\lfloor x \\rfloor \\;\\in [0, 1)'}</MathBlock>
        <MathBlock>{'\\operatorname{wrapCycles}(x) = \\begin{cases} y, & y \\le 0.5 \\\\ y - 1, & y > 0.5 \\end{cases} \\quad y = x - \\lfloor x \\rfloor, \\;\\in (-0.5, 0.5]'}</MathBlock>
        <MathBlock>{'\\operatorname{wrapRadians}(t) = 2\\pi \\operatorname{wrapCycles}\\!\\left(\\tfrac{t}{2\\pi}\\right) \\;\\in (-\\pi, \\pi]'}</MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> 量化 primitives(注意都是 floor 形式,不用內建
          round):
        </p>
        <MathBlock>{'\\operatorname{qFloor}(x) = \\lfloor x \\rfloor, \\qquad \\operatorname{qNearest}(x) = \\lfloor x + 0.5 \\rfloor \\;\\text{(half-up)}'}</MathBlock>
        <p>符號慣例(全站 binding):<EpistemicTag kind="EXACT" /></p>
        <ul>
          <li>
            phase <strong>增加</strong> = 時間上<strong>較晚</strong>的 edge(later edge)。
          </li>
          <li>
            所有 error 一律 <M>{'e = \\text{actual} - \\text{ideal}'}</M>,並以{' '}
            <M>{'\\operatorname{wrapCycles}'}</M> 取帶符號最短表示,例如{' '}
            <M>{'e_{FB,abs}[k] = \\operatorname{wrapCycles}(s_{FB,actual}[k] - s_{ideal}[k])'}</M>。
          </li>
          <li>
            delay(DTC、route)是<strong>正</strong>的 phase 增量:code 越大、edge 越晚。
          </li>
          <li>
            error feedback / kick 的負號<strong>寫在公式裡</strong>,不藏在變數定義中,如{' '}
            <M>{'\\Delta\\theta = -K_{inj}\\sin(e_{inj})'}</M>(Ch13)。
          </li>
        </ul>
      </SectionMath>

      <SectionExample>
        <p>
          規定的數值例:<M>{'\\operatorname{wrapCycles}(0.7)'}</M>。步驟:
          <M>{'y = 0.7 - \\lfloor 0.7 \\rfloor = 0.7'}</M>;因 <M>{'y > 0.5'}</M>,取{' '}
          <M>{'y - 1 = -0.3'}</M>。模型即時計算:
          <code> wrapCycles(0.7) = {trimNumber(wrapCycles(0.7), 6)}</code>(顯示為{' '}
          {formatPhase(wrapCycles(0.7), unit, tv, 6)};單位切換:<UnitSwitch />)。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>更多樣本點(全部由 ../model 的 wrap01 / wrapCycles 即時計算):</p>
        <table>
          <thead>
            <tr>
              <th>x</th>
              {WRAP_SAMPLES.map((x) => (
                <th key={x}>{trimNumber(x, 4)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>wrap01(x)</td>
              {WRAP_SAMPLES.map((x) => (
                <td key={x}>{trimNumber(wrap01(x), 4)}</td>
              ))}
            </tr>
            <tr>
              <td>wrapCycles(x)</td>
              {WRAP_SAMPLES.map((x) => (
                <td key={x}>{trimNumber(wrapCycles(x), 4)}</td>
              ))}
            </tr>
          </tbody>
        </table>
        <p>
          注意邊界:<M>{'\\operatorname{wrapCycles}(0.5) = +0.5'}</M>(區間右閉),
          <M>{'\\operatorname{wrapCycles}(-0.5) = +0.5'}</M>;而{' '}
          <M>{'\\operatorname{wrap01}(-0.3) = 0.7'}</M> 與{' '}
          <M>{'\\operatorname{wrapCycles}(-0.3) = -0.3'}</M> 指同一個圓上點,但作為
          「誤差」只有後者是對的讀法。
        </p>
        <p>
          內建 round() 的 tie 行為(這就是禁用的原因;qNearest 欄由 ../model 即時計算,
          Python 欄為 CPython round-half-to-even 的文件行為 <EpistemicTag kind="EXACT" />):
        </p>
        <table>
          <thead>
            <tr>
              <th>u</th>
              <th>Python round(u)(banker's)</th>
              <th>JS Math.round(u)(half-up)</th>
              <th>qNearest(u) = floor(u+0.5)</th>
            </tr>
          </thead>
          <tbody>
            {ROUND_TIES.map(({ u, py }) => (
              <tr key={u}>
                <td>{u}</td>
                <td>{py}</td>
                <td>{qNearest(u)}</td>
                <td>{qNearest(u)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Python 在 .5 的 tie 上取<strong>偶數</strong>(round(0.5)=0、round(2.5)=2),JS 取
          half-up — 同一份 ideal code 序列在兩語言會量化出<strong>不同的整數 command</strong>,
          test vector 逐位比對必然失敗。qNearest = floor(u+0.5) 在兩語言完全一致,所以
          MODEL_SPEC 規定所有 nearest 量化只能用它。
        </p>
      </SectionExample>

      <SectionFigure
        title="wrap01 vs wrapCycles(數線上的 wrap 行為)"
        caption={
          <span>
            x 軸:未 wrap 的輸入(cycles);y 軸:wrap 後的值。wrap01 是週期 1 的鋸齒,值域{' '}
            <M>{'[0,1)'}</M>;wrapCycles 同樣週期 1,但在 x 的小數部分超過 0.5 時跳到負半邊,
            值域 <M>{'(-0.5, 0.5]'}</M>。垂直線段是跳變處(不是實際取值)。
          </span>
        }
      >
        <EChart option={wrapOption} height={280} />
      </SectionFigure>

      <SectionFigure
        title="互動圖 #4 — EdgeTimeline:ref / VCO / feedback / injection edges"
        caption={
          <span>
            單位:ps(time 是顯示單位;內部全為 cycles)。REF 列:<M>{'k T_{ref}'}</M>(250 ps
            間距);VCO grid 列:<M>{'m T_{vco}'}</M>(VCO 整數-cycle 邊界,即理想 zero
            crossings);FB edge 列:<M>{'t_{FB} = (A_{FB}/G)\\, T_{vco}'}</M>(來自 simulate()
            的 A_FB 欄);INJ pulse 列:<M>{'k T_{ref} + u_{INJ,digital}\\, T_{vco}'}</M>。
            滑鼠移到任一 edge 顯示精確時間;右側可調 <M>{'N'}</M> 與顯示拍數。
          </span>
        }
      >
        <EdgeTimeline
          rows={timeline.rows}
          tMax={timeline.tMax}
          unitLabel="ps"
          rowHeight={38}
        />
      </SectionFigure>

      <SectionFigure
        title="符號對照表 Notation table:全站符號 ↔ MODEL_SPEC ↔ 章節"
        caption={
          <span>
            全站(Ch0–Ch20)使用的符號、意義、單位、定義所在的 MODEL_SPEC 節與首次出現章。
            過濾框做 client-side 比對:對 ASCII 名(即程式碼 / test-vector 欄名,如{' '}
            <code>e_pair</code>、<code>e_ZC_hw</code>)、中文意義、單位、spec 節(如 §14)與章號
            (如 Ch13)取子字串,多個關鍵字以空白分隔為 AND。定義全部引自 MODEL_SPEC
            (本表不新增數學);單位欄為該符號的自然顯示單位,內部計算一律 float64 cycles(§2)。
            <EpistemicTag kind="EXACT" />
          </span>
        }
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <input
            type="search"
            value={notationFilter}
            onChange={(e) => setNotationFilter(e.target.value)}
            placeholder="過濾:符號 / 意義 / 單位 / §節 / 章,如 e_pair、rad、§14、Ch13"
            aria-label="符號過濾"
            style={{
              flex: '1 1 300px',
              maxWidth: 460,
              background: 'var(--bg)',
              color: 'var(--fg)',
              border: '1px solid var(--border-strong)',
              borderRadius: 4,
              padding: '5px 9px',
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
            }}
          />
          <span style={{ fontSize: '0.85rem', color: 'var(--fg-subtle)' }}>
            顯示 {notationRows.length} / {NOTATION.length} 個符號
          </span>
        </div>
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 480, marginTop: 10 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>符號</th>
                <th>意義</th>
                <th>單位</th>
                <th>MODEL_SPEC</th>
                <th>首次出現</th>
              </tr>
            </thead>
            <tbody>
              {notationRows.map((r) => (
                <tr key={r.ascii}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <M>{r.tex}</M>
                  </td>
                  <td>{r.zh}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.unit}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.spec}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.ch}</td>
                </tr>
              ))}
              {notationRows.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ color: 'var(--fg-subtle)' }}>
                    無符合「{notationFilter}」的符號;試試 ASCII 欄名(e_pair、u_INJ_ideal)或
                    §節號。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model/phaseMath.ts(真實碼節錄)"
        code={PHASE_MATH_SRC}
      >
        <p>
          這四個函式是全模型的地基:Python 版(model/python/phase_math.py)與此檔逐字元同義,
          test vectors 以 |diff| ≤ 1e-12(整數 code 完全相等)交叉驗證。
          <EpistemicTag kind="EXACT" />
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'return x - Math.floor(x);',
            explain: (
              <span>
                wrap01:對任何實數(含負數)回到 <M>{'[0,1)'}</M>。floor 是唯一用到的取整,
                對負輸入行為兩語言一致(Python 的 <code>math.floor</code> 同義)。
              </span>
            ),
          },
          {
            code: 'let y = x - Math.floor(x);',
            explain: (
              <span>
                wrapCycles 第一步與 wrap01 相同:先取絕對位置 <M>{'y \\in [0,1)'}</M>。
              </span>
            ),
          },
          {
            code: 'if (y > 0.5) {\n  y -= 1.0;\n}',
            explain: (
              <span>
                嚴格大於 0.5 才減 1 — 這個不等號決定值域是 <M>{'(-0.5, 0.5]'}</M>
                (右閉):0.5 屬於正半邊。若寫成 <code>&gt;=</code>,兩語言邊界值就會分歧。
              </span>
            ),
          },
          {
            code: 'return TWO_PI * wrapCycles(t / TWO_PI);',
            explain: (
              <span>
                wrapRadians 不另寫演算法,直接以 cycles 版為準換算 — 單一實作、單一真值,
                值域 <M>{'(-\\pi, \\pi]'}</M>。
              </span>
            ),
          },
          {
            code: "* NEVER use a language round() (Python round is banker's rounding) —",
            explain: (
              <span>
                註解即規格:Python 內建 round 是 round-half-to-even,JS Math.round 是
                half-up(往 +∞),tie 上結果不同(見上表)。跨語言 bit-exact 的模型
                <strong>禁止</strong>兩者。
              </span>
            ),
          },
          {
            code: 'return Math.floor(x + 0.5);',
            explain: (
              <span>
                qNearest 的實作:half-up 以 floor 表達,兩語言逐位一致;qNearest(2.5)=3、
                qNearest(86.272)=86(Ch5 的 0.337 例即用此式)。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            <strong>FB edge 貼著 REF</strong>:<M>{'s_{ideal}[k] T_{vco} = kNT_{vco} = kT_{ref}'}</M>,
            所以理想上每拍的 feedback edge 與 reference edge 重合。<M>{'N=3.125'}</M>(on-grid)
            時 hover 讀值是精確的 250、500、750 ps;切到 <M>{'N=3.13'}</M> 後讀值偏離不超過
            half-LSB(±156 fs 量級,肉眼不可見,hover 才看得到)。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            <strong>INJ pulse 落在 VCO grid 上</strong>:injection 的目的就是在 VCO 整數-cycle
            邊界(zero crossing)放 pulse — INJ 列的每根 edge 都與 VCO grid 列的某根對齊
            (off-grid α 時差一個量化誤差)。
          </li>
          <li>
            <strong>反向排程看 INJ 在每個 ref 週期內的相對位置</strong>:相對位置 ={' '}
            <M>{'u_{INJ}'}</M>,每拍遞減 α(mod 1)— 與 x_ideal 每拍 +α 恰為鏡像。α=0.125 時
            序列為 0, 0.875, 0.75, 0.625, …。
          </li>
          <li>
            VCO grid 間距 = <M>{'T_{vco}'}</M>:把 N 從 3.000 掃到 3.250,間距從 83.3 ps 縮到
            76.9 ps,每個 T_ref 內的 VCO edge 數在 3 與 4 之間交替(這就是 /3-/4 的來源,Ch4)。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解:「wrap01 與 wrapCycles 差不多,選一個用就好」">
          <p>
            錯。兩者只在 <M>{'[0, 0.5]'}</M> 上相等。把誤差用 wrap01 表示會把「早 0.3 cycle」
            讀成「晚 0.7 cycle」:均值、RMS、頻譜全部失真,而且丟掉符號後無法判斷 error
            該往哪邊修。規則:<strong>位置/command 用 wrap01</strong>(如{' '}
            <M>{'u_{INJ,ideal}'}</M>),<strong>誤差用 wrapCycles</strong>(如{' '}
            <M>{'e_{FB,abs}, e_{pair}, e_{ZC}'}</M>)。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解:「round 到最近整數,哪個語言都一樣」">
          <p>
            錯。Python round(2.5)=2、JS Math.round(2.5)=3。fractional-N scheduler 的 ideal
            code 常常正好落在 .5(例如 α=0.125 時 <M>{'A_{ideal}'}</M> 逐拍 +800、fine code
            R 逐拍 +32,任何 .5 的 offset 都會系統性出現),tie 行為不同 → 兩語言產生不同的 command 序列 →
            golden model 交叉驗證直接失敗。這不是浮點誤差,是定義不同。
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>
            內部單位凍結為 VCO cycles(float64),換算只在顯示層 — 本站所有圖的單位切換
            (cycles/deg/time)都不改變底層資料。
          </li>
          <li>
            位置用 wrap01、誤差用 wrapCycles、radians 只在 dynamics(Ch13)介面出現;
            三者的值域與邊界(右閉)是規格的一部分。
          </li>
          <li>
            <M>{'e = \\text{actual} - \\text{ideal}'}</M>、delay 為正、負號寫在公式裡 —
            這三條讓 20 章的每個 error plot 符號可直接比對。
          </li>
          <li>
            量化一律 qFloor / qNearest(floor 形式):跨語言 bit-exact 是 test vector
            方法論(Ch18)的前提。
          </li>
          <li>
            全站符號索引在本章的<strong>符號對照表</strong>:每個符號對回定義它的 MODEL_SPEC
            節與首次出現章;後面章節遇到不認識的符號,回這裡用 ASCII 欄名或 §節號過濾即可。
          </li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            EdgeTimeline 畫的是 <strong>digital-exact 的理想時刻</strong>:edge 為零寬度的
            瞬時事件,reference jitter、DTC analog 誤差、injection pulse 寬度都未畫入
            (本圖 config 全為預設,noise 全關)。FB/INJ edge 的 ps 讀值顯示到 6 位有效數字,
            sub-fs 的浮點尾數不顯示。actual zero-crossing 含 analog 誤差的版本見 Ch14 圖 #15。
          </p>
        </Callout>
      </SectionLimitation>

      <DebugTable
        columns={[
          { key: 'k', label: 'k' },
          { key: 't_ref_ps', label: 't_ref (ps)', fmt: (v) => trimNumber(v as number, 6) },
          { key: 'x_ideal', label: 'x_ideal', fmt: (v) => trimNumber(v as number, 6) },
          { key: 'A_FB', label: 'A_FB' },
          { key: 't_FB_ps', label: 't_FB (ps)', fmt: (v) => trimNumber(v as number, 8) },
          { key: 'u_INJ_digital', label: 'u_INJ', fmt: (v) => trimNumber(v as number, 6) },
          { key: 't_INJ_ps', label: 't_INJ (ps)', fmt: (v) => trimNumber(v as number, 8) },
          {
            key: 'e_FB_abs',
            label: 'e_FB_abs',
            fmt: (v) => formatPhase(v as number, unit, tv, 4),
          },
        ]}
        rows={tableRows}
        exportName="ch2_edge_times.csv"
      />

      <ParamPanel title="參數">
        <Slider
          label="α(N = 3 + α)"
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
        <Slider
          label="顯示 ref cycles"
          value={kShow}
          min={2}
          max={8}
          step={1}
          onChange={setKShow}
        />
      </ParamPanel>
    </ChapterShell>
  );
}
