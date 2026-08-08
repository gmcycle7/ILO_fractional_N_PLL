/**
 * Chapter 9 — Why DSM Output Alone Is Insufficient 為何只看 DSM 輸出不夠
 *
 * Content contract: CHAPTER_GUIDE.md Ch9; math contract: MODEL_SPEC.md
 * sections 3, 4, 5, 7 (q_N vs accumulated p, z-domain accumulation,
 * N=3.13 concrete example, figures 19/20, experiment 20 comparison).
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
import { M, MathBlock } from '../components/Math';
import { ParamPanel, Slider, SelectControl, PresetButtons } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import DebugTable from '../components/DebugTable';
import { makeLineOption } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { phaseAxisLabel, makePhaseTickFormatter, trimNumber, formatPhase } from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  simulate,
  fromPartial,
  replaceConfig,
  getPreset,
  presetConfigs,
  rms,
  peakToPeak,
} from '../model';
import type { Quantizer, SimResult } from '../model';

const meta = chapterById(9)!;
const N_CYCLES = 256;

/** y-array -> [k, y] pairs for ECharts (packaging only, no math). */
function toXY(ys: ArrayLike<number>, count?: number): [number, number][] {
  const n = count === undefined ? ys.length : Math.min(count, ys.length);
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    out.push([k, ys[k]]);
  }
  return out;
}

const QUANT_OPTIONS: { value: Quantizer; label: string }[] = [
  { value: 'nearest', label: 'nearest(half-up)' },
  { value: 'floor', label: 'floor' },
  { value: 'truncate', label: 'truncate' },
  { value: 'ef1', label: 'ef1(1st-order DSM)' },
  { value: 'mash11', label: 'mash11(MASH 1-1)' },
];

export default function Chapter09() {
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();
  const [nDiv, setNDiv] = useState(3.13);
  const [quant, setQuant] = useState<Quantizer>('ef1');

  // 主模擬:mode D(預設),quantizer 可切換
  const sim: SimResult = useMemo(
    () => simulate(fromPartial({ n_div: nDiv, quantizer: quant, n_cycles: N_CYCLES })),
    [nDiv, quant],
  );

  // experiment 20:mode D(accumulated/shared)vs mode A(bit-stream 視角)
  const exp20 = useMemo(() => {
    const preset = getPreset('exp20');
    return presetConfigs(preset).map((c) => simulate(replaceConfig(c, { n_cycles: N_CYCLES })));
  }, []);

  useEffect(() => {
    setStatus('done', `${N_CYCLES} cycles × 3 configs`);
  }, [sim, exp20, setStatus]);

  const tVco = sim.t_vco_s;
  const tVco20 = exp20[0].t_vco_s;

  // p[k+1] = p[k] + N − n[k](CHAPTER_GUIDE 指定的累積式;恆等於 s_ideal − I_FB)
  const derived = useMemo(() => {
    const d = sim.data;
    const n = d.k.length;
    const p = new Float64Array(n);
    p[0] = d.s_ideal[0] - d.I_FB[0];
    for (let i = 0; i < n - 1; i++) {
      p[i + 1] = p[i] + nDiv - d.n_int[i];
    }
    const qN = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      qN[i] = nDiv - d.n_int[i];
    }
    return { p, qN };
  }, [sim, nDiv]);

  // 圖 #19:DSM internal state
  const optState = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: 'dsm_state (LSB)',
        series: [
          {
            name: 'dsm_state',
            data: toXY(sim.data.dsm_state),
            step: 'middle',
            showSymbol: false,
            color: ct.accent,
          },
        ],
        yMin: -0.1,
        yMax: 1.1,
      }),
    [sim, ct],
  );

  // 圖 #20:DSM 瞬時輸出 q_N vs 累積相位 p
  const optQvsP = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: phaseAxisLabel('phase', unit, tVco),
        yTickFormatter: makePhaseTickFormatter(unit, tVco),
        series: [
          {
            name: 'q_N[k] = N − n[k](瞬時)',
            data: toXY(derived.qN),
            step: 'middle',
            showSymbol: false,
            color: ct.warn,
          },
          {
            name: 'p[k](累積)',
            data: toXY(derived.p),
            showSymbol: false,
            color: ct.accent,
            width: 2,
          },
          {
            name: 'x_ideal[k]',
            data: toXY(sim.data.x_ideal),
            showSymbol: false,
            dashed: true,
            color: ct.good,
          },
        ],
      }),
    [derived, sim, unit, tVco, ct],
  );

  // experiment 20 對照:e_pair_digital(mode A vs mode D)
  const optExp20 = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: phaseAxisLabel('e_pair_digital', unit, tVco20),
        yTickFormatter: makePhaseTickFormatter(unit, tVco20),
        series: [
          {
            name: 'mode A(只看 bit,獨立 ef1)',
            data: toXY(exp20[1].data.e_pair_digital),
            step: 'middle',
            showSymbol: false,
            color: ct.bad,
          },
          {
            name: 'mode D(累積 state,modular reverse)',
            data: toXY(exp20[0].data.e_pair_digital),
            step: 'middle',
            showSymbol: false,
            color: ct.good,
            width: 2.2,
          },
        ],
      }),
    [exp20, unit, tVco20, ct],
  );

  const exp20Stats = useMemo(
    () => ({
      rmsD: rms(exp20[0].data.e_pair_digital),
      rmsA: rms(exp20[1].data.e_pair_digital),
      p2pA: peakToPeak(exp20[1].data.e_pair_digital),
    }),
    [exp20],
  );

  const tableRows = useMemo(() => {
    const d = sim.data;
    const m = Math.min(16, d.k.length);
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < m; i++) {
      rows.push({
        k: d.k[i],
        n_int: d.n_int[i],
        q_N: derived.qN[i],
        p: derived.p[i],
        x_ideal: d.x_ideal[i],
        u_INJ_ideal: d.u_INJ_ideal[i],
        R_FB: d.R_FB[i],
        R_INJ: d.R_INJ[i],
      });
    }
    return rows;
  }, [sim, derived]);

  const fmt6 = (v: unknown) => trimNumber(Number(v), 6);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            DSM / 除頻器的瞬時輸出 <M>{'n[k]'}</M>(/3 或 /4)與 VCO 的 fractional phase
            之間是什麼關係?為什麼一個是 frequency-like 量、一個是累積量?
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            兩個 reference cycle 的 DSM 輸出同樣是 /3,injection 需要的 phase
            會一樣嗎?(答案:不一樣 — 本章用 N=3.13 指出具體的 k。)
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            z-domain 上「輸出 bit → phase」的積分關係{' '}
            <M>{'P(z) = \\frac{z^{-1}}{1-z^{-1}}\\,(N(z)-N_{\\mathrm{div}}(z))'}</M>{' '}
            怎麼推導?
          </li>
          <li>
            如果 injection scheduler「只看 bit」用獨立 state 重新量化,會失去什麼?
            (experiment 20:pair error 不再恆為零。)<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            正確做法應該拉哪一個訊號?master accumulator state、accumulated
            quantization error、還是 final common code?<EpistemicTag kind="INFERENCE" />
          </li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          把 VCO 想成一個每拍相對 reference 多轉 <M>{'\\alpha'}</M> 圈的輪子(Ch3 的
          phase wheel)。除頻器每拍回報的 <M>{'n[k]\\in\\{3,4\\}'}</M> 只說「這一拍我
          跳過了 3 或 4 個 VCO cycle」— 它是<b>轉速</b>的資訊。而 injection pulse
          要對準的是輪子<b>現在指到哪裡</b>(fractional phase <M>{'x[k]'}</M>)—
          這是把每拍的轉速差一路加總起來的<b>位置</b>資訊。
        </p>
        <p>
          位置 = 轉速的積分。丟掉累積器、只留最後一顆 bit,就像只知道汽車「這一秒
          有沒有踩油門」,卻想回答「車現在開到哪裡」。N=3.13 時連續七拍輸出都是
          /3(見下方數值例),這七拍之間 VCO 的 fractional phase 卻從 0.13 一路走到
          0.91 — 同樣的 bit,完全不同的注入位置。<EpistemicTag kind="EXACT" />
        </p>
        <p>
          所以「把 DSM 輸出 bit 直接接給 injection scheduler」在架構上就問錯了問題:
          bit 流是 <M>{'x[k]'}</M> 的<b>差分</b>編碼,要用它重建注入相位必須先積分回
          accumulator state — 而這個 state 系統裡本來就有(master accumulator),
          直接共享即可,不需要也不應該在 injection 端重建。
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>
          依 MODEL_SPEC §3–§4 的符號:absolute coordinate <M>{'s_{ideal}[k]=s_0+kN'}</M>,
          量化後 <M>{'A_{FB}[k]=Q_{FB}(G\\,s_{ideal}[k])'}</M>(G=256),integer cycle
          index <M>{'I_{FB}[k]=\\lfloor A_{FB}[k]/G\\rfloor'}</M>。除頻器的瞬時 command
          由 absolute code 的差分導出:
        </p>
        <MathBlock>{'n[k] \\;=\\; I_{FB}[k+1]-I_{FB}[k] \\;\\in\\;\\{3,4\\}'}</MathBlock>
        <p>
          定義瞬時 fractional 殘量(DSM 輸出當拍所帶的全部資訊):
          <EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>{'q_N[k] \\;=\\; N-n[k]'}</MathBlock>
        <p>
          <M>{'q_N[k]'}</M> 是 <b>frequency-like 瞬時量</b>:N=3.13 時它只在{' '}
          <M>{'\\alpha=0.13'}</M> 與 <M>{'\\alpha-1=-0.87'}</M> 兩值之間跳動。phase
          是它的<b>累積</b>:<EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>{'p[k+1] \\;=\\; p[k] + N - n[k],\\qquad p[0]=s_0-I_{FB}[0]'}</MathBlock>
        <p>
          z-domain 寫法(<M>{'N_{\\mathrm{div}}(z)'}</M> 為序列 <M>{'n[k]'}</M> 的
          變換):一階 accumulator 就是 <M>{'z^{-1}/(1-z^{-1})'}</M> 積分器,
        </p>
        <MathBlock>
          {'P(z) \\;=\\; \\frac{z^{-1}}{1-z^{-1}}\\,\\bigl(N(z)-N_{\\mathrm{div}}(z)\\bigr)'}
        </MathBlock>
        <p>
          把遞迴展開(telescoping sum)得閉式恆等式:<EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {'p[k] \\;=\\; s_0+kN-\\sum_{j<k} n[j] \\;=\\; s_{ideal}[k]-I_{FB}[k]'}
        </MathBlock>
        <p>
          亦即 <M>{'p[k]'}</M> 正是 accumulator 保存、bit 流本身不含的 fractional
          state;無量化時 <M>{'p[k]=x_{ideal}[k]'}</M>,nearest quantizer 下兩者差距
          被 half-LSB 限制。而 injection 需要的 command(MODEL_SPEC §5.2)是:
          <EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {'u_{INJ,ideal}[k] \\;=\\; \\operatorname{wrap01}(z_0 - x_{nominal}[k])'}
        </MathBlock>
        <p>
          它是 <M>{'x'}</M>(累積量)的函數,<b>不是</b> <M>{'q_N'}</M>(瞬時量)的
          函數。只由當拍 <M>{'n[k]'}</M> 出發的任何映射都不可能重建{' '}
          <M>{'u_{INJ,ideal}'}</M>:同一個 bit 值對應無窮多個 phase state。
          <EpistemicTag kind="EXACT" />
        </p>
      </SectionMath>

      <SectionExample>
        <p>
          N = 3.13、quantizer = nearest、<M>{'s_0=0'}</M>(手算可驗;把右側面板的
          quantizer 切到 nearest,即可與圖 #20 下方 DebugTable 逐格對照)。
          <M>{'x_{ideal}'}</M> 序列為 0, 0.13, 0.26, 0.39, 0.52, 0.65, 0.78, 0.91,
          0.04, …(MODEL_SPEC §3)。<M>{'A_{FB}=\\lfloor 256\\,s_{ideal}+0.5\\rfloor'}</M>:
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>k</th>
                <th>x_ideal</th>
                <th>n[k]</th>
                <th>q_N[k]</th>
                <th>p[k]</th>
                <th>R_FB</th>
                <th>u_INJ_ideal</th>
                <th>R_INJ</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>0</td><td>0.00</td><td>3</td><td>+0.13</td><td>0.00</td>
                <td>0</td><td>0.00</td><td>0</td>
              </tr>
              <tr style={{ fontWeight: 600 }}>
                <td>1</td><td>0.13</td><td>3</td><td>+0.13</td><td>0.13</td>
                <td>33</td><td>0.87</td><td>223</td>
              </tr>
              <tr>
                <td>2</td><td>0.26</td><td>3</td><td>+0.13</td><td>0.26</td>
                <td>67</td><td>0.74</td><td>189</td>
              </tr>
              <tr>
                <td>3</td><td>0.39</td><td>3</td><td>+0.13</td><td>0.39</td>
                <td>100</td><td>0.61</td><td>156</td>
              </tr>
              <tr style={{ fontWeight: 600 }}>
                <td>4</td><td>0.52</td><td>3</td><td>+0.13</td><td>0.52</td>
                <td>133</td><td>0.48</td><td>123</td>
              </tr>
              <tr>
                <td>7</td><td>0.91</td><td>4</td><td>−0.87</td><td>0.91</td>
                <td>233</td><td>0.09</td><td>23</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          <b>關鍵對照:k=1 與 k=4</b>(粗體)。兩拍的 DSM / 除頻輸出<b>同為 /3</b>,
          <M>{'q_N'}</M> 同為 +0.13;但 accumulator state 不同:<M>{'p[1]=0.13'}</M>{' '}
          vs <M>{'p[4]=0.52'}</M>。所需 injection phase 因此不同:
          <M>{'u_{INJ,ideal}[1]=\\operatorname{wrap01}(-0.13)=0.87'}</M>(code 223)vs{' '}
          <M>{'u_{INJ,ideal}[4]=\\operatorname{wrap01}(-0.52)=0.48'}</M>(code 123)—
          相差 0.39 cycle = 140.4°。只看 bit 無法區分這兩拍。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>目前顯示單位下,0.39 cycle = {formatPhase(0.39, unit, tVco)}。</p>
      </SectionExample>

      <SectionFigure
        title="圖 #19 — DSM internal state:dsm_state[k]"
        caption={
          <span>
            x 軸:reference cycle k(sample rate = f_ref,MODEL_SPEC §17);y 軸:
            quantizer 內部 state(單位 LSB;ef1 為 error-feedback 殘量 e ∈ [0,1),
            mash11 為第一級 accumulator acc1)。nearest / floor / truncate 為
            memoryless,state 恆為 0 — 用右側面板切換 quantizer 觀察差異。這個 state
            就是「accumulated quantization error」:丟掉它,就丟掉了 sub-LSB 的累積
            資訊。
          </span>
        }
      >
        <EChart option={optState} height={280} group="ch9-k" />
      </SectionFigure>

      <SectionFigure
        title="圖 #20 — DSM 瞬時輸出 q_N[k] vs 累積相位 p[k]"
        caption={
          <span>
            橘色階梯:<M>{'q_N[k]=N-n[k]'}</M>(N=3.13 時只有 +0.13 / −0.87 兩值,
            frequency-like);藍色:累積 <M>{'p[k+1]=p[k]+N-n[k]'}</M>;綠色虛線:
            <M>{'x_{ideal}[k]'}</M> — 與 p 幾乎重合(nearest 下差 ≤ half-LSB,本尺度
            不可分辨),證明 p 重建的正是 fractional phase。單位:<UnitSwitch />
          </span>
        }
      >
        <EChart option={optQvsP} height={320} group="ch9-k" />
        <DebugTable
          columns={[
            { key: 'k', label: 'k' },
            { key: 'n_int', label: 'n[k]' },
            { key: 'q_N', label: 'q_N', fmt: fmt6 },
            { key: 'p', label: 'p', fmt: fmt6 },
            { key: 'x_ideal', label: 'x_ideal', fmt: fmt6 },
            { key: 'u_INJ_ideal', label: 'u_INJ_ideal', fmt: fmt6 },
            { key: 'R_FB', label: 'R_FB' },
            { key: 'R_INJ', label: 'R_INJ' },
          ]}
          rows={tableRows}
          maxHeight={280}
          exportName="ch9_qn_vs_p.csv"
        />
      </SectionFigure>

      <SectionFigure
        title="「只看 bit 的錯誤 injection」vs「用 state 的正確 injection」(experiment 20)"
        caption={
          <span>
            兩組模擬皆為 N=3.13、ef1(EXPERIMENTS exp20)。紅色:mode A — injection
            對 wrapped per-cycle target 用<b>獨立</b> ef1 state 重新量化(bit-stream
            視角);綠色:mode D — 直接由共享的 final code 做 modular reverse。mode D
            的 e_pair_digital 恆為 0 <EpistemicTag kind="EXACT" />(rms ={' '}
            {trimNumber(exp20Stats.rmsD, 3)} cycle);mode A 非零(rms ={' '}
            {formatPhase(exp20Stats.rmsA, unit, tVco20)},p2p ={' '}
            {formatPhase(exp20Stats.p2pA, unit, tVco20)})
            <EpistemicTag kind="EXPERIMENT" />。單位:<UnitSwitch />
          </span>
        }
      >
        <EChart option={optExp20} height={300} group="ch9-k" />
      </SectionFigure>

      <SectionCode
        title="web/src/model — 真實碼節錄:R_INJ 的兩種來源與 n_int 的導出"
        language="typescript"
        code={`// web/src/model/injectionScheduler.ts — runInjection() 節錄
const uIdeal = uInjIdeal(xNominal, cfg.z0_cycles);

// --- R_INJ per architecture mode ---
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
}

// web/src/model/feedbackScheduler.ts — n_integer 由 absolute code 差分導出
for (let k = 0; k < n - 1; k++) {
  const d = iFb[k + 1] - iFb[k];
  if (!(d >= 0)) {
    throw new Error('n_integer must be non-negative (PMUX wrap legality)');
  }
  nIntPadded[k] = d;
}`}
      >
        <p>
          兩段皆為 <code>web/src/model</code> 的實際原始碼(未改寫)。上段是本章核心
          對照:mode D 從累積後的 final code <code>rFb</code> 導出 injection;mode
          A/B/C 用獨立 quantizer state 重新量化 — 即「bit-stream 視角」。
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'const uIdeal = uInjIdeal(xNominal, cfg.z0_cycles);',
            explain: (
              <span>
                injection 目標由 <M>{'x_{nominal}'}</M>(累積 state)經{' '}
                <M>{'\\operatorname{wrap01}(z_0-x)'}</M> 算出 — 輸入是 phase,不是
                除頻 bit。這一行本身就給出本章的答案。
              </span>
            ),
          },
          {
            code: "if (cfg.arch_mode === 'D') {",
            explain: (
              <span>
                mode D 分支:injection code 完全由 feedback 已量化的 final code 導出,
                兩路共用同一次 quantization 的結果(Ch8 的 shared state)。
              </span>
            ),
          },
          {
            code: 'rInj[k] = pymod(cfg.r_zero - rFb[k], g);',
            explain: (
              <span>
                modular reverse:<M>{'R_{INJ}=(R_{zero}-R_{FB})\\bmod 256'}</M>。
                <code>rFb</code> 是 <b>accumulated</b> absolute code 的餘數,因此
                identity <M>{'(R_{FB}+R_{INJ})\\bmod 256=R_{zero}'}</M> 逐拍成立,
                <M>{'e_{pair,digital}\\equiv 0'}</M>。<EpistemicTag kind="EXACT" />
              </span>
            ),
          },
          {
            code: 'const q = makeQuantizer(cfg.quantizer);',
            explain: (
              <span>
                A/B/C 分支:建立<b>獨立</b>的 quantizer instance,有自己的 error
                state — 這是「只看當拍 target、不共享累積狀態」的形式化。
              </span>
            ),
          },
          {
            code: 'let u = g * uIdeal[k];',
            explain: (
              <span>
                對 wrapped 的 per-cycle target 重新量化。注意輸入已 wrap 回 [0,1):
                integer-cycle 的累積歷史在這裡被丟掉。
              </span>
            ),
          },
          {
            code: 'rInj[k] = pymod(q.quantize(u), g);',
            explain: (
              <span>
                獨立 state 的 quantize:平均行為正確,但每一拍的捨入決策與 feedback
                側不同步 → cycle-by-cycle 的 reverse 配對破裂(第三張圖紅線)。
                <EpistemicTag kind="EXPERIMENT" />
              </span>
            ),
          },
          {
            code: 'const d = iFb[k + 1] - iFb[k];',
            explain: (
              <span>
                除頻器瞬時輸出 <M>{'n[k]=I_{FB}[k+1]-I_{FB}[k]'}</M> 是 absolute code
                的<b>差分</b>,frequency-like;要回到 phase 必須再積分
                (<M>{'z^{-1}/(1-z^{-1})'}</M>),積分的初值與歷史就是 accumulator
                state。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            圖 #19:quantizer = ef1 時 <code>dsm_state</code> 呈鋸齒(每拍累積 sub-LSB
            殘量、進位時回落);切到 nearest 後恆為 0 — memoryless quantizer 沒有可
            共享的累積誤差。
          </li>
          <li>
            圖 #20:橘色 <M>{'q_N'}</M> 只在 +0.13 / −0.87 兩值跳動(α=0.13 時),
            對 phase 幾乎沒有直接資訊;藍色 p 每拍上升 0.13、到 1 wrap — 與綠色虛線{' '}
            <M>{'x_{ideal}'}</M> 重合。用 tooltip 對照 k=1 與 k=4:n[k] 同為 3,p 卻是
            0.13 vs 0.52。
          </li>
          <li>
            圖 #20 下方表格:R_INJ 欄(injection 實際 command)逐拍遞減約 33 個
            code(反向旋轉 −α),它跟著 p / R_FB 走,與 n[k] 的 bit 值沒有一對一關係。
          </li>
          <li>
            experiment 20 圖:綠線(mode D)貼 0 不動 <EpistemicTag kind="EXACT" />;
            紅線(mode A)在 ±1 LSB 內跳動,rms 顯示於 caption — 這就是「只看 bit /
            只看當拍 target」的代價。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            把 N 滑到 3.000(整數):q_N 恆 0、p 恆 0、一切靜止 — off-grid 的 α 才是
            問題來源。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout
          type="warn"
          title="誤解:「DSM 輸出 bit 已含相位資訊,直接把 bit 接到 injection 端即可」"
        >
          <p>
            錯。<M>{'n[k]'}</M> 是 <M>{'x[k]'}</M> 的差分(frequency-like);同一個
            bit 值對應無窮多個 phase state。N=3.13 的 k=1 與 k=4 同為 /3,所需
            injection code 卻是 223 vs 123(差 140.4°)。把 bit 直接映射成注入相位
            等於丟掉積分器 — 誤差不是 sub-LSB 級,而是整條 fractional 軌跡級。
            <EpistemicTag kind="EXACT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解:「兩邊各自用同型 DSM 重新量化,平均對就好」">
          <p>
            平均正確不等於逐拍正確:independent state 的捨入決策與 feedback 不同步,
            e_pair 逐拍非零(experiment 20 紅線)。injection 的目的正是逐拍對準 zero
            crossing,「平均對」沒有意義。<EpistemicTag kind="EXPERIMENT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <p>
          Injection scheduler 必須拉的是<b>累積量</b>,不是瞬時 bit。具體選項(由好到
          不可接受):
        </p>
        <ul>
          <li>
            <b>shared master accumulator state</b>(<M>{'P[k]=A_{ideal}[k]'}</M>)或由
            它量化後的 <b>final common code</b> <M>{'R_{FB}[k]'}</M> — mode D 直接
            modular reverse,e_pair_digital ≡ 0。<EpistemicTag kind="EXACT" />
          </li>
          <li>
            至少要共享 <b>accumulated quantization error</b>(DSM 內部 state,圖
            #19)— 沒有它,sub-LSB 的累積資訊無法重建。<EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            <b>瞬時 bit</b> <M>{'n[k]'}</M> 單獨存在時對 injection 沒有足夠資訊 —
            不可作為 injection phase 的唯一來源。<EpistemicTag kind="EXACT" />
          </li>
        </ul>
        <p>
          這也是 Ch1 系統圖中「兩條路徑在 master accumulator 交會」的理由,以及 Ch8
          Mode D 被推薦的根本原因。
        </p>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            本章全部為 exact digital timing model(MODEL_SPEC §20):quantizer 是 §6
            的行為抽象,未建模實際 DSM 硬體的位寬、pipeline 或 dither 電路;模擬不含
            analog 誤差(tap/DTC mismatch)、VCO random noise 與 latency(見
            Ch12–Ch15)。「p 與 x_ideal 重合」的緊密程度依 quantizer 而定:nearest
            下差距 ≤ half-LSB <EpistemicTag kind="EXACT" />;ef1 / mash11 暫態可較大
            (n_int 測試範圍放寬為 2–5,MODEL_SPEC §4)。互動模擬固定 {N_CYCLES}{' '}
            cycles、seed 12345。
          </p>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="參數 Parameters">
        <Slider
          label="N = 3 + α"
          value={nDiv}
          min={3.0}
          max={3.25}
          step={0.0025}
          onChange={setNDiv}
        />
        <PresetButtons
          label="Preset N"
          presets={[3.0, 3.125, 3.13, 3.1375, 3.25].map((n) => ({
            label: String(n),
            onClick: () => setNDiv(n),
          }))}
        />
        <SelectControl<Quantizer>
          label="Quantizer(圖 #19 / #20)"
          value={quant}
          options={QUANT_OPTIONS}
          onChange={setQuant}
        />
        <p style={{ fontSize: 12, opacity: 0.75 }}>
          experiment 20 對照圖固定為 N=3.13 / ef1(mode D vs mode A),不隨上方參數
          改變。
        </p>
      </ParamPanel>
    </ChapterShell>
  );
}
