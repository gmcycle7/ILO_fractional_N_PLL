# web/ARCHITECTURE.md — 網站架構與元件契約(for content/model agents)

This document is the binding contract for agents writing chapter content in
`web/src/chapters/` and for the model agent filling `web/src/model/`.
The mathematical contract is `../MODEL_SPEC.md` + `../ASSUMPTIONS.md` (repo
root) — nothing on the website may deviate from them.

## 0. Stack and commands

- React 19 + TypeScript (strict, `noUnusedLocals`, `noUnusedParameters`) + Vite.
- Charts: `echarts`, loaded lazily via `import('echarts')` inside
  `components/EChart.tsx` only (module-level cached promise; the echarts
  chunk is async so first paint of chapter text never waits for it).
  Chapters never import echarts directly — type-only imports
  (`import type { EChartsOption } from 'echarts'`) are fine.
- Math: `katex` via `components/Math.tsx` (KaTeX CSS is imported in `main.tsx`).
- Tests: Vitest (`environment: node`), files `src/**/*.test.{ts,tsx}`.

```
npm run dev       # dev server
npm run build     # tsc --noEmit && vite build (must stay green)
npm run test      # vitest run (must stay green)
npm run preview
```

## 1. Language & style rules (binding)

- Primary language: **Traditional Chinese (zh-Hant)**. `index.html` has
  `lang="zh-Hant"`. **Never** Simplified Chinese. Technical terms stay in
  English (DTC, PMUX, DSM, zero-crossing, injection, spur, …).
- Visual style: professional engineering. Restrained neutral palette
  (grays/blues, ONE accent color), **no gradients, no cartoon style, no
  decorative images, no gimmicky animation**. Desktop-first, responsive.
- Light AND dark theme. Default light. Never hardcode colors in chapter
  JSX/CSS — use CSS variables (see §3) or `ChartTheme` tokens for canvases.
- Every equation/claim carries the epistemic tag from MODEL_SPEC
  (`[EXACT] [ASSUMPTION] [APPROX] [EXPERIMENT] [INFERENCE]`) via
  `<EpistemicTag kind="..."/>`.

## 2. Directory layout

```
web/
  index.html                lang=zh-Hant, pre-paint theme script
  vite.config.ts            vite + vitest config
  tsconfig.json             strict TS, include src/
  src/
    main.tsx                entry: katex css, index.css, initTheme, <App/>
    App.tsx                 layout shell + hash routing + lazy chapters
                            (+ footer 上一章/下一章 nav and global ←/→
                            keyboard chapter switching, skipped while focus
                            is in a form control)
    SimStatusContext.tsx    global simulation status context
    index.css               ALL global styles + CSS variables (both themes)
    lib/
      theme.ts              ThemeMode, ChartTheme tokens, subscribeTheme
      useChartTheme.ts      React hook: ChartTheme that tracks toggles
      format.ts             PhaseUnit, formatPhase, axis label helpers
      chartOptions.ts       makeLineOption + axis/tooltip/toolbox builders
      globalParams.tsx      global N (n_div) context + chapter hooks
      router.ts             hash router: useHashRoute, chapterHref
    components/             shared UI (documented in §5)
    chapters/
      index.ts              CHAPTERS registry (ids, slugs, titles, lazy load)
      Chapter00.tsx … Chapter20.tsx   one file per chapter (currently stubs)
      stub.tsx              placeholder body (delete usages as you fill chapters)
    model/                  TS mirror of the Python golden model (model agent)
```

## 3. Theming rules

- `<html data-theme="light|dark">` is the single switch (default light,
  persisted in `localStorage['ilo-theme']`, stamped pre-paint by an inline
  script in `index.html`). The top bar renders the toggle.
- DOM/SVG styling: use CSS variables from `index.css` (`--bg`, `--bg-alt`,
  `--bg-panel`, `--fg`, `--fg-subtle`, `--fg-faint`, `--border`,
  `--border-strong`, `--accent`, `--accent-soft`, `--code-bg`, callout/status/
  epistemic tokens…). Inline SVG may use them directly (`fill="var(--accent)"`).
- Canvas charts cannot read CSS variables. Use `ChartTheme` tokens:

```ts
import { useChartTheme } from '../lib/useChartTheme';
import { makeLineOption } from '../lib/chartOptions';

const ct = useChartTheme();               // re-renders on theme toggle
const option = useMemo(
  () => makeLineOption({ ... }),          // reads getChartTheme() internally
  [data, ct],                             // MUST depend on ct
);
```

`EChart` additionally re-inits itself on theme change with a registered
echarts theme, so default text/palette colors never go stale even if you
forget a color; explicit colors still need the `ct` dependency above.

## 4. Layout, routing, registry

- Fixed left sidebar lists all 21 chapters (number + zh title + en subtitle);
  top bar shows current chapter + simulation status + theme toggle; central
  scrollable content (`.content`); optional right-docked param panel.
- Routing is hash-based: `#/<slug>`. No router dependency. Navigate with
  plain `<a href={chapterHref(slug)}>` or `navigateToChapter(slug)` from
  `lib/router.ts`. Unknown/empty hash falls back to chapter 0.
- Registry `chapters/index.ts` exports
  `CHAPTERS: { id, slug, titleZh, titleEn, load }[]` — `load` is a dynamic
  import used with `React.lazy` in `App.tsx`. **Do not change ids or slugs**
  (slugs are URLs). To fill a chapter, edit `ChapterNN.tsx` only; keep the
  default export a parameterless React component.

### SimStatusContext

```tsx
import { useSimStatus } from '../SimStatusContext';
const { setStatus } = useSimStatus();
setStatus('running', 'N sweep 3.000…3.250');   // status: 'idle'|'running'|'done'
setStatus('done', '512 cycles');
```
Set `running` before any non-trivial simulate() call and `done` after; the
top bar displays it (with a small spinner while `running`). For figure areas
recomputed in a post-paint effect, wrap them in
`<SimVeil active={runs === null}>` (`../components/SimVeil`) to overlay a
subtle translucent veil + spinner (see Chapter17 for the pattern:
`useState(null)` + `useEffect` + `setTimeout(0)` so preset switches paint
immediately).

### Global parameters — `../lib/globalParams`

```tsx
import { useChapterAlpha, useChapterNDiv, useGlobalNDiv } from '../lib/globalParams';
const [alpha, setAlpha] = useChapterAlpha(); // chapter-local α = N − 3
const [nDiv, setNDiv] = useChapterNDiv();    // chapter-local N
const { nDiv, setNDiv } = useGlobalNDiv();   // raw context (TopBar N control)
```

The divide ratio N is a **global** parameter (sessionStorage `pll_n_div`,
default 3.13, presets `N_DIV_PRESETS = [3.0, 3.125, 3.13, 3.1375, 3.25]`,
clamped to [3, 3.25]). The TopBar renders a compact preset + numeric input
control. Chapters that expose an N/α control MUST use `useChapterNDiv()` /
`useChapterAlpha()` instead of `useState`: local state is seeded from the
global value, re-initialized when the TopBar changes N, and written back on
local change. Chapters without an N control ignore it. SSR-safe (render
smoke tests run without a provider and fall back to the default value).

The full preset catalogue is the **grouped** export (flat `N_DIV_PRESETS`
stays unchanged for existing consumers — Chapter21/Chapter22 preset rows):

```ts
interface NDivPreset      { n: number; label: string; hint: string }
interface NDivPresetGroup { label: string; values: NDivPreset[] }
N_DIV_PRESET_GROUPS: NDivPresetGroup[]   // 基本 / sub-LSB 階梯 / 特殊
N_DIV_ALL_PRESETS:   NDivPreset[]        // flattened, 13 entries
findNDivPreset(n):   NDivPreset | undefined   // exact float64 match
```

Group 0 (`基本`) mirrors `N_DIV_PRESETS` exactly and stays the five TopBar
buttons; `N_DIV_PRESET_GROUPS.slice(1)` (sub-LSB 階梯 F1–F4, 特殊 F5–F8) sits
behind one compact `<select>` with `<optgroup>`s so the bar stays uncluttered.
`hint` is the `title` tooltip (α·G, period P, spur spacing, story). Values and
periods are contracted in `MODEL_SPEC.md` §1.1 and re-derived numerically by
`src/lib/globalParams.test.ts`.

## 5. Component reference (import paths relative to `src/chapters/`)

### EChart — `../components/EChart` (default export)

```ts
interface EChartProps {
  option: EChartsOption;         // build via makeLineOption
  height?: number | string;      // default 320
  group?: string;                // echarts.connect group (sync zoom/tooltip)
  onEvents?: Record<string, (params: unknown) => void>;  // e.g. { click }
  className?: string;
}
```
Handles lazy echarts loading (placeholder box of the reserved height until
the async echarts chunk arrives), init/dispose, ResizeObserver resize, theme
re-init, group connect. Give two charts the same `group` string to sync
their axisPointer/zoom.

### Chart options — `../lib/chartOptions`

```ts
makeLineOption({
  title?, xLabel?, yLabel?,
  series: { name, data, color?, type?: 'line'|'scatter'|'bar',
            step?: 'start'|'middle'|'end',   // per-cycle digital sequences
            showSymbol?, symbolSize?, width?, dashed?, area?, yAxisIndex? }[],
  xType?: 'value'|'category', categories?,
  xTickFormatter?, yTickFormatter?,          // (v:number)=>string
  zoom?: boolean,      // default true: x dataZoom inside + slider
  toolbox?: boolean,   // default true: dataZoom/restore/saveAsImage
  legend?: boolean,    // default: series.length > 1
  xMin?, xMax?, yMin?, yMax?,
  extra?: Record<string, unknown>,           // shallow-merged escape hatch
}): EChartsOption
baseAxis(t, name?, formatter?)   // for hand-rolled options
baseTooltip(t)                   // crosshair tooltip config
baseToolbox(t, { dataZoom? })    // toolbox: dataZoom/restore/saveAsImage
makeMarkLine([{ y?|x?, label?, color? }])   // dashed reference lines
```
Every chart must carry the toolbox (saveAsImage + restore): makeLineOption
includes it by default; hand-rolled options spread
`{ toolbox: baseToolbox(t) }`.
Per-reference-cycle sequences: x axis is `k` (sample rate = f_ref, MODEL_SPEC
§17); use `step: 'middle'` + `showSymbol` for short sequences.

### Math — `../components/Math` (named exports `M`, `MathBlock`)

```tsx
<M>{'\\alpha = N - 3'}</M>                         // inline
<MathBlock>{'x_{ideal}[k+1] = \\operatorname{wrap01}(x_{ideal}[k] + \\alpha)'}</MathBlock>
```
Children must be a raw TeX string. `throwOnError:false`, `trust:false`.

### ChapterShell + sections — `../components/ChapterShell` (named exports)

`ChapterShell({ chapter?, titleZh?, titleEn?, children })` renders the
chapter header and the `.chapter-grid` container, plus (automatically, no
chapter wiring) a floating collapsible mini-TOC of the 11 sections on
>= 1280 px viewports with IntersectionObserver scrollspy; anchor ids
`sec-<slug>` are stamped on the first occurrence of each section kind.

Fixed 11-part structure (order binding; Figure/Code may repeat):

| # | Component | 標題 |
|---|-----------|------|
| 1 | `SectionQuestion` | 本章要回答的問題 |
| 2 | `SectionIntuition` | 物理直覺 |
| 3 | `SectionMath` | 完整數學 |
| 4 | `SectionExample` | 數值例子 |
| 5 | `SectionFigure` | 互動圖 — props `{ title, children, caption? }` |
| 6 | `SectionCode` | 行為程式碼 — props `{ code, language?, title?, children? }` |
| 7 | `SectionLineByLine` | 逐行解說 — props `{ items: { code, explain }[] }` |
| 8 | `SectionObserve` | 圖上應觀察什麼 |
| 9 | `SectionMisconception` | 常見誤解 |
| 10 | `SectionTakeaway` | 設計要點 |
| 11 | `SectionLimitation` | 模型限制 |

All others take `{ children }` only.

### ExampleProblem — `../components/ExampleProblem` (default export, named `fmt`)

The shared **interactive worked-example** widget. Every chapter puts **three**
of them inside its `SectionExample` (數值例子): the reader edits the given
quantities and watches the intermediate values and the final answer recompute.
The chapter supplies the statement, the editable inputs and ONE pure `compute`;
the component owns all state, validation, formatting and layout.

```ts
interface ExampleInput {
  key: string;          // compute receives it as v[key]; also used in warnings
  label: ReactNode;     // may contain <M> math
  def: number;          // default, restored by 重設
  min?: number;         // inclusive; below it -> out-of-range warning
  max?: number;         // inclusive
  step?: number;        // spinner step (typed values are NOT snapped)
  unit?: string;        // shown after the field: 'cyc' | 'GHz' | 'ps' | …
}
interface ExampleStep { label: ReactNode; value: string }   // value: use fmt()
interface ExampleResult {
  steps: ExampleStep[];
  answer: ReactNode;
  warn?: string;        // caveat for THIS input point (boundary, out of validity)
}
interface ExampleProblemProps {
  title: string;                     // short zh-Hant title
  prompt: ReactNode;                 // zh-Hant statement, may contain <M> math
  inputs: ExampleInput[];
  compute: (v: Record<string, number>) => ExampleResult;   // PURE
  tag?: 'EXACT' | 'APPROX' | 'EXPERIMENT';
  index?: number;                    // badge number (1..3); omit -> 例
  defaultOpen?: boolean;             // start with 解題步驟 expanded (default false)
}

fmt(value: number, digits = 6, unit?: string): string   // named export
```

Rendering: numbered card header (badge + title + `EpistemicTag`) → prompt →
editable number inputs (defaults prefilled) → warning line (if any) →
`解題步驟` toggle + `重設` → collapsible numbered step list → highlighted
answer box.

Binding rules:

- `compute` must be **pure** and read every number from `v` — it runs on every
  keystroke. It must get its math from `../model` (ARCHITECTURE §6); never
  re-implement wrap/quantizer/DSM math inside it.
- Validation is the component's job, not the chapter's: a blank/NaN field or a
  value outside `[min, max]` shows `輸入無效:…`, marks the field, and
  **suppresses** steps + answer (`compute` is not called). A `compute` that
  throws becomes `計算失敗:…` instead of unmounting the chapter.
- `fmt` (and `../lib/format`) are **display only** — never feed a formatted
  string back into a computation. `digits` is *significant* digits, trailing
  zeros stripped, non-finite renders as `NaN` / `∞` / `−∞`, and the count is
  clamped to toPrecision's legal 1..21 so it cannot throw.
- SSR-safe: pure render from props + state, no effects, no `window`/`document`.
  Keep it that way — `chapters/__tests__/render.smoke.test.tsx` renders every
  chapter with `renderToString`.
- Styling: `.example-problem*` classes in `index.css` (theme vars only). The
  action buttons are hidden in print; the card avoids page breaks.

Full usage example (wired to the model — `wrap01`, `qNearest`, `configTVcoS`;
with the defaults below the card shows `s = 15.65 cyc`, `x = 0.65 cyc`,
`Gx = 166.4`, `q = 166`, `T_vco = 79.872 ps`, answer `51.792 ps`):

```tsx
import ExampleProblem, { fmt } from '../components/ExampleProblem';
import { M } from '../components/Math';
import { SectionExample } from '../components/ChapterShell';
import { fromPartial, configG, configTVcoS, wrap01, qNearest } from '../model';

<SectionExample>
  <ExampleProblem
    index={1}
    tag="EXACT"
    title="第 k 拍的 fractional phase 與最近的 fine code"
    prompt={
      <>
        取 <M>{'N'}</M>、起始相位 <M>{'s_0'}</M> 與拍數 <M>{'k'}</M>,先算絕對相位{' '}
        <M>{'s = s_0 + kN'}</M>,再取 <M>{'x_{ideal}[k] = \\operatorname{wrap01}(s)'}</M>,
        最後量化成 <M>{'G'}</M> 階 fine code{' '}
        <M>{'q = \\operatorname{qNearest}(G\\,x)'}</M> 並換算成時間。
      </>
    }
    inputs={[
      { key: 'N', label: <M>{'N'}</M>, def: 3.13, min: 2, max: 8, step: 0.001 },
      { key: 's0', label: <M>{'s_0'}</M>, def: 0, min: -100, max: 100, step: 0.01, unit: 'cyc' },
      { key: 'k', label: <M>{'k'}</M>, def: 5, min: 0, max: 1023, step: 1 },
      { key: 'fref', label: <M>{'f_{ref}'}</M>, def: 4, min: 0.1, max: 20, step: 0.1, unit: 'GHz' },
    ]}
    compute={(v) => {
      const cfg = fromPartial({ n_div: v.N, f_ref_hz: v.fref * 1e9 });
      const G = configG(cfg);                       // 256 fine steps per T_vco
      const tVcoPs = configTVcoS(cfg) * 1e12;
      const s = v.s0 + v.k * v.N;
      const x = wrap01(s);                          // MODEL_SPEC §2/§3
      const q = qNearest(G * x);                    // half-up, NEVER Math.round
      const resid = G * x - q;                      // quantization residue, LSB
      return {
        steps: [
          { label: <><M>{'s = s_0 + kN'}</M></>, value: fmt(s, 8, 'cyc') },
          { label: <><M>{'x = \\operatorname{wrap01}(s)'}</M></>, value: fmt(x, 6, 'cyc') },
          { label: <>fine code 之前的實數 <M>{'G\\,x'}</M></>, value: fmt(G * x, 8) },
          { label: <><M>{'q = \\operatorname{qNearest}(G x)'}</M></>, value: `${q} / ${G} LSB` },
          { label: <><M>{'T_{vco} = 1/(N f_{ref})'}</M></>, value: fmt(tVcoPs, 5, 'ps') },
        ],
        answer: (
          <>
            <M>{'x_{ideal}[k]'}</M> = {fmt(x, 6, 'cyc')},量化後{' '}
            <M>{'q'}</M> = {q} LSB = {fmt((q / G) * tVcoPs, 5, 'ps')}
          </>
        ),
        warn:
          Math.abs(resid) > 0.499
            ? `落在量化邊界(殘差 ${fmt(resid, 3)} LSB),±1 LSB 都算合理`
            : undefined,
      };
    }}
  />
</SectionExample>;
```

### EpistemicTag — `../components/EpistemicTag` (default export)

`<EpistemicTag kind="EXACT" />` with
`kind: 'EXACT'|'ASSUMPTION'|'APPROX'|'EXPERIMENT'|'INFERENCE'`.

### Callout — `../components/Callout` (default export)

`{ type?: 'note'|'warn'|'honesty', title?, children }` — use `honesty` for
model-limitation statements (matches MODEL_SPEC §20 tone).

### CodeBlock — `../components/CodeBlock` (default export)

`{ code: string, language?, title? }` — monospace `<pre>` with copy button.
No syntax highlighting (by design).

### Controls — `../components/controls` (named exports)

```ts
Slider({ label, value, min, max, step?, unit?, onChange, log?, fmt? })
  // log:true -> logarithmic position mapping (requires min > 0)
NumberInput({ label, value, onChange, min?, max?, step?, unit? })
SelectControl<T extends string>({ label, value, options: {value,label}[], onChange })
Toggle({ label, checked, onChange })
PresetButtons({ label?, presets: { label, onClick }[] })
ParamPanel({ title?, children })
```

`ParamPanel` docking rule: it must be a **direct child of `ChapterShell`**,
placed as the **last** child. On viewports >= 1280 px CSS docks it as a
sticky right column (320 px); below that it flows after the content.

### UnitSwitch — `../components/UnitSwitch`

```ts
// named: UnitProvider, useUnit; default: UnitSwitch
const { unit } = useUnit();   // 'cycles' | 'deg' | 'time'  (global, provided in App)
<UnitSwitch />                // segmented control bound to the context
<UnitSwitch value={u} onChange={setU} />   // locally scoped alternative
```

### format — `../lib/format`

Internal phase unit is ALWAYS VCO cycles (MODEL_SPEC §2). Convert only for
display:

```ts
type PhaseUnit = 'cycles' | 'deg' | 'time';
formatPhase(valueCycles, unit, tVcoSeconds, sig?) // '0.337 cyc' | '90°' | '-85 fs'
formatSiTime(seconds, sig?)                       // '312.5 fs', '80 ps'
phaseUnitLabel(unit, tVcoSeconds?)                // 'cycles' | 'deg' | 'ps'
phaseAxisLabel(name, unit, tVcoSeconds?)          // 'e_pair (ps)'
makePhaseTickFormatter(unit, tVcoSeconds, sig?)   // ticks matching that label
phaseToUnitValue(valueCycles, unit, tVcoSeconds)  // numeric conversion
trimNumber(v, sig?)                               // display rounding only
```
NEVER use `trimNumber`/formatters for computation — they are display-only.
Quantization math must use the model's `qNearest`/`qFloor` (MODEL_SPEC §2).

### PhaseWheel — `../components/PhaseWheel` (default export)

```ts
{
  taps?: { angleCycles, label, color? }[],       // fixed ring positions
  markers: { angleCycles, label?, color?, r? }[],// needles (r: 0..1 of radius)
  arcs?: { fromCycles, toCycles, color?, r?, width? }[],
  size?: number,            // px, default 260
  animateToMarker?: boolean,// CSS transition on needle rotation
  title?: ReactNode,
}
```
Angle convention: **0 cycles at 12 o'clock, increasing clockwise** (phase
increase = later edge). All angles in cycles, wrapped mod 1. Major ticks every
1/8 cycle (tick labels hidden when `taps` are provided).

### EdgeTimeline — `../components/EdgeTimeline` (default export)

```ts
{
  rows: { label, edges: { t, color?, tag? }[] }[],
  tMax: number, tMin?: number,   // caller-chosen unit
  unitLabel: string,             // e.g. 'ps' or 'T_ref'
  rowHeight?: number,
}
```
SVG rows of edge ticks over a shared axis; hovering an edge shows a readout.

### DebugTable — `../components/DebugTable` (default export)

```ts
{
  columns: { key, label, fmt?: (value, row) => string }[],
  rows: Record<string, unknown>[],
  maxHeight?: number,       // default 320 (scrolling)
  exportName?: string,      // CSV filename, default 'debug_table.csv'
}
```
CSV export button is always present; CSV uses column **keys** as header and
**raw** values (full precision, comparable against Python golden output);
`fmt` affects screen only. The header row is sticky inside the scroll
container, and a 欄位 dropdown toggles per-column visibility (screen only —
CSV always exports ALL columns regardless of visibility).

## 6. Model import contract (binding for chapter agents)

The TypeScript mirror model lives in `web/src/model/` (currently a README
placeholder — the model agent will implement it against MODEL_SPEC.md).

- Chapters import compute functionality ONLY from `../model`:

```ts
import { simulate, defaultConfig /* , ... */ } from '../model';
```

- The exported API surface is defined by the model agent; treat `../model` as
  the **only compute entry**. Chapters MUST NOT re-implement wrap/quantizer/
  DSM/injection math inline, must not import from `../model/internal` paths,
  and must not fabricate numbers — every plotted value comes from the model
  (or is a MODEL_SPEC check value quoted with its epistemic tag).
- Until the model lands, chapters must not import `../model` (the current
  stubs do not), so the build stays green.
- Deterministic PRNG (seed 12345, MODEL_SPEC §12) lives in the model; never
  use `Math.random()` in chapters.

## 7. Chapter template (full skeleton)

Replace the body of `ChapterNN.tsx` following this shape (Chapter 3 example):

```tsx
import { useMemo, useState } from 'react';
import {
  ChapterShell, SectionQuestion, SectionIntuition, SectionMath, SectionExample,
  SectionFigure, SectionCode, SectionLineByLine, SectionObserve,
  SectionMisconception, SectionTakeaway, SectionLimitation,
} from '../components/ChapterShell';
import EChart from '../components/EChart';
import EpistemicTag from '../components/EpistemicTag';
import Callout from '../components/Callout';
import { M, MathBlock } from '../components/Math';
import { ParamPanel, Slider, PresetButtons } from '../components/controls';
import UnitSwitch, { useUnit } from '../components/UnitSwitch';
import DebugTable from '../components/DebugTable';
import { makeLineOption } from '../lib/chartOptions';
import { useChartTheme } from '../lib/useChartTheme';
import { formatPhase, phaseAxisLabel, makePhaseTickFormatter } from '../lib/format';
import { chapterById } from './index';
// import { simulate, defaultConfig } from '../model';   // once model lands

const meta = chapterById(3)!;

export default function Chapter03() {
  const [alpha, setAlpha] = useState(0.13);
  const { unit } = useUnit();
  const ct = useChartTheme();
  const tVco = 1 / ((3 + alpha) * 4e9);          // display only; sims use ../model

  const result = useMemo(() => {
    // const r = simulate({ ...defaultConfig, alpha, nCycles: 64 });
    return { x: [] as [number, number][] };      // placeholder until model lands
  }, [alpha]);

  const option = useMemo(
    () =>
      makeLineOption({
        xLabel: 'k (reference cycle)',
        yLabel: phaseAxisLabel('x_ideal', unit, tVco),
        yTickFormatter: makePhaseTickFormatter(unit, tVco),
        series: [{ name: 'x_ideal', data: result.x, step: 'middle', showSymbol: true }],
      }),
    [result, unit, tVco, ct],
  );

  return (
    <ChapterShell chapter={meta.id} titleZh={meta.titleZh} titleEn={meta.titleEn}>
      <SectionQuestion>
        <p>off-grid 的 <M>{'\\alpha'}</M>(如 0.13)如何產生連續且 deterministic 的
        fractional phase trajectory?<EpistemicTag kind="EXACT" /></p>
      </SectionQuestion>

      <SectionIntuition><p>…物理直覺(zh-Hant)…</p></SectionIntuition>

      <SectionMath>
        <MathBlock>{'s_{ideal}[k] = s_0 + kN \\quad [EXACT]'}</MathBlock>
        <p>其中 <M>{'N = 3 + \\alpha'}</M>…</p>
      </SectionMath>

      <SectionExample>
        <p>N = 3.13:x_ideal = 0, 0.13, 0.26, …(MODEL_SPEC §3)。
        目前值:{formatPhase(0.13, unit, tVco)}</p>
      </SectionExample>

      <SectionFigure
        title="x_ideal[k] trajectory"
        caption={<span>拖動 α slider 觀察 wrap01 造成的鋸齒。單位:<UnitSwitch /></span>}
      >
        <EChart option={option} height={300} group="ch3" />
      </SectionFigure>

      <SectionCode
        language="python"
        code={'s_ideal = s0 + k * N   # multiplication, not accumulation'}
      />

      <SectionLineByLine
        items={[{ code: 's_ideal = s0 + k * N', explain: '用乘法保證 float64 逐位一致…' }]}
      />

      <SectionObserve><p>…應觀察到 α=0.13 時每 100 拍回到 0.13 的整數倍…</p></SectionObserve>

      <SectionMisconception>
        <Callout type="warn" title="誤解">
          <p>「off-grid α 表示 phase 不存在」— 錯;是 actuator 無法精確表示它。</p>
        </Callout>
      </SectionMisconception>

      <SectionTakeaway><p>…</p></SectionTakeaway>

      <SectionLimitation>
        <Callout type="honesty"><p>本章為 exact digital model,不含 analog 誤差。</p></Callout>
      </SectionLimitation>

      <DebugTable
        columns={[{ key: 'k', label: 'k' }, { key: 'x_ideal', label: 'x_ideal' }]}
        rows={[]}
        exportName="ch3_x_ideal.csv"
      />

      <ParamPanel title="參數">
        <Slider label="α" value={alpha} min={0} max={0.25} step={0.0005} onChange={setAlpha} />
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
```

Notes:
- `ParamPanel` last direct child (see §5). `SimStatusContext` for long sims.
- Keep `npm run build` clean: TS strict forbids unused locals/params.
- MODEL_SPEC preset N values: `3.000, 3.125, 3.130, 3.1375, 3.250`.

## 8. CSS class conventions

Prefer existing classes; if a chapter needs custom styling, add classes to
`index.css` (never inline hex colors) with a `chN-` prefix (e.g. `ch14-`).

- Layout: `.app`, `.sidebar`, `.main-col`, `.topbar`, `.content`
- Chapter: `.chapter`, `.chapter-header`, `.chapter-kicker`,
  `.chapter-subtitle`, `.chapter-grid`, `.chapter-section`,
  `.section-header`, `.section-num`, `.section-body`,
  `.section-figure`, `.section-figure-title`, `.section-figure-body`
- Widgets: `.callout(-note|-warn|-honesty)`, `.epistemic-tag`,
  `.codeblock`, `.linebyline(-row|-code|-explain)`, `.control(-slider|…)`,
  `.param-panel`, `.unit-switch`, `.debug-table`, `.data-table`,
  `.phase-wheel`, `.edge-timeline`, `.echart`,
  `.example-problem(-header|-num|-title|-prompt|-inputs|-input|-warn|
  -actions|-steps|-step-label|-step-value|-answer)`
- States: `.nav-item-active`, `.sidebar-open`, `.sim-status-(idle|running|done)`

Rules: no gradients; no new accent colors; wide content (tables/plots) must
scroll inside its own container, never the page horizontally; keep print
output usable (interactive chrome is hidden by the print stylesheet).

## 9. Unit conventions recap (binding)

- Phase: VCO cycles internally, float64. 1 cycle = 2π rad = T_vco s = 360°.
- Sign: phase increase = later edge; error = actual − ideal; delays positive.
- Fine code: 1 LSB = 1/256 cycle (G = 256). At N=3.125: LSB = 312.5 fs
  = 1.40625°, half-LSB = 156.25 fs = 0.703125°.
- Per-cycle sequences are sampled at f_ref (4 GHz default), NOT f_vco.
- dBc labeling rules: MODEL_SPEC §17 (SSB spur = 20·log10(a/2) dBc).
