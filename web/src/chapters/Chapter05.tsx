/**
 * Chapter 5 — 6-bit Feedback DTC
 *
 * Content contract: CHAPTER_GUIDE.md Ch5; math contract MODEL_SPEC.md §4, §9, §11.
 * Figures: #9 DTC code plot, #12 ideal vs quantized phase, #13 absolute error,
 * #28 frequency sweep (time LSB / phase LSB / peak error vs f_vco).
 * Worked example: the 0.337 feedback-side case (R_FB = 86, -85 fs).
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
import { ParamPanel, Slider, PresetButtons, SelectControl } from '../components/controls';
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
  configTVcoS,
  wrapCycles,
  dtcLsbS,
  phaseLsbDeg,
} from '../model';
import type { Quantizer, DtcModeName } from '../model';

const meta = chapterById(5)!;

const N_CYCLES = 256;
const HALF_LSB_CYC = 1 / 512; // half-LSB in cycles (G = 256) [EXACT]

const PRESET_N: { label: string; value: number }[] = [
  { label: '3.000', value: 3.0 },
  { label: '3.125', value: 3.125 },
  { label: '3.130', value: 3.13 },
  { label: '3.1375', value: 3.1375 },
  { label: '3.250', value: 3.25 },
];

const QUANTIZER_OPTIONS: { value: Quantizer; label: string }[] = [
  { value: 'nearest', label: 'nearest (floor(u+0.5))' },
  { value: 'floor', label: 'floor' },
  { value: 'truncate', label: 'truncate' },
  { value: 'ef1', label: 'ef1 (1st-order error feedback)' },
  { value: 'mash11', label: 'mash11 (MASH 1-1)' },
];

const DTC_MODE_OPTIONS: { value: DtcModeName; label: string }[] = [
  { value: 'normalized', label: 'normalized (Δt = T_vco/256)' },
  { value: 'fixed_time', label: 'fixed_time (Δt = 312.5 fs)' },
];

function pairs(ks: Float64Array, ys: Float64Array, count?: number): [number, number][] {
  const n = count === undefined ? ys.length : Math.min(count, ys.length);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    out.push([ks[i], ys[i]]);
  }
  return out;
}

const CODE_EXCERPT = `// web/src/model/dtcModel.ts  (MODEL_SPEC §10–§11, 真實碼節錄)
export function makeDtc(cfg: SimConfig, path: 'fb' | 'inj', streams: Streams): DTCModel {
  const nCodes = 1 << cfg.b_dtc;
  let lsbCyc: number;
  if (cfg.dtc_mode === 'normalized') {
    lsbCyc = 1.0 / configG(cfg);
  } else {
    // fixed_time
    lsbCyc = (cfg.dtc_lsb_fs * FS) / configTVcoS(cfg);
  }
  // ... gain / offset / DNL stream 依 path ('fb' | 'inj') 選取 ...
}

// DTCModel constructor 內的 per-code delay table(單位 cycles):
table[c] =
  gain * c * lsbCycles +
  offsetCycles +
  inlSinAmpCycles * Math.sin((2.0 * Math.PI * c) / nCodes) +
  p2 * (c / denom) ** 2 +
  p3 * (c / denom) ** 3 +
  lut +
  dnlCum[c] * lsbCycles;`;

export default function Chapter05() {
  const [alpha, setAlpha] = useState(0.13);
  const [quantizer, setQuantizer] = useState<Quantizer>('nearest');
  const [dtcMode, setDtcMode] = useState<DtcModeName>('normalized');
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const cfg = useMemo(
    () =>
      fromPartial({
        n_div: 3 + alpha,
        n_cycles: N_CYCLES,
        quantizer,
        dtc_mode: dtcMode,
      }),
    [alpha, quantizer, dtcMode],
  );
  const result = useMemo(() => simulate(cfg), [cfg]);
  const tVco = configTVcoS(cfg);

  useEffect(() => {
    setStatus(
      'done',
      `N = ${trimNumber(3 + alpha, 6)}, Q = ${quantizer}, DTC = ${dtcMode}, ${N_CYCLES} cycles`,
    );
  }, [alpha, quantizer, dtcMode, setStatus]);

  // analog-side absolute error e_FB_analog[k] = wrapCycles(u_FB_analog - x_ideal)
  const eFbAnalog = useMemo(() => {
    const uAn = result.data.u_FB_analog;
    const xi = result.data.x_ideal;
    const out = new Float64Array(uAn.length);
    for (let k = 0; k < uAn.length; k++) {
      out[k] = wrapCycles(uAn[k] - xi[k]);
    }
    return out;
  }, [result]);

  // ---- figure #9: DTC code plot ----
  const codeOption = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: 'c_FB (DTC code, 0..63)',
        yMin: -2,
        yMax: 66,
        series: [
          {
            name: 'c_FB',
            data: pairs(result.data.k, result.data.c_FB, 96),
            step: 'middle',
            showSymbol: true,
            symbolSize: 4,
          },
        ],
      }),
    [result, ct],
  );

  // ---- figure #12: ideal vs quantized phase ----
  const idealVsQuantOption = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: phaseAxisLabel('fractional phase', unit, tVco),
        yTickFormatter: makePhaseTickFormatter(unit, tVco),
        series: [
          {
            name: 'x_ideal (ideal)',
            data: pairs(result.data.k, result.data.x_ideal, 64),
            step: 'middle',
            showSymbol: true,
            symbolSize: 4,
          },
          {
            name: 'u_FB_digital (quantized)',
            data: pairs(result.data.k, result.data.u_FB_digital, 64),
            step: 'middle',
            showSymbol: true,
            symbolSize: 4,
            dashed: true,
          },
        ],
      }),
    [result, unit, tVco, ct],
  );

  // ---- figure #13: absolute error with half-LSB bounds ----
  const errOption = useMemo(() => {
    const kLast = N_CYCLES - 1;
    return makeLineOption({
      xLabel: 'k (reference cycle)',
      yLabel: phaseAxisLabel('e_FB', unit, tVco),
      yTickFormatter: makePhaseTickFormatter(unit, tVco),
      series: [
        {
          name: 'e_FB_abs (digital)',
          data: pairs(result.data.k, result.data.e_FB_abs),
          step: 'middle',
          showSymbol: true,
          symbolSize: 3,
        },
        {
          name: 'e_FB_analog',
          data: pairs(result.data.k, eFbAnalog),
          step: 'middle',
          showSymbol: false,
          width: 1.2,
        },
        {
          name: '+half-LSB',
          data: [
            [0, HALF_LSB_CYC],
            [kLast, HALF_LSB_CYC],
          ],
          dashed: true,
          width: 1,
          color: ct.warn,
        },
        {
          name: '−half-LSB',
          data: [
            [0, -HALF_LSB_CYC],
            [kLast, -HALF_LSB_CYC],
          ],
          dashed: true,
          width: 1,
          color: ct.warn,
        },
      ],
    });
  }, [result, eFbAnalog, unit, tVco, ct]);

  // ---- figure #28: frequency sweep 12–13 GHz (fixed nearest quantizer) ----
  const sweep = useMemo(() => {
    const fGhz: number[] = [];
    const lsbNormFs: [number, number][] = [];
    const lsbFixedFs: [number, number][] = [];
    const phNormDeg: [number, number][] = [];
    const phFixedDeg: [number, number][] = [];
    const peakNormFs: [number, number][] = [];
    const peakFixedFs: [number, number][] = [];
    for (let i = 0; i <= 25; i++) {
      const nDiv = 3 + i * 0.01;
      const f = nDiv * 4; // GHz (f_ref = 4 GHz)
      fGhz.push(f);
      lsbNormFs.push([f, dtcLsbS(nDiv, 4e9, 'normalized') / 1e-15]);
      lsbFixedFs.push([f, dtcLsbS(nDiv, 4e9, 'fixed_time') / 1e-15]);
      phNormDeg.push([f, phaseLsbDeg(256, nDiv, 4e9, 'normalized')]);
      phFixedDeg.push([f, phaseLsbDeg(256, nDiv, 4e9, 'fixed_time')]);
      for (const mode of ['normalized', 'fixed_time'] as const) {
        const r = simulate(
          fromPartial({ n_div: nDiv, n_cycles: 128, quantizer: 'nearest', dtc_mode: mode }),
        );
        const uAn = r.data.u_FB_analog;
        const xi = r.data.x_ideal;
        let peak = 0;
        for (let k = 0; k < uAn.length; k++) {
          const e = Math.abs(wrapCycles(uAn[k] - xi[k]));
          if (e > peak) peak = e;
        }
        const fs = (peak * r.t_vco_s) / 1e-15;
        if (mode === 'normalized') peakNormFs.push([f, fs]);
        else peakFixedFs.push([f, fs]);
      }
    }
    return { fGhz, lsbNormFs, lsbFixedFs, phNormDeg, phFixedDeg, peakNormFs, peakFixedFs };
  }, []);

  const sweepTimeOption = useMemo(
    () =>
      makeLineOption({
        xLabel: 'f_vco (GHz)',
        yLabel: 'time (fs)',
        xMin: 12,
        xMax: 13,
        zoom: false,
        series: [
          { name: 'normalized LSB', data: sweep.lsbNormFs, showSymbol: true, symbolSize: 4 },
          {
            name: 'fixed-time LSB (312.5 fs)',
            data: sweep.lsbFixedFs,
            showSymbol: true,
            symbolSize: 4,
            dashed: true,
          },
          {
            name: 'peak |e_FB_analog| (normalized)',
            data: sweep.peakNormFs,
            showSymbol: true,
            symbolSize: 4,
          },
          {
            name: 'peak |e_FB_analog| (fixed-time)',
            data: sweep.peakFixedFs,
            showSymbol: true,
            symbolSize: 4,
          },
        ],
      }),
    [sweep, ct],
  );

  const sweepPhaseOption = useMemo(
    () =>
      makeLineOption({
        xLabel: 'f_vco (GHz)',
        yLabel: 'phase LSB (deg)',
        xMin: 12,
        xMax: 13,
        zoom: false,
        series: [
          {
            name: 'normalized (360/256 = 1.40625°)',
            data: sweep.phNormDeg,
            showSymbol: true,
            symbolSize: 4,
          },
          {
            name: 'fixed-time (360·Δt/T_vco)',
            data: sweep.phFixedDeg,
            showSymbol: true,
            symbolSize: 4,
            dashed: true,
          },
        ],
      }),
    [sweep, ct],
  );

  const tableRows = useMemo(() => {
    const d = result.data;
    const rows: Record<string, unknown>[] = [];
    for (let k = 0; k < Math.min(16, N_CYCLES); k++) {
      rows.push({
        k,
        R_FB: d.R_FB[k],
        m_FB: d.m_FB[k],
        c_FB: d.c_FB[k],
        x_ideal: d.x_ideal[k],
        u_FB_digital: d.u_FB_digital[k],
        e_FB_abs: d.e_FB_abs[k],
        e_FB_analog: eFbAnalog[k],
      });
    }
    return rows;
  }, [result, eFbAnalog]);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            6-bit feedback DTC 的 code <M>{'c_{FB}'}</M> 怎麼從 <M>{'R_{FB}'}</M> decode?一個 LSB
            對應多少時間、多少相位?<EpistemicTag kind="EXACT" />
          </li>
          <li>
            normalized DTC(<M>{'\\Delta t = T_{vco}/256'}</M>)與 fixed-time DTC
            (<M>{'\\Delta t = 312.5\\,\\mathrm{fs}'}</M> 固定)有什麼本質差異?哪個量不隨 f_vco
            變?
          </li>
          <li>量化誤差 <M>{'e_{FB,abs}'}</M> 有多大?nearest 的 half-LSB bound 是什麼?</li>
          <li>掃 12–13 GHz 時,time LSB、phase LSB、peak error 各如何變化?</li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          Ch4 的 PMUX 把 edge 放到 4 個粗格(每格 T<sub>vco</sub>/4)之一;6-bit DTC 是掛在後面的
          游標卡尺,把那 1/4 cycle 再細分成 64 格——每格 1 LSB = T<sub>vco</sub>/256。PMUX 走大步、
          DTC 走小步,兩層合成 256 格覆蓋整個 VCO cycle。<EpistemicTag kind="EXACT" />
        </p>
        <p>
          「normalized」是一種理想化:假設 DTC 的每格延遲永遠精確等於 T<sub>vco</sub>/256,
          無論 VCO 跑 12 GHz 還是 13 GHz——這等於假設 DTC 隨頻率完美校正。真實延遲線的一格是
          <strong>固定的時間</strong>(例如 312.5 fs),不會跟著 T<sub>vco</sub> 縮放:於是
          12.5 GHz 時 code-to-phase 對映恰好落在 1/256 grid 上,偏離 12.5 GHz 後每個 code
          的相位都systematically 偏掉——這就是 fixed-time mode 要捕捉的效應。
          <EpistemicTag kind="ASSUMPTION" />
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>DTC code 的 decode 與理想延遲(MODEL_SPEC §4)<EpistemicTag kind="EXACT" />:</p>
        <MathBlock>
          {'c_{FB}[k] = R_{FB}[k] \\bmod 64, \\qquad \\tau_{DTC}(c) = c \\cdot \\Delta t'}
        </MathBlock>
        <p>兩種 LSB 定義(MODEL_SPEC §11)<EpistemicTag kind="EXACT" />:</p>
        <MathBlock>
          {'\\textbf{normalized:}\\quad \\Delta t = \\frac{T_{vco}}{256}, \\qquad \\text{phase LSB} = \\frac{360^\\circ}{256} = 1.40625^\\circ \\;(\\text{恆定})'}
        </MathBlock>
        <MathBlock>
          {'\\textbf{fixed-time:}\\quad \\Delta t = 312.5\\,\\mathrm{fs}\\;(\\text{固定}), \\qquad \\text{phase LSB} = 360^\\circ \\cdot \\frac{\\Delta t}{T_{vco}} \\;(\\text{隨 } f_{vco} \\text{ 變})'}
        </MathBlock>
        <p>
          digital 量化誤差(與 DTC mode 無關,是捨入本身)<EpistemicTag kind="EXACT" />:nearest
          quantizer 下
        </p>
        <MathBlock>
          {'|e_{FB,abs}[k]| = |\\operatorname{wrapCycles}(A_{FB}/G - s_{ideal})| \\leq \\tfrac{1}{512}\\,\\text{cycle} = \\text{half-LSB}'}
        </MathBlock>
        <p>
          fixed-time 的 systematic scale error(analog 層;gain/INL 全關時)
          <EpistemicTag kind="EXACT" />:
        </p>
        <MathBlock>
          {'e_{scale}(c) = c\\left(\\frac{\\Delta t}{T_{vco}} - \\frac{1}{256}\\right)\\,\\text{cycle}'}
        </MathBlock>
        <p>
          只有 <M>{'T_{vco} = 80\\,\\mathrm{ps}'}</M>(12.5 GHz)時括號為零;12.0 GHz 端每 LSB 差
          −13.02 fs,c = 63 的解析上界為 −820.3 fs——遠超 half-LSB(156.25 fs)。注意恰在
          α = 0 或 0.25 時 <M>{'c_{FB} \\equiv 0'}</M>,scale error 完全不被激發;實測最大值
          出現在鄰近的 off-grid 點(12.04 GHz 處 peak ≈ 0.87 ps,含捨入貢獻)
          <EpistemicTag kind="EXPERIMENT" />。頻率表<EpistemicTag kind="EXACT" />:
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>N</th>
                <th>f_vco</th>
                <th>T_vco</th>
                <th>normalized LSB</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>3.000</td>
                <td>12.000 GHz</td>
                <td>83.333 ps</td>
                <td>325.521 fs</td>
              </tr>
              <tr>
                <td>3.125</td>
                <td>12.500 GHz</td>
                <td>80.000 ps</td>
                <td>312.500 fs</td>
              </tr>
              <tr>
                <td>3.250</td>
                <td>13.000 GHz</td>
                <td>76.923 ps</td>
                <td>300.481 fs</td>
              </tr>
            </tbody>
          </table>
        </div>
      </SectionMath>

      <SectionExample>
        <p>
          MODEL_SPEC §9 的 canonical 例子(feedback 半邊)。<M>{'N = 3.125'}</M>、
          <M>{'T_{vco} = 80\\,\\mathrm{ps}'}</M>、1 LSB = 312.5 fs = 1.40625°、half-LSB = 156.25 fs
          = 0.703125°。目標 <M>{'u_{FB,ideal} = 0.337'}</M> cycle<EpistemicTag kind="EXACT" />:
        </p>
        <MathBlock>
          {'\\text{ideal fine code} = 0.337 \\times 256 = 86.272 \\;\\xrightarrow{\\text{nearest}}\\; R_{FB} = 86'}
        </MathBlock>
        <MathBlock>
          {'m_{FB} = \\lfloor 86/64 \\rfloor = 1, \\qquad c_{FB} = 86 \\bmod 64 = 22'}
        </MathBlock>
        <MathBlock>
          {'u_{FB,actual} = 86/256 = 0.3359375, \\qquad e_{FB,abs} = 0.3359375 - 0.337 = -0.0010625\\,\\text{cycle}'}
        </MathBlock>
        <p>
          換算:<M>{'-0.0010625 \\times 80\\,\\mathrm{ps} = -85\\,\\mathrm{fs}'}</M>、
          <M>{'-0.0010625 \\times 360^\\circ = -0.3825^\\circ'}</M>。即 PMUX 選 phase 1(+T
          <sub>vco</sub>/4)、DTC 撥 22 格,edge 比理想早 85 fs——誤差小於 half-LSB,nearest
          做不到更好。injection 半邊(R_INJ = 170、+85 fs、pair = 0)見 Ch10。目前顯示單位下:
          e_FB_abs = {formatPhase(-0.0010625, unit, 80e-12)}。<EpistemicTag kind="EXACT" />
        </p>
      </SectionExample>

      <SectionFigure
        title="圖 #9 — DTC code plot:c_FB[k]"
        caption={
          <span>
            feedback DTC 每拍的 6-bit code(0..63)。N = 3.130 時 c 每拍前進 33.28 mod 64
            的量化版本;on-grid N = 3.125 時 c 呈 0, 32, 0, 32, …(α G = 32 恰為半個 DTC range)。
          </span>
        }
      >
        <EChart option={codeOption} height={260} group="ch5" />
      </SectionFigure>

      <SectionFigure
        title="圖 #12 — ideal vs quantized phase"
        caption={
          <span>
            實線 x_ideal 與虛線 u_FB_digital = R_FB/256。兩線在圖上幾乎重合——差值被 half-LSB
            (±156.25 fs @ 12.5 GHz)bound 住,要看圖 #13 的放大。單位:<UnitSwitch />
          </span>
        }
      >
        <EChart option={idealVsQuantOption} height={280} group="ch5" />
      </SectionFigure>

      <SectionFigure
        title="圖 #13 — absolute error plot:e_FB_abs 與 e_FB_analog"
        caption={
          <span>
            digital 誤差 e_FB_abs(quantizer 捨入)與 analog 誤差 e_FB_analog(含 DTC mode 的
            scale 效應)。虛線為 ±half-LSB = ±1/512 cycle。normalized mode 下兩線重合;切到
            fixed_time 並把 N 拉離 3.125(例如 3.01 或 3.24)時,e_FB_analog 隨 c_FB 出現放大的
            鋸齒、明顯衝出 half-LSB 界線(N = 3.130 因 12.52 GHz 貼近 12.5 GHz,效應只有幾十
            fs)。quantizer 換 floor 可看到誤差變成單邊 [−1, 0) LSB;ef1 則在 ±1 LSB 內、平均為
            0。
          </span>
        }
      >
        <EChart option={errOption} height={300} group="ch5" />
      </SectionFigure>

      <SectionFigure
        title="圖 #28 — frequency sweep:LSB 與 peak error vs f_vco(12–13 GHz)"
        caption={
          <span>
            上圖:time LSB(normalized 隨 T_vco/256 從 325.521 fs 降到 300.481 fs;fixed-time 恆為
            312.5 fs)與 peak |e_FB_analog|(nearest,128 cycles/點)。normalized 的 peak 貼著
            half-LSB(~145–156 fs,half-LSB 的 fs 值本身隨 T_vco 縮小);fixed-time 的 peak 呈 V
            形:谷底在 12.5 GHz 附近(~0.17 ps),往低頻端升到 0.87 ps(12.04 GHz)。兩種 mode 在
            恰好 12.00 / 13.00 GHz 都掉到 0——α = 0 或 0.25 時 on-grid 且 c_FB ≡ 0,誤差機制都
            不被激發。下圖:phase LSB——normalized 恆 1.40625°,fixed-time 從 1.35° 變到 1.4625°。
          </span>
        }
      >
        <EChart option={sweepTimeOption} height={300} />
        <EChart option={sweepPhaseOption} height={240} />
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model/dtcModel.ts — LSB 選擇與 delay table(真實碼節錄)"
        code={CODE_EXCERPT}
      />

      <SectionLineByLine
        items={[
          {
            code: 'const nCodes = 1 << cfg.b_dtc;',
            explain: (
              <span>
                6-bit → 64 個 code。DTC range = 64 LSB = 1/4 cycle,恰好接住 PMUX 一格(Ch4 的
                decode 保證 c 不會超出)。
              </span>
            ),
          },
          {
            code: "if (cfg.dtc_mode === 'normalized') { lsbCyc = 1.0 / configG(cfg); }",
            explain: (
              <span>
                normalized:1 LSB 恆為 1/256 cycle。這是「DTC 完美追蹤 T_vco」的理想化,
                digital 與 analog 誤差因此一致。
              </span>
            ),
          },
          {
            code: 'lsbCyc = (cfg.dtc_lsb_fs * FS) / configTVcoS(cfg);',
            explain: (
              <span>
                fixed-time:把固定的 Δt(預設 312.5 fs)換算成當前 T_vco 下的 cycles。N ≠ 3.125
                時 <M>{'\\text{lsbCyc} \\neq 1/256'}</M>,code-to-phase 對映偏離 grid,產生
                systematic scale error。
              </span>
            ),
          },
          {
            code: 'table[c] = gain * c * lsbCycles + offsetCycles + …',
            explain: (
              <span>
                per-code delay table 一次建好(frozen):第一項是理想線性延遲,其後 offset、
                sinusoidal INL、polynomial INL、LUT、DNL 隨機走廊全是 Ch15 的 behavioral
                nonideality,本章全部保持 0。
              </span>
            ),
          },
          {
            code: 'inlSinAmpCycles * Math.sin((2.0 * Math.PI * c) / nCodes)',
            explain: (
              <span>
                sinusoidal INL 模型 <M>{'a \\sin(2\\pi c/64)'}</M>:本章設 0,列出以說明 analog
                誤差與量化誤差在模型中是嚴格分離、可獨立開關的。
              </span>
            ),
          },
          {
            code: 'dnlCum[c] * lsbCycles',
            explain: (
              <span>
                DNL 累積項(per-instance frozen random walk,stream <code>dnl_fb</code>)。
                同樣本章為 0——圖 #13 看到的一切誤差純粹來自捨入與 LSB scale。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            圖 #9:c_FB 的 pattern 週期 = x_ideal 的週期(N = 3.125 → 2 拍 0/32;N = 3.130 → 100
            拍)。DTC code 只是 fractional phase 的低 6 bits,沒有獨立的自由度。
          </li>
          <li>
            圖 #13(normalized, nearest):e_FB_abs 嚴格落在 ±half-LSB 虛線之間,N = 3.125 時恆為
            0(on-grid exact assertion)。
          </li>
          <li>
            圖 #13(fixed_time):把 N 設 3.01(12.04 GHz),e_FB_analog 的包絡隨 c_FB 放大到
            ≈ 0.87 ps,約為 half-LSB 的 5.6 倍——而且它是 deterministic 的,會變成 spur(Ch16)。
            N = 3.130(12.52 GHz)時因為貼近 12.5 GHz,scale 項只有 ~0.5 fs/LSB,幾乎看不出差異。
          </li>
          <li>
            圖 #28 上圖:normalized 的 peak error 貼著 half-LSB;fixed-time 呈 V 形,谷底在 12.5
            GHz 附近。兩條 peak 曲線在恰好 12.00/13.00 GHz 同時歸零(α = 0 / 0.25 → on-grid 且
            c_FB ≡ 0)。下圖:兩種 mode 的 phase LSB 在 12.5 GHz 交叉——那正是 312.5 fs 這個數字
            的由來。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解 1:「DTC LSB 是 312.5 fs,所以相位解析度固定是 1.40625°」">
          <p>
            只在 12.5 GHz 成立。fixed-time DTC 的一格是固定<strong>時間</strong>,相位解析度{' '}
            <M>{'360^\\circ \\Delta t / T_{vco}'}</M> 隨 f_vco 變:12.0 GHz 時 1.35°、13.0 GHz 時
            1.4625°。更嚴重的是 code-to-phase 對映偏離 1/256 grid 造成的累積 scale error
            (c = 63 時 ~0.8 ps),它比 half-LSB 大 5 倍,且不會被 quantizer 選擇消除。
            <EpistemicTag kind="EXACT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解 2:「e_FB_abs 是 DTC 的 analog 缺陷造成的」">
          <p>
            不是。e_FB_abs 是 <strong>digital 捨入誤差</strong>——即使 DTC 完美(normalized、
            gain = 1、INL = 0),off-grid α 也讓每拍留下 ≤ half-LSB 的殘差。analog 缺陷
            (gain/INL/DNL/mismatch)是疊加在其上的另一層,Ch15 才開啟。兩者來源不同、
            對策也不同(前者靠 DSM/dither 整形,後者靠 calibration)。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <p>
          設計上要把「捨入」與「表示」分開預算:digital 捨入誤差被 half-LSB(156.25 fs @ 12.5
          GHz)bound 住,是架構的底線;DTC 的時間 LSB 若不隨 T_vco 校正(fixed-time),在 band
          邊緣附近會引入近 0.9 ps 的 deterministic scale error(實測 12.04 GHz 處 0.87 ps),
          遠大於捨入誤差本身。因此 DTC 的
          code-to-phase gain 必須納入 per-frequency calibration(對應 Ch7 的 calibrated mapping 與
          Ch15 的 gain error 實驗),否則提高 quantizer 品質毫無意義。<EpistemicTag kind="INFERENCE" />
        </p>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            DTC 是 behavioral model:per-code delay table 為靜態(gain/offset/INL/DNL frozen),
            不含 supply/溫度漂移、code-dependent 動態效應與 jitter;fixed-time 的 scale error
            在真實系統中可由 calibration 大幅壓低,本章展示的是「未校正」情形的上界。
            <EpistemicTag kind="ASSUMPTION" /> 量化誤差部分(e_FB_abs、half-LSB bound、on-grid
            exact)為 digital-exact,可由 test vectors 逐位驗證。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionLimitation>

      <DebugTable
        columns={[
          { key: 'k', label: 'k' },
          { key: 'R_FB', label: 'R_FB' },
          { key: 'm_FB', label: 'm_FB' },
          { key: 'c_FB', label: 'c_FB' },
          { key: 'x_ideal', label: 'x_ideal' },
          { key: 'u_FB_digital', label: 'u_FB_digital' },
          { key: 'e_FB_abs', label: 'e_FB_abs' },
          { key: 'e_FB_analog', label: 'e_FB_analog' },
        ]}
        rows={tableRows}
        exportName="ch5_feedback_dtc.csv"
      />

      <ParamPanel title="參數 Parameters">
        <Slider
          label="α (N − 3)"
          value={alpha}
          min={0}
          max={0.25}
          step={0.0005}
          onChange={setAlpha}
          fmt={(v) => `${trimNumber(v, 4)} (N=${trimNumber(3 + v, 6)})`}
        />
        <PresetButtons
          label="Preset N"
          presets={PRESET_N.map((p) => ({
            label: p.label,
            onClick: () => setAlpha(p.value - 3),
          }))}
        />
        <SelectControl<Quantizer>
          label="Quantizer Q_FB"
          value={quantizer}
          options={QUANTIZER_OPTIONS}
          onChange={setQuantizer}
        />
        <SelectControl<DtcModeName>
          label="DTC mode"
          value={dtcMode}
          options={DTC_MODE_OPTIONS}
          onChange={setDtcMode}
        />
      </ParamPanel>
    </ChapterShell>
  );
}
