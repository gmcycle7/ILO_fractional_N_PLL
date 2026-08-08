# VALIDATION_REPORT.md

日期:2026-08-08。
本報告記錄實際執行過的測試與數值驗證。所有結果皆為本機實測,非預期值。

## 1. 測試總覽

| Suite | 指令 | 結果 |
|---|---|---|
| Python golden model | `python3 -m pytest tests/ -q` | **61 passed, 0 failed** |
| TypeScript mirror + 交叉驗證 + smoke | `cd web && npm test`(vitest) | **119 passed / 14 files, 0 failed** |
| TypeScript type check | `npx tsc --noEmit`(strict) | **0 errors** |
| Production build | `cd web && npm run build` | **成功**(dist 3.2 MB;chapters lazy-loaded 16–32 kB/章)|

vitest 119 項包含:TS acceptance tests、**Python↔TS 交叉驗證**(12 組 JSON vectors,
整數欄完全相等、float ≤1e-12、noise 路徑 ≤1e-9)、**21 個 preset smoke tests**
(全部 experiments 模擬無 exception、關鍵欄位 finite)、**21 章 SSR render smoke tests**
(每章 `renderToString` 無 throw)。

## 2. Acceptance tests(MODEL_SPEC §19)逐項狀態

| # | 內容 | 狀態 | 驗證位置 |
|---|---|---|---|
| 1 | N=3.125:LSB=312.5 fs、phase LSB=1.40625°、half-LSB=0.703125° | ✅ | pytest `test_units_constants` + vitest |
| 2 | Mode D:`R_INJ=(−R_FB) mod 256`、`e_pair_digital≡0`(所有 k、所有 quantizer) | ✅ | pytest `test_mode_d_identity` + vitest |
| 3 | u=0.337 → R_FB=86、R_INJ=170、∓85 fs、pair=0 | ✅ | 兩側皆有 |
| 4 | 0.3 LSB ef1:mean→0、instantaneous ∈ {−0.3, +0.7} LSB | ✅ | pytest `test_quantizers` + vitest |
| 5 | α=0.13、L=1 latency bug = 46.8° | ✅ | pytest `test_latency` + vitest |
| 6 | 1° tap mismatch @80 ps = 222.22 fs | ✅ | pytest `test_mismatch` + vitest |
| 7 | 1% DTC gain @20 ps = 200 fs | ✅ | 同上 |
| 8 | N∈[3,3.25] sweep:edges monotonic、codes 合法、n_int 合法 | ✅ | pytest `test_sweep` + vitest |
| 9 | Python↔TS deterministic vectors 一致 | ✅ | vitest cross-validation(12 vectors)|
| 10 | `npm run build` 成功 | ✅ | 實測 exit 0 |
| 11 | 所有 presets 載入無 runtime exception | ✅ | vitest `presets.smoke` + `render.smoke` + 瀏覽器實測 |
| 12 | PSD x 軸 sample rate = f_ref | ✅ | pytest `test_measurements` + vitest |
| 13 | shared final code vs independent DSM pair-error 行為不同(D≡0、B≠0) | ✅ | 兩側皆有 |
| 14 | injection models 趨勢合理(K_inj→0 無修正;K_inj↑ residual↓;sin 固定點 = asin 解) | ✅ | pytest `test_dynamics` + vitest |

## 3. 關鍵數值 checks(實測)

- `wrapCycles(0.7) = −0.3`;`qNearest` 用 `floor(x+0.5)`(非語言內建 round,避免
  banker's rounding 跨語言不一致)— Python 與 TS 逐位一致。
- Mulberry32 PRNG:seed 12345 前 5 個輸出在 Python 與 TS pinned 為相同常數
  (pytest `test_prng` / vitest 對應測試)。
- Mode D identity 以「所有 quantizer mode × 512 cycles」驗證 `e_pair_digital` **精確為 0**
  (非 tolerance 比較)。
- On-grid case(N=3.125)`e_FB_abs ≡ 0` exact。
- ef1 DSM 0.3 LSB case 的 error sequence 逐拍為 `−0.3,−0.3,−0.3,+0.7` 循環。
- sin injection map 的 steady state 與 `asin(2πΔf·T_ref/K_inj)` 解析解一致(≤1e-6)。
- 12 組 test vectors 重新生成兩次逐位 identical(deterministic 驗證)。

## 4. 瀏覽器實測(vite preview,production bundle)

- Ch0/Ch3/Ch17 實際載入:模擬在 browser 端執行完成(status bar 顯示 Done + cycle 數);
  Ch17 渲染 4 個 ECharts、3 個表格、2 個 CSV export 按鈕;Ch3 phase wheel 有 Play/Step 控制。
- Console **0 errors**。
- Light/dark mode 切換實測正常(`data-theme` 切換、背景/圖表色跟隨)。

## 5. Known limitations

1. **未執行 Spectre**:`model/veriloga/*.va` 為 simulator-friendly source,僅通過
   靜態括號/區塊平衡檢查,未經任何 Verilog-A simulator 編譯或模擬。
   simulator-dependent constructs(`@cross`、`transition` 變動延遲、`idtmod`、
   analog-block 記憶狀態、`$bound_step`)已集中標記於 `// --- SIMULATOR-DEPENDENT ---`
   區段,詳見 `VERILOGA_USAGE.md`。
2. **Injection dynamics 是離散 phase map 近似**(reset/linear/sin/LUT),
   不等同 continuous-time ILO 或 transistor-level shorting;amplitude 效應未建模。
3. **Shorting energy 為 sin² normalized proxy**,非真實功率。
4. **Error decomposition 的可加性只在 linear regime 近似成立**;model 同時輸出
   逐項 contribution 與 joint total,差異即非線性交互項。
5. **PDR/PRC 需自行萃取**:網站/model 支援 CSV LUT 匯入,但本專案不含任何
   transistor-level 萃取結果。
6. Python↔TS 的 noise 路徑 tolerance 為 1e-9(libm cos/sin/log 末位差異),
   非逐位相等;純數位路徑為整數全等。

## 6. Remaining transistor-level questions(留給 silicon 團隊)

1. 實際 VCO 各 node 的 PDR/PRC 形狀與 injection pulse width/強度的 trade-off
   (K_inj 對應的物理量)。
2. 8 個 injection taps 的實測 static mismatch 分佈與溫度/supply 漂移
   (本 model 假設 static LUT)。
3. DTC INL 的真實形狀(本 model 提供 sin/poly/LUT 三種 behavioral 形式)。
4. injection pulse 對 VCO amplitude(非 phase)的擾動與 AM-PM 轉換。
5. reference spur 的 board/package 耦合路徑(不在 behavioral scope 內)。
6. calibration loop 的收斂與 dithering 策略(本 model 提供 calibrated mapping
   的靜態最佳解,未建 calibration dynamics)。
