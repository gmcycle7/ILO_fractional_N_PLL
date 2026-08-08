/**
 * Chapter 16 — Spur 與相位雜訊分析 Spur and Phase-Noise Analysis
 *
 * 內容契約:CHAPTER_GUIDE.md Ch16;數學契約:MODEL_SPEC.md §17(measurement
 * conventions:sample rate = f_ref、f_spur = m/P·f_ref、Hann PSD、dBc
 * convention 全文引用)、§12(fixed seed)、§15(誤差性質 → 頻譜後果)。
 * 互動圖:#17 Hann PSD、#18 spur markers(標 m/P·f_ref);
 * 五種 error-signature preset 一鍵切換。所有計算經由 ../model。
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
  periodogramPsd,
  detectSpurs,
  psdToDbcPerHz,
  toneAmpToDbc,
  rms,
  TWO_PI,
} from '../model';
import type { SimConfig, Spur } from '../model';

const meta = chapterById(16)!;

const LSB = 1 / 256;
/** 10*log10(2):psdDb(10log10 S)→ dBc/Hz(10log10 S/2)的常數差,顯示用 */
const LOG2_DB = 10 * Math.log10(2);
const FLOOR_DB = -220; // 顯示下限(數值 floor 以下截斷,僅影響畫面)

/* ------------------------------------------------- 五種 error signature */

type SigId = 'spur' | 'broadband' | 'offset' | 'rj' | 'pj';

interface SigPreset {
  id: SigId;
  label: string;
  zh: string;
  mechanism: string;
  signature: string;
  /** 週期 P(deterministic periodic 時才有;f_spur = m/P · f_ref) */
  P: number | null;
  partial: Partial<SimConfig>;
}

const SIG_PRESETS: SigPreset[] = [
  {
    id: 'spur',
    label: 'deterministic spur',
    zh: '確定性 spur',
    mechanism: '0.125 LSB 週期量化誤差(N = 3 + 32.125/256,nearest)',
    signature: '離散 tone @ m·(f_ref/8) = m·500 MHz(恰落在 FFT bin 上)',
    P: 8,
    partial: { n_div: 3 + 32.125 / 256, quantizer: 'nearest' },
  },
  {
    id: 'broadband',
    label: 'broadband',
    zh: '寬頻 noise floor',
    mechanism: 'VCO white phase noise 0.02 rad/cycle + sin injection K=0.3(N=3.125 on-grid)',
    signature: '無離散 tone 的連續 floor',
    P: null,
    partial: { n_div: 3.125, sigma_vco_w_rad: 0.02, inj_model: 'sin', k_inj: 0.3 },
  },
  {
    id: 'offset',
    label: 'static offset',
    zh: '固定 offset',
    mechanism: 'route_INJ = 2 LSB 靜態 skew(N=3.125,無 noise;exp16)',
    signature: '能量全部集中在 DC(近 DC 的 Hann main lobe)',
    P: null,
    partial: { n_div: 3.125, route_inj_cycles: 2 * LSB },
  },
  {
    id: 'rj',
    label: 'random jitter',
    zh: '隨機 jitter(RJ)',
    mechanism: 'reference jitter 100 fs rms(white)+ linear injection K=0.3(exp16)',
    signature: '白色 floor(無 tone)',
    P: null,
    partial: { n_div: 3.125, sigma_ref_s: 100e-15, inj_model: 'linear', k_inj: 0.3 },
  },
  {
    id: 'pj',
    label: 'periodic jitter',
    zh: '週期性 jitter(PJ)',
    mechanism: 'DTC sin INL 0.5 LSB + off-grid N=3.13(fine-code 小數增量 0.28 = 7/25 → P=25;exp14)',
    signature: '密集 tone @ m·(f_ref/25) = m·160 MHz',
    P: 25,
    partial: { n_div: 3.13, inl_sin_amp_cycles: 0.5 * LSB },
  },
];

/* ---------------------------------------------------------- 真實模型碼節錄 */

const CODE_EXCERPT = `// web/src/model/measurements.ts — Hann-window periodogram(MODEL_SPEC §17)
export function periodogramPsd(
  x: ArrayLike<number>,
  fs: number,
): { freqsHz: Float64Array; psd: Float64Array } {
  const xt = pow2Truncate(x);
  const n = xt.length;
  const w = new Float64Array(n);
  let u = 0.0;
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / n);
    u += w[i] * w[i];
  }
  u /= n;
  const xw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xw[i] = xt[i] * w[i];
  }
  const { re, im } = rfft(xw);
  const m = re.length;
  const psd = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    psd[i] = (re[i] * re[i] + im[i] * im[i]) / (fs * n * u);
  }
  for (let i = 1; i < m - 1; i++) {
    psd[i] *= 2.0; // one-sided (DC and Nyquist not doubled)
  }
  // bin spacing fs/n (n is a power of 2 -> exact); freqs[last] == fs/2
  const freqsHz = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    freqsHz[i] = i * (fs / n);
  }
  return { freqsHz, psd };
}

// dBc helpers(同檔):
export function toneAmpToDbc(aRad: number): number {
  return 20.0 * Math.log10(aRad / 2.0);
}`;

/* ---------------------------------------------------------------- 章節主體 */

type NCyclesStr = '256' | '512' | '1024';

export default function Chapter16() {
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const [sigId, setSigId] = useState<SigId>('spur');
  const [nCyclesStr, setNCyclesStr] = useState<NCyclesStr>('1024');
  const [thresholdDb, setThresholdDb] = useState(30);
  const [showMarkers, setShowMarkers] = useState(true);

  const preset = SIG_PRESETS.find((p) => p.id === sigId) ?? SIG_PRESETS[0];
  const nCycles = Number(nCyclesStr);

  // 模擬 + PSD(fixed seed 12345:每次重跑逐位一致)
  const sim = useMemo(() => {
    const cfg = fromPartial({ ...preset.partial, n_cycles: nCycles });
    const res = simulate(cfg);
    const eZc = res.data.e_ZC_total; // cycles
    const phi = Float64Array.from(eZc, (v) => TWO_PI * v); // rad
    const { freqsHz, psd } = periodogramPsd(phi, cfg.f_ref_hz);
    const dbc = psdToDbcPerHz(psd);
    return {
      cfg,
      tVco: res.t_vco_s,
      eZc,
      rmsCycles: rms(eZc),
      freqsHz,
      psd,
      dbc,
    };
  }, [preset, nCycles]);

  const spurs: Spur[] = useMemo(
    () => detectSpurs(sim.freqsHz, sim.psd, thresholdDb),
    [sim, thresholdDb],
  );

  useEffect(() => {
    setStatus('done', `${preset.label}: ${nCycles} cycles → PSD(fs = f_ref = 4 GHz)`);
  }, [preset, nCycles, setStatus]);

  /* ------------------------------------------------------------ 圖表選項 */

  // 時域:前 128 拍
  const timeOption = useMemo(() => {
    const m = Math.min(128, sim.eZc.length);
    const data: [number, number][] = [];
    for (let k = 0; k < m; k++) {
      data.push([k, sim.eZc[k]]);
    }
    return makeLineOption({
      xLabel: 'k(reference cycle;sample rate = f_ref,非 f_vco)',
      yLabel: phaseAxisLabel('e_ZC_total', unit, sim.tVco),
      yTickFormatter: makePhaseTickFormatter(unit, sim.tVco),
      zoom: false,
      series: [
        {
          name: preset.label,
          data,
          step: 'middle',
          showSymbol: false,
          color: ct.accent,
        },
      ],
    });
  }, [sim, preset, unit, ct]);

  // #17 PSD + #18 spur markers
  const psdOption = useMemo(() => {
    const line: [number, number][] = [];
    for (let i = 1; i < sim.freqsHz.length; i++) {
      line.push([sim.freqsHz[i] / 1e6, Math.max(sim.dbc[i], FLOOR_DB)]);
    }
    const spurPts: [number, number][] = spurs.map((s) => [
      s.freqHz / 1e6,
      Math.max(s.psdDb - LOG2_DB, FLOOR_DB),
    ]);
    const opt = makeLineOption({
      xLabel: 'frequency(MHz;Nyquist = f_ref/2 = 2000 MHz)',
      yLabel: 'S_phi / 2(dBc/Hz)',
      yMin: FLOOR_DB,
      series: [
        { name: 'Hann PSD(dBc/Hz)', data: line, color: ct.accent, width: 1.2 },
        {
          name: `detected spurs(> median + ${trimNumber(thresholdDb, 3)} dB)`,
          data: spurPts,
          type: 'scatter',
          symbolSize: 8,
          color: ct.bad,
        },
      ],
    });
    if (showMarkers && preset.P !== null) {
      const P = preset.P;
      const fRefMhz = sim.cfg.f_ref_hz / 1e6;
      const mMax = Math.min(8, Math.floor(P / 2));
      const marks = Array.from({ length: mMax }, (_, i) => ({
        x: ((i + 1) / P) * fRefMhz,
        label: `m=${i + 1}`,
        color: ct.warn,
      }));
      (opt as unknown as { series: Record<string, unknown>[] }).series[0].markLine =
        makeMarkLine(marks);
    }
    return opt;
  }, [sim, spurs, preset, showMarkers, thresholdDb, ct]);

  // spur 表(前 12 個,依強度排序)
  const spurRows = useMemo(
    () =>
      spurs.slice(0, 12).map((s, i) => {
        const mEst =
          preset.P !== null ? Math.round(s.freqHz / (sim.cfg.f_ref_hz / preset.P)) : null;
        return {
          rank: i + 1,
          f_mhz: s.freqHz / 1e6,
          level_dbc_hz: s.psdDb - LOG2_DB,
          m_over_P: mEst !== null && preset.P !== null ? `${mEst}/${preset.P}` : '—',
        };
      }),
    [spurs, preset, sim],
  );

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            per-reference-cycle 誤差序列的取樣率是多少?為什麼是 f_ref 而
            <strong>不是</strong> f_vco?<EpistemicTag kind="EXACT" />
          </li>
          <li>
            週期 P 的 deterministic 誤差,spur 會出現在哪些頻率?
            (<M>{'f_{spur,m} = \\tfrac{m}{P} f_{ref}'}</M>)<EpistemicTag kind="EXACT" />
          </li>
          <li>
            Hann-window periodogram 怎麼正規化?dBc 與 dBc/Hz 的標示規則是什麼、
            何時<strong>不可</strong>標 dBc?<EpistemicTag kind="EXACT" />
          </li>
          <li>
            五種 error signature(deterministic spur / broadband / static offset /
            random jitter / periodic jitter)在時域與 PSD 上各長什麼樣?
            <EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          Scheduler 每個 reference edge 只做<strong>一次</strong>決策、產生一筆誤差樣本,
          所以 <M>{'e_{ZC}[k]'}</M> 這類序列天生就是取樣率 <M>{'f_{ref}'}</M>(預設 4 GHz)
          的離散訊號 — 兩個 reference edge 之間沒有其他觀測點,VCO 在中間跑了幾個
          cycle 都不會增加樣本數。Nyquist 因此是 <M>{'f_{ref}/2 = 2\\,\\mathrm{GHz}'}</M>。
        </p>
        <p>
          誤差的<strong>性質</strong>決定頻譜的<strong>簽名</strong>(MODEL_SPEC §15):
          固定誤差 → 靜態 phase offset(能量在 DC);週期誤差 → deterministic spur
          (能量集中在 <M>{'m/P \\cdot f_{ref}'}</M> 的離散 tone);
          noise-like 誤差 → phase-noise floor(能量攤平)。<EpistemicTag kind="INFERENCE" />
          反過來,看 PSD 就能推斷誤差來源:本章把 Ch11(量化)、Ch14(誤差性質)、
          Ch15(mismatch)全部接到頻域,用同一把尺(§17 conventions)量。
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>
          <strong>取樣率。</strong>MODEL_SPEC §17 原文:「per-reference-cycle sequence
          的 sample rate = <strong>f_ref</strong>(<strong>不是</strong> f_vco)」。
          <EpistemicTag kind="EXACT" /> 長度 N 的序列 FFT 後 bin 間距為
          <M>{'\\Delta f = f_{ref}/N'}</M>,最高頻率恰為 <M>{'f_{ref}/2'}</M>。
        </p>
        <p>
          <strong>週期序列的 spur 位置。</strong>若 <M>{'\\varphi[k] = \\varphi[k+P]'}</M>
          (週期 P 拍),頻譜只在基頻 <M>{'f_{ref}/P'}</M> 的整數倍有能量:
          <EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {'f_{spur,m} = \\frac{m}{P}\\, f_{ref}, \\qquad m = 1, 2, \\ldots, \\lfloor P/2 \\rfloor'}
        </MathBlock>
        <p>
          <strong>Hann periodogram(one-sided)。</strong>序列先截為 2 的冪長度 N,
          乘上 periodic Hann window 後取 FFT:<EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>
          {'w[n] = 0.5 - 0.5\\cos\\!\\Big(\\frac{2\\pi n}{N}\\Big), \\qquad U = \\frac{1}{N}\\sum_{n=0}^{N-1} w[n]^2'}
        </MathBlock>
        <MathBlock>
          {'S_{\\varphi}[i] = \\frac{2\\,\\big|\\mathrm{FFT}(\\varphi w)[i]\\big|^2}{f_{ref}\\, N\\, U}'}
        </MathBlock>
        <p>
          (DC 與 Nyquist bin 不乘 2。)正規化 <M>{'U'}</M> 使 white noise 的 PSD
          積分後回到其 variance。<strong>dBc convention</strong> — MODEL_SPEC §17
          全文引用:
        </p>
        <Callout type="note" title="MODEL_SPEC §17 — dBc convention(逐字引用)">
          <p>
            「<strong>dBc convention</strong>:phase sequence <code>phi[k]</code>(rad)中幅度{' '}
            <code>a</code> rad 的 tone,small-angle 下 SSB spur ={' '}
            <code>20*log10(a/2)</code> dBc;PSD 曲線標 <code>10*log10(S_phi/2)</code> dBc/Hz
            (<code>S_phi</code> 單位 rad²/Hz)。未經 carrier normalization 的 phase PSD{' '}
            <strong>不可</strong>直接標 dBc。」<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
        <p>來源是 narrowband FM 的一階展開(small-angle):</p>
        <MathBlock>
          {'e^{j(\\omega_c t + a\\cos 2\\pi f_m t)} \\approx e^{j\\omega_c t}\\Big(1 + j\\frac{a}{2}e^{j2\\pi f_m t} + j\\frac{a}{2}e^{-j2\\pi f_m t}\\Big)'}
        </MathBlock>
        <p>
          兩個 sideband 相對 carrier 各為 <M>{'a/2'}</M>,故 SSB spur ={' '}
          <M>{'20\\log_{10}(a/2)'}</M> dBc。<EpistemicTag kind="EXACT" />
        </p>
      </SectionMath>

      <SectionExample>
        <p>三個手算可驗的數字:</p>
        <ol>
          <li>
            <strong>tone → dBc:</strong>幅度 a = 0.01 rad 的 tone:
            <M>{'20\\log_{10}(0.005) = -46.02\\ \\mathrm{dBc}'}</M>。模型計算:
            toneAmpToDbc(0.01) = {trimNumber(toneAmpToDbc(0.01), 6)} dBc。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            <strong>spur 位置:</strong>preset「deterministic spur」的 N = 3 + 32.125/256:
            fine code 每拍走 <M>{'G \\cdot N = 800.125'}</M> LSB,小數部分 0.125 LSB;
            8 拍恰累積 1 LSB 整數 → 誤差 pattern 週期 P = 8(模擬驗證:序列
            e_ZC_total 逐位以 8 為週期)→ spur 在 m·(4 GHz/8) =
            <strong> m·500 MHz</strong>,m = 1..4(m=4 恰為 Nyquist)。
            同法可算 PJ preset:N=3.13 → 小數增量 0.28 = 7/25 → P = 25 →
            tone 間距 160 MHz。<EpistemicTag kind="EXACT" />
          </li>
          <li>
            <strong>static offset:</strong>route 2 LSB = 2/256 cycle →
            φ = 2π·2/256 = {trimNumber(TWO_PI * 2 * LSB, 4)} rad 的 DC 值;
            能量集中於 DC,不產生 spur 也不抬 floor。<EpistemicTag kind="EXACT" />
          </li>
        </ol>
      </SectionExample>

      <SectionFigure
        title={`五種 error signature — 時域(目前:${preset.zh})`}
        caption={
          <span>
            橫軸 k(取樣率 = f_ref = 4 GHz;只畫前 128 拍),縱軸 e_ZC_total
            (單位:<UnitSwitch />)。目前 preset:{preset.mechanism};rms ={' '}
            {formatPhase(sim.rmsCycles, unit, sim.tVco)}。右側面板可一鍵切換
            五種 signature(config 見下表)。<EpistemicTag kind="EXPERIMENT" />
          </span>
        }
      >
        <EChart option={timeOption} height={260} group="ch16" />
        <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>分類</th>
                <th>機制(config)</th>
                <th>預期頻譜簽名</th>
                <th>P</th>
              </tr>
            </thead>
            <tbody>
              {SIG_PRESETS.map((p) => (
                <tr key={p.id} style={p.id === sigId ? { fontWeight: 600 } : undefined}>
                  <td>
                    {p.zh}({p.label})
                  </td>
                  <td>{p.mechanism}</td>
                  <td>{p.signature}</td>
                  <td>{p.P ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionFigure>

      <SectionFigure
        title="圖 #17 + #18 — Hann PSD 與 spur markers"
        caption={
          <span>
            橫軸 MHz(bin 間距 f_ref/N = {trimNumber(4000 / nCycles, 4)} MHz,
            最右端 = Nyquist 2000 MHz),縱軸 10·log10(S_phi/2) dBc/Hz
            (φ 以 rad 計,已依 §17 convention 正規化)。紅點 = detectSpurs
            找到的 local maxima(高於 median + threshold);黃虛線 ={' '}
            <M>{'m/P \\cdot f_{ref}'}</M> 預測位置(只標前 8 個 m;deterministic
            periodic preset 才有)。DC bin 不畫;低於 {FLOOR_DB} dB 截斷顯示。
            deterministic preset 的低階「floor」來自 float64 數值精度與
            window leakage,不是物理雜訊。
          </span>
        }
      >
        <EChart option={psdOption} height={340} group="ch16" />
        <div style={{ marginTop: '0.75rem' }}>
          <DebugTable
            columns={[
              { key: 'rank', label: '#' },
              { key: 'f_mhz', label: 'f (MHz)', fmt: (v) => trimNumber(Number(v), 6) },
              {
                key: 'level_dbc_hz',
                label: 'level (dBc/Hz)',
                fmt: (v) => trimNumber(Number(v), 5),
              },
              { key: 'm_over_P', label: 'm/P' },
            ]}
            rows={spurRows}
            maxHeight={240}
            exportName="ch16_spurs.csv"
          />
        </div>
        <Callout type="note" title="固定 seed 之可重現性">
          <p>
            所有含 noise 的 preset 都用 base_seed = 12345 的 named PRNG streams
            (mulberry32;ref:1、vco_w:2、vco_rw:3、…,MODEL_SPEC §12)。
            重新整理頁面、或改用 Python golden model 跑同一 config,得到的時域序列與
            PSD <strong>逐位一致</strong>(純數位路徑 tolerance 1e-12,含 noise
            路徑 1e-9,libm 差異)。<EpistemicTag kind="EXACT" /> 表格的 CSV export
            可直接 diff 對照。
          </p>
        </Callout>
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model/measurements.ts(真實碼節錄)"
        code={CODE_EXCERPT}
      >
        <p>
          這是網站與 Python golden model 共用定義的 PSD(radix-2 FFT 自含實作,
          無外部相依);dBc 換算不藏在繪圖層,而是 model 的 export。
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'const xt = pow2Truncate(x);',
            explain: '截為 2 的冪長度(§17:FFT 截為 2 的冪),bin 間距 f_ref/N 為精確二進位數。',
          },
          {
            code: 'w[i] = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / n);',
            explain: (
              <span>
                periodic Hann window:壓 spectral leakage(第一 sidelobe 約 −31 dB),
                代價是 main lobe 寬約 2 bins — 所以 static offset 的 DC 能量會
                「暈」到鄰近幾個 bin。
              </span>
            ),
          },
          {
            code: 'u += w[i] * w[i];  …  u /= n;',
            explain: (
              <span>
                <M>{'U = \\mathrm{mean}(w^2)'}</M>:window power 正規化,
                使 white noise 的 PSD 積分回到 variance(能量守恆)。
              </span>
            ),
          },
          {
            code: 'xw[i] = xt[i] * w[i];',
            explain: '先加窗再 FFT;輸入 φ[k] 單位是 rad,PSD 單位因此是 rad²/Hz。',
          },
          {
            code: 'psd[i] = (re[i] * re[i] + im[i] * im[i]) / (fs * n * u);',
            explain: (
              <span>
                periodogram 正規化:除以 <M>{'f_s N U'}</M>。此處 fs 一律傳入
                f_ref = 4 GHz — 這一行就是「sample rate = f_ref」convention 的落點
                (acceptance test 12)。
              </span>
            ),
          },
          {
            code: 'psd[i] *= 2.0; // one-sided (DC and Nyquist not doubled)',
            explain: 'one-sided 慣例:正頻率 bin 乘 2,DC 與 Nyquist 不乘(它們沒有鏡像 bin)。',
          },
          {
            code: 'freqsHz[i] = i * (fs / n);',
            explain: '頻率軸由 0 到 fs/2 = 2 GHz;spur 預測位置 m/P·f_ref 直接落在這條軸上。',
          },
          {
            code: 'return 20.0 * Math.log10(aRad / 2.0);',
            explain: (
              <span>
                SSB spur dBc:tone 幅度 a rad 的 sideband 是 a/2 —
                手算例 a = 0.01 → −46.02 dBc。small-angle 假設,a 接近 1 rad 時失效。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            <strong>deterministic spur(P=8)</strong>:恰好 4 根 tone,位置
            500 / 1000 / 1500 / 2000 MHz,與黃色 m/P 虛線逐根重合;
            0.125 是 dyadic 數,tone 恰落在 FFT 整數 bin 上,bin 之間的 floor
            低於 −300 dB(float64 數值精度)。注意 2000 MHz 那根在 Nyquist
            端點 — detectSpurs 的 local-maximum 定義不含端點,所以它沒有紅點。
          </li>
          <li>
            <strong>對照:</strong>若改用 exp07 的 0.3 LSB(P=10,tone 在
            m·400 MHz),因 400 MHz = 102.4 bin 不是整數,Hann leakage 會把
            tone 攤成 skirt、floor 升到約 −150 dBc/Hz — spur 位置公式不變,
            差別只在 FFT 取樣格點的呈現。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            <strong>periodic jitter(P=25)</strong>:tone 間距縮成 160 MHz、
            數量變多且更密;黃虛線只標前 8 根(至 1280 MHz),其餘 tone 仍準確
            落在 160 MHz 格點上(用 zoom 拉近驗證)。
          </li>
          <li>
            <strong>static offset</strong>:時域是一條 2 LSB 的水平線;
            PSD 只剩近 DC 的 Hann main lobe,中高頻什麼都沒有 —
            固定誤差不產生 spur。
          </li>
          <li>
            <strong>broadband / random jitter</strong>:時域雜亂、PSD 是連續 floor,
            detectSpurs 幾乎找不到穩定 local maxima(把 threshold slider 調低,
            會開始抓到統計突波 — 這不是 spur)。
          </li>
          <li>
            n_cycles 從 256 → 1024:bin 間距變細(15.6 → 3.9 MHz),tone 變「尖」
            但位置不變;noise floor 則因單一 periodogram 無 averaging 而抖動。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解一:PSD 的頻率軸應該延伸到 f_vco/2">
          <p>
            錯。誤差序列每個 <strong>reference</strong> cycle 只有一個樣本,
            取樣率是 f_ref = 4 GHz,Nyquist = 2 GHz。f_vco(約 12.5 GHz)的載波與其
            harmonics 根本不在這個序列裡;把這條 PSD 當成 VCO 輸出頻譜、或把軸標到
            f_vco,都是單位錯誤(MODEL_SPEC §17、acceptance test 12)。
          </p>
        </Callout>
        <Callout type="warn" title="誤解二:任何 phase PSD 都可以標 dBc">
          <p>
            錯。dBc 是「相對 carrier」的量,只有把 φ 以 rad 表示、經 small-angle
            換算(SSB = 20·log10(a/2)、PSD 標 10·log10(S_phi/2))之後才成立。
            未經 carrier normalization 的 PSD(例如單位是 cycles²/Hz 或 fs²/Hz)
            <strong>不可</strong>直接寫 dBc — 這正是 §17 引文的最後一句。
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>
            誤差性質 → 頻譜簽名是設計診斷表:DC(offset)/ 離散 tone(periodic,
            位置由 <M>{'m/P \\cdot f_{ref}'}</M> 完全預測)/ floor(random)。
            看到 spur 先算 P,就知道去哪一級找 bug。<EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            fractional spur 的<strong>位置</strong>只由 α 的有理結構(pattern 週期 P)
            決定,與 mismatch 大小無關 — mismatch 只決定 tone 的<strong>高度</strong>。
            <EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            量測 convention 要釘死:sample rate = f_ref、Hann one-sided periodogram、
            dBc 依 §17 — 否則跨團隊 / 跨語言的 dB 數字無法互相比對。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            固定 seed(12345)讓 spur 表可以進 regression:數字變了就是 model 變了,
            不是運氣變了。<EpistemicTag kind="EXACT" />
          </li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <ul>
            <li>
              此處的 PSD 是 <strong>scheduler 誤差序列</strong>的頻譜,不是鎖相後
              VCO 輸出的 phase noise:沒有 PLL loop shaping,injection 的 tracking
              行為本身也是近似(Ch13)。<EpistemicTag kind="APPROX" />
            </li>
            <li>
              單一 Hann periodogram 無 averaging:noise floor 每個 bin 的 variance
              很大;要平滑需 Welch-type 平均,model 刻意不做,以維持
              「一次模擬 = 一份可逐位重現的資料」。
            </li>
            <li>
              dBc 換算依 small-angle 近似<EpistemicTag kind="APPROX" />;
              φ 幅度接近 1 rad 時 Bessel 高階項不可忽略。
            </li>
            <li>本專案未執行 Spectre;行為級頻譜 ≠ silicon 量測(MODEL_SPEC §20)。</li>
          </ul>
        </Callout>
      </SectionLimitation>

      <ParamPanel title="Ch16 參數">
        <PresetButtons
          label="Error signature(一鍵切換)"
          presets={SIG_PRESETS.map((p) => ({
            label: p.zh,
            onClick: () => setSigId(p.id),
          }))}
        />
        <SelectControl<NCyclesStr>
          label="n_cycles"
          value={nCyclesStr}
          options={[
            { value: '256', label: '256(Δf = 15.6 MHz)' },
            { value: '512', label: '512(Δf = 7.8 MHz)' },
            { value: '1024', label: '1024(Δf = 3.9 MHz)' },
          ]}
          onChange={setNCyclesStr}
        />
        <Slider
          label="spur threshold(median +)"
          value={thresholdDb}
          min={6}
          max={60}
          step={1}
          unit="dB"
          onChange={setThresholdDb}
        />
        <Toggle label="顯示 m/P·f_ref markers" checked={showMarkers} onChange={setShowMarkers} />
      </ParamPanel>
    </ChapterShell>
  );
}
