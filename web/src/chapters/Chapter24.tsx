/**
 * Chapter 24 — Scheduler RTL Reference 數位排程器 RTL
 *
 * 從 float64 golden model 交接到 fixed-point 硬體:rtl/frac_phase_scheduler.sv
 * (+ rtl/fps_quantizer.sv、rtl/fps_decode.sv)的 fixed-point 格式、FCW、
 * nearest / floor / ef1 的整數實作、look-ahead pre-advance、bit-exact 驗證
 * 方法(rtl/gen_vectors.py + rtl/run_sim.py)與合成統計(rtl/synth_stat.txt)。
 *
 * - RTL / Python 摘錄逐字取自 rtl/*.sv 與 rtl/gen_vectors.py(標明行號)。
 * - 驗證數字(50/50 PASS、204 634 cycles、1 637 072 values)與合成 cell 數
 *   取自 RTL_USAGE.md §6–§7 與 rtl/synth_stat.txt(recorded,非瀏覽器重跑)。
 * - FCW 一律以 BigInt exact rational 計算,語意等同 rtl/gen_vectors.py::fcw_of
 *   (Fraction(str(N)) · 2^(8+F) + 1/2 取 floor)。
 * - 互動模擬只經由 ../model(simulate / fromPartial / qNearest / configTVcoS)。
 */

import { useEffect, useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
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
import type { ExampleInput, ExampleResult } from '../components/ExampleProblem';
import { M, MathBlock } from '../components/Math';
import {
  ParamPanel,
  Slider,
  NumberInput,
  SelectControl,
  PresetButtons,
} from '../components/controls';
import DebugTable from '../components/DebugTable';
import { makeLineOption, baseAxis, makeMarkLine } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { trimNumber } from '../lib/format';
import { useChapterNDiv } from '../lib/globalParams';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  simulate,
  fromPartial,
  defaultConfig,
  qNearest,
  configTVcoS,
} from '../model';

/* ------------------------------------------------------------------ meta */

const CHAPTER_ID = 24;
/** registry entry (slug scheduler-rtl) is added by the integration step;
 *  fall back to the contract title so the chapter renders standalone. */
const meta = chapterById(CHAPTER_ID) ?? {
  id: CHAPTER_ID,
  titleZh: '數位排程器 RTL',
  titleEn: 'Scheduler RTL Reference',
};

/* ------------------------------------------------- exact fixed-point math */

/** G = 256 fine codes per VCO cycle -> 8 fine-code bits (rtl/gen_vectors.py G_BITS). */
const G_BITS = 8;
const TWO_53 = 1n << 53n;
/** RTL default integer width (rtl/frac_phase_scheduler.sv parameter IW). */
const IW_DEFAULT = 4;
/** f_ref of the default config (MODEL_SPEC §1), used by the explorer table. */
const F_REF_HZ = defaultConfig().f_ref_hz;

const pow2 = (n: number): bigint => 1n << BigInt(n);
const pow10 = (d: number): bigint => 10n ** BigInt(d);

/** An exact decimal value num / 10^digits plus the text it was parsed from. */
interface ExactDecimal {
  text: string;
  num: bigint;
  digits: number;
}

/**
 * Parse a non-negative decimal literal exactly (String(float64) yields the
 * shortest round-trip decimal — the same text Fraction(str) sees in
 * rtl/gen_vectors.py).
 */
function parseDecimal(text: string): ExactDecimal {
  const m = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (m === null) throw new Error(`無法解析十進位數 ${text}`);
  const ip = m[1];
  const fp = m[2] ?? '';
  const ex = m[3] === undefined ? 0 : Number(m[3]);
  let num = BigInt(ip + fp);
  let digits = fp.length - ex;
  if (digits < 0) {
    num *= pow10(-digits);
    digits = 0;
  }
  return { text, num, digits };
}

const decimalOf = (x: number): ExactDecimal => parseDecimal(String(x));

/** FCW = round(N · 256 · 2^F), half up, exact rational (gen_vectors.py::fcw_of). */
function fcwOfDecimal(d: ExactDecimal, F: number): bigint {
  const den = pow10(d.digits);
  return (2n * d.num * pow2(G_BITS + F) + den) / (2n * den);
}

/** exact decimal text of num / 10^digits (DISPLAY) */
function decimalText(num: bigint, digits: number): string {
  const neg = num < 0n;
  const a = neg ? -num : num;
  const den = pow10(digits);
  const ip = a / den;
  const rem = a % den;
  const body =
    rem === 0n
      ? ip.toString()
      : `${ip.toString()}.${rem.toString().padStart(digits, '0').replace(/0+$/, '')}`;
  return neg ? `−${body}` : body;
}

/** exact (finite) decimal expansion of a / 2^s = a·5^s / 10^s (DISPLAY) */
const dyadicText = (a: bigint, s: number): string => decimalText(a * 5n ** BigInt(s), s);

/** hex digits grouped by 4 with underscores (SystemVerilog style) */
function hexGroups(v: bigint): string {
  const h = v.toString(16).toUpperCase();
  const parts: string[] = [];
  for (let end = h.length; end > 0; end -= 4) parts.unshift(h.slice(Math.max(0, end - 4), end));
  return parts.join('_');
}
const hexOf = (v: bigint): string => `0x${hexGroups(v)}`;

/** display-grade BigInt ratio */
const ratio = (a: bigint, b: bigint): number => Number(a) / Number(b);

interface FcwInfo {
  dec: ExactDecimal;
  F: number;
  IW: number;
  /** accumulator / fcw port width W = IW + 8 + F */
  W: number;
  /** 8 + F */
  shift: number;
  /** N · 2^(8+F) as an exact decimal */
  scaledExact: string;
  fcw: bigint;
  bits: number;
  /** FCW / 2^(8+F) as float64 (exact while FCW < 2^53) */
  nReal: number;
  nRealExact: string;
  /** N_real − N, exact rational rounded once to float64 */
  dN: number;
  /** RTL requirement N + 1 < 2^IW (exact) */
  fitsPort: boolean;
  /** FCW < 2^53 so N_real is exactly representable in float64 */
  floatExact: boolean;
  /** largest k with k·FCW + 2^F < 2^53 (gen_vectors.assert_float_exact) */
  kMax: bigint;
}

function fcwInfo(dec: ExactDecimal, F: number, IW: number): FcwInfo {
  const shift = G_BITS + F;
  const den = pow10(dec.digits);
  const fcw = fcwOfDecimal(dec, F);
  const dNnum = fcw * den - dec.num * pow2(shift);
  return {
    dec,
    F,
    IW,
    W: IW + G_BITS + F,
    shift,
    scaledExact: decimalText(dec.num * pow2(shift), dec.digits),
    fcw,
    bits: fcw === 0n ? 1 : fcw.toString(2).length,
    nReal: ratio(fcw, pow2(shift)),
    nRealExact: dyadicText(fcw, shift),
    dN: ratio(dNnum, den * pow2(shift)),
    fitsPort: dec.num + den < den * pow2(IW),
    floatExact: fcw < TWO_53,
    kMax: fcw === 0n ? -1n : (TWO_53 - 1n - pow2(F)) / fcw,
  };
}

/** group a decimal integer string by 3 digits with thin spaces (DISPLAY) */
function groupDigits(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
}

/** frequency with an auto SI prefix (DISPLAY; numbers via lib/format trimNumber) */
function fmtHz(hz: number, sig = 4): string {
  if (!Number.isFinite(hz)) return String(hz);
  const a = Math.abs(hz);
  if (a === 0) return '0 Hz';
  // [threshold, scale, unit]: sub-Hz values stay in Hz down to 0.1 Hz
  const units: [number, number, string][] = [
    [1e9, 1e9, 'GHz'],
    [1e6, 1e6, 'MHz'],
    [1e3, 1e3, 'kHz'],
    [0.1, 1, 'Hz'],
    [1e-4, 1e-3, 'mHz'],
    [1e-7, 1e-6, 'µHz'],
  ];
  for (const [threshold, scale, unit] of units) {
    if (a >= threshold) return `${trimNumber(hz / scale, sig).replace(/^-/, '−')} ${unit}`;
  }
  return `${trimNumber(hz / 1e-9, sig).replace(/^-/, '−')} nHz`;
}

const signed = (s: string): string => s.replace(/^-/, '−');

/* ------------------------------------------------ RTL pre-advance (§5) */

const Q_NAMES = ['nearest', 'floor', 'ef1'] as const;
type Q3 = (typeof Q_NAMES)[number];

interface PreAdvance {
  fcw: bigint;
  W: number;
  accRst: bigint;
  accWrapped: boolean;
  curRst: bigint;
  triPrev: number;
  efPrev: bigint;
  off: bigint;
  aCurRst: bigint;
  efRst: bigint;
  efClosed: bigint;
}

/**
 * Bit-accurate transcription of the reset path of frac_phase_scheduler.sv:
 *   acc_rst = K_ACC * fcw, cur_rst_u = K_CUR * fcw (mod 2^W),
 *   ef_prev_rst = K_EF * fcw[F-1:0] (mod 2^F), u_q_rst = fps_quantizer.
 */
function preAdvance(fcw: bigint, F: number, IW: number, lat: number, q: Q3): PreAdvance {
  const W = IW + G_BITS + F;
  const maskW = pow2(W) - 1n;
  const maskF = pow2(F) - 1n;
  const L = BigInt(lat);
  const accFull = (L + 1n) * fcw;
  const accRst = accFull & maskW;
  const curRst = (L * fcw) & maskW;
  const triPrev = (lat * (lat - 1)) / 2;
  const efPrev = (BigInt(triPrev) * (fcw & maskF)) & maskF;
  const off = q === 'nearest' ? pow2(F - 1) : q === 'ef1' ? efPrev : 0n;
  const v = (curRst + off) & maskW;
  const aCurRst = v >> BigInt(F);
  const efRst = q === 'ef1' ? v & maskF : 0n;
  const efClosed = ((fcw * L * (L + 1n)) / 2n) & maskF;
  return {
    fcw,
    W,
    accRst,
    accWrapped: accFull !== accRst,
    curRst,
    triPrev,
    efPrev,
    off,
    aCurRst,
    efRst,
    efClosed,
  };
}

/* ----------------------------------------------- verified case matrix */

/** rtl/gen_vectors.py::N_TARGETS */
const N_TARGETS: [string, string][] = [
  ['n3p13', '3.13'],
  ['n3p125', '3.125'],
  ['n3p2', '3.2'],
  ['n3p126953125', '3.126953125'],
  ['n3p001', '3.001'],
];
const CASE_LATS = [0, 1, 3];
const CASE_RZ = [0, 10];
const N_VEC_CYCLES = 2048;
const N_SIGNALS = 8; // n_int, m_fb, c_fb, r_fb, r_inj, j_inj, c_inj, seq_id

/** FCW values committed in rtl/vectors/manifest.json (consistency check) */
const MANIFEST_FCW: Record<string, bigint> = {
  '3.13|24': 13443247636n,
  '3.125|24': 13421772800n,
  '3.2|24': 13743895347n,
  '3.126953125|24': 13430161408n,
  '3.001|24': 12889196855n,
  '3.13|16': 52512686n,
  '3.126953125|16': 52461568n,
  '3.001|32': 3299634394956n,
};

/** recorded results (RTL_USAGE.md §6; rtl/run_sim.py SUMMARY line) */
const RECORDED = { cases: 50, pass: 50, cycles: 204634, values: 1637072 };

interface CaseRow extends Record<string, unknown> {
  idx: number;
  name: string;
  n_target: string;
  F: number;
  fcw: string;
  fcw_hex: string;
  n_realized: number;
  manifest: string;
  quantizer: Q3;
  lat: number;
  r_zero: number;
  cycles: number;
  values: number;
  result: string;
}

function buildCases(): CaseRow[] {
  const rows: CaseRow[] = [];
  const add = (nid: string, nTarget: string, q: Q3, lat: number, rz: number, F = 24) => {
    const fcw = fcwOfDecimal(parseDecimal(nTarget), F);
    const want = MANIFEST_FCW[`${nTarget}|${F}`];
    const cycles = 2 * (N_VEC_CYCLES - lat);
    rows.push({
      idx: rows.length + 1,
      name: `${nid}_${q}_lat${lat}_rz${rz}${F !== 24 ? `_f${F}` : ''}`,
      n_target: nTarget,
      F,
      fcw: fcw.toString(),
      fcw_hex: hexOf(fcw),
      n_realized: ratio(fcw, pow2(G_BITS + F)),
      manifest: want === fcw ? '一致' : '不一致',
      quantizer: q,
      lat,
      r_zero: rz,
      cycles,
      values: cycles * N_SIGNALS,
      result: 'PASS',
    });
  };
  N_TARGETS.forEach(([nid, nTarget], ni) => {
    Q_NAMES.forEach((q, qi) => {
      CASE_LATS.forEach((lat, li) => {
        add(nid, nTarget, q, lat, CASE_RZ[(ni + qi + li) % 2]);
      });
    });
  });
  add('n3p13', '3.13', 'ef1', 8, 10);
  add('n3p13', '3.13', 'nearest', 8, 0);
  add('n3p13', '3.13', 'ef1', 1, 0, 16);
  add('n3p126953125', '3.126953125', 'nearest', 3, 10, 16);
  add('n3p001', '3.001', 'ef1', 3, 10, 32);
  return rows;
}

const CASE_COLUMNS = [
  { key: 'idx', label: '#' },
  { key: 'name', label: 'case' },
  { key: 'n_target', label: 'N target' },
  { key: 'F', label: 'F' },
  { key: 'fcw_hex', label: 'FCW (hex)' },
  {
    key: 'n_realized',
    label: 'N_realized',
    fmt: (v: unknown) => (typeof v === 'number' ? String(v) : ''),
  },
  { key: 'manifest', label: 'FCW = manifest' },
  { key: 'quantizer', label: 'q' },
  { key: 'lat', label: 'LAT' },
  { key: 'r_zero', label: 'R_zero' },
  { key: 'cycles', label: 'cycles (2 passes)' },
  { key: 'values', label: 'values (×8)' },
  { key: 'result', label: 'result (recorded)' },
];

/** rtl/synth_stat.txt (yosys 0.69 synth -flatten, F=24 IW=4 SEQW=16) */
const SYNTH = [
  { lat: 0, cells: 577, ff: 88, comb: 489, latches: 0 },
  { lat: 1, cells: 837, ff: 125, comb: 712, latches: 0 },
  { lat: 3, cells: 1240, ff: 199, comb: 1041, latches: 0 },
];

/* ------------------------------------------------------ explorer (§fig 2) */

const EXPLORER_F = [8, 12, 16, 24];
const WINDOW_OPTIONS = ['512', '1024', '2048', '4096'] as const;
type WindowOpt = (typeof WINDOW_OPTIONS)[number];

interface DiffCell {
  first: number | null;
  count: number;
  ks: number[];
}

interface ExplorerRow {
  info: FcwInfo;
  cells: Record<Q3, DiffCell>;
}

/** R_FB of simulate() at the requested N vs at the realized dyadic N per F. */
function runExplorer(nDiv: number, win: number): ExplorerRow[] {
  const dec = decimalOf(nDiv);
  const reqR = {} as Record<Q3, Float64Array>;
  for (const q of Q_NAMES) {
    reqR[q] = simulate(fromPartial({ n_div: nDiv, n_cycles: win, quantizer: q })).data.R_FB;
  }
  return EXPLORER_F.map((F) => {
    const info = fcwInfo(dec, F, IW_DEFAULT);
    const cells = {} as Record<Q3, DiffCell>;
    for (const q of Q_NAMES) {
      const realR = simulate(fromPartial({ n_div: info.nReal, n_cycles: win, quantizer: q })).data
        .R_FB;
      const ks: number[] = [];
      for (let k = 0; k < win; k++) {
        if (realR[k] !== reqR[q][k]) ks.push(k);
      }
      cells[q] = { first: ks.length > 0 ? ks[0] : null, count: ks.length, ks };
    }
    return { info, cells };
  });
}

/* --------------------------------------------------- example problems */

const EX1_INPUTS: ExampleInput[] = [
  { key: 'N', label: <M>{'N'}</M>, def: 3.13, min: 1, max: 14, step: 0.001 },
  { key: 'F', label: <M>{'F'}</M>, def: 24, min: 1, max: 40, step: 1, unit: 'bits' },
  { key: 'IW', label: <M>{'IW'}</M>, def: 4, min: 3, max: 8, step: 1, unit: 'bits' },
];

function computeEx1(v: Record<string, number>): ExampleResult {
  const F = Math.round(v.F);
  const IW = Math.round(v.IW);
  const dec = decimalOf(v.N);
  const info = fcwInfo(dec, F, IW);
  // float64 cross-check through the model's half-up quantizer (MODEL_SPEC §2)
  const qModel = qNearest(v.N * 2 ** (G_BITS + F));
  const agree = Number.isSafeInteger(qModel) && BigInt(qModel) === info.fcw;
  const warns: string[] = [];
  if (F !== v.F || IW !== v.IW) warns.push('F / IW 必須是整數,已取最近整數');
  if (!info.fitsPort) warns.push('違反 RTL 條件 N + 1 < 2^IW:n_int 與整數 cycle 欄位會 wrap');
  if (!agree)
    warns.push('float64 qNearest 與 exact rational 結果不同:N 的 float64 表示誤差剛好跨過 tie');
  return {
    steps: [
      {
        label: <>N 的 exact 十進位有理數(gen_vectors 的 Fraction(str))</>,
        value: `${dec.text} = ${dec.num.toString()} / ${pow10(dec.digits).toString()}`,
      },
      { label: <M>{'2^{8+F}'}</M>, value: pow2(info.shift).toString() },
      { label: <><M>{'N\\cdot 2^{8+F}'}</M>(exact)</>, value: info.scaledExact },
      {
        label: <M>{'\\mathrm{FCW} = \\lfloor N\\,2^{8+F} + \\tfrac12 \\rfloor'}</M>,
        value: groupDigits(info.fcw.toString()),
      },
      {
        label: <>model 交叉檢查:<M>{'\\operatorname{qNearest}(N\\cdot 2^{8+F})'}</M>(float64)</>,
        value: `${qModel}${agree ? '(與 exact 一致)' : '(不一致)'}`,
      },
      { label: <>hex / 有效位元數</>, value: `${hexOf(info.fcw)}(${info.bits} bits)` },
      {
        label: <>port 寬度 <M>{'W = IW + 8 + F'}</M>(SystemVerilog literal)</>,
        value: `${info.W}'h${hexGroups(info.fcw)}`,
      },
      { label: <M>{'N_{real} = \\mathrm{FCW}/2^{8+F}'}</M>, value: String(info.nReal) },
      { label: <><M>{'N_{real}'}</M> exact decimal(dyadic,有限位數)</>, value: info.nRealExact },
    ],
    answer: (
      <>
        FCW = {groupDigits(info.fcw.toString())} = {hexOf(info.fcw)}({info.W}-bit port),{' '}
        <M>{'N_{real}'}</M> = {String(info.nReal)}
      </>
    ),
    warn: warns.length > 0 ? warns.join(';') : undefined,
  };
}

const EX2_INPUTS: ExampleInput[] = [
  { key: 'fref', label: <M>{'f_{ref}'}</M>, def: 4, min: 0.01, max: 100, step: 0.1, unit: 'GHz' },
  { key: 'N', label: <M>{'N'}</M>, def: 3.13, min: 1, max: 14, step: 0.001 },
  { key: 'F', label: <M>{'F'}</M>, def: 24, min: 1, max: 40, step: 1, unit: 'bits' },
];

function computeEx2(v: Record<string, number>): ExampleResult {
  const F = Math.round(v.F);
  const fRefHz = v.fref * 1e9;
  const info = fcwInfo(decimalOf(v.N), F, IW_DEFAULT);
  const res = fRefHz / 2 ** (G_BITS + F);
  const df = info.dN * fRefHz;
  const ppb = (info.dN / v.N) * 1e9;
  // realized VCO frequency through the model's T_vco definition (MODEL_SPEC §1)
  const fVcoReal = 1 / configTVcoS(fromPartial({ n_div: info.nReal, f_ref_hz: fRefHz }));
  const boundRatio = Math.abs(df) / (res / 2);
  return {
    steps: [
      { label: <><M>{'\\Delta f_{res} = f_{ref}/2^{8+F}'}</M></>, value: fmtHz(res, 6) },
      { label: <>FCW</>, value: `${groupDigits(info.fcw.toString())} = ${hexOf(info.fcw)}` },
      { label: <M>{'N_{real}'}</M>, value: String(info.nReal) },
      { label: <><M>{'\\Delta N = N_{real} - N'}</M>(exact)</>, value: signed(fmt(info.dN, 6)) },
      { label: <><M>{'\\Delta f_{vco} = \\Delta N\\cdot f_{ref}'}</M></>, value: fmtHz(df, 6) },
      { label: <>相對誤差 <M>{'\\Delta N/N'}</M></>, value: `${signed(fmt(ppb, 4))} ppb` },
      {
        label: <><M>{'f_{vco,real} = 1/T_{vco}'}</M>(model configTVcoS)</>,
        value: `${fmt(fVcoReal, 15)} Hz`,
      },
      {
        label: <><M>{'|\\Delta f_{vco}| / (\\Delta f_{res}/2)'}</M>(必須 ≤ 1)</>,
        value: fmt(boundRatio, 4),
      },
    ],
    answer: (
      <>
        解析度 {fmtHz(res)};realized 頻率誤差 {fmtHz(df)}({signed(fmt(ppb, 3))} ppb)
      </>
    ),
    warn: F !== v.F ? 'F 必須是整數,已取最近整數' : undefined,
  };
}

const EX3_INPUTS: ExampleInput[] = [
  { key: 'alpha', label: <M>{'\\alpha'}</M>, def: 0.13, min: 0, max: 0.999, step: 0.001 },
  { key: 'LAT', label: <M>{'LAT'}</M>, def: 3, min: 0, max: 8, step: 1 },
  { key: 'F', label: <M>{'F'}</M>, def: 24, min: 1, max: 40, step: 1, unit: 'bits' },
  { key: 'q', label: <>q_mode(0 nearest · 1 floor · 2 ef1)</>, def: 2, min: 0, max: 2, step: 1 },
];

function computeEx3(v: Record<string, number>): ExampleResult {
  const F = Math.round(v.F);
  const lat = Math.round(v.LAT);
  const q: Q3 = Q_NAMES[Math.round(v.q)];
  const IW = IW_DEFAULT;
  const n = 3 + v.alpha;
  const info = fcwInfo(decimalOf(n), F, IW);
  const p = preAdvance(info.fcw, F, IW, lat, q);
  const lsb = (x: bigint): number => ratio(x, pow2(F));
  // golden-model cross-check: A_FB[LAT] of simulate() at the realized dyadic N
  const exact = info.floatExact && BigInt(lat + 1) * info.fcw + pow2(F) < TWO_53;
  let check = '略過(float64 路徑非 exact)';
  let match = true;
  if (exact) {
    const res = simulate(fromPartial({ n_div: info.nReal, n_cycles: lat + 2, quantizer: q }));
    const aFb = BigInt(res.data.A_FB[lat]);
    const mod = aFb & (pow2(IW + G_BITS) - 1n);
    match = mod === p.aCurRst;
    check = `A_FB[${lat}] = ${aFb.toString()} → mod 2^${IW + G_BITS} = ${mod.toString()}${
      match ? '(一致)' : '(不一致)'
    }`;
  }
  const warns: string[] = [];
  if (F !== v.F || lat !== v.LAT || Math.round(v.q) !== v.q) warns.push('F / LAT / q_mode 已取整');
  if (p.accWrapped) warns.push(`(LAT+1)·FCW ≥ 2^${p.W}:accumulator 已 wrap(合法,decode 只用低位與差值)`);
  if (!match) warns.push('與 golden model 不一致');
  return {
    steps: [
      { label: <>FCW(N = 3 + α = {String(n)})</>, value: hexOf(info.fcw) },
      {
        label: <><M>{'\\texttt{acc\\_rst} = (LAT+1)\\cdot\\mathrm{FCW} \\bmod 2^W'}</M></>,
        value: `${hexOf(p.accRst)}(W = ${p.W})`,
      },
      {
        label: <><M>{'\\texttt{cur\\_rst\\_u} = LAT\\cdot\\mathrm{FCW}'}</M></>,
        value: hexOf(p.curRst),
      },
      {
        label: <><M>{'e[LAT-1] = \\mathrm{FCW}\\cdot\\tfrac{LAT(LAT-1)}{2} \\bmod 2^F'}</M></>,
        value: `${p.efPrev.toString()}(TRI_PREV = ${p.triPrev};${fmt(lsb(p.efPrev), 8)} LSB)`,
      },
      {
        label: <>quantizer offset(q = {q})</>,
        value: `${p.off.toString()}(${fmt(lsb(p.off), 8)} LSB)`,
      },
      {
        label: <><M>{'\\texttt{a\\_cur\\_rst} = (\\texttt{cur} + \\texttt{off}) \\gg F'}</M> = <M>{'A_{FB}[LAT] \\bmod 2^{IW+8}'}</M></>,
        value: `${p.aCurRst.toString()} = ${hexOf(p.aCurRst)}(R_FB = ${(p.aCurRst & 255n).toString()})`,
      },
      {
        label: <><M>{'\\texttt{ef\\_rst} = e[LAT]'}</M>(ef1;closed form <M>{'\\mathrm{FCW}\\tfrac{LAT(LAT+1)}{2} \\bmod 2^F'}</M>)</>,
        value:
          q === 'ef1'
            ? `${p.efRst.toString()}(${fmt(lsb(p.efRst), 8)} LSB;closed form ${p.efClosed.toString()}${
                p.efClosed === p.efRst ? ' 一致' : ' 不一致'
              })`
            : '0(非 ef1)',
      },
      { label: <>golden model 交叉檢查</>, value: check },
    ],
    answer: (
      <>
        acc_q = {hexOf(p.accRst)},a_cur_q = {p.aCurRst.toString()},ef_q ={' '}
        {p.efRst.toString()}
        {q === 'ef1' ? `(${fmt(lsb(p.efRst), 6)} LSB)` : ''},seq_q = {lat}
      </>
    ),
    warn: warns.length > 0 ? warns.join(';') : undefined,
  };
}

/* ----------------------------------------------------------- RTL excerpts */

const CODE_QUANTIZER = `// rtl/fps_quantizer.sv (lines 35–54) — MODEL_SPEC §6 in fixed point
    localparam logic [1:0] Q_NEAREST = 2'd0;
    localparam logic [1:0] Q_EF1     = 2'd2;

    // 0.5 LSB in UQ(CW).F
    localparam logic [CW+F-1:0] HALF = {{(CW+F-1){1'b0}}, 1'b1} << (F - 1);

    logic [CW+F-1:0] off;
    logic [CW+F-1:0] v;

    always_comb begin
        case (q_mode)
            Q_NEAREST: off = HALF;
            Q_EF1:     off = {{CW{1'b0}}, e_in};
            default:   off = '0;               // floor (and reserved 2'd3)
        endcase
        v = a + off;
    end

    assign y     = v[CW+F-1:F];
    assign e_out = (q_mode == Q_EF1) ? v[F-1:0] : '0;`;

const CODE_CORE = `// rtl/frac_phase_scheduler.sv (lines 87–92) — look-ahead pre-advance constants
    localparam int TRI_PREV = (LAT * (LAT - 1)) / 2;

    localparam logic [W-1:0]    K_ACC = LAT + 1;
    localparam logic [W-1:0]    K_CUR = LAT;
    localparam logic [F-1:0]    K_EF  = TRI_PREV;
    localparam logic [SEQW-1:0] K_SEQ = LAT;

// rtl/frac_phase_scheduler.sv (lines 120–156) — reset closed form + state update
    assign acc_rst     = K_ACC * fcw;
    assign cur_rst_u   = K_CUR * fcw;
    assign ef_prev_rst = K_EF * fcw[F-1:0];

    fps_quantizer #(.F(F), .CW(CW)) u_q_rst (
        .a      (cur_rst_u),
        .e_in   (ef_prev_rst),
        .q_mode (q_mode),
        .y      (a_cur_rst),
        .e_out  (ef_rst)
    );

    // quantizer of the look-ahead index j+1 (needed for n_int[j])
    logic [CW-1:0] a_nxt;
    logic [F-1:0]  ef_nxt;

    fps_quantizer #(.F(F), .CW(CW)) u_q_run (
        .a      (acc_q),
        .e_in   (ef_q),
        .q_mode (q_mode),
        .y      (a_nxt),
        .e_out  (ef_nxt)
    );

    always_ff @(posedge clk) begin
        if (rst) begin
            acc_q   <= acc_rst;
            ef_q    <= ef_rst;
            a_cur_q <= a_cur_rst;
            seq_q   <= K_SEQ;
        end else if (en) begin
            acc_q   <= acc_q + fcw;
            ef_q    <= ef_nxt;
            a_cur_q <= a_nxt;
            seq_q   <= seq_q + 1'b1;
        end
    end`;

const CODE_DECODE = `// rtl/fps_decode.sv (lines 33–35) — MODEL_SPEC §4 decode + §7 Mode D reverse
    assign n_int = a_nxt[IW+7:8] - a_cur[IW+7:8];
    assign r_fb  = a_cur[7:0];
    assign r_inj = r_zero - a_cur[7:0];

// rtl/frac_phase_scheduler.sv (lines 174–175, 182–198, 209–212)
    logic [PW-1:0] cmd_core;
    assign cmd_core = {1'b1, n_int_c, r_fb_c, r_inj_c, seq_q};

    generate
        if (LAT == 0) begin : g_lat0
            assign cmd_out = cmd_core;
        end else begin : g_lat
            logic [LAT*PW-1:0]     pipe_q;      // [PW-1:0] newest .. top = oldest
            logic [(LAT+1)*PW-1:0] pipe_shift;

            assign pipe_shift = {pipe_q, cmd_core};

            always_ff @(posedge clk) begin
                if (rst)     pipe_q <= '0;
                else if (en) pipe_q <= pipe_shift[LAT*PW-1:0];
            end

            assign cmd_out = pipe_q[LAT*PW-1 -: PW];
        end
    endgenerate

    assign m_fb   = r_fb[7:6];
    assign c_fb   = r_fb[5:0];
    assign j_inj  = r_inj[7:5];
    assign c_inj  = {1'b0, r_inj[4:0]};`;

const CODE_GEN = `# rtl/gen_vectors.py (lines 67–70, 112–125) — FCW and the float64-exactness guard
def fcw_of(n_target: str, f_bits: int) -> int:
    """FCW = round(N * 256 * 2^F), half-up, in exact rational arithmetic."""
    x = Fraction(n_target) * (1 << (G_BITS + f_bits)) + Fraction(1, 2)
    return x.numerator // x.denominator

def assert_float_exact(fcw: int, f_bits: int, n: int) -> float:
    """Return n_div = FCW / 2^(8+F) after proving the golden model's float64
    digital path is exact for k = 0..n (inclusive)."""
    scale = 1 << (G_BITS + f_bits)
    n_div = fcw / scale
    assert Fraction(n_div) == Fraction(fcw, scale), "n_div is not exact"
    for k in range(n + 1):
        # s_ideal[k] = k * N  (float multiplication) must be exact
        assert Fraction(float(k) * n_div) == Fraction(k * fcw, scale), (
            f"k*N not exact in float64 at k={k}")
        # u + 0.5 (nearest) and u + e (ef1, e < 1) need <= 53 significant bits
        assert (k * fcw + (1 << f_bits)).bit_length() <= 53, (
            f"quantizer input exceeds 53 bits at k={k}")
    return n_div`;

/* --------------------------------------------------------------- figures */

function BlockDiagramSvg() {
  const box = { fill: 'var(--bg-panel)', stroke: 'var(--border-strong)', strokeWidth: 1, rx: 4 } as const;
  const accentBox = { ...box, fill: 'var(--accent-soft)', stroke: 'var(--accent)' };
  const regBox = { ...box, fill: 'var(--bg-alt)', strokeWidth: 1.8 };
  const dashedBox = { ...box, fill: 'var(--bg-alt)', strokeDasharray: '5 3' };
  const label = { fill: 'var(--fg)', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit' } as const;
  const sub = { fill: 'var(--fg-subtle)', fontSize: 9.5, fontFamily: 'var(--font-mono)' } as const;
  const note = { fill: 'var(--fg-subtle)', fontSize: 9.5, fontFamily: 'inherit' } as const;
  const wire = {
    stroke: 'var(--fg-faint)',
    strokeWidth: 1.2,
    fill: 'none',
    markerEnd: 'url(#ch24-arr)',
  } as const;
  const wlab = { fill: 'var(--fg-subtle)', fontSize: 9, fontFamily: 'var(--font-mono)' } as const;
  const inLab = { fill: 'var(--accent)', fontSize: 10.5, fontWeight: 600, fontFamily: 'var(--font-mono)' } as const;
  return (
    <svg
      viewBox="0 0 910 404"
      style={{ width: '100%', maxWidth: 940, display: 'block' }}
      role="img"
      aria-label="frac_phase_scheduler block diagram: accumulator, quantizer, decode, modular reverse, LAT pipeline, field split"
    >
      <defs>
        <marker id="ch24-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--fg-faint)" />
        </marker>
      </defs>

      {/* inputs */}
      <text x={68} y={30} {...inLab}>fcw [IW+8+F]</text>
      <line x1={115} y1={36} x2={115} y2={70} {...wire} />
      <text x={296} y={30} {...inLab}>q_mode</text>
      <line x1={320} y1={36} x2={320} y2={70} {...wire} />
      <text x={768} y={30} {...inLab}>r_zero</text>
      <line x1={790} y1={36} x2={790} y2={70} {...wire} />
      <text x={410} y={22} {...note}>所有 flop:posedge clk;en = 1 才前進一個 reference cycle</text>
      <text x={410} y={36} {...note}>rst:同步、active high(載入 index LAT 的 closed-form state)</text>

      {/* row 1: datapath */}
      <rect x={40} y={70} width={150} height={60} {...regBox} />
      <text x={50} y={88} {...label}>phase accumulator</text>
      <text x={50} y={104} {...sub}>acc_q = ACC[j+1]</text>
      <text x={50} y={119} {...sub}>acc_q + fcw mod 2^W</text>

      <rect x={235} y={70} width={170} height={60} {...accentBox} />
      <text x={245} y={88} {...label}>fps_quantizer u_q_run</text>
      <text x={245} y={104} {...sub}>v = acc_q + off(q_mode)</text>
      <text x={245} y={119} {...sub}>a_nxt = v[W-1:F]</text>

      <rect x={450} y={70} width={190} height={60} {...accentBox} />
      <text x={460} y={88} {...label}>fps_decode(§4)</text>
      <text x={460} y={104} {...sub}>n_int = I(a_nxt) - I(a_cur)</text>
      <text x={460} y={119} {...sub}>r_fb  = a_cur[7:0]</text>

      <rect x={690} y={70} width={200} height={60} {...accentBox} />
      <text x={700} y={88} {...label}>modular reverse(§7 Mode D)</text>
      <text x={700} y={104} {...sub}>r_inj = (r_zero - r_fb)</text>
      <text x={756} y={119} {...sub}>mod 256(8-bit wrap)</text>

      <line x1={190} y1={100} x2={235} y2={100} {...wire} />
      <line x1={405} y1={92} x2={450} y2={92} {...wire} />
      <text x={409} y={86} {...wlab}>a_nxt</text>
      <line x1={640} y1={92} x2={690} y2={92} {...wire} />
      <text x={646} y={86} {...wlab}>r_fb</text>

      {/* row 2: state registers */}
      <rect x={250} y={170} width={140} height={40} {...regBox} />
      <text x={260} y={187} {...label}>ef_q [F]</text>
      <text x={260} y={202} {...sub}>= e[j](ef1 residual)</text>
      <line x1={300} y1={130} x2={300} y2={170} {...wire} />
      <text x={262} y={152} {...wlab}>ef_nxt</text>
      <line x1={350} y1={170} x2={350} y2={130} {...wire} />
      <text x={355} y={152} {...wlab}>e_in</text>

      <rect x={470} y={170} width={150} height={40} {...regBox} />
      <text x={480} y={187} {...label}>a_cur_q [IW+8]</text>
      <text x={480} y={202} {...sub}>= A_FB[j]</text>
      <path d="M 405 118 L 428 118 L 428 196 L 470 196" {...wire} />
      <text x={432} y={160} {...wlab}>a_nxt</text>
      <line x1={545} y1={170} x2={545} y2={130} {...wire} />
      <text x={550} y={152} {...wlab}>a_cur</text>

      {/* row 3: reset pre-advance */}
      <rect x={40} y={250} width={600} height={84} {...dashedBox} />
      <text x={50} y={268} {...label}>reset pre-advance(rst = 1 → state index j = LAT,§13 look-ahead)</text>
      <text x={50} y={285} {...sub}>acc_rst = (LAT+1)·FCW</text>
      <text x={330} y={285} {...sub}>seq_q = LAT</text>
      <text x={50} y={300} {...sub}>a_cur_rst = Q(LAT·FCW, e[LAT-1])</text>
      <text x={330} y={300} {...sub}>via u_q_rst(第二個 quantizer instance)</text>
      <text x={50} y={315} {...sub}>ef_rst = e[LAT] = FCW·LAT(LAT+1)/2 mod 2^F</text>
      <text x={50} y={329} {...note}>constant-coefficient 乘法;LAT = 0 時全部 fold 成常數</text>
      <line x1={115} y1={250} x2={115} y2={130} {...wire} />
      <line x1={275} y1={250} x2={275} y2={210} {...wire} />
      <line x1={500} y1={250} x2={500} y2={210} {...wire} />
      <text x={120} y={232} {...wlab}>rst</text>
      <text x={280} y={238} {...wlab}>rst</text>
      <text x={505} y={238} {...wlab}>rst</text>

      {/* LAT pipeline + field split */}
      <rect x={690} y={180} width={200} height={60} {...regBox} />
      <text x={700} y={198} {...label}>LAT pipeline(g_lat)</text>
      <text x={700} y={214} {...sub}>cmd = {'{'}1,n_int,r_fb,r_inj,seq{'}'}</text>
      <text x={700} y={229} {...sub}>LAT × 37 flops;reset → valid=0</text>
      <line x1={790} y1={130} x2={790} y2={180} {...wire} />
      <text x={796} y={158} {...wlab}>r_fb, r_inj</text>
      <path d="M 640 120 L 665 120 L 665 210 L 690 210" {...wire} />
      <text x={669} y={158} {...wlab}>n_int, seq</text>

      <rect x={690} y={280} width={200} height={80} {...box} />
      <text x={700} y={298} {...label}>field split(純 wiring)</text>
      <text x={700} y={314} {...sub}>m_fb = r_fb[7:6]</text>
      <text x={700} y={327} {...sub}>c_fb = r_fb[5:0]</text>
      <text x={700} y={340} {...sub}>j_inj = r_inj[7:5](§8 naive)</text>
      <text x={700} y={353} {...sub}>c_inj = {'{'}0, r_inj[4:0]{'}'}</text>
      <line x1={790} y1={240} x2={790} y2={280} {...wire} />
      <text x={796} y={264} {...wlab}>cmd(k), k = j − LAT</text>
      <text x={690} y={380} {...sub}>→ valid · n_int · m_fb · c_fb · r_fb</text>
      <text x={690} y={394} {...sub}>  r_inj · j_inj · c_inj · seq_id</text>
    </svg>
  );
}

function AccWordSvg() {
  const lab = { fill: 'var(--fg)', fontSize: 11, fontWeight: 600, fontFamily: 'inherit' } as const;
  const mono = { fill: 'var(--fg-subtle)', fontSize: 9.5, fontFamily: 'var(--font-mono)' } as const;
  const note = { fill: 'var(--fg-subtle)', fontSize: 9.5, fontFamily: 'inherit' } as const;
  const seg = { stroke: 'var(--border-strong)', strokeWidth: 1 } as const;
  return (
    <svg
      viewBox="0 0 760 124"
      style={{ width: '100%', maxWidth: 820, display: 'block' }}
      role="img"
      aria-label="accumulator word format UQ(IW+8).F"
    >
      <text x={22} y={20} {...mono}>[W-1 : 8+F]</text>
      <text x={142} y={20} {...mono}>[8+F-1 : F]</text>
      <text x={352} y={20} {...mono}>[F-1 : 0]</text>
      <rect x={20} y={28} width={120} height={34} fill="var(--accent-soft)" {...seg} />
      <rect x={140} y={28} width={210} height={34} fill="var(--bg-panel)" {...seg} />
      <rect x={350} y={28} width={390} height={34} fill="var(--bg-alt)" {...seg} />
      <text x={30} y={50} {...lab}>IW bits</text>
      <text x={150} y={50} {...lab}>8 bits:fine code</text>
      <text x={360} y={50} {...lab}>F bits:sub-LSB fraction</text>
      <text x={22} y={82} {...note}>整數 VCO cycles</text>
      <text x={22} y={97} {...note}>(mod 2^IW)→ I</text>
      <text x={142} y={82} {...note}>1 LSB = T_vco / 256</text>
      <text x={142} y={97} {...mono}>R_FB = A[7:0]</text>
      <text x={142} y={112} {...mono}>m = R[7:6], c = R[5:0]</text>
      <text x={352} y={82} {...note}>被 quantizer 丟掉(nearest 先加 2^(F−1));</text>
      <text x={352} y={97} {...note}>ef1 residual e 恰好就是這 F bits;</text>
      <text x={352} y={112} {...note}>頻率解析度 Δf = f_ref / 2^(8+F)</text>
    </svg>
  );
}

/* --------------------------------------------------------------- chapter */

const N_PRESETS: { label: string; n: number }[] = [
  { label: '3.13', n: 3.13 },
  { label: '3.125', n: 3.125 },
  { label: '3.1375', n: 3.1375 },
  { label: '3.2', n: 3.2 },
  { label: '3.126953125', n: 3.126953125 },
  { label: '3.001', n: 3.001 },
  { label: '3.25', n: 3.25 },
];

const thStyle = { textAlign: 'left' as const, whiteSpace: 'nowrap' as const };
const monoStyle = { fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' as const };
const labelTd = { textAlign: 'left' as const };

/** log-axis tick label (DISPLAY): plain digits in 1e-3..1e4, exponent outside */
function logTick(v: number): string {
  const a = Math.abs(v);
  return a !== 0 && (a >= 1e4 || a < 1e-3) ? v.toExponential(0) : trimNumber(v, 3);
}

export default function Chapter24() {
  const [nDiv, setNDiv] = useChapterNDiv();
  const [calcF, setCalcF] = useState<number>(24);
  const [calcIW, setCalcIW] = useState<number>(IW_DEFAULT);
  const [calcFrefGHz, setCalcFrefGHz] = useState<number>(4);
  const [quant, setQuant] = useState<Q3>('nearest');
  const [win, setWin] = useState<WindowOpt>('2048');
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  /* ---- figure 1: FCW calculator ---- */
  const calcDec = useMemo(() => decimalOf(nDiv), [nDiv]);
  const calc = useMemo(() => fcwInfo(calcDec, calcF, calcIW), [calcDec, calcF, calcIW]);
  const calcFrefHz = calcFrefGHz * 1e9;

  const sweepOption = useMemo(() => {
    const errPts: [number, number][] = [];
    const resPts: [number, number][] = [];
    const halfPts: [number, number][] = [];
    for (let F = 1; F <= 40; F++) {
      const inf = fcwInfo(calcDec, F, IW_DEFAULT);
      const df = Math.abs(inf.dN * calcFrefHz);
      if (df > 0) errPts.push([F, df]);
      resPts.push([F, calcFrefHz / 2 ** (G_BITS + F)]);
      halfPts.push([F, calcFrefHz / 2 ** (G_BITS + 1 + F)]);
    }
    const opt = makeLineOption({
      xLabel: 'F (fractional sub-LSB bits)',
      series: [
        { name: '|Δf_vco| = |N_real − N|·f_ref', data: errPts, showSymbol: true, symbolSize: 5 },
        { name: '解析度 f_ref/2^(8+F)', data: resPts, dashed: true },
        { name: '上界 f_ref/2^(9+F)', data: halfPts, dashed: true, width: 1 },
      ],
      zoom: false,
      xMin: 1,
      xMax: 40,
      extra: {
        yAxis: {
          ...baseAxis(ct, '|Δf| (Hz)', logTick),
          type: 'log',
          nameLocation: 'middle',
          nameGap: 48,
        },
        grid: { left: 70, right: 24, top: 40, bottom: 44 },
      },
    }) as unknown as { series: Record<string, unknown>[] };
    opt.series[1] = { ...opt.series[1], markLine: makeMarkLine([{ x: calcF, label: `F = ${calcF}` }]) };
    return opt as unknown as EChartsOption;
  }, [calcDec, calcFrefHz, calcF, ct]);

  /* ---- figure 2: requested vs realized explorer ---- */
  const winN = Number(win);
  const explorer = useMemo(() => runExplorer(nDiv, winN), [nDiv, winN]);

  useEffect(() => {
    setStatus('done', `RTL fixed-point explorer:15 runs × ${winN} cycles @ N=${nDiv}`);
  }, [explorer, nDiv, winN, setStatus]);

  const rasterOption = useMemo(() => {
    const cats = explorer.map((r) => `F=${r.info.F}`);
    return makeLineOption({
      xLabel: 'k (reference cycle)',
      series: explorer.map((r, i) => ({
        name: `F=${r.info.F}`,
        type: 'scatter' as const,
        data: r.cells[quant].ks.map((k): [number, number] => [k, i]),
        showSymbol: true,
        symbolSize: 4,
      })),
      legend: false,
      xMin: 0,
      xMax: winN - 1,
      extra: {
        yAxis: {
          ...baseAxis(ct, 'F'),
          type: 'category',
          data: cats,
          nameLocation: 'middle',
          nameGap: 46,
        },
      },
    });
  }, [explorer, quant, winN, ct]);

  /* ---- figure 3: verified cases ---- */
  const cases = useMemo(() => buildCases(), []);
  const caseTotals = useMemo(() => {
    let cycles = 0;
    let values = 0;
    let manifestOk = 0;
    for (const c of cases) {
      cycles += c.cycles;
      values += c.values;
      if (c.manifest === '一致') manifestOk += 1;
    }
    return { cycles, values, manifestOk };
  }, [cases]);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      {/* 1 ------------------------------------------------------------ */}
      <SectionQuestion>
        <ul>
          <li>
            Python golden model 是 float64 行為模型;交給數位設計流程時,需要一份「同一套數學、
            但用整數加法與 bit slicing 寫成」的 synthesizable reference — 它在 repo 裡長什麼樣子?
            (<code>rtl/frac_phase_scheduler.sv</code> + <code>fps_quantizer.sv</code> +{' '}
            <code>fps_decode.sv</code>)
          </li>
          <li>
            十進位的 <M>{'N'}</M>(如 3.13)如何變成整數 frequency control word{' '}
            <M>{'\\mathrm{FCW} = \\operatorname{round}(N\\cdot 256\\cdot 2^F)'}</M>?realized{' '}
            <M>{'N'}</M>、頻率誤差與解析度 <M>{'f_{ref}/2^{8+F}'}</M> 各是多少?
          </li>
          <li>
            nearest / floor / ef1 在 fixed point 中只是「加一個 offset、丟掉低 F bits」— 為什麼這與
            MODEL_SPEC §6 的定義<strong>逐位相同</strong>?
          </li>
          <li>
            LAT 級輸出 pipeline 下,reset 時 accumulator 與 ef1 residual 要 pre-advance 成什麼
            closed form,才符合 §13 的 correct look-ahead?
          </li>
          <li>
            「bit-exact」怎麼證明:哪些 case、跑了多少 cycle、比了多少個輸出值?合成後有多大?
          </li>
          <li>這份 RTL 刻意<strong>不</strong>做什麼(CDC、DFT、timing closure、MASH、calibrated mapping)?</li>
        </ul>
      </SectionQuestion>

      {/* 2 ------------------------------------------------------------ */}
      <SectionIntuition>
        <p>
          golden model 的數位路徑其實是整數運算的偽裝。若 <M>{'N'}</M> 是分母為 2 的冪的有理數
          (dyadic),<M>{'A_{ideal}[k] = 256\\,k\\,N'}</M> 就能精確寫成整數{' '}
          <M>{'k\\cdot\\mathrm{FCW}'}</M> 再除以 <M>{'2^F'}</M>:相位累加 = 一個 W-bit 加法器;
          quantizer = 加 offset 後丟掉低 F bits;feedback decode = 取 bit 欄位;Mode D 的 modular
          reverse = 8-bit 減法的自然 wrap;look-ahead = 核心跑在輸出前面 LAT 拍,命令經 LAT 級
          flop 延遲後剛好在該用的那一拍出現。RTL 就是把這條鏈逐級翻成硬體
          <EpistemicTag kind="EXACT" />。
        </p>
        <BlockDiagramSvg />
        <p>
          圖中有<strong>兩個</strong> quantizer instance:<code>u_q_run</code> 每拍組合地算出下一個
          index 的 quantized code <M>{'A_{FB}[j+1]'}</M>(<code>a_nxt</code>),因為{' '}
          <M>{'n_{int}[j] = I_{FB}[j+1] - I_{FB}[j]'}</M> 同時需要 j 與 j+1;<code>u_q_rst</code>{' '}
          只在 reset 時用,算出 pre-advance 的 <M>{'A_{FB}[LAT]'}</M>。state register 只有四個:
          <code>acc_q</code>(36 bits)、<code>ef_q</code>(24)、<code>a_cur_q</code>(12)、
          <code>seq_q</code>(16)— 合計 88 flops,正是 LAT = 0 的合成結果
          <EpistemicTag kind="EXACT" />。injection decode(<M>{'j = R_{INJ}[7:5]'}</M>、
          <M>{'c = R_{INJ}[4:0]'}</M>)在 RTL 中是 pipeline <strong>之後</strong>的純 wiring;
          bit slicing 與延遲可交換,所以位置不改變任何數值。
        </p>
        <Callout type="note" title="誰是契約">
          <p>
            數學契約仍是 <code>MODEL_SPEC.md</code>;RTL_USAGE.md 明寫:RTL 與 golden model
            的任何數值不一致都算 RTL 的 bug。RTL 是 golden model 的「fixed-point 實作證明」,
            不是另一份規格。
          </p>
        </Callout>
      </SectionIntuition>

      {/* 3 ------------------------------------------------------------ */}
      <SectionMath>
        <h3>3.1 Fixed-point 格式 <EpistemicTag kind="EXACT" /></h3>
        <p>
          accumulator 保存 absolute fine code <M>{'A_{ideal}[k] = 256\\,k\\,N'}</M>(MODEL_SPEC §4),
          格式 UQ(IW+8).F,寬度 <M>{'W = IW + 8 + F'}</M>(預設 IW = 4、F = 24 → W = 36):
        </p>
        <AccWordSvg />
        <MathBlock>{'\\mathrm{ACC}[k] = k\\cdot\\mathrm{FCW} \\bmod 2^{W},\\qquad u[k] = \\mathrm{ACC}[k]/2^{F}\\ \\text{(LSB units)}'}</MathBlock>

        <h3>3.2 FCW、realized N 與頻率解析度 <EpistemicTag kind="EXACT" /></h3>
        <MathBlock>{'\\mathrm{FCW} = \\operatorname{round}\\!\\left(N\\cdot 256\\cdot 2^{F}\\right) = \\left\\lfloor N\\,2^{8+F} + \\tfrac12 \\right\\rfloor \\quad\\text{(half up, exact rational)}'}</MathBlock>
        <MathBlock>{'N_{real} = \\frac{\\mathrm{FCW}}{2^{8+F}},\\qquad |N_{real} - N| \\le 2^{-(9+F)},\\qquad \\Delta f_{vco} = (N_{real} - N)\\,f_{ref}'}</MathBlock>
        <MathBlock>{'\\Delta N_{LSB} = 2^{-(8+F)} \\;\\Rightarrow\\; \\Delta f_{res} = \\frac{f_{ref}}{2^{8+F}},\\qquad |\\Delta f_{vco}| \\le \\frac{\\Delta f_{res}}{2}'}</MathBlock>
        <p>
          FCW 由十進位字串以 exact rational 取 half-up(<code>rtl/gen_vectors.py::fcw_of</code>),
          不經 float64。<M>{'f_{ref}'}</M> = 4 GHz 時的解析度:
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={thStyle}>F</th>
                {[8, 12, 16, 24, 32].map((F) => (
                  <th key={F} style={thStyle}>
                    {F}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <M>{'f_{ref}/2^{8+F}'}</M>
                </td>
                {[8, 12, 16, 24, 32].map((F) => (
                  <td key={F} style={monoStyle}>
                    {fmtHz(F_REF_HZ / 2 ** (G_BITS + F))}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          RTL_USAGE.md 的 worked example:N = 3.13、F = 24 →{' '}
          <M>{'N\\cdot 2^{32}'}</M> = 13 443 247 636.48 → FCW = 13 443 247 636 = 0x3_2147_AE14(34
          bits;IW = 4 → W = 36);<M>{'N_{real}'}</M> = 3.1299999998882413;
          <M>{'\\Delta f_{vco}'}</M> = −0.447035 Hz(−0.0357 ppb);F = 16 時 −19.1 Hz
          <EpistemicTag kind="EXACT" />。
        </p>

        <h3>3.3 三種 quantizer 的整數形式 = MODEL_SPEC §6 <EpistemicTag kind="EXACT" /></h3>
        <p>
          令 <M>{'\\mathrm{ACC}\\in\\mathbb{Z}_{\\ge 0}'}</M>、<M>{'u = \\mathrm{ACC}/2^F'}</M>。對整數
          ACC 與 <M>{'F \\ge 1'}</M>,下列是恆等式(不是近似):
        </p>
        <MathBlock>{'\\text{nearest:}\\quad \\left\\lfloor u + \\tfrac12 \\right\\rfloor = \\left\\lfloor \\frac{\\mathrm{ACC} + 2^{F-1}}{2^F} \\right\\rfloor = (\\mathrm{ACC} + 2^{F-1}) \\gg F'}</MathBlock>
        <MathBlock>{'\\text{floor:}\\quad \\lfloor u \\rfloor = \\mathrm{ACC} \\gg F'}</MathBlock>
        <MathBlock>{'\\text{ef1:}\\quad e = \\varepsilon/2^F,\\ \\varepsilon\\in[0,2^F):\\quad v = u + e = \\frac{\\mathrm{ACC}+\\varepsilon}{2^F},\\quad y = (\\mathrm{ACC}+\\varepsilon) \\gg F,\\quad e\' = \\frac{(\\mathrm{ACC}+\\varepsilon) \\bmod 2^F}{2^F} \\in [0,1)'}</MathBlock>
        <p>
          nearest 的 tie(<M>{'\\mathrm{ACC} \\bmod 2^F = 2^{F-1}'}</M>)一律進位 — 這就是 §6 的{' '}
          <M>{'\\lfloor u + 0.5 \\rfloor'}</M> half-up,永遠不是 banker&apos;s rounding。ef1 的
          residual 正好是被丟掉的 F bits,所以 <code>ef_q</code> 只需 F bits。
        </p>
        <p>
          <strong>mod 2^W 不影響 decode。</strong>因為 <M>{'2^W = 2^{IW+8}\\cdot 2^F'}</M>:
        </p>
        <MathBlock>{'\\big(((\\mathrm{ACC} \\bmod 2^W) + \\mathrm{off}) \\bmod 2^W\\big) \\gg F \\;=\\; \\big((\\mathrm{ACC} + \\mathrm{off}) \\gg F\\big) \\bmod 2^{IW+8}'}</MathBlock>
        <p>
          decode 只用 <M>{'A_{FB} \\bmod 2^{IW+8}'}</M>:<M>{'R_{FB} = A[7:0]'}</M> 與{' '}
          <M>{'n_{int} = (I[j+1] - I[j]) \\bmod 2^{IW}'}</M>;後者在{' '}
          <M>{'0 \\le n_{int} < 2^{IW}'}</M> 時等於真值,故需 <M>{'N + 1 < 2^{IW}'}</M>(IW = 4 →
          N &lt; 15)。<M>{'R_{INJ} = (R_{zero} - R_{FB}) \\bmod 256'}</M> 由 8-bit 減法直接得到,Mode D
          identity <M>{'(R_{FB} + R_{INJ}) \\bmod 256 = R_{zero}'}</M> 在 RTL 中字面成立。
        </p>

        <h3>3.4 golden model 為何能逐位對上:dyadic N 與 53-bit 條件 <EpistemicTag kind="EXACT" /></h3>
        <p>
          golden vectors 以 <M>{'n_{div} = N_{real}'}</M>(exact dyadic)執行,而不是十進位 N。此時
          float64 路徑上的 <M>{'k\\cdot N'}</M>、<M>{'256\\,s'}</M>、<M>{'u + 0.5'}</M>、ef1 的{' '}
          <M>{'u + e'}</M> 全部 exact,只要
        </p>
        <MathBlock>{'k\\cdot\\mathrm{FCW} + 2^{F} < 2^{53} \\;\\Longleftrightarrow\\; k \\le k_{max} = \\left\\lfloor \\frac{2^{53} - 1 - 2^{F}}{\\mathrm{FCW}} \\right\\rfloor'}</MathBlock>
        <p>
          N = 3.13、F = 24:<M>{'k_{max}'}</M> = 670 016;N = 3.001、F = 32:<M>{'k_{max}'}</M> = 2 729
          — 2048 + 1 拍的 F = 32 vectors 仍在範圍內(<code>assert_float_exact</code> 逐 k 檢查)
          <EpistemicTag kind="EXACT" />。golden rows 另外與獨立的純整數 reference{' '}
          <code>int_reference</code> 逐列比對後才寫檔。
        </p>

        <h3>3.5 Look-ahead pre-advance 的 closed form <EpistemicTag kind="EXACT" /></h3>
        <p>
          核心 state 的 index 是 <M>{'j = k + LAT'}</M>:<code>acc_q</code> ={' '}
          <M>{'\\mathrm{ACC}[j+1]'}</M>、<code>a_cur_q</code> = <M>{'A_{FB}[j]'}</M>、
          <code>ef_q</code> = <M>{'e[j]'}</M>、<code>seq_q</code> = j。reset 直接載入 j = LAT 的值:
        </p>
        <MathBlock>{'\\texttt{acc\\_q} = (LAT+1)\\,\\mathrm{FCW},\\quad \\texttt{a\\_cur\\_q} = Q\\big(LAT\\cdot\\mathrm{FCW},\\ e[LAT-1]\\big),\\quad \\texttt{ef\\_q} = e[LAT],\\quad \\texttt{seq\\_q} = LAT'}</MathBlock>
        <p>
          ef1 的 residual 有 closed form:由 <M>{'v_k = u_k + e_{k-1}'}</M>、
          <M>{'e_k = v_k - \\lfloor v_k \\rfloor'}</M> 歸納得 <M>{'e_k \\equiv \\sum_{i\\le k} u_i \\pmod 1'}</M>,
          而 <M>{'e_k\\in[0,1)'}</M>,所以
        </p>
        <MathBlock>{'e[k] = \\operatorname{frac}\\Big(\\sum_{i=0}^{k} \\frac{i\\,\\mathrm{FCW}}{2^F}\\Big) \\;\\Rightarrow\\; 2^F e[k] = \\mathrm{FCW}\\cdot\\frac{k(k+1)}{2} \\bmod 2^F'}</MathBlock>
        <p>
          RTL 用 <code>K_EF * fcw[F-1:0]</code>(TRI_PREV = LAT(LAT−1)/2)得到{' '}
          <M>{'e[LAT-1]'}</M>,送進 <code>u_q_rst</code> 後,其 <code>e_out</code> 正好是{' '}
          <M>{'e[LAT]'}</M>(只有低 F bits 參與,mod 2^F 下乘數取低位不改變結果)。命令{' '}
          <M>{'\\mathrm{cmd}(j)'}</M> 經 LAT 級 flop(reset 為 0 → valid = 0)後在 reference cycle{' '}
          <M>{'k = j - LAT + LAT = j'}</M> 出現:對 <M>{'k \\ge LAT'}</M> 輸出等於 golden model 在
          state k 的命令(<code>seq_id = k</code>),等同 <code>lookahead = True</code> 的{' '}
          <code>k_applied = k</code>。
        </p>

        <h3>3.6 驗證規模 <EpistemicTag kind="EXACT" /></h3>
        <MathBlock>{'\\text{cycles} = \\sum_{\\text{cases}} 2\\,(2048 - LAT) = 204\\,634,\\qquad \\text{values} = 8 \\times 204\\,634 = 1\\,637\\,072'}</MathBlock>
        <p>
          (45 個主矩陣 case 各 LAT ∈ {'{'}0, 1, 3{'}'} 15 個:15 × (4096 + 4094 + 4090) = 184 200;
          LAT = 8 兩個 2 × 4080;F = 16 的 LAT 1 / LAT 3 各 4094 / 4090;F = 32 的 LAT 3 為 4090。)
        </p>
      </SectionMath>

      {/* 4 ------------------------------------------------------------ */}
      <SectionExample>
        <p>
          三題都以 RTL 的整數語意計算(BigInt,不經 float64),並各自呼叫 model 交叉檢查。預設值重現
          RTL_USAGE.md 的 N = 3.13、F = 24 worked example。
        </p>
        <ExampleProblem
          index={1}
          tag="EXACT"
          title="FCW 計算:由 N、F 得到整數 frequency control word"
          prompt={
            <>
              給定 <M>{'N'}</M>、sub-LSB 位元數 <M>{'F'}</M> 與整數位寬 <M>{'IW'}</M>,依{' '}
              <code>fcw_of</code> 以 exact rational 求{' '}
              <M>{'\\mathrm{FCW} = \\lfloor N\\,2^{8+F} + \\tfrac12 \\rfloor'}</M>,寫成 hex 與{' '}
              <M>{'W = IW+8+F'}</M> bit 的 SystemVerilog literal,並求{' '}
              <M>{'N_{real} = \\mathrm{FCW}/2^{8+F}'}</M>。
            </>
          }
          inputs={EX1_INPUTS}
          compute={computeEx1}
        />
        <ExampleProblem
          index={2}
          tag="EXACT"
          title="頻率解析度與 realized 頻率誤差"
          prompt={
            <>
              給定 <M>{'f_{ref}'}</M>、<M>{'N'}</M>、<M>{'F'}</M>:求解析度{' '}
              <M>{'\\Delta f_{res} = f_{ref}/2^{8+F}'}</M>、realized 頻率誤差{' '}
              <M>{'\\Delta f_{vco} = (N_{real} - N) f_{ref}'}</M> 與相對誤差(ppb),並驗證{' '}
              <M>{'|\\Delta f_{vco}| \\le \\Delta f_{res}/2'}</M>。
            </>
          }
          inputs={EX2_INPUTS}
          compute={computeEx2}
        />
        <ExampleProblem
          index={3}
          tag="EXACT"
          title="Look-ahead pre-advance:reset 載入的 closed-form state"
          prompt={
            <>
              <M>{'N = 3 + \\alpha'}</M>、LAT 級 pipeline、<M>{'F'}</M>、q_mode,IW = 4。依{' '}
              <code>frac_phase_scheduler.sv</code> 的 reset 路徑求 <code>acc_q</code>、
              <code>a_cur_q</code>、<code>ef_q</code>、<code>seq_q</code>,並以 golden model 在{' '}
              <M>{'N_{real}'}</M> 下的 <M>{'A_{FB}[LAT]'}</M> 交叉檢查。預設(α = 0.13、LAT = 3、ef1)
              應得 acc_q = 0xC_851E_B850、a_cur_q = 2404、ef_q = 11 408 504(≈ 0.68 LSB)。
            </>
          }
          inputs={EX3_INPUTS}
          compute={computeEx3}
        />
      </SectionExample>

      {/* 5 ------------------------------------------------------------ */}
      <SectionFigure
        title="圖 1 · FCW 計算器:N、F → FCW(BigInt)、realized N、頻率誤差"
        caption={
          <>
            N 與 TopBar / 參數面板同步(範圍 3–3.25)。FCW 以十進位字串的 exact rational 計算(等同{' '}
            <code>gen_vectors.py::fcw_of</code>),hex 依 SystemVerilog 習慣每 4 位加底線。圖:F = 1…40
            的 |Δf_vco|(實心點;Δf = 0 的 F 不畫,表示 N 在該 F 下 exact)與解析度、半解析度上界(虛線),
            log-y。<EpistemicTag kind="EXACT" />
          </>
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', marginBottom: 8 }}>
          <NumberInput label="N" value={nDiv} min={3} max={3.25} step={0.0001} onChange={setNDiv} />
          <NumberInput
            label="F"
            value={calcF}
            min={1}
            max={40}
            step={1}
            unit="bits"
            onChange={(v) => setCalcF(Math.round(v))}
          />
          <NumberInput
            label="IW"
            value={calcIW}
            min={3}
            max={8}
            step={1}
            unit="bits"
            onChange={(v) => setCalcIW(Math.round(v))}
          />
          <NumberInput
            label="f_ref"
            value={calcFrefGHz}
            min={0.1}
            max={20}
            step={0.1}
            unit="GHz"
            onChange={setCalcFrefGHz}
          />
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <tbody>
              <tr>
                <td style={labelTd}>N(exact decimal)</td>
                <td style={monoStyle}>{calc.dec.text}</td>
              </tr>
              <tr>
                <td style={labelTd}>
                  <M>{'N\\cdot 2^{8+F}'}</M>
                </td>
                <td style={monoStyle}>{calc.scaledExact}</td>
              </tr>
              <tr>
                <td style={labelTd}>FCW(decimal)</td>
                <td style={monoStyle}>{calc.fcw.toString()}</td>
              </tr>
              <tr>
                <td style={labelTd}>FCW(hex / SV literal)</td>
                <td style={monoStyle}>
                  {hexOf(calc.fcw)} · {calc.W}&apos;h{hexGroups(calc.fcw)}({calc.bits} 有效 bits;port W ={' '}
                  {calc.W})
                </td>
              </tr>
              <tr>
                <td style={labelTd}>
                  <M>{'N_{real}'}</M>(float64 / exact)
                </td>
                <td style={monoStyle}>
                  {String(calc.nReal)}
                  <br />
                  {calc.nRealExact}
                </td>
              </tr>
              <tr>
                <td style={labelTd}>
                  <M>{'\\Delta N = N_{real} - N'}</M>
                </td>
                <td style={monoStyle}>{signed(fmt(calc.dN, 6))}</td>
              </tr>
              <tr>
                <td style={labelTd}>
                  <M>{'\\Delta f_{vco}'}</M> @ f_ref
                </td>
                <td style={monoStyle}>
                  {fmtHz(calc.dN * calcFrefHz, 6)}({signed(fmt((calc.dN / nDiv) * 1e6, 4))} ppm)
                </td>
              </tr>
              <tr>
                <td style={labelTd}>
                  解析度 <M>{'f_{ref}/2^{8+F}'}</M>
                </td>
                <td style={monoStyle}>{fmtHz(calcFrefHz / 2 ** (G_BITS + calcF), 6)}</td>
              </tr>
              <tr>
                <td style={labelTd}>
                  float64-exact 窗長 <M>{'k_{max}'}</M>
                </td>
                <td style={monoStyle}>{calc.kMax >= 0n ? groupDigits(calc.kMax.toString()) : '—'} cycles</td>
              </tr>
              <tr>
                <td style={labelTd}>
                  RTL 條件 <M>{'N + 1 < 2^{IW}'}</M>
                </td>
                <td style={monoStyle}>{calc.fitsPort ? '滿足' : '違反(n_int 會 wrap)'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <EChart option={sweepOption} height={300} />
      </SectionFigure>

      <SectionFigure
        title="圖 2 · fixed-point vs requested N:R_FB 第一次不同的 cycle"
        caption={
          <>
            對每個 quantizer,用 <code>simulate()</code> 分別跑 requested N(float64 的 N 本身)與
            realized dyadic <M>{'N_{real}'}</M>(F ∈ {'{'}8, 12, 16, 24{'}'}),逐拍比對 R_FB;表格列出第一個不同的
            k 與窗內不同的拍數(共 15 次模擬)。圖為所選 quantizer 的差異 raster(每個點 = 一個 R_FB
            不同的 cycle)。drift 欄是 <M>{'256\\,k\\,\\Delta N'}</M>(k = 窗尾,LSB),ef1 欄另列累積量{' '}
            <M>{'128\\,k(k+1)\\,\\Delta N'}</M>。注意 requested N 的 float64 軌跡本身也不是十進位 N 的
            exact 值;這是兩個 golden run 的比較。<EpistemicTag kind="EXPERIMENT" />
          </>
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={thStyle}>F</th>
                {Q_NAMES.map((q) => (
                  <th key={q} style={{ ...thStyle, fontWeight: q === quant ? 700 : undefined }}>
                    {q}:first k(# diff)
                  </th>
                ))}
                <th style={thStyle}>FCW</th>
                <th style={thStyle}>ΔN = N_real − N</th>
                <th style={thStyle}>Δf @ {fmtHz(F_REF_HZ, 3)}</th>
                <th style={thStyle}>drift 256kΔN</th>
                <th style={thStyle}>ef1 Σ-drift</th>
              </tr>
            </thead>
            <tbody>
              {explorer.map((r) => {
                const kEnd = winN - 1;
                return (
                  <tr key={r.info.F}>
                    <td style={monoStyle}>{r.info.F}</td>
                    {Q_NAMES.map((q) => {
                      const c = r.cells[q];
                      return (
                        <td key={q} style={{ ...monoStyle, fontWeight: q === quant ? 700 : undefined }}>
                          {c.first === null ? `none(< ${winN})` : `${c.first}(${c.count})`}
                        </td>
                      );
                    })}
                    <td style={monoStyle}>{hexOf(r.info.fcw)}</td>
                    <td style={monoStyle}>{signed(fmt(r.info.dN, 4))}</td>
                    <td style={monoStyle}>{fmtHz(r.info.dN * F_REF_HZ, 4)}</td>
                    <td style={monoStyle}>{signed(fmt(256 * kEnd * r.info.dN, 3))} LSB</td>
                    <td style={monoStyle}>{signed(fmt(128 * kEnd * (kEnd + 1) * r.info.dN, 3))} LSB</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ margin: '8px 0 4px' }}>
          {quant} · 窗長 {winN}:
          {explorer
            .map((r) =>
              r.cells[quant].first === null
                ? `F=${r.info.F} 窗內無差異`
                : `F=${r.info.F} 首差 k=${r.cells[quant].first}`,
            )
            .join(';')}
        </p>
        <EChart option={rasterOption} height={240} />
      </SectionFigure>

      <SectionFigure
        title="圖 3 · 已驗證的 50 個 bit-exact case 與合成統計(recorded)"
        caption={
          <>
            case 矩陣依 <code>rtl/gen_vectors.py::case_list</code> 重建,FCW 以本章 BigInt 計算並與
            committed <code>manifest.json</code> 的值核對(一致 {caseTotals.manifestOk} / {cases.length})。
            result 欄是記錄值:<code>python3 rtl/run_sim.py</code> 的 SUMMARY(RTL_USAGE.md §6),
            不是在瀏覽器裡重跑。cycles = 兩個 pass × (2048 − LAT);values = cycles × 8 個輸出。CSV 可匯出。
            <EpistemicTag kind="EXPERIMENT" />
          </>
        }
      >
        <p>
          <strong>
            {RECORDED.pass}/{RECORDED.cases} PASS
          </strong>
          ,重建矩陣合計 {groupDigits(String(caseTotals.cycles))} cycles、
          {groupDigits(String(caseTotals.values))} values
          {caseTotals.cycles === RECORDED.cycles && caseTotals.values === RECORDED.values
            ? '(與記錄的 204 634 / 1 637 072 一致)'
            : '(與記錄值不一致)'}
          ,0 mismatches。
        </p>
        <DebugTable columns={CASE_COLUMNS} rows={cases} maxHeight={340} exportName="ch24_rtl_cases.csv" />
        <h4 style={{ margin: '14px 0 6px' }}>
          合成統計(yosys 0.69 <code>synth -flatten</code>,generic gates,F = 24、IW = 4、SEQW = 16;無
          timing 資訊)
        </h4>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={thStyle}>LAT</th>
                <th style={thStyle}>cells total</th>
                <th style={thStyle}>flip-flops</th>
                <th style={thStyle}>combinational</th>
                <th style={thStyle}>latches</th>
                <th style={thStyle}>flop budget</th>
              </tr>
            </thead>
            <tbody>
              {SYNTH.map((s) => (
                <tr key={s.lat}>
                  <td style={monoStyle}>{s.lat}</td>
                  <td style={monoStyle}>{s.cells}</td>
                  <td style={monoStyle}>{s.ff}</td>
                  <td style={monoStyle}>{s.comb}</td>
                  <td style={monoStyle}>{s.latches}</td>
                  <td style={monoStyle}>
                    88 + 37 × {s.lat} = {88 + 37 * s.lat}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionFigure>

      {/* 6 ------------------------------------------------------------ */}
      <SectionCode language="systemverilog" title="rtl/fps_quantizer.sv — fixed-point §6 quantizer" code={CODE_QUANTIZER}>
        <p>
          三種 mode 共用一個加法器:只有 offset 不同(<code>HALF</code> / <code>e_in</code> / 0)。
        </p>
      </SectionCode>
      <SectionCode
        language="systemverilog"
        title="rtl/frac_phase_scheduler.sv — pre-advance、兩個 quantizer、state update"
        code={CODE_CORE}
      />
      <SectionCode
        language="systemverilog"
        title="rtl/fps_decode.sv + frac_phase_scheduler.sv — decode、LAT pipeline、field split"
        code={CODE_DECODE}
      />
      <SectionCode language="python" title="rtl/gen_vectors.py — FCW 與 float64-exact 保證" code={CODE_GEN} />

      {/* 7 ------------------------------------------------------------ */}
      <SectionLineByLine
        items={[
          {
            code: "localparam logic [CW+F-1:0] HALF = {{(CW+F-1){1'b0}}, 1'b1} << (F - 1);",
            explain: (
              <>
                0.5 LSB 在 UQ(CW).F 中就是 <M>{'2^{F-1}'}</M>。nearest = 加 HALF 再取高位 ={' '}
                <M>{'\\lfloor u + 0.5 \\rfloor'}</M>,tie 一律進位(half-up)<EpistemicTag kind="EXACT" />。
              </>
            ),
          },
          {
            code: "Q_EF1:     off = {{CW{1'b0}}, e_in};",
            explain: (
              <>
                ef1 把上一拍的 residual(UQ0.F)零延伸後加進來:<M>{'v = u + e'}</M>。
              </>
            ),
          },
          {
            code: 'assign y     = v[CW+F-1:F];\nassign e_out = (q_mode == Q_EF1) ? v[F-1:0] : \'0;',
            explain: (
              <>
                丟掉低 F bits 就是 floor;被丟掉的 F bits 恰為 <M>{'e = v - \\lfloor v \\rfloor \\in [0,1)'}</M>,
                不需要任何減法器。非 ef1 時 residual 強制為 0。
              </>
            ),
          },
          {
            code: 'localparam int TRI_PREV = (LAT * (LAT - 1)) / 2;',
            explain: (
              <>
                <M>{'\\sum_{i=0}^{LAT-1} i'}</M>:<M>{'e[LAT-1] = \\operatorname{frac}(\\mathrm{FCW}\\cdot TRI\\_PREV/2^F)'}</M>
                的係數,elaboration 時就是常數。
              </>
            ),
          },
          {
            code: 'assign acc_rst     = K_ACC * fcw;\nassign cur_rst_u   = K_CUR * fcw;',
            explain: (
              <>
                pre-advance:<M>{'\\mathrm{ACC}[LAT+1]'}</M> 與 <M>{'\\mathrm{ACC}[LAT]'}</M>。常數係數乘法,
                LAT = 0 時 fold 成 fcw 與 0;LAT 越大,這兩個乘法器與第二個 quantizer 越大(組合邏輯 489 →
                712 → 1041)。
              </>
            ),
          },
          {
            code: 'assign ef_prev_rst = K_EF * fcw[F-1:0];',
            explain: (
              <>
                只取 fcw 低 F bits 並截成 F bits:在 mod <M>{'2^F'}</M> 下乘積只取決於兩因子的低位,所以結果就是
                <M>{'e[LAT-1]'}</M>,u_q_rst 的 e_out 再給出 <M>{'e[LAT]'}</M>。
              </>
            ),
          },
          {
            code: 'acc_q   <= acc_q + fcw;',
            explain: (
              <>
                W-bit 加法自然 mod <M>{'2^W'}</M> wrap。decode 只用低 IW+8 bits 與差值,wrap 不改變任何輸出
                <EpistemicTag kind="EXACT" />。
              </>
            ),
          },
          {
            code: 'a_cur_q <= a_nxt;',
            explain: (
              <>
                j+1 的 quantized code 變成下一拍的「目前」code。n_int 由兩個 <strong>quantized</strong> code
                相減,所以 nearest / ef1 的進位跨出 8 個 fine bits 時,會像 golden model 一樣落進 divider
                command。
              </>
            ),
          },
          {
            code: 'assign n_int = a_nxt[IW+7:8] - a_cur[IW+7:8];',
            explain: (
              <>
                <M>{'n_{int} = I_{FB}[j+1] - I_{FB}[j]'}</M>,IW-bit 減法 = mod <M>{'2^{IW}'}</M>;在{' '}
                <M>{'0 \\le n_{int} < 2^{IW}'}</M>(即 N + 1 &lt; 2^IW)時為真值。
              </>
            ),
          },
          {
            code: 'assign r_inj = r_zero - a_cur[7:0];',
            explain: (
              <>
                Mode D modular reverse:8-bit 減法的 wrap 就是 mod 256,<M>{'(R_{FB} + R_{INJ}) \\bmod 256 = R_{zero}'}</M>{' '}
                在硬體中字面成立,digital pair error 恆為 0。
              </>
            ),
          },
          {
            code: "if (rst)     pipe_q <= '0;\nelse if (en) pipe_q <= pipe_shift[LAT*PW-1:0];",
            explain: (
              <>
                LAT 級 shift register(每級 PW = 1 + IW + 8 + 8 + SEQW = 37 bits)。reset 清 0,最高位是
                valid,所以前 LAT 拍 valid = 0、命令為 0;en = 0 時保持(testbench pass 1 檢查)。
              </>
            ),
          },
          {
            code: "assign c_inj  = {1'b0, r_inj[4:0]};",
            explain: (
              <>
                naive injection decode(§8):tap = <M>{'R_{INJ}[7:5]'}</M>、DTC = 低 5 bits,只用到 6-bit DTC
                的下半段;nearest-phase 與 calibrated mapping 未實作。
              </>
            ),
          },
          {
            code: 'x = Fraction(n_target) * (1 << (G_BITS + f_bits)) + Fraction(1, 2)',
            explain: (
              <>
                FCW 由十進位字串的 exact rational 取 half-up,與 float64 表示誤差無關;本章的 BigInt
                計算是同一語意。
              </>
            ),
          },
          {
            code: 'assert (k * fcw + (1 << f_bits)).bit_length() <= 53, (',
            explain: (
              <>
                保證 golden model 的 <M>{'u + 0.5'}</M> / <M>{'u + e'}</M> 在 float64 中 exact — 這是「float model 與
                整數 RTL 逐位相同」的前提,而不是運氣。
              </>
            ),
          },
        ]}
      />

      {/* 8 ------------------------------------------------------------ */}
      <SectionObserve>
        <ul>
          <li>
            <strong>圖 1。</strong>N = 3.13、F = 24:FCW = 13 443 247 636 = 0x3_2147_AE14(34 bits,
            36-bit port),<M>{'\\Delta f_{vco}'}</M> = −0.447 Hz;改成 3.125 或 3.126953125(dyadic)→
            每個 F 的 Δf = 0,點全部消失<EpistemicTag kind="EXACT" />。非 dyadic N 的 |Δf| 點永遠在
            <M>{'f_{ref}/2^{9+F}'}</M> 虛線之下,大致每多 1 bit 下降一半。
          </li>
          <li>
            <strong>圖 2(N = 3.13、窗長 2048)。</strong>nearest:F = 8 → k = 16、F = 12 → k = 691、
            F = 16 / 24 → 無差異;floor:F = 8 → 32、F = 12 → 1382、F = 16 / 24 → <strong>k = 25</strong>;
            ef1:F = 8 → 17、F = 12 → 24、F = 16 → 366、F = 24 → 無差異(窗長 4096 時 F = 24 於 k = 2366
            分歧)<EpistemicTag kind="EXPERIMENT" />。Python golden model 同設定逐值相同。
          </li>
          <li>
            <strong>為什麼 floor 在 F = 16、24 都卡在 k = 25:</strong>requested 軌跡在 k = 25 恰落在整數 grid
            上(float64 的 25 × 3.13 = 78.25,A = 20 032 LSB),而這兩個 F 的 FCW 是向下捨入(ΔN &lt; 0)→
            floor 少 1 LSB。F = 12 的 FCW 向上捨入(ΔN &gt; 0),floor 在 grid 點上不受影響,要等 drift{' '}
            <M>{'256\\,k\\,\\Delta N'}</M> 累積到 pattern 中最靠近邊界的 0.04 LSB(frac = 24/25)才分歧:預測{' '}
            <M>{'k \\ge 1365.3'}</M> 且 <M>{'k \\equiv 7 \\pmod{25}'}</M> → 1382,與量測相同
            <EpistemicTag kind="INFERENCE" />。
          </li>
          <li>
            <strong>nearest 的同一套推理:</strong>N = 3.13 的 fine-code 小數部分只取 m/25 LSB,離 half-LSB
            邊界最近 0.02 LSB(k ≡ 16 mod 25 時為 0.48)。F = 12:drift 在 k = 682.7 達 0.02 → 第一個 k ≡ 16
            為 691;F = 8:k = 16 時 drift 恰為 0.02,realized A = 12 820.5 正好是 tie,half-up 進位 → 不同。
            F = 16(ΔN &lt; 0)要到 k = 16 384 才達 0.02;延長到 17 000 拍的 Python 量測首差在 k = 16 409
            <EpistemicTag kind="EXPERIMENT" />。
          </li>
          <li>
            <strong>ef1 分歧得更早:</strong>residual 積分了 <M>{'\\sum u'}</M>,drift 是{' '}
            <M>{'128\\,k(k+1)\\,\\Delta N'}</M>(二次成長;F = 24、k = 2048 → 0.060 LSB)。F = 12(ΔN &gt; 0)在
            k = 24 就分歧 — 那是 <M>{'\\sum u'}</M> 在 exact 意義下恰為整數的第一點(16·24·25/25 = 384)
            <EpistemicTag kind="INFERENCE" />。
          </li>
          <li>
            <strong>圖 3。</strong>50/50 PASS 涵蓋 5 個 N(含 half-LSB tie 3.126953125 與 near-integer
            3.001,其 ef1 會出現 n_int = 2)× 3 quantizer × LAT ∈ {'{'}0, 1, 3{'}'},外加 LAT = 8、F = 16、
            F = 32;每個 case 兩個 pass(連續 en;中途 re-reset + 0–3 拍 idle 的稀疏 en)。合成表中 flop
            數嚴格等於 88 + 37·LAT。
          </li>
        </ul>
      </SectionObserve>

      {/* 9 ------------------------------------------------------------ */}
      <SectionMisconception>
        <Callout type="warn" title="誤解 1:「F 夠大,RTL 就會和 float model(requested N)逐拍相同」">
          <p>
            錯。(a) requested 軌跡只要剛好落在 decision boundary 上(floor 的整數點、nearest 的
            half-LSB tie),任何向下捨入的 FCW 都會立刻翻轉 code — N = 3.13 的 floor 在 F = 16 與 F = 24
            都在 k = 25 分歧;(b) drift 隨 k 線性(ef1 為二次)成長,任何有限 F 終將分歧。正確的比對
            對象是 <M>{'N_{real}'}</M> 的 golden model,這正是 gen_vectors 用 exact dyadic N 的原因
            <EpistemicTag kind="EXPERIMENT" />。
          </p>
        </Callout>
        <Callout type="warn" title="誤解 2:「LAT 只是在輸出多加幾級 flop」">
          <p>
            錯。若不 pre-advance,輸出的是 <M>{'\\mathrm{cmd}(k - LAT)'}</M>,即 §13 的 bug mode:α = 0.13、
            L = 1 時 phase error 0.13 cycle = 46.8°,是 half-LSB 0.703° 的 66.6 倍
            <EpistemicTag kind="EXACT" />。RTL 讓核心跑在 index <M>{'k + LAT'}</M>,reset 以 closed form 載入
            LAT 的 state,所以同一組 vectors 在 LAT ∈ {'{'}0, 1, 3, 8{'}'} 全部 PASS。
          </p>
        </Callout>
        <Callout type="warn" title="誤解 3:「nearest 用哪種 rounding 都差不多,反正只差半個 LSB」">
          <p>
            錯。RTL_USAGE.md 的 sensitivity check:把 nearest offset 從 <M>{'2^{F-1}'}</M> 改成{' '}
            <M>{'2^{F-2}'}</M>,14 個 off-grid nearest case 在第一個 rounding cycle 就 FAIL(例:
            <code>n3p126953125_nearest_lat0_rz10: cycle 1 signal c_fb: got 32 expected 33</code>),只有
            on-grid 3.125 仍 PASS。tie vector(<M>{'A[k] = 800.5\\,k'}</M>)專門釘住 half-up
            <EpistemicTag kind="EXPERIMENT" />。
          </p>
        </Callout>
        <Callout type="warn" title="誤解 4:「−0.447 Hz 的頻率誤差會變成 jitter」">
          <p>
            不對。FCW 量化給的是<strong>靜態</strong>頻率 offset:RTL 精確實現 <M>{'N_{real}'}</M> 的
            trajectory,鎖定後 VCO 就在 <M>{'N_{real} f_{ref}'}</M>。它改變的是長期 pattern 的週期
            (見設計要點),不是逐拍的 timing 誤差<EpistemicTag kind="INFERENCE" />。
          </p>
        </Callout>
      </SectionMisconception>

      {/* 10 ----------------------------------------------------------- */}
      <SectionTakeaway>
        <ul>
          <li>
            <strong>選 F:</strong>由頻率解析度 <M>{'f_{ref}/2^{8+F}'}</M> 與誤差上界{' '}
            <M>{'f_{ref}/2^{9+F}'}</M> 決定;4 GHz 下 F = 16 → 238.4 Hz、F = 24 → 0.931 Hz、F = 32 →
            3.638 mHz<EpistemicTag kind="EXACT" />。F 只增加 accumulator / ef_q 寬度,不改 decode。
          </li>
          <li>
            <strong>交接方法:</strong>golden vectors 一律在 <M>{'N_{real} = \\mathrm{FCW}/2^{8+F}'}</M> 產生,
            並保證 <M>{'k\\cdot\\mathrm{FCW} + 2^F < 2^{53}'}</M>;再以獨立整數 reference 交叉驗證。這讓
            「float model 與 RTL 逐位相同」成為可證明的性質,而不是容差比較。
          </li>
          <li>
            <strong>LAT:</strong>LAT ≥ 1 時所有輸出直接來自 flop(對 actuator 介面 glitch-free);代價是每級
            37 flops,以及 reset 時 closed-form pre-advance 的組合邏輯(cells 577 → 837 → 1240)。量產設計可改用
            LAT 拍 warm-up 或由軟體算好初值載入。
          </li>
          <li>
            <strong>Timing:</strong>36-bit accumulator 加 quantizer adder 是單 cycle;4 GHz reference
            需要把 LAT 級 retime 進 datapath,或用較慢的數位時脈搭配 en strobe
            <EpistemicTag kind="ASSUMPTION" />。
          </li>
          <li>
            <strong>週期變化:</strong>dyadic FCW 讓量化誤差序列的週期變成{' '}
            <M>{'P = 2^F/\\gcd(\\mathrm{FCW}, 2^F)'}</M>;N = 3.13、F = 24 時 FCW mod 2^24 = 4 697 620、gcd = 4 →
            P = 2^22 = 4 194 304 拍(f_ref/P ≈ 953.7 Hz),取代 requested N 的 P = 25。但 code 序列只在 drift
            跨過邊界的稀疏 cycle 與 P = 25 pattern 不同,其頻譜影響本章未量化
            <EpistemicTag kind="INFERENCE" />。
          </li>
        </ul>
      </SectionTakeaway>

      {/* 11 ----------------------------------------------------------- */}
      <SectionLimitation>
        <Callout type="honesty" title="RTL_USAGE.md §9 列出的限制(照錄)">
          <ul>
            <li>
              <strong>Reference RTL only。</strong>單一同步時脈域;<strong>沒有 CDC</strong> 到 analog
              DTC / PMUX / injection-pulse 域,actuator 介面沒有 retiming,沒有 reset synchronizer。
            </li>
            <li>
              <strong>沒有 DFT</strong>(scan、BIST)、<strong>沒有 timing closure</strong>(36-bit
              accumulator + quantizer adder 為單 cycle;4 GHz reference 需把 LAT 級 retime 進 datapath,或
              用較慢的數位時脈加 en strobe)、沒有 power intent、沒有 technology mapping。
            </li>
            <li>
              <strong>Quantizer 只有 nearest、floor、ef1 — 沒有 MASH 1-1 / 1-1-1</strong>,沒有 dither(§6
              第 5–7 項),沒有 <code>dsm_only</code> / <code>qnc</code> actuator modes(§7.1、§7.2)。
            </li>
            <li>
              <strong>只有 Mode D</strong>(quantize once + modular reverse);arch modes A / B / C 未實作。
            </li>
            <li>
              <strong>只有 naive injection decode</strong>(<code>j = R_INJ[7:5]</code>、
              <code>c = R_INJ[4:0]</code>);§8 的 nearest-phase 與 calibrated joint mapping 未實作。
            </li>
            <li>
              G = 256(6-bit DTC、4-phase PMUX)、8 taps 固定;需 <M>{'N + 1 < 2^{IW}'}</M>(IW = 4 → N &lt;
              15);<code>fcw</code>、<code>q_mode</code>、<code>r_zero</code> 從 reset 起必須靜態(沒有
              on-the-fly frequency hopping 語意 — 改了 fcw 只會以新增量繼續累加)。
            </li>
            <li>
              只以 yosys 的 CXXRTL 語意驗證(沒有 event-driven simulator;未跑 iverilog / Verilator /
              商用工具)。synthesizability 只以 yosys generic <code>synth</code> 證明;沒有 vendor tool、
              沒有 gate-level simulation。
            </li>
            <li>行為級結果<strong>不是</strong> silicon 結果(MODEL_SPEC §20)。</li>
          </ul>
        </Callout>
        <Callout type="honesty" title="本章自身的限制">
          <p>
            圖 2 比較的是兩個 float64 golden run(requested N 本身也只是 float64 近似),量測的是 code
            序列差異,不是 phase noise;圖 3 的 PASS 是記錄值(<code>rtl/run_sim.py</code>,需要
            yowasp-yosys + C++ 編譯器),瀏覽器內無法重跑 CXXRTL。合成數字是 technology-independent 的 generic
            gate 計數,不代表面積或速度。
          </p>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="參數">
        <Slider
          label="N(requested)"
          value={nDiv}
          min={3}
          max={3.25}
          step={0.0001}
          onChange={setNDiv}
          fmt={(v) => String(v)}
        />
        <PresetButtons
          label="N presets(含 RTL vector 的 N)"
          presets={N_PRESETS.map((p) => ({ label: p.label, onClick: () => setNDiv(p.n) }))}
        />
        <SelectControl<Q3>
          label="圖 2 raster 的 quantizer"
          value={quant}
          options={Q_NAMES.map((q) => ({ value: q, label: q }))}
          onChange={setQuant}
        />
        <SelectControl<WindowOpt>
          label="圖 2 窗長(cycles)"
          value={win}
          options={WINDOW_OPTIONS.map((w) => ({ value: w, label: w }))}
          onChange={setWin}
        />
        <Slider
          label="圖 1 的 F"
          value={calcF}
          min={1}
          max={40}
          step={1}
          unit="bits"
          onChange={(v) => setCalcF(Math.round(v))}
        />
      </ParamPanel>
    </ChapterShell>
  );
}
