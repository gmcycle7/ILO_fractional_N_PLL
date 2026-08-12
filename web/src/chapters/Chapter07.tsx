/**
 * Chapter 7 — 8-phase Injection Tap Mapping
 *
 * MODEL_SPEC.md §8:tap spacing 32 LSB vs DTC range 64 LSB → redundancy;
 * naive / nearest / calibrated 三種 mapping;u_target = 0.40 手算例;
 * 互動圖 #3(8-tap phase wheel)、#10(tap code)、#11(injection DTC code)。
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
import { ParamPanel, Slider, SelectControl, PresetButtons } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import PhaseWheel from '../components/PhaseWheel';
import DebugTable from '../components/DebugTable';
import { makeLineOption, makeMarkLine } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { formatPhase, trimNumber } from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterById } from './index';
import {
  simulate,
  fromPartial,
  runInjection,
  makeDtc,
  tapTable,
  makeAllStreams,
  wrap01,
  wrapCycles,
  type InjMapping,
} from '../model';

const meta = chapterById(7)!;

const MAPPINGS = ['naive', 'nearest', 'calibrated'] as const;
const N_CODES = 96; // code plot 模擬長度
const N_BASIN = 128; // basin 逐拍情境模擬長度

/** basin 逐拍播放的情境:off = slider 靜態模式 */
type BasinScenario = 'off' | 'latency' | 'dsm';

interface MapPick {
  j: number;
  c: number;
  R: number;
  uDig: number;
  uAn: number;
}

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

const MAPPING_OPTIONS: { value: InjMapping; label: string }[] = [
  { value: 'naive', label: 'naive floor' },
  { value: 'nearest', label: 'nearest phase' },
  { value: 'calibrated', label: 'calibrated' },
];

export default function Chapter07() {
  const [uTarget, setUTarget] = useState(0.4);
  const [mapping, setMapping] = useState<InjMapping>('naive');
  const [tap3Deg, setTap3Deg] = useState(0); // tap 3 mismatch, degrees
  const [alpha, setAlpha] = useChapterAlpha();
  const [eSchedLsb, setESchedLsb] = useState(0.5); // basin 圖:總排程誤差(LSB)
  // #10b tap 交棒動畫:每拍 2 個 sub-stage(偶 = tap 對準、奇 = DTC 弧),k = floor(t/2)
  const [tapPlayT, setTapPlayT] = useState(1);
  const [tapPlaying, setTapPlaying] = useState(false);
  // basin 捕捉逐拍動態
  const [basinScenario, setBasinScenario] = useState<BasinScenario>('off');
  const [basinK, setBasinK] = useState(0);
  const [basinPlaying, setBasinPlaying] = useState(false);
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  // --- 單點 mapping demo(圖 #3):三種 mapping 同時解 ---
  const demo = useMemo(() => {
    const mm = Array.from({ length: 8 }, (_, j) => (j === 3 ? tap3Deg / 360 : 0));
    const baseCfg = fromPartial({
      arch_mode: 'A',
      quantizer: 'nearest',
      tap_mismatch_cycles: mm,
      n_cycles: 1,
    });
    const streams = makeAllStreams(baseCfg.seed);
    const dtc = makeDtc(baseCfg, 'inj', streams);
    const taps = tapTable(baseCfg.n_tap, baseCfg.tap_mismatch_cycles);
    // x_nominal 使 u_INJ_ideal = wrap01(z0 - x) = uTarget
    const x = Float64Array.of(wrap01(baseCfg.z0_cycles - uTarget));
    const picks = {} as Record<InjMapping, MapPick>;
    for (const m of MAPPINGS) {
      const cfg = fromPartial({ ...baseCfg, inj_mapping: m });
      const r = runInjection(cfg, x, Float64Array.of(0), dtc, taps, null);
      picks[m] = {
        j: r.j_INJ[0],
        c: r.c_INJ[0],
        R: r.R_INJ[0],
        uDig: r.u_INJ_digital[0],
        uAn: r.u_INJ_analog[0],
      };
    }
    const dtcDelay = (c: number) => dtc.delayCycles(c);
    return { picks, taps, dtcDelay };
  }, [uTarget, tap3Deg]);

  const sel = demo.picks[mapping];
  const rTargetU = sel.R / 256; // 模型的 mapping 目標(digital command target)

  // redundant 替代解:(j, c) <-> (j∓1, c±32)
  const alt = useMemo(() => {
    const jA = sel.c >= 32 ? (sel.j + 1) % 8 : (sel.j + 7) % 8;
    const cA = sel.c >= 32 ? sel.c - 32 : sel.c + 32;
    return { j: jA, c: cA, uAn: wrap01(demo.taps[jA] + demo.dtcDelay(cA)) };
  }, [sel, demo]);

  // --- 圖 #10 / #11:tap code 與 DTC code 序列 ---
  const codeRes = useMemo(() => {
    const mm = Array.from({ length: 8 }, (_, j) => (j === 3 ? tap3Deg / 360 : 0));
    return simulate(
      fromPartial({
        n_div: 3 + alpha,
        n_cycles: N_CODES,
        inj_mapping: mapping,
        tap_mismatch_cycles: mm,
      }),
    );
  }, [alpha, mapping, tap3Deg]);

  useEffect(() => {
    setStatus('done', `Ch7: ${N_CODES} cycles (${mapping})`);
  }, [codeRes, mapping, setStatus]);

  const tVco = codeRes.t_vco_s;

  // --- 圖 #10b:tap 交棒動畫(重用 codeRes,兩段式 sub-stage) ---
  useEffect(() => {
    if (!tapPlaying) return undefined;
    const id = window.setInterval(() => {
      setTapPlayT((t) => (t + 1) % (2 * N_CODES));
    }, 420);
    return () => window.clearInterval(id);
  }, [tapPlaying]);

  const playK = Math.floor(tapPlayT / 2);
  const tapStage: 'tap' | 'arc' = tapPlayT % 2 === 0 ? 'tap' : 'arc';

  const play = useMemo(() => {
    const d = codeRes.data;
    const j = d.j_INJ[playK];
    const trail: { angleCycles: number; color?: string; r?: number; opacity?: number }[] = [];
    for (let b = 1; b <= 4 && playK - b >= 0; b++) {
      trail.push({
        angleCycles: wrap01(d.u_INJ_analog[playK - b]),
        color: 'var(--fg-subtle)',
        r: 0.8,
        opacity: 0.45 - 0.1 * b, // 前 1..4 拍漸淡
      });
    }
    return {
      j,
      c: d.c_INJ[playK],
      tapU: demo.taps[j],
      uAn: wrap01(d.u_INJ_analog[playK]),
      uIdeal: d.u_INJ_ideal[playK],
      eAbs: d.e_INJ_abs[playK],
      trail,
    };
  }, [codeRes, playK, demo]);

  const jOption = useMemo(
    () =>
      withMarkLine(
        makeLineOption({
          title: '#10 injection tap code j_INJ[k]',
          xLabel: 'k (reference cycle)',
          yLabel: 'j_INJ',
          yMin: 0,
          yMax: 7,
          series: [
            {
              name: 'j_INJ',
              data: toXY(codeRes.data.j_INJ),
              color: ct.series[0],
              step: 'middle',
              showSymbol: true,
              symbolSize: 4,
            },
          ],
        }),
        0,
        makeMarkLine([{ x: playK, label: `k=${playK}` }]),
      ),
    [codeRes, ct, playK],
  );

  const cOption = useMemo(() => {
    const opt = makeLineOption({
      title: '#11 injection DTC code c_INJ[k]',
      xLabel: 'k (reference cycle)',
      yLabel: 'c_INJ',
      yMin: 0,
      yMax: 63,
      series: [
        {
          name: 'c_INJ',
          data: toXY(codeRes.data.c_INJ),
          color: ct.series[1],
          step: 'middle',
          showSymbol: true,
          symbolSize: 4,
        },
      ],
    });
    return withMarkLine(
      opt,
      0,
      makeMarkLine([{ y: 31.5, label: 'naive 上限 c=31' }, { x: playK }]),
    );
  }, [codeRes, ct, playK]);

  // --- basin 捕捉逐拍動態:兩個一鍵情境(exp10 式 / exp21b 式)---
  const basinSim = useMemo(() => {
    if (basinScenario === 'off') return null;
    const cfg =
      basinScenario === 'latency'
        ? // exp10 式:L=1 無 look-ahead,N=3.13
          fromPartial({ n_div: 3.13, latency_cycles: 1, lookahead: false, n_cycles: N_BASIN })
        : // exp21b 式:dsm_only 無 gating
          fromPartial({
            n_div: 3.13,
            quantizer: 'ef1',
            actuator_mode: 'dsm_only',
            inj_model: 'sin',
            k_inj: 0.4,
            delta_f_hz: 1e6,
            sigma_vco_w_rad: 0.02,
            n_cycles: N_BASIN,
          });
    const e = simulate(cfg).data.e_ZC_hw;
    // 最近 crossing proxy:e = off/8 + resid,off = round(8e) ∈ [-4, 4]
    const off = new Int32Array(N_BASIN);
    for (let k = 0; k < N_BASIN; k++) {
      off[k] = Math.round(8 * e[k] - wrapCycles(8 * e[k]));
    }
    return { e, off };
  }, [basinScenario]);

  useEffect(() => {
    if (basinSim) setStatus('done', `Ch7 basin: ${basinScenario} × ${N_BASIN} cycles`);
  }, [basinSim, basinScenario, setStatus]);

  useEffect(() => {
    if (!basinPlaying || !basinSim) return undefined;
    const id = window.setInterval(() => {
      setBasinK((k) => Math.min(k + 1, N_BASIN - 1));
    }, 150);
    return () => window.clearInterval(id);
  }, [basinPlaying, basinSim]);

  useEffect(() => {
    if (basinK >= N_BASIN - 1) setBasinPlaying(false);
  }, [basinK]);

  // capture-count histogram 為 0..basinK 的純導出量(Reset = basinK 歸零)
  const basinNow = useMemo(() => {
    if (!basinSim) return null;
    const counts = new Array<number>(8).fill(0);
    for (let k = 0; k <= basinK; k++) {
      counts[(basinSim.off[k] + 12) % 8] += 1; // T-index = (4 + off) mod 8(排定 = T4)
    }
    return {
      e: basinSim.e[basinK],
      off: basinSim.off[basinK],
      resid: wrapCycles(8 * basinSim.e[basinK]) / 8,
      counts,
      maxCount: Math.max(1, ...counts),
    };
  }, [basinSim, basinK]);

  const startBasin = (s: Exclude<BasinScenario, 'off'>) => {
    setBasinScenario(s);
    setBasinK(0);
    setBasinPlaying(true);
  };

  // --- 1/8-cycle 對位模糊 basin 圖(slider 靜態模式為純幾何,不跑 simulate)---
  const eSchedCyc = eSchedLsb / 256;
  // 顯示值:情境播放中取 e_ZC_hw[k],否則取 slider
  const eShowCyc = basinNow ? basinNow.e : eSchedCyc;
  // 被捕捉的 crossing(相對排定 crossing 的整數位移)與 capture 後殘留
  const capturedTaps = basinNow
    ? basinNow.off
    : Math.round(8 * eSchedCyc - wrapCycles(8 * eSchedCyc));
  const residCyc = basinNow ? basinNow.resid : wrapCycles(8 * eSchedCyc) / 8;
  const falseLock = capturedTaps !== 0;
  const uPulse = 0.5 + eShowCyc; // 排定 crossing 固定畫在 0.5(T4)
  const uCaptured = 0.5 + capturedTaps / 8;
  const pullColor = falseLock ? 'var(--warn-border)' : 'var(--accent)';
  const xOf = (u: number) => 40 + u * 680; // phase axis 0..1 cycle -> px

  const tableRows = useMemo(() => {
    const d = codeRes.data;
    return Array.from({ length: 16 }, (_, i) => ({
      k: i,
      u_INJ_ideal: d.u_INJ_ideal[i],
      R_INJ: d.R_INJ[i],
      j_INJ: d.j_INJ[i],
      c_INJ: d.c_INJ[i],
      u_INJ_digital: d.u_INJ_digital[i],
      u_INJ_analog: d.u_INJ_analog[i],
      e_INJ_abs: d.e_INJ_abs[i],
    }));
  }, [codeRes]);

  const fmt6 = (v: unknown) => trimNumber(v as number, 6);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            injection 的 fine code <M>{'R_{INJ}'}</M> 如何 decode 成(tap <M>{'j'}</M>, DTC code{' '}
            <M>{'c'}</M>)?
          </li>
          <li>
            tap spacing 32 LSB、DTC range 64 LSB —— 為什麼刻意做 2× 覆蓋?redundant representation{' '}
            <M>{'(j, c) \\leftrightarrow (j{-}1, c{+}32)'}</M> 有什麼用?
          </li>
          <li>naive / nearest / calibrated 三種 mapping 各自的定義與差異?</li>
          <li>tap mismatch 出現時,calibrated mapping 為何(以及如何)改選另一個 tap?</li>
          <li>mapping 的選擇改變的是 analog 誤差還是 digital 命令?</li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          injection 路徑是一個「粗調 + 細調」的兩段式 actuator:8 個 tap 把一圈切成 45° 的粗格
          (每格 32 LSB),6-bit DTC 在 tap 之後再加 0–63 LSB 的細 delay。若 DTC range 剛好等於
          tap spacing(32 LSB),每個目標 phase 只有唯一一組 <M>{'(j, c)'}</M>;
          規格刻意讓 DTC 蓋到 64 LSB(1/4 cycle),於是相鄰兩個 tap 的可達範圍重疊了 32 LSB ——
          同一個目標有<strong>兩種</strong>表示法。
        </p>
        <p>
          這個 redundancy 不是浪費,而是類比世界的保險:當某個 tap 的實際 phase 偏了(mismatch),
          digital 命令不用改,mapping 只要改走「另一條路」—— 用前一個 tap 加上 +32 LSB 的 DTC
          delay,就能繞開壞掉的粗格。這正是 calibrated mapping 在做的事:它拿著實測的 tap/DTC
          表,對每個目標逐一比較所有 512 種 <M>{'(j, c)'}</M> 組合,選 analog 誤差最小者。
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>
          <strong>幾何常數(MODEL_SPEC §8)。</strong>G = 256,8 taps:
        </p>
        <MathBlock>
          {'\\Delta_{tap} = \\tfrac{1}{8}\\,\\text{cycle} = 32\\ \\text{LSB}, \\qquad c \\in \\{0..63\\} \\Rightarrow \\text{DTC range} = \\tfrac{1}{4}\\,\\text{cycle} = 64\\ \\text{LSB}'}
        </MathBlock>
        <p>
          合成的 digital phase(fractional,cycles):
          <EpistemicTag kind="EXACT" />
        </p>
        <MathBlock>{'u_{INJ,digital} = \\operatorname{wrap01}\\big((32j + c)/256\\big)'}</MathBlock>
        <p>
          <strong>Redundancy identity。</strong>因為 DTC range 是 tap spacing 的兩倍:
        </p>
        <MathBlock>
          {'32j + c = 32(j-1) + (c + 32), \\qquad c \\le 31 \\;\\Leftrightarrow\\; c+32 \\le 63'}
        </MathBlock>
        <p>
          即每個 code <M>{'R_{INJ}'}</M> 都有恰好兩組表示:<M>{'(j, c)'}</M> 與{' '}
          <M>{'((j-1) \\bmod 8,\\; c+32)'}</M>。<EpistemicTag kind="EXACT" />
        </p>
        <p>
          <strong>三種 mapping(輸入為 digital 命令目標 <M>{'u_{target} = R_{INJ}/G'}</M>)。</strong>
        </p>
        <MathBlock>
          {'\\textbf{naive floor:}\\quad j = \\lfloor R_{INJ}/32 \\rfloor, \\qquad c = R_{INJ} \\bmod 32'}
        </MathBlock>
        <p>只用 DTC 下半 range(<M>{'c \\le 31'}</M>),完全不碰 redundancy。</p>
        <MathBlock>
          {'\\textbf{nearest phase:}\\quad (j^*, c^*) = \\underset{j \\in \\{0..7\\},\\, c \\in \\{0..63\\}}{\\operatorname{argmin}} \\Big| \\operatorname{wrapCycles}\\big(u_{target} - (j/8 + c/256)\\big) \\Big|'}
        </MathBlock>
        <MathBlock>
          {'\\textbf{calibrated:}\\quad (j^*, c^*) = \\underset{j,\\,c}{\\operatorname{argmin}} \\Big| \\operatorname{wrapCycles}\\big(u_{target} - (tap_{actual}[j] + DTC_{actual}(c) + route_{INJ})\\big) \\Big|'}
        </MathBlock>
        <p>
          tie-break:誤差相同時取較小的 <M>{'c'}</M>,再取較小的 <M>{'j'}</M>(實作以 c-major
          枚舉 + first-minimum 達成,見第 6 節)。integer-cycle offset 已由 wrapCycles 隱含處理。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>
          理想參數下(<M>{'\\delta_{tap} = 0'}</M>、DTC exact)nearest 的兩個零誤差解正是 redundancy
          pair,tie-break 選 <M>{'c \\le 31'}</M> 那組 —— 所以 <strong>nearest 與 naive 輸出相同</strong>;
          兩者只在 calibrated(拿 actual 表)時才會分道揚鑣。<EpistemicTag kind="EXACT" />
        </p>
      </SectionMath>

      <SectionExample>
        <p>
          <strong>u<sub>target</sub> = 0.40 全手算(MODEL_SPEC §8;T<sub>vco</sub> = 80 ps 換算)。</strong>
        </p>
        <ol>
          <li>
            quantize:<M>{'256 \\times 0.40 = 102.4 \\Rightarrow R_{INJ} = \\lfloor 102.4 + 0.5 \\rfloor = 102'}</M>,
            digital 目標 <M>{'102/256 = 0.3984375'}</M>。
          </li>
          <li>
            <strong>naive</strong>:<M>{'j = \\lfloor 102/32 \\rfloor = 3'}</M>,{' '}
            <M>{'c = 102 \\bmod 32 = 6'}</M> → phase <M>{'3/8 + 6/256 = 0.3984375'}</M>。
          </li>
          <li>
            <strong>redundant 替代解</strong>:<M>{'(j, c) = (2, 38)'}</M> →{' '}
            <M>{'2/8 + 38/256 = 0.3984375'}</M>,與 (3, 6) 的 digital phase 完全相同。
            <EpistemicTag kind="EXACT" />
          </li>
          <li>
            對真實目標 0.40 的 residual:<M>{'0.3984375 - 0.40 = -0.0015625'}</M> cycle ={' '}
            <M>{'-0.4'}</M> LSB = <M>{'-0.5625^\\circ'}</M> = −125 fs —— 純 quantization,
            兩組解都一樣。
          </li>
          <li>
            <strong>開 +1° tap3 mismatch</strong>(<M>{'\\delta_{tap}[3] = +1/360 = +0.002778'}</M>{' '}
            cycle = +0.711 LSB = +222.2 fs):
            <ul>
              <li>
                naive / nearest 不知道 mismatch,仍選 (3, 6):analog 落點{' '}
                <M>{'0.375 + 0.002778 + 0.0234375 = 0.401215'}</M>,對 digital 目標誤差{' '}
                <M>{'+0.002778'}</M> cycle(整個 tap 誤差 +1° 全數吃下)。
              </li>
              <li>
                <strong>calibrated 改選 (2, 38)</strong>:tap2 未受損,analog 落點{' '}
                <M>{'0.25 + 38/256 = 0.3984375'}</M>,對 digital 目標誤差 <strong>0</strong>;
                對真實 0.40 只剩 quantization 的 −0.4 LSB。redundancy 把 +1°(0.711 LSB)的
                tap 誤差完全繞開。<EpistemicTag kind="EXACT" />
              </li>
            </ul>
          </li>
        </ol>
        <p>
          下方互動圖把 u<sub>target</sub> 調到 0.40、tap3 mismatch 調到 +1°,即可逐字重現這組數字。
        </p>
      </SectionExample>

      <SectionFigure
        title="#3 8-tap injection phase wheel:target / 選中 tap / DTC 細調 / residual / redundant 替代解"
        caption={
          <span>
            外圈 8 點 = tap 實際位置(開 mismatch 後 T3 會偏移);長針 = 理想 target{' '}
            <M>{'u_{target}'}</M>;中針 = 實際 zero crossing(tap + DTC);弧線 = DTC 細調路徑;
            短針 = redundant 替代解 <M>{'(j\\mp1, c\\pm32)'}</M>。切到 calibrated 並開啟 tap3
            mismatch,觀察選擇如何跳到替代解。讀值單位:<UnitSwitch />
          </span>
        }
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            alignItems: 'flex-start',
            justifyContent: 'center',
          }}
        >
          <PhaseWheel
            size={300}
            animateToMarker
            title={
              <span>
                mapping = {mapping};chosen (j, c) = ({sel.j}, {sel.c})
              </span>
            }
            taps={Array.from(demo.taps, (a, j) => ({
              angleCycles: a,
              label: j === 3 && tap3Deg !== 0 ? `T3 (${tap3Deg > 0 ? '+' : ''}${trimNumber(tap3Deg, 3)}°)` : `T${j}`,
              color: j === sel.j ? 'var(--accent)' : undefined,
            }))}
            markers={[
              { angleCycles: uTarget, label: 'target', color: 'var(--accent)', r: 0.95 },
              { angleCycles: wrap01(sel.uAn), label: 'actual ZC', color: 'var(--fg)', r: 0.8 },
              {
                angleCycles: demo.taps[sel.j],
                label: `tap ${sel.j}`,
                color: 'var(--fg-subtle)',
                r: 0.5,
              },
              {
                angleCycles: alt.uAn,
                label: `alt (${alt.j},${alt.c})`,
                color: 'var(--fg-faint)',
                r: 0.32,
              },
            ]}
            arcs={[
              {
                fromCycles: demo.taps[sel.j],
                toCycles: demo.taps[sel.j] + demo.dtcDelay(sel.c),
                color: 'var(--accent)',
                r: 0.68,
                width: 5,
              },
              {
                fromCycles: demo.taps[alt.j],
                toCycles: demo.taps[alt.j] + demo.dtcDelay(alt.c),
                color: 'var(--fg-faint)',
                r: 0.4,
                width: 3,
              },
            ]}
          />
          <div style={{ minWidth: 280, fontSize: '0.9rem' }}>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>mapping</th>
                    <th>(j, c)</th>
                    <th>u_analog</th>
                    <th>err vs digital 目標</th>
                    <th>err vs u_target</th>
                  </tr>
                </thead>
                <tbody>
                  {MAPPINGS.map((m) => {
                    const p = demo.picks[m];
                    return (
                      <tr key={m} style={m === mapping ? { fontWeight: 600 } : undefined}>
                        <td>{m}</td>
                        <td>
                          ({p.j}, {p.c})
                        </td>
                        <td>{trimNumber(wrap01(p.uAn), 6)}</td>
                        <td>{formatPhase(wrapCycles(p.uAn - p.R / 256), unit, tVco)}</td>
                        <td>{formatPhase(wrapCycles(p.uAn - uTarget), unit, tVco)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p style={{ marginTop: 8 }}>
              R_INJ = {sel.R};digital 目標 = {trimNumber(rTargetU, 6)} cyc;quantization residual ={' '}
              {formatPhase(wrapCycles(rTargetU - uTarget), unit, tVco)}。
              <br />
              替代解 ({alt.j}, {alt.c}) 的 analog 落點 = {trimNumber(alt.uAn, 6)} cyc,err vs digital
              目標 = {formatPhase(wrapCycles(alt.uAn - rTargetU), unit, tVco)}。
            </p>
          </div>
        </div>
      </SectionFigure>

      <SectionFigure
        title="#10 / #11 tap code 與 injection DTC code 序列"
        caption={
          <span>
            x 軸為 reference cycle k(N = 3 + α,Mode D,nearest quantizer)。上圖 j_INJ 隨 α
            反向旋轉而遞減(α ≥ 1/8 時每拍至少退一格;α=0.13 時每拍約 −33.3 LSB ≈ −1 tap;
            0 {'<'} α {'<'} 1/8 時偶爾停留,α = 0 時為水平線);下圖 c_INJ:naive/nearest 永遠停在{' '}
            <M>{'c \\le 31'}</M>(虛線以下),calibrated + mismatch 時會跳進 32–63 的 redundant 區。
            兩圖 x 軸連動;豎虛線游標 = 下方 #10b 交棒動畫目前的 k。
          </span>
        }
      >
        <EChart option={jOption} height={240} group="ch7codes" />
        <EChart option={cOption} height={260} group="ch7codes" />
      </SectionFigure>

      <SectionFigure
        title="#10b Tap 交棒動畫:每拍 (j_INJ, c_INJ) 的兩段式對準"
        caption={
          <span>
            wheel 角度 = phase(VCO cycles;0 在 12 點鐘、順時針增加)。每拍分兩個 sub-stage:
            先「tap 對準」(高亮 tap j_INJ[k],ZC 針跳到該 tap),再「DTC 細調」(弧線 ={' '}
            c_INJ[k]/256 cycle 的細 delay,ZC 針滑到 analog 落點);淡色小點 = 前 1–4 拍的落點
            (漸淡)。長針 = 該拍理想目標 u_INJ_ideal[k]。資料重用上方 #10/#11 的同一次模擬
            (N = 3 + α、mapping、tap3 mismatch 共用),#10/#11 的豎虛線游標同步指在同一個 k。
            讀值單位:<UnitSwitch />
          </span>
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
          <PhaseWheel
            size={300}
            animateToMarker
            title={
              <span>
                k = {playK}({tapStage === 'tap' ? 'tap 對準' : 'DTC 細調'});(j, c) = (
                {play.j}, {play.c})
              </span>
            }
            taps={Array.from(demo.taps, (a, j) => ({
              angleCycles: a,
              label: `T${j}`,
              color: j === play.j ? 'var(--accent)' : undefined,
            }))}
            markers={[
              { angleCycles: play.uIdeal, label: 'target', color: 'var(--accent)', r: 0.95 },
              {
                angleCycles: tapStage === 'tap' ? play.tapU : play.uAn,
                label: 'ZC',
                color: 'var(--fg)',
                r: 0.8,
              },
            ]}
            arcs={
              tapStage === 'arc'
                ? [
                    {
                      fromCycles: play.tapU,
                      toCycles: play.uAn,
                      color: 'var(--accent)',
                      r: 0.68,
                      width: 5,
                    },
                  ]
                : undefined
            }
            trail={play.trail}
          />
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              minWidth: 260,
              fontSize: '0.9rem',
            }}
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="preset-button"
                onClick={() => setTapPlaying((p) => !p)}
              >
                {tapPlaying ? 'Pause' : 'Play'}
              </button>
              <button
                type="button"
                className="preset-button"
                onClick={() => {
                  setTapPlaying(false);
                  setTapPlayT((t) => (t + 1) % (2 * N_CODES));
                }}
              >
                Step 半拍
              </button>
              <button
                type="button"
                className="preset-button"
                onClick={() => {
                  setTapPlaying(false);
                  setTapPlayT(1);
                }}
              >
                Reset
              </button>
            </div>
            <p style={{ margin: 0 }}>
              u_INJ_ideal[k] = {formatPhase(play.uIdeal, unit, tVco)};analog 落點 ={' '}
              {formatPhase(play.uAn, unit, tVco)};e_INJ_abs ={' '}
              {formatPhase(play.eAbs, unit, tVco)}。
              <br />
              α = {trimNumber(alpha, 4)}:每拍 j_INJ 平均反向旋轉 8α ≈{' '}
              {trimNumber(8 * alpha, 3)} tap。Step 一次走半拍(tap 對準 ↔ DTC 細調)。
            </p>
          </div>
        </div>
      </SectionFigure>

      <SectionFigure
        title="1/8-cycle 對位模糊與 false-lock 風險:8 個 crossing 的 basins of attraction"
        caption={
          <span>
            一維 phase 軸(0–1 VCO cycle):實心直線 = 8-phase ring 的 zero crossings
            (間距 1/8 cycle = 32 LSB;排定的 crossing 固定畫在 T4);虛線 = basin 邊界
            (每個 crossing ±1/16 cycle = ±16 LSB);高亮豎線 = injection pulse 實際落點
            (排定 crossing + 總排程誤差 e<sub>sched</sub>);箭頭 = 被拉往的 crossing。
            右側 ParamPanel 的「e_sched(對位圖)」slider 與 preset 可重現各誤差等級。
            兩個情境按鈕改以<strong>逐拍播放</strong>驅動本圖:pulse 豎線取第 k 拍的{' '}
            e<sub>ZC,hw</sub>[k](模擬值),並在下方累積 8-bin capture-count histogram
            (capture = 最近 crossing 之 proxy)。讀值單位:<UnitSwitch />
          </span>
        }
      >
        <p>
          injection pulse 不知道「你要的是哪一個 crossing」。shorting 只會把 VCO 往 pulse
          附近<strong>最近的</strong> zero crossing 拉(Ch13 sin map 的吸引行為);而 8-phase
          ring 上,tap j 與 tap j+4 構成 4 組差動對、每組每個 T<sub>vco</sub> 有 2 個
          crossing,合計每 1/8 cycle 就有一個 crossing —— 恰為 tap spacing 32 LSB。
          所以「打在哪個 crossing」這件事,injection 本身完全不把關:
          <strong>cycle-level(以及 1/8-cycle-level)的對位由 digital scheduler 全權負責</strong>。
          <EpistemicTag kind="INFERENCE" />
        </p>
        <p>
          幾何上,每個 crossing 的 basin of attraction 以相鄰 crossing 的中點為界:半寬 =
          crossing 間距的一半 = <M>{'\\tfrac{1}{16}'}</M> cycle = 16 LSB = 22.5° = 5 ps
          (T<sub>vco</sub> = 80 ps)。可接受的<strong>總</strong>排程誤差判準因此是
          <EpistemicTag kind="INFERENCE" />
        </p>
        <MathBlock>
          {'|e_{ZC,hw}| < \\tfrac{1}{16}\\ \\text{cycle} = 16\\ \\text{LSB} = 22.5^\\circ'}
        </MathBlock>
        <p>
          超過這個界,pulse 距離<strong>隔壁</strong> crossing 更近,injection 會把 VCO 拉去
          那裡。危險之處在於數位側完全無法察覺:shared code 的 pair identity 照樣成立
          (e<sub>pair,digital</sub> ≡ 0)、divider 照樣吐出合法的 n<sub>int</sub> 序列,但
          VCO 實際停在偏 1/8 cycle 整數倍的 <strong>false lock</strong>。注意這與圖 #3 的
          redundancy 無關:redundant 替代解 (j−1, c+32) 落在<strong>同一個</strong> phase,
          不改變排定的 crossing;本節說的是「實際 VCO 相對排程」的偏差。
          <EpistemicTag kind="INFERENCE" />
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
          <button type="button" className="preset-button" onClick={() => startBasin('latency')}>
            情境 (a):latency bug L=1(N=3.13)
          </button>
          <button type="button" className="preset-button" onClick={() => startBasin('dsm')}>
            情境 (b):dsm_only 無 gating
          </button>
          <button
            type="button"
            className="preset-button"
            onClick={() => {
              setBasinPlaying(false);
              setBasinScenario('off');
              setBasinK(0);
            }}
          >
            slider 模式
          </button>
          {basinSim !== null && (
            <>
              <button
                type="button"
                className="preset-button"
                onClick={() => {
                  if (basinPlaying) {
                    setBasinPlaying(false);
                    return;
                  }
                  if (basinK >= N_BASIN - 1) setBasinK(0);
                  setBasinPlaying(true);
                }}
              >
                {basinPlaying ? 'Pause' : 'Play'}
              </button>
              <button
                type="button"
                className="preset-button"
                onClick={() => {
                  setBasinPlaying(false);
                  setBasinK((k) => Math.min(k + 1, N_BASIN - 1));
                }}
              >
                Step +1
              </button>
              <button
                type="button"
                className="preset-button"
                onClick={() => {
                  setBasinPlaying(false);
                  setBasinK(0);
                }}
              >
                Reset
              </button>
            </>
          )}
        </div>
        <svg
          viewBox="0 0 760 200"
          style={{ width: '100%', maxWidth: 860, display: 'block' }}
          role="img"
          aria-label="1/8-cycle basins of attraction 一維相位軸示意圖"
        >
          {/* 排定 crossing 的 basin 底色 */}
          <rect
            x={xOf(0.5 - 1 / 16)}
            y={86}
            width={xOf(0.5 + 1 / 16) - xOf(0.5 - 1 / 16)}
            height={62}
            fill="var(--accent-soft)"
          />
          {/* phase 軸 */}
          <line x1={40} y1={120} x2={720} y2={120} stroke="var(--border-strong)" strokeWidth={1.5} />
          {/* basin 邊界(j/8 + 1/16) */}
          {Array.from({ length: 8 }, (_, j) => j / 8 + 1 / 16).map((u) => (
            <line
              key={`b${u}`}
              x1={xOf(u)}
              y1={86}
              x2={xOf(u)}
              y2={148}
              stroke="var(--border)"
              strokeDasharray="3 3"
            />
          ))}
          {/* 8 個 crossing(0 與 1 為同一 phase,都畫) */}
          {Array.from({ length: 9 }, (_, j) => (
            <g key={`c${j}`}>
              <line
                x1={xOf(j / 8)}
                y1={96}
                x2={xOf(j / 8)}
                y2={144}
                stroke={j === 4 ? 'var(--accent)' : 'var(--fg-subtle)'}
                strokeWidth={j === 4 ? 2.5 : 1.5}
              />
              <text
                x={xOf(j / 8)}
                y={162}
                textAnchor="middle"
                fontSize={11}
                fontFamily="var(--font-mono)"
                fill={j === 4 ? 'var(--accent)' : 'var(--fg-subtle)'}
              >
                {`T${j % 8}`}
              </text>
            </g>
          ))}
          <text
            x={xOf(0.5)}
            y={178}
            textAnchor="middle"
            fontSize={11}
            fill="var(--accent)"
          >
            排定 crossing
          </text>
          {/* 被捕捉的 crossing */}
          <circle cx={xOf(uCaptured)} cy={120} r={5.5} fill={pullColor} />
          {/* pulse 實際落點 */}
          <line
            x1={xOf(uPulse)}
            y1={58}
            x2={xOf(uPulse)}
            y2={144}
            stroke={pullColor}
            strokeWidth={2}
          />
          <text
            x={xOf(uPulse)}
            y={50}
            textAnchor="middle"
            fontSize={11}
            fontFamily="var(--font-mono)"
            fill={pullColor}
          >
            pulse
          </text>
          {/* pull 方向箭頭 */}
          {Math.abs(xOf(uPulse) - xOf(uCaptured)) > 8 && (
            <g stroke={pullColor} fill={pullColor}>
              <line
                x1={xOf(uPulse)}
                y1={72}
                x2={xOf(uCaptured) + (uCaptured < uPulse ? 8 : -8)}
                y2={72}
                strokeWidth={1.5}
              />
              <polygon
                points={
                  uCaptured < uPulse
                    ? `${xOf(uCaptured)},72 ${xOf(uCaptured) + 8},68 ${xOf(uCaptured) + 8},76`
                    : `${xOf(uCaptured)},72 ${xOf(uCaptured) - 8},68 ${xOf(uCaptured) - 8},76`
                }
              />
            </g>
          )}
        </svg>
        {basinNow ? (
          <p style={{ marginTop: 8, fontSize: '0.9rem' }}>
            情境{' '}
            {basinScenario === 'latency'
              ? '(a) latency bug L=1(N=3.13,無 look-ahead,exp10 式)'
              : '(b) dsm_only 無 gating(N=3.13,ef1,exp21b 式)'}
            :k = {basinK}/{N_BASIN - 1};e<sub>ZC,hw</sub>[k] ={' '}
            {formatPhase(basinNow.e, unit, tVco)};捕捉:
            {falseLock ? (
              <strong>
                {' '}
                偏 {capturedTaps > 0 ? '+' : ''}
                {capturedTaps}/8 cycle({capturedTaps * 45}°)的錯誤 crossing
              </strong>
            ) : (
              <span> 排定 crossing</span>
            )}
            ;capture 後殘留 {formatPhase(residCyc, unit, tVco)}。
            (情境播放中,e_sched slider 暫停作用;capture = 最近 crossing 之 proxy
            <EpistemicTag kind="APPROX" />)
          </p>
        ) : (
          <p style={{ marginTop: 8, fontSize: '0.9rem' }}>
            e<sub>sched</sub> = {trimNumber(eSchedLsb, 4)} LSB ={' '}
            {formatPhase(eSchedCyc, unit, tVco)};捕捉結果:
            {falseLock ? (
              <strong>
                {' '}
                false lock — 被拉去偏 {capturedTaps > 0 ? '+' : ''}
                {capturedTaps}/8 cycle({capturedTaps * 45}°)的 crossing
              </strong>
            ) : (
              <span> 正確 crossing(pulse 仍在排定 basin 內)</span>
            )}
            ;capture 後相對該 crossing 殘留 {formatPhase(residCyc, unit, tVco)}。
          </p>
        )}
        {basinNow && (
          <div style={{ marginTop: 8 }}>
            <svg
              viewBox="0 0 380 122"
              style={{ width: '100%', maxWidth: 420, display: 'block' }}
              role="img"
              aria-label="per-crossing capture-count histogram(8 bins)"
            >
              {basinNow.counts.map((cnt, j) => {
                const h = (cnt / basinNow.maxCount) * 78;
                const x = 24 + j * 44;
                const isSched = j === 4;
                return (
                  <g key={`hb${j}`}>
                    <rect
                      x={x}
                      y={96 - h}
                      width={26}
                      height={Math.max(h, 1)}
                      fill={
                        isSched
                          ? 'var(--accent)'
                          : cnt > 0
                            ? 'var(--warn-border)'
                            : 'var(--border)'
                      }
                    />
                    <text
                      x={x + 13}
                      y={110}
                      textAnchor="middle"
                      fontSize={10}
                      fontFamily="var(--font-mono)"
                      fill={isSched ? 'var(--accent)' : 'var(--fg-subtle)'}
                    >
                      {`T${j}`}
                    </text>
                    {cnt > 0 && (
                      <text
                        x={x + 13}
                        y={91 - h}
                        textAnchor="middle"
                        fontSize={9}
                        fill="var(--fg-subtle)"
                      >
                        {cnt}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            <p style={{ fontSize: '0.85rem', marginTop: 4 }}>
              capture-count histogram:x 軸 = 8 個 crossing(T0–T7,排定 = T4),y 軸 = 第
              0..k 拍累積被捕捉的拍數(capture = 最近 crossing 之 proxy,round(8·e)/8
              <EpistemicTag kind="APPROX" />)。情境 (a) 只長 T5 一根(128 拍實測 127/128;
              唯一例外是 e=0 的 k=0)—— 每拍都被<strong>同一個</strong>錯 crossing 捕捉,
              數位側毫無異狀:安靜的 false lock;情境 (b) 八根近乎均勻長高(128 拍實測每根
              14–17)—— 每拍換 basin,injection 無固定收斂點 → unlock。
              <EpistemicTag kind="EXPERIMENT" /> 「同一 crossing ⇒ 鎖錯相位、逐拍換 crossing ⇒
              失鎖」的解讀為 tap 幾何推論。<EpistemicTag kind="INFERENCE" />
            </p>
          </div>
        )}
        <p>
          拿 Ch15 的 mismatch 實測與本站各 experiment 對照這個 16 LSB 的預算
          (T<sub>vco</sub> = 80 ps 換算;各行來源標於表內):
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>誤差來源</th>
                <th>大小(LSB)</th>
                <th>佔 basin 半寬 16 LSB</th>
                <th>對位結果</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>quantization(nearest)上限 [EXACT]</td>
                <td>0.5(156.25 fs)</td>
                <td>3.1%</td>
                <td>安全</td>
              </tr>
              <tr>
                <td>1° tap mismatch(exp12)[EXACT]</td>
                <td>0.711(222.2 fs)</td>
                <td>4.4%</td>
                <td>安全</td>
              </tr>
              <tr>
                <td>1% INJ DTC gain 上限(exp13)[EXACT]</td>
                <td>0.64(200 fs)</td>
                <td>4.0%</td>
                <td>安全</td>
              </tr>
              <tr>
                <td>上述三者 worst-case 直加 [APPROX]</td>
                <td>≈ 1.85</td>
                <td>11.6%</td>
                <td>安全(margin ≈ 8.6×)</td>
              </tr>
              <tr>
                <td>latency bug L=1, α=0.13(exp10)[EXPERIMENT]</td>
                <td>33.28(46.8°)</td>
                <td>208%</td>
                <td>跨 basin → false lock(偏 1 tap,殘留 1.28 LSB)</td>
              </tr>
              <tr>
                <td>dsm_only 無 gating(exp21b)[EXPERIMENT]</td>
                <td>rms ≈ 74(e_ZC_hw 掃滿 ±0.5 cycle)</td>
                <td>—</td>
                <td>每拍換 basin → unlock(θ rms 1.81 rad)</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          與 PLL loop 的分工:<strong>loop 顧 absolute</strong>(把 frequency 與長期 phase
          鎖住,讓 η<sub>vco</sub> 保持小)、<strong>scheduler 顧「選哪個 crossing」</strong>
          (deterministic 的 cycle-level + 1/8-level 對位)、<strong>injection 只顧 basin
          內的 local 收斂</strong>。三層失效的症狀完全不同:loop 失鎖是頻率漂;scheduler
          跨 basin 是頻率正確、相位偏 n/8 cycle 的 false lock;injection 太弱只是 residual
          jitter 變大。scheduler 一旦跨 basin,loop 不會自動救回 —— 因為 feedback path 用的
          是同一套(錯誤的)digital 相位記帳。<EpistemicTag kind="INFERENCE" />
        </p>
        <p>
          實測對照:mismatch 類誤差(合計 ≈ 1.85 LSB)只佔預算 11.6%,它們傷的是
          <strong>精度</strong>(Ch15),不是對位;會跨 basin 的是 <strong>cycle-level
          記帳錯誤</strong> —— exp10 的 L=1 latency bug 實測 e<sub>ZC,hw</sub> ≈ +0.13 cycle
          (511/512 拍超過 1/16 cycle),exp21b 的 dsm_only 無 gating 則掃滿 ±0.5 cycle。
          §14 的 gating 門檻預設 0.0625 cycle <strong>正是 basin 半寬</strong>:只在
          deterministic 誤差已落在正確 basin 內才 fire,exp21c 實測以 67/512 的 fire rate
          把 tail θ rms 從 1.81 rad 壓回 0.102 rad。<EpistemicTag kind="EXPERIMENT" />
        </p>
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model/injectionScheduler.ts(真實節錄:tap + DTC decode)"
        code={`// candidates(): c-major 枚舉(先 c 後 j)—— first minimum 即實作 tie-break
if (calibrated) {
  us[i] = tapTbl[j] + dtcInj.delayCycles(c) + cfg.route_inj_cycles;
} else {
  us[i] = j / cfg.n_tap + c / g;
}

// runInjection(): tap + DTC decode
const tapStep = Math.floor(g / cfg.n_tap); // 32 LSB
if (cfg.inj_mapping === 'naive') {
  for (let k = 0; k < n; k++) {
    jInj[k] = Math.floor(rInj[k] / tapStep);
    cInj[k] = pymod(rInj[k], tapStep);
  }
} else {
  const calibrated = cfg.inj_mapping === 'calibrated';
  const { js, cs, us } = candidates(cfg, dtcInj, tapTbl, calibrated);
  for (let k = 0; k < n; k++) {
    const target = rInj[k] / g;
    // first minimum -> smaller c, then smaller j (c-major enumeration)
    let best = 0;
    let bestErr = Math.abs(wrapCycles(target - us[0]));
    for (let i = 1; i < us.length; i++) {
      const err = Math.abs(wrapCycles(target - us[i]));
      if (err < bestErr) {
        bestErr = err;
        best = i;
      }
    }
    jInj[k] = js[best];
    cInj[k] = cs[best];
  }
}`}
      >
        <p>
          注意 model 的解決方案(檔頭註明的 resolved ambiguity):mapping 的輸入一律是 digital
          命令目標 <M>{'u_{target} = R_{INJ}/G'}</M>,讓 <M>{'R_{INJ}'}</M> 保持唯一 command word;
          對真實 <M>{'u_{INJ,ideal}'}</M> 的誤差仍另以 <code>e_INJ_abs</code> 量測。
        </p>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'const tapStep = Math.floor(g / cfg.n_tap); // 32 LSB',
            explain: (
              <span>
                tap spacing(G=256、8 taps → 32 LSB)。DTC range 是 <M>{'2^6 = 64'}</M> 個 code,
                恰為 tapStep 的兩倍 —— redundancy 的數字根源。
              </span>
            ),
          },
          {
            code: 'jInj[k] = Math.floor(rInj[k] / tapStep);  cInj[k] = pymod(rInj[k], tapStep);',
            explain: (
              <span>
                naive floor:直接把 code 拆成商與餘數,c 永遠 ≤ 31,只用 DTC 下半 range。digital
                上正確,但 tap 偏了就無路可逃。
              </span>
            ),
          },
          {
            code: 'us[i] = j / cfg.n_tap + c / g;   // nearest(ideal 表)',
            explain: (
              <span>
                nearest 用 <strong>nominal</strong> tap/DTC 位置比誤差 —— 理想參數下與 naive 同解
                (tie-break 選小 c),它的存在意義是作為 calibrated 的對照組。
              </span>
            ),
          },
          {
            code: 'us[i] = tapTbl[j] + dtcInj.delayCycles(c) + cfg.route_inj_cycles;',
            explain: (
              <span>
                calibrated 用 <strong>actual</strong> 表(含 mismatch/gain/INL/route):同一個 argmin
                迴圈,換一張表,就能自動繞開受損的 tap —— 校正的成本全部在 digital。
              </span>
            ),
          },
          {
            code: 'if (err < bestErr) { bestErr = err; best = i; }',
            explain: (
              <span>
                嚴格小於 + c-major 枚舉順序 = 「誤差相同時取較小 c、再取較小 j」的 tie-break。
                Python golden model 用同一慣例,保證兩邊逐位一致。
              </span>
            ),
          },
          {
            code: 'const target = rInj[k] / g;',
            explain: (
              <span>
                mapping 目標是 digital command(<M>{'R_{INJ}/G'}</M>)而非真實 ideal phase:
                quantization error 留在 quantizer 那層,mapping 只負責「忠實執行 code」。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            <strong>Wheel(ideal,mismatch = 0)</strong>:三種 mapping 給出相同 (j, c);actual ZC
            針與 digital 目標重合,對 u<sub>target</sub> 只剩 quantization residual(u=0.40 時 −0.4
            LSB)。替代解短針落在完全相同的 phase —— redundancy 的兩條路等價。
          </li>
          <li>
            <strong>開 +1° tap3、mapping = naive</strong>:選擇仍是 (3, 6),actual ZC 針偏離 digital
            目標整整 +1°(+0.711 LSB &gt; half-LSB)。nearest 同樣中招 —— 它看的是 nominal 表。
          </li>
          <li>
            <strong>切到 calibrated</strong>:選擇跳到 (2, 38)(c 進入 32–63 redundant 區),actual
            ZC 針回到 digital 目標上,err vs digital 目標歸零。這就是「redundancy + 校正表」的價值。
          </li>
          <li>
            <strong>#10</strong>:j_INJ 逐拍下降(反向旋轉的 coarse 部分);α=0.13 時大約每拍退一格,
            偶爾一次退兩格、從不停留(因為 0.13 cycle = 33.28 LSB,略多於一格 32 LSB;多出的
            1.28 LSB 累積滿一格 — 平均每 25 拍 — 該拍就退兩格)。
          </li>
          <li>
            <strong>#11</strong>:naive/nearest 的 c_INJ 永遠在虛線(c=31)下方;calibrated + tap3
            mismatch 時,目標落在 tap3 粗格的那些拍會跳到 c ≥ 32(改走 tap2 + 上半 range)。
          </li>
          <li>
            <strong>#10b 交棒動畫</strong>:α=0.13 時每拍退一格、平均每 ≈25 拍插入一次退兩格
            (2048 拍實測:單格 1965/2047、雙格 82/2047;0.13 cycle = 33.28 LSB 超出一格的
            1.28 LSB,每 25 拍累滿一格 32 LSB);N=3.000 時 j_INJ 靜止不動;α=0.25 時每拍
            <strong>恰好</strong>退兩格。每次交棒都是「先 tap 對準、再長 DTC 弧」的兩段動作。
            <EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            <strong>Basin 逐拍動態</strong>:情境 (a) 的 pulse 豎線幾乎固定在 +0.13 cycle,每拍被
            <strong>同一個</strong> +1/8 cycle 的錯 crossing 捕捉(histogram 只長 T5)——
            安靜的 false lock;情境 (b) 的 pulse 逐拍掃過整個 phase 軸,histogram 八根均勻長高
            —— 每拍換 basin → unlock。<EpistemicTag kind="EXPERIMENT" />
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解一:「DTC range 蓋 32 LSB 就夠,64 LSB 是浪費硬體」">
          <p>
            錯。range 剛好 = spacing 時每個目標只有唯一 (j, c),任何 tap mismatch 都無法繞開 ——
            該 tap 轄區內的所有目標都被迫吃下全部誤差。2× 覆蓋讓每個目標都有兩條路,校正演算法
            才有選擇權。1° tap 誤差(0.711 LSB)大於 half-LSB(0.5 LSB quantization 上限),
            沒有替代路徑時它直接成為 dominant error。
            <EpistemicTag kind="INFERENCE" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解二:「nearest mapping 理想下比 naive 準」">
          <p>
            錯。理想參數下兩者輸出<strong>逐位相同</strong>(nearest 的零誤差解對 tie-break 收斂到
            naive 的小-c 解);mapping 影響的是 <strong>analog 層</strong>的落點,digital command{' '}
            <M>{'R_{INJ}'}</M> 三種 mapping 完全一樣。差異只在 calibrated 拿 actual 表時出現。
            <EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <ul>
          <li>
            保留 tap spacing 2× 的 DTC 覆蓋(32 vs 64 LSB):redundancy 是 tap mismatch 的逃生門,
            成本只是 DTC 多一個 bit 的 range。<EpistemicTag kind="INFERENCE" />
          </li>
          <li>
            calibrated joint argmin(§8 公式)把校正問題化為查表 + 512 組合搜尋,不動 command
            word、不加 analog 硬體;在 1° tap3 mismatch 下能把該格誤差從 +0.711 LSB 壓回
            quantization-only。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            debug 時看 c_INJ 的分佈就能判斷 mapping 行為:c 永遠 ≤ 31 → naive/nearest;c 出現
            32–63 → calibrated 正在利用 redundancy。<EpistemicTag kind="EXPERIMENT" />
          </li>
          <li>
            對位判準:總 deterministic 排程誤差 |e<sub>ZC,hw</sub>| 必須 &lt; 1/16 cycle
            (16 LSB,basin 半寬)。mismatch 類誤差(worst-case 直加 ≈ 1.85 LSB)有 ≈ 8.6×
            margin;latency 類 bug(33.28 LSB)與 dsm_only 無 gating(±0.5 cycle)直接跨
            basin → false lock / unlock。look-ahead(Ch12)與 gating 門檻 0.0625 cycle(§14)
            是對位性的守門員,不只是精度問題。<EpistemicTag kind="INFERENCE" />
          </li>
        </ul>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            calibrated mapping 假設 tap/DTC 的 actual 表<strong>完全已知</strong>(等同完美校正);
            實際校正有量測誤差與漂移,本模型不含。mapping 是 static 查表,不含 tap 切換的動態限制
            (glitch、settling)。DTC 的 gain/INL/DNL 為 behavioral 模型(§10,ASSUMPTION),
            tie-break 慣例是為了 Python↔TS 逐位一致所做的實作選擇。行為級結果不等同 silicon(§20)。
            1/8-cycle 對位模糊一節的 basin 圖是 tap 幾何的<strong>推論</strong>(INFERENCE):
            行為級 sin map(§14)把 e_inj 摺到 (−π, π],每拍只有單一 fixed point,
            <strong>不會</strong>模擬 wrong-crossing capture;真實吸引域邊界取決於 pulse
            寬度、波形斜率與 stage 間耦合,需 transistor-level 驗證。
          </p>
        </Callout>
      </SectionLimitation>

      <DebugTable
        columns={[
          { key: 'k', label: 'k' },
          { key: 'u_INJ_ideal', label: 'u_INJ_ideal', fmt: fmt6 },
          { key: 'R_INJ', label: 'R_INJ' },
          { key: 'j_INJ', label: 'j_INJ' },
          { key: 'c_INJ', label: 'c_INJ' },
          { key: 'u_INJ_digital', label: 'u_INJ_digital', fmt: fmt6 },
          { key: 'u_INJ_analog', label: 'u_INJ_analog', fmt: fmt6 },
          { key: 'e_INJ_abs', label: 'e_INJ_abs (cyc)', fmt: fmt6 },
        ]}
        rows={tableRows}
        exportName="ch7_tap_mapping.csv"
      />

      <ParamPanel title="Ch7 參數">
        <Slider
          label="u_target"
          value={uTarget}
          min={0}
          max={0.9961}
          step={0.0025}
          unit="cyc"
          onChange={setUTarget}
        />
        <PresetButtons
          label="範例 target"
          presets={[
            { label: 'u = 0.40(§8 例)', onClick: () => setUTarget(0.4) },
            { label: 'u = 0.87(Ch6 例)', onClick: () => setUTarget(0.87) },
          ]}
        />
        <SelectControl<InjMapping>
          label="Mapping"
          value={mapping}
          options={MAPPING_OPTIONS}
          onChange={setMapping}
        />
        <Slider
          label="tap3 mismatch"
          value={tap3Deg}
          min={-2}
          max={2}
          step={0.1}
          unit="°"
          onChange={setTap3Deg}
        />
        <PresetButtons
          label="mismatch preset"
          presets={[
            { label: '+1° tap3', onClick: () => setTap3Deg(1) },
            { label: '0°(ideal)', onClick: () => setTap3Deg(0) },
          ]}
        />
        <Slider
          label="α(code 序列圖)"
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
        <Slider
          label="e_sched(對位圖)"
          value={eSchedLsb}
          min={-40}
          max={40}
          step={0.01}
          unit="LSB"
          onChange={setESchedLsb}
        />
        <PresetButtons
          label="e_sched preset"
          presets={[
            { label: 'half-LSB 0.5', onClick: () => setESchedLsb(0.5) },
            { label: '1° tap 0.711', onClick: () => setESchedLsb(256 / 360) },
            { label: '1% gain 0.64', onClick: () => setESchedLsb(0.64) },
            { label: 'worst-case ≈1.85', onClick: () => setESchedLsb(0.5 + 256 / 360 + 0.64) },
            { label: 'latency bug 33.28', onClick: () => setESchedLsb(33.28) },
          ]}
        />
      </ParamPanel>
    </ChapterShell>
  );
}
