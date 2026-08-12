# Fractional-N PLL Reverse Edge Injection Behavioral Model

[![CI](https://github.com/gmcycle7/ILO_fractional_N_PLL/actions/workflows/ci.yml/badge.svg)](https://github.com/gmcycle7/ILO_fractional_N_PLL/actions/workflows/ci.yml)

一個工程等級、可執行、可驗證、可互動學習的 behavioral modeling 專案,研究
**fractional-N PLL 中 reverse edge injection 的排程、量化與注入動力學**:

- Reference 4 GHz,`N = 3 + α`(α ∈ [0, 0.25]),VCO 12–13 GHz
- Feedback:/3-/4 multi-modulus → 4-phase PMUX → 6-bit DTC
- Injection:8 個 VCO taps(45° 間距)→ 6-bit DTC → narrow pulse → VCO node
- 核心問題:off-grid N 時,每一拍的 injection timing 從哪裡來?
  DSM 該拉哪個 state?sub-LSB error 對 VCO 究竟意味著什麼?

## 專案目標

1. 建立 **exact digital timing model**(Python golden + TypeScript mirror,逐位交叉驗證)
2. 比較四種架構:independent quantization / independent DSMs /
   shared accumulator state / **quantize once + modular reverse(推薦)**
3. 量化 sub-LSB rounding、phase DSM、latency、tap mismatch、DTC gain/INL 的影響
4. 以離散 phase map 近似 VCO injection dynamics(ideal / linear / sinusoidal / PDR LUT)
5. 產出 simulator-friendly **Verilog-A models** 與 CSV command vectors
6. 以互動式教學網站(繁體中文)完整呈現推導、數值例與模擬

## 目錄結構

```
MODEL_SPEC.md          ← 全專案數學契約(單一真相來源)
ASSUMPTIONS.md         ← 所有 modeling 假設(皆為可調參數)
CHAPTER_GUIDE.md       ← 網站章節內容契約
VALIDATION_REPORT.md   ← 測試與數值驗證報告
VERILOGA_USAGE.md      ← Verilog-A 使用指南
model/python/          ← Python golden model(units/phase_math/config/schedulers/
                          quantizers/DTC/tap/latency/dynamics/measurements/
                          experiments/cli)
model/veriloga/        ← 4 個 Verilog-A behavioral models(未經 Spectre 驗證)
web/                   ← React + TypeScript + Vite 互動教學網站
web/src/model/         ← TypeScript mirror model(與 Python 逐位交叉驗證)
tests/                 ← pytest(acceptance tests)
test_vectors/          ← deterministic JSON vectors + csv/(Verilog-A 用 command CSV)
results/               ← CLI 輸出(summary.json / timeseries.csv / psd.csv)
examples/              ← Python API 範例腳本
```

## 安裝

需求:Python ≥ 3.10(含 numpy、pytest)、Node ≥ 18。

```bash
# Python 側(僅 numpy / pytest)
pip install numpy pytest

# 網站
cd web
npm install
```

## 執行 Python behavioral model

```bash
# 列出所有 presets(22 個 experiments + 別名)
python3 -m model.python.cli --list-presets

# 跑推薦架構 preset(N=3.13, quantize-once + modular reverse, look-ahead)
python3 -m model.python.cli --preset n3p13_shared_reverse

# 重新產生 deterministic test vectors(JSON + Verilog-A 用 CSV)
python3 -m model.python.cli --emit-vectors test_vectors
```

輸出寫入 `results/<preset>/`(summary.json、timeseries.csv、psd.csv)。

Python API 範例:

```bash
python3 examples/ex1_basic_run.py
python3 examples/ex2_compare_modes.py
python3 examples/ex3_injection_dynamics.py
```

## 執行測試

```bash
# Python golden model acceptance tests
pytest

# TypeScript mirror model tests + Python↔TS 交叉驗證 + smoke tests
cd web && npm test
```

## CI

`.github/workflows/ci.yml` 在 push 到 `main` 與每個 pull request 上自動執行:

- **test**:`pytest tests/`(Python golden model)、`web/` 下的
  `npm ci` → `tsc --noEmit` → `npm test` → `npm run build`,並上傳
  `web/dist` 為 build artifact。
- **deploy**(僅 push 到 `main` 時,需 `test` 先通過):下載
  `web/dist`、補上 `.nojekyll`,再用 `peaceiris/actions-gh-pages`
  發布到 `gh-pages` branch。

因此 push 到 `main` 會自動部署網站到 GitHub Pages,**不再需要手動執行
`npx gh-pages`**。

## 啟動網站

```bash
cd web
npm run dev      # 開發模式(http://localhost:5173)
npm run build    # production build(輸出 web/dist/)
npm run preview  # 預覽 production build
```

網站 23 章(0–22):從 timing/sign convention、ideal fractional trajectory、
feedback decode、reverse injection 幾何、tap/DTC redundancy、shared phase state、
DSM state 議題、sub-LSB、latency look-ahead、injection dynamics、mismatch、
spur/PN 分析、22 個一鍵 comparison experiments 與 design conclusions,到
PD-input 誤差逐級解析與 DSM 殘餘誤差的失鎖邊界分析。
所有模擬直接在 browser 端執行(TypeScript mirror model),不依賴任何 server。

TopBar 的全站 `N` 控制提供 13 個 preset,分成三組(完整表格見
`MODEL_SPEC.md` §1.1;`P` = DTC grid 上量化誤差序列的週期,
spur 間距 = `f_ref / P`):

- **基本**(5 個按鈕):`3.0, 3.125, 3.13, 3.1375, 3.25`
- **sub-LSB 階梯**:`3.126953125`(`alpha*G=32.5` 半 LSB tie,P=2 → 2 GHz Nyquist tone)、
  `3.1259765625`(0.25 LSB,P=4 → 1 GHz)、`3.125390625`(0.1 LSB,P=10 → 400 MHz)、
  `3.1250390625`(0.01 LSB,P=100 → 40 MHz close-in spur)
- **特殊**:`3.2`(integer/PMUX/DTC 三層 grid 的 P 都是 5 → 800 MHz)、
  `3.22265625`(12.890625 GHz = 25.78125 Gbps / 2,`alpha*G=57` on-grid)、
  `3.001`(near-integer,DSM `n_int=2` regime,P=125 → 32 MHz)、
  `3.1545084971874737`(`alpha = 0.25/phi`,quasi-periodic、無離散 spur)

## 輸出檔案

| 位置 | 內容 |
|---|---|
| `test_vectors/*.json` | 14 組 deterministic vectors(Python 產生,TS 逐位比對)|
| `test_vectors/csv/*.csv` | 每-cycle command vectors(k, n_int, m_FB, c_FB, j_INJ, c_INJ, …)|
| `results/<preset>/` | summary.json / timeseries.csv / psd.csv |
| `web/dist/` | 網站 production build |

## Model limitations(誠實聲明)

- Scheduler equations 是 **exact digital timing model**;
  DTC/tap mismatch 是 **behavioral nonideality model**。
- Sinusoidal / linear injection map 是 **approximation**;
  真實 phase response curve(PDR/PRC)須由 transistor-level
  transient/PSS 萃取,可用 CSV LUT 匯入本 model。
- Shorting energy 為 **normalized proxy**(sin²),非真實功率。
- 本專案**未執行 Spectre**;Verilog-A models 為 simulator-friendly source,
  未經模擬器驗證(詳見 `VERILOGA_USAGE.md`)。
- Behavioral 結果**不等同** silicon 結果。完整清單見 `MODEL_SPEC.md` §20 與網站 Ch20。

## 授權與引用

內部研究/教學用 behavioral model。公式與慣例以 `MODEL_SPEC.md` 為準;
發現 Python/TS/Verilog-A 與 spec 不一致時,以 spec 為準並視為 bug 回報。
