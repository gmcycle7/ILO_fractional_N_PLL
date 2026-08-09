/**
 * Chapter 18 — Python Golden Model
 * 模組結構、SimConfig 欄位表、CLI 用法、test vector schema、pytest 摘要、
 * Python↔TS 交叉驗證方法與 tolerance。
 * 所有 Python 程式碼摘錄均逐字取自 model/python/(勿改寫)。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ChapterShell, SectionQuestion, SectionIntuition, SectionMath, SectionExample,
  SectionFigure, SectionCode, SectionLineByLine, SectionObserve,
  SectionMisconception, SectionTakeaway, SectionLimitation,
} from '../components/ChapterShell';
import EChart from '../components/EChart';
import EpistemicTag from '../components/EpistemicTag';
import Callout from '../components/Callout';
import { M, MathBlock } from '../components/Math';
import { ParamPanel, SelectControl, Toggle } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import DebugTable from '../components/DebugTable';
import { makeLineOption } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { trimNumber, phaseAxisLabel, makePhaseTickFormatter, formatPhase } from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import { simulate, fromPartial } from '../model';
import type { SimConfig } from '../model';

const meta = chapterById(18)!;

/**
 * 14 組 canonical test vector 的 config(MODEL_SPEC §18)。
 * 逐字對應 model/python/cli.py 的 VECTOR_CONFIGS(其餘欄位皆為 spec 預設值,
 * n_cycles=512, seed=12345)。
 */
const VECTOR_CONFIGS: { id: string; partial: Partial<SimConfig>; note: string }[] = [
  { id: 'n3p000_nearest', partial: { n_div: 3.0, quantizer: 'nearest' }, note: 'on-grid integer N' },
  { id: 'n3p125_nearest', partial: { n_div: 3.125, quantizer: 'nearest' }, note: 'on-grid α=1/8' },
  { id: 'n3p130_floor', partial: { n_div: 3.13, quantizer: 'floor' }, note: 'off-grid, floor' },
  { id: 'n3p130_nearest', partial: { n_div: 3.13, quantizer: 'nearest' }, note: 'off-grid, nearest' },
  { id: 'n3p130_ef1_shared', partial: { n_div: 3.13, quantizer: 'ef1', arch_mode: 'D' }, note: 'Mode D + ef1' },
  { id: 'n3p130_ef1_independent', partial: { n_div: 3.13, quantizer: 'ef1', arch_mode: 'B' }, note: 'Mode B(獨立 DSM)' },
  { id: 'n3p130_mash11', partial: { n_div: 3.13, quantizer: 'mash11' }, note: 'MASH 1-1' },
  { id: 'n3p130_latency_bug', partial: { n_div: 3.13, latency_cycles: 1, lookahead: false }, note: 'L=1 bug mode' },
  { id: 'n3p130_lookahead', partial: { n_div: 3.13, latency_cycles: 1, lookahead: true }, note: 'L=1 look-ahead' },
  {
    id: 'n3p125_tap_mismatch_1deg',
    partial: { n_div: 3.125, tap_mismatch_cycles: Array(8).fill(1.0 / 360.0) as number[] },
    note: '1° tap mismatch',
  },
  { id: 'n3p125_dtc_gain_1pct', partial: { n_div: 3.125, dtc_inj_gain: 1.01 }, note: '1% INJ DTC gain' },
  {
    id: 'n3p130_dynamics_sin',
    partial: { n_div: 3.13, inj_model: 'sin', k_inj: 0.3, delta_f_hz: 1e6, sigma_vco_w_rad: 0.01 },
    note: 'sin dynamics + noise',
  },
  { id: 'n3p130_mash111', partial: { n_div: 3.13, quantizer: 'mash111' }, note: 'MASH 1-1-1(schema-v2)' },
  {
    id: 'n3p130_dsm_only_gated',
    partial: {
      n_div: 3.13,
      quantizer: 'ef1',
      actuator_mode: 'dsm_only',
      inj_gate_mode: 'threshold',
      inj_model: 'sin',
      k_inj: 0.4,
      delta_f_hz: 1e6,
      sigma_vco_w_rad: 0.02,
    },
    note: 'dsm_only + gating(schema-v2)',
  },
];

/** model/python/ 檔案 → 職責(模組對照表)。 */
const MODULE_ROWS: { file: string; spec: string; role: string }[] = [
  { file: 'phase_math.py', spec: '§2', role: 'wrap01 / wrapCycles / wrapRadians / qNearest / qFloor(禁止內建 round)' },
  { file: 'units.py', spec: '§1, §9, §11', role: '常數與檢查值(LSB=312.5 fs、half-LSB、頻率表)' },
  { file: 'noise_models.py', spec: '§12', role: 'mulberry32 PRNG、Box-Muller Gaussian、named streams' },
  { file: 'config.py', spec: '§1, 6–8, 10–14', role: 'SimConfig dataclass;to_dict/from_dict JSON round-trip' },
  { file: 'phase_accumulator.py', spec: '§3', role: 's_ideal[k]=s0+kN(乘法)、x_ideal、A_ideal' },
  { file: 'dsm_first_order.py / mash11.py / mash111.py', spec: '§6', role: 'ef1 error-feedback DSM、MASH 1-1 / MASH 1-1-1 quantizer' },
  { file: 'feedback_scheduler.py', spec: '§4, §6', role: 'A_FB=Q(A_ideal) → I/R/m/c decode、n_int、assertions' },
  { file: 'injection_scheduler.py', spec: '§5, §7, §8', role: 'u_INJ_ideal、mode A/B/C/D、tap+DTC 三種 mapping' },
  { file: 'tap_model.py / dtc_model.py', spec: '§10, §11', role: 'tap/PMUX mismatch 表、DTC gain/offset/INL/DNL' },
  { file: 'latency_pipeline.py', spec: '§13', role: 'L-cycle pipeline、look-ahead vs bug、command metadata' },
  { file: 'injection_dynamics.py', spec: '§14', role: 'reset/linear/sin(+LUT) injection map、lock condition' },
  { file: 'error_decomposition.py', spec: '§16', role: '逐項 error decomposition(individual vs joint)' },
  { file: 'measurements.py', spec: '§17', role: 'Hann periodogram PSD、spur 偵測、RMS/histogram/dBc' },
  { file: 'simulate.py', spec: 'all', role: '全鏈 engine;SimResult 35 columns;summary()' },
  { file: 'experiments.py', spec: '—', role: '22 個 canonical experiments + presets(exp01…exp22)' },
  { file: 'cli.py', spec: '§18', role: '--list-presets / --preset / --emit-vectors' },
];

/** SimConfig 欄位表(名稱與預設逐字對應 model/python/config.py)。 */
const CONFIG_FIELDS: { group: string; rows: [string, string, string][] }[] = [
  {
    group: '核心系統(MODEL_SPEC §1)',
    rows: [
      ['f_ref_hz', '4e9', 'reference frequency(Hz)'],
      ['n_div', '3.125', 'fractional divide ratio N = 3 + α'],
      ['n_cycles', '512', '模擬 reference cycles 數'],
      ['s0', '0.0', 'initial absolute phase coordinate(cycles)'],
      ['b_dtc', '6', 'DTC bits(兩路共用)→ G = 4·2^6 = 256'],
      ['n_tap', '8', 'injection taps(45° 間距)'],
      ['n_pmux', '4', 'feedback PMUX 相位數'],
      ['z0_cycles', '0.0', '目標 injection zero-crossing phase'],
      ['r_zero', '0', 'modular reverse 的 digital zero offset code'],
    ],
  },
  {
    group: 'Digital scheduler(§6, §7, §8, §11, §13)',
    rows: [
      ['quantizer', "'nearest'", 'floor | nearest | truncate | ef1 | mash11'],
      ['dither_amp_lsb', '0.0', 'triangular dither 幅度(LSB,quantize 前加入)'],
      ['arch_mode', "'D'", 'A | B | C | D(D = quantize once + modular reverse)'],
      ['inj_mapping', "'naive'", 'naive | nearest | calibrated tap/DTC decode'],
      ['dtc_mode', "'normalized'", 'normalized | fixed_time DTC LSB'],
      ['dtc_lsb_fs', '312.5', 'fixed_time 模式的 DTC LSB(fs)'],
      ['latency_cycles', '0', '固定 digital latency L(reference cycles)'],
      ['lookahead', 'true', 'true = 正確 look-ahead;false = bug mode'],
      ['seed', '12345', 'PRNG base seed(§12)'],
    ],
  },
  {
    group: 'Analog nonidealities(§10)',
    rows: [
      ['tap_mismatch_cycles', '[0]×8', '8-tap mismatch LUT(cycles)'],
      ['pmux_mismatch_cycles', '[0]×4', 'PMUX mismatch(cycles)'],
      ['dtc_fb_gain / dtc_inj_gain', '1.0', 'DTC gain error(乘在 code delay 上)'],
      ['dtc_fb_offset_cycles / dtc_inj_offset_cycles', '0.0', 'DTC 靜態 offset(cycles)'],
      ['inl_sin_amp_cycles', '0.0', 'sinusoidal INL:a·sin(2πc/64)'],
      ['inl_poly', '[0, 0]', 'polynomial INL [p2, p3](對 (c/63)² 與 (c/63)³)'],
      ['inl_lut', 'null', '64-entry 使用者 INL LUT(cycles)'],
      ['dnl_sigma_lsb', '0.0', 'per-code random DNL(frozen per instance)'],
      ['route_fb_cycles / route_inj_cycles', '0.0', 'route skew(cycles)'],
      ['sigma_ref_s', '0.0', 'reference jitter rms(秒,white)'],
      ['sigma_vco_w_rad', '0.0', 'VCO white phase step per ref cycle(rad)'],
      ['sigma_vco_rw_rad', '0.0', 'VCO random walk(rad/√cycle)'],
      ['p_late', '0.0', '+1 cycle random latency 機率'],
      ['sigma_pulse_s', '0.0', 'injection pulse timing noise(秒)'],
    ],
  },
  {
    group: 'Injection dynamics(§14)',
    rows: [
      ['inj_model', "'none'", 'none | reset | linear | sin | lut'],
      ['k_inj', '0.3', 'lumped injection strength K_inj ∈ [0, 1]'],
      ['delta_f_hz', '0.0', 'VCO free-running detuning(相對 N·f_ref)'],
      ['pdr_lut', 'null', 'PDR/PRC LUT [[e_rad, dθ_rad], …](linear interp + clamp)'],
    ],
  },
];

const PY_FEEDBACK_EXCERPT = `# model/python/feedback_scheduler.py — run_feedback() 核心(逐字節錄)
q = make_quantizer(cfg.quantizer)

use_dither = cfg.dither_amp_lsb > 0.0 and dither_stream is not None
for k in range(n):
    u = float(a_ideal[k])
    if use_dither:
        u += cfg.dither_amp_lsb * (dither_stream.next() + dither_stream.next() - 1.0)
    y = q.quantize(u)
    a_fb[k] = y
    dsm_out[k] = y
    dsm_state[k] = q.state

# --- assertions (MODEL_SPEC section 4) ---
d = np.diff(a_fb)
assert np.all(d > 0), "A_FB must be strictly monotonic (no duplicate/backward edges)"
i_fb = a_fb // g
r_fb = a_fb % g
m_fb = r_fb // n_dtc
c_fb = r_fb % n_dtc`;

const PY_MODE_D_EXCERPT = `# model/python/injection_scheduler.py — run_injection() 的 mode 分支(逐字節錄)
u_ideal = u_inj_ideal(x_nominal, cfg.z0_cycles)

# --- R_INJ per architecture mode ---
r_inj = np.empty(n, dtype=np.int64)
if cfg.arch_mode == "D":
    r_inj[:] = (cfg.r_zero - r_fb) % g
else:  # A, B, C: independent quantizer instance on G * u_INJ_ideal
    q = make_quantizer(cfg.quantizer)
    use_dither = cfg.dither_amp_lsb > 0.0 and dither_stream is not None
    for k in range(n):
        u = g * float(u_ideal[k])
        if use_dither:
            u += cfg.dither_amp_lsb * (dither_stream.next() + dither_stream.next() - 1.0)
        r_inj[k] = q.quantize(u) % g`;

const PY_MULBERRY_EXCERPT = `# model/python/noise_models.py — Mulberry32.next()(逐字節錄)
def next(self) -> float:
    """Uniform in [0, 1) with 32-bit resolution."""
    self.s = (self.s + 0x6D2B79F5) & _MASK
    t = self.s
    t = ((t ^ (t >> 15)) * (t | 1)) & _MASK
    t = ((t + (((t ^ (t >> 7)) * (t | 61)) & _MASK)) & _MASK) ^ t
    return ((t ^ (t >> 14)) & _MASK) / _TWO32`;

const PY_VECTOR_EXCERPT = `# model/python/cli.py — _vector_dict() 的 schema(逐字節錄)
return {
    "name": name,
    "generator": "python",
    "seed": cfg.seed,
    "config": cfg.to_dict(),
    "tolerance": {"int": 0, "float_abs": 1e-12, "noise_abs": 1e-9},
    "columns": list(VECTOR_COLUMNS),
    "data": data,
}`;

const CLI_USAGE = `# 列出 22 個 experiment presets(exp01…exp22 + n3p13_shared_reverse)
python3 -m model.python.cli --list-presets

# 跑單一 preset:寫出 results/<ID>/summary.json + timeseries.csv + psd.csv
# (comparison presets 另寫 timeseries_<i>.csv / psd_<i>.csv)
python3 -m model.python.cli --preset exp03 --out results

# 產生 14 組 canonical JSON test vectors(各 512 cycles、seed 12345)
# 以及 test_vectors/csv/ 下的 per-cycle command CSV(給 Verilog-A testbench)
python3 -m model.python.cli --emit-vectors test_vectors`;

/** JSON vector 欄位(逐字對應 cli.py 的 VECTOR_COLUMNS)。 */
const VECTOR_COLUMNS_LIST =
  '"k", "s_ideal", "A_FB", "R_FB", "m_FB", "c_FB", "n_int", "R_INJ", "j_INJ", ' +
  '"c_INJ", "u_FB_digital", "u_INJ_digital", "e_FB_abs", "e_pair", "u_INJ_ideal", ' +
  '"e_INJ_abs", "u_FB_analog", "u_INJ_analog", "e_pair_analog", "e_ZC_hw", ' +
  '"e_inj", "theta_plus", "seq_id"'; // schema-v2 vectors 末端另追加 "inj_fired"

/** 模組結構圖(inline SVG,顏色一律 theme tokens)。 */
function ModuleMapSvg() {
  const box = {
    fill: 'var(--bg-panel)',
    stroke: 'var(--border-strong)',
    strokeWidth: 1,
    rx: 4,
  } as const;
  const accentBox = { ...box, fill: 'var(--accent-soft)', stroke: 'var(--accent)' };
  const label = { fill: 'var(--fg)', fontSize: 11, fontFamily: 'inherit' } as const;
  const sub = { fill: 'var(--fg-subtle)', fontSize: 9.5, fontFamily: 'inherit' } as const;
  const layer = { fill: 'var(--fg-faint)', fontSize: 9.5, fontFamily: 'inherit' } as const;
  const arrow = { stroke: 'var(--fg-faint)', strokeWidth: 1.2, markerEnd: 'url(#ch18-arr)' } as const;
  return (
    <svg viewBox="0 0 760 330" style={{ width: '100%', maxWidth: 860, display: 'block' }} role="img"
      aria-label="model/python module map">
      <defs>
        <marker id="ch18-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--fg-faint)" />
        </marker>
      </defs>
      {/* Layer 0: consumers */}
      <text x={10} y={22} {...layer}>使用端</text>
      <rect x={80} y={8} width={200} height={36} {...box} />
      <text x={90} y={24} {...label}>cli.py</text>
      <text x={90} y={37} {...sub}>--list-presets / --preset / --emit-vectors</text>
      <rect x={300} y={8} width={170} height={36} {...box} />
      <text x={310} y={24} {...label}>tests/(pytest)</text>
      <text x={310} y={37} {...sub}>61 passed;11 個 test 檔</text>
      <rect x={490} y={8} width={180} height={36} {...box} />
      <text x={500} y={24} {...label}>test_vectors/*.json + csv/</text>
      <text x={500} y={37} {...sub}>→ web/src/model vitest 比對</text>
      {/* Layer 1: engine */}
      <text x={10} y={86} {...layer}>engine</text>
      <rect x={80} y={66} width={300} height={40} {...accentBox} />
      <text x={90} y={83} {...label}>simulate.py — simulate(cfg) → SimResult</text>
      <text x={90} y={97} {...sub}>34 columns、summary()、to_csv()</text>
      <rect x={400} y={66} width={270} height={40} {...box} />
      <text x={410} y={83} {...label}>experiments.py</text>
      <text x={410} y={97} {...sub}>EXPERIMENTS(exp01…exp22)、PRESETS</text>
      {/* Layer 2: chain stages */}
      <text x={10} y={150} {...layer}>chain</text>
      <rect x={30} y={128} width={170} height={40} {...box} />
      <text x={40} y={145} {...label}>feedback_scheduler.py</text>
      <text x={40} y={159} {...sub}>§4 A/I/R/m/c、n_int、asserts</text>
      <rect x={215} y={128} width={175} height={40} {...box} />
      <text x={225} y={145} {...label}>injection_scheduler.py</text>
      <text x={225} y={159} {...sub}>§5/7/8 mode A–D、mapping</text>
      <rect x={405} y={128} width={160} height={40} {...box} />
      <text x={415} y={145} {...label}>latency_pipeline.py</text>
      <text x={415} y={159} {...sub}>§13 look-ahead、metadata</text>
      <rect x={580} y={128} width={165} height={40} {...box} />
      <text x={590} y={145} {...label}>injection_dynamics.py</text>
      <text x={590} y={159} {...sub}>§14 reset/linear/sin/LUT</text>
      {/* Layer 3: element models */}
      <rect x={30} y={192} width={170} height={40} {...box} />
      <text x={40} y={209} {...label}>phase_accumulator.py</text>
      <text x={40} y={223} {...sub}>§3 s_ideal = s0 + kN(乘法)</text>
      <rect x={215} y={192} width={175} height={40} {...box} />
      <text x={225} y={209} {...label}>dsm_first_order / mash11</text>
      <text x={225} y={223} {...sub}>§6 ef1、MASH 1-1 state</text>
      <rect x={405} y={192} width={160} height={40} {...box} />
      <text x={415} y={209} {...label}>tap_model / dtc_model</text>
      <text x={415} y={223} {...sub}>§10/11 mismatch、INL、LSB</text>
      <rect x={580} y={192} width={165} height={40} {...box} />
      <text x={590} y={209} {...label}>measurements.py</text>
      <text x={590} y={223} {...sub}>§17 PSD/spur;decomposition §16</text>
      {/* Layer 4: primitives */}
      <text x={10} y={278} {...layer}>基礎</text>
      <rect x={30} y={258} width={200} height={40} {...box} />
      <text x={40} y={275} {...label}>phase_math.py</text>
      <text x={40} y={289} {...sub}>§2 wrap01/wrapCycles/qNearest</text>
      <rect x={250} y={258} width={180} height={40} {...box} />
      <text x={260} y={275} {...label}>noise_models.py</text>
      <text x={260} y={289} {...sub}>§12 mulberry32、9 named streams</text>
      <rect x={450} y={258} width={140} height={40} {...box} />
      <text x={460} y={275} {...label}>units.py</text>
      <text x={460} y={289} {...sub}>§1/9/11 常數檢查值</text>
      <rect x={610} y={258} width={135} height={40} {...box} />
      <text x={620} y={275} {...label}>config.py</text>
      <text x={620} y={289} {...sub}>SimConfig(39 欄位)</text>
      {/* arrows: primitives -> chain -> engine -> consumers */}
      <line x1={115} y1={258} x2={115} y2={234} {...arrow} />
      <line x1={302} y1={258} x2={302} y2={234} {...arrow} />
      <line x1={485} y1={258} x2={485} y2={234} {...arrow} />
      <line x1={115} y1={192} x2={115} y2={170} {...arrow} />
      <line x1={302} y1={192} x2={302} y2={170} {...arrow} />
      <line x1={485} y1={192} x2={485} y2={170} {...arrow} />
      <line x1={662} y1={192} x2={662} y2={170} {...arrow} />
      <line x1={230} y1={128} x2={230} y2={108} {...arrow} />
      <line x1={202} y1={66} x2={202} y2={46} {...arrow} />
      <line x1={382} y1={66} x2={382} y2={46} {...arrow} />
      <line x1={560} y1={66} x2={560} y2={46} {...arrow} />
    </svg>
  );
}

export default function Chapter18() {
  const [vecId, setVecId] = useState('n3p130_nearest');
  const [showAllRows, setShowAllRows] = useState(false);
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const vec = VECTOR_CONFIGS.find((v) => v.id === vecId) ?? VECTOR_CONFIGS[3];

  const res = useMemo(() => simulate(fromPartial({ ...vec.partial, n_cycles: 512 })), [vec]);

  useEffect(() => {
    setStatus('done', `${vec.id}: 512 cycles`);
  }, [vec, setStatus]);

  const tVco = res.t_vco_s;

  const errOption = useMemo(() => {
    const d = res.data;
    const eFb: [number, number][] = [];
    const ePair: [number, number][] = [];
    const eInj: [number, number][] = [];
    for (let k = 0; k < d.k.length; k++) {
      eFb.push([k, d.e_FB_abs[k]]);
      ePair.push([k, d.e_pair_digital[k]]);
      eInj.push([k, d.e_INJ_abs[k]]);
    }
    return makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: phaseAxisLabel('error', unit, tVco),
      yTickFormatter: makePhaseTickFormatter(unit, tVco),
      series: [
        { name: 'e_FB_abs', data: eFb, width: 1.5 },
        { name: 'e_INJ_abs', data: eInj, width: 1.5, dashed: true },
        { name: 'e_pair_digital', data: ePair, width: 2 },
      ],
    });
  }, [res, unit, tVco, ct]);

  const tableRows = useMemo(() => {
    const d = res.data;
    const n = showAllRows ? d.k.length : Math.min(64, d.k.length);
    const rows: Record<string, unknown>[] = [];
    for (let k = 0; k < n; k++) {
      rows.push({
        k,
        A_FB: d.A_FB[k],
        R_FB: d.R_FB[k],
        m_FB: d.m_FB[k],
        c_FB: d.c_FB[k],
        n_int: d.n_int[k],
        R_INJ: d.R_INJ[k],
        j_INJ: d.j_INJ[k],
        c_INJ: d.c_INJ[k],
        e_FB_abs: d.e_FB_abs[k],
        e_pair_digital: d.e_pair_digital[k],
      });
    }
    return rows;
  }, [res, showAllRows]);

  const fmtErr = (v: unknown) => trimNumber(Number(v), 6);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>Python golden model 由哪些模組組成?每個模組對應 MODEL_SPEC 哪一節?</li>
          <li><code>SimConfig</code> 有哪些欄位、預設值是什麼?</li>
          <li>CLI 怎麼用?<code>--list-presets</code> / <code>--preset</code> / <code>--emit-vectors</code> 各產生什麼檔案?</li>
          <li>test vector JSON 的 schema 長什麼樣?14 組 canonical vectors 是哪些?</li>
          <li>Python 與 TypeScript 兩份實作如何交叉驗證?tolerance 為何是
            「integer 完全相等 / float 1e-12 / noise 1e-9」三級?</li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          整個專案有三份實作:<strong>Python golden model</strong>(唯一 executable
          reference)、瀏覽器上的 <strong>TypeScript mirror</strong>(本網站所有互動圖的
          compute 來源,<code>web/src/model/</code>),以及未經 simulator 驗證的
          <strong> Verilog-A</strong>(第 19 章)。數學契約只有一份 —— MODEL_SPEC.md;
          Python 是它的第一實作,其他實作不對 spec 直接負責,而是對「Python 產生的
          test vectors」負責:Python 把 14 組 canonical 模擬結果凍結成 JSON,TS 端的
          vitest 逐 cycle、逐 column 讀入比對。這樣「兩語言一致」不是口號,而是
          CI 裡每次都跑的數值事實。<EpistemicTag kind="EXACT" />
        </p>
        <p>
          能做到逐位一致的前提是:純數位路徑上只用 IEEE-754 float64 的加減乘除與
          <code>floor</code>(每種語言結果逐位相同)、量化一律 <M>{'\\lfloor u + 0.5 \\rfloor'}</M>
          (避開 Python banker&apos;s rounding / JS half-up 的差異)、隨機數不用各語言內建
          RNG 而用 32-bit 整數運算的 mulberry32。只有經過 <code>sin/cos/log</code> 等
          libm 函數的 noise 路徑允許 1e-9 的差異。<EpistemicTag kind="EXACT" />
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>交叉驗證的三級 tolerance(MODEL_SPEC §12、§18)。對每個 vector 的每個 column:</p>
        <MathBlock>{'\\text{integer columns:}\\quad y_{TS}[k] = y_{Py}[k]\\ \\text{(完全相等,tolerance } 0\\text{)}'}</MathBlock>
        <MathBlock>{'\\text{pure digital float:}\\quad |y_{TS}[k] - y_{Py}[k]| \\le 10^{-12}'}</MathBlock>
        <MathBlock>{'\\text{noise-path float:}\\quad |y_{TS}[k] - y_{Py}[k]| \\le 10^{-9}'}</MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> integer columns(<code>A_FB, R_FB, m_FB, c_FB, n_int,
          R_INJ, j_INJ, c_INJ, seq_id</code>)是量化器與模運算的輸出,兩語言的
          <M>{'\\lfloor u + 0.5\\rfloor'}</M> 與整數 mod 完全相同,任何 1 LSB 差異都是 bug。
          純數位 float columns(如 <code>e_FB_abs</code>)理論上也逐位一致,1e-12 只是保險。
          noise 路徑(<code>theta_plus, e_inj</code> 等)經過 <code>math.sin</code> vs
          <code>Math.sin</code> 等 libm 實作,ulp 級差異會累積,故放寬到 1e-9。
        </p>
        <p>PRNG 的逐位一致靠 mulberry32(全部 uint32 運算,<M>{'\\gg'}</M> 為 logical shift):</p>
        <MathBlock>{'s \\leftarrow (s + \\mathtt{0x6D2B79F5}) \\bmod 2^{32}, \\qquad \\text{output} = \\frac{t \\oplus (t \\gg 14)}{2^{32}} \\in [0,1)'}</MathBlock>
        <p>
          每個 noise source 用獨立 named stream,seed = base_seed + offset
          (<code>ref:1, vco_w:2, vco_rw:3, dither_fb:4, dither_inj:5, dnl_fb:6,
          dnl_inj:7, lat:8, pulse:9</code>),預設 base_seed = 12345。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>
          test vector JSON 的頂層 schema(MODEL_SPEC §18)固定為
          <code>{'{name, generator, seed, config, tolerance, columns, data}'}</code>,
          其中 <code>tolerance</code> 的三個 key 就對應上面三級。
        </p>
      </SectionMath>

      <SectionExample>
        <p>
          手算驗證 <code>n3p130_nearest</code> 的 k=1 那一列(N=3.13,nearest quantizer):
        </p>
        <ul>
          <li><M>{'s_{ideal}[1] = 0 + 1 \\times 3.13 = 3.13'}</M>,
            <M>{'A_{ideal} = 256 \\times 3.13 = 801.28'}</M></li>
          <li>nearest:<M>{'A_{FB} = \\lfloor 801.28 + 0.5 \\rfloor = 801'}</M>;
            <M>{'I_{FB} = \\lfloor 801/256 \\rfloor = 3'}</M>,
            <M>{'R_{FB} = 801 \\bmod 256 = 33'}</M>,
            <M>{'m_{FB} = \\lfloor 33/64 \\rfloor = 0'}</M>,
            <M>{'c_{FB} = 33'}</M></li>
          <li>Mode D:<M>{'R_{INJ} = (0 - 33) \\bmod 256 = 223'}</M>;naive decode
            <M>{'j = \\lfloor 223/32 \\rfloor = 6'}</M>,<M>{'c = 223 \\bmod 32 = 31'}</M></li>
          <li>誤差:<M>{'e_{FB,abs} = 801/256 - 3.13 = -0.28\\ \\text{LSB} = -0.00109375'}</M> cycle
            = {formatPhase(-0.00109375, unit, tVco)};
            pair:<M>{'33/256 + 223/256 = 1.0 \\Rightarrow e_{pair} = \\operatorname{wrapCycles}(1.0) = 0'}</M></li>
        </ul>
        <p>
          對照 <code>test_vectors/csv/n3p130_nearest.csv</code> 的實際第 2 個資料列(逐字):
          <code>1,0.25,3,0,33,6,31,33,223,1</code> —— 即
          k=1, t=0.25 ns, n_int=3, m_FB=0, c_FB=33, j_INJ=6, c_INJ=31, R_FB=33,
          R_INJ=223, seq_id=1,與手算完全一致。<EpistemicTag kind="EXACT" />
        </p>
      </SectionExample>

      <SectionFigure
        title="model/python/ 模組結構圖"
        caption={
          <span>
            由下而上:§2/§12 基礎 primitives → element models 與 chain stages →
            simulate.py engine → CLI / pytest / test vectors。強調框的 simulate.py
            是唯一把整條鏈串起來的地方;本網站的 TS mirror 逐檔對應同名模組。
          </span>
        }
      >
        <ModuleMapSvg />
      </SectionFigure>

      <SectionFigure
        title="SimConfig 欄位表(39 欄位,名稱與預設逐字對應 config.py)"
        caption={
          <span>
            所有欄位經 <code>to_dict()/from_dict()</code> 與 JSON round-trip,直接嵌在每個
            test vector 的 <code>config</code> 欄位裡;TS 端 <code>fromPartial()</code>
            用相同的 snake_case 名稱,免轉換即可重播 vector config。
          </span>
        }
      >
        <div style={{ maxHeight: 420, overflowY: 'auto', overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr><th>欄位</th><th>預設</th><th>意義</th></tr>
            </thead>
            <tbody>
              {CONFIG_FIELDS.map((g) => (
                [
                  <tr key={g.group}>
                    <td colSpan={3} style={{ fontWeight: 600 }}>{g.group}</td>
                  </tr>,
                  ...g.rows.map(([name, def, desc]) => (
                    <tr key={name}>
                      <td><code>{name}</code></td>
                      <td><code>{def}</code></td>
                      <td>{desc}</td>
                    </tr>
                  )),
                ]
              ))}
            </tbody>
          </table>
        </div>
      </SectionFigure>

      <SectionFigure
        title="模組 → spec 對照表"
        caption={<span>每個 Python 檔案對應的 MODEL_SPEC 章節與職責。</span>}
      >
        <div style={{ maxHeight: 360, overflowY: 'auto', overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr><th>檔案</th><th>spec</th><th>職責</th></tr>
            </thead>
            <tbody>
              {MODULE_ROWS.map((r) => (
                <tr key={r.file}>
                  <td><code>{r.file}</code></td>
                  <td>{r.spec}</td>
                  <td>{r.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionFigure>

      <SectionFigure
        title="14 組 canonical test vectors:用 TS mirror 重播"
        caption={
          <span>
            右側選單選 vector(config 逐字對應 cli.py 的 VECTOR_CONFIGS;此處由 TS mirror
            以相同 config、相同 seed 重算)。軸:x = reference cycle k;y = 誤差,單位
            <UnitSwitch />。e_pair_digital 在 Mode D vectors 恆為 0;
            <code>n3p130_ef1_independent</code>(Mode B,獨立 ef1 state)則持續非零:
            512 拍中 326 拍(約 64%)在 {'{'}−1, 0, +1{'}'} LSB 之間跳動。
          </span>
        }
      >
        <EChart option={errOption} height={320} group="ch18" />
        <DebugTable
          columns={[
            { key: 'k', label: 'k' },
            { key: 'A_FB', label: 'A_FB' },
            { key: 'R_FB', label: 'R_FB' },
            { key: 'm_FB', label: 'm_FB' },
            { key: 'c_FB', label: 'c_FB' },
            { key: 'n_int', label: 'n_int' },
            { key: 'R_INJ', label: 'R_INJ' },
            { key: 'j_INJ', label: 'j_INJ' },
            { key: 'c_INJ', label: 'c_INJ' },
            { key: 'e_FB_abs', label: 'e_FB_abs', fmt: fmtErr },
            { key: 'e_pair_digital', label: 'e_pair_dig', fmt: fmtErr },
          ]}
          rows={tableRows}
          maxHeight={300}
          exportName={`ch18_${vec.id}.csv`}
        />
      </SectionFigure>

      <SectionCode
        language="bash"
        title="CLI 用法(model/python/cli.py)"
        code={CLI_USAGE}
      >
        <p>
          vector JSON 的 columns(schema-v1 23 欄,逐字對應 <code>VECTOR_COLUMNS</code>;schema-v2 vectors 末端追加 <code>inj_fired</code>;
          其中 <code>&quot;e_pair&quot;</code> 即 engine 的 <code>e_pair_digital</code>):
        </p>
        <p><code style={{ fontSize: '0.85em' }}>{VECTOR_COLUMNS_LIST}</code></p>
        <p>
          command CSV(<code>test_vectors/csv/</code>,給 Verilog-A testbench,第 19 章)欄位:
          <code>k, t_ref_ns, n_int, m_FB, c_FB, j_INJ, c_INJ, R_FB, R_INJ, seq_id</code>。
        </p>
        <Callout type="note" title="pytest 摘要">
          <p>
            <code>python3 -m pytest -q</code> → <strong>61 passed</strong>(0.39 s)。
            <EpistemicTag kind="EXPERIMENT" /> 測試分佈:units/constants、phase_math
            wrap 慣例、PRNG 逐位向量、quantizer canonical cases(§6 0.3 LSB 例)、
            Mode D identity(Test 2/3)、latency(Test 5)、mismatch(Test 6/7)、
            dynamics(Test 14)、measurements(§17)、N sweep(Test 8)、
            vectors 可重現性(<code>--emit-vectors</code> 兩次輸出 byte-for-byte 相同)。
            TS 端 <code>web/src/model/__tests__/</code> 有 12 個 vitest 檔對應,其中
            <code>vectors.test.ts</code> 直接載入 14 組 JSON 逐 cycle 比對。
          </p>
        </Callout>
      </SectionCode>

      <SectionCode language="python" title="節錄 1 — feedback_scheduler.py:quantize + decode + assertions" code={PY_FEEDBACK_EXCERPT} />
      <SectionCode language="python" title="節錄 2 — injection_scheduler.py:Mode D 的 modular reverse" code={PY_MODE_D_EXCERPT} />
      <SectionCode language="python" title="節錄 3 — noise_models.py:mulberry32(逐位一致 PRNG)" code={PY_MULBERRY_EXCERPT} />
      <SectionCode language="python" title="節錄 4 — cli.py:test vector schema 與 tolerance" code={PY_VECTOR_EXCERPT} />

      <SectionLineByLine
        items={[
          {
            code: 'y = q.quantize(u); a_fb[k] = y',
            explain:
              '單一 quantizer instance 逐拍前進:ef1/mash11 的 state 只在這裡演進一次,' +
              '順序即 k 順序 —— 這是跨語言逐位一致的必要條件(state 演進順序不同結果就分岔)。',
          },
          {
            code: 'assert np.all(d > 0)',
            explain:
              'MODEL_SPEC §4 assertion:A_FB 嚴格遞增(edge monotonic、無 duplicate、' +
              '無 backward)。golden model 把物理合法性寫成硬 assert,而非事後檢查。',
          },
          {
            code: 'i_fb = a_fb // g; r_fb = a_fb % g',
            explain:
              'decode 全部用整數運算(floor division 與 mod),I_FB/R_FB/m_FB/c_FB ' +
              '因此天生是 exact integer,對應 tolerance 的「int: 0」級。',
          },
          {
            code: 'if cfg.arch_mode == "D": r_inj[:] = (cfg.r_zero - r_fb) % g',
            explain:
              'Mode D 一行完成:R_INJ = (R_zero − R_FB) mod 256。沒有第二個 quantizer、' +
              '沒有第二份 state,identity (R_FB+R_INJ) mod 256 = R_zero 由構造保證。',
          },
          {
            code: 'q = make_quantizer(cfg.quantizer)  # A, B, C',
            explain:
              '非 D mode 走獨立 quantizer instance(獨立 error state)—— 這正是 Mode B ' +
              'pair error 非零的來源,程式碼結構直接對應 §7 的架構分類。',
          },
          {
            code: 'self.s = (self.s + 0x6D2B79F5) & _MASK',
            explain:
              'mulberry32 全程 uint32(& 0xFFFFFFFF)。整數運算沒有浮點捨入,' +
              'Python 與 TS 可逐位相同 —— 這是 noise 路徑可驗證的根基。',
          },
          {
            code: '"tolerance": {"int": 0, "float_abs": 1e-12, "noise_abs": 1e-9}',
            explain:
              'tolerance 不是 hard-coded 在測試裡,而是 vector 檔自帶的契約欄位;' +
              'TS 測試讀 JSON 拿到的就是驗收標準本身。',
          },
          {
            code: '"config": cfg.to_dict()',
            explain:
              '完整 SimConfig 嵌入 vector:任何人拿到 JSON 就能在任一語言重播同一模擬,' +
              '不需要另外對參數 —— reproducibility 的關鍵設計。',
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>選 <code>n3p130_nearest</code>:e_FB_abs 呈鋸齒狀、界在 ±0.5 LSB
            (±0.001953 cycle)內;<strong>e_pair_digital 整條是 0</strong>(Mode D identity)。</li>
          <li>切到 <code>n3p130_ef1_independent</code>(Mode B):e_pair_digital
            持續在 ±1 LSB 之間跳動(512 拍中 326 拍非零,約 64%)—— 兩個獨立 DSM state
            各走各的。這就是 Test 13「shared vs independent」的可視化。</li>
          <li>切到 <code>n3p130_latency_bug</code>:e_FB_abs / e_INJ_abs 整段偏移約
            0.13 cycle(46.8°)—— Test 5 的 latency bug;換 <code>n3p130_lookahead</code>
            偏移消失,只剩 ±half-LSB 量化誤差。</li>
          <li>表格中任一列驗證 <M>{'(R_{FB} + R_{INJ}) \\bmod 256 = 0'}</M>;
            CSV export 的數值是 full precision,可直接 diff Python 的
            <code>test_vectors/csv/</code> 輸出。</li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解:「兩種語言的浮點運算必然有差,逐位一致不可能」">
          <p>
            錯。IEEE-754 float64 的加減乘除與 <code>floor</code> 在兩語言中是
            deterministic 且逐位相同的;會分岔的只有 libm 超越函數(sin/cos/log)與
            內建 <code>round()</code>(Python banker&apos;s rounding vs JS half-up)。
            golden model 的做法是:純數位路徑只用前者(所以 tolerance 可以是 0 與
            1e-12),把後者隔離到 noise 路徑(1e-9),並以
            <M>{'\\lfloor u+0.5 \\rfloor'}</M> 取代 round()。
            「做不到一致」通常是實作紀律問題,不是浮點的本質限制。
            <EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>單一數學契約(MODEL_SPEC)+ 單一 executable reference(Python)+
            凍結的 test vectors,是多語言 behavioral model 不分岔的最低配置。</li>
          <li>tolerance 分級要跟著誤差來源走:整數 code 沒有理由不完全相等;
            會過 libm 的才放寬。把 1e-9 用在整數 column 上等於白測。</li>
          <li>vector 自帶 config 與 tolerance,讓驗收標準跟資料一起版本化;
            <code>--emit-vectors</code> 的 byte-for-byte 可重現性本身也是測試項目。</li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            pytest 的 61 個測試驗證的是 <strong>digital/timing identity 與 behavioral
            noise model 的自洽</strong>,不是電路事實:tap/DTC mismatch 是 behavioral
            假設模型、injection map 是 approximation(§14)、shorting energy 是
            normalized proxy(§15)。vectors 固定 512 cycles、seed 12345 ——
            對更長序列或其他 seed 的行為是外插。Python↔TS 一致只證明「兩份程式碼
            實作了同一份數學」,不證明「這份數學等於 silicon」。(MODEL_SPEC §20)
          </p>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="Vector 選擇">
        <SelectControl
          label="test vector"
          value={vecId}
          options={VECTOR_CONFIGS.map((v) => ({ value: v.id, label: `${v.id} — ${v.note}` }))}
          onChange={setVecId}
        />
        <Toggle label="表格顯示全部 512 列(否則前 64 列)" checked={showAllRows} onChange={setShowAllRows} />
      </ParamPanel>
    </ChapterShell>
  );
}
