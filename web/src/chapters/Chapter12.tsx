/**
 * Chapter 12 — Pipeline Latency and Look-Ahead (MODEL_SPEC §13).
 * Figure #27: command issue/apply timeline + seq_id metadata table;
 * correct vs bug comparison (46.8° @ alpha=0.13, L=1 vs half-LSB 0.703125°).
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
import { ParamPanel, Slider, Toggle, PresetButtons } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import DebugTable from '../components/DebugTable';
import PhaseWheel from '../components/PhaseWheel';
import { makeLineOption, makeMarkLine } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { formatPhase, phaseAxisLabel, makePhaseTickFormatter, trimNumber } from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  simulate,
  fromPartial,
  applyLatency,
  wrap01,
  wrapCycles,
  cyclesToDegrees,
  configTVcoS,
} from '../model';

const meta = chapterById(12)!;

const N_DIAG = 12; // cycles drawn in the latency diagram
const N_SIM = 256; // interactive simulation length

const LATENCY_CODE = `const L = Math.trunc(cfg.latency_cycles);
const kApplied = new Int32Array(n);
const kComputed = new Int32Array(n);
const kIntended = new Int32Array(n);
const idx = new Int32Array(n);
const seqId = new Int32Array(n);

for (let k = 0; k < n; k++) {
  kApplied[k] = k;
  kComputed[k] = Math.max(k - L - extra[k], 0);
  if (cfg.lookahead) {
    idx[k] = Math.max(k - extra[k], 0);
    kIntended[k] = idx[k];
  } else {
    idx[k] = kComputed[k];
    kIntended[k] = kComputed[k];
  }
  seqId[k] = idx[k];
}

const metadata: LatencyMetadata[] = [];
for (let k = 0; k < n; k++) {
  metadata.push({
    k_computed: kComputed[k],
    k_intended: kIntended[k],
    k_applied: k,
    seq_id: seqId[k],
  });
}`;

/** Figure #27: command compute/apply timeline (hand-rolled SVG). */
function LatencyDiagram({
  kComputed,
  seqId,
  lookahead,
  accent,
  bad,
  good,
}: {
  kComputed: ArrayLike<number>;
  seqId: ArrayLike<number>;
  lookahead: boolean;
  accent: string;
  bad: string;
  good: string;
}) {
  const xs = (k: number) => 56 + k * 52;
  const yTop = 62;
  const yBot = 150;
  const lineColor = lookahead ? good : bad;
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg
        viewBox="0 0 680 212"
        style={{ width: '100%', minWidth: 560, height: 'auto', display: 'block' }}
        role="img"
        aria-label="latency command issue and apply timeline"
      >
        <text x={4} y={yTop + 4} style={{ fill: 'var(--fg-subtle)', fontSize: 11 }}>
          compute
        </text>
        <text x={4} y={yBot + 4} style={{ fill: 'var(--fg-subtle)', fontSize: 11 }}>
          apply
        </text>
        <text x={676} y={14} textAnchor="end" style={{ fill: lineColor, fontSize: 11 }}>
          {lookahead ? 'look-ahead:command 攜帶 P[k_applied]' : 'bug:command 攜帶 P[k_computed]'}
        </text>
        {/* lane baselines */}
        <line x1={xs(0) - 10} y1={yTop} x2={xs(N_DIAG - 1) + 10} y2={yTop} stroke="var(--border)" />
        <line x1={xs(0) - 10} y1={yBot} x2={xs(N_DIAG - 1) + 10} y2={yBot} stroke="var(--border)" />
        {/* command journeys */}
        {Array.from({ length: N_DIAG }, (_, k) => (
          <line
            key={`j${k}`}
            x1={xs(kComputed[k])}
            y1={yTop + 5}
            x2={xs(k)}
            y2={yBot - 5}
            stroke={lineColor}
            strokeWidth={1.6}
            opacity={0.85}
          />
        ))}
        {/* nodes and labels */}
        {Array.from({ length: N_DIAG }, (_, k) => (
          <g key={`n${k}`}>
            <circle cx={xs(k)} cy={yTop} r={3.5} fill="var(--fg-subtle)" />
            <circle cx={xs(k)} cy={yBot} r={3.5} fill={accent} />
            <text
              x={xs(k)}
              y={yTop - 12}
              textAnchor="middle"
              style={{ fill: 'var(--fg-subtle)', fontSize: 10 }}
            >
              {k}
            </text>
            <text
              x={xs(k)}
              y={yBot + 20}
              textAnchor="middle"
              style={{ fill: 'var(--fg-subtle)', fontSize: 10 }}
            >
              {k}
            </text>
            <text
              x={xs(k)}
              y={yBot + 36}
              textAnchor="middle"
              style={{ fill: lineColor, fontSize: 10 }}
            >
              s{seqId[k]}
            </text>
          </g>
        ))}
        <text x={xs(N_DIAG - 1) + 12} y={yBot + 36} style={{ fill: 'var(--fg-subtle)', fontSize: 10 }}>
          = seq_id
        </text>
      </svg>
    </div>
  );
}

export default function Chapter12() {
  const [alpha, setAlpha] = useState(0.13);
  const [latL, setLatL] = useState(1);
  const [diagLookahead, setDiagLookahead] = useState(false);
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const cfgBug = useMemo(
    () =>
      fromPartial({
        n_div: 3 + alpha,
        n_cycles: N_SIM,
        latency_cycles: latL,
        lookahead: false,
      }),
    [alpha, latL],
  );
  const cfgOk = useMemo(
    () =>
      fromPartial({
        n_div: 3 + alpha,
        n_cycles: N_SIM,
        latency_cycles: latL,
        lookahead: true,
      }),
    [alpha, latL],
  );

  const resBug = useMemo(() => simulate(cfgBug), [cfgBug]);
  const resOk = useMemo(() => simulate(cfgOk), [cfgOk]);
  const tVco = configTVcoS(cfgBug);

  useEffect(() => {
    setStatus('done', `2 × ${N_SIM} cycles, L=${latL}, α=${trimNumber(alpha, 4)}`);
  }, [resBug, resOk, latL, alpha, setStatus]);

  // theoretical bug-mode error (MODEL_SPEC §13, Test 5)
  const eLat = wrapCycles(latL * alpha);
  const eLatDeg = cyclesToDegrees(Math.abs(eLat));
  const halfLsbCyc = 1 / 512;
  const halfLsbDeg = cyclesToDegrees(halfLsbCyc); // 0.703125
  const ratio = eLatDeg / halfLsbDeg;

  // max |e_pair_digital| in bug mode (identity survives the latency bug)
  const pairMaxBug = useMemo(() => {
    let m = 0;
    const arr = resBug.data.e_pair_digital;
    for (let i = 0; i < arr.length; i++) {
      m = Math.max(m, Math.abs(arr[i]));
    }
    return m;
  }, [resBug]);

  // diagram mapping (12 cycles, deterministic — no noise stream)
  const diag = useMemo(
    () => applyLatency(fromPartial({ latency_cycles: latL, lookahead: diagLookahead }), N_DIAG, null),
    [latL, diagLookahead],
  );

  const simDiag = diagLookahead ? resOk : resBug;
  const metaRows = useMemo(() => {
    const d = simDiag.data;
    const md = simDiag.metadata;
    return Array.from({ length: Math.min(16, d.k.length) }, (_, k) => ({
      k_applied: d.k_applied[k],
      seq_id: d.seq_id[k],
      k_computed: d.k_computed[k],
      k_intended: md[k].k_intended,
      staleness: d.k_applied[k] - d.seq_id[k],
      R_FB: d.R_FB[k],
      R_INJ: d.R_INJ[k],
      x_ideal: d.x_ideal[k],
    }));
  }, [simDiag]);

  const cmpOption = useMemo(() => {
    const xy = (arr: Float64Array) => Array.from(arr, (v, k) => [k, v] as [number, number]);
    const opt = makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: phaseAxisLabel('e_abs', unit, tVco),
      yTickFormatter: makePhaseTickFormatter(unit, tVco),
      series: [
        { name: 'e_INJ_abs(bug)', data: xy(resBug.data.e_INJ_abs), color: ct.bad, step: 'middle' },
        { name: 'e_FB_abs(bug)', data: xy(resBug.data.e_FB_abs), color: ct.warn, step: 'middle' },
        {
          name: 'e_INJ_abs(look-ahead)',
          data: xy(resOk.data.e_INJ_abs),
          color: ct.good,
          step: 'middle',
        },
        {
          name: 'e_FB_abs(look-ahead)',
          data: xy(resOk.data.e_FB_abs),
          color: ct.accent,
          step: 'middle',
          dashed: true,
        },
      ],
    });
    const o = opt as unknown as { series?: Record<string, unknown>[] };
    if (o.series && o.series[0]) {
      o.series[0].markLine = makeMarkLine([
        { y: halfLsbCyc, label: '+half-LSB' },
        { y: -halfLsbCyc, label: '−half-LSB' },
      ]);
    }
    return opt;
  }, [resBug, resOk, unit, tVco, ct, halfLsbCyc]);

  // phase-wheel intuition: state at k=3 vs the stale state L cycles earlier
  const xNow = wrap01(3 * alpha);
  const xStale = wrap01((3 - latL) * alpha);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            digital pipeline latency <M>{'L'}</M> 是什麼?command 在哪一拍計算、哪一拍 apply?
          </li>
          <li>
            為什麼固定的 <M>{'L'}</M> 在 fractional-N 下仍造成{' '}
            <M>{'\\operatorname{wrapCycles}(L\\alpha)'}</M> 的 phase error?
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            look-ahead <M>{'x[k+L]=\\operatorname{wrap01}(x[k]+L\\alpha)'}</M> 如何完全補償固定
            latency?<EpistemicTag kind="EXACT" />
          </li>
          <li>
            canonical 數字 46.8°(<M>{'\\alpha=0.13,\\ L=1'}</M>)怎麼來?為何是 half-LSB
            0.703125° 的 66.6 倍?
          </li>
          <li>
            <code>seq_id / k_computed / k_intended / k_applied</code> metadata 如何讓 latency bug
            變成可驗證的量?
          </li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          scheduler 的輸出不是立刻生效的:command 要走過 retiming、synthesis pipeline、driver
          等數位級,<M>{'L'}</M> 拍之後才抵達 PMUX/DTC。VCO 的 fractional phase 不等人 —
          每個 reference cycle 相對 phase grid 多轉 <M>{'\\alpha'}</M>。如果 command 的內容是
          「計算當下」的 phase state,送達時 payload 已過期 <M>{'L\\alpha'}</M> cycle。
          look-ahead 的意思是:出貨時就寫上「到貨那一拍」的地址 —— command 在 cycle{' '}
          <M>{'k'}</M> 計算,但用的是 <M>{'k+L'}</M> 的 state。
        </p>
        <PhaseWheel
          markers={[
            { angleCycles: xNow, label: `x[3]=${trimNumber(xNow, 4)}`, color: ct.accent },
            {
              angleCycles: xStale,
              label: `stale x[${3 - latL}]`,
              color: ct.bad,
              r: 0.62,
            },
          ]}
          arcs={[{ fromCycles: xStale, toCycles: xNow, color: ct.warn, r: 0.45 }]}
          title={
            <span>
              apply 於 k=3 的 command:look-ahead 用 x[3](藍),bug 用 stale x[{3 - latL}]
              (紅);橘色弧 = 差距 <M>{'L\\alpha'}</M> ={' '}
              {formatPhase(Math.abs(eLat), unit, tVco)}
            </span>
          }
        />
      </SectionIntuition>

      <SectionMath>
        <p>
          MODEL_SPEC §13:cycle <M>{'k'}</M> 計算的 command 於 cycle <M>{'k+L'}</M> 被
          apply。ideal trajectory 是乘法式的 <M>{'s_{ideal}[k]=s_0+kN'}</M>,因此
          <EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>{'s_{ideal}[k+L] = s_{ideal}[k] + L\\,N'}</MathBlock>
        <p>
          <strong>bug mode(無 look-ahead)</strong>:apply 於 <M>{'k+L'}</M> 的 command 由{' '}
          <M>{'s_{ideal}[k]'}</M> 計算。依 error = actual − ideal(§2 sign convention),
          feedback 邊的 absolute error 為
          <EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {
            'e_{FB} = \\operatorname{wrapCycles}\\big(s_{ideal}[k] - s_{ideal}[k+L]\\big) = \\operatorname{wrapCycles}(-L N) = -\\operatorname{wrapCycles}(L\\alpha)'
          }
        </MathBlock>
        <p>
          (integer 部分在 wrap 後消失,只剩 fractional <M>{'L\\alpha'}</M>;邊界{' '}
          <M>{'\\operatorname{wrapCycles}'}</M> 的 (−0.5, 0.5] 慣例見第 2 章。)injection 邊因為{' '}
          <M>{'u_{INJ,ideal}=\\operatorname{wrap01}(z_0-x)'}</M> 是反向命令,stale state 給出{' '}
          <M>{'e_{INJ}=+\\operatorname{wrapCycles}(L\\alpha)'}</M>:兩邊各差一個相同大小、
          相反符號的量。error 大小為
          <EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {
            '|e_{latency}| = |\\operatorname{wrapCycles}(L\\alpha)| \\;\\xrightarrow{\\;\\alpha=0.13,\\ L=1\\;}\\; 0.13\\ \\text{cycle} = 46.8^{\\circ}'
          }
        </MathBlock>
        <p>
          <strong>正確(look-ahead)</strong>:apply 於 <M>{'k+L'}</M> 的 command 改由{' '}
          <M>{'P[k+L]'}</M> 計算。理想 accumulator 的 look-ahead 只是一行:
          <EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>{'x[k+L] = \\operatorname{wrap01}(x[k] + L\\,\\alpha)'}</MathBlock>
        <p>
          此時 latency error 恆為 0,殘餘的只有 quantizer 的 ≤ half-LSB error。與 half-LSB 的
          對比:
          <EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {
            '\\frac{46.8^{\\circ}}{0.703125^{\\circ}} = 66.56 \\approx 66.6\\times \\quad (\\text{half-LSB} = \\tfrac{1}{512}\\ \\text{cycle} = 156.25\\ \\text{fs @ } N=3.125)'
          }
        </MathBlock>
      </SectionMath>

      <SectionExample>
        <p>
          手算(<M>{'\\alpha=0.13,\\ L=1,\\ z_0=0'}</M>)。k=3 時 ideal fractional phase{' '}
          <M>{'x[3]=\\operatorname{wrap01}(3\\times 0.13)=0.39'}</M>;bug mode 下 apply 於 k=3 的
          command 是在 k=2 用 <M>{'x[2]=0.26'}</M> 算的:
        </p>
        <ul>
          <li>
            injection command(stale):<M>{'\\operatorname{wrap01}(-0.26)=0.74'}</M>;當拍 ideal 是{' '}
            <M>{'\\operatorname{wrap01}(-0.39)=0.61'}</M> → <M>{'e_{INJ}=+0.13'}</M> cycle = +46.8°。
          </li>
          <li>
            feedback edge(stale):phase 0.26 vs ideal 0.39 → <M>{'e_{FB}=-0.13'}</M> cycle =
            −46.8°。
          </li>
          <li>
            46.8° ÷ 0.703125° = 66.56 ≈ 66.6× half-LSB。<EpistemicTag kind="EXACT" />
          </li>
        </ul>
        <p>
          目前 slider 值:<M>{'|\\operatorname{wrapCycles}(L\\alpha)|'}</M> ={' '}
          {formatPhase(Math.abs(eLat), unit, tVco)} = {trimNumber(eLatDeg, 4)}° ={' '}
          {trimNumber(ratio, 4)}× half-LSB。
        </p>
      </SectionExample>

      <SectionFigure
        title={`圖 #27 — Latency 時間軸與 seq_id metadata(L=${latL}, ${diagLookahead ? 'look-ahead' : 'bug mode'})`}
        caption={
          <span>
            上排 = command 計算時刻 k_computed,下排 = apply 時刻 k_applied;每條線是一筆 command
            的旅程,底部 s<sub>n</sub> 是它攜帶的 state index(seq_id)。bug mode 下 seq_id =
            k_applied − L(stale);look-ahead 下 seq_id = k_applied。開頭 k &lt; L 的 command 被
            clamp 到 state 0(pipeline 預填)。下表為 simulate() 輸出的前 16 筆 metadata,
            staleness = k_applied − seq_id。
          </span>
        }
      >
        <LatencyDiagram
          kComputed={diag.k_computed}
          seqId={diag.seq_id}
          lookahead={diagLookahead}
          accent={ct.accent}
          bad={ct.bad}
          good={ct.good}
        />
        <DebugTable
          columns={[
            { key: 'k_applied', label: 'k_applied' },
            { key: 'seq_id', label: 'seq_id' },
            { key: 'k_computed', label: 'k_computed' },
            { key: 'k_intended', label: 'k_intended' },
            { key: 'staleness', label: 'staleness' },
            { key: 'R_FB', label: 'R_FB' },
            { key: 'R_INJ', label: 'R_INJ' },
            { key: 'x_ideal', label: 'x_ideal', fmt: (v) => trimNumber(v as number, 4) },
          ]}
          rows={metaRows}
          maxHeight={260}
          exportName="ch12_latency_metadata.csv"
        />
      </SectionFigure>

      <SectionFigure
        title="Correct vs bug:absolute error 對照(experiment 10 / 11)"
        caption={
          <span>
            紅/橘 = bug mode 的 e_INJ_abs / e_FB_abs(N={trimNumber(3 + alpha, 6)}, L={latL});
            綠/藍 = 同一 pipeline 開 look-ahead。虛線 = ±half-LSB。單位:<UnitSwitch />
            。把 unit 切到 deg,bug 平台的高度就是 ±{trimNumber(eLatDeg, 4)}°(疊加 ≤ half-LSB
            的量化 ripple)。<EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <EChart option={cmpOption} height={320} group="ch12" />
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model/latencyPipeline.ts — applyLatency() 核心(節錄)"
        code={LATENCY_CODE}
      >
        <p>
          <code>idx[k]</code> 是「apply 於 cycle k 的 command 用了哪一拍的 state」;simulate()
          用它 gather 所有 command 欄位,error 一律對「當拍 ideal state」計算(§16 的{' '}
          <M>{'e_{abs}'}</M> 定義)。
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'const L = Math.trunc(cfg.latency_cycles);',
            explain: (
              <span>
                latency 以整數 reference cycles 表示(MODEL_SPEC §13);behavioral model 不含
                sub-cycle 的類比 skew,那屬於 §10 的 route delay。
              </span>
            ),
          },
          {
            code: 'kComputed[k] = Math.max(k - L - extra[k], 0);',
            explain: (
              <span>
                apply 於 k 的 command 是在 k−L−extra 計算的;<code>extra</code> 是機率{' '}
                <code>p_late</code> 的 random 加 1 拍 latency。開頭 index 會是負的,clamp 到
                0:pipeline 以 k=0 的 command 預填(startup transient 的來源)。
              </span>
            ),
          },
          {
            code: 'if (cfg.lookahead) { idx[k] = Math.max(k - extra[k], 0);',
            explain: (
              <span>
                正確模式:雖然計算早了 L 拍,command 攜帶的是 look-ahead 後的 state{' '}
                <M>{'P[k]'}</M>,固定 L 被完全補償;只有無法預知的 random extra 拍會洩漏。
              </span>
            ),
          },
          {
            code: 'kIntended[k] = idx[k];',
            explain: <span>metadata 記錄 command「想要」服務的那一拍,供 testbench 比對。</span>,
          },
          {
            code: '} else { idx[k] = kComputed[k]; kIntended[k] = kComputed[k]; }',
            explain: (
              <span>
                bug 模式:apply 於 k 的 command 內容來自 stale state <M>{'P[k-L]'}</M>,intended
                與 applied 差 L 拍 — 這就是 <M>{'\\operatorname{wrapCycles}(L\\alpha)'}</M> error
                的機制。
              </span>
            ),
          },
          {
            code: 'seqId[k] = idx[k];',
            explain: (
              <span>
                seq_id 即 command 攜帶的 state index。驗證規則一行:look-ahead 正確 ⇔ 每筆{' '}
                <code>seq_id === k_applied</code>(deterministic pipeline 下)。
              </span>
            ),
          },
          {
            code: 'metadata.push({ k_computed, k_intended, k_applied: k, seq_id });',
            explain: (
              <span>
                每筆 command 附 metadata(MODEL_SPEC §13 契約),同時輸出到 test-vector CSV,
                讓 RTL/Verilog-A testbench 能逐筆對帳。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            對照圖:bug 的 e_INJ_abs 是一條 +{trimNumber(eLatDeg, 4)}° 附近的平台(latency error
            疊加 ≤ half-LSB 的量化 ripple,切到 deg 讀值),e_FB_abs 對稱地在 −
            {trimNumber(eLatDeg, 4)}°;look-ahead 兩條貼著 0,峰值不超過 ±half-LSB 虛線。
            <EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            前 L 拍是 startup transient(pipeline 預填 k=0 command),之後 bug error 是常數 —
            它是 deterministic error,不是 noise。
          </li>
          <li>
            把 L 拉到 8(α=0.13):<M>{'\\operatorname{wrapCycles}(1.04)=0.04'}</M> cycle =
            14.4° — error 對 L <em>不單調</em>,因為 wrap mod 1。看似變小,仍是 bug。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            metadata 表:bug mode 的 staleness 欄恆為 L;look-ahead 恆為 0。
          </li>
          <li>
            關鍵陷阱:bug mode 下 max |e_pair_digital| = {trimNumber(pairMaxBug, 4)} cycle —
            仍然是 0!兩路共享同一筆 stale code,Mode D identity 不受 latency 影響,
            pair check 抓不到 latency bug。<EpistemicTag kind="EXACT" />
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解 1:「latency 固定、兩路又同步延遲,所以沒有 error」">
          <p>
            錯。error 是相對「apply 當拍的 ideal phase」定義的(§16)。fractional phase 每拍
            +α,stale L 拍就是 <M>{'L\\alpha'}</M> cycle 的 phase error — α=0.13、L=1 時
            46.8°,是 half-LSB 的 66.6 倍。command domain 的「等延遲」不等於 phase domain 的
            「無誤差」。
          </p>
        </Callout>
        <Callout type="warn" title="誤解 2:「e_pair = 0 就代表 scheduler 沒 bug」">
          <p>
            pair error 只驗證 FB/INJ 的相對關係;latency bug 讓兩路一起錯,
            <M>{'e_{pair}'}</M> 依然恆 0。必須另外檢查 absolute error(e_abs 對當拍{' '}
            <M>{'P[k]'}</M>)或 seq_id metadata。
          </p>
        </Callout>
        <Callout type="warn" title="誤解 3:「L 越大錯越多」">
          <p>
            <M>{'\\operatorname{wrapCycles}(L\\alpha)'}</M> 隨 L 在 (−0.5, 0.5] 內繞圈:L=4 時
            −172.8°、L=8 時只有 14.4°(α=0.13)。「錯得比較少的 bug」更難在 lab 裡被發現,
            這正是要靠 metadata 驗證的原因。
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>
            固定 latency 必須用 fixed-latency look-ahead 補償:在 master accumulator 上前推{' '}
            <M>{'x[k+L]=\\operatorname{wrap01}(x[k]+L\\alpha)'}</M>,digital 上 exact、成本一行。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            每筆 command 都應攜帶 seq_id / k_intended metadata 進 RTL 與 testbench;
            「seq_id == k_applied」是一條可自動化的 assertion。<EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            驗證計畫必須同時含 absolute check 與 pair check — 只靠 pair check 會漏掉整類
            common-mode bug。<EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            random(非確定性)latency 無法用靜態 look-ahead 補償(<code>p_late</code> 洩漏項);
            設計上應讓 command pipeline 深度 deterministic。<EpistemicTag kind="INFERENCE" />
          </li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <ul>
            <li>
              L 只建模為整數 reference cycles;sub-cycle 的類比傳輸延遲歸入 §10 route skew,
              不在本章。<EpistemicTag kind="ASSUMPTION" />
            </li>
            <li>
              random extra latency 簡化為「每個 applied cycle 獨立抽 +1 拍」,未建模真實
              FIFO/handshake 的 command 碰撞與重排。<EpistemicTag kind="ASSUMPTION" />
            </li>
            <li>
              無 CDC/metastability 模型;「deterministic pipeline 深度已知」本身是一個設計
              assumption,需由 RTL 驗證。<EpistemicTag kind="ASSUMPTION" />
            </li>
          </ul>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="參數 — Chapter 12">
        <Slider
          label="latency L(cycles)"
          value={latL}
          min={0}
          max={8}
          step={1}
          onChange={(v) => setLatL(Math.round(v))}
        />
        <Slider label="α" value={alpha} min={0} max={0.25} step={0.0005} onChange={setAlpha} />
        <Toggle label="圖 #27 用 look-ahead" checked={diagLookahead} onChange={setDiagLookahead} />
        <PresetButtons
          label="Preset"
          presets={[
            {
              label: 'canonical bug(α=0.13, L=1)',
              onClick: () => {
                setAlpha(0.13);
                setLatL(1);
                setDiagLookahead(false);
              },
            },
            {
              label: 'look-ahead 修正(exp11)',
              onClick: () => {
                setAlpha(0.13);
                setLatL(1);
                setDiagLookahead(true);
              },
            },
            {
              label: 'wrap 陷阱(α=0.13, L=8)',
              onClick: () => {
                setAlpha(0.13);
                setLatL(8);
                setDiagLookahead(false);
              },
            },
          ]}
        />
      </ParamPanel>
    </ChapterShell>
  );
}
