/**
 * Chapter 4 — /3-/4 除頻與 4-phase PMUX 運作 (/3-/4 + 4-phase PMUX Operation)
 *
 * Content contract: CHAPTER_GUIDE.md Ch4; math contract MODEL_SPEC.md §4.
 * Figures: #7 divider command plot, #8 PMUX code plot, ideal vs actual edge.
 * Hand-computed table N = 3.13, k = 0..8; assertions list.
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
import { ParamPanel, Slider, PresetButtons, SelectControl } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import DebugTable from '../components/DebugTable';
import { makeLineOption } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { phaseAxisLabel, makePhaseTickFormatter, trimNumber } from '../lib/format';
import { useSimStatus } from '../SimStatusContext';
import { chapterHref } from '../lib/router';
import { chapterById } from './index';
import { simulate, fromPartial, configTVcoS } from '../model';
import type { Quantizer } from '../model';

const meta = chapterById(4)!;

const N_CYCLES = 128;
const SHOW_CYCLES = 96;

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

function pairs(ks: Float64Array, ys: Float64Array, count?: number): [number, number][] {
  const n = count === undefined ? ys.length : Math.min(count, ys.length);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    out.push([ks[i], ys[i]]);
  }
  return out;
}

/** hand-computed decode table for N = 3.13, nearest quantizer (SectionExample) */
const HAND_ROWS: [number, string, number, number, number, number, number, string][] = [
  // k, A_ideal, A_FB, I_FB, R_FB, m_FB, c_FB, n_int (I[k+1]-I[k])
  [0, '0.00', 0, 0, 0, 0, 0, '3'],
  [1, '801.28', 801, 3, 33, 0, 33, '3'],
  [2, '1602.56', 1603, 6, 67, 1, 3, '3'],
  [3, '2403.84', 2404, 9, 100, 1, 36, '3'],
  [4, '3205.12', 3205, 12, 133, 2, 5, '3'],
  [5, '4006.40', 4006, 15, 166, 2, 38, '3'],
  [6, '4807.68', 4808, 18, 200, 3, 8, '3'],
  [7, '5608.96', 5609, 21, 233, 3, 41, '4'],
  [8, '6410.24', 6410, 25, 10, 0, 10, '—'],
];

const CODE_EXCERPT = `// web/src/model/feedbackScheduler.ts  (MODEL_SPEC §4, 真實碼節錄)
const y = q.quantize(u);          // A_FB[k] = Q_FB(A_ideal[k])
aFb[k] = y;

// --- assertions (MODEL_SPEC section 4) ---
for (let k = 1; k < n; k++) {
  if (!(aFb[k] - aFb[k - 1] > 0)) {
    throw new Error('A_FB must be strictly monotonic (no duplicate/backward edges)');
  }
}
for (let k = 0; k < n; k++) {
  iFb[k] = Math.floor(aFb[k] / g);      // I_FB: integer cycle index
  rFb[k] = pymod(aFb[k], g);            // R_FB in {0..255}
  mFb[k] = Math.floor(rFb[k] / nDtc);   // m_FB: PMUX code in {0,1,2,3}
  cFb[k] = pymod(rFb[k], nDtc);         // c_FB: DTC code in {0..63}
  if (!(rFb[k] >= 0 && rFb[k] < g)) throw new Error('R_FB out of range');
  if (!(mFb[k] >= 0 && mFb[k] < cfg.n_pmux)) throw new Error('m_FB out of range');
  if (!(cFb[k] >= 0 && cFb[k] < nDtc)) throw new Error('c_FB out of range');
}
if (n > 1) {
  for (let k = 0; k < n - 1; k++) {
    const d = iFb[k + 1] - iFb[k];      // n_integer[k] = I_FB[k+1] - I_FB[k]
    if (!(d >= 0)) {
      throw new Error('n_integer must be non-negative (PMUX wrap legality)');
    }
    nIntPadded[k] = d;
  }
}`;

export default function Chapter04() {
  const [alpha, setAlpha] = useChapterAlpha();
  const [quantizer, setQuantizer] = useState<Quantizer>('nearest');
  const { unit } = useUnit();
  const ct = useChartTheme();
  const { setStatus } = useSimStatus();

  const cfg = useMemo(
    () => fromPartial({ n_div: 3 + alpha, n_cycles: N_CYCLES, quantizer }),
    [alpha, quantizer],
  );
  const result = useMemo(() => simulate(cfg), [cfg]);
  const tVco = configTVcoS(cfg);

  useEffect(() => {
    setStatus('done', `N = ${trimNumber(3 + alpha, 6)}, Q = ${quantizer}, ${N_CYCLES} cycles`);
  }, [alpha, quantizer, setStatus]);

  // ---- figure #7: divider command plot ----
  const dividerOption = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: 'n_int (VCO cycles swallowed)',
        yMin: 1.5,
        yMax: 5.5,
        series: [
          {
            name: 'n_int',
            data: pairs(result.data.k, result.data.n_int, SHOW_CYCLES),
            step: 'middle',
            showSymbol: true,
            symbolSize: 5,
          },
        ],
      }),
    [result, ct],
  );

  // ---- figure #8: PMUX code plot ----
  const pmuxOption = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: 'm_FB (PMUX code)',
        yMin: -0.5,
        yMax: 3.5,
        series: [
          {
            name: 'm_FB',
            data: pairs(result.data.k, result.data.m_FB, SHOW_CYCLES),
            step: 'middle',
            showSymbol: true,
            symbolSize: 5,
            color: ct.series[2],
          },
        ],
      }),
    [result, ct],
  );

  // ---- ideal vs actual fractional edge position ----
  const edgeOption = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: phaseAxisLabel('fractional edge', unit, tVco),
        yTickFormatter: makePhaseTickFormatter(unit, tVco),
        series: [
          {
            name: 'x_ideal (ideal)',
            data: pairs(result.data.k, result.data.x_ideal, 48),
            step: 'middle',
            showSymbol: true,
            symbolSize: 4,
          },
          {
            name: 'u_FB_digital = R_FB/G (actual)',
            data: pairs(result.data.k, result.data.u_FB_digital, 48),
            step: 'middle',
            showSymbol: true,
            symbolSize: 4,
            dashed: true,
          },
        ],
      }),
    [result, unit, tVco, ct],
  );

  const tableRows = useMemo(() => {
    const d = result.data;
    const rows: Record<string, unknown>[] = [];
    for (let k = 0; k < Math.min(16, N_CYCLES); k++) {
      rows.push({
        k,
        A_ideal: d.A_ideal[k],
        A_FB: d.A_FB[k],
        I_FB: d.I_FB[k],
        R_FB: d.R_FB[k],
        m_FB: d.m_FB[k],
        c_FB: d.c_FB[k],
        n_int: d.n_int[k],
      });
    }
    return rows;
  }, [result]);

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <ul>
          <li>
            一個實數的 ideal fine code <M>{'A_{ideal}[k]'}</M> 如何 decode 成 /3-/4 divider、
            4-phase PMUX、6-bit DTC 三層硬體各自的整數指令?<EpistemicTag kind="EXACT" />
          </li>
          <li>
            為什麼正常操作下 divider command <M>{'n_{int} \\in \\{3, 4\\}'}</M>?什麼時候會出現
            4?
          </li>
          <li>PMUX code 從 3 wrap 回 0 時,/3-/4 divider 怎麼「補」那一個 VCO cycle?</li>
          <li>模型用哪些 assertions 保證 edge 序列合法(monotonic、無 duplicate、無 backward)?</li>
        </ul>
      </SectionQuestion>

      <SectionIntuition>
        <p>
          feedback divider 的工作是「從 VCO 的連續 edge 流裡,每個 reference cycle 挑出一個
          edge」。挑哪一個?答案已經在 Ch3 的 absolute coordinate 裡:第 k 拍應該挑落在{' '}
          <M>{'s_{ideal}[k]'}</M> 附近的那個。粗調由 /3-/4 divider 完成(一次跳 3 或 4 個整數
          cycle);中調由 4-phase PMUX 完成(選 0、T<sub>vco</sub>/4、T<sub>vco</sub>/2、3T
          <sub>vco</sub>/4 四個相位之一,一格 = 64 LSB);細調由 6-bit DTC 完成(一格 = 1 LSB =
          T<sub>vco</sub>/256,共 64 格)。三層合起來是一個 256 進位的「里程表」:I 是公里數,
          m 是百米數,c 是米數。<EpistemicTag kind="EXACT" />
        </p>
        <p>
          關鍵設計:三層指令<strong>不是</strong>各自獨立產生,而是把單一整數 code{' '}
          <M>{'A_{FB}[k]'}</M> 按位切開。這保證任何一層 wrap 時(例如 PMUX 3→0),上一層自動進位
          (divider 3→4),不需要另寫補償邏輯,也不可能出現三層彼此矛盾的指令。
          <EpistemicTag kind="EXACT" />
        </p>
      </SectionIntuition>

      <SectionMath>
        <p>high-resolution ideal fine code(單位:1/256 cycle;G = 256)<EpistemicTag kind="EXACT" />:</p>
        <MathBlock>{'A_{ideal}[k] = G \\cdot s_{ideal}[k] \\quad (\\text{real})'}</MathBlock>
        <p>量化為非負整數 code(quantizer <M>{'Q_{FB}'}</M> 見 MODEL_SPEC §6;Ch11 詳述):</p>
        <MathBlock>{'A_{FB}[k] = Q_{FB}(A_{ideal}[k])'}</MathBlock>
        <p>三層 decode(全部由同一個 <M>{'A_{FB}'}</M> 導出)<EpistemicTag kind="EXACT" />:</p>
        <MathBlock>
          {'I_{FB}[k] = \\lfloor A_{FB}[k]/G \\rfloor, \\qquad R_{FB}[k] = A_{FB}[k] \\bmod G \\in \\{0..255\\}'}
        </MathBlock>
        <MathBlock>
          {'m_{FB}[k] = \\lfloor R_{FB}[k]/64 \\rfloor \\in \\{0,1,2,3\\}, \\qquad c_{FB}[k] = R_{FB}[k] \\bmod 64 \\in \\{0..63\\}'}
        </MathBlock>
        <p>實際 feedback edge 的 digital-exact 位置與 error:</p>
        <MathBlock>
          {'s_{FB,actual}[k] = A_{FB}[k]/G, \\qquad u_{FB,digital}[k] = R_{FB}[k]/G'}
        </MathBlock>
        <MathBlock>
          {'e_{FB,abs}[k] = \\operatorname{wrapCycles}(s_{FB,actual}[k] - s_{ideal}[k])'}
        </MathBlock>
        <p>integer divider 的每拍動作由 absolute code 的差分推導:</p>
        <MathBlock>{'n_{int}[k] = I_{FB}[k+1] - I_{FB}[k]'}</MathBlock>
        <p>
          <strong>為何 <M>{'n_{int} \\in \\{3,4\\}'}</M></strong>:相鄰兩拍{' '}
          <M>{'A_{FB}'}</M> 的差約為 <M>{'G \\cdot N \\in [768, 832]'}</M>(N ∈ [3, 3.25]),
          nearest/floor quantizer 的每拍捨入誤差有界(|e| ≤ 1 LSB),所以整數 cycle 的差分只能是
          3 或 4;fraction R 累積滿 256 時 I 多進一位,該拍即為 /4。DSM 型 quantizer
          (ef1/mash11)誤差界稍寬,暫態允許 2 — 但只在 α &lt; 3/256 ≈ 0.012 時偶爾出現;
          5 在 N ≤ 3.25 下不可達,ef1 與 mash11 的可達集合同為 {'{2,3,4}'},測試即檢查{' '}
          {'{2,3,4}'}。
          <EpistemicTag kind="EXACT" />
        </p>
        <p>
          <strong>PMUX wrap 怎麼補</strong>:m 從 3 回到 0 表示 fractional 部分少算了 1 個整 cycle
          (256 LSB),而同一拍 <M>{'I_{FB}'}</M> 恰好多走 1(<M>{'n_{int}=4'}</M>)。這不是巧合,
          是同一個 <M>{'A_{FB}'}</M> 進位的兩面——decode 恆等式{' '}
          <M>{'A_{FB} = 256\\,I_{FB} + 64\\,m_{FB} + c_{FB}'}</M> 使補償自動成立。
          <EpistemicTag kind="EXACT" />
        </p>
      </SectionMath>

      <SectionExample>
        <p>
          <M>{'N = 3.13'}</M>、nearest quantizer(<M>{'\\lfloor u + 0.5 \\rfloor'}</M>)、
          <M>{'A_{ideal}[k] = 801.28\\,k'}</M>。手算 k = 0…8<EpistemicTag kind="EXACT" />:
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>k</th>
                <th>A_ideal</th>
                <th>A_FB</th>
                <th>I_FB</th>
                <th>R_FB</th>
                <th>m_FB</th>
                <th>c_FB</th>
                <th>n_int</th>
              </tr>
            </thead>
            <tbody>
              {HAND_ROWS.map((r) => (
                <tr key={r[0]}>
                  <td>{r[0]}</td>
                  <td>{r[1]}</td>
                  <td>{r[2]}</td>
                  <td>{r[3]}</td>
                  <td>{r[4]}</td>
                  <td>{r[5]}</td>
                  <td>{r[6]}</td>
                  <td>{r[7]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          驗算 k = 2:<M>{'A_{ideal} = 1602.56 \\Rightarrow \\lfloor 1603.06 \\rfloor = 1603'}</M>;
          <M>{'I = \\lfloor 1603/256 \\rfloor = 6'}</M>、<M>{'R = 1603 - 1536 = 67'}</M>、
          <M>{'m = \\lfloor 67/64 \\rfloor = 1'}</M>、<M>{'c = 3'}</M>。注意 k = 7→8:R 從 233 wrap
          到 10(PMUX 3→0),I 從 21 跳到 25,該拍 <M>{'n_{int} = 4'}</M>——正是 Ch3 序列裡 x 從
          0.91 wrap 到 0.04 的那一拍。下方 DebugTable 的模擬值應與本表逐格相同。
          <EpistemicTag kind="EXACT" />
        </p>
      </SectionExample>

      <SectionFigure
        title="圖 #7 — divider command plot:n_int[k]"
        caption={
          <span>
            每拍 /3-/4 divider 吞掉的 VCO cycle 數。N = 3.130 時大多為 3,每逢 fraction 累積滿 1
            cycle(約每 1/0.13 ≈ 7.7 拍)出現一次 4。切到 ef1 / mash11 在本圖 128 拍內
            n_int 仍只有 3 與 4 — 暫態的 2 只在 α &lt; 0.012 的長模擬偶現,5 永不出現。
          </span>
        }
      >
        <EChart option={dividerOption} height={260} group="ch4" />
      </SectionFigure>

      <SectionFigure
        title="圖 #8 — PMUX code plot:m_FB[k]"
        caption={
          <span>
            4-phase PMUX 的選相指令(0..3,一格 = T_vco/4 = 64 LSB)。m_FB 從 3 wrap 回 0 的每一
            拍,圖 #7 的 n_int 恰為 4(兩圖 x 軸已同步,zoom 其中一張另一張跟著動)。
          </span>
        }
      >
        <EChart option={pmuxOption} height={260} group="ch4" />
      </SectionFigure>

      <SectionFigure
        title="ideal vs actual edge(fractional 位置)"
        caption={
          <span>
            實線 x_ideal(理想)與虛線 u_FB_digital = R_FB/G(量化後實際 edge 的 fractional
            位置)。off-grid N 時兩線有 sub-LSB 的差,即 e_FB_abs(Ch5 圖 #13 放大);on-grid
            (N = 3.000/3.125/3.250,nearest)兩線完全重合。單位:<UnitSwitch />
          </span>
        }
      >
        <EChart option={edgeOption} height={280} group="ch4" />
      </SectionFigure>

      <SectionCode
        language="typescript"
        title="web/src/model/feedbackScheduler.ts — decode 與 assertions(真實碼節錄)"
        code={CODE_EXCERPT}
      >
        <p>
          模型對每次 run 都強制檢查的 assertions 清單(MODEL_SPEC §4)
          <EpistemicTag kind="EXACT" />:
        </p>
        <ul>
          <li>
            <M>{'A_{FB}[k+1] > A_{FB}[k]'}</M>:edge 嚴格單調——無 duplicate edge、無 backward
            edge(違反即 throw,不是警告)。
          </li>
          <li>
            所有 code 在合法範圍:<M>{'R_{FB} \\in [0, 256)'}</M>、<M>{'m_{FB} \\in [0, 4)'}</M>、
            <M>{'c_{FB} \\in [0, 64)'}</M>。
          </li>
          <li>
            PMUX wrap 時 <M>{'n_{int} \\geq 0'}</M> 且合法(nearest/floor 下為 {'{3,4}'};DSM 為
            {'{2,3,4}'},2 僅見於 α &lt; 3/256 ≈ 0.012)。
          </li>
          <li>
            on-grid case(<M>{'\\alpha G'}</M> 為整數,如 N = 3.125)必須 exact:
            <M>{'e_{FB,abs} \\equiv 0'}</M>。
          </li>
        </ul>
      </SectionCode>

      <SectionLineByLine
        items={[
          {
            code: 'const y = q.quantize(u);  aFb[k] = y;',
            explain: (
              <span>
                單一 quantizer instance 把實數 <M>{'A_{ideal}'}</M> 轉成整數 <M>{'A_{FB}'}</M>。
                之後所有硬體指令都從這一個整數導出——「quantize once」是 Mode D(Ch8)的前半句。
              </span>
            ),
          },
          {
            code: "if (!(aFb[k] - aFb[k - 1] > 0)) throw new Error('A_FB must be strictly monotonic …');",
            explain: (
              <span>
                edge 單調性 assertion:absolute code 若重複或倒退,物理上等於選到同一個或更早的
                VCO edge——divider 無法執行。用 throw 讓 bug 立即曝露,而不是被後級 loop 吸收。
              </span>
            ),
          },
          {
            code: 'iFb[k] = Math.floor(aFb[k] / g);',
            explain: (
              <span>integer cycle index:到第 k 拍為止累積走過的完整 VCO cycle 數(里程表高位)。</span>
            ),
          },
          {
            code: 'rFb[k] = pymod(aFb[k], g);',
            explain: (
              <span>
                fractional 餘數 R ∈ {'{0..255}'}。<code>pymod</code> 是 Python 語義的 mod
                (結果恆非負),避免 JS <code>%</code> 對負數的行為差異破壞跨語言 bit-exact。
              </span>
            ),
          },
          {
            code: 'mFb[k] = Math.floor(rFb[k] / nDtc);  cFb[k] = pymod(rFb[k], nDtc);',
            explain: (
              <span>
                R 再切成 PMUX 粗調(64 LSB 一格)與 DTC 細調(1 LSB 一格):<M>{'R = 64m + c'}</M>。
              </span>
            ),
          },
          {
            code: 'const d = iFb[k + 1] - iFb[k];',
            explain: (
              <span>
                divider command 是 I 的差分,不是獨立產生的指令——PMUX wrap 的補償因此自動成立
                (進位發生在同一個 A_FB 裡)。
              </span>
            ),
          },
          {
            code: "if (!(d >= 0)) throw new Error('n_integer must be non-negative (PMUX wrap legality)');",
            explain: (
              <span>
                n_int 非負是 /3-/4 能執行的下限檢查;實際合法集合(nearest/floor 為 {'{3,4}'})由
                vitest/pytest 對照 test vectors 驗證。
              </span>
            ),
          },
        ]}
      />

      <SectionObserve>
        <ul>
          <li>
            圖 #7(N = 3.130, nearest):n_int 大致每 7–8 拍出現一個 4,100 拍裡恰有 13 個 4
            (平均 3.13 = N)。長期平均恆等於 N,與 quantizer 無關。
          </li>
          <li>
            圖 #8:m_FB 呈 0→1→2→3→0 的階梯循環;對照圖 #7,每次 3→0 wrap 的那拍 n_int = 4。
            N = 3.250 時 m 每拍 +1(α = 0.25 = 64 LSB),4 拍一循環。
          </li>
          <li>
            切 quantizer 到 ef1/mash11:在預設與所有 preset 下 n_int 仍只有 3 與 4(DSM
            把量化誤差搬到時間軸上,但誤差仍有界,Ch11);暫態的 2 只在 α 低於約 3/256 ≈ 0.012
            的長模擬偶爾出現,5 對 N ≤ 3.25 永不可能;edge 仍嚴格單調——assertion 沒有 throw
            就是證明。
          </li>
          <li>
            ideal vs actual 圖:N = 3.125 時兩線重合(on-grid exact);N = 3.130 時虛線在實線上下
            ±half-LSB 內跳動。
          </li>
          <li>
            想看「divider 單獨 → +PMUX → +DTC」逐級把 PD 輸入端誤差從 ±0.5 cycle 縮到
            ±half-LSB 的完整解剖(公式、暫態、頻譜與 sanity 檢查),見{' '}
            <a href={chapterHref('pd-input-error-anatomy')}>Ch21 PD 輸入端誤差逐級解析</a>。
          </li>
        </ul>
      </SectionObserve>

      <SectionMisconception>
        <Callout
          type="warn"
          title="誤解 1:「/3-/4 的指令序列是 DSM 直接輸出的 bit stream,與 phase 無關」"
        >
          <p>
            錯。本架構的 <M>{'n_{int}'}</M> 是 absolute code 的差分{' '}
            <M>{'I_{FB}[k+1] - I_{FB}[k]'}</M>,由 master accumulator 的<strong>狀態</strong>導出。
            兩個 cycle 可以有相同的 divider 指令(都 /3)但 accumulator state 完全不同——只看指令
            bit 會丟失 injection 所需的 phase 資訊(Ch9 專章)。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
        <Callout type="warn" title="誤解 2:「PMUX 從 3 wrap 到 0 需要額外的補償狀態機」">
          <p>
            不需要。m 的 wrap 與 I 的進位是同一個整數 <M>{'A_{FB}'}</M> 進位的兩面
            (<M>{'A_{FB} = 256I + 64m + c'}</M>)。只有當三層指令各自獨立產生時才會出現「wrap
            補償」問題——那正是本架構刻意避免的做法。<EpistemicTag kind="EXACT" />
          </p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway>
        <p>
          把 divider/PMUX/DTC 視為<strong>一個 256 進位計數器的三段位數</strong>,由單一{' '}
          <M>{'A_{FB}'}</M> decode,是這條 feedback path 正確性的來源:edge 單調、wrap 自動補償、
          三層永不矛盾,而且全部可用 assertion 逐拍驗證。任何「各層各自算指令」的實作都應改寫成
          這種 absolute-code decode 形式。<EpistemicTag kind="INFERENCE" />
        </p>
      </SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty">
          <p>
            本章只到 digital-exact 層:PMUX 相位視為精確的 m/4,DTC 視為精確的 c/256。實際 PMUX
            mismatch(<M>{'\\delta_{pmux}[m]'}</M>)、DTC gain/INL/DNL 屬 behavioral nonideality
            model,在 Ch5 與 Ch15 加入。<EpistemicTag kind="ASSUMPTION" /> 此外 divider 的
            transistor-level 時序(重置、metastability)不在模型範圍內。
          </p>
        </Callout>
      </SectionLimitation>

      <DebugTable
        columns={[
          { key: 'k', label: 'k' },
          { key: 'A_ideal', label: 'A_ideal' },
          { key: 'A_FB', label: 'A_FB' },
          { key: 'I_FB', label: 'I_FB' },
          { key: 'R_FB', label: 'R_FB' },
          { key: 'm_FB', label: 'm_FB' },
          { key: 'c_FB', label: 'c_FB' },
          { key: 'n_int', label: 'n_int' },
        ]}
        rows={tableRows}
        exportName="ch4_decode_chain.csv"
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
      </ParamPanel>
    </ChapterShell>
  );
}
