/**
 * Chapter 11 — Fixed Rounding versus Phase DSM 固定捨入與 Phase DSM 之比較
 *
 * Content contract: CHAPTER_GUIDE.md Ch11; math contract: MODEL_SPEC.md
 * section 6 (0.3-LSB canonical case, quantizer definitions, dither),
 * section 17 (PSD/dBc conventions); experiments 7 / 8 / 9.
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
import { makeLineOption } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import {
  phaseAxisLabel,
  makePhaseTickFormatter,
  formatSiTime,
  trimNumber,
} from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  simulate,
  replaceConfig,
  getPreset,
  presetConfigs,
  makeQuantizer,
  histogram,
  periodogramPsd,
  psdToDbcPerHz,
  detectSpurs,
  db10,
  rms,
  mean,
  peakToPeak,
  cyclesToRadians,
} from '../model';
import type { Quantizer, SimResult, Spur } from '../model';

const meta = chapterById(11)!;
const NC = 1024; // power of 2 -> full length used by the Hann periodogram

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
  { value: 'mash111', label: 'mash111(MASH 1-1-1)' },
];

interface Metrics {
  meanLsb: number;
  rmsLsb: number;
  peakLsb: number;
  p2pLsb: number;
}

function metricsOf(res: SimResult): Metrics {
  const e = res.data.e_FB_abs;
  const g = res.g;
  let peak = 0;
  for (let i = 0; i < e.length; i++) {
    const a = Math.abs(e[i]);
    if (a > peak) peak = a;
  }
  return {
    meanLsb: mean(e) * g,
    rmsLsb: rms(e) * g,
    peakLsb: peak * g,
    p2pLsb: peakToPeak(e) * g,
  };
}

function psdOf(res: SimResult): { pts: [number, number][]; spurs: Spur[] } {
  const e = res.data.e_FB_abs;
  const rad = new Float64Array(e.length);
  for (let i = 0; i < e.length; i++) {
    rad[i] = cyclesToRadians(e[i]);
  }
  const { freqsHz, psd } = periodogramPsd(rad, 1 / res.t_ref_s);
  const dbc = psdToDbcPerHz(psd);
  const pts: [number, number][] = [];
  for (let i = 1; i < freqsHz.length; i++) {
    // skip the DC bin: a nonzero mean is a static offset, not a spur
    pts.push([freqsHz[i] / 1e6, dbc[i]]);
  }
  const spurs = detectSpurs(freqsHz, psd, 10).slice(0, 5);
  return { pts, spurs };
}

export default function Chapter11() {
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();
  const [quant, setQuant] = useState<Quantizer>('ef1');
  const [dither, setDither] = useState(0);

  // canonical 0.3-LSB case (MODEL_SPEC section 6): u[k] = m[k] + 0.3, m = 0
  const canonical = useMemo(() => {
    const qn = makeQuantizer('nearest');
    const qe = makeQuantizer('ef1');
    const nearestPts: [number, number][] = [];
    const ef1Pts: [number, number][] = [];
    const rows: { k: number; eIn: number; v: number; y: number; eOut: number; err: number }[] = [];
    for (let k = 0; k < 40; k++) {
      const u = 0.3;
      const eIn = qe.state;
      const yN = qn.quantize(u);
      const yE = qe.quantize(u);
      nearestPts.push([k, yN - u]);
      ef1Pts.push([k, yE - u]);
      if (k < 8) {
        rows.push({ k, eIn, v: u + eIn, y: yE, eOut: qe.state, err: yE - u });
      }
    }
    return { nearestPts, ef1Pts, rows };
  }, []);

  // full-chain experiments 7 (nearest baseline) / 8 (selected quantizer)
  const base = useMemo(() => presetConfigs(getPreset('exp07'))[0], []);
  const simNearest = useMemo(
    () => simulate(replaceConfig(base, { n_cycles: NC, quantizer: 'nearest', dither_amp_lsb: 0 })),
    [base],
  );
  const simSel = useMemo(
    () =>
      simulate(replaceConfig(base, { n_cycles: NC, quantizer: quant, dither_amp_lsb: dither })),
    [base, quant, dither],
  );
  // experiment 9: shared (mode D) vs independent (mode B) phase DSM pair error
  const pairSims = useMemo(
    () => presetConfigs(getPreset('exp09')).map((c) => simulate(replaceConfig(c, { n_cycles: 256 }))),
    [],
  );

  // taxonomy (1): experiment 22 — DSM 階數比較(full actuator、mode D、512 cycles)
  const exp22Sims = useMemo(() => presetConfigs(getPreset('exp22')).map((c) => simulate(c)), []);
  // taxonomy (2): experiment 21 — full vs dsm_only ungated vs dsm_only gated(512 cycles)
  const exp21Sims = useMemo(() => presetConfigs(getPreset('exp21')).map((c) => simulate(c)), []);
  const [gateThr, setGateThr] = useState(0.0625);
  const gatedSim = useMemo(
    () =>
      simulate(
        replaceConfig(presetConfigs(getPreset('exp21'))[2], {
          inj_gate_threshold_cycles: gateThr,
        }),
      ),
    [gateThr],
  );

  const taxStats = useMemo(() => {
    const nIntSet = (r: SimResult): string => {
      const s = new Set<number>();
      const ni = r.data.n_int;
      for (let i = 0; i < ni.length; i++) s.add(ni[i]);
      return `{${[...s].sort((a, b) => a - b).join(',')}}`;
    };
    const m22 = exp22Sims.map((r) => {
      const e = r.data.e_FB_abs;
      let peak = 0;
      for (let i = 0; i < e.length; i++) peak = Math.max(peak, Math.abs(e[i]));
      return {
        quant: r.config.quantizer,
        rmsLsb: rms(e) * r.g,
        peakLsb: peak * r.g,
        ezcRms: rms(r.data.e_ZC_total),
        nInt: nIntSet(r),
      };
    });
    const fired = (r: SimResult): number => {
      let s = 0;
      const f = r.data.inj_fired;
      for (let i = 0; i < f.length; i++) s += f[i];
      return s;
    };
    const tail = (r: SimResult): number => rms(r.data.theta_plus.subarray(256));
    const m21 = exp21Sims.map((r) => ({ fired: fired(r), tail: tail(r) }));
    return { m22, m21, gFired: fired(gatedSim), gTail: tail(gatedSim) };
  }, [exp22Sims, exp21Sims, gatedSim]);

  useEffect(() => {
    setStatus('done', `exp07/08: ${NC} cycles ×2, exp09: 256 ×2, exp21/22: 512 ×7`);
  }, [simNearest, simSel, pairSims, exp21Sims, exp22Sims, gatedSim, setStatus]);

  const tVco = simNearest.t_vco_s;
  const g = simNearest.g;
  const mN = useMemo(() => metricsOf(simNearest), [simNearest]);
  const mS = useMemo(() => metricsOf(simSel), [simSel]);
  const pairStats = useMemo(
    () => ({
      rmsD: rms(pairSims[0].data.e_pair_digital) * g,
      rmsB: rms(pairSims[1].data.e_pair_digital) * g,
    }),
    [pairSims, g],
  );

  const optCanonical = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k',
        yLabel: 'error (LSB)',
        series: [
          {
            name: 'nearest:固定 −0.3',
            data: canonical.nearestPts,
            step: 'middle',
            showSymbol: true,
            symbolSize: 4,
            color: ct.accent,
          },
          {
            name: 'ef1:−0.3 / +0.7 序列',
            data: canonical.ef1Pts,
            step: 'middle',
            showSymbol: true,
            symbolSize: 4,
            color: ct.warn,
          },
        ],
        yMin: -0.6,
        yMax: 1.0,
        zoom: false,
      }),
    [canonical, ct],
  );

  const optTime = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: phaseAxisLabel('e_FB_abs', unit, tVco),
        yTickFormatter: makePhaseTickFormatter(unit, tVco),
        series: [
          {
            name: 'nearest(exp07)',
            data: toXY(simNearest.data.e_FB_abs, 64),
            step: 'middle',
            showSymbol: false,
            color: ct.accent,
          },
          {
            name: `${quant}${dither > 0 ? ' + dither' : ''}`,
            data: toXY(simSel.data.e_FB_abs, 64),
            step: 'middle',
            showSymbol: false,
            color: ct.warn,
          },
        ],
      }),
    [simNearest, simSel, quant, dither, unit, tVco, ct],
  );

  const histData = useMemo(() => {
    const mk = (res: SimResult) => {
      const e = res.data.e_FB_abs;
      const lsb = new Float64Array(e.length);
      for (let i = 0; i < e.length; i++) {
        lsb[i] = e[i] * res.g;
      }
      const { counts, edges } = histogram(lsb, 33);
      const pts: [number, number][] = [];
      for (let i = 0; i < counts.length; i++) {
        pts.push([(edges[i] + edges[i + 1]) / 2, counts[i]]);
      }
      return pts;
    };
    return { nearest: mk(simNearest), sel: mk(simSel) };
  }, [simNearest, simSel]);

  const optHistN = useMemo(
    () =>
      makeLineOption({
        title: 'nearest(exp07)',
        xLabel: 'e_FB_abs (LSB)',
        yLabel: 'count',
        series: [
          { name: 'nearest', data: histData.nearest, type: 'bar', color: ct.accent },
        ],
        zoom: false,
        legend: false,
      }),
    [histData, ct],
  );

  const optHistS = useMemo(
    () =>
      makeLineOption({
        title: `${quant}${dither > 0 ? ` + dither ${trimNumber(dither, 3)} LSB` : ''}`,
        xLabel: 'e_FB_abs (LSB)',
        yLabel: 'count',
        series: [{ name: quant, data: histData.sel, type: 'bar', color: ct.warn }],
        zoom: false,
        legend: false,
      }),
    [histData, quant, dither, ct],
  );

  const psdData = useMemo(
    () => ({ nearest: psdOf(simNearest), sel: psdOf(simSel) }),
    [simNearest, simSel],
  );

  const optPsd = useMemo(
    () =>
      makeLineOption({
        xLabel: 'frequency (MHz)',
        yLabel: 'SSB PSD (dBc/Hz)',
        series: [
          {
            name: 'nearest(exp07)',
            data: psdData.nearest.pts,
            showSymbol: false,
            color: ct.accent,
          },
          {
            name: `${quant}${dither > 0 ? ' + dither' : ''}`,
            data: psdData.sel.pts,
            showSymbol: false,
            color: ct.warn,
          },
        ],
        yMin: -220,
        yMax: -80,
      }),
    [psdData, quant, dither, ct],
  );

  // taxonomy (1) 圖:exp22 e_FB_abs(LSB)前 64 拍
  const optTax22 = useMemo(() => {
    const colors = [ct.accent, ct.warn, ct.bad];
    const names = ['ef1', 'mash11', 'mash111'];
    return makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: 'e_FB_abs (LSB)',
      series: exp22Sims.map((r, i) => {
        const e = r.data.e_FB_abs;
        const pts: [number, number][] = [];
        for (let k = 0; k < Math.min(64, e.length); k++) {
          pts.push([k, e[k] * r.g]);
        }
        return {
          name: names[i],
          data: pts,
          step: 'middle' as const,
          showSymbol: false,
          color: colors[i],
          width: i === 0 ? 2.2 : 1.4,
        };
      }),
    });
  }, [exp22Sims, ct]);

  // taxonomy (2) 圖:exp21 theta_plus(rad),gated series 隨 threshold slider 重算
  const optTax21 = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: 'theta_plus (rad)',
        series: [
          {
            name: 'dsm_only 無 gating(exp21b)',
            data: toXY(exp21Sims[1].data.theta_plus),
            showSymbol: false,
            color: ct.bad,
          },
          {
            name: `dsm_only + gating(threshold ${trimNumber(gateThr, 4)})`,
            data: toXY(gatedSim.data.theta_plus),
            showSymbol: false,
            color: ct.accent,
          },
          {
            name: 'full actuator(exp21a)',
            data: toXY(exp21Sims[0].data.theta_plus),
            showSymbol: false,
            color: ct.good,
            width: 2.2,
          },
        ],
      }),
    [exp21Sims, gatedSim, gateThr, ct],
  );

  const spurRow = (s: Spur, i: number, tag: string) => (
    <tr key={`${tag}${i}`}>
      <td>{tag}</td>
      <td>{trimNumber(s.freqHz / 1e6, 5)} MHz</td>
      <td>{trimNumber(s.psdDb - db10(2), 4)} dBc/Hz</td>
    </tr>
  );

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            同樣面對 0.3 LSB 的 off-grid 殘量,固定捨入(nearest)與一階 phase
            DSM(ef1)的誤差<b>時間序列</b>差在哪?mean / peak / RMS 各是多少?
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            DSM 的 noise shaping 把量化能量搬到哪裡去了?histogram 與 PSD 上怎麼看?
            <EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>triangular dither 加進來之後,deterministic tone 發生什麼事?</li>
          <li>
            phase DSM 到底「能做什麼、不能做什麼」?它是不是 sub-LSB 問題的萬靈丹?
            (不是。)<EpistemicTag kind="EXACT" />
          </li>
          <li>
            用了 DSM 之後,shared(mode D)與 independent(mode B)的 pair error
            差異還存在嗎?(experiment 9)<EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          nearest 是「每一拍都選最近的格點」:面對固定的 0.3 LSB 殘量,它每拍都做出
          同一個決定 — 誤差固定 −0.3 LSB。這是一個 <b>DC 偏移 + 確定性 pattern</b>:
          能量集中在低頻與特定 tone(spur),聽起來「安靜」但頻譜上是尖峰。
        </p>
        <p>
          ef1 DSM 則「記帳」:把每拍沒表示掉的殘量存進 state,累積到超過 1 LSB 就
          進位一次。同樣的 0.3 LSB,它輸出 −0.3, −0.3, −0.3, +0.7, … — 平均恰為 0,
          代價是瞬時誤差峰值從 0.3 變成 0.7 LSB。這就是 <b>temporal averaging</b>:
          用時間換 DC 精度,把誤差能量從 DC / 低頻 tone 推向高頻(noise shaping,
          <M>{'1-z^{-1}'}</M> 高通)。<EpistemicTag kind="EXACT" />
        </p>
        <p>
          重點:DSM 沒有讓任何一拍的 edge 更準 — 每拍誤差仍是「整數 code − 理想值」,
          解析度還是 1 LSB。它改變的是誤差的<b>統計與頻譜分佈</b>,不是誤差的存在。
          對 injection 這種「每拍都要對準 zero crossing」的用途,瞬時誤差變大反而
          可能更糟 — 這是本章的工程張力所在。<EpistemicTag kind="INFERENCE" />
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>MODEL_SPEC §6 的 quantizer 定義(輸入 u 單位 LSB,輸出整數 code):</p>
        <MathBlock>
          {
            '\\mathrm{nearest}:\\; y=\\lfloor u+0.5\\rfloor\\qquad \\mathrm{floor}:\\; y=\\lfloor u\\rfloor'
          }
        </MathBlock>
        <p>ef1 — first-order error-feedback DSM(state e,init 0):</p>
        <MathBlock>
          {'v[k]=u[k]+e[k-1],\\qquad y[k]=\\lfloor v[k]\\rfloor,\\qquad e[k]=v[k]-y[k]\\in[0,1)'}
        </MathBlock>
        <p>移項得誤差的 noise-shaping 形式:<EpistemicTag kind="EXACT" /></p>
        <MathBlock>
          {'y[k]-u[k]=e[k-1]-e[k]\\;\\;\\xrightarrow{\\;z\\;}\\;\\;Y(z)-U(z)=-(1-z^{-1})\\,E(z)'}
        </MathBlock>
        <p>
          <M>{'1-z^{-1}'}</M> 是一階高通:DC 增益為 0(長期平均誤差 → 0),高頻誤差
          被放大。N 拍平均為 telescoping sum:
        </p>
        <MathBlock>
          {
            '\\frac{1}{N}\\sum_{k=0}^{N-1}\\bigl(y[k]-u[k]\\bigr)=\\frac{e[-1]-e[N-1]}{N}\\;\\in\\;\\Bigl(-\\tfrac{1}{N},\\tfrac{1}{N}\\Bigr)\\;\\to\\;0'
          }
        </MathBlock>
        <p>mash11 — MASH 1-1(兩級 accumulator,c2 差分回饋):</p>
        <MathBlock>
          {
            'y = \\lfloor u\\rfloor + c_1 + (c_2 - c_2^{prev}),\\qquad (1-z^{-1})^2\\;\\text{2nd-order shaping}'
          }
        </MathBlock>
        <p>optional triangular dither(quantize 前加入,§6 item 6):</p>
        <MathBlock>{"u' = u + d_{amp}\\,(U_1+U_2-1),\\qquad U_i\\sim\\mathcal{U}[0,1)"}</MathBlock>
        <p>
          PSD 標示(§17):phase 序列(rad)的 Hann periodogram <M>{'S_{\\phi}'}</M>{' '}
          (rad²/Hz)以 <M>{'10\\log_{10}(S_{\\phi}/2)'}</M> 標為 SSB dBc/Hz —
          僅在 small-angle 下成立;幅度 a rad 的 tone 對應{' '}
          <M>{'20\\log_{10}(a/2)'}</M> dBc。<EpistemicTag kind="EXACT" />
        </p>
      </SectionMath>

      <SectionExample>
        <p>
          <b>0.3-LSB canonical case</b>(MODEL_SPEC §6,Test 4):
          <M>{'u[k]=m[k]+0.3'}</M>(取 m = 0)。nearest:每拍{' '}
          <M>{'y=\\lfloor 0.3+0.5\\rfloor=0'}</M>,誤差固定 −0.3 LSB。ef1 前 8 拍
          (下表由 model 的 <code>ErrorFeedbackFirstOrder</code> 即時計算,可手算
          對照):
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>k</th>
                <th>e[k−1]</th>
                <th>v = u + e</th>
                <th>y = ⌊v⌋</th>
                <th>e[k]</th>
                <th>err = y − u</th>
              </tr>
            </thead>
            <tbody>
              {canonical.rows.map((r) => (
                <tr key={r.k}>
                  <td>{r.k}</td>
                  <td>{trimNumber(r.eIn, 4)}</td>
                  <td>{trimNumber(r.v, 4)}</td>
                  <td>{r.y}</td>
                  <td>{trimNumber(r.eOut, 4)}</td>
                  <td>{trimNumber(r.err, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          誤差序列 −0.3, −0.3, −0.3, <b>+0.7</b>, −0.3, −0.3, <b>+0.7</b>, …:瞬時值
          只取 −0.3 / +0.7 兩值 <EpistemicTag kind="EXACT" />(進位 pattern
          0,0,0,1,0,0,1,0,0,1 以週期 10 循環,每 10 拍進位 3 次),長期平均 → 0(上節
          telescoping bound),peak |error| 由 0.3 增為 0.7 LSB。以 N=3.125 的 LSB
          = 312.5 fs 換算:nearest 固定 −93.75 fs;ef1 在 −93.75 fs 與 +218.75 fs
          之間跳動、平均 0。注意這是<b>常數 0.3-LSB 輸入</b>的 canonical 例(Test 4);
          full-chain 的 exp07/exp08 輸入逐拍累積 0.3 LSB,誤差因此是 0.1-LSB 階梯的
          多階序列(nearest:十階 ±0.5 LSB;ef1:峰值 ±0.7 LSB),不是 −0.3/+0.7 兩值。
        </p>
      </SectionExample>

      <SectionFigure
        title="Canonical 0.3-LSB:nearest 固定 −0.3 vs ef1 的 −0.3 / +0.7 序列"
        caption={
          <span>
            x 軸:拍 k;y 軸:量化誤差(LSB)。藍:nearest — 恆為 −0.3(DC 偏移);
            橘:ef1 — 大約每 10 拍進位 3 次(state 累積 0.3/拍,越過 1 便進位),
            平均 0。此圖直接呼叫 model 的 quantizer classes,無 full-chain 模擬。
          </span>
        }
      >
        <EChart option={optCanonical} height={260} />
      </SectionFigure>

      <SectionFigure
        title="Full-chain 時序:e_FB_abs 前 64 拍(exp07 nearest vs 選定 quantizer)"
        caption={
          <span>
            N = 3 + 32.3/256(exp07/exp08:fine-code 殘量落在 0.3-LSB 格上,逐拍
            走位)、mode D、{NC} cycles。nearest 呈週期 10 的 deterministic pattern
            (0, −0.3, +0.4, +0.1, −0.2, +0.5, … LSB)<EpistemicTag kind="EXPERIMENT" />;
            切到 ef1 觀察峰值變大但平均歸零。單位:<UnitSwitch />
          </span>
        }
      >
        <EChart option={optTime} height={280} />
      </SectionFigure>

      <SectionFigure
        title="圖 #16 — error histogram(LSB)"
        caption={
          <span>
            左:nearest — 誤差集中在 0.1-LSB 格點上的少數值(deterministic);右:
            選定 quantizer — ef1 分佈變寬(峰值 ±較大),加 dither 後進一步平滑化。
            兩圖 bin 皆 33、各自取 min–max 範圍。
          </span>
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ flex: '1 1 300px', minWidth: 280 }}>
            <EChart option={optHistN} height={240} />
          </div>
          <div style={{ flex: '1 1 300px', minWidth: 280 }}>
            <EChart option={optHistS} height={240} />
          </div>
        </div>
      </SectionFigure>

      <SectionFigure
        title="圖 #17 — PSD 與 tone 比較(sample rate = f_ref = 4 GHz)"
        caption={
          <span>
            e_FB_abs 轉為 rad 後之 Hann periodogram,y 軸 = 10·log₁₀(S/2) dBc/Hz
            (small-angle SSB convention,§17;DC bin 略去 — nearest 的非零 mean 是
            static offset,不是 spur)。nearest:能量集中在 m/P·f_ref = m×400 MHz
            的諧波(週期 P = 10;periodogram bin 間距 f_ref/1024 ≈ 3.9 MHz,尖峰落在
            最接近的 bin)<EpistemicTag kind="EXPERIMENT" />;ef1:tone 重新
            分佈且低頻被壓低(1−z⁻¹ 高通);加 dither 讓 tone 攤成 noise floor。
          </span>
        }
      >
        <EChart option={optPsd} height={300} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 8 }}>
          <div style={{ flex: '1 1 300px', overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>config</th>
                  <th>spur 頻率</th>
                  <th>level</th>
                </tr>
              </thead>
              <tbody>
                {psdData.nearest.spurs.map((s, i) => spurRow(s, i, 'nearest'))}
                {psdData.sel.spurs.map((s, i) => spurRow(s, i, quant))}
              </tbody>
            </table>
          </div>
          <div style={{ flex: '1 1 300px', overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>metric(e_FB_abs)</th>
                  <th>nearest</th>
                  <th>{quant}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>mean (LSB)</td>
                  <td>{trimNumber(mN.meanLsb, 4)}</td>
                  <td>{trimNumber(mS.meanLsb, 4)}</td>
                </tr>
                <tr>
                  <td>RMS (LSB)</td>
                  <td>{trimNumber(mN.rmsLsb, 4)}</td>
                  <td>{trimNumber(mS.rmsLsb, 4)}</td>
                </tr>
                <tr>
                  <td>peak |e| (LSB)</td>
                  <td>{trimNumber(mN.peakLsb, 4)}</td>
                  <td>{trimNumber(mS.peakLsb, 4)}</td>
                </tr>
                <tr>
                  <td>peak-to-peak (LSB)</td>
                  <td>{trimNumber(mN.p2pLsb, 4)}</td>
                  <td>{trimNumber(mS.p2pLsb, 4)}</td>
                </tr>
                <tr>
                  <td>RMS × T_vco/256 → 時間</td>
                  <td>{formatSiTime((mN.rmsLsb * tVco) / simNearest.g)}</td>
                  <td>{formatSiTime((mS.rmsLsb * tVco) / simNearest.g)}</td>
                </tr>
                <tr>
                  <td>e_pair rms(exp09,ef1)</td>
                  <td colSpan={2}>
                    mode D(shared):{trimNumber(pairStats.rmsD, 4)} LSB;mode B
                    (independent):{trimNumber(pairStats.rmsB, 4)} LSB
                    <EpistemicTag kind="EXPERIMENT" />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </SectionFigure>

      <SectionFigure
        title="DSM 在 fractional-N PLL 的常見用法與對本架構的影響 —(1)divider-modulating MASH(experiment 22)"
        caption={
          <span>
            exp22:N=3.13、mode D、full actuator、512 cycles,三組只差 quantizer
            階數(前 64 拍)。<M>{'e_{FB,abs}'}</M> 的 rms / peak 隨階數上升(下表
            實測值)<EpistemicTag kind="EXPERIMENT" />;三組的 e_pair_digital 皆恆為
            0(mode D 的 modular-reverse identity,與階數無關)
            <EpistemicTag kind="EXACT" />。
          </span>
        }
      >
        <p>
          真實 fractional-N PLL 中,DSM 出現在四種不同的位置。這一節逐一檢視每種
          部署「是什麼、對 reverse injection 有什麼影響、設計上該怎麼辦」;(1)(2)
          由 exp22 / exp21 量測支撐,(3)(4) 對應本架構既有的選項。
        </p>
        <p>
          <b>(1) divider-modulating DSM(MASH 1-1 / 1-1-1)— 是什麼:</b>經典
          fractional-N 的作法,MASH 直接調變瞬時除數 <M>{'n[k]'}</M>,沒有
          fractional actuator。本模型的對應是{' '}
          <code>actuator_mode='dsm_only'</code>(MODEL_SPEC §7.1):quantization 移到
          integer-cycle granularity,fine code 恆為 0。<b>對 n_int 的影響:</b>
          nearest 下 <M>{'n[k]\\in\\{3,4\\}'}</M>;ef1 下擴為 {'{2,3,4}'}(N=3.13;
          整個 N ∈ [3, 3.25] grid 實測為 {'{2,3,4,5}'})
          <EpistemicTag kind="EXPERIMENT" />;mash11 / mash111 在 /3-/4 這麼小的
          integer part 下瞬時除數會觸及 0(duplicate edge)→ 模型故意讓 edge
          monotonicity assertion raise — classic MASH 需要更大的 integer part(§7.1)
          <EpistemicTag kind="EXACT" />。<b>對 per-edge phase error 的影響:</b>
          每拍 feedback edge 只能落在整數 VCO cycle 上,對 injection 而言{' '}
          <M>{'e_{ZC,hw}=\\operatorname{wrapCycles}(x_{ideal}-z_0)'}</M> 掃過全範圍
          ±0.5 <b>cycle</b>(不是 sub-LSB!exp21b 實測 rms{' '}
          {trimNumber(rms(exp21Sims[1].data.e_ZC_hw), 4)} cycle)
          <EpistemicTag kind="EXPERIMENT" />。<b>因此:</b>divider-modulating DSM 的
          系統若要加 reverse injection,injection timing <b>必須</b>另外取得
          accumulated state(Ch9:MASH 第一級 accumulator 內容)並配上 fractional
          actuator(DTC),或者退而求其次做 gating(見 (2))。
          <EpistemicTag kind="INFERENCE" />
        </p>
        <p>
          即使 fractional actuator 存在(full,mode D),把 final-code quantizer
          換成高階 MASH 仍有代價 — 這就是 exp22:
        </p>
        <EChart option={optTax22} height={280} />
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>quantizer(exp22,512 cycles)</th>
                <th>e_FB_abs rms (LSB)</th>
                <th>e_FB_abs peak (LSB)</th>
                <th>e_ZC_total rms (cycle)</th>
                <th>n_int 集合</th>
              </tr>
            </thead>
            <tbody>
              {taxStats.m22.map((m) => (
                <tr key={m.quant}>
                  <td>{m.quant}</td>
                  <td>{trimNumber(m.rmsLsb, 4)}</td>
                  <td>{trimNumber(m.peakLsb, 4)}</td>
                  <td>{trimNumber(m.ezcRms, 5)}</td>
                  <td>{m.nInt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          階數每升一級,瞬時誤差的 rms / peak 就變大一截(1−z⁻¹ 的冪次把更多能量
          推到高頻,時域擺幅隨之變寬)<EpistemicTag kind="EXPERIMENT" />;而整數
          bit 集合在 N=3.13 下三者同為 {'{3,4}'} — 階數的差異全部發生在 sub-cycle
          code 層。<b>設計指引:</b>full actuator 下選 mash11 / mash111 只該為了
          頻譜(spur)規格,且必須接受 Ch14 意義下更差的逐拍 zero-crossing 精度;
          每拍直接作用的 injection 沒有 loop 低通可以把高頻 shaped noise 濾掉。
          <EpistemicTag kind="INFERENCE" />
        </p>
      </SectionFigure>

      <SectionFigure
        title="DSM 常見用法(2)(3)(4)— DSM-only + injection(experiment 21)、DTC-assisted QNC、phase-domain DSM"
        caption={
          <span>
            exp21:N=3.13、ef1、sin injection(K=0.4、Δf=1 MHz、σ_vco_w=0.02
            rad)、512 cycles。綠:full actuator — {taxStats.m21[0].fired}/512 拍
            fire,tail rms(後 256 拍){trimNumber(taxStats.m21[0].tail, 4)} rad;
            紅:dsm_only 無 gating — kick 打在任意 phase,失鎖(tail rms{' '}
            {trimNumber(taxStats.m21[1].tail, 4)} rad);藍:dsm_only + threshold
            gating(slider,目前 {trimNumber(gateThr, 4)} cycle)—{' '}
            {taxStats.gFired}/512 拍 fire,tail rms {trimNumber(taxStats.gTail, 4)}{' '}
            rad <EpistemicTag kind="EXPERIMENT" />。injection dynamics 為 §14
            sin map <EpistemicTag kind="APPROX" />。
          </span>
        }
      >
        <p>
          <b>(2) DSM-only(無 DTC)直接配 injection — 是什麼:</b>只有
          divider-modulating DSM、沒有任何 fractional actuator,injection pulse
          仍逐拍發出。<b>對 reverse injection 的影響:</b>ungated 時 kick 落點誤差
          就是上面 (1) 的 ±0.5-cycle 掃描 — 大部分拍的 kick 把 VCO 推<b>離</b>鎖點
          而不是拉回來,反而把 loop 打失鎖:tail rms 由 full actuator 的{' '}
          {trimNumber(taxStats.m21[0].tail, 4)} rad 惡化為{' '}
          {trimNumber(taxStats.m21[1].tail, 4)} rad(×
          {trimNumber(taxStats.m21[1].tail / taxStats.m21[0].tail, 3)})—{' '}
          <b>主動有害</b> <EpistemicTag kind="EXPERIMENT" />。加上 deterministic
          threshold gating(§14:只在 |e_ZC_hw| ≤ threshold 的拍 fire;判準是
          scheduler 可預先算出的 e_ZC_hw,不含 noise)後,以預設 threshold
          0.0625 cycle 為例:只剩 {taxStats.m21[2].fired}/512 拍(
          {trimNumber((taxStats.m21[2].fired / 512) * 100, 2)}%)fire,但 tail rms
          回到 {trimNumber(taxStats.m21[2].tail, 4)} rad — gating 用
          correction rate 換回 bounded lock <EpistemicTag kind="EXPERIMENT" />。
          用右側 ParamPanel 的 gate threshold slider 觀察 trade-off:threshold
          越小、fire 越少、kick 越準;threshold → 0.5 等同無 gating。
          <b>設計指引:</b>DSM-only + 每拍 injection 是錯誤組合;若無法加 DTC,
          gating 是最低限度的補救,代價是校正頻寬。<EpistemicTag kind="INFERENCE" />
        </p>
        <EChart option={optTax21} height={300} />
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>config(exp21 + slider)</th>
                <th>fired / 512</th>
                <th>theta_plus tail rms (rad)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>(a) full actuator</td>
                <td>{taxStats.m21[0].fired}</td>
                <td>{trimNumber(taxStats.m21[0].tail, 4)}</td>
              </tr>
              <tr>
                <td>(b) dsm_only,無 gating</td>
                <td>{taxStats.m21[1].fired}</td>
                <td>{trimNumber(taxStats.m21[1].tail, 4)}</td>
              </tr>
              <tr>
                <td>(c) dsm_only,gating 0.0625 cycle</td>
                <td>{taxStats.m21[2].fired}</td>
                <td>{trimNumber(taxStats.m21[2].tail, 4)}</td>
              </tr>
              <tr style={{ fontWeight: 600 }}>
                <td>dsm_only,gating {trimNumber(gateThr, 4)} cycle(slider)</td>
                <td>{taxStats.gFired}</td>
                <td>{trimNumber(taxStats.gTail, 4)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          <b>(3) DTC-assisted quantization-noise cancellation(QNC)— 是什麼:</b>
          現代 fractional-N 的主流中間解:DSM 照樣調變 divider,但把 DSM 的
          accumulated residue 送給一顆 cancellation DTC,在 phase detector 之前把
          量化誤差抵消掉。<b>對本架構的意義:</b>本模型的 full actuator(shared
          final code 驅動 PMUX+DTC)從 injection 視角看<b>就是</b> QNC:同一份
          accumulated state,QNC 用它在 PD 前抵消誤差,本架構用它把 injection pulse
          放到正確的 sub-cycle 位置 — exp21a 的 e_ZC_hw ≤{' '}
          {trimNumber(Math.max(...Array.from(exp21Sims[0].data.e_ZC_hw).map(Math.abs)), 5)}{' '}
          cycle 就是 cancellation 成功的量。<b>設計指引:</b>預算允許一顆 DTC 時,
          這是 (1)(2) 與理想 fractional actuator 之間的自然折衷;需要 Ch15 的
          gain/INL calibration 配套。<EpistemicTag kind="INFERENCE" />
        </p>
        <p>
          <b>(4) phase-domain DSM 作用在 final code(本模型的 ef1 / mash11 /
          mash111 選項)與 dithering — 是什麼:</b>本章前半的主角:quantizer 作用在
          accumulated fine code 上、mode D 共享。<b>對 reverse injection 的影響:</b>
          mode D 下 e_pair_digital 恆 0,DSM 只改變<b>絕對</b>誤差的統計:spur ↔
          shaped noise(圖 #17),代價是瞬時 peak(0.3 → 0.7 LSB;mash11 1.36、
          mash111 1.76 LSB,上節 exp22 表)<EpistemicTag kind="EXPERIMENT" />;
          triangular dither 進一步把殘餘 tone 攤成 noise floor(圖 #16 / #17 的
          dither preset)。<b>設計指引:</b>維持 quantize-once(mode D)前提下,
          「nearest 的有界誤差 + spur」vs「DSM 的 shaped noise + 更大 peak」由 Ch16
          頻譜規格決定 — 這正是本章 takeaway 的能力邊界清單。
          <EpistemicTag kind="INFERENCE" />
        </p>
      </SectionFigure>

      <SectionCode
        title="web/src/model/quantizers.ts — 真實碼節錄:ef1 與 triangular dither"
        language="typescript"
        code={`export class ErrorFeedbackFirstOrder implements QuantizerState {
  private e = 0.0;

  reset(): void {
    this.e = 0.0;
  }

  quantize(u: number): number {
    const v = u + this.e;
    const y = Math.floor(v);
    this.e = v - y;
    return y;
  }

  /** Current error-feedback state e in [0, 1). */
  get state(): number {
    return this.e;
  }
}

/**
 * Optional triangular dither (spec section 6 item 6), added pre-quantize:
 * u' = u + d_amp * (U1 + U2 - 1), U from the named PRNG stream.
 */
export function triangularDither(ditherAmpLsb: number, stream: Mulberry32): number {
  return ditherAmpLsb * (stream.next() + stream.next() - 1.0);
}`}
      >
        <p>
          與 MODEL_SPEC §6 item 4 / 6 逐行對應;Python golden model 為逐位一致的
          鏡像實作(dsm_first_order.py)。
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'private e = 0.0;',
            explain: (
              <span>
                DSM 的全部記憶:一個 sub-LSB 殘量 e ∈ [0,1)。Ch9 的 dsm_state 欄位
                回報的就是它 — 這是「accumulated quantization error」的具體形態。
              </span>
            ),
          },
          {
            code: 'const v = u + this.e;',
            explain: (
              <span>
                把上一拍沒表示掉的殘量加回本拍輸入:0.3 → 0.6 → 0.9 → 1.2 —
                第 4 拍才越過 1。
              </span>
            ),
          },
          {
            code: 'const y = Math.floor(v);',
            explain: (
              <span>
                對補償後的 v 取 floor:v = 1.2 時 y = 1(進位拍,err = +0.7);
                v {'<'} 1 時 y = 0(err = −0.3)。輸出仍是整數 code — 單拍解析度
                沒有變細。
              </span>
            ),
          },
          {
            code: 'this.e = v - y;',
            explain: (
              <span>
                新殘量存回 state(1.2 − 1 = 0.2):error feedback 迴路閉合,得{' '}
                <M>{'y-u=e[k-1]-e[k]'}</M> 的 <M>{'(1-z^{-1})'}</M> shaping。
                <EpistemicTag kind="EXACT" />
              </span>
            ),
          },
          {
            code: 'return ditherAmpLsb * (stream.next() + stream.next() - 1.0);',
            explain: (
              <span>
                triangular dither:兩個 uniform 相加為三角分佈(±d_amp),quantize
                前注入,打斷 deterministic pattern 的週期性 → tone 攤為 noise
                floor。PRNG 為 mulberry32 named stream(§12),跨語言逐位一致。
              </span>
            ),
          },
          {
            code: "quantizer: 'ef1'  // exp08 config",
            explain: (
              <span>
                full-chain 中 ef1 作用在 <M>{'A_{ideal}[k]=G\\,s_{ideal}[k]'}</M>{' '}
                (accumulated absolute code)上,mode D 再對其 modular reverse —
                所以即使換 DSM,pair identity 仍逐拍成立(metrics 表 mode D rms = 0)。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            canonical 圖:橘線(ef1)只取 −0.3 / +0.7 兩值,進位拍約每 10 拍出現
            3 次;藍線(nearest)固定 −0.3 — DC 偏移一目了然。
          </li>
          <li>
            full-chain 時序:nearest 是週期 10 的固定 pattern(exp07 expected:
            deterministic、是 spur 不是 noise);ef1 的 pattern 更「碎」且峰值更大。
          </li>
          <li>
            histogram:nearest 集中在 0.1-LSB 格點的 10 個值;ef1 範圍變寬;dither
            0.5 LSB 後分佈連續化。
          </li>
          <li>
            PSD:nearest 在 ≈400 / 800 / 1200 / 1600 / 2000 MHz 出現尖 tone
            (= m/P·f_ref,P = 10;顯示頻率被 3.9 MHz 的 bin 網格微移);切 ef1
            後低頻壓低、能量上移;dither 把 tone 攤成 floor — spur 表的 top-5 會
            即時更新。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            metrics 表:ef1 的 |mean| ≪ nearest(→ 0),RMS 與 peak 反而更大 —
            「平均準、瞬時差」量化呈現;mode D 的 e_pair rms 恆 0,mode B 非零
            (exp09,Test 13)。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解:「DSM 平均誤差為零,所以 DSM 比較準」">
          <p>
            「準」要先問是哪個統計量。DSM 讓 mean → 0,但瞬時 |error| 峰值由 0.3 增為
            0.7 LSB、RMS 也變大。對 injection 而言每一拍的 zero-crossing 對準精度
            才是物理量(Ch14 的 shorting energy ∝ 瞬時誤差平方),「平均準」不能
            替代「逐拍準」。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解:「DSM 可以合成 sub-LSB 的 delay,解析度等效變高」">
          <p>
            DSM 輸出仍是整數 code:任何單一拍的 edge 只能落在 1-LSB 格點上。
            「等效解析度變高」只在<b>經過低通平均之後</b>的意義下成立(如 PLL loop
            對 feedback path 的濾波);對每拍直接作用的 injection pulse 沒有這層
            低通,sub-LSB analog timing 並不存在。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <p>Phase DSM 的能力邊界(MODEL_SPEC §6、§7;CHAPTER_GUIDE Ch11 必列):</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <div style={{ flex: '1 1 280px' }}>
            <Callout type="note" title="DSM 能做">
              <ul>
                <li>
                  <b>temporal averaging</b>:長期平均誤差 → 0(DC 精度)。
                  <EpistemicTag kind="EXACT" />
                </li>
                <li>
                  <b>noise shaping</b>:把量化能量推向高頻(1−z⁻¹ / (1−z⁻¹)²)。
                  <EpistemicTag kind="EXACT" />
                </li>
                <li>
                  <b>改變頻譜</b>:deterministic spur ↔ broadband(配合 dither)。
                  <EpistemicTag kind="EXPERIMENT" />
                </li>
              </ul>
            </Callout>
          </div>
          <div style={{ flex: '1 1 280px' }}>
            <Callout type="warn" title="DSM 不能做">
              <ul>
                <li>
                  產生 <b>sub-LSB 的 analog timing</b>:單拍 edge 解析度仍是 1 LSB。
                  <EpistemicTag kind="EXACT" />
                </li>
                <li>
                  消除 <b>tap / DTC / latency error</b>:它們在 quantizer 之後
                  (Ch12 / Ch15)。<EpistemicTag kind="EXACT" />
                </li>
                <li>
                  預知 <b>VCO random noise</b>:DSM 只處理 deterministic 部分;
                  random noise 正是 injection 要修的對象(§5.3)。
                  <EpistemicTag kind="EXACT" />
                </li>
              </ul>
            </Callout>
          </div>
        </div>
        <p>
          設計基線:先用 nearest(誤差有界 ±half-LSB、無峰值放大)建立 baseline;
          是否改用 shared DSM,要以 spur 規格與 Ch16 的頻譜評估為準,而且必須維持
          mode D 的 shared/quantize-once 結構(exp09:mode B 的 pair error 證明
          independent DSM 不可取)。<EpistemicTag kind="INFERENCE" />
        </p>
        <p>
          對照 DSM 部署 taxonomy(本章新增兩節):divider-modulating MASH 的系統要加
          reverse injection,必拉 accumulated state + DTC(exp22:full actuator 下
          階數仍以 rms/peak 為代價);DSM-only + 每拍 injection 是主動有害的組合,
          threshold gating 只是部分補救(exp21:1.81 → 0.10 rad,fire rate 13%);
          DTC-assisted QNC 與本架構的 full actuator 是同一個 accumulated state 的
          兩種用法;phase-domain DSM 只在 mode D 的 quantize-once 前提下安全。
          <EpistemicTag kind="EXPERIMENT" />
        </p>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            本章 quantizer 為 §6 行為抽象:未建模硬體 DSM 的位寬截斷、飽和與 pipeline;
            mash11 暫態允許 n_int ∈ 2–5(§4),對除頻器的可行性需另行確認。PSD 為
            單一 realization 的 Hann periodogram(固定 seed 12345),無 ensemble
            平均;dBc/Hz 標示依 §17 small-angle SSB convention,誤差幅度大時不成立。
            除 taxonomy 一節外全部為 digital 層比較 — DTC/tap 的 analog 誤差與
            injection dynamics(Ch13–Ch15)不在其餘模擬內;taxonomy (2) 的 exp21
            比較使用 §14 sin-map injection dynamics(APPROX、單一 seed 12345),
            且 dsm_only 的 mash11 / mash111 在 N ∈ (3, 3.25) 多數值會觸發 edge
            monotonicity assertion(§7.1),故 dsm_only 比較僅用 ef1。
          </p>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="參數 Parameters">
        <SelectControl<Quantizer>
          label="Quantizer(右側 series)"
          value={quant}
          options={QUANT_OPTIONS}
          onChange={setQuant}
        />
        <Slider
          label="triangular dither(LSB)"
          value={dither}
          min={0}
          max={1}
          step={0.05}
          onChange={setDither}
        />
        <PresetButtons
          label="Preset(experiments)"
          presets={[
            {
              label: 'exp07 nearest',
              onClick: () => {
                setQuant('nearest');
                setDither(0);
              },
            },
            {
              label: 'exp08 ef1',
              onClick: () => {
                setQuant('ef1');
                setDither(0);
              },
            },
            {
              label: 'mash11',
              onClick: () => {
                setQuant('mash11');
                setDither(0);
              },
            },
            {
              label: 'mash111',
              onClick: () => {
                setQuant('mash111');
                setDither(0);
              },
            },
            {
              label: 'ef1 + dither 0.5',
              onClick: () => {
                setQuant('ef1');
                setDither(0.5);
              },
            },
          ]}
        />
        <Slider
          label="inj gate threshold(cycle,taxonomy 圖 (2))"
          value={gateThr}
          min={0}
          max={0.5}
          step={0.0025}
          onChange={setGateThr}
        />
        <PresetButtons
          label="Preset threshold"
          presets={[0.03125, 0.0625, 0.125, 0.25, 0.5].map((t) => ({
            label: String(t),
            onClick: () => setGateThr(t),
          }))}
        />
        <p style={{ fontSize: 12, opacity: 0.75 }}>
          baseline 恆為 exp07(nearest,無 dither);兩組皆 N = 3 + 32.3/256、mode
          D、{NC} cycles、seed 12345。exp09 對照(mode D vs B)固定 ef1、256 cycles。
          gate threshold slider 只影響 taxonomy 圖 (2) 的 dsm_only gated series
          (exp21c config、512 cycles);其餘 taxonomy 模擬固定為 exp21 / exp22。
        </p>
      </ParamPanel>
    </ChapterShell>
  );
}
