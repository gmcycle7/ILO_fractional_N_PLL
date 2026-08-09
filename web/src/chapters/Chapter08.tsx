/**
 * Chapter 8 — Shared Phase State 共享相位狀態
 *
 * MODEL_SPEC.md §7:四種架構 mode A/B/C/D 全比較,Mode D identity
 * (R_FB + R_INJ) mod 256 = R_zero 的證明,e_pair 定義,
 * 互動圖 #14(pair error)+ #13(absolute error)對照,cycle 表。
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
import DebugTable from '../components/DebugTable';
import { makeLineOption, makeMarkLine } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { formatPhase, phaseAxisLabel, makePhaseTickFormatter, trimNumber } from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  simulate,
  fromPartial,
  summary,
  pymod,
  type ArchMode,
  type Quantizer,
} from '../model';

const meta = chapterById(8)!;

const N_SIM = 256;
const LSB_CYC = 1 / 256;
const HALF_LSB_CYC = 1 / 512;

function toXY(a: ArrayLike<number>): [number, number][] {
  return Array.from(a as ArrayLike<number>, (v, i) => [i, v] as [number, number]);
}

function withMarkLine(
  option: ReturnType<typeof makeLineOption>,
  idx: number,
  ml: Record<string, unknown>,
): ReturnType<typeof makeLineOption> {
  const s = (option as unknown as { series?: Record<string, unknown>[] }).series;
  if (s && s[idx]) s[idx].markLine = ml;
  return option;
}

const MODE_OPTIONS: { value: ArchMode; label: string }[] = [
  { value: 'A', label: 'A — independent quantization' },
  { value: 'B', label: 'B — independent DSMs(不建議)' },
  { value: 'C', label: 'C — shared state, 各自 quantize' },
  { value: 'D', label: 'D — quantize once + modular reverse' },
];

const QUANTIZER_OPTIONS: { value: Quantizer; label: string }[] = [
  { value: 'nearest', label: 'nearest' },
  { value: 'floor', label: 'floor' },
  { value: 'truncate', label: 'truncate' },
  { value: 'ef1', label: 'ef1 (DSM)' },
  { value: 'mash11', label: 'mash11 (DSM)' },
];

export default function Chapter08() {
  const [mode, setMode] = useState<ArchMode>('B');
  const [quantizer, setQuantizer] = useState<Quantizer>('ef1');
  const [alpha, setAlpha] = useChapterAlpha();
  const [tapMm, setTapMm] = useState(false);
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const res = useMemo(() => {
    const mm = Array.from({ length: 8 }, () => (tapMm ? 1 / 360 : 0));
    return simulate(
      fromPartial({
        n_div: 3 + alpha,
        n_cycles: N_SIM,
        arch_mode: mode,
        quantizer,
        tap_mismatch_cycles: mm,
      }),
    );
  }, [mode, quantizer, alpha, tapMm]);

  const stats = useMemo(() => summary(res), [res]);

  useEffect(() => {
    setStatus('done', `Ch8: Mode ${mode} · ${quantizer} · ${N_SIM} cycles`);
  }, [res, mode, quantizer, setStatus]);

  const tVco = res.t_vco_s;

  const pairOption = useMemo(() => {
    const opt = makeLineOption({
      title: `#14 pair error — Mode ${mode} / ${quantizer}`,
      xLabel: 'k (reference cycle)',
      yLabel: phaseAxisLabel('e_pair', unit, tVco),
      yTickFormatter: makePhaseTickFormatter(unit, tVco),
      series: [
        {
          name: 'e_pair_digital',
          data: toXY(res.data.e_pair_digital),
          color: ct.accent,
          step: 'middle',
          showSymbol: true,
          symbolSize: 3,
          width: 1.6,
        },
        {
          name: 'e_pair_analog',
          data: toXY(res.data.e_pair_analog),
          color: ct.warn,
          step: 'middle',
          dashed: true,
          width: 1.1,
        },
      ],
    });
    return withMarkLine(
      opt,
      0,
      makeMarkLine([
        { y: LSB_CYC, label: '+1 LSB' },
        { y: -LSB_CYC, label: '-1 LSB' },
      ]),
    );
  }, [res, mode, quantizer, unit, tVco, ct]);

  const absOption = useMemo(() => {
    const opt = makeLineOption({
      title: '#13 absolute error(對照:兩邊各自 vs ideal)',
      xLabel: 'k (reference cycle)',
      yLabel: phaseAxisLabel('e_abs', unit, tVco),
      yTickFormatter: makePhaseTickFormatter(unit, tVco),
      series: [
        {
          name: 'e_FB_abs',
          data: toXY(res.data.e_FB_abs),
          color: ct.series[2],
          step: 'middle',
          width: 1.3,
        },
        {
          name: 'e_INJ_abs',
          data: toXY(res.data.e_INJ_abs),
          color: ct.series[3],
          step: 'middle',
          width: 1.3,
        },
      ],
    });
    return withMarkLine(
      opt,
      0,
      makeMarkLine([
        { y: HALF_LSB_CYC, label: '+half-LSB' },
        { y: -HALF_LSB_CYC, label: '-half-LSB' },
      ]),
    );
  }, [res, unit, tVco, ct]);

  const tableRows = useMemo(() => {
    const d = res.data;
    return Array.from({ length: 16 }, (_, i) => ({
      k: i,
      R_FB: d.R_FB[i],
      R_INJ: d.R_INJ[i],
      sum_mod_256: pymod(d.R_FB[i] + d.R_INJ[i], 256),
      e_pair_digital: d.e_pair_digital[i],
      e_FB_abs: d.e_FB_abs[i],
    }));
  }, [res]);

  const fmt6 = (v: unknown) => trimNumber(v as number, 6);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>feedback 與 injection 兩條路徑的 code 可以各自產生嗎?四種架構 mode A/B/C/D 差在哪裡?</li>
          <li>
            Mode D 的 identity <M>{'(R_{FB} + R_{INJ}) \\bmod 256 = R_{zero}'}</M> 如何證明?為什麼它對
            <strong>所有</strong> quantizer mode、<strong>所有</strong> k 都成立?
          </li>
          <li>pair error <M>{'e_{pair}'}</M> 與 absolute error <M>{'e_{abs}'}</M> 是不同的量 —— 差在哪?</li>
          <li>共享 final code 到底消除了什麼?又有哪些誤差它「原理上」不可能消除?</li>
          <li>為什麼 Mode B(兩邊各自跑 DSM)平均正確、卻 cycle-by-cycle 錯誤?</li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          Ch6 證明了幾何上 <M>{'x + u_{INJ}'}</M> 必須恆等於 <M>{'z_0'}</M>(mod 1)。問題是:
          數位實作裡「誰負責維持這個恆等式」?若 feedback 與 injection 各自拿一份 fractional
          trajectory 去 round(Mode A/B/C),兩個 quantizer 在同一拍可能往不同方向捨入 ——
          平均而言都對,但<strong>逐拍</strong>的 reverse 關係被打破,pair error 在 ±1 LSB 之間跳動。
          對 DSM 型 quantizer 特別嚴重:兩邊的 error state 各自演化,何時進位互不相關。
        </p>
        <p>
          Mode D 的做法像「同一根軸上的兩個齒輪」:只 quantize 一次得到 <M>{'R_{FB}'}</M>,injection
          code 用 modular 減法直接導出 <M>{'R_{INJ} = (R_{zero} - R_{FB}) \\bmod 256'}</M>。
          reverse 關係不再是「兩個近似值恰好互補」,而是<strong>代數恆等式</strong> ——
          數位層的 pair error 被建構性地釘在零,連捨入方向都不需要協調。
        </p>
        <p>
          但要誠實:這個恆等式只管「兩邊相對」。每一邊對 ideal 的 absolute quantization error
          仍在 ±half-LSB 內跳動,analog 的 tap/DTC/route 誤差也原封不動 —— 共享 code
          不是萬靈丹,它消除的是一個特定(且致命)的誤差類別。
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>
          <strong>四種 mode(MODEL_SPEC §7;feedback 一律 <M>{'A_{FB} = Q_{FB}(A_{ideal})'}</M>)。</strong>
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Mode</th>
                <th>injection code 來源</th>
                <th>phase state</th>
                <th>quantizer state</th>
                <th><M>{'e_{pair,digital}'}</M></th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>A</td>
                <td><M>{'R_{INJ} = Q_{INJ}(G\\, u_{INJ,ideal}) \\bmod G'}</M>,同型獨立 instance</td>
                <td>共享(同一 <M>{'x_{ideal}'}</M>)</td>
                <td>獨立</td>
                <td>nearest 幾乎 0;floor 恆 −1 LSB(例外:{'{a}'} = 0 的格點拍為 0,α = 0.13 時每 25 拍一次)</td>
              </tr>
              <tr>
                <td>B</td>
                <td>同 A,但兩邊都是 DSM 型(ef1/mash11)、獨立 state</td>
                <td>共享</td>
                <td>獨立(各自演化)</td>
                <td>非零、time-varying(ef1:{'{−1, 0, +1}'} LSB、約 64% 拍非零;mash11 至 ±3)→「不建議」</td>
              </tr>
              <tr>
                <td>C</td>
                <td>共享 master accumulator <M>{'P[k] = A_{ideal}[k]'}</M>,再各自 quantize</td>
                <td>共享(明確單一來源)</td>
                <td>獨立</td>
                <td>同 A(本模型中 code path 相同)</td>
              </tr>
              <tr>
                <td>D</td>
                <td><M>{'R_{INJ} = (R_{zero} - R_{FB}) \\bmod 256'}</M></td>
                <td>共享</td>
                <td><strong>單一</strong>(只 quantize 一次)</td>
                <td><strong>恆 0</strong>(identity)</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          <strong>pair error 的定義(digital 或 analog 層同式)。</strong>
          <EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {'e_{pair}[k] = \\operatorname{wrapCycles}\\big(u_{FB,actual}[k] + u_{INJ,actual}[k] - u_{zero}\\big), \\qquad u_{zero} = R_{zero}/G'}
        </MathBlock>
        <p>
          它與 <M>{'e_{abs} = \\text{actual} - \\text{ideal}'}</M>(§16)是不同的量:<M>{'e_{abs}'}</M>{' '}
          問「離理想多遠」,<M>{'e_{pair}'}</M> 問「兩邊加起來是否仍是整數圈 + <M>{'u_{zero}'}</M>」。
        </p>
        <p>
          <strong>Mode D identity 的證明。</strong>由定義{' '}
          <M>{'R_{INJ}[k] = (R_{zero} - R_{FB}[k]) \\bmod 256'}</M>:
        </p>
        <MathBlock>
          {'(R_{FB}[k] + R_{INJ}[k]) \\bmod 256 = \\big(R_{FB}[k] + R_{zero} - R_{FB}[k]\\big) \\bmod 256 = R_{zero}'}
        </MathBlock>
        <p>整數層更精確:兩個 code 都落在 <M>{'\\{0,\\dots,255\\}'}</M>,所以和只有兩種可能:</p>
        <MathBlock>
          {'R_{FB} + R_{INJ} \\in \\{R_{zero},\\; R_{zero} + 256\\}'}
        </MathBlock>
        <MathBlock>
          {'\\Rightarrow\\; u_{FB,digital} + u_{INJ,digital} - \\tfrac{R_{zero}}{256} = \\tfrac{R_{FB} + R_{INJ} - R_{zero}}{256} \\in \\{0, 1\\} \\;\\Rightarrow\\; e_{pair,digital}[k] = \\operatorname{wrapCycles}(0 \\text{ 或 } 1) = 0'}
        </MathBlock>
        <p>
          證明只用了 modular 代數,<strong>與 quantizer mode、α、k 無關</strong>:對 floor/nearest/
          ef1/mash11、任何 fractional 值、每一拍都成立。<EpistemicTag kind="EXACT" />
        </p>
        <p>
          <strong>獨立量化(Mode A/B/C)的 pair error。</strong>設兩個 quantizer 的瞬時誤差(LSB)為{' '}
          <M>{'\\varepsilon_{FB}, \\varepsilon_{INJ}'}</M>。因為理想值本身滿足{' '}
          <M>{'G x + G u_{INJ,ideal} \\equiv R_{zero} \\pmod G'}</M>(Ch6 的幾何恆等式):
        </p>
        <MathBlock>
          {'e_{pair,digital}[k] = \\operatorname{wrapCycles}\\Big(\\tfrac{\\varepsilon_{FB}[k] + \\varepsilon_{INJ}[k]}{G}\\Big)'}
        </MathBlock>
        <ul>
          <li>
            nearest:捨入對稱,<M>{'\\varepsilon_{INJ} = -\\varepsilon_{FB}'}</M>(除了恰為 0.5 LSB
            的 tie)→ pair ≈ 0。<EpistemicTag kind="EXACT" />
          </li>
          <li>
            floor(off-grid α):<M>{'\\varepsilon_{FB} + \\varepsilon_{INJ} = -\\{a\\} - (1 - \\{a\\}) = -1'}</M>{' '}
            → pair 為 −1 LSB,但僅限 <M>{'\\{a\\} \\neq 0'}</M> 的拍;<M>{'A_{ideal}'}</M>{' '}
            恰落格點時兩邊皆 exact → pair = 0(α = 0.13 時每 25 拍一次)。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            ef1 / mash11 獨立 state(injection 側由 'dsm_inj' stream 種出不同初始值,兩份 state
            真正各自演化):ef1 的 pair 在 <M>{'\\{-1, 0, +1\\}'}</M> LSB 間跳動,α = 0.13、256 拍
            下約 64% 的拍非零(−1 / 0 / +1 約各佔三分之一);mash11 更寬,可達 ±3 LSB(多為
            ±1,約 8% 的拍 |pair| ≥ 2)——Mode B 的問題。
            <EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
        <p>
          <strong>共享 final code 消除 / 不能消除的清單(§7)。</strong>
          <EpistemicTag kind="EXACT" />
        </p>
        <ul>
          <li>
            <strong>消除</strong>:feedback/injection 的<strong>數位相對 mismatch</strong>
            (兩個 quantizer 的捨入方向不一致、DSM state 漂移、tie-break 差異)—— 即{' '}
            <M>{'e_{pair,digital} \\equiv 0'}</M>。
          </li>
          <li>
            <strong>不能消除</strong>:absolute quantization error(±half-LSB,兩邊各自仍在)、
            DTC analog gain/INL/DNL、tap mismatch、route mismatch、latency error(§13)、
            VCO random noise(§5 第 2 類)。這些不是「相對」誤差,modular 恆等式管不到。
          </li>
        </ul>
      </SectionMath>

      <SectionExample>
        <p>
          <strong>N = 3.13、nearest、R<sub>zero</sub> = 0,手算 k = 1。</strong>
        </p>
        <ol>
          <li>
            <M>{'A_{ideal}[1] = 256 \\times 3.13 = 801.28'}</M> →{' '}
            <M>{'A_{FB} = \\lfloor 801.28 + 0.5 \\rfloor = 801'}</M>,{' '}
            <M>{'R_{FB} = 801 \\bmod 256 = 33'}</M>。
          </li>
          <li>
            <M>{'R_{INJ} = (0 - 33) \\bmod 256 = 223'}</M>。
          </li>
          <li>
            檢查 identity:<M>{'33 + 223 = 256 \\equiv 0 = R_{zero} \\pmod{256}'}</M>。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            pair error:<M>{'u_{FB} = 33/256 = 0.12890625'}</M>,<M>{'u_{INJ} = 223/256 = 0.87109375'}</M>,
            和 = 1.0 → <M>{'e_{pair} = \\operatorname{wrapCycles}(1.0) = 0'}</M>。
          </li>
          <li>
            但 absolute error 沒有消失:<M>{'e_{FB,abs} = (801 - 801.28)/256 = -0.00109375'}</M> cycle
            (= −0.28 LSB = {formatPhase(-0.00109375, unit, tVco)}),
            <M>{'e_{INJ,abs} = +0.00109375'}</M> cycle —— 兩邊等量反號,pair 相消,absolute 仍在。
            <EpistemicTag kind="EXACT" />
          </li>
        </ol>
        <p>
          下方 cycle 表(DebugTable)由 model 對每一拍重算同樣的驗證,sum_mod_256 欄在 Mode D
          下恆為 0。
        </p>
      </SectionExample>

      <SectionFigure
        title="#14 pair error + #13 absolute error:mode A/B/C/D 即時切換"
        caption={
          <span>
            上圖:<M>{'e_{pair,digital}'}</M>(實線)與 <M>{'e_{pair,analog}'}</M>(虛線;開啟 tap
            mismatch 後兩者分離)。下圖:同一次模擬的 <M>{'e_{FB,abs}'}</M> 與 <M>{'e_{INJ,abs}'}</M>{' '}
            對照 —— 切 mode 時上圖劇變、下圖的 e_FB_abs 完全不動。參考線:±1 LSB(上)、
            ±half-LSB(下)。兩圖 x 軸連動;單位:<UnitSwitch />
          </span>
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 8, fontSize: '0.9rem' }}>
          <span>
            e_pair_digital:RMS = <strong>{formatPhase(stats.e_pair_digital.rms_cycles, unit, tVco)}</strong>
            ,p2p = <strong>{formatPhase(stats.e_pair_digital.p2p_cycles, unit, tVco)}</strong>
          </span>
          <span>
            e_pair_analog:RMS = <strong>{formatPhase(stats.e_pair_analog.rms_cycles, unit, tVco)}</strong>
          </span>
          <span>
            e_FB_abs:RMS = <strong>{formatPhase(stats.e_FB_abs.rms_cycles, unit, tVco)}</strong>
          </span>
        </div>
        <EChart option={pairOption} height={280} group="ch8" />
        <EChart option={absOption} height={280} group="ch8" />
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model/injectionScheduler.ts(真實節錄:mode 分支與 e_pair)"
        code={`// --- R_INJ per architecture mode ---
const rInj = new Float64Array(n);
if (cfg.arch_mode === 'D') {
  for (let k = 0; k < n; k++) {
    rInj[k] = pymod(cfg.r_zero - rFb[k], g);
  }
} else {
  // A, B, C: independent quantizer instance on G * u_INJ_ideal
  const q = makeQuantizer(cfg.quantizer);
  // distinct deterministic DSM state per spec section 7 ('dsm_inj' stream)
  if (dsmStream !== null) {
    if (cfg.quantizer === 'ef1') {
      (q as ErrorFeedbackFirstOrder).seedState(dsmStream.next());
    } else if (cfg.quantizer === 'mash11') {
      const acc1 = dsmStream.next();
      const acc2 = dsmStream.next();
      (q as Mash11).seedState(acc1, acc2);
    }
  }
  const useDither = cfg.dither_amp_lsb > 0.0 && ditherStream !== null;
  for (let k = 0; k < n; k++) {
    let u = g * uIdeal[k];
    if (useDither && ditherStream !== null) {
      u += cfg.dither_amp_lsb * (ditherStream.next() + ditherStream.next() - 1.0);
    }
    rInj[k] = pymod(q.quantize(u), g);
  }
}

// e_pair = wrapCycles(u_FB_actual + u_INJ_actual - u_zero_offset)
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
          model 檔頭註明:Mode B 與 A 的 code path 相同(差別是「意圖」—— B 的 cfg.quantizer 應設
          ef1/mash11);Mode C 的共享 state 在本模型中即 <M>{'A_{ideal}'}</M> 本身,故與 A 數值一致。
          真正的分水嶺是「獨立 quantize(A/B/C)」vs「quantize 一次 + modular reverse(D)」。
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: "if (cfg.arch_mode === 'D') { rInj[k] = pymod(cfg.r_zero - rFb[k], g); }",
            explain: (
              <span>
                Mode D 的全部:一行 modular 減法。沒有第二個 quantizer、沒有第二份 state ——
                identity 是建構出來的,不是調出來的。<code>pymod</code> 保證負數也映到{' '}
                <M>{'\\{0..255\\}'}</M>(JS 的 % 對負數行為不同,故不用)。
              </span>
            ),
          },
          {
            code: 'const q = makeQuantizer(cfg.quantizer);',
            explain: (
              <span>
                A/B/C 分支:替 injection <strong>另開一個</strong> quantizer instance。對 stateless 的
                floor/nearest 這只是重複計算;對 ef1/mash11 這是<strong>第二份獨立演化的 error
                state</strong>(以 'dsm_inj' PRNG stream 種出與 feedback 側不同的初始值,§7、§12)
                —— Mode B pair error 的根源。
              </span>
            ),
          },
          {
            code: 'rInj[k] = pymod(q.quantize(u), g);',
            explain: (
              <span>
                獨立路徑對 <M>{'G \\cdot u_{INJ,ideal}'}</M> 量化。注意輸入是 fractional(非
                absolute code),與 feedback 對 <M>{'A_{ideal}'}</M> 量化的資訊相同(Ch6 恆等式),
                錯的不是 phase state,而是<strong>捨入決策不同步</strong>。
              </span>
            ),
          },
          {
            code: 'tmp[k] = uFb[k] + uInj[k] - rZero / g;',
            explain: (
              <span>
                §7 的 <M>{'e_{pair}'}</M> 公式逐字實作;同一函式餵 digital(<M>{'R/G'}</M>)或
                analog(tap+DTC+route)值即得 <code>e_pair_digital</code> / <code>e_pair_analog</code>。
              </span>
            ),
          },
          {
            code: 'return wrapCyclesArr(tmp);',
            explain: (
              <span>
                wrap 到 <M>{'(-\\tfrac12, \\tfrac12]'}</M>:整數圈(0 或 1)歸零 —— 這一步把
                「<M>{'R_{FB}+R_{INJ}'}</M> 是 <M>{'R_{zero}'}</M> 或 <M>{'R_{zero}+256'}</M>」
                兩種情形都映成 pair error = 0。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            <strong>預設(Mode B、ef1)</strong>:上圖 e_pair_digital 在 −1 / 0 / +1 LSB 之間
            不規則跳動 —— 256 拍中約 64% 非零,−1 / 0 / +1 約各佔三分之一,兩個獨立 DSM 的
            進位時刻互不相關。這就是「平均正確、cycle-by-cycle 錯誤」。切到 mash11 跳動範圍
            擴到 ±3 LSB(多為 ±1)。
          </li>
          <li>
            <strong>切到 Mode D(任何 quantizer)</strong>:e_pair_digital 變成一條精確為 0 的直線
            <EpistemicTag kind="EXACT" /> —— 不是「很小」,是逐位為零(cycle 表 sum_mod_256 全 0)。
          </li>
          <li>
            <strong>Mode A + floor</strong>:pair error 為 −1 LSB(§Math 的{' '}
            <M>{'-\\{a\\}-(1-\\{a\\})=-1'}</M>),唯一例外是 <M>{'A_{ideal}'}</M> 恰落格點的拍
            (α = 0.13 時每 25 拍一次,該拍 pair = 0,256 拍中 11 次);
            <strong>Mode A + nearest</strong>:幾乎恆 0
            (對稱捨入)—— 獨立量化不見得炸,但取決於 quantizer 的對稱性,是脆弱的巧合而非保證。
          </li>
          <li>
            <strong>下圖對照</strong>:切 mode 時 e_FB_abs 完全不變(feedback 路徑相同),
            e_INJ_abs 在 D 下與 e_FB_abs 鏡像(等量反號)、在 B 下獨立跳動。pair 的改善不是靠
            把任一邊變準,而是靠<strong>相關性</strong>。
          </li>
          <li>
            <strong>開 1° tap mismatch(Mode D)</strong>:e_pair_digital 仍恆 0,但 e_pair_analog
            出現非零圖樣 —— 共享 code 管不到 analog 層,這是「不能消除」清單的直接示範。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解一:「Mode D 讓量化誤差消失」">
          <p>
            錯。Mode D 消除的是<strong>兩邊的相對</strong>數位誤差(<M>{'e_{pair,digital} \\equiv 0'}</M>);
            每一邊對 ideal 的 absolute error 仍是 ±half-LSB(上例的 ∓0.28 LSB)。VCO 追蹤的是
            quantized common trajectory —— shared code 不會創造不存在的 sub-LSB analog delay
            (§9,Ch10 詳談)。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解二:「pair error 為零 = injection 落在理想 zero crossing」">
          <p>
            錯。<M>{'e_{pair}'}</M>、<M>{'e_{abs}'}</M>、<M>{'e_{ZC}'}</M> 是三個不可混淆的量(§16)。
            Mode D 下 <M>{'e_{ZC,hw}'}</M> 仍含 absolute quantization、tap/DTC mismatch、latency;
            VCO random noise 更完全在數位掌控之外。pair = 0 只保證「兩條路徑用同一份真相」。
            <EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>
            <strong>quantize once, derive the other side</strong>:injection code 用 modular reverse
            從 final feedback code 導出(Mode D),讓 reverse 關係成為代數恆等式而非兩個近似值的
            巧合。identity 對所有 quantizer、所有 k 成立,零額外硬體。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            <M>{'e_{pair,digital}'}</M> 是免費的 built-in assertion:Mode D 實作中它必須逐位為零,
            模擬或 silicon bring-up 時任何非零值都直接指向實作 bug(state 不同步、latency 不齊、
            mod 運算錯誤)。<EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            兩邊各自跑 DSM(Mode B)「不建議」:它把一個本可為零的誤差類別重新引入,且頻譜上是
            難以濾除的寬帶跳動(Ch16)。若要 DSM 的 noise-shaping,在共享的 final code{' '}
            <strong>之前</strong>做一次(單一 instance),而不是兩邊各做一次。
            <EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            校正預算應花在 shared code 管不到的項目:tap/DTC/route mismatch(Ch7、Ch15)與
            latency(Ch12)。<EpistemicTag kind="INFERENCE" />
          </li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            <M>{'e_{pair,digital} \\equiv 0'}</M> 是 digital mapping 的性質(EXACT),但本模型中
            Mode A 與 C 走同一條 code path(C 的「共享 accumulator」在此已隱含於單一{' '}
            <M>{'A_{ideal}'}</M> 來源)—— 實際硬體若兩路徑各有 accumulator,C 與 A 的差異會更大。
            兩個 DTC code 假設在同一拍原子性地生效(共用 §13 latency pipeline);analog
            非理想為 behavioral 模型(§10)。行為級結果不等同 silicon(§20)。
          </p>
        </Callout>
      </SectionLimitation>

      <DebugTable
        columns={[
          { key: 'k', label: 'k' },
          { key: 'R_FB', label: 'R_FB' },
          { key: 'R_INJ', label: 'R_INJ' },
          { key: 'sum_mod_256', label: '(R_FB+R_INJ) mod 256' },
          { key: 'e_pair_digital', label: 'e_pair_digital (cyc)', fmt: fmt6 },
          { key: 'e_FB_abs', label: 'e_FB_abs (cyc)', fmt: fmt6 },
        ]}
        rows={tableRows}
        exportName="ch8_shared_state.csv"
      />

      <ParamPanel title="Ch8 參數">
        <SelectControl<ArchMode>
          label="Architecture mode"
          value={mode}
          options={MODE_OPTIONS}
          onChange={setMode}
        />
        <SelectControl<Quantizer>
          label="Quantizer"
          value={quantizer}
          options={QUANTIZER_OPTIONS}
          onChange={setQuantizer}
        />
        <PresetButtons
          label="情境 preset"
          presets={[
            {
              label: 'Mode B · ef1(問題)',
              onClick: () => {
                setMode('B');
                setQuantizer('ef1');
              },
            },
            {
              label: 'Mode D · ef1(修復)',
              onClick: () => {
                setMode('D');
                setQuantizer('ef1');
              },
            },
            {
              label: 'Mode A · floor(−1 LSB)',
              onClick: () => {
                setMode('A');
                setQuantizer('floor');
              },
            },
            {
              label: 'Mode A · nearest(對稱)',
              onClick: () => {
                setMode('A');
                setQuantizer('nearest');
              },
            },
          ]}
        />
        <Slider
          label="α (fractional)"
          value={alpha}
          min={0}
          max={0.25}
          step={0.0005}
          onChange={setAlpha}
        />
        <PresetButtons
          label="Preset N"
          presets={[3.0, 3.125, 3.13, 3.1375, 3.25].map((n) => ({
            label: n.toFixed(4),
            onClick: () => setAlpha(Number((n - 3).toFixed(4))),
          }))}
        />
        <Toggle label="1° tap mismatch(全部 taps)" checked={tapMm} onChange={setTapMm} />
      </ParamPanel>
    </ChapterShell>
  );
}
