/**
 * Chapter 20 — Design Rules and Conclusions 設計準則與結論
 * 逐條回答原始需求 §26 的 18 個設計問題(答案 + 依據 experiment/公式 + 標記)、
 * 推薦架構鏈、以及 MODEL_SPEC §20 的 honesty 清單。
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
import ExampleProblem, { fmt } from '../components/ExampleProblem';
import { M, MathBlock } from '../components/Math';
import { ParamPanel, Slider } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import DebugTable from '../components/DebugTable';
import { makeLineOption } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { trimNumber, phaseUnitLabel, phaseToUnitValue } from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  simulate,
  fromPartial,
  rms,
  configAlpha,
  configG,
  configTVcoS,
  wrapCycles,
  cyclesToDegrees,
  tapActual,
} from '../model';
import type { SimConfig } from '../model';

const meta = chapterById(20)!;

type TagKind = 'EXACT' | 'ASSUMPTION' | 'APPROX' | 'EXPERIMENT' | 'INFERENCE';

interface QA {
  n: number;
  q: string;
  a: string;
  basis: string;
  tag: TagKind;
}

/** 原始需求 §26 的 18 個設計問題,逐條作答。 */
const QA_LIST: QA[] = [
  {
    n: 1,
    q: '反向 injection 的正確數學關係是什麼?',
    a: 'u_INJ_ideal[k] = wrap01(z0 − x_nominal[k]);z0=0 時即 wrap01(−x)。injection command 是 VCO fractional phase 的模 1 反相,不是任何啟發式。',
    basis: 'MODEL_SPEC §5.2;exp02(N=3.125 時 j_INJ 每拍 −1 tap)',
    tag: 'EXACT',
  },
  {
    n: 2,
    q: '為什麼 injection pulse 相對 reference 每拍要「倒轉」−α?',
    a: 'VCO 相對 reference 每拍多轉 +α;要讓 pulse 固定落在 VCO 的同一個 zero crossing,pulse 的 normalized 位置必須每拍反向移動 −α。這就是 reverse injection 的物理來源。',
    basis: 'MODEL_SPEC §5.2 zero-crossing condition;Ch6 推導',
    tag: 'EXACT',
  },
  {
    n: 3,
    q: '只看 DSM 輸出 bit(/3 或 /4)能不能決定 injection phase?',
    a: '不能。q_N[k]=N−n[k] 是瞬時量,phase 是累積量 p[k+1]=p[k]+N−n[k]:同樣輸出 /3 的兩個 cycle,accumulator state 可以不同,所需 injection phase 也不同。必須拉 shared master accumulator state / accumulated quantization error / final common code。',
    basis: 'exp20(bit-only vs accumulated state);Ch9;P(z)=z⁻¹/(1−z⁻¹)·(N−N_div)',
    tag: 'EXACT',
  },
  {
    n: 4,
    q: '四種架構 mode(A/B/C/D)該選哪個?',
    a: 'Mode D(quantize once + modular reverse):R_INJ=(R_zero−R_FB) mod 256,identity 使 e_pair_digital≡0 對所有 k、所有 quantizer 成立。Mode B(獨立 DSM)平均正確但逐拍 reverse 關係錯誤,不建議;Mode C 共享 state 但獨立量化,pair error 仍可非零。',
    basis: 'MODEL_SPEC §7;Test 2/13;exp03/04/05/06/09',
    tag: 'EXACT',
  },
  {
    n: 5,
    q: 'shared final code 消除什麼、不能消除什麼?',
    a: '消除:feedback/injection 兩路的數位相對 mismatch(pair error)。不能消除:absolute quantization error、DTC analog gain/INL、tap mismatch、route mismatch、latency error、VCO random noise —— 這些逐項仍在。',
    basis: 'MODEL_SPEC §7 列表;exp06 vs exp12/13(mode D 下 e_ZC_hw 仍非零)',
    tag: 'EXACT',
  },
  {
    n: 6,
    q: 'shared code 能不能「創造」sub-LSB 的 analog delay?',
    a: '不能。u=0.337 例:R_FB=86、R_INJ=170,兩側各差 ∓85 fs,但 pair 和恰為 1.0 cycle → e_pair=0。VCO 追蹤的是 quantized common trajectory;sub-LSB 精度不存在於任一單邊。',
    basis: 'MODEL_SPEC §9;Test 1/3;Ch10',
    tag: 'EXACT',
  },
  {
    n: 7,
    q: '固定 rounding(nearest)與 phase DSM 怎麼取捨?',
    a: '以 nearest 為 baseline。0.3 LSB canonical case:nearest 每拍固定 −0.3 LSB(deterministic spur);ef1 長期平均 → 0 但 peak 誤差升到 +0.7 LSB。DSM 能做 temporal averaging / noise shaping / 改變頻譜;不能做 sub-LSB analog timing、不能消 tap/DTC/latency error、不能預知 VCO noise。評估 spur 需求後才選 shared DSM。',
    basis: 'MODEL_SPEC §6;Test 4;exp07/08/09;Ch11',
    tag: 'EXPERIMENT',
  },
  {
    n: 8,
    q: 'DSM 能預測哪一類誤差?injection 真正要修的是什麼?',
    a: 'DSM/accumulator 只能預測 deterministic fractional phase(§5.3 第 1 類);VCO random phase noise(第 2 類)不可預測 —— 這正是 injection 存在的理由。混淆兩者會把 scheduler 誤差當成 noise 修正目標。',
    basis: 'MODEL_SPEC §5.3 七類誤差;exp17(none/reset/sin 對照)',
    tag: 'EXACT',
  },
  {
    n: 9,
    q: 'Pipeline latency 怎麼處理才正確?',
    a: '固定 latency L + look-ahead:apply 於 k+L 的 command 必須由 state P[k+L] 計算(x[k+L]=wrap01(x[k]+Lα))。用 state k 計算是 bug mode:α=0.13、L=1 → 46.8° 誤差,是 half-LSB 0.703° 的 66.6 倍。每筆 command 應附 {k_computed, k_intended, k_applied, seq_id} metadata。',
    basis: 'MODEL_SPEC §13;Test 5;exp10/11;Ch12',
    tag: 'EXACT',
  },
  {
    n: 10,
    q: 'tap/DTC decode 用哪種 mapping?redundancy 有什麼用?',
    a: 'tap 間距 32 LSB、DTC range 64 LSB → 同一 target 有 (j,c) 與 (j−1 mod 8, c+32) 兩種表示。理想參數下 naive floor 足夠;有 tap/DTC mismatch 時 calibrated argmin(用實測 tap+DTC+route 特性)可利用 redundancy 選誤差較小的解,降低 rms placement error。',
    basis: 'MODEL_SPEC §8;exp19(naive vs calibrated with mismatch);Ch7 數值例',
    tag: 'EXPERIMENT',
  },
  {
    n: 11,
    q: 'DTC 該用 normalized 還是 fixed-time LSB?',
    a: 'normalized(Δt=T_vco/256)時 phase LSB 恆為 1.40625°,跨頻率行為一致;fixed-time(Δt 固定 312.5 fs)時 time LSB 不變但 phase LSB 隨 f_vco 改變(325.521/312.500/300.481 fs @ 12/12.5/13 GHz 的 normalized 對應值),校正表要跟著頻率走。系統分析用 normalized 較乾淨;實體 DTC 是 fixed-time,需帶頻率相依 gain 校正。',
    basis: 'MODEL_SPEC §11 頻率表;exp18(12–13 GHz sweep);Ch5 圖#28',
    tag: 'EXACT',
  },
  {
    n: 12,
    q: '1° 的 injection tap mismatch 可以忽略嗎?',
    a: '不可以。T_vco=80 ps 時 1° = 222.22 fs ≈ 0.711 LSB,大於 half-LSB 156.25 fs —— 單一 tap mismatch 就吃掉整個量化預算。tap mismatch 必須校正(或用 calibrated mapping 繞開)。',
    basis: 'MODEL_SPEC §10 檢查值;Test 6;exp12',
    tag: 'EXACT',
  },
  {
    n: 13,
    q: '1% 的 DTC gain error 可以忽略嗎?',
    a: '不可以。DTC full range = T_vco/4 = 20 ps,1% gain → 最大 200 fs ≈ 0.64 LSB,同樣大於 half-LSB。且誤差隨 code 變化(code-dependent),在 fractional 序列下轉成 spur。',
    basis: 'MODEL_SPEC §10;Test 7;exp13/14',
    tag: 'EXACT',
  },
  {
    n: 14,
    q: 'injection 修正能力的 lock 條件是什麼?',
    a: 'sinusoidal map 下 K_inj·sin(θ_ss)=2πΔf·T_ref,lock 條件 |2πΔf·T_ref| ≤ K_inj,stable 解取 cos(θ_ss)>0。K_inj→0 等於沒有 injection(random walk / detuning ramp);K_inj 增大 → 收斂更快、residual 更小。',
    basis: 'MODEL_SPEC §14;Test 14;exp15/17;Ch13',
    tag: 'APPROX',
  },
  {
    n: 15,
    q: 'zero-crossing miss 的能量後果多大?',
    a: 'v_d/V_p = sin(2πε_t/T_vco),E ∝ sin²。half-LSB miss(ε_t=T_vco/512)→ |v_d|/V_p ≈ 2π/512 ≈ 1.227%,E ≈ 1.5e-4(normalized proxy)。deterministic scheduling 做對時,shorting 擾動即被壓到這個量級以下。',
    basis: 'MODEL_SPEC §15;Ch14 圖#23/#24',
    tag: 'APPROX',
  },
  {
    n: 16,
    q: '不同性質的 timing error 各造成什麼頻譜後果?',
    a: '固定 error → static phase offset;periodic error(如 fractional pattern、code-dependent INL)→ deterministic spur(f_spur=m/P·f_ref);noise-like error → phase-noise floor 抬升。診斷時先分類再對症:offset 校 z0、spur 校 deterministic 路徑、floor 只能靠 injection 強度與 noise 源。',
    basis: 'MODEL_SPEC §15/§17;exp16(fixed vs periodic vs random);Ch16',
    tag: 'INFERENCE',
  },
  {
    n: 17,
    q: 'spur / phase-noise 分析的正確量測 convention?',
    a: 'per-reference-cycle 序列的 sample rate 是 f_ref(不是 f_vco);period-P 序列的 spur 在 f_spur=(m/P)·f_ref;PSD 用 Hann periodogram(one-sided);SSB spur = 20·log10(a/2) dBc(small-angle),未經 carrier normalization 的 phase PSD 不可直接標 dBc。固定 seed 12345 使 Python 與 browser 結果一致。',
    basis: 'MODEL_SPEC §17;Test 12;Ch16',
    tag: 'EXACT',
  },
  {
    n: 18,
    q: 'behavioral 模型的結論可以直接外推到 silicon 嗎?',
    a: '不可以。scheduler equations 是 exact digital timing model,可以直接落 RTL;但 DTC/tap mismatch 是 behavioral 假設、injection map 是 approximation、shorting energy 是 proxy,且本專案未執行 Spectre。architecture 層結論(mode D、look-ahead、校正需求)穩健;數值層結論(residual、spur 位準)需 transistor-level 驗證。',
    basis: 'MODEL_SPEC §20;VERILOGA_USAGE.md 誠實聲明;Ch19',
    tag: 'INFERENCE',
  },
];

/**
 * 補充問答:DSM 使用模式與 reverse injection 的相容性(exp21/exp22)。
 * 量測值全部來自 golden model(512 cycles、seed 12345)。
 */
const DSM_QA: QA[] = [
  {
    n: 1,
    q: '哪些 DSM 使用模式可以與 reverse injection 共存?各自怎麼共存?',
    a: '四種模式,結論各異:(1) divider-modulating MASH 可以共存,但必須把 accumulated quantization state 餵給 fine actuator(DTC/PMUX)—— 即 mode D + mash quantizer + full actuator;(2) 純 dsm_only(無 fine actuator)不能無條件共存,必須 gating 且性能仍差;(3) full fractional actuator(DTC-QNC 等效)是推薦 baseline;(4) phase-domain DSM(shared final code 上的 ef1/mash)是選配,經 spur-vs-peak 評估後才用。以下三題附量測數字。',
    basis: 'exp21/exp22;MODEL_SPEC §6/§7.1/§14',
    tag: 'EXPERIMENT',
  },
  {
    n: 2,
    q: 'divider-MASH(調 divider 的 DSM)怎麼配 reverse injection 才正確?',
    a: '把 MASH 建在 shared master accumulator 上(mode D),整數部分走 divider(N=3.13 時 n_int 只用 {3,4}),accumulated 殘餘交給 DTC —— 殘餘不小:e_FB_abs 峰值 1.36 LSB(mash11)/ 1.76 LSB(mash111),都超過 DTC 的 half-LSB 量化預算數倍,沒有 fine actuator 就沒有人吃掉它。做對之後 e_pair_digital 仍恆 0(identity 與 quantizer 無關),e_ZC_total rms 0.00268 / 0.00467 cycle(mash11 / mash111)。掃 N∈[3,3.25] 時 n_int 可達 {2,3,4}(小 α 才出現 2),divider 整數餘裕要照最壞情況設計。',
    basis: 'exp22 量測(rms 0.47/0.69/1.19 LSB、峰值 0.76/1.36/1.76 LSB);Q3(bit 不含 phase);Ch9/Ch11',
    tag: 'EXPERIMENT',
  },
  {
    n: 3,
    q: '純 dsm_only(無 PMUX/DTC/tap)撐得起 reverse injection 嗎?',
    a: '撐不起。integer-cycle actuator 使 e_ZC_hw 掃過 ±0.5 cycle(rms 0.289 cycle),kick 落點任意,loop 直接失鎖:theta_plus rms(last 256)1.81 rad(exp21b)。加 threshold gating(fire iff |e_ZC_hw| ≤ 0.0625 cycle)後回到有界 lock,但只 fire 67/512(13.1%),residual 0.102 rad —— 仍比 full actuator 的 0.015 rad 差約 7 倍。gating 是止血,不是解方。',
    basis: 'exp21 三組量測(512/512 vs 67/512 fire;0.015 / 1.81 / 0.102 rad);MODEL_SPEC §7.1、§14 gating',
    tag: 'EXPERIMENT',
  },
  {
    n: 4,
    q: '那 baseline 該是哪一種?phase-domain DSM 又何時用?',
    a: 'baseline 是 full fractional actuator(PMUX+DTC+tap;DTC-based quantization-noise-cancellation 的等效):exp21a 量測 512/512 fire、|e_ZC_hw| ≤ 0.00297 cycle、theta_plus rms 0.015 rad,是 dsm_only 任一變體達不到的。phase-domain DSM 是其上的選配:mode D 下換 quantizer 不破壞 identity,但階數越高瞬時誤差越大(e_FB_abs rms 0.47→0.69→1.19 LSB、峰值 0.76→1.36→1.76 LSB),換到的只是頻譜形狀 —— 只有 spur 需求值得付出 peak 時才選,預設 nearest。',
    basis: 'exp21a;exp22;exp07/08(nearest vs ef1 的 spur-vs-peak 原型)',
    tag: 'INFERENCE',
  },
];

/** 比較 dashboard 的 6 組 config(id 對應 experiments.py / EXPERIMENTS)。 */
const DASH_CONFIGS: { id: string; label: string; partial: Partial<SimConfig> }[] = [
  { id: 'exp03', label: 'Mode D + nearest(baseline)', partial: { n_div: 3.13 } },
  { id: 'exp05', label: 'Mode B + ef1(獨立 DSM)', partial: { n_div: 3.13, arch_mode: 'B', quantizer: 'ef1' } },
  { id: 'exp10', label: 'latency bug(L=1, no look-ahead)', partial: { n_div: 3.13, latency_cycles: 1, lookahead: false } },
  { id: 'exp11', label: 'look-ahead(L=1)', partial: { n_div: 3.13, latency_cycles: 1, lookahead: true } },
  {
    id: 'exp12',
    label: '1° tap mismatch',
    partial: { n_div: 3.125, tap_mismatch_cycles: Array(8).fill(1.0 / 360.0) as number[] },
  },
  { id: 'exp13', label: '1% INJ DTC gain', partial: { n_div: 3.13, dtc_inj_gain: 1.01 } },
];

const TS_MODE_D_EXCERPT = `// web/src/model/injectionScheduler.ts — R_INJ per architecture mode(逐字節錄)
const rInj = new Float64Array(n);
if (cfg.arch_mode === 'D') {
  for (let k = 0; k < n; k++) {
    rInj[k] = pymod(cfg.r_zero - rFb[k], g);
  }
} else {
  // A, B, C: independent quantizer instance on G * u_INJ_ideal
  const q = makeQuantizer(cfg.quantizer);
  const useDither = cfg.dither_amp_lsb > 0.0 && ditherStream !== null;
  for (let k = 0; k < n; k++) {
    let u = g * uIdeal[k];
    if (useDither && ditherStream !== null) {
      u += cfg.dither_amp_lsb * (ditherStream.next() + ditherStream.next() - 1.0);
    }
    rInj[k] = pymod(q.quantize(u), g);
  }
}`;

const TS_LOCK_EXCERPT = `// web/src/model/injectionDynamics.ts — lock condition 與 fixed point(逐字節錄)
/** |2*pi*Delta_f*T_ref| <= K_inj (sinusoidal map lock range). */
export function lockCondition(kInj: number, deltaFHz: number, fRefHz: number): boolean {
  const a = (2.0 * Math.PI * deltaFHz) / fRefHz;
  return Math.abs(a) <= kInj;
}

export function sinFixedPointRad(kInj: number, deltaFHz: number, fRefHz: number): number | null {
  const a = (2.0 * Math.PI * deltaFHz) / fRefHz;
  if (kInj <= 0.0 || Math.abs(a) > kInj) {
    return null;
  }
  return Math.asin(a / kInj);
}`;

/** 推薦架構鏈(每一環附依據)。 */
const CHAIN: { step: string; why: string }[] = [
  { step: 'Shared master accumulator', why: '瞬時 bit 不含 phase;accumulated state 才含(exp20、Ch9)' },
  { step: 'Common final code(quantize once)', why: '單一 quantize 點,兩路共用同一 R_FB(§7)' },
  { step: 'FB decode:I / R / m / c', why: 'exact integer decode + edge monotonic assertions(§4、Test 8)' },
  { step: 'Modular reverse:R_INJ = (R_zero − R_FB) mod 256', why: 'e_pair_digital ≡ 0 by construction(Test 2、exp06)' },
  { step: 'Calibrated tap/DTC decode(需要時)', why: 'redundancy + argmin 吃掉 tap/DTC mismatch(exp19)' },
  { step: 'Fixed-latency look-ahead', why: '46.8° bug → half-LSB 內(Test 5、exp10/11)' },
  { step: 'Nearest 為 baseline quantizer', why: 'bounded ±half-LSB deterministic error(exp03/07)' },
  { step: '評估 spur 後才選 shared DSM', why: 'DSM 改頻譜、不減 peak,階數越高 peak 越大;必要才用(exp08/09/22)' },
];

/** MODEL_SPEC §20 honesty 清單(faithful),加上 Ch13 的 gating/loop 交互限制。 */
const HONESTY: string[] = [
  'scheduler equations 是 exact digital timing model',
  'DTC/tap mismatch 是 behavioral nonideality model',
  'sinusoidal injection map 是 approximation;真實 phase response 需 transistor-level transient/PSS/PDR extraction',
  'shorting energy 是 normalized proxy',
  'threshold gating 的判準是 deterministic 的 e_ZC_hw(scheduler 可預先計算),不含 noise;真實電路的 gate 決策若含 jitter/metastability/量測誤差,行為會偏離本模型(§14)',
  'gating 與 loop dynamics 的交互只以 per-cycle kick mask 建模:非 fire 拍 delta_theta = 0、theta 照常累積 detuning 與 noise;fire rate 與 residual(exp21c:67/512、0.102 rad)是 behavioral 量測值,不是 closed-form 保證,且解讀 e_ZC_total 必須連同 inj_fired mask 一起看(§16、Ch13)',
  '本專案未執行 Spectre;Verilog-A 提供 source 與 usage guide,未經 simulator 驗證',
  'behavioral result 不等同 silicon result',
];

export default function Chapter20() {
  const [nCycles, setNCycles] = useState(512);
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const runs = useMemo(
    () =>
      DASH_CONFIGS.map((c) => {
        const res = simulate(fromPartial({ ...c.partial, n_cycles: nCycles }));
        return {
          id: c.id,
          label: c.label,
          tVco: res.t_vco_s,
          rms_e_FB_abs: rms(res.data.e_FB_abs),
          rms_e_pair_digital: rms(res.data.e_pair_digital),
          rms_e_ZC_hw: rms(res.data.e_ZC_hw),
        };
      }),
    [nCycles],
  );

  useEffect(() => {
    setStatus('done', `${DASH_CONFIGS.length} configs × ${nCycles} cycles`);
  }, [runs, nCycles, setStatus]);

  const tVco0 = runs[0].tVco;

  const dashOption = useMemo(() => {
    const conv = (v: number, tVco: number) => phaseToUnitValue(v, unit, tVco);
    return makeLineOption({
      xType: 'category',
      categories: runs.map((r) => r.id),
      xLabel: 'config (experiment id)',
      yLabel: `RMS error (${phaseUnitLabel(unit, tVco0)})`,
      yTickFormatter: (v: number) => trimNumber(v, 3),
      zoom: false,
      series: [
        { name: 'rms e_FB_abs', data: runs.map((r) => conv(r.rms_e_FB_abs, r.tVco)), type: 'bar' },
        { name: 'rms e_pair_digital', data: runs.map((r) => conv(r.rms_e_pair_digital, r.tVco)), type: 'bar' },
        { name: 'rms e_ZC_hw', data: runs.map((r) => conv(r.rms_e_ZC_hw, r.tVco)), type: 'bar' },
      ],
    });
  }, [runs, unit, tVco0, ct]);

  const dashRows = useMemo(
    () =>
      runs.map((r) => ({
        id: r.id,
        config: r.label,
        rms_e_FB_abs_cyc: r.rms_e_FB_abs,
        rms_e_pair_digital_cyc: r.rms_e_pair_digital,
        rms_e_ZC_hw_cyc: r.rms_e_ZC_hw,
        rms_e_FB_abs_deg: r.rms_e_FB_abs * 360,
        rms_e_ZC_hw_fs: (r.rms_e_ZC_hw * r.tVco) / 1e-15,
      })),
    [runs],
  );

  const fmt6 = (v: unknown) => trimNumber(Number(v), 6);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>原始需求 §26 的 18 個設計問題,逐條的最終答案是什麼?各自依據哪個
            experiment / 公式?</li>
          <li>哪些 DSM 使用模式可以與 reverse injection 共存?divider-MASH、純
            dsm_only、full actuator、phase-domain DSM 四者的量測結論(exp21/exp22)
            各是什麼?</li>
          <li>綜合 22 個 experiments,推薦的架構鏈長什麼樣?每一環為什麼?</li>
          <li>哪些結論是 exact、哪些是 behavioral 假設、哪些只是 approximation ——
            誠實邊界在哪裡?</li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          全站的設計判準可以濃縮成一把尺:<strong>half-LSB = 156.25 fs = 0.703125°</strong>
          (N=3.125)。deterministic scheduler 做到極致,殘餘就是 ±half-LSB;任何其他
          誤差源只要超過這把尺,就成為系統的主導誤差。三個 canonical 數字立刻排出
          優先序:latency bug 46.8°(66.6 倍)&gt;&gt; 1° tap mismatch 222.22 fs(0.711 LSB)
          &gt; 1% DTC gain 200 fs(0.64 LSB)&gt; half-LSB。所以順序是:先把數位做對
          (mode D + look-ahead —— 零 analog 成本、exact),再校 analog(tap/DTC),
          最後才微調 quantizer 的頻譜行為。<EpistemicTag kind="INFERENCE" />
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>支撐 18 個答案的核心恆等式與判準(全站推導的濃縮;sign convention 依 §2):</p>
        <MathBlock>{'u_{INJ,ideal}[k] = \\operatorname{wrap01}\\big(z_0 - x_{nominal}[k]\\big)'}</MathBlock>
        <MathBlock>{'R_{INJ}[k] = (R_{zero} - R_{FB}[k]) \\bmod 256 \\;\\Rightarrow\\; (R_{FB}[k] + R_{INJ}[k]) \\bmod 256 = R_{zero}'}</MathBlock>
        <MathBlock>{'e_{pair}[k] = \\operatorname{wrapCycles}\\big(u_{FB}[k] + u_{INJ}[k] - R_{zero}/G\\big) \\;\\equiv\\; 0 \\ \\text{(digital, mode D)}'}</MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> 以上三式是 Q1/Q4/Q5 的依據:digital identity,
          由構造成立,pytest/vitest 逐位驗證(Test 2)。
        </p>
        <MathBlock>{'x[k+L] = \\operatorname{wrap01}(x[k] + L\\alpha), \\qquad e_{bug} = \\operatorname{wrapCycles}(L\\alpha) \\;\\xrightarrow{\\alpha=0.13,\\,L=1}\\; 46.8^{\\circ}'}</MathBlock>
        <p><EpistemicTag kind="EXACT" /> Q9(look-ahead)的依據(Test 5)。</p>
        <MathBlock>{'K_{inj}\\sin\\theta_{ss} = 2\\pi\\,\\Delta f\\, T_{ref}, \\qquad \\text{lock iff } |2\\pi\\,\\Delta f\\, T_{ref}| \\le K_{inj}'}</MathBlock>
        <p><EpistemicTag kind="APPROX" /> Q14(lock 條件)的依據 —— sinusoidal map 是近似。</p>
        <MathBlock>{'\\frac{v_d}{V_p} = \\sin\\frac{2\\pi\\varepsilon_t}{T_{vco}}, \\qquad E_{norm} = \\sin^2\\frac{2\\pi\\varepsilon_t}{T_{vco}} \\;\\xrightarrow{\\varepsilon_t = T_{vco}/512}\\; 1.5\\times 10^{-4}'}</MathBlock>
        <p><EpistemicTag kind="APPROX" /> Q15(shorting proxy)的依據。</p>
      </SectionMath>

      <SectionExample>
        <p>誤差預算表(全部可手算;N=3.125、T_vco=80 ps、G=256):</p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr><th>誤差源</th><th>手算</th><th>大小</th><th>相對 half-LSB</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>quantization half-LSB</td>
                <td>80 ps / 512</td>
                <td>156.25 fs = 0.703125°</td>
                <td>1×(基準)</td>
              </tr>
              <tr>
                <td>1% DTC gain(Q13)</td>
                <td>0.01 × 20 ps</td>
                <td>200 fs ≈ 0.64 LSB</td>
                <td>1.28×</td>
              </tr>
              <tr>
                <td>1° tap mismatch(Q12)</td>
                <td>80 ps / 360</td>
                <td>222.22 fs ≈ 0.711 LSB</td>
                <td>1.42×</td>
              </tr>
              <tr>
                <td>latency bug L=1, α=0.13(Q9)</td>
                <td>0.13 × 360°</td>
                <td>46.8°</td>
                <td>66.6×</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          驗算:<M>{'46.8 / 0.703125 = 66.56'}</M>;<M>{'80\\,\\text{ps}/360 = 222.2\\,\\text{fs}'}</M>;
          <M>{'0.01 \\times 20\\,\\text{ps} = 200\\,\\text{fs}'}</M>。<EpistemicTag kind="EXACT" />
          排序即設計優先序:digital 正確性(免費)→ analog 校正(有成本)→
          quantizer 頻譜(權衡)。<EpistemicTag kind="INFERENCE" />
        </p>

        <ExampleProblem
          index={1}
          tag="EXACT"
          title="tap mismatch 對 half-LSB 預算的比值(Q12)"
          prompt={
            <>
              給定 <M>{'N'}</M>、單一 tap 的角度誤差與 tap index <M>{'j'}</M>,用
              <code>tapActual</code> 算出 tap 的實際相位與理想相位 <M>{'j/8'}</M> 之差,換算成
              fs,再對照 half-LSB(<M>{'T_{vco}/(2G)'}</M>)看倍率 —— 就是誤差預算表第三列的
              互動版。
            </>
          }
          inputs={[
            { key: 'N', label: <M>{'N'}</M>, def: 3.125, min: 3, max: 3.25, step: 0.0001 },
            { key: 'mismatchDeg', label: 'tap 角度誤差', def: 1, min: -10, max: 10, step: 0.1, unit: '°' },
            { key: 'j', label: <M>{'j'}</M>, def: 0, min: 0, max: 7, step: 1 },
          ]}
          compute={(v) => {
            const cfg = fromPartial({ n_div: v.N });
            const tVcoPs = configTVcoS(cfg) * 1e12;
            const g = configG(cfg);
            const j = Math.max(0, Math.min(7, Math.round(v.j)));
            const deltaTap = new Array(8).fill(v.mismatchDeg / 360);
            const nominalCycles = j / 8;
            const actualCycles = tapActual(j, 8, deltaTap);
            const mismatchCycles = actualCycles - nominalCycles;
            const mismatchFs = mismatchCycles * tVcoPs * 1000;
            const halfLsbFs = (tVcoPs * 1000) / (2 * g);
            const ratio = Math.abs(mismatchFs) / halfLsbFs;
            return {
              steps: [
                { label: <>理想 tap 相位 <M>{'j/8'}</M></>, value: fmt(nominalCycles, 6, 'cyc') },
                { label: <>實際 tap 相位 <code>tapActual(j)</code></>, value: fmt(actualCycles, 6, 'cyc') },
                { label: <>mismatch(實際 − 理想)</>, value: fmt(mismatchFs, 6, 'fs') },
                { label: <>half-LSB <M>{'=T_{vco}/(2G)'}</M></>, value: fmt(halfLsbFs, 5, 'fs') },
                { label: <>倍率</>, value: `${fmt(ratio, 4)}×` },
              ],
              answer: (
                <>
                  mismatch = {fmt(mismatchFs, 5, 'fs')},是 half-LSB({fmt(halfLsbFs, 4, 'fs')})的{' '}
                  {fmt(ratio, 4)} 倍
                </>
              ),
              warn: ratio > 1 ? '單一 tap mismatch 已超過 half-LSB 量化預算,需要校正' : undefined,
            };
          }}
        />

        <ExampleProblem
          index={2}
          tag="EXACT"
          title="latency bug 的靜態誤差(Q9)"
          prompt={
            <>
              固定 latency <M>{'L'}</M>、沒有 look-ahead 時,誤差是{' '}
              <M>{'e_{bug}=\\operatorname{wrapCycles}(L\\alpha)'}</M>,其中{' '}
              <M>{'\\alpha=N-\\lfloor N\\rfloor'}</M>。給定 <M>{'N'}</M> 與 <M>{'L'}</M>,算出這個
              靜態誤差(度)並對照 half-LSB 看倍率。
            </>
          }
          inputs={[
            { key: 'N', label: <M>{'N'}</M>, def: 3.13, min: 3, max: 3.25, step: 0.0001 },
            { key: 'L', label: <M>{'L'}</M>, def: 1, min: 0, max: 8, step: 1, unit: 'cyc' },
          ]}
          compute={(v) => {
            const cfg = fromPartial({ n_div: v.N });
            const alpha = configAlpha(cfg);
            const L = Math.round(v.L);
            const eBug = wrapCycles(L * alpha);
            const eBugDeg = cyclesToDegrees(eBug);
            const g = configG(cfg);
            const halfLsbDeg = 360 / (2 * g);
            const ratio = Math.abs(eBugDeg) / halfLsbDeg;
            return {
              steps: [
                { label: <><M>{'\\alpha=N-\\lfloor N\\rfloor'}</M></>, value: fmt(alpha, 6, 'cyc') },
                { label: <><M>{'e_{bug}=\\operatorname{wrapCycles}(L\\alpha)'}</M></>, value: fmt(eBug, 6, 'cyc') },
                { label: <>換算成度數</>, value: fmt(eBugDeg, 4, '°') },
                { label: <>half-LSB(度)</>, value: fmt(halfLsbDeg, 5, '°') },
                { label: <>倍率</>, value: `${fmt(ratio, 4)}×` },
              ],
              answer: (
                <>
                  e_bug = {fmt(eBugDeg, 4)}°,是 half-LSB({fmt(halfLsbDeg, 4)}°)的{' '}
                  {fmt(ratio, 4)} 倍
                </>
              ),
              warn: ratio > 10 ? 'latency bug 造成的誤差遠超量化預算 —— look-ahead 是免費的修正' : undefined,
            };
          }}
        />

        <ExampleProblem
          index={3}
          tag="EXPERIMENT"
          title="error budget roll-up:多誤差源合併是否等於 RSS?"
          prompt={
            <>
              同時開啟 DTC gain 誤差與 tap mismatch,用 <code>simulate()</code> 量測合併後的{' '}
              <M>{'\\mathrm{rms}(e_{ZC,hw})'}</M>;再分別只開一項算出各自的 rms,取
              root-sum-square <M>{'\\sqrt{\\mathrm{rms}_{gain}^2+\\mathrm{rms}_{tap}^2}'}</M>{' '}
              當作 naive 誤差預算估計,比較兩者是否一致。
            </>
          }
          inputs={[
            { key: 'N', label: <M>{'N'}</M>, def: 3.13, min: 3, max: 3.25, step: 0.0001 },
            { key: 'gainPct', label: 'DTC gain 誤差', def: 1, min: -10, max: 10, step: 0.1, unit: '%' },
            { key: 'mismatchDeg', label: 'tap 角度誤差', def: 1, min: -10, max: 10, step: 0.1, unit: '°' },
            { key: 'n', label: <M>{'n'}</M>, def: 64, min: 8, max: 128, step: 8, unit: 'cyc' },
          ]}
          compute={(v) => {
            const n = Math.max(8, Math.round(v.n));
            const tapMismatch = new Array(8).fill(v.mismatchDeg / 360);
            const gain = 1 + v.gainPct / 100;
            const cfgBoth = fromPartial({
              n_div: v.N,
              dtc_inj_gain: gain,
              tap_mismatch_cycles: tapMismatch,
              n_cycles: n,
            });
            const cfgGain = fromPartial({ n_div: v.N, dtc_inj_gain: gain, n_cycles: n });
            const cfgTap = fromPartial({ n_div: v.N, tap_mismatch_cycles: tapMismatch, n_cycles: n });
            const resBoth = simulate(cfgBoth);
            const resGain = simulate(cfgGain);
            const resTap = simulate(cfgTap);
            const tVcoFs = configTVcoS(cfgBoth) * 1e15;
            const rmsBothFs = rms(resBoth.data.e_ZC_hw) * tVcoFs;
            const rmsGainFs = rms(resGain.data.e_ZC_hw) * tVcoFs;
            const rmsTapFs = rms(resTap.data.e_ZC_hw) * tVcoFs;
            const rss = Math.sqrt(rmsGainFs * rmsGainFs + rmsTapFs * rmsTapFs);
            const ratio = rmsBothFs / rss;
            return {
              steps: [
                { label: <>只開 DTC gain:<M>{'\\mathrm{rms}(e_{ZC,hw})'}</M></>, value: fmt(rmsGainFs, 6, 'fs') },
                { label: <>只開 tap mismatch:<M>{'\\mathrm{rms}(e_{ZC,hw})'}</M></>, value: fmt(rmsTapFs, 6, 'fs') },
                { label: <>RSS 估計 <M>{'\\sqrt{a^2+b^2}'}</M></>, value: fmt(rss, 6, 'fs') },
                { label: <>兩項同開:實測 <M>{'\\mathrm{rms}(e_{ZC,hw})'}</M></>, value: fmt(rmsBothFs, 6, 'fs') },
                { label: <>實測 / RSS 估計</>, value: fmt(ratio, 4) },
              ],
              answer: (
                <>
                  實測合併 rms = {fmt(rmsBothFs, 5, 'fs')},naive RSS 估計 = {fmt(rss, 5, 'fs')}
                  (比值 {fmt(ratio, 4)})
                </>
              ),
              warn:
                Math.abs(ratio - 1) > 0.05
                  ? 'RSS 假設誤差源互相獨立;實測偏離 RSS 表示各誤差源之間有相關性,naive 預算表只能當估計'
                  : undefined,
            };
          }}
        />
      </SectionExample>

      <SectionFigure
        title="18 個設計問題 — 逐條答案"
        caption={
          <span>
            每題:答案 + 依據(experiment id / MODEL_SPEC 章節 / acceptance test)+
            epistemic 標記。點開任一題;experiment id 可在第 17 章一鍵重播。
          </span>
        }
      >
        <div style={{ maxHeight: 520, overflowY: 'auto' }}>
          {QA_LIST.map((qa) => (
            <details key={qa.n} style={{ borderBottom: '1px solid var(--border)', padding: '6px 4px' }}>
              <summary style={{ cursor: 'pointer' }}>
                <strong>Q{qa.n}.</strong> {qa.q} <EpistemicTag kind={qa.tag} />
              </summary>
              <p style={{ margin: '8px 0 4px' }}>{qa.a}</p>
              <p style={{ margin: '0 0 4px', color: 'var(--fg-subtle)', fontSize: '0.9em' }}>
                依據:{qa.basis}
              </p>
            </details>
          ))}
        </div>
      </SectionFigure>

      <SectionFigure
        title="補充問答:DSM 使用模式與 reverse injection 的相容性(exp21/exp22)"
        caption={
          <span>
            actuator_mode(full / dsm_only,§7.1)、injection gating(§14)與 mash111
            加入 model 後的四個補充問題。量測值全部來自 golden model
            (512 cycles、seed 12345);exp21/exp22 可在第 17 章一鍵重播。
          </span>
        }
      >
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {DSM_QA.map((qa) => (
            <details key={qa.n} style={{ borderBottom: '1px solid var(--border)', padding: '6px 4px' }}>
              <summary style={{ cursor: 'pointer' }}>
                <strong>D{qa.n}.</strong> {qa.q} <EpistemicTag kind={qa.tag} />
              </summary>
              <p style={{ margin: '8px 0 4px' }}>{qa.a}</p>
              <p style={{ margin: '0 0 4px', color: 'var(--fg-subtle)', fontSize: '0.9em' }}>
                依據:{qa.basis}
              </p>
            </details>
          ))}
        </div>
      </SectionFigure>

      <SectionFigure
        title="結論 dashboard:六組 config 的 RMS 誤差"
        caption={
          <span>
            由 TS mirror 即時計算(id 對應 EXPERIMENTS)。三組 bar:rms e_FB_abs
            (單邊 absolute)、rms e_pair_digital(兩路相對)、rms e_ZC_hw
            (deterministic zero-crossing error)。單位 <UnitSwitch />。
            注意 exp10(latency bug)的 e_FB_abs/e_ZC_hw 遠超其他組;
            exp05(Mode B)是唯一 e_pair_digital 非零的組。
          </span>
        }
      >
        <EChart option={dashOption} height={320} group="ch20" />
        <DebugTable
          columns={[
            { key: 'id', label: 'id' },
            { key: 'config', label: 'config' },
            { key: 'rms_e_FB_abs_cyc', label: 'rms e_FB_abs (cyc)', fmt: fmt6 },
            { key: 'rms_e_pair_digital_cyc', label: 'rms e_pair_dig (cyc)', fmt: fmt6 },
            { key: 'rms_e_ZC_hw_cyc', label: 'rms e_ZC_hw (cyc)', fmt: fmt6 },
            { key: 'rms_e_FB_abs_deg', label: 'rms e_FB_abs (deg)', fmt: fmt6 },
            { key: 'rms_e_ZC_hw_fs', label: 'rms e_ZC_hw (fs)', fmt: fmt6 },
          ]}
          rows={dashRows}
          maxHeight={240}
          exportName="ch20_conclusion_metrics.csv"
        />
      </SectionFigure>

      <SectionCode language="typescript" title="節錄 1 — injectionScheduler.ts:mode D 與獨立量化的分水嶺" code={TS_MODE_D_EXCERPT} />
      <SectionCode language="typescript" title="節錄 2 — injectionDynamics.ts:lock 條件(Q14 的程式碼形式)" code={TS_LOCK_EXCERPT} />

      <SectionLineByLine
        items={[
          {
            code: "if (cfg.arch_mode === 'D') { rInj[k] = pymod(cfg.r_zero - rFb[k], g); }",
            explain:
              '整個推薦架構的核心只有這一行:injection code 由 feedback code 取模反相,' +
              '不經過第二個 quantizer。Q4/Q5 的答案在程式碼層面就是「D 分支沒有 state」。',
          },
          {
            code: 'const q = makeQuantizer(cfg.quantizer);  // A, B, C 分支',
            explain:
              '對照組:獨立 quantizer instance(獨立 error state)。Mode B 的 pair error ' +
              '非零(exp05/09)正是這個第二份 state 造成的 —— 架構差異即程式碼差異。',
          },
          {
            code: 'pymod(q.quantize(u), g)',
            explain:
              'pymod 實作 Python 式 mod(結果非負),確保兩語言 R_INJ 完全相等 ——' +
              'JS 的 % 對負數回傳負值,直接用會破壞 identity。',
          },
          {
            code: 'const a = (2.0 * Math.PI * deltaFHz) / fRefHz;',
            explain:
              'a = 2πΔf·T_ref:每個 reference period 因 detuning 累積的相位(rad)。' +
              'injection 每拍最多修 K_inj(sin 的峰值),故 lock 條件是 |a| ≤ K_inj。',
          },
          {
            code: 'return Math.asin(a / kInj);',
            explain:
              'stable fixed point θ_ss = asin(a/K_inj)(取 cos>0 的解):lock 之後的' +
              '靜態 phase offset —— Q16 中「固定 error → static offset」的來源之一。',
          },
          {
            code: 'rms(res.data.e_ZC_hw)',
            explain:
              'dashboard 的指標直接取自 model 的 measurements(§17);章節不自算統計量,' +
              '保證與 Python summary 相同定義。',
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>dashboard 中 <code>exp03/exp11/exp12/exp13</code> 的
            <strong>e_pair_digital 皆為 0</strong>(mode D identity);只有
            <code>exp05</code>(Mode B)非零 —— Q4 的直接證據。</li>
          <li><code>exp10</code>(latency bug)的 rms e_FB_abs ≈ 0.13 cycle(46.8°),
            比 <code>exp11</code>(look-ahead)大兩個數量級 —— Q9 的直接證據;
            兩者 config 只差一個 boolean。</li>
          <li><code>exp12/exp13</code> 的 e_pair_digital = 0 但 e_ZC_hw 非零
            (exp12:靜態 222.2 fs;exp13(N=3.13):rms 104.8 fs、峰值 205.9 fs,
            491/512 拍非零):shared code 消不掉 analog 誤差 —— Q5 的直接證據。</li>
          <li>把 n_cycles 從 512 調到 1024:各 rms 幾乎不變(誤差是 deterministic
            pattern,不是隨 N 收斂的隨機量)。</li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解:「e_pair ≡ 0,所以 mode D 之後就沒有誤差了」">
          <p>
            錯。mode D 消除的只是<strong>兩路的數位相對誤差</strong>。absolute
            quantization(±half-LSB)、tap/DTC/route mismatch、latency、VCO random
            noise 全部還在(Q5/Q6)。dashboard 裡 exp12/exp13 的 e_ZC_hw 就是證據:
            pair 為零,zero-crossing 誤差峰值照樣超過 half-LSB(exp12 靜態 222.2 fs、
            exp13 峰值 205.9 fs,皆 &gt; 156.25 fs)。
          </p>
        </Callout>
        <Callout type="warn" title="誤解:「模擬顯示可行,代表 silicon 可行」">
          <p>
            錯。本專案的數值結論建立在 behavioral 假設上(§10 的 mismatch 模型、
            §14 的 injection map、§15 的 energy proxy),且未經任何電路模擬器驗證
            (Q18)。可以外推的是 architecture 層的 exact identity;不可外推的是
            任何絕對數值(residual、spur 位準、lock range)。
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <p>推薦架構鏈(每一環附依據;這是全站 22 個 experiments 的總結,不是先驗信念):</p>
        <ol>
          {CHAIN.map((c) => (
            <li key={c.step} style={{ marginBottom: 4 }}>
              <strong>{c.step}</strong>
              <span style={{ color: 'var(--fg-subtle)' }}> — {c.why}</span>
            </li>
          ))}
        </ol>
        <p>
          <EpistemicTag kind="INFERENCE" /> 鏈中前四環是 exact digital(零 analog
          成本、identity 可測);後四環是工程權衡,依 mismatch 與 spur 需求逐案評估。
          任何一環要偏離,先用第 17 章的 experiment preset 重跑證據。
        </p>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty" title="已知限制(MODEL_SPEC §20 + §14 gating,逐條)">
          <ul>
            {HONESTY.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="Dashboard 參數">
        <Slider
          label="n_cycles"
          value={nCycles}
          min={128}
          max={1024}
          step={128}
          onChange={setNCycles}
        />
      </ParamPanel>
    </ChapterShell>
  );
}
