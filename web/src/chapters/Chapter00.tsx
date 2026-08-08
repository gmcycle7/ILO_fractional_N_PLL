/**
 * Chapter 0 — 執行摘要 Executive Overview.
 *
 * Content contract: CHAPTER_GUIDE.md Ch0. No interactive simulation here —
 * key-number cards are derived live from ../model unit helpers, plus a small
 * static phase wheel and the site navigation map.
 */

import { useState } from 'react';
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
import PhaseWheel from '../components/PhaseWheel';
import { ParamPanel, PresetButtons, Slider } from '../components/controls';
import { useChartTheme } from '../lib/useChartTheme';
import { formatSiTime, trimNumber } from '../lib/format';
import { chapterHref } from '../lib/router';
import { chapterById } from './index';
import {
  tVcoS,
  fVcoHz,
  dtcLsbS,
  phaseLsbDeg,
  wrapCycles,
  cyclesToDegrees,
  cyclesToTime,
} from '../model';

const meta = chapterById(0)!;

/* ---------------------------------------------------------------- styles */

const cardGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 12,
  margin: '10px 0',
};

const cardStyle: CSSProperties = {
  background: 'var(--bg-panel)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  padding: '10px 12px',
};

const navGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 10,
  margin: '6px 0',
};

const navLinkStyle: CSSProperties = {
  display: 'block',
  padding: '7px 10px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  background: 'var(--bg-panel)',
  color: 'var(--fg)',
  textDecoration: 'none',
  fontSize: 13,
  lineHeight: 1.45,
};

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--accent)', margin: '2px 0' }}>
        {value}
      </div>
      {sub !== undefined && <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>{sub}</div>}
    </div>
  );
}

/* ------------------------------------------------------------- nav map */

const NAV_GROUPS: { label: string; ids: number[] }[] = [
  { label: '基礎與慣例', ids: [0, 1, 2] },
  { label: '理想軌跡與 feedback path', ids: [3, 4, 5] },
  { label: 'Reverse injection 核心', ids: [6, 7, 8] },
  { label: '量化與 DSM', ids: [9, 10, 11] },
  { label: '非理想性與動態', ids: [12, 13, 14, 15, 16] },
  { label: '綜合、模型與結論', ids: [17, 18, 19, 20] },
];

/* --------------------------------------------------- quoted model source */

const DEFAULT_CONFIG_SRC = `/** Spec defaults (identical to the Python dataclass defaults). */
export function defaultConfig(): SimConfig {
  return {
    f_ref_hz: 4e9,
    n_div: 3.125,
    n_cycles: 512,
    s0: 0.0,
    b_dtc: 6,
    n_tap: 8,
    n_pmux: 4,
    z0_cycles: 0.0,
    r_zero: 0,
    quantizer: 'nearest',
    dither_amp_lsb: 0.0,
    arch_mode: 'D',
    inj_mapping: 'naive',
    dtc_mode: 'normalized',
    dtc_lsb_fs: 312.5,
    latency_cycles: 0,
    lookahead: true,
    seed: 12345,
    // ... analog nonideality 與 injection dynamics 欄位(全部預設 0 / off,
    //     見 web/src/model/config.ts 與 MODEL_SPEC §10、§14)...
  };
}`;

export default function Chapter00() {
  const [alpha, setAlpha] = useState(0.125);
  const ct = useChartTheme();

  const nDiv = 3 + alpha;
  const tv = tVcoS(nDiv); // seconds
  const fvGhz = fVcoHz(nDiv) / 1e9;
  const lsbS = dtcLsbS(nDiv); // normalized DTC LSB, seconds
  const lsbDeg = phaseLsbDeg(256); // 1.40625 deg, normalized
  const halfLsbS = lsbS / 2;
  const halfLsbDeg = lsbDeg / 2;
  const latBugDeg = cyclesToDegrees(wrapCycles(1 * 0.13)); // 46.8 deg
  const tap1degS = cyclesToTime(1 / 360, tv); // 1 deg tap mismatch, seconds
  const gain1pctS = cyclesToTime(0.01 * 0.25, tv); // 1% of DTC full range T_vco/4

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            這個專案研究的系統是什麼?一句話說清楚 fractional-N PLL 加上 reverse edge
            injection 的組合在做什麼。
          </li>
          <li>
            預設參數(<M>{'f_{ref}=4\\,\\mathrm{GHz}'}</M>、<M>{'N=3+\\alpha'}</M>、
            <M>{'G=256'}</M>)下,關鍵數量級是多少?哪些誤差大於 half-LSB?
          </li>
          <li>為什麼全站最後推薦 Mode D(quantize once + modular reverse)架構鏈?</li>
          <li>20 章的內容如何組織?從哪裡開始讀?</li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          <strong>系統一句話:</strong>一個 4 GHz reference 驅動的 fractional-N
          PLL(輸出 12–13 GHz、8-phase VCO),除了傳統 feedback loop(/3-/4 divider +
          4-phase PMUX + 6-bit DTC)之外,每個 reference cycle 額外由 digital scheduler
          排程一個 injection pulse,在 VCO differential 波形的 zero crossing 上做
          shorting,把 VCO 的 random phase noise 每拍拉回一次;feedback 與 injection
          兩條路徑共用同一個 master phase accumulator。
          <EpistemicTag kind="ASSUMPTION" />
        </p>
        <p>
          核心幾何是「反向」:VCO 相對 reference 每拍多轉 <M>{'+\\alpha'}</M>{' '}
          cycle,要讓 pulse 永遠落在固定的 VCO zero crossing,pulse 的排程相對
          reference 每拍就要倒轉 <M>{'-\\alpha'}</M>。
          <EpistemicTag kind="EXACT" />{' '}
          下方 phase wheel 用一對正轉/反轉的針靜態示意這件事(動畫版在 Ch3、Ch6)。
        </p>
        <p>
          整個模型是 behavioral、digital-exact 的 timing model:scheduler 方程式可被
          逐位驗證,analog 非理想性(tap mismatch、DTC INL、jitter)與 injection
          dynamics 則是行為級近似,各章誠實標注。
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>全站數學的最小集合(各章展開推導,符號慣例見 Ch2):</p>
        <MathBlock>{'f_{vco} = N \\cdot f_{ref}, \\qquad N = 3 + \\alpha,\\; \\alpha \\in [0, 0.25]'}</MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> 頻率規劃:<M>{'f_{vco} \\in [12, 13]\\,\\mathrm{GHz}'}</M>,
          <M>{'T_{vco} \\in [76.923, 83.333]\\,\\mathrm{ps}'}</M>。
        </p>
        <MathBlock>{'s_{ideal}[k] = s_0 + kN, \\qquad x_{ideal}[k] = \\operatorname{wrap01}(s_{ideal}[k])'}</MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> 理想 fractional phase trajectory(Ch3);fine code 解析度{' '}
          <M>{'G = N_{PMUX} \\cdot 2^{B_{DTC}} = 4 \\cdot 64 = 256'}</M>,即
        </p>
        <MathBlock>{'\\mathrm{LSB} = \\frac{T_{vco}}{256}, \\qquad \\Delta\\phi_{LSB} = \\frac{360^\\circ}{256} = 1.40625^\\circ'}</MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> Injection 的理想 normalized command 是 fractional phase
          的「反向」(Ch6):
        </p>
        <MathBlock>{'u_{INJ,ideal}[k] = \\operatorname{wrap01}(z_0 - x_{nominal}[k]) \\xrightarrow{z_0=0} \\operatorname{wrap01}(-x_{nominal}[k])'}</MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> Mode D 架構把「反向」放在 digital final code 上做一次
          modular reverse(Ch8):
        </p>
        <MathBlock>{'R_{INJ}[k] = (R_{zero} - R_{FB}[k]) \\bmod 256 \\;\\Rightarrow\\; (R_{FB}[k] + R_{INJ}[k]) \\bmod 256 = R_{zero}'}</MathBlock>
        <p>
          <EpistemicTag kind="EXACT" /> 因此 pairwise digital error 恆為零。最後,pipeline latency{' '}
          <M>{'L'}</M> 若不做 look-ahead,誤差為(Ch12):
        </p>
        <MathBlock>{'e_{lat} = \\operatorname{wrapCycles}(L\\,\\alpha)'}</MathBlock>
      </SectionMath>

      <SectionExample>
        <p>預設參數表(MODEL_SPEC §1;全部可在各章互動圖中調整):</p>
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Default</th>
              <th>說明</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><M>{'f_{ref}'}</M></td><td>4 GHz</td><td>reference frequency <EpistemicTag kind="ASSUMPTION" /></td></tr>
            <tr><td><M>{'N = 3+\\alpha'}</M></td><td><M>{'\\alpha \\in [0, 0.25]'}</M></td><td>fractional divide ratio;preset 3.000 / 3.125 / 3.130 / 3.1375 / 3.250</td></tr>
            <tr><td><M>{'f_{vco}'}</M></td><td>12–13 GHz</td><td><M>{'N \\cdot f_{ref}'}</M></td></tr>
            <tr><td><M>{'B_{DTC}'}</M></td><td>6 bits</td><td>feedback 與 injection DTC 位元數</td></tr>
            <tr><td><M>{'G'}</M></td><td>256</td><td><M>{'4 \\cdot 2^6'}</M> fine units / <M>{'T_{vco}'}</M></td></tr>
            <tr><td><M>{'N_{TAP}'}</M></td><td>8</td><td>injection taps(45° 間距)<EpistemicTag kind="ASSUMPTION" /></td></tr>
            <tr><td><M>{'N_{PMUX}'}</M></td><td>4</td><td>feedback PMUX 相位數 <EpistemicTag kind="ASSUMPTION" /></td></tr>
            <tr><td><M>{'z_0,\\ R_{zero}'}</M></td><td>0, 0</td><td>injection zero-crossing 目標與 digital zero offset(可校正)</td></tr>
          </tbody>
        </table>
        <p style={{ marginTop: 12 }}>
          關鍵數字卡片(隨右側 <M>{'N'}</M> 選擇即時計算;目前{' '}
          <M>{'N'}</M> = {trimNumber(nDiv, 6)}):
        </p>
        <div style={cardGridStyle}>
          <StatCard
            label="f_vco / T_vco"
            value={`${trimNumber(fvGhz, 6)} GHz`}
            sub={`T_vco = ${formatSiTime(tv, 6)}`}
          />
          <StatCard
            label="1 LSB(time)= T_vco/256"
            value={formatSiTime(lsbS, 6)}
            sub="N=3.125 時 = 312.5 fs [EXACT]"
          />
          <StatCard
            label="1 LSB(phase)"
            value={`${trimNumber(lsbDeg, 6)}°`}
            sub="360°/256,normalized DTC 下與 N 無關 [EXACT]"
          />
          <StatCard
            label="half-LSB(quantization bound)"
            value={formatSiTime(halfLsbS, 6)}
            sub={`= ${trimNumber(halfLsbDeg, 6)}°;N=3.125 時 156.25 fs [EXACT]`}
          />
          <StatCard
            label="latency bug @ α=0.13, L=1"
            value={`${trimNumber(latBugDeg, 4)}°`}
            sub={`= wrapCycles(L·α)·360°,為 half-LSB 的 ${trimNumber(latBugDeg / halfLsbDeg, 3)} 倍 [EXACT]`}
          />
          <StatCard
            label="1° tap mismatch"
            value={formatSiTime(tap1degS, 6)}
            sub={`= half-LSB 的 ${trimNumber(tap1degS / halfLsbS, 3)} 倍;N=3.125 時 222.22 fs [EXACT]`}
          />
          <StatCard
            label="1% DTC gain error(range T_vco/4)"
            value={formatSiTime(gain1pctS, 6)}
            sub={`= half-LSB 的 ${trimNumber(gain1pctS / halfLsbS, 3)} 倍;N=3.125 時 200 fs [EXACT]`}
          />
        </div>
        <p>
          手驗:<M>{'N=3.125'}</M> 時 <M>{'T_{vco} = 1/(3.125 \\times 4\\,\\mathrm{GHz}) = 80\\,\\mathrm{ps}'}</M>,
          <M>{'80\\,\\mathrm{ps}/256 = 312.5\\,\\mathrm{fs}'}</M>;
          <M>{'1^\\circ = 80\\,\\mathrm{ps}/360 = 222.2\\overline{2}\\,\\mathrm{fs}'}</M>;
          <M>{'1\\% \\times 20\\,\\mathrm{ps} = 200\\,\\mathrm{fs}'}</M>;
          <M>{'0.13 \\times 360^\\circ = 46.8^\\circ'}</M>。
        </p>
      </SectionExample>

      <SectionFigure
        title="Reverse injection 幾何(靜態示意,N = 3.13)"
        caption={
          <span>
            Phase wheel 慣例:0 cycle 在 12 點鐘方向、順時針 = phase 增加 = 時間上較晚(Ch2)。
            藍針:第 1 拍的 <M>{'x_{ideal} = +\\alpha = 0.13'}</M>(正轉);另一針:對應的{' '}
            <M>{'u_{INJ,ideal} = \\operatorname{wrap01}(-0.13) = 0.87'}</M>(反轉)。兩針相加 mod 1 = 0,
            即 injection pulse 落回 zero crossing。動畫版見 Ch3 / Ch6。
          </span>
        }
      >
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <PhaseWheel
            size={280}
            markers={[
              { angleCycles: 0.13, label: 'x_ideal = 0.13', color: ct.accent },
              { angleCycles: 0.87, label: 'u_INJ = 0.87', color: ct.series[1], r: 0.62 },
            ]}
            arcs={[
              { fromCycles: 0, toCycles: 0.13, color: ct.accent, r: 0.9 },
              { fromCycles: 0.87, toCycles: 1.0, color: ct.series[1], r: 0.5 },
            ]}
            title="正轉 +α(feedback 追蹤)vs 反轉 −α(injection 排程)"
          />
        </div>
      </SectionFigure>

      <SectionFigure
        title="導覽地圖(21 章)"
        caption="建議閱讀路徑:Ch0–2 先固定語言與慣例 → Ch3–5 feedback path → Ch6–8 injection 核心(全站最重要的推導在 Ch6)→ Ch9–11 量化與 DSM → Ch12–16 非理想性 → Ch17–20 綜合與結論。"
      >
        {NAV_GROUPS.map((g) => (
          <div key={g.label} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg-subtle)', margin: '6px 0 4px' }}>
              {g.label}
            </div>
            <div style={navGridStyle}>
              {g.ids.map((id) => {
                const c = chapterById(id);
                if (!c) return null;
                return (
                  <a key={id} href={chapterHref(c.slug)} style={navLinkStyle}>
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>Ch{c.id}</span>{' '}
                    {c.titleZh}
                    <span style={{ color: 'var(--fg-faint)', display: 'block', fontSize: 11.5 }}>
                      {c.titleEn}
                    </span>
                  </a>
                );
              })}
            </div>
          </div>
        ))}
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model/config.ts — defaultConfig()(節錄)"
        code={DEFAULT_CONFIG_SRC}
      >
        <p>
          全站所有互動圖的計算都經由 <code>import {'{ simulate, defaultConfig, ... }'} from
          '../model'</code>,與 Python golden model 逐位一致(整數 code 完全相等、純數位
          float 誤差 ≤ 1e-12;MODEL_SPEC §18)。<EpistemicTag kind="EXACT" />
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'f_ref_hz: 4e9,',
            explain: (
              <span>
                Reference 4 GHz(<M>{'T_{ref}=250\\,\\mathrm{ps}'}</M>),只用上升緣
                (ASSUMPTION A1)。所有 per-cycle 序列的 sample rate 都是 f_ref,不是 f_vco(Ch16)。
              </span>
            ),
          },
          {
            code: "n_div: 3.125,",
            explain: (
              <span>
                預設 <M>{'N=3.125'}</M> 是 on-grid case(<M>{'\\alpha G = 32'}</M> 為整數),
                量化誤差恆為 0,適合當 sanity baseline;off-grid 的 3.13 才是本題核心(Ch3)。
              </span>
            ),
          },
          {
            code: 'b_dtc: 6,\nn_tap: 8,\nn_pmux: 4,',
            explain: (
              <span>
                <M>{'G = 4 \\cdot 2^6 = 256'}</M> fine units / cycle。8 taps 間距 32 LSB、DTC
                range 64 LSB → injection 有 redundant 表示(Ch7)。
              </span>
            ),
          },
          {
            code: 'z0_cycles: 0.0,\nr_zero: 0,',
            explain: (
              <span>
                期望 zero-crossing 相位與 digital zero offset,皆為可校正參數
                (ASSUMPTION A5/A6),推導中保留符號 <M>{'z_0, R_{zero}'}</M>。
              </span>
            ),
          },
          {
            code: "quantizer: 'nearest',",
            explain: (
              <span>
                Baseline 是 half-up nearest:<M>{'\\lfloor x+0.5 \\rfloor'}</M>;語言內建
                round() 被禁用(Ch2)。DSM(ef1/mash11)是選項,不是預設(Ch11)。
              </span>
            ),
          },
          {
            code: "arch_mode: 'D',",
            explain: (
              <span>
                Mode D = quantize once + modular reverse,pairwise digital error 恆為 0
                <EpistemicTag kind="EXACT" />(Ch8)。
              </span>
            ),
          },
          {
            code: 'latency_cycles: 0,\nlookahead: true,',
            explain: (
              <span>
                Pipeline latency 模型(Ch12):<code>lookahead: false</code> 就是 46.8° 的
                bug mode。
              </span>
            ),
          },
          {
            code: 'seed: 12345,',
            explain: (
              <span>
                Deterministic PRNG(mulberry32,per-stream offset;MODEL_SPEC §12),讓
                browser 與 Python 的含 noise 結果也一致。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            Phase wheel 上兩針恆為鏡像:<M>{'x + u_{INJ} \\equiv z_0 \\pmod 1'}</M>。這個鏡像關係搬到
            digital final code 上就是 Mode D identity。
          </li>
          <li>
            卡片中,把 <M>{'N'}</M> 從 3.000 掃到 3.250:time-LSB 從 325.5 fs 縮到 300.5 fs
            (normalized DTC 的 phase-LSB 固定 1.40625°),但 1° tap 與 1% gain 的絕對誤差同時縮放,
            <strong>比值</strong>幾乎不變 — 兩者始終大於 half-LSB。
            <EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            46.8°(latency bug)對 0.703°(half-LSB)= 66.6 倍:數位排程 bug 比量化本身大兩個
            數量級,這是 Ch12 的主題。<EpistemicTag kind="EXACT" />
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解:「量化步長只有 312.5 fs,夠細了,analog mismatch 是次要問題」">
          <p>
            錯。卡片直接給出反例:1° 的 tap mismatch = 222 fs、1% 的 DTC gain error = 200 fs,
            都<strong>大於</strong> half-LSB 156.25 fs — 也就是說,合理的 analog 失配一項就能吃掉
            整個量化預算。<EpistemicTag kind="INFERENCE" /> 所以 Ch7/Ch15 的 calibrated mapping
            與 error decomposition 不是選配,是設計主軸。
          </p>
        </Callout>
        <Callout type="warn" title="誤解:「Mode D 消除所有 injection 誤差」">
          <p>
            錯。Shared final code 消除的只有 feedback/injection 之間的<strong>數位相對</strong>
            mismatch;absolute quantization error、DTC analog gain/INL、tap mismatch、latency、
            VCO random noise 一項都不會消失(Ch8 逐項列表)。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <p>全站結論預覽(Ch20 逐條論證;此處先給推薦架構鏈):<EpistemicTag kind="INFERENCE" /></p>
        <ol>
          <li>單一 shared master phase accumulator(不是兩套各自累加)</li>
          <li>quantize once → common final code <M>{'R_{FB}'}</M></li>
          <li>feedback decode:<M>{'I/R/m/c'}</M>(/3-/4 + PMUX + DTC)</li>
          <li>injection 用 modular reverse:<M>{'R_{INJ}=(R_{zero}-R_{FB}) \\bmod 256'}</M></li>
          <li>tap/DTC decode 用 calibrated argmin(吃掉 redundancy)</li>
          <li>fixed-latency look-ahead(<M>{'x[k+L]=\\operatorname{wrap01}(x[k]+L\\alpha)'}</M>)</li>
          <li>quantizer baseline 用 nearest;shared DSM 要先經 Ch11/Ch17 的頻譜評估才選用</li>
        </ol>
        <p>
          每一步都由具體 experiment 支持(Ch17 一鍵重現),不是宣稱。
        </p>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty" title="本站(與整個模型)誠實範圍 — MODEL_SPEC §20">
          <ul>
            <li>scheduler 方程式是 exact digital timing model,可逐位驗證。<EpistemicTag kind="EXACT" /></li>
            <li>DTC/tap mismatch 是 behavioral nonideality model。<EpistemicTag kind="ASSUMPTION" /></li>
            <li>
              sinusoidal injection map 是近似;真實 phase response 需 transistor-level
              PSS/PDR 萃取。<EpistemicTag kind="APPROX" />
            </li>
            <li>shorting energy 是 normalized proxy,非真實功率。<EpistemicTag kind="APPROX" /></li>
            <li>本專案未執行 Spectre;Verilog-A 僅提供 source 與 usage guide(Ch19)。</li>
            <li>behavioral result 不等同 silicon result。</li>
          </ul>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="參數(卡片即時重算)">
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
      </ParamPanel>
    </ChapterShell>
  );
}
