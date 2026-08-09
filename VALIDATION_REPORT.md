# VALIDATION_REPORT.md

最後更新:2026-08-09。
本報告記錄實際執行過的測試、數值驗證與 review 過程。所有結果皆為本機實測,非預期值。

## 1. 測試總覽(目前狀態)

| Suite | 指令 | 結果 |
|---|---|---|
| Python golden model | `python3 -m pytest tests/ -q` | **87 passed, 0 failed** |
| TypeScript mirror + 交叉驗證 + smoke | `cd web && npm test`(vitest) | **141 passed / 15 files, 0 failed** |
| TypeScript type check | `npx tsc --noEmit`(strict) | **0 errors** |
| Production build | `cd web && npm run build` | **成功**(chapters lazy-loaded;echarts 為獨立 async chunk)|

vitest 141 項包含:TS acceptance tests、**Python↔TS 交叉驗證**(14 組 JSON vectors,
整數欄完全相等、float ≤1e-12、noise 路徑 ≤1e-9)、committed-vector byte-identity、
23 個 preset smoke tests、21 章 SSR render smoke tests、actuator/gating 行為測試。

## 2. 全面正確性 Review(2026-08-09)

以多 agent 交叉查核執行了一次完整 audit:8 路獨立 finder(spec↔Python、spec↔TS、
21 章內容、測試品質、Verilog-A、canonical 數字重算)產生 40 個 findings,
**每一個都經過獨立對抗式驗證**(2–3 個 agent 嘗試反駁):38 個 CONFIRMED、2 個被反駁。
38 個確認問題全部修正,主要包括:

1. **Mode B「independent DSMs」未真正獨立**(最嚴重):兩側 DSM state 因 complementary
   輸入而鎖成鏡像,pair error 只在啟動出現 1 次。修正:modes A/B/C 的 injection 側
   DSM instance 以獨立 PRNG stream `dsm_inj` 播種初始 state(MODEL_SPEC §7/§12)。
   修正後實測:Mode B + ef1 的 `e_pair_digital` 在 **326/512 = 63.7%** cycles 非零
   (值 ∈ {−1,0,+1} LSB);mash11 為 65.0%。Mode D 仍精確為 0。
2. **Spec 數學錯誤**:0.3 LSB ef1 carry pattern 由錯誤的「週期 4」修正為
   `0,0,0,1,0,0,1,0,0,1` 週期 10(carry rate 0.3);n_int 範圍修正為
   nearest/floor {3,4}、DSM {2,3,4}(5 對 N≤3.25 不可達);latency bug 符號修正為 −L·α。
3. **實驗 config 失效**:exp13 改為 off-grid N=3.13(修正後實測 max |e_ZC_hw| = 205.9 fs,
   符合 1% × 20 ps 量級);exp18 sweep 改用 off-grid N 值使 fixed-time/normalized 差異可見。
4. **章節數字錯誤**:N=3.13 quantization error 基本週期為 **25 拍**(spur 間距 160 MHz),
   多處誤寫為 100 拍/40 MHz,已全部修正;exp07 實為 ±0.5 LSB 十階 sawtooth(mean +0.047)、
   exp08 峰值 ±0.7 LSB,相關描述改為實測值。
5. 其他:error decomposition 可加性 gap 改為 per-cycle 線性和定義;latency metadata 補
   P_state/R_FB/R_INJ;新增 committed-vector byte-identity 回歸測試;Verilog-A ef1
   look-ahead state priming、nearest decode 對 b_dtc 一般化、testbench nominal tap/PMUX
   delay 規則補入 usage guide;Ch0–6 補查 86 條 claims 修正 5 處。

## 3. Model 擴充(DSM 使用情境)

為討論 fractional-N PLL 常見 DSM 用法的影響,擴充(Python + TS 同步,交叉驗證):

- **`mash111`**(MASH 1-1-1)quantizer;實測 n_int 可達集合 {2,3,4},與 mash11 相同
  (「更寬」的預期被實測推翻,已如實記載於 MODEL_SPEC §4)。
- **`actuator_mode='dsm_only'`**:classic divider-modulating DSM(無 PMUX/DTC),
  quantize 於整數 cycle,R_FB≡R_INJ≡0,e_ZC_hw 掃 ±0.5 cycle。
  mash11/mash111 在 dsm_only 下多數 N 觸發 divide-ratio 0(非法,model 刻意 raise)。
- **Injection gating**(`inj_gate_mode='threshold'`):只在 |e_ZC_hw| ≤ threshold 時 fire;
  新增 `inj_fired` 欄位。
- 新實驗 exp21/exp22 與新 vectors(共 14 JSON + 14 CSV)。

關鍵實測(seed 12345,512 cycles):

| 實驗 | 結果 |
|---|---|
| exp21a full actuator | fire 512/512,θ⁺ rms(後 256)= **0.0149 rad** |
| exp21b dsm_only 未 gated | e_ZC_hw rms 0.289/peak 0.5 cyc,θ⁺ rms = **1.811 rad(失鎖)** |
| exp21c dsm_only gated 1/16 | fire 67/512(13.1%),θ⁺ rms = **0.102 rad(恢復 bounded lock)** |
| exp22 ef1→mash11→mash111 | e_FB_abs rms 0.466→0.686→1.194 LSB;e_ZC_total rms 單調惡化 |

結論(EXPERIMENT→INFERENCE):DSM-only 架構下 ungated injection 有害;gating 只能部分
補救;DTC-assisted 架構(本專案 full actuator,等價於 injection 側的 DTC QNC)才是
與 reverse injection 相容的作法。網站 Ch11/Ch13/Ch20 詳述。

## 4. Acceptance tests(MODEL_SPEC §19)

原 14 條全部通過(逐項見 §19 表與對應測試檔),加上新增:mash111 定義測試、
dsm_only 不變量、gating 行為、exp21/exp22 一致性、committed-vector byte-identity。
Canonical 數字(312.5 fs、1.40625°、0.703125°、0.337→86/170、∓85 fs、46.8°、
222.22 fs、200 fs、wrapCycles(0.7)=−0.3、PRNG pinned values)全部以測試釘死。

## 5. 瀏覽器實測

- production build 於本機 preview 與 GitHub Pages 實測:章節載入、模擬執行、
  console 0 errors、light/dark、responsive、hash 直達連結正常。
- UI 改善(全部實測):上一章/下一章 + 鍵盤 ←/→、11 節浮動 TOC + scrollspy、
  TopBar 全域 N 控制(sessionStorage 保留)、模擬 spinner(Ch17 改為 post-paint 計算)、
  DebugTable sticky header + 欄位開關、全圖表 saveAsImage/restore toolbox、
  echarts 延遲載入(首屏不再等 1.1 MB chunk)。

## 6. Known limitations

1. **未執行 Spectre**:Verilog-A 僅靜態檢查;simulator-dependent constructs 集中標記。
   獨立 DSM 播種(mulberry32)無法在純 Verilog-A 重現(以 `e_q_init` 參數近似,已註明)。
2. **Injection dynamics 為離散 phase map 近似**(reset/linear/sin/LUT);
   PLL loop 未共模擬(Ch13 說明 loop-injection 互動為定性論述)。
3. **Shorting energy 為 sin² proxy**。
4. **Error decomposition 可加性僅 linear regime 近似**(per-cycle gap 已量化顯示)。
5. Python↔TS noise 路徑 tolerance 1e-9(libm 差異);純數位路徑整數全等。
6. Gating 使用 deterministic e_ZC_hw(非含 noise 的瞬時值)— 為 behavioral 簡化,
   實際電路的 gate 決策資訊來源需另行設計(ASSUMPTIONS B7)。

## 7. Remaining transistor-level questions

1. 實際 VCO 各 node 的 PDR/PRC 與 pulse width/強度 trade-off(K_inj 的物理對應)。
2. Taps/DTC 的實測 mismatch 分佈與漂移;DTC INL 真實形狀。
3. Injection 對 VCO amplitude 的擾動與 AM-PM。
4. Loop filter 與 injection 的完整 co-simulation(本 model 刻意分離)。
5. Gated injection 的 gate 判斷在實際電路如何取得(需 calibration/observer 設計)。
6. Calibration loop 收斂動態(本 model 只給 calibrated mapping 靜態最佳解)。
