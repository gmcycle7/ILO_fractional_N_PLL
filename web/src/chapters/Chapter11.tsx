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

  useEffect(() => {
    setStatus('done', `exp07/08: ${NC} cycles ×2, exp09: 256 ×2`);
  }, [simNearest, simSel, pairSims, setStatus]);

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
        toolbox: false,
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
        toolbox: false,
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
          只取 −0.3 / +0.7 兩值 <EpistemicTag kind="EXACT" />,長期平均 → 0(上節
          telescoping bound),peak |error| 由 0.3 增為 0.7 LSB。以 N=3.125 的 LSB
          = 312.5 fs 換算:nearest 固定 −93.75 fs;ef1 在 −93.75 fs 與 +218.75 fs
          之間跳動、平均 0。
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
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            本章 quantizer 為 §6 行為抽象:未建模硬體 DSM 的位寬截斷、飽和與 pipeline;
            mash11 暫態允許 n_int ∈ 2–5(§4),對除頻器的可行性需另行確認。PSD 為
            單一 realization 的 Hann periodogram(固定 seed 12345),無 ensemble
            平均;dBc/Hz 標示依 §17 small-angle SSB convention,誤差幅度大時不成立。
            全部為 digital 層比較 — DTC/tap 的 analog 誤差與 injection dynamics
            (Ch13–Ch15)不在本章模擬內。
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
              label: 'ef1 + dither 0.5',
              onClick: () => {
                setQuant('ef1');
                setDither(0.5);
              },
            },
          ]}
        />
        <p style={{ fontSize: 12, opacity: 0.75 }}>
          baseline 恆為 exp07(nearest,無 dither);兩組皆 N = 3 + 32.3/256、mode
          D、{NC} cycles、seed 12345。exp09 對照(mode D vs B)固定 ef1、256 cycles。
        </p>
      </ParamPanel>
    </ChapterShell>
  );
}
