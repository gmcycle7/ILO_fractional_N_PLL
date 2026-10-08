# VALIDATION_REPORT.md

最後更新:2026-10-08(§1 測試計數與 §8–§11 為 2026-10-08 實測;§2–§7 保留 2026-08-09 audit 當時的敘述)。
本報告記錄實際執行過的測試、數值驗證與 review 過程。所有結果皆為本機實測,非預期值。

## 1. 測試總覽(目前狀態)

| Suite | 指令 | 結果 |
|---|---|---|
| Python golden model | `python3 -m pytest tests/ -q` | **194 passed, 0 failed, 0 skipped**(含 RTL bit-exact 4 項,`yowasp-yosys` 已安裝) |
| TypeScript mirror + 交叉驗證 + smoke | `cd web && npm test`(vitest) | **196 passed / 20 files, 0 failed** |
| TypeScript type check | `npx tsc --noEmit`(strict) | **0 errors** |
| Production build | `cd web && npm run build` | **成功**(chapters lazy-loaded;echarts 為獨立 async chunk)|

vitest 196 項包含:TS acceptance tests、**Python↔TS 交叉驗證**(`vectors.test.ts` 17 項,
涵蓋 16 組 JSON vectors,整數欄完全相等、float ≤1e-12、noise 路徑 ≤1e-9)、committed-vector
byte-identity、25 個 preset smoke tests、25 章 SSR render smoke tests(Ch0–24)、
actuator/gating 行為測試、`redundantDem.test.ts`(13 項,§8)。

實測分檔計數(2026-10-08):

| pytest(194) | | vitest(196) | |
|---|---|---|---|
| `test_redundant_dem.py` | 67 | `presets.smoke.test.ts` | 25 |
| `test_pdr_postprocess.py` | 18 | `render.smoke.test.tsx` | 25 |
| `test_actuator_gating.py` | 12 | `vectors.test.ts` | 17 |
| `test_mode_d_identity.py` | 10 | `redundantDem.test.ts` | 13 |
| `test_sweep.py` | 10 | `ExampleProblem.test.tsx` | 11 |
| `test_qnc.py` / `test_quantizers.py` | 9 / 9 | `sweep.test.ts` | 10 |
| `test_dynamics.py` / `test_loop.py` / `test_measurements.py` / `test_phase_math.py` | 7 / 7 / 7 / 7 | `format.test.ts` / `modeDIdentity.test.ts` / `quantizers.test.ts` | 9 / 9 / 9 |
| `test_mismatch.py` / `test_vectors_repro.py` | 6 / 6 | `actuatorGating.test.ts` / `globalParams.test.ts` | 8 / 8 |
| `test_units_constants.py` | 5 | `qnc.test.ts` | 8 |
| `test_latency.py` / `test_prng.py` / `test_rtl_bitexact.py` | 4 / 4 / 4 | `dynamics` / `loop` / `measurements` | 7 / 7 / 7 |
| `test_vectors_committed.py` | 2 | `mismatch` / `unitsConstants` | 6 / 5 |
| | | `experiments` / `latency` / `prng` | 4 / 4 / 4 |

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
dsm_only 不變量、gating 行為、exp21/exp22 一致性、committed-vector byte-identity,
以及 §19 Test 17–20(gating、qnc、PLL loop co-sim、redundant_random DEM;Test 20 見本報告 §8)。
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
   `model/veriloga/validation/` 的 Spectre validation kit 同為 UNRUN,且 OpenVAF/OSDI 無法
   編譯這些 `.va`(§11)。
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

## 8. Redundancy DEM(`inj_mapping='redundant_random'`)與 exp24

MODEL_SPEC §8 mapping 4 / §12 stream offset 11(`map_inj`)/ §19 Test 20。Python
(`tests/test_redundant_dem.py`,67 項)與 TS(`redundantDem.test.ts`,13 項)同步,新增
vector `n3p222_redundant_random`(schema-v5;既有 15 組 vectors byte-identical,現共
**16 JSON + 16 CSV**)。

結構性質(測試釘死):ideal analog 下 `u_INJ_digital`、`e_ZC_hw` 與所有 digital columns 與
naive **逐位相同**(任意 `map_rand_p`、所有 arch mode、qnc);`map_rand_p=0` 逐位 = naive;
`map_rand_p=1` 恆走 `(j0−1 mod 8, c0+32)`;每拍恰消耗一個 `map_inj` draw(p=0/1 亦然),其他
stream 不動;seed 12345、p=0.5、N=3.13 時 266/512 拍選 alternative。

exp24 實測(N=3.22265625、`α·G=57` on-grid → 量化誤差 ≡ 0;固定 1.00° rms tap mismatch;
`dtc_inj_gain=1.01`;2048 拍;seed 12345;`T_vco`=77.576 ps;`e_ZC_hw` 為純 mismatch 誤差;
本次以 `python3` 重跑):

| mapping | rms / peak (fs) | spurs | 最強 spur | median floor |
|---|---|---|---|---|
| (a) naive | 223.8 / 365.5 | 127 | −101.2 dB @437.5 MHz | 無(數值零) |
| (b) redundant_random p=0.5(1084/2048 拍走 alternative) | **246.1 / 462.4** | 2 | −111.0 dB @890.625 MHz(α·f_ref 基頻,未被降低:naive −111.1 dB) | −129.9 dB(spur-to-floor 18.9 dB) |
| (c) calibrated | 60.3 / 124.0 | 127 | −116.3 dB(−15.0 dB vs naive) | 無(仍週期) |

結論(EXPERIMENT):DEM 把 437.5 MHz 的相鄰-tap 交替 spur 打散(−25.1 dB,低於偵測門檻),
但代價是出現 noise-like floor,且 **rms 反升 10%**、peak 上升;error 被重新分配而非移除。
要真正縮小 rms 與最強 spur 需 calibrated(但前提是量得 mismatch)。網站 Ch7 互動重現、Ch17 exp24 卡片。

## 9. Digital scheduler RTL(`rtl/`)bit-exact 驗證

`rtl/frac_phase_scheduler.sv`(+ `fps_quantizer.sv`、`fps_decode.sv`)對 Python golden model
的 pip-only 驗證流程(`yowasp-yosys` → CXXRTL → 系統 C++ compiler);細節見 `RTL_USAGE.md` §6。
本次重跑 `python3 rtl/run_sim.py`:

- `SUMMARY: 50/50 cases PASS, 0 FAIL, 204634 cycles compared bit-exact (1637072 signal values), 4.8 s`
  (5 個 N × 3 quantizer × LAT∈{0,1,3} = 45 例 + LAT=8 ×2 + F=16 ×2 + F=32 ×1;每例兩個 pass:
  連續 `en`,以及中途 re-reset + 稀疏 `en`)。
- `python3 rtl/gen_vectors.py --check`:`50 cases checked: OK`(committed `rtl/vectors/` 與
  golden model 現場重新產生者逐位相同)。
- `pytest tests/test_rtl_bitexact.py`:4 passed,含「注入一個錯值後 runner 必須報
  `FAIL … pass 0 cycle 777 signal c_fb`」的非空洞性檢查。**CI** 的 pip 行已加入
  `yowasp-yosys`,因此該測試在 CI 實際執行而非 skip。
- Synthesizability(yosys generic `synth -flatten; check -assert`,technology independent,
  **無 timing 資訊**):cells 577 / 837 / 1240、flops 88 / 125 / 199(= 88 + 37·LAT)、
  latches 0(LAT = 0 / 1 / 3)。
- 敏感度檢查(手動、未 commit,RTL_USAGE.md §6):nearest offset 由 `2^(F−1)` 改為 `2^(F−2)` →
  14 個 off-grid nearest case 在第一個 rounding cycle FAIL。

範圍限制(RTL_USAGE.md §9):reference RTL,單一時脈域、無 CDC / DFT / timing closure;只有
nearest / floor / ef1(無 MASH、dither、`dsm_only`、`qnc`);只有 Mode D 與 naive injection
decode;僅 yosys CXXRTL 語意驗證(未跑 iverilog / Verilator / 商用 simulator)。網站 Ch24。

## 10. PDR 萃取 kit:synthetic round trip(`extraction/`)

`PDR_EXTRACTION.md`。**Spectre 端為 TEMPLATE, NOT RUN**:`extraction/spectre_pdr_tb.scs` 與
`run_sweep.py` 產生的 Spectre 指令 / 網表從未被 Spectre parse 過;從未處理過真實電路輸出。
實際驗證過的是 Python 部分,**只用 synthetic 資料**:

- `tests/test_pdr_postprocess.py`:18 passed(synthetic round trip、sign mapping、
  `simulate(inj_model='lut')` lock、driver)。
- 本次重跑 `run_sweep.py --synthetic` → `postprocess_pdr.py`(truth `Δθ = −0.3(sin e + 0.3 sin 2e)`,
  128 個 `φ` 步、10 fs rms timing noise、seed 20261005、64 點 LUT):產生的 LUT 與 committed
  `examples/pdr_example_asymmetric.csv` **逐位相同(max |Δ| = 0)**;quality report:
  `K_inj`(e=0)0.479055(truth 0.48,−0.20%)、`K1` 0.299713(truth 0.3,−0.10%)、
  `max|kick|` 0.339669 rad(truth 0.340949)、noise 估計 1.128e-3 rad(預期 1.111e-3)、
  static lock range [−216.2, +216.0] MHz(`−K1·sin` 只給 ±190.99 MHz)。
- 結論限於 post-processing 管線:它能由已知 PDR 還原 LUT,且 sign convention 與 §14 一致。
  它**不**證明 testbench 網表可用,也不證明 single-kick PRC 能代表每拍 injection `[APPROX]`
  (PDR_EXTRACTION.md §6 pitfall 1)。`examples/pdr_example_asymmetric.csv` 是 synthetic,
  不是量測或電路模擬結果。網站 Ch13 圖 #21b。

## 11. Spectre validation kit(`model/veriloga/validation/`):UNRUN 與 OpenVAF 限制

**狀態:UNRUN。**四個 Spectre testbench、Ocean export script、`run_all.sh` 從未被 Spectre /
Ocean 執行(開發環境沒有能編譯 Verilog-A 的 simulator);第一次實跑預期需要修 netlist 或 `.va`。
實際跑過的只有 simulator-free 部分(本次重跑):

- `python3 model/veriloga/validation/check_results.py --self-test` → `SELF-TEST PASS`
  (含 lint,以及每個 bench 的 emulator_exact、matching+noise PASS 與刻意 corrupt 案例 FAIL;
  `va_emulator.py` 顯示 `.va` 算術「如寫」重現 committed vectors:scheduler code 誤差 0 LSB、
  injection 與 golden recursion 差 4.3e-12 rad)。
- `gen_stimulus.py --all --verify`(PWL 與 trigger 時序自檢)與以 stub `spectre`/`ocean` 驗證
  `run_all.sh` 的 shell plumbing 與結束碼(README 記載之輸出)。
- kit 回報、**未修正**的 `.va` 疑點:`pulsed_injection_phase_model.va` 的 `theta_c` wrap 在
  約 2000 拍後造成 `vco_out` 波形 glitch;`dtc_nonideal_model.va` 的下降緣沿用 `transition()`
  延遲、在 t_d ~90 ps > pulse width 時可能遺失或縮短輸出脈衝;
  `n3p125_dtc_gain_1pct` 因 `c_INJ ≡ 0` 無法偵測 DTC gain error。

**OpenVAF 限制 `[INFERENCE]`:**開源 OSDI 流程(OpenVAF 編譯、ngspice 或 Xyce 載入)只支援
Verilog-A 的 compact-model 子集 —— 沒有 analog event(`@(cross)`、`@(timer)`)、沒有
`transition()`、`idtmod()` 等 analog operator。四個 `.va` 全部建立在這些 constructs 上,
所以無法被 OpenVAF 編譯;改寫成 `@(timer)` 迴圈也不能繞過。這是依該子集的文件範圍所做的判斷,
本 checkout 沒有安裝 OpenVAF / ngspice / Xyce,**未實際嘗試編譯**。驗證需要完整的 Verilog-A
simulator(Spectre 含 APS/X、Siemens AFS、Xcelium AMS)。kit 的 PASS 準則:scheduler codes 完全
相等(且電壓離整數 ≤ 0.25 LSB)、DTC delay ≤ 10 fs、injection debug 量 ≤ 5e-4 rad;
不涵蓋 noise/jitter、真實 PDR、MASH/dither/dsm_only/qnc、閉迴路 chain 與長時間(> 2000 拍)執行。
網站 Ch19 對應段落。
