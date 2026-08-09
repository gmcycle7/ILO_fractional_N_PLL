/**
 * Chapter 19 — Verilog-A Model
 * 四個 .va 模組的用途/ports/parameters、VERILOGA_USAGE.md 重點、CSV 驅動法、
 * simulator-dependent constructs、bring-up 順序,以及誠實聲明(未跑 Spectre)。
 * .va 摘錄均逐字取自 model/veriloga/。
 */

import { useEffect, useMemo, useState } from 'react';
import { useChapterNDiv } from '../lib/globalParams';
import {
  ChapterShell, SectionQuestion, SectionIntuition, SectionMath, SectionExample,
  SectionFigure, SectionCode, SectionLineByLine, SectionObserve,
  SectionMisconception, SectionTakeaway, SectionLimitation,
} from '../components/ChapterShell';
import EChart from '../components/EChart';
import EpistemicTag from '../components/EpistemicTag';
import Callout from '../components/Callout';
import { M, MathBlock } from '../components/Math';
import { ParamPanel, SelectControl, Slider, Toggle, PresetButtons } from '../components/controls';
import DebugTable from '../components/DebugTable';
import { makeLineOption } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { trimNumber } from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import { simulate, fromPartial } from '../model';
import type { Quantizer } from '../model';

const meta = chapterById(19)!;

/** 四個 .va 模組總表(對應 VERILOGA_USAGE.md「Files」)。 */
const VA_MODULES: { file: string; purpose: string; spec: string }[] = [
  {
    file: 'fractional_phase_scheduler.va',
    purpose:
      'Feedback-path scheduler:每個 ref rising edge 輸出 divider modulus n_int、' +
      'PMUX code m_FB、DTC code c_FB(exact digital model;n_int 用一步 look-ahead 量化取得)',
    spec: '§3–4, §6, §13',
  },
  {
    file: 'reverse_injection_scheduler.va',
    purpose:
      'Injection-path scheduler:R_INJ = (R_zero − R_FB) mod 256(Mode D shared code)' +
      '或獨立 re-quantization(Mode A);tap/DTC decode;pipeline latency shift register',
    spec: '§5–8, §13',
  },
  {
    file: 'pulsed_injection_phase_model.va',
    purpose:
      'Behavioral ILO:free-running VCO phase(idtmod),每個 injection trigger edge ' +
      '施加 Δθ = −K_inj·sin(e_inj)(或 linear / ideal-reset)的 phase kick',
    spec: '§14, §15',
  },
  {
    file: 'dtc_nonideal_model.va',
    purpose:
      '非理想 DTC delay line:gain/offset/sinusoidal INL/polynomial INL/per-tap skew;' +
      '上升沿取樣 code、以 transition() 變動延遲重播 edge',
    spec: '§10–11',
  },
];

/** Port 表(逐模組;faithful to VERILOGA_USAGE.md)。 */
const PORT_TABLES: { module: string; rows: [string, string, string, string][] }[] = [
  {
    module: 'fractional_phase_scheduler',
    rows: [
      ['ref_clk', 'in', 'analog edge(vth)', 'reference clock,只用 rising edge'],
      ['n_int_out', 'out', 'code × v_per_code', 'divider modulus;floor/nearest 為 {3,4},ef1 暫態允許 {2..5}'],
      ['m_fb_out', 'out', 'code × v_per_code', 'PMUX code 0..3'],
      ['c_fb_out', 'out', 'code × v_per_code', 'feedback DTC code 0..63'],
      ['s_ideal_out', 'out', '1 V/cycle', 'debug:s_ideal[k],無界成長(勿 lint 該節點)'],
      ['x_frac_out', 'out', '1 V/cycle', 'debug:wrap01(s_ideal[k])'],
      ['r_fb_out', 'out', 'code × v_per_code', 'debug:R_FB[k] 0..255 → 接 reverse scheduler 的 r_fb_in'],
    ],
  },
  {
    module: 'reverse_injection_scheduler',
    rows: [
      ['ref_clk', 'in', 'analog edge', 'compute/apply clock'],
      ['r_fb_in', 'in', 'code × v_per_code', 'R_FB[k](僅 shared_mode=1 讀取;否則接地)'],
      ['j_inj_out', 'out', 'code × v_per_code', 'injection tap select 0..7'],
      ['c_inj_out', 'out', 'code × v_per_code', 'injection DTC code 0..63'],
      ['r_inj_out', 'out', 'code × v_per_code', 'debug:applied R_INJ 0..255'],
      ['u_inj_out', 'out', '1 V/cycle', 'debug:u_INJ_digital = (32j+c)/256 mod 1'],
    ],
  },
  {
    module: 'pulsed_injection_phase_model',
    rows: [
      ['inj_in', 'in', 'analog edge(vth_trig)', 'injection trigger(每 T_ref 一顆 pulse)'],
      ['vco_out', 'out', 'volts', 'VCO 輸出:sine(out_mode=0)或 square(out_mode=1)'],
      ['e_inj_dbg', 'out', '1 V/rad', 'debug:最近一次取樣的 e_inj'],
      ['dtheta_dbg', 'out', '1 V/rad', 'debug:最近一次施加的 Δθ'],
      ['theta_dbg', 'out', '1 V/rad', 'debug:累積 kick offset,wrap 到 (−π, π]'],
    ],
  },
  {
    module: 'dtc_nonideal_model',
    rows: [
      ['trig_in', 'in', 'analog edges', '要延遲的 edge/pulse'],
      ['code_in', 'in', 'code × v_per_code', 'DTC code 0..63,rising edge 時取樣'],
      ['tap_sel_in', 'in', 'code × v_per_code', 'tap select 0..7(use_tap=1 才用;否則接地)'],
      ['trig_out', 'out', 'vlo/vhi', '延遲後的 edge/pulse(fall 用同一顆 captured delay)'],
    ],
  },
];

/** 主要 parameters(節選;完整表在 VERILOGA_USAGE.md)。 */
const PARAM_TABLES: { module: string; rows: [string, string, string, string][] }[] = [
  {
    module: 'fractional_phase_scheduler',
    rows: [
      ['n_int_base / alpha / s0', '3 / 0.13 / 0.0', '– / cycles / cycles', 'N = n_int_base + α;preset α:0 / .125 / .13 / .1375 / .25'],
      ['b_dtc', '6', 'bits', 'G = 4·2^b_dtc = 256'],
      ['q_mode', '1', '–', '0=floor, 1=nearest(half-up floor(u+0.5)), 2=ef1;mash11/dither 為 Python-only'],
      ['f_ref', '4.0e9', 'Hz', '資訊性參數 — 實際 timing 來自 ref_clk 波形'],
      ['vth / v_per_code / t_tran', '0.5 / 1.0 / 1e-12', 'V / V/LSB / s', 'threshold、code 編碼、transition ramp'],
    ],
  },
  {
    module: 'reverse_injection_scheduler',
    rows: [
      ['r_zero', '0', 'LSB', 'modular reverse 的 R_zero'],
      ['shared_mode', '1', '–', '1 = Mode D shared code(建議);0 = Mode A 獨立 re-quantization'],
      ['map_mode', '0', '–', '0 = naive floor;1 = nearest phase(tie-break 小 c 再小 j);calibrated 為 Python-only'],
      ['lat_cycles / look_ahead', '0 / 1', 'ref cycles / –', 'L∈{0..8} shift register;look_ahead 僅 independent mode 有意義(0 = bug mode,Test 5)'],
      ['n_int_base, alpha, s0, b_dtc, z0, q_mode', '3, 0.13, 0, 6, 0, 1', '同上', 'independent mode 自建軌跡用'],
    ],
  },
  {
    module: 'pulsed_injection_phase_model',
    rows: [
      ['f0 / delta_f', '12.5e9 / 0.0', 'Hz', '名目 N·f_ref 與 free-running detuning;lock iff |2πΔf·T_ref| ≤ K_inj'],
      ['k_inj / k_scale', '0.3 / 1.0', 'rad/rad / –', 'lumped injection strength(有效 K = k_inj·k_scale)'],
      ['inj_map', '1', '–', '0=linear −K·e、1=sin −K·sin e、2=ideal reset −e;PDR/PRC LUT 為 Python-only'],
      ['pulse_width', '5e-12', 's', '僅文件用途 — kick 是瞬時 phase step(ASSUMPTIONS D1)'],
      ['t_kick / en_bound_step', '1e-13 / 1', 's / –', 'kick 平滑 ramp;$bound_step(0.05/f0) timestep 上限'],
    ],
  },
  {
    module: 'dtc_nonideal_model',
    rows: [
      ['lsb_s', '312.5e-15', 's', 'DTC LSB;normalized 模式手動設 T_vco/256(325.521/312.5/300.481 fs)'],
      ['gain / offset_s', '1.0 / 0.0', '– / s', 'gain error(1.01 → 200 fs canonical check)與靜態 offset(兼作 route skew)'],
      ['inl_sin_amp_s / p2_s / p3_s', '0.0', 's', 'sinusoidal 與 polynomial INL'],
      ['use_tap, tap0..tap7', '0, 0.0', '– / s', 'per-tap skew;1° @80 ps → 222.22e-15(Test 6)'],
      ['t_d_min', '1e-15', 's', 'causality clamp(總延遲下限)'],
    ],
  },
];

/** Simulator-dependent constructs(faithful to VERILOGA_USAGE.md)。 */
const SIMDEP_ROWS: [string, string, string][] = [
  ['array ports / array parameters', '全部避用', 'tap mismatch 攤平為 tap0..tap7 scalars;LUT INL、PDR/PRC LUT 為 Python-only(各家 array 支援差異大)'],
  ['cross() 事件排序', '兩個 scheduler、DTC、ILO', 'LRM 不保證「不同 module 同時刻 cross()」的順序;一律 registered-output/sample-later,testbench 加 clock skew'],
  ['cross() 精度', '所有 edge 偵測', 'edge 時間由內插求得,帶 solver tolerance;數位 identity 仍 exact(float64 state),但 edge timestamp 不是無限精度'],
  ['analog memory(event 內更新的變數)', '所有模組', '標準 Verilog-A,但 initial_step 前初始化、multi-analysis 重跑、save/restart 行為 tool-specific;全部變數在 @(initial_step) 顯式初始化'],
  ['transition() 變動延遲', 'dtc_nonideal_model', '延遲值逐 edge 改變合法,但 pending-event 搶佔行為 tool-specific;pulse 間距 ≥ T_ref、延遲 ≤ ~25 ps 故安全。absdelay() 只能常數延遲,不可用'],
  ['idtmod()', 'pulsed_injection_phase_model', 'solver-owned wrapped integrator;wrap 點事件處理與 tolerance 各家略異(標準 VCO 寫法,但此處未驗證)'],
  ['$bound_step', 'pulsed_injection_phase_model', '普遍但非全面支援;en_bound_step=0 可關閉'],
  ['32-bit integer 溢位', 'edge counter、A_FB', '計數與 absolute code 全存 real(exact 到 2^53);Verilog-A integer 是 32-bit,A_FB ≈ 256·3.13·k 約 2.6e6 edges 就溢位'],
  ['real 沒有 % 運算子', '所有 mod', '一律寫成 a − b·floor(a/b)'],
  ['PRNG parity', '全部', '§12 mulberry32 streams 不實作;$rdist_* 每 timestep 呼叫次數 tool-dependent,刻意不用 → Verilog-A 模型完全 deterministic'],
];

const VA_SCHED_EXCERPT = `// fractional_phase_scheduler.va — @(cross(V(ref_clk)-vth, +1)) 內核(逐字節錄)
s_now      = s0 + k_real * n_frac;
x_frac_val = s_now - floor(s_now);                 // wrap01, spec sec.2

s_next = s0 + (k_real + 1.0) * n_frac;
u_q    = g_units * s_next;                         // A_ideal[k+1]
if      (q_mode == 0) y_q = floor(u_q);            // floor
else if (q_mode == 1) y_q = floor(u_q + 0.5);      // nearest, half-up
else begin                                         // ef1 (spec sec.6)
  v_q = u_q + e_q;
  y_q = floor(v_q);
  e_q = v_q - y_q;
end
a_fb_next = y_q;                                   // A_FB[k+1]

i_curr    = floor(a_fb_curr / g_units);            // I_FB[k]
i_next    = floor(a_fb_next / g_units);            // I_FB[k+1]
n_int_val = i_next - i_curr;                       // divider modulus cmd

r_fb      = a_fb_curr - g_units * floor(a_fb_curr / g_units); // R_FB[k]
m_fb_val  = floor(r_fb / (g_units / 4.0));         // PMUX code 0..3
c_fb_val  = r_fb - (g_units / 4.0)
                 * floor(r_fb / (g_units / 4.0));  // DTC code 0..63

a_fb_curr = a_fb_next;
k_real    = k_real + 1.0;`;

const VA_REVERSE_EXCERPT = `// reverse_injection_scheduler.va — Mode D 分支與 latency pipe(逐字節錄)
if (shared_mode == 1) begin
  // Mode D: shared code, modular reverse (spec sec.7)  [EXACT]
  r_fb_smp = floor(V(r_fb_in) / v_per_code + 0.5);
  if (r_fb_smp < 0.0)           r_fb_smp = 0.0;
  if (r_fb_smp > g_units - 1.0) r_fb_smp = g_units - 1.0;
  // R_INJ = (r_zero - R_FB) mod G ; real-arithmetic mod (a-b*floor(a/b))
  r_now = (r_zero - r_fb_smp)
          - g_units * floor((r_zero - r_fb_smp) / g_units);
end

// ---- 2) latency shift register (spec sec.13) --------------------------
for (i = 8; i >= 1; i = i - 1) pipe[i] = pipe[i-1];
pipe[0] = r_now;
r_apply = pipe[lat_cycles];                 // command APPLIED this edge`;

const VA_KICK_EXCERPT = `// pulsed_injection_phase_model.va — injection kick 事件(逐字節錄)
@(cross(V(inj_in) - vth_trig, +1)) begin
  // --- sample actual VCO phase at the pulse instant --------------------
  phi_tot = phi_cyc + theta_c;                 // cycles (any real)
  // e_cyc = wrapCycles(phi_tot - z0)  -> (-0.5, 0.5]   (spec sec.2)
  e_cyc = (phi_tot - z0) - floor(phi_tot - z0);
  if (e_cyc > 0.5) e_cyc = e_cyc - 1.0;
  e_rad = \`M_TWO_PI * e_cyc;                   // e_inj [rad], (-pi, pi]

  // --- injection response (spec sec.14) --------------------------------
  if      (inj_map == 0) dth_rad = -(k_inj * k_scale) * e_rad;      // lin
  else if (inj_map == 1) dth_rad = -(k_inj * k_scale) * sin(e_rad); // sin
  else                   dth_rad = -e_rad;               // ideal reset

  // --- apply kick: theta_plus = wrapRadians(theta_minus + Delta) -------
  theta_c = theta_c + dth_rad / \`M_TWO_PI;
  theta_c = theta_c - floor(theta_c);          // wrap01 ...
  if (theta_c > 0.5) theta_c = theta_c - 1.0;  // ... then wrapCycles
end`;

const VA_DTC_EXCERPT = `// dtc_nonideal_model.va — 總延遲與變動延遲 transition()(逐字節錄)
t_d = offset_s
    + gain * c_smp * lsb_s
    + inl_sin_amp_s * sin(\`M_TWO_PI * c_smp / n_codes)
    + p2_s * pow(c_smp / (n_codes - 1.0), 2.0)
    + p3_s * pow(c_smp / (n_codes - 1.0), 3.0)
    + tap_d;
if (t_d < t_d_min) t_d = t_d_min;   // causality clamp (see t_d_min)

// ...

V(trig_out) <+ transition((out_state > 0.5) ? vhi : vlo,
                          t_d, t_rise, t_rise);`;

/** Testbench 接線圖(inline SVG,theme tokens)。 */
function TestbenchSvg() {
  const box = { fill: 'var(--bg-panel)', stroke: 'var(--border-strong)', strokeWidth: 1, rx: 4 } as const;
  const accentBox = { ...box, fill: 'var(--accent-soft)', stroke: 'var(--accent)' };
  const label = { fill: 'var(--fg)', fontSize: 11, fontFamily: 'inherit' } as const;
  const sub = { fill: 'var(--fg-subtle)', fontSize: 9.5, fontFamily: 'inherit' } as const;
  const wire = { stroke: 'var(--fg-faint)', strokeWidth: 1.2, fill: 'none', markerEnd: 'url(#ch19-arr)' } as const;
  const wlab = { fill: 'var(--fg-subtle)', fontSize: 9, fontFamily: 'inherit' } as const;
  return (
    <svg viewBox="0 0 780 340" style={{ width: '100%', maxWidth: 880, display: 'block' }} role="img"
      aria-label="Verilog-A testbench hookup">
      <defs>
        <marker id="ch19-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--fg-faint)" />
        </marker>
      </defs>
      {/* ref source */}
      <rect x={10} y={40} width={110} height={44} {...box} />
      <text x={20} y={58} {...label}>ref_clk 源</text>
      <text x={20} y={72} {...sub}>4 GHz pulse src</text>
      {/* fb scheduler */}
      <rect x={170} y={16} width={220} height={92} {...accentBox} />
      <text x={180} y={34} {...label}>fractional_phase_scheduler</text>
      <text x={180} y={49} {...sub}>s_ideal = s0 + k·N;A_FB = Q(256·s)</text>
      <text x={180} y={63} {...sub}>n_int / m_FB / c_FB / r_fb(debug)</text>
      {/* reverse scheduler */}
      <rect x={170} y={150} width={220} height={78} {...accentBox} />
      <text x={180} y={168} {...label}>reverse_injection_scheduler</text>
      <text x={180} y={183} {...sub}>R_INJ = (R_zero − R_FB) mod 256</text>
      <text x={180} y={197} {...sub}>j_INJ / c_INJ;latency pipe L</text>
      {/* dtc fb */}
      <rect x={470} y={16} width={170} height={56} {...box} />
      <text x={480} y={34} {...label}>dtc_nonideal_model(FB)</text>
      <text x={480} y={49} {...sub}>code_in = c_FB</text>
      {/* dtc inj */}
      <rect x={470} y={150} width={170} height={56} {...box} />
      <text x={480} y={168} {...label}>dtc_nonideal_model(INJ)</text>
      <text x={480} y={183} {...sub}>code_in = c_INJ;tap_sel_in = j_INJ</text>
      {/* ILO */}
      <rect x={470} y={252} width={220} height={64} {...accentBox} />
      <text x={480} y={270} {...label}>pulsed_injection_phase_model</text>
      <text x={480} y={285} {...sub}>idtmod(f0+Δf);Δθ = −K·sin(e_inj)</text>
      <text x={480} y={299} {...sub}>vco_out → divider / PMUX / probes</text>
      {/* wires */}
      <line x1={120} y1={62} x2={170} y2={62} {...wire} />
      <path d="M 145 62 L 145 189 L 170 189" {...wire} />
      <text x={126} y={100} {...wlab}>ref_clk(+skew)</text>
      <line x1={390} y1={40} x2={470} y2={40} {...wire} />
      <text x={398} y={34} {...wlab}>c_fb_out</text>
      <line x1={390} y1={62} x2={440} y2={62} {...wire} />
      <text x={398} y={57} {...wlab}>n_int / m_FB → divider, PMUX</text>
      <path d="M 390 96 L 420 96 L 420 164 L 390 164" {...wire} />
      <text x={398} y={124} {...wlab}>r_fb_out → r_fb_in</text>
      <line x1={390} y1={190} x2={470} y2={190} {...wire} />
      <text x={398} y={184} {...wlab}>c_inj / j_inj</text>
      <path d="M 555 206 L 555 252" {...wire} />
      <text x={562} y={232} {...wlab}>trig_out → inj_in</text>
      <path d="M 60 84 L 60 300 L 470 300" {...wire} />
      <text x={70} y={314} {...wlab}>ref_clk(+t_arm)→ DTC(INJ) trig_in(經 DTC 延遲後打 pulse)</text>
    </svg>
  );
}

const N_PRESETS = [3.0, 3.125, 3.13, 3.1375, 3.25];

export default function Chapter19() {
  const [nDiv, setNDiv] = useChapterNDiv();
  const [quant, setQuant] = useState<Quantizer>('nearest');
  const [latency, setLatency] = useState(0);
  const [lookahead, setLookahead] = useState(true);
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const res = useMemo(
    () =>
      simulate(
        fromPartial({
          n_div: nDiv,
          quantizer: quant,
          latency_cycles: latency,
          lookahead,
          n_cycles: 256,
        }),
      ),
    [nDiv, quant, latency, lookahead],
  );

  useEffect(() => {
    setStatus('done', `command vectors: 256 cycles @ N=${nDiv}`);
  }, [res, nDiv, setStatus]);

  const codeOption = useMemo(() => {
    const d = res.data;
    const n = Math.min(64, d.k.length);
    const cFb: [number, number][] = [];
    const cInj: [number, number][] = [];
    const jInj: [number, number][] = [];
    const nInt: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      cFb.push([k, d.c_FB[k]]);
      cInj.push([k, d.c_INJ[k]]);
      jInj.push([k, d.j_INJ[k]]);
      nInt.push([k, d.n_int[k]]);
    }
    return makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: 'code (LSB / tap / modulus)',
      series: [
        { name: 'c_FB (0..63)', data: cFb, step: 'middle', showSymbol: true, symbolSize: 4 },
        { name: 'c_INJ (0..63)', data: cInj, step: 'middle', showSymbol: true, symbolSize: 4 },
        { name: 'j_INJ (0..7)', data: jInj, step: 'middle', showSymbol: true, symbolSize: 4 },
        { name: 'n_int (3/4)', data: nInt, step: 'middle', showSymbol: true, symbolSize: 4, dashed: true },
      ],
    });
  }, [res, ct]);

  const csvRows = useMemo(() => {
    const d = res.data;
    const tRefNs = res.t_ref_s * 1e9;
    const rows: Record<string, unknown>[] = [];
    for (let k = 0; k < d.k.length; k++) {
      rows.push({
        k,
        t_ref_ns: k * tRefNs,
        n_int: d.n_int[k],
        m_FB: d.m_FB[k],
        c_FB: d.c_FB[k],
        j_INJ: d.j_INJ[k],
        c_INJ: d.c_INJ[k],
        R_FB: d.R_FB[k],
        R_INJ: d.R_INJ[k],
        seq_id: d.seq_id[k],
      });
    }
    return rows;
  }, [res]);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>四個 Verilog-A 模組各做什麼?ports 與 parameters 怎麼接?</li>
          <li>integer code 在純 electrical netlist 裡如何傳遞?(code-as-voltage)</li>
          <li>怎麼用 Python 產生的 CSV command vectors 驅動 / 驗證這些模組?</li>
          <li>哪些 Verilog-A constructs 是 simulator-dependent?為什麼刻意避開哪些寫法?</li>
          <li>合理的 bring-up 順序是什麼?哪些功能刻意留在 Python-only?</li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <Callout type="honesty" title="先講誠實聲明(VERILOGA_USAGE.md 開頭)">
          <p>
            <strong>這四個 .va 檔從未在 Spectre(或任何 Verilog-A/AMS simulator)上跑過</strong>
            —— 開發環境沒有任何模擬器可用。它們是對照 Verilog-AMS 2.4 LRM 與 MODEL_SPEC.md
            手寫的 unvalidated source;executable reference 是 Python golden model。
            第一次 load 預期要修 elaboration warnings/errors;行為級結果也不等於
            silicon 結果(MODEL_SPEC §20)。<EpistemicTag kind="ASSUMPTION" />
          </p>
        </Callout>
        <p>
          設計哲學是「replacement ladder」:整條鏈先全用 behavioral 模組驗證 timing
          數學,再一塊一塊換成 transistor-level(先換 DTC、再換 divider、最後換
          VCO)。因此每個 .va 模組的邊界都對齊實體電路的邊界,而且所有 ports 都是
          <strong>scalar electrical</strong>:integer code 以 piecewise-constant 電壓
          <M>{'v = \\text{code} \\times v_{per\\_code}'}</M>(預設 1 V/LSB)傳遞,
          避開 array ports 與 wreal bus 的跨工具差異。scheduler 輸出在 ref edge 上
          經 transition() ramp 更新,消費端必須「晚一點取樣」(registered-output
          discipline)—— 因為 LRM 不保證不同 module 同時刻 cross() 事件的順序。
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>Verilog-A 端實作的數學與 Python 完全同源(MODEL_SPEC §3–§8、§13–§14):</p>
        <MathBlock>{'s_{ideal}[k] = s_0 + k N, \\qquad A_{FB}[k] = Q\\big(256\\, s_{ideal}[k]\\big), \\qquad n_{int}[k] = I_{FB}[k+1] - I_{FB}[k]'}</MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> <M>{'n_{int}[k]'}</M> 需要 <M>{'A_{FB}[k+1]'}</M>,
          所以模組「提前一格量化」:ef1 state 每個 ref edge 仍恰好前進一次、順序不變,
          與 Python 逐位同構。real 沒有 <code>%</code>,所有 mod 一律寫成:
        </p>
        <MathBlock>{'a \\bmod b = a - b \\left\\lfloor a/b \\right\\rfloor'}</MathBlock>
        <p>Mode D(shared_mode=1)與 injection kick(§14):</p>
        <MathBlock>{'R_{INJ}[k] = (R_{zero} - R_{FB}[k]) \\bmod 256 \\quad [\\text{EXACT}], \\qquad \\Delta\\theta = -K_{inj}\\sin(e_{inj}) \\quad [\\text{APPROX}]'}</MathBlock>
        <p>非理想 DTC 的總延遲(秒域;cycles = 秒 / T_vco):</p>
        <MathBlock>{'t_d(c,j) = t_{off} + g\\, c\\, t_{LSB} + a_{INL}\\sin\\tfrac{2\\pi c}{64} + p_2\\big(\\tfrac{c}{63}\\big)^2 + p_3\\big(\\tfrac{c}{63}\\big)^3 + t_{tap,j}'}</MathBlock>
        <p>
          <EpistemicTag kind="ASSUMPTION" /> trigger edge 的到達時間本身就攜帶了
          scheduler+DTC 的 deterministic error <M>{'\\varepsilon_{hw}'}</M>,所以 ILO
          模組在 pulse 瞬間取樣 VCO phase 即是離散映射
          <M>{'e_{inj}[k] = \\operatorname{wrapRadians}(\\theta^-[k] + \\varepsilon_{hw}[k])'}</M>
          的連續時間等價;detuning 項 <M>{'2\\pi\\Delta f\\, T_{ref}'}</M> 由兩 pulse 間
          對 <M>{'f_0 + \\Delta f'}</M> 的積分自動出現。
        </p>
      </SectionMath>

      <SectionExample>
        <p>兩個手算 check(bring-up 時的 sanity 數字):</p>
        <ul>
          <li>
            <strong>DTC gain check(Test 7)</strong>:<code>gain=1.01</code>、
            <M>{'t_{LSB} = 312.5\\ \\text{fs}'}</M>、c = 63 →
            名目延遲 <M>{'63 \\times 312.5 = 19.6875\\ \\text{ps}'}</M>,誤差
            <M>{'0.01 \\times 19.6875\\ \\text{ps} = 196.875\\ \\text{fs} \\approx 200\\ \\text{fs}'}</M>
            (full-range 20 ps 的 1%)。<EpistemicTag kind="EXACT" />
          </li>
          <li>
            <strong>Mode D identity(Test 2)</strong>:對照第 18 章 CSV 列
            <code>k=1: R_FB=33, R_INJ=223</code> →
            <M>{'(33 + 223) \\bmod 256 = 0 = R_{zero}'}</M>。bring-up 步驟 1 就是在
            simulator 裡逐 edge assert 這條。<EpistemicTag kind="EXACT" />
          </li>
          <li>
            <strong>1° tap skew(Test 6)</strong>:T_vco = 80 ps 時
            <M>{'t_{tap} = 80\\ \\text{ps}/360 = 222.22\\ \\text{fs}'}</M>,
            即參數 <code>tap0..tap7 = 222.22e-15</code>。<EpistemicTag kind="EXACT" />
          </li>
        </ul>
      </SectionExample>

      <SectionFigure
        title="模組總表與 testbench 接線"
        caption={
          <span>
            behavioral → transistor 的 replacement ladder:codes 是電壓(1 V/LSB),
            r_fb_out → r_fb_in 是 Mode D shared code 的關鍵連線;injection trigger 走
            ref_clk(+t_arm)→ DTC(INJ) → ILO 的鏈,pulse 到達時間即攜帶全部
            deterministic scheduling error。
          </span>
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr><th>檔案</th><th>用途</th><th>spec</th></tr>
            </thead>
            <tbody>
              {VA_MODULES.map((m) => (
                <tr key={m.file}>
                  <td><code>{m.file}</code></td>
                  <td>{m.purpose}</td>
                  <td>{m.spec}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <TestbenchSvg />
      </SectionFigure>

      <SectionFigure
        title="Ports 一覽(四模組)"
        caption={<span>全部 scalar electrical;code 皆為 v = code × v_per_code(預設 1 V/LSB)。</span>}
      >
        {PORT_TABLES.map((t) => (
          <div key={t.module} style={{ overflowX: 'auto', marginBottom: 12 }}>
            <table className="data-table">
              <thead>
                <tr><th colSpan={4}><code>{t.module}</code></th></tr>
                <tr><th>port</th><th>dir</th><th>編碼</th><th>意義</th></tr>
              </thead>
              <tbody>
                {t.rows.map((r) => (
                  <tr key={t.module + r[0]}>
                    <td><code>{r[0]}</code></td>
                    <td>{r[1]}</td>
                    <td>{r[2]}</td>
                    <td>{r[3]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </SectionFigure>

      <SectionFigure
        title="主要 parameters(節選)"
        caption={<span>完整表(含每個參數的 spec 對應)在 VERILOGA_USAGE.md;此處列 bring-up 會動到的。</span>}
      >
        {PARAM_TABLES.map((t) => (
          <div key={t.module} style={{ overflowX: 'auto', marginBottom: 12 }}>
            <table className="data-table">
              <thead>
                <tr><th colSpan={4}><code>{t.module}</code></th></tr>
                <tr><th>parameter</th><th>default</th><th>unit</th><th>意義</th></tr>
              </thead>
              <tbody>
                {t.rows.map((r) => (
                  <tr key={t.module + r[0]}>
                    <td><code>{r[0]}</code></td>
                    <td><code>{r[1]}</code></td>
                    <td>{r[2]}</td>
                    <td>{r[3]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </SectionFigure>

      <SectionFigure
        title="CSV command vectors:Verilog-A testbench 的驅動資料"
        caption={
          <span>
            與 <code>test_vectors/csv/*.csv</code> 完全同欄位(k, t_ref_ns, n_int, m_FB,
            c_FB, j_INJ, c_INJ, R_FB, R_INJ, seq_id),由 TS mirror 以目前參數即時產生。
            圖為前 64 拍的 code 序列(step = PWL hold 的形狀);表格可 CSV export,
            腳本轉成 Spectre <code>vsource type=pwl</code>(value = code × 1 V,~1 ps ramp)
            即可直接餵 <code>dtc_nonideal_model.code_in</code>、tap mux 與 divider control。
          </span>
        }
      >
        <EChart option={codeOption} height={300} group="ch19" />
        <DebugTable
          columns={[
            { key: 'k', label: 'k' },
            { key: 't_ref_ns', label: 't_ref_ns', fmt: (v) => trimNumber(Number(v), 6) },
            { key: 'n_int', label: 'n_int' },
            { key: 'm_FB', label: 'm_FB' },
            { key: 'c_FB', label: 'c_FB' },
            { key: 'j_INJ', label: 'j_INJ' },
            { key: 'c_INJ', label: 'c_INJ' },
            { key: 'R_FB', label: 'R_FB' },
            { key: 'R_INJ', label: 'R_INJ' },
            { key: 'seq_id', label: 'seq_id' },
          ]}
          rows={csvRows}
          maxHeight={280}
          exportName="ch19_command_vectors.csv"
        />
      </SectionFigure>

      <SectionFigure
        title="Simulator-dependent constructs 清單"
        caption={<span>每一項都在 .va 原始碼中以 <code>--- SIMULATOR-DEPENDENT ---</code> 註解標出。</span>}
      >
        <div style={{ maxHeight: 400, overflowY: 'auto', overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr><th>construct</th><th>出現處</th><th>風險與對策</th></tr>
            </thead>
            <tbody>
              {SIMDEP_ROWS.map((r) => (
                <tr key={r[0]}>
                  <td><code>{r[0]}</code></td>
                  <td>{r[1]}</td>
                  <td>{r[2]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionFigure>

      <SectionCode language="verilog" title="節錄 1 — fractional_phase_scheduler.va:look-ahead 量化與 decode" code={VA_SCHED_EXCERPT} />
      <SectionCode language="verilog" title="節錄 2 — reverse_injection_scheduler.va:Mode D + latency shift register" code={VA_REVERSE_EXCERPT} />
      <SectionCode language="verilog" title="節錄 3 — pulsed_injection_phase_model.va:injection kick 事件" code={VA_KICK_EXCERPT} />
      <SectionCode language="verilog" title="節錄 4 — dtc_nonideal_model.va:總延遲與 transition()" code={VA_DTC_EXCERPT} />

      <SectionLineByLine
        items={[
          {
            code: 's_now = s0 + k_real * n_frac;',
            explain:
              '乘法而非累加(spec §3):float64 下單次 rounding,與 Python/TS 逐位一致;' +
              'k_real 存 real(exact 到 2^53),避開 32-bit integer 溢位。',
          },
          {
            code: 'else if (q_mode == 1) y_q = floor(u_q + 0.5);',
            explain:
              'half-up nearest 手寫成 floor(u+0.5) —— spec 禁用語言內建 round(),' +
              'Verilog-A 端同樣遵守,三份實作的量化決策才會相同。',
          },
          {
            code: 'n_int_val = i_next - i_curr;',
            explain:
              'divider modulus 是 I_FB 的差分:模組在 edge k 就要發出 [k, k+1) 的 modulus,' +
              '所以量化提前一格(registered-output 語意,像 RTL 一樣取樣)。',
          },
          {
            code: 'r_fb_smp = floor(V(r_fb_in) / v_per_code + 0.5);',
            explain:
              'code-as-voltage 的還原:transition() ramp 與 solver 誤差使電壓非嚴格整數,' +
              '用 round-to-nearest 恢復 code;之後 clamp 僅是診斷性 guard。',
          },
          {
            code: 'r_now = (r_zero - r_fb_smp) - g_units * floor((r_zero - r_fb_smp) / g_units);',
            explain:
              'Mode D 的 modular reverse,real-arithmetic mod 寫法(real 沒有 % 運算子)。' +
              '與 Python 的 (r_zero - r_fb) % g 數值等價。',
          },
          {
            code: 'pipe[0] = r_now; r_apply = pipe[lat_cycles];',
            explain:
              '§13 latency:9 深 shift register。shared mode 下這只是 transport delay ——' +
              'look-ahead 必須發生在擁有 phase state 的 feedback scheduler 那端。',
          },
          {
            code: 'phi_tot = phi_cyc + theta_c;',
            explain:
              'pulse 瞬間取樣 VCO 相位(idtmod 的 free-running 相位 + 累積 kick offset);' +
              'trigger 到達時間已含 ε_hw,故不需要獨立的 error port。',
          },
          {
            code: 'else if (inj_map == 1) dth_rad = -(k_inj * k_scale) * sin(e_rad);',
            explain:
              '§14 sinusoidal map [APPROX]:負號在公式裡(error feedback),不藏在變數定義。' +
              'K_inj 是 lumped 參數,非電路萃取值。',
          },
          {
            code: 'V(trig_out) <+ transition((out_state > 0.5) ? vhi : vlo, t_d, t_rise, t_rise);',
            explain:
              '變動延遲的 transition():t_d 逐 edge 更新。合法但有 pending-event 搶佔的' +
              '工具差異;一拍一顆 pulse、t_d ≤ ~25 ps << T_ref,實務上安全。absdelay() 只吃常數延遲,不可用。',
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>圖上 <code>n_int</code> 在 {'{3, 4}'} 之間切換(nearest/floor);把 quantizer 改成
            ef1 可能出現暫態 {'{2..5}'} —— 這是 .va port 註解裡明寫的合法範圍。</li>
          <li><code>c_INJ</code> 與 <code>j_INJ</code> 隨 k <strong>倒退</strong>旋轉
            (reverse injection),而 <code>c_FB</code> 正向前進;N=3.125 時 j_INJ 每拍
            剛好 −1 tap。</li>
          <li>表格任一列 <M>{'(R_{FB}+R_{INJ}) \\bmod 256 = 0'}</M>;把 latency slider
            調到 L&gt;0 且關掉 look-ahead,codes 整體平移 L 拍 —— 在 Verilog-A 裡
            對應 <code>lat_cycles</code> 與 <code>look_ahead=0</code> 的 bug mode
            (α=0.13, L=1 → 46.8°,Test 5)。</li>
          <li>CSV export 出來的檔案就是 testbench 驅動格式:integer codes 必須與
            Python vectors <strong>完全相等</strong>(§18 tolerance int=0)。</li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解:「Verilog-A 檔案在 repo 裡,代表它已被模擬驗證過」">
          <p>
            錯。這四個 .va 是 <strong>hand-written、未經任何 simulator elaboration</strong>
            的原始碼;它們的數學正確性由「與 MODEL_SPEC/Python 同源」背書,不是由模擬
            背書。第一次在 Spectre/AMS 上 load 時,應該預期要處理語法與事件語意的問題,
            並用 CSV vectors 逐 edge diff。<EpistemicTag kind="ASSUMPTION" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解:「noise 研究也可以在 Verilog-A 端做」">
          <p>
            不行(刻意設計):§12 mulberry32 streams 無法在 Verilog-A 重現,
            <code>$rdist_*</code> 的呼叫次數 per timestep 是 tool-dependent,逐位 parity
            不可能。Verilog-A 模型是全 deterministic;noise 研究一律回 Python golden
            model,或用外部手段(調 trigger timing)注入。
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <p>Bring-up 順序(VERILOGA_USAGE.md;每一步都有 Python 對照):</p>
        <ol>
          <li><strong>Scheduler alone</strong>:<code>fractional_phase_scheduler</code> +
            理想 4 GHz 源,α=0.125、q_mode=1。逐 cycle strobe codes、diff
            <code>test_vectors/csv/</code>:integer 必須完全相等;on-grid N=3.125 必須
            <M>{'e_{FB,abs} \\equiv 0'}</M>。再換 α=0.13 與 ef1;接上
            <code>reverse_injection_scheduler</code>(shared_mode=1)逐 edge assert
            <M>{'(R_{FB}+R_{INJ}) \\bmod 256 = 0'}</M>(Test 2)。</li>
          <li><strong>DTC next</strong>:插入 <code>dtc_nonideal_model</code>,先全零
            (edges 應落在理想 grid 內、只差 solver tolerance),再逐項開 impairment:
            1% gain → 200 fs(Test 7)、1° tap → 222.22 fs(Test 6)。</li>
          <li><strong>Injection model last</strong>:k_inj=0 → 相位以 Δf ramp 不被修正;
            k_inj=0.3、Δf=1 MHz → lock 且靜態 offset
            <M>{'\\theta_{ss} = \\arcsin(2\\pi\\Delta f\\, T_{ref}/K_{inj})'}</M>;
            k_inj ↑ → residual ↓;inj_map=2(ideal reset)是上限(Test 14)。
            之後才閉整條鏈看 <code>e_inj_dbg</code>。</li>
        </ol>
        <p>
          數值不合先 diff Python,再懷疑 simulator —— 數學契約只有一份。
          <EpistemicTag kind="INFERENCE" />
        </p>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <ul>
            <li><strong>未跑 Spectre</strong>:四個 .va 均未經任何 simulator 驗證;
              語法與事件語意風險由 simulator-dependent 清單逐項標示,但只有實跑才能關閉。</li>
            <li>Verilog-A 端功能子集:mash11、triangular dither、calibrated mapping、
              64-entry LUT INL、frozen DNL、全部 random noise 皆為 Python-only。</li>
            <li>shared mode 的 look-ahead 必須由 feedback 端補償(此模組只有 transport
              delay);pair identity 只在兩 code 取樣自同一 k 時逐 edge 成立。</li>
            <li>行為級 ≠ silicon:kick map 是 [APPROX]、K_inj 非電路萃取、
              pulse_width 只是文件參數(MODEL_SPEC §20)。</li>
          </ul>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="Command vector 參數">
        <PresetButtons
          label="Preset N"
          presets={N_PRESETS.map((n) => ({ label: String(n), onClick: () => setNDiv(n) }))}
        />
        <SelectControl<Quantizer>
          label="quantizer(VA 支援 floor/nearest/ef1)"
          value={quant}
          options={[
            { value: 'floor', label: 'floor (q_mode=0)' },
            { value: 'nearest', label: 'nearest (q_mode=1)' },
            { value: 'ef1', label: 'ef1 (q_mode=2)' },
          ]}
          onChange={setQuant}
        />
        <Slider label="latency L (ref cycles)" value={latency} min={0} max={8} step={1} onChange={setLatency} />
        <Toggle label="look-ahead(關閉 = bug mode)" checked={lookahead} onChange={setLookahead} />
      </ParamPanel>
    </ChapterShell>
  );
}
