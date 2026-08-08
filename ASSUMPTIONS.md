# ASSUMPTIONS.md

本專案在硬體細節未完全定義處採用的預設假設。
每一項都是**可調參數**,不是已知的電路事實。網站對應章節亦標示相同內容。

## 系統層

| # | 假設 | 預設值 | 可調位置 |
|---|---|---|---|
| A1 | reference 為理想 4 GHz 方波,只用上升緣 | f_ref=4 GHz | config `f_ref` |
| A2 | VCO 為 8-phase ring/multi-phase oscillator,tap nominal 間距 45° | N_TAP=8 | config `n_tap` |
| A3 | feedback PMUX 為 4-phase,間距 T_vco/4 | N_PMUX=4 | config `n_pmux` |
| A4 | 每個 reference cycle 恰好一次 injection | 1 pulse/T_ref | `injection_enabled` |
| A5 | 期望 zero-crossing 相位 z0 可校正,預設 0 | z0=0 | config `z0_cycles` |
| A6 | modular reverse 的 digital offset R_zero 預設 0 | R_zero=0 | config `r_zero` |

## Timing / digital 層

| # | 假設 | 預設值 |
|---|---|---|
| B1 | DTC 覆蓋範圍恰為 T_vco/4(normalized mode) | 64 LSB |
| B2 | fixed-time DTC 的 LSB 取 12.5 GHz 時的 312.5 fs | `dtc_lsb_fs=312.5` |
| B3 | digital latency 為整數個 reference cycles | L∈{0..8} |
| B4 | scheduler 運算本身無誤差(exact digital model) | — |
| B5 | quantizer 預設 nearest(half-up),DSM 為選項 | `quantizer='nearest'` |

## Analog nonideality 層(全部 behavioral)

| # | 假設 | 預設值 |
|---|---|---|
| C1 | tap mismatch 為 static per-tap offset(LUT) | 0 |
| C2 | DTC INL 用 sinusoidal / polynomial / LUT 近似 | 0 |
| C3 | DNL 為 frozen per-code random step(固定 seed) | 0 |
| C4 | reference jitter 為 white Gaussian | σ=0 |
| C5 | VCO noise = white phase step + random walk | σ=0 |
| C6 | route skew 為 static delay | 0 |

## Injection dynamics 層(全部 approximation)

| # | 假設 | 說明 |
|---|---|---|
| D1 | injection 效果以離散 per-cycle phase map 近似 | 非 continuous-time ILO 模型 |
| D2 | linear map:Δθ=−K·e;sinusoidal map:Δθ=−K·sin(e) | K_inj 為 lumped 強度參數 |
| D3 | K_inj 與 pulse width/強度的關係為 lumped 參數,未由電晶體萃取 | `K_inj∈[0,1]` |
| D4 | PDR/PRC LUT 可由使用者以 CSV 匯入取代 sinusoidal map | 兩欄 CSV |
| D5 | shorting energy 為 sin² normalized proxy,非真實功率 | — |

## 明確不假裝知道的事

- 真實 VCO 的 PDR/PRC 形狀(需 transistor-level 萃取)
- injection pulse 對 VCO amplitude 的影響(本 model 只處理 phase)
- DTC 實體電路的 supply/temperature 敏感度
- 任何 Spectre / silicon 驗證結果(本專案未執行)
