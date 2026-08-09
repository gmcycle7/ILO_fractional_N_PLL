/**
 * Chapter 13 — Actual VCO Injection Dynamics (MODEL_SPEC §14, all APPROX).
 * Figure #21: phase response curve with stable/unstable fixed points;
 * Figure #22: convergence plot with K_inj / delta_f / noise sliders;
 * lock range check; PDR LUT CSV import UI.
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
import PhaseWheel from '../components/PhaseWheel';
import { makeLineOption, makeMarkLine } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { trimNumber } from '../lib/format';
import { chapterHref } from '../lib/router';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  simulate,
  fromPartial,
  sinFixedPointRad,
  lockCondition,
  getPreset,
  presetConfigs,
  replaceConfig,
  rms,
} from '../model';
import type { InjModel } from '../model';

const meta = chapterById(13)!;

const N_SIM = 512;
const F_REF = 4e9;
const T_REF = 1 / F_REF;

const DYNAMICS_CODE = `function deltaTheta(
  model: SimConfig['inj_model'],
  kInj: number,
  e: number,
  lutE: Float64Array | null,
  lutD: Float64Array | null,
): number {
  switch (model) {
    case 'none':
      return 0.0;
    case 'reset':
      return -e;
    case 'linear':
      return -kInj * e;
    case 'sin':
      return -kInj * Math.sin(e);
    case 'lut':
      return interpClamped(e, lutE as Float64Array, lutD as Float64Array);
    default:
      throw new Error(\`unknown inj_model '\${model as string}'\`);
  }
}

/* ... main per-reference-cycle loop (runDynamics) ... */
const tm = tpPrev + a + w;                            // a = 2*pi*Delta_f*T_ref
const e = wrapRadians(tm + epsilonHw[k] + epsRand);
const dth = deltaTheta(cfg.inj_model, cfg.k_inj, e, lutE, lutD);
const tp = wrapRadians(tm + dth);

/* ... sinusoidal-map fixed point / lock range ... */
export function sinFixedPointRad(kInj: number, deltaFHz: number, fRefHz: number): number | null {
  const a = (2.0 * Math.PI * deltaFHz) / fRefHz;
  if (kInj <= 0.0 || Math.abs(a) > kInj) {
    return null;
  }
  return Math.asin(a / kInj);
}`;

const GATING_CODE = `// web/src/model/simulate.ts — gate mask(MODEL_SPEC §14 convention)
const injFired = new Float64Array(n);
if (cfg.inj_model !== 'none') {
  for (let k = 0; k < n; k++) {
    injFired[k] =
      cfg.inj_gate_mode === 'threshold'
        ? Math.abs(eZcHw[k]) <= cfg.inj_gate_threshold_cycles
          ? 1
          : 0
        : 1;
  }
}

// web/src/model/injectionDynamics.ts — 非 fire 的拍不施加 phase kick
const dth =
  fired !== null && fired[k] === 0
    ? 0.0 // gated out: no phase kick this cycle
    : deltaTheta(cfg.inj_model, cfg.k_inj, e, lutE, lutD);
const tp = wrapRadians(tm + dth);`;

/** Gate-threshold sweep points for 圖 #22c(cycles). */
const GATE_SWEEP = [0.005, 0.01, 0.02, 0.03125, 0.0625, 0.09375, 0.125, 0.1875, 0.25, 0.375, 0.5];

function sumInt(arr: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

type UiModel = Exclude<InjModel, 'none'>;

/** Parse a two-column PDR/PRC CSV: e_inj_rad, delta_theta_rad. */
function parsePdrLut(text: string): { lut: [number, number][] | null; msg: string } {
  const rows: [number, number][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/[,;\s]+/).filter((p) => p !== '');
    if (parts.length < 2) continue;
    const e = Number(parts[0]);
    const d = Number(parts[1]);
    if (!Number.isFinite(e) || !Number.isFinite(d)) continue; // tolerate header line
    rows.push([e, d]);
  }
  if (rows.length < 2) {
    return { lut: null, msg: '需要至少 2 個數值點(每行:e_inj_rad, delta_theta_rad)' };
  }
  const eMin = Math.min(...rows.map((r) => r[0]));
  const eMax = Math.max(...rows.map((r) => r[0]));
  return {
    lut: rows,
    msg: `已載入 ${rows.length} 點,e 範圍 [${trimNumber(eMin, 4)}, ${trimNumber(eMax, 4)}] rad`,
  };
}

/** Demonstration LUT (NOT measured data): a 15%-weaker sinusoidal response. */
function exampleLutText(): string {
  const lines: string[] = ['# e_inj_rad, delta_theta_rad  (示例,非量測資料)'];
  for (let i = 0; i <= 16; i++) {
    const e = -Math.PI + (i * 2 * Math.PI) / 16;
    const d = -0.3 * 0.85 * Math.sin(e);
    lines.push(`${e.toPrecision(8)}, ${d.toPrecision(8)}`);
  }
  return lines.join('\n');
}

export default function Chapter13() {
  const [model, setModel] = useState<UiModel>('sin');
  const [kInj, setKInj] = useState(0.3);
  const [dfMhz, setDfMhz] = useState(1);
  const [sigmaW, setSigmaW] = useState(0.01);
  const [lutText, setLutText] = useState('');
  const [lut, setLut] = useState<[number, number][] | null>(null);
  const [lutMsg, setLutMsg] = useState('尚未載入 LUT');
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  // if the LUT disappears while selected, fall back to the sin map
  useEffect(() => {
    if (model === 'lut' && lut === null) setModel('sin');
  }, [model, lut]);

  const deltaFHz = dfMhz * 1e6;
  const aRad = 2 * Math.PI * deltaFHz * T_REF; // per-cycle detuning increment
  const locked = lockCondition(kInj, deltaFHz, F_REF);
  const thetaSs = sinFixedPointRad(kInj, deltaFHz, F_REF); // stable fixed point or null

  const cfgDyn = useMemo(
    () =>
      fromPartial({
        n_div: 3.125, // on-grid: epsilon_hw = 0, pure dynamics
        n_cycles: N_SIM,
        inj_model: model === 'lut' && lut === null ? 'sin' : model,
        k_inj: kInj,
        delta_f_hz: deltaFHz,
        sigma_vco_w_rad: sigmaW,
        pdr_lut: model === 'lut' && lut !== null ? lut.map((p) => [p[0], p[1]]) : null,
      }),
    [model, kInj, deltaFHz, sigmaW, lut],
  );
  const cfgNone = useMemo(
    () =>
      fromPartial({
        n_div: 3.125,
        n_cycles: N_SIM,
        inj_model: 'none',
        delta_f_hz: deltaFHz,
        sigma_vco_w_rad: sigmaW,
      }),
    [deltaFHz, sigmaW],
  );

  const resDyn = useMemo(() => simulate(cfgDyn), [cfgDyn]);
  const resNone = useMemo(() => simulate(cfgNone), [cfgNone]);

  // --- gated injection(exp21:dsm_only 生存策略)---
  const [gateTh, setGateTh] = useState(0.0625);
  const exp21cfgs = useMemo(() => presetConfigs(getPreset('exp21')), []);
  const resFull = useMemo(() => simulate(exp21cfgs[0]), [exp21cfgs]); // exp21a
  const resUngated = useMemo(() => simulate(exp21cfgs[1]), [exp21cfgs]); // exp21b
  const resGated = useMemo(
    () => simulate(replaceConfig(exp21cfgs[2], { inj_gate_threshold_cycles: gateTh })), // exp21c
    [exp21cfgs, gateTh],
  );
  const firedCount = useMemo(() => sumInt(resGated.data.inj_fired), [resGated]);
  const tailRmsGated = useMemo(() => rms(resGated.data.theta_plus.subarray(256)), [resGated]);
  const tailRmsUngated = useMemo(
    () => rms(resUngated.data.theta_plus.subarray(256)),
    [resUngated],
  );
  const gateSweep = useMemo(
    () =>
      GATE_SWEEP.map((th) => {
        const res = simulate(replaceConfig(exp21cfgs[2], { inj_gate_threshold_cycles: th }));
        return {
          th,
          frac: sumInt(res.data.inj_fired) / res.data.inj_fired.length,
          tail: rms(res.data.theta_plus.subarray(256)),
        };
      }),
    [exp21cfgs],
  );

  useEffect(() => {
    setStatus(
      'done',
      `2 × ${N_SIM} cycles, model=${model}, K=${trimNumber(kInj, 3)}, Δf=${trimNumber(dfMhz, 4)} MHz`,
    );
  }, [resDyn, resNone, model, kInj, dfMhz, setStatus]);

  // theoretical steady-state theta_minus for the mark line [APPROX]
  const thetaRef: number | null = useMemo(() => {
    if (model === 'reset') return aRad;
    if (model === 'linear') return kInj > 0 ? aRad / kInj : null;
    if (model === 'sin') return thetaSs;
    return null; // lut: no closed form
  }, [model, aRad, kInj, thetaSs]);

  // --- figure #21: phase response curve ---
  const prcOption = useMemo(() => {
    const n = 241;
    const es = Array.from({ length: n }, (_, i) => -Math.PI + (i * 2 * Math.PI) / (n - 1));
    const sinData = es.map((e) => [e, -kInj * Math.sin(e)] as [number, number]);
    const linData = es.map((e) => [e, -kInj * e] as [number, number]);
    const resetData = es.map((e) => [e, -e] as [number, number]);
    const series = [
      { name: 'sin:Δθ=−K·sin(e)', data: sinData, color: ct.accent, width: 2 },
      { name: 'linear:Δθ=−K·e', data: linData, color: ct.series[1], dashed: true },
      { name: 'reset:Δθ=−e', data: resetData, color: ct.series[5], dashed: true },
      ...(lut !== null
        ? [
            {
              name: 'LUT(imported)',
              data: [...lut].sort((p, q) => p[0] - q[0]) as [number, number][],
              color: ct.series[3],
              showSymbol: true,
              symbolSize: 5,
            },
          ]
        : []),
      ...(thetaSs !== null
        ? [
            {
              name: 'stable FP',
              data: [[thetaSs, -kInj * Math.sin(thetaSs)]] as [number, number][],
              type: 'scatter' as const,
              color: ct.good,
              symbolSize: 11,
            },
            {
              name: 'unstable FP',
              data: [[Math.PI - thetaSs, -kInj * Math.sin(Math.PI - thetaSs)]] as [
                number,
                number,
              ][],
              type: 'scatter' as const,
              color: ct.bad,
              symbolSize: 11,
            },
          ]
        : []),
    ];
    const opt = makeLineOption({
      xLabel: 'e_inj (rad)',
      yLabel: 'Δθ (rad)',
      xTickFormatter: (v) => trimNumber(v, 3),
      yTickFormatter: (v) => trimNumber(v, 3),
      series,
      zoom: false,
    });
    const o = opt as unknown as { series?: Record<string, unknown>[] };
    if (o.series && o.series[0]) {
      o.series[0].markLine = makeMarkLine([
        { y: -aRad, label: `Δθ 需求 = −a = ${trimNumber(-aRad, 4)}` },
      ]);
    }
    return opt;
  }, [kInj, aRad, thetaSs, lut, ct]);

  // --- figure #22: convergence plot ---
  const convOption = useMemo(() => {
    const xy = (arr: Float64Array) => Array.from(arr, (v, k) => [k, v] as [number, number]);
    const opt = makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: 'θ⁻[k] (rad)',
      yTickFormatter: (v) => trimNumber(v, 3),
      series: [
        {
          name: `θ⁻ (${model}, K=${trimNumber(kInj, 3)})`,
          data: xy(resDyn.data.theta_minus),
          color: ct.accent,
          width: 1.8,
        },
        {
          name: 'θ⁻ (none:無 injection)',
          data: xy(resNone.data.theta_minus),
          color: ct.series[5],
          dashed: true,
        },
      ],
    });
    if (thetaRef !== null) {
      const o = opt as unknown as { series?: Record<string, unknown>[] };
      if (o.series && o.series[0]) {
        o.series[0].markLine = makeMarkLine([
          { y: thetaRef, label: `理論穩態 θ⁻ = ${trimNumber(thetaRef, 4)} rad`, color: ct.good },
        ]);
      }
    }
    return opt;
  }, [resDyn, resNone, model, kInj, thetaRef, ct]);

  // --- 圖 #22b:dsm_only gate off vs on(exp21b vs exp21c)+ inj_fired raster ---
  const gateConvOption = useMemo(() => {
    const xy = (arr: Float64Array) => Array.from(arr, (v, k) => [k, v] as [number, number]);
    const raster: [number, number][] = [];
    const f = resGated.data.inj_fired;
    for (let k = 0; k < f.length; k++) {
      if (f[k] === 1) raster.push([k, -3.8]);
    }
    const opt = makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: 'θ⁺[k] (rad)',
      yMin: -4.3,
      yMax: 3.5,
      yTickFormatter: (v) => (v < -3.4 ? '' : trimNumber(v, 3)),
      series: [
        {
          name: 'θ⁺ dsm_only, gate off(exp21b)',
          data: xy(resUngated.data.theta_plus),
          color: ct.bad,
          width: 1,
        },
        {
          name: `θ⁺ dsm_only, gated th=${trimNumber(gateTh, 4)}(exp21c)`,
          data: xy(resGated.data.theta_plus),
          color: ct.accent,
          width: 1.8,
        },
        {
          name: 'θ⁺ full actuator(exp21a)',
          data: xy(resFull.data.theta_plus),
          color: ct.good,
          dashed: true,
        },
        {
          name: 'inj_fired = 1(gated,raster)',
          data: raster,
          type: 'scatter',
          symbolSize: 3,
          color: ct.warn,
        },
      ],
    });
    const o = opt as unknown as { series?: Record<string, unknown>[] };
    if (o.series && o.series[0]) {
      o.series[0].markLine = makeMarkLine([
        { y: Math.PI, label: '+π' },
        { y: -Math.PI, label: '−π' },
      ]);
    }
    return opt;
  }, [resGated, resUngated, resFull, gateTh, ct]);

  // --- 圖 #22c:threshold trade-off(fired fraction vs tail rms)---
  const gateSweepOption = useMemo(() => {
    const opt = makeLineOption({
      xLabel: 'inj_gate_threshold (cycles)',
      yLabel: 'rad / fraction',
      xTickFormatter: (v) => trimNumber(v, 3),
      yTickFormatter: (v) => trimNumber(v, 3),
      zoom: false,
      series: [
        {
          name: 'tail rms θ⁺(後 256 拍,rad)',
          data: gateSweep.map((p) => [p.th, p.tail] as [number, number]),
          color: ct.accent,
          width: 1.8,
          showSymbol: true,
          symbolSize: 6,
        },
        {
          name: 'fired fraction ρ',
          data: gateSweep.map((p) => [p.th, p.frac] as [number, number]),
          color: ct.series[1],
          dashed: true,
          showSymbol: true,
          symbolSize: 5,
        },
      ],
    });
    const o = opt as unknown as { series?: Record<string, unknown>[] };
    if (o.series && o.series[0]) {
      o.series[0].markLine = makeMarkLine([{ x: 0.0625, label: '預設 th=0.0625' }]);
    }
    return opt;
  }, [gateSweep, ct]);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            injection pulse 打進 VCO 後,residual phase <M>{'\\theta'}</M> 每拍怎麼移動?
            reset / linear / sin 三種 response model 差在哪?<EpistemicTag kind="APPROX" />
          </li>
          <li>
            sin map 的 fixed point 在哪?哪個穩定、哪個不穩定?lock range{' '}
            <M>{'|2\\pi\\Delta f\\,T_{ref}|\\le K_{inj}'}</M> 怎麼來?
            <EpistemicTag kind="APPROX" />
          </li>
          <li>
            <M>{'K_{inj}'}</M>、detuning <M>{'\\Delta f'}</M>、VCO noise 如何影響收斂速度與
            steady-state residual?<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>為什麼 scheduler(第 3–12 章)要先在 open-loop 驗證完,才加上 injection dynamics?</li>
          <li>transistor-level 的 PDR/PRC 曲線如何以 CSV LUT 匯入取代 sin map?</li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          把 VCO residual phase 想成一顆珠子:每拍 detuning 把它往一邊推{' '}
          <M>{'a=2\\pi\\Delta f\\,T_{ref}'}</M> rad,noise 隨機晃它;injection pulse 每拍把它往
          zero crossing「拉一把」,拉力大小取決於當下的 phase error。sin map 下拉力是{' '}
          <M>{'-K_{inj}\\sin(e)'}</M>:error 小時近似線性,error 接近 ±π 時拉力消失 —
          珠子停在「拉回量恰好抵銷漂移」的地方,這就是 fixed point。
          <EpistemicTag kind="APPROX" />
        </p>
        <p>
          分層驗證的理由:injection loop 是一個會「自我修正」的機制,任何 deterministic 的
          scheduler bug(例如第 12 章的 46.8° latency error)進了閉環後會被吸收成一個固定的
          correction,表面上只是 residual 稍大或 lock point 偏移 — bug 被 loop 藏起來。因此本
          專案先以 <em>exact digital</em> 的 open-loop 條件驗證 scheduler(<M>{'e_{abs}'}</M>、
          <M>{'e_{pair}'}</M>、seq_id 全部逐位檢查),確認無誤後才把 [APPROX] 的 dynamics
          疊上去。<EpistemicTag kind="INFERENCE" />
        </p>
        {thetaSs !== null ? (
          <PhaseWheel
            markers={[
              {
                angleCycles: thetaSs / (2 * Math.PI),
                label: `stable ${trimNumber(thetaSs, 3)} rad`,
                color: ct.good,
              },
              {
                angleCycles: (Math.PI - thetaSs) / (2 * Math.PI),
                label: 'unstable',
                color: ct.bad,
                r: 0.6,
              },
            ]}
            title={
              <span>
                sin map 的兩個 fixed point(目前 K={trimNumber(kInj, 3)}, Δf=
                {trimNumber(dfMhz, 4)} MHz):相位收斂到綠色點;紅色點一受擾動就離開。
                <EpistemicTag kind="APPROX" />
              </span>
            }
          />
        ) : (
          <Callout type="warn" title="目前參數超出 lock range">
            <p>
              |a| = {trimNumber(Math.abs(aRad), 4)} rad &gt; K_inj = {trimNumber(kInj, 3)}:sin map
              沒有 fixed point,phase 會 cycle slipping(見圖 #22)。
            </p>
          </Callout>
        )}
      </SectionIntuition>

      <SectionMath>
        <p>
          residual phase <M>{'\\theta'}</M>(rad;deterministic trajectory 已移除)。每個
          reference cycle 一次 injection:<EpistemicTag kind="ASSUMPTION" />
        </p>
        <MathBlock>
          {
            '\\theta^{-}[k] = \\theta^{+}[k-1] + \\underbrace{2\\pi\\,\\Delta f\\,T_{ref}}_{a} + w_{vco}[k]'
          }
        </MathBlock>
        <MathBlock>
          {
            'e_{inj}[k] = \\operatorname{wrapRadians}\\big(\\theta^{-}[k] + \\varepsilon_{hw}[k]\\big),\\qquad \\varepsilon_{hw}[k] = 2\\pi\\, e_{ZC,hw}[k]'
          }
        </MathBlock>
        <p>三種 injection response(behavioral):</p>
        <MathBlock>
          {
            '\\Delta\\theta[k] = \\begin{cases} -\\,e_{inj}[k] & \\text{reset} \\\\ -K_{inj}\\, e_{inj}[k] & \\text{linearized} \\\\ -K_{inj}\\, \\sin(e_{inj}[k]) & \\text{sinusoidal} \\end{cases}'
          }
        </MathBlock>
        <p>
          reset 為理想上限 <EpistemicTag kind="ASSUMPTION" />;linear 與 sin 為近似{' '}
          <EpistemicTag kind="APPROX" />。更新式:
        </p>
        <MathBlock>
          {'\\theta^{+}[k] = \\operatorname{wrapRadians}\\big(\\theta^{-}[k] + \\Delta\\theta[k]\\big)'}
        </MathBlock>
        <p>
          <strong>Fixed point 與 lock range(sin map)</strong>
          <EpistemicTag kind="APPROX" />。穩態要求每拍的拉回量恰好抵銷 detuning:
          <M>{'\\Delta\\theta = -a'}</M>,即
        </p>
        <MathBlock>
          {
            'K_{inj}\\sin(\\theta_{ss}) = 2\\pi\\,\\Delta f\\,T_{ref} \\quad\\Rightarrow\\quad \\text{lock condition: } |2\\pi\\,\\Delta f\\,T_{ref}| \\le K_{inj}'
          }
        </MathBlock>
        <p>
          在 <M>{'(-\\pi,\\pi]'}</M> 內有兩個解:<M>{'\\theta_{ss}=\\arcsin(a/K_{inj})'}</M> 與{' '}
          <M>{'\\pi-\\theta_{ss}'}</M>。對 map 線性化,擾動增益為{' '}
          <M>{'1-K_{inj}\\cos(\\theta_{ss})'}</M>;local stability 要求
        </p>
        <MathBlock>
          {
            '|1 - K_{inj}\\cos(\\theta_{ss})| < 1 \\;\\Rightarrow\\; \\cos(\\theta_{ss}) > 0 \\text{ 的解為 stable}'
          }
        </MathBlock>
        <p>
          linear map 的穩態為 <M>{'\\theta_{ss}=a/K_{inj}'}</M>、reset 為{' '}
          <M>{'\\theta_{ss}=a'}</M>(每拍歸零後再漂 a)。<M>{'K_{inj}\\to 0'}</M>:無 injection,
          phase 變成 detuning ramp + random walk;<M>{'K_{inj}'}</M> 增大:收斂更快、residual
          更小。<EpistemicTag kind="APPROX" />
        </p>
      </SectionMath>

      <SectionMath>
        <p>
          <strong>Gated injection(MODEL_SPEC §14)。</strong>digital gate 的定義{' '}
          <EpistemicTag kind="EXACT" />:threshold mode 下第 k 拍 fire 若且唯若
        </p>
        <MathBlock>
          {
            '\\mathrm{inj\\_fired}[k] = \\big(\\,|e_{ZC,hw}[k]| \\le \\mathrm{th}\\,\\big), \\qquad \\Delta\\theta[k] = 0 \\;\\text{且}\\; \\theta^{+}[k] = \\operatorname{wrapRadians}(\\theta^{-}[k]) \\;\\text{當不 fire}'
          }
        </MathBlock>
        <p>
          gate 判準用的是 <strong>deterministic</strong> 的 <M>{'e_{ZC,hw}'}</M>(scheduler
          可以在 pulse 之前就算出來),而不是含 noise 的 <M>{'e_{inj}'}</M>;非 fire 的拍{' '}
          <M>{'\\theta'}</M> 照常累積 detuning 與 noise,PRNG 消耗也與 gating 無關。
          <M>{'\\mathrm{inj\\_fired}'}</M> convention:inj_model=none 恆 0;gate off 恆 1。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>
          <strong>為什麼 gating 是生存策略。</strong>full actuator 下 |e_ZC_hw| ≤ half-LSB
          量級,每拍 kick 都落在 stable fixed point 附近的近線性區,gate 沒有必要。但{' '}
          <a href={chapterHref('rounding-vs-phase-dsm')}>第 11 章</a>的 dsm_only 情境
          (classic divider-modulating DSM,無 PMUX/DTC/tap actuator)把 quantization 放在
          <strong>整數 VCO cycle</strong> granularity:
        </p>
        <MathBlock>
          {'e_{ZC,hw}[k] = \\operatorname{wrapCycles}(x_{ideal}[k] - z_0) \\in (-0.5, 0.5]\\ \\text{cycle} \\;\\Rightarrow\\; \\varepsilon_{hw} = 2\\pi\\,e_{ZC,hw} \\in (-\\pi, \\pi]\\ \\text{rad}'
          }
        </MathBlock>
        <p>
          scheduling error 掃過整個 wrap 範圍,超出 sin map 的 lock-in basin(basin 邊界即
          unstable fixed point <M>{'\\pi-\\theta_{ss}'}</M>):kick 抵達時的{' '}
          <M>{'e_{inj}'}</M> 可以落在拉力反向或近零的區域 — 這正是
          <a href={chapterHref('injection-tap-mapping')}>第 7 章</a>的 mod-1 ambiguity:phase
          目標只定義到 mod 1 cycle,誤差接近半個 cycle 時「最近的 zero crossing」會換到另一個
          edge,kick 等效指向錯誤方向。每拍一個 full-range 的 <M>{'\\varepsilon_{hw}'}</M>{' '}
          等同持續的大擾動,實測直接失鎖(exp21b:tail rms 1.81 rad)。
          <EpistemicTag kind="EXPERIMENT" />
        </p>
        <p>
          <strong>Effective correction rate 與 trade-off。</strong>dsm_only 的{' '}
          <M>{'e_{ZC,hw}'}</M> 近似均勻分布在 ±0.5 cycle,所以 fire 機率{' '}
          <M>{'\\rho(\\mathrm{th}) \\approx 2\\,\\mathrm{th}'}</M>
          <EpistemicTag kind="APPROX" />(實測 th=0.0625 → 67/512 = 13.1%,th=0.25 → 51.0%)。
          兩個競爭項:fire 的拍 placement error 上限 <M>{'2\\pi\\,\\mathrm{th}'}</M>
          (th 越小 kick 越準),但 fire 間隔約 <M>{'1/\\rho'}</M> 拍內 detuning 漂移{' '}
          <M>{'a/\\rho'}</M>(th 越小 kick 越稀疏、漂移越大)。把 lock condition 用平均修正量
          改寫,得 gated 的有效條件 <M>{'|a| \\lesssim \\rho\\,K_{inj}'}</M>
          <EpistemicTag kind="INFERENCE" />。兩項拉鋸 → 存在最佳 threshold(圖 #22c)。
        </p>
        <p>
          <strong>PLL loop 與 injection 的互動(qualitative)。</strong>真實系統裡 PLL loop
          與 injection 同時作用在同一個 VCO 上,分工是:<strong>frequency correction 留給
          loop</strong>(loop integrator 把平均 frequency error 積分到零,等效把本章的{' '}
          <M>{'\\Delta f \\to 0'}</M>、<M>{'\\theta_{ss}\\to 0'}</M>);
          <strong>cycle-to-cycle jitter 留給 injection</strong>(loop bandwidth 外的快速
          phase error 只有每拍一次的 kick 追得上)。loop 的 phase detector 取樣到的是
          injection <strong>修正後</strong>的 phase(<M>{'\\theta^{+}'}</M> 一側)— injection
          已移除的 jitter,loop 看不到。<EpistemicTag kind="INFERENCE" />
        </p>
        <p>
          風險:injection 若留下 <strong>static phase offset</strong>(ε_hw 的固定分量、route
          skew、tap offset,或 <M>{'\\theta_{ss}'}</M> 本身),loop integrator 會把它當成
          phase error 持續積分,推動 VCO 頻率去抵銷 — 但 injection 每拍又把 phase 拉回原處。
          兩個 actuator 對同一節點角力,平衡點落在「loop 看到的平均 error 為零、卻帶著非零
          detuning」的狀態:此時每個 injection kick 都非零,pulse 擾動能量與 spur 隨之變大,
          loop bandwidth 太高時甚至可能出現慢速 limit cycle。設計上要嘛把 injection 的
          static offset 校正到零(第 15 章 calibrated mapping),要嘛讓 loop 對 injection
          residual 的可見度降低(gated integrator / 降 BW)。<EpistemicTag kind="INFERENCE" />
        </p>
        <Callout type="warn" title="ASSUMPTION — 本模型不 co-simulate PLL loop">
          <p>
            本章的 θ 遞迴只有固定 detuning <M>{'\\Delta f'}</M> 與 noise,<strong>沒有</strong>{' '}
            loop filter / integrator 狀態(<M>{'\\Delta f'}</M> 不隨 θ 回授更新)。上兩段的
            loop–injection 互動是定性推論,本 model 無法給數字。co-simulation 需要加入:PFD
            對 <M>{'\\theta^{+}'}</M> 的取樣、loop filter 狀態(<M>{'K_p, K_i'}</M>)、每拍更新
            的 <M>{'\\Delta f[k]'}</M> 與 loop 延遲,才能量化 contention 的平衡 detuning、
            kick 振幅分布、spur level 對 loop BW 的關係與雙 actuator 的穩定裕度。
            <EpistemicTag kind="ASSUMPTION" />
          </p>
        </Callout>
      </SectionMath>

      <SectionExample>
        <p>
          手算(<M>{'K_{inj}=0.3,\\ \\Delta f = 1\\,\\mathrm{MHz},\\ T_{ref}=250\\,\\mathrm{ps}'}</M>):
        </p>
        <ul>
          <li>
            <M>{'a = 2\\pi \\times 10^{6} \\times 250\\times10^{-12} = 1.5708\\times10^{-3}'}</M>{' '}
            rad/cycle。
          </li>
          <li>
            <M>{'\\theta_{ss} = \\arcsin(a/K_{inj}) = \\arcsin(5.236\\times10^{-3}) = 5.236\\times10^{-3}'}</M>{' '}
            rad = 0.300°。<EpistemicTag kind="APPROX" />
          </li>
          <li>
            lock edge:
            <M>
              {'\\Delta f_{max} = \\dfrac{K_{inj}}{2\\pi T_{ref}} = \\dfrac{0.3}{2\\pi\\times 250\\,\\mathrm{ps}} = 190.99\\ \\mathrm{MHz}'}
            </M>
            。
          </li>
        </ul>
        <p>
          目前 slider:a = {trimNumber(aRad, 4)} rad,K_inj = {trimNumber(kInj, 3)},lock check{' '}
          <M>{'|a|\\le K_{inj}'}</M>:{' '}
          <strong>{locked ? '在 lock range 內' : '超出 lock range(cycle slipping)'}</strong>
          {thetaSs !== null && (
            <span>
              ,θ_ss = {trimNumber(thetaSs, 4)} rad ={' '}
              {trimNumber((thetaSs * 360) / (2 * Math.PI), 4)}°
            </span>
          )}
          。<EpistemicTag kind="APPROX" />
        </p>
      </SectionExample>

      <SectionFigure
        title={`圖 #21 — Injection phase response curve(K_inj=${trimNumber(kInj, 3)})`}
        caption={
          <span>
            橫軸 e_inj(rad),縱軸單拍 phase correction Δθ(rad)。虛線水平線 = 穩態需求 Δθ =
            −a;它與 sin 曲線的交點即 fixed points:綠點 stable(cos θ_ss &gt; 0)、紅點
            unstable。linear 與 reset map 供對照;匯入 LUT 後以點列顯示(model 內部做 linear
            interpolation,超出端點 clamp)。<EpistemicTag kind="APPROX" />
          </span>
        }
      >
        <EChart option={prcOption} height={320} />
        <div style={{ marginTop: 12 }}>
          <p style={{ marginBottom: 6 }}>
            <strong>PDR/PRC LUT CSV 匯入</strong>(兩欄:<code>e_inj_rad, delta_theta_rad</code>;
            <code>#</code> 開頭為註解;{lutMsg})
          </p>
          <textarea
            value={lutText}
            onChange={(e) => setLutText(e.target.value)}
            rows={5}
            spellCheck={false}
            style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
            placeholder={'# e_inj_rad, delta_theta_rad\n-3.14159, 0.0\n0.0, 0.0\n1.5708, -0.25'}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                void f.text().then((t) => {
                  setLutText(t);
                  const p = parsePdrLut(t);
                  setLut(p.lut);
                  setLutMsg(p.msg);
                  if (p.lut !== null) setModel('lut');
                });
              }}
            />
            <button
              type="button"
              className="preset-button"
              onClick={() => {
                const p = parsePdrLut(lutText);
                setLut(p.lut);
                setLutMsg(p.msg);
                if (p.lut !== null) setModel('lut');
              }}
            >
              解析文字框
            </button>
            <button
              type="button"
              className="preset-button"
              onClick={() => {
                const t = exampleLutText();
                setLutText(t);
                const p = parsePdrLut(t);
                setLut(p.lut);
                setLutMsg(`${p.msg}(示例,非量測資料)`);
                if (p.lut !== null) setModel('lut');
              }}
            >
              載入示例 LUT
            </button>
            <button
              type="button"
              className="preset-button"
              onClick={() => {
                setLut(null);
                setLutText('');
                setLutMsg('尚未載入 LUT');
              }}
            >
              清除
            </button>
          </div>
        </div>
      </SectionFigure>

      <SectionFigure
        title={`圖 #22 — Convergence:θ⁻[k] 軌跡(model=${model}, N=3.125)`}
        caption={
          <span>
            實線 = 選定 injection model 的 θ⁻[k];虛線 = 無 injection(K→0 極限):同樣的
            detuning 與 noise 下 phase 漂移並在 ±π wrap。綠色標線 = 理論穩態(sin:asin(a/K);
            linear:a/K;reset:a)。lock check:|a| = {trimNumber(Math.abs(aRad), 4)} rad{' '}
            {locked ? '≤' : '>'} K_inj = {trimNumber(kInj, 3)} →{' '}
            {locked ? 'locked' : 'cycle slipping'}。N=3.125 為 on-grid,ε_hw ≡ 0,看到的是純
            dynamics。<EpistemicTag kind="APPROX" /> <EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <EChart option={convOption} height={320} />
      </SectionFigure>

      <SectionFigure
        title="圖 #22b — Gated injection:dsm_only gate off vs on(exp21b vs exp21c)"
        caption={
          <span>
            exp21 config:N=3.13、ef1、dsm_only actuator、sin K_inj=0.4、Δf=1 MHz、σ_vco_w=0.02
            rad、seed 12345。紅線 = gate off:ε_hw 全範圍掃動,θ⁺ 失鎖(tail rms 1.81 rad);
            藍線 = threshold gating:只在 |e_ZC_hw| ≤ th 時 fire,鎖回有界 residual(th=0.0625
            時 tail rms 0.102 rad、fire 67/512 = 13.1%);綠虛線 = full actuator 對照(exp21a,
            tail rms 0.015 rad)。底部黃色 raster = gated config 的 inj_fired=1 拍(gate off 時
            恆為 1,不畫)。<EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <EChart option={gateConvOption} height={340} />
        <div style={{ maxWidth: 420, marginTop: 8 }}>
          <Slider
            label="inj_gate_threshold"
            value={gateTh}
            min={0.005}
            max={0.5}
            step={0.005}
            unit="cycle"
            onChange={setGateTh}
          />
        </div>
        <p style={{ marginTop: 6 }}>
          目前 th = {trimNumber(gateTh, 4)} cycle(= {trimNumber(gateTh * 360, 4)}°):fire{' '}
          {firedCount}/512({trimNumber((firedCount / 512) * 100, 3)}%,ρ≈2·th 預測{' '}
          {trimNumber(2 * gateTh * 100, 3)}%);tail rms θ⁺(後 256 拍)gated ={' '}
          {trimNumber(tailRmsGated, 4)} rad vs ungated = {trimNumber(tailRmsUngated, 4)} rad。
          <EpistemicTag kind="EXPERIMENT" />
        </p>
      </SectionFigure>

      <SectionFigure
        title="圖 #22c — Effective correction rate vs threshold(exp21c 掃描)"
        caption={
          <span>
            橫軸 inj_gate_threshold(cycles),實線 = tail rms θ⁺(後 256 拍,rad),虛線 =
            fired fraction ρ。兩端都變差:th 太小 → kick 準但太稀疏,fire 間隔內的 detuning
            漂移主導(th=0.005:ρ=1.2%、rms 0.149 rad);th 太大 → kick 常見但 placement error
            上限 2π·th 變大,直到 th=0.5(≡ gate off)完全失鎖(rms 1.81 rad)。本 config
            最佳區間約 th ≈ 0.02–0.03(rms 0.068–0.081 rad @ ρ = 4.7–7.0%);預設 0.0625 =
            1/16 cycle 是偏保守的整數冪次選擇(rms 0.102 rad)。單次 seed 12345 量測,非統計
            平均。<EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <EChart option={gateSweepOption} height={300} />
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model/injectionDynamics.ts — response models 與 fixed point(節錄)"
        code={DYNAMICS_CODE}
      />

      <SectionCode
        language="typescript"
        title="web/src/model/simulate.ts + injectionDynamics.ts — injection gating(節錄)"
        code={GATING_CODE}
      >
        <p>
          gate mask 由 deterministic 的 <code>e_ZC_hw</code> 計算(§14 convention),dynamics
          迴圈在非 fire 拍直接令 <code>dth = 0</code> — θ 照常累積 detuning 與 noise,
          <code>e_inj</code> 仍照常記錄(「若 fire 會看到的誤差」)。
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'const tm = tpPrev + a + w;',
            explain: (
              <span>
                拍間演化 <EpistemicTag kind="ASSUMPTION" />:上一拍 post-injection phase 加上
                detuning 增量 <M>{'a=2\\pi\\Delta f\\,T_{ref}'}</M> 與該拍 VCO noise(white +
                random walk,獨立 PRNG stream)。
              </span>
            ),
          },
          {
            code: 'const e = wrapRadians(tm + epsilonHw[k] + epsRand);',
            explain: (
              <span>
                pulse 抵達時的總 phase error:VCO residual + deterministic 硬體排程誤差{' '}
                <M>{'\\varepsilon_{hw}=2\\pi e_{ZC,hw}'}</M>(§5.1)+ ref/pulse jitter。wrap 到
                (−π, π] — injection 只「看得到」wrap 後的 error。
              </span>
            ),
          },
          {
            code: "case 'reset': return -e;",
            explain: (
              <span>
                理想 reset <EpistemicTag kind="ASSUMPTION" />:phase 一拍拉到 pulse 位置。若{' '}
                <M>{'\\varepsilon_{hw}\\ne 0'}</M>,VCO 停在 <M>{'-\\varepsilon_{hw}'}</M> —
                硬體排程錯多少,鎖完就偏多少。
              </span>
            ),
          },
          {
            code: "case 'sin': return -kInj * Math.sin(e);",
            explain: (
              <span>
                sinusoidal map <EpistemicTag kind="APPROX" />:小 error 時 ≈ −K·e(linear),
                大 error 時拉力衰減,|e|→π 時歸零 — 這給出 lock range 與兩個 fixed point。
              </span>
            ),
          },
          {
            code: "case 'lut': return interpClamped(e, lutE, lutD);",
            explain: (
              <span>
                匯入的 PDR/PRC 曲線:linear interpolation,超出範圍 clamp 至端點值(MODEL_SPEC
                §14 CSV 契約)。
              </span>
            ),
          },
          {
            code: 'const tp = wrapRadians(tm + dth);',
            explain: <span>post-injection phase,成為下一拍遞迴的起點。</span>,
          },
          {
            code: 'if (kInj <= 0.0 || Math.abs(a) > kInj) { return null; }',
            explain: (
              <span>
                lock condition <M>{'|a|\\le K_{inj}'}</M> 的程式形式:不滿足就沒有 fixed
                point(回傳 null),對應圖 #22 的 cycle slipping。
              </span>
            ),
          },
          {
            code: 'return Math.asin(a / kInj);',
            explain: (
              <span>
                取 <M>{'\\cos\\theta_{ss}>0'}</M> 分支(asin 值域即此分支)— 即 stable fixed
                point;<M>{'\\pi-\\theta_{ss}'}</M> 為 unstable。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            圖 #21:水平虛線(−a)與 sin 曲線的兩個交點就是 fixed points;調大 Δf 使虛線下移,
            兩點互相靠近,<M>{'|a|=K_{inj}'}</M> 時合併消失(lock edge)。
            <EpistemicTag kind="APPROX" />
          </li>
          <li>
            圖 #22:preset「弱 K=0.05」與「強 K=0.6」(experiment 15)— 強 injection 收斂拍數
            明顯較少、穩態抖動較小。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>K_inj 拉到 0.01:實線幾乎貼上虛線(none)— 拉不住,detuning ramp 主導。</li>
          <li>
            Δf 拉超過 lock edge(preset「失鎖」:K=0.1、Δf=120 MHz,|a|=0.188 &gt; 0.1):θ⁻
            不再收斂到常數,呈週期性 slip;綠色穩態線消失。
          </li>
          <li>
            reset model:一拍到位,軌跡立即落在 a 附近 — injection 效果的理論上限,不是可實現
            電路。<EpistemicTag kind="ASSUMPTION" />
          </li>
          <li>
            模擬穩態值與綠色理論線重合(殘差為 noise floor)。<EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout
          type="warn"
          title="誤解 1:「behavioral K_inj 可以直接換算 silicon 的 injection strength」"
        >
          <p>
            K_inj 是 lumped、每拍一次的離散 map 增益,把 pulse 寬度、注入位置、tank Q、swing
            等全部濃縮成一個數。它能重現趨勢(lock range、收斂速率),但數值不可直接對應
            電晶體級 — 真實 phase response 需 transistor-level transient/PSS/PDR extraction,
            再以 LUT 匯入。<EpistemicTag kind="APPROX" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解 2:「直接在閉環模擬裡驗 scheduler 就好」">
          <p>
            閉環會把 deterministic scheduler bug 吸收成固定 correction:第 12 章的 46.8°
            latency error 在閉環裡只表現為「residual 稍大 / lock point 偏移」,容易被誤判為
            analog 問題。先 open-loop 逐位驗證 exact digital scheduler,再加 [APPROX]
            dynamics,層次不可顛倒。<EpistemicTag kind="INFERENCE" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>
            設計檢查一行:<M>{'|2\\pi\\Delta f\\,T_{ref}|\\le K_{inj}'}</M>。以 K_inj 的保守估計
            回推可容忍的 free-running detuning(K=0.3 → ±191 MHz)。
            <EpistemicTag kind="APPROX" />
          </li>
          <li>
            穩態 residual <M>{'\\theta_{ss}=\\arcsin(a/K_{inj})'}</M> 隨 K_inj 增大而縮小 — 但
            K_inj 受 pulse 能量 / spur trade-off 限制(第 14、16 章)。
            <EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            驗證流程分層:exact scheduler(open-loop, bit-exact)→ APPROX dynamics(趨勢)→
            transistor-level PDR LUT(替換 sin map)。介面已就緒:CSV 兩欄即可。
          </li>
          <li>
            scheduling error 可能超出 lock-in basin 時(dsm_only:±0.5 cycle),threshold
            gating 是生存策略:實測 tail rms 1.81 rad(ungated)→ 0.102 rad(th=0.0625)。
            threshold 是 placement error(∝ th)與 correction rate(ρ ≈ 2·th)的 trade-off,
            存在最佳值(本 config 約 0.02–0.03 cycle);有效 lock 條件近似{' '}
            <M>{'|a| \\lesssim \\rho K_{inj}'}</M>。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            loop / injection 分工:frequency correction 屬 loop、cycle-to-cycle jitter 屬
            injection;injection 的 static offset 會被 loop integrator 誤讀並積分 — 要嘛校正到
            零,要嘛降低 loop 對它的可見度。<EpistemicTag kind="INFERENCE" />
          </li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <ul>
            <li>
              本章全部結論屬 <EpistemicTag kind="APPROX" />:每 reference cycle 一次的離散 phase
              map,無 pulse 寬度、無單一 T_vco 內多次注入、無 amplitude dynamics(AM-PM
              未建模)。
            </li>
            <li>
              sin map 只是 injection locking 的一階近似;真實 PDR 形狀、非對稱性、injection
              點的 tank loading 都需電晶體級萃取。
            </li>
            <li>LUT 模式也只是 static map:假設 phase response 不隨 amplitude/溫度/corner 變化。</li>
            <li>
              本模型<strong>不</strong> co-simulate PLL loop:θ 遞迴含固定 detuning,無 loop
              filter/integrator(Δf 不隨 θ 回授)。loop–injection 互動(integrator 對 injection
              static offset 的積分、contention 平衡點、spur vs loop BW)僅為定性推論;量化需要
              加入 PFD 取樣、LF 狀態與 per-cycle Δf 更新的 co-simulation。
              <EpistemicTag kind="ASSUMPTION" />
            </li>
            <li>
              gate 是理想數位決策:非 fire 拍完全無 kick(Δθ=0),不含真實電路 gate-off 時的
              殘餘 pulse 能量或 partial suppression。<EpistemicTag kind="ASSUMPTION" />
            </li>
            <li>本專案未執行 Spectre;behavioral result 不等同 silicon result(MODEL_SPEC §20)。</li>
          </ul>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="參數 — Chapter 13">
        <SelectControl<UiModel>
          label="injection model"
          value={model}
          options={[
            { value: 'reset', label: 'reset(理想上限)' },
            { value: 'linear', label: 'linear' },
            { value: 'sin', label: 'sin' },
            ...(lut !== null ? [{ value: 'lut' as UiModel, label: 'lut(imported)' }] : []),
          ]}
          onChange={setModel}
        />
        <Slider label="K_inj" value={kInj} min={0} max={1} step={0.01} onChange={setKInj} />
        <Slider
          label="Δf(detuning)"
          value={dfMhz}
          min={0}
          max={200}
          step={1}
          unit="MHz"
          onChange={setDfMhz}
        />
        <Slider
          label="σ_vco_w(white)"
          value={sigmaW}
          min={0}
          max={0.05}
          step={0.001}
          unit="rad"
          onChange={setSigmaW}
        />
        <PresetButtons
          label="Preset(experiment 15 / lock edge)"
          presets={[
            {
              label: '弱 K=0.05',
              onClick: () => {
                setModel('sin');
                setKInj(0.05);
                setDfMhz(1);
                setSigmaW(0.01);
              },
            },
            {
              label: '強 K=0.6',
              onClick: () => {
                setModel('sin');
                setKInj(0.6);
                setDfMhz(1);
                setSigmaW(0.01);
              },
            },
            {
              label: '失鎖 K=0.1, Δf=120M',
              onClick: () => {
                setModel('sin');
                setKInj(0.1);
                setDfMhz(120);
                setSigmaW(0);
              },
            },
            {
              label: 'K→0',
              onClick: () => {
                setModel('sin');
                setKInj(0.01);
                setDfMhz(1);
                setSigmaW(0.01);
              },
            },
          ]}
        />
      </ParamPanel>
    </ChapterShell>
  );
}
