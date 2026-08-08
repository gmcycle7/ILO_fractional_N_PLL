# MODEL_SPEC.md — Fractional-N PLL Reverse Edge Injection Behavioral Model

本文件是整個專案的**單一數學契約 (single source of truth)**。
Python golden model、TypeScript browser model、Verilog-A model 與網站上的所有推導**必須**與本文件一致。
任何實作差異視為 bug。

每一條敘述都標記其性質:

- `[EXACT]` — exact digital/timing identity,可被測試逐位驗證
- `[ASSUMPTION]` — modeling assumption(合理預設,非已驗證的電路事實)
- `[APPROX]` — approximation(如 linearized / sinusoidal injection map)
- `[EXPERIMENT]` — numerical experiment 的觀察
- `[INFERENCE]` — design inference(由模擬支持的設計推論)

---

## 1. 系統參數 (defaults)

| Symbol | Default | 說明 |
|---|---|---|
| `f_ref` | 4 GHz | reference frequency `[ASSUMPTION]` |
| `T_ref` | 250 ps | `1/f_ref` |
| `N` | `3 + alpha` | fractional divide ratio |
| `alpha` | `0 … 0.25` | fractional part |
| `f_vco` | `N * f_ref` | 12–13 GHz |
| `T_vco` | `1/f_vco` | 76.923–83.333 ps |
| `B_DTC` | 6 | feedback 與 injection DTC bits |
| `G` | `4 * 2^B_DTC = 256` | fine phase units per T_vco |
| `N_TAP` | 8 | injection taps (0°,45°,…,315°) |
| `N_PMUX` | 4 | feedback PMUX phases (0, T_vco/4, …) |
| `z0` | 0 cycle | desired injection zero-crossing phase(可校正參數)|
| `R_zero` | 0 | modular reverse 的 digital zero offset code |
| `s0` | 0 | initial absolute phase coordinate |

Preset N 值:`3.000, 3.125, 3.130, 3.1375, 3.250`。

檢查值 `[EXACT]`:

- `N=3.000 → f_vco=12.000 GHz, T_vco=83.333... ps`
- `N=3.125 → f_vco=12.500 GHz, T_vco=80.000 ps`
- `N=3.250 → f_vco=13.000 GHz, T_vco=76.923... ps`

---

## 2. 單位與 wrap conventions `[EXACT]`

內部 phase 單位一律為 **VCO cycles**(float64)。`1 cycle = 2π rad = T_vco 秒 = 360°`。

Helper functions(Python 與 TypeScript 必須逐字元同義實作;**禁止**使用語言內建 `round()`,因 Python 是 banker's rounding、JS 是 half-up,行為不同):

```
wrap01(x)      = x - floor(x)                    # -> [0, 1)
wrapCycles(x)  : y = x - floor(x); if y > 0.5: y -= 1   # -> (-0.5, 0.5]
wrapRadians(t) = 2*pi * wrapCycles(t / (2*pi))   # -> (-pi, pi]
cyclesToTime(x, T_vco)    = x * T_vco
cyclesToDegrees(x)        = 360 * x
cyclesToRadians(x)        = 2*pi*x
timeToCycles(t, T_vco)    = t / T_vco
qNearest(x)    = floor(x + 0.5)                  # half-up, 兩語言一致
qFloor(x)      = floor(x)
```

Sign convention `[EXACT]`:

- phase 增加 = 時間上較晚 (later edge)。
- 所有 error 定義為 `actual − ideal`。
- delay(DTC、route)為**正**的 phase 增量。
- error feedback / kick 的負號寫在公式裡,不藏在變數定義裡。

---

## 3. 理想 fractional phase trajectory `[EXACT]`

第 k 個 reference edge(k = 0,1,2,…)的 VCO absolute phase coordinate(單位 cycles):

```
s_ideal[k] = s0 + k * N
```

fractional phase state:

```
x_ideal[k]   = wrap01(s_ideal[k])
x_ideal[k+1] = wrap01(x_ideal[k] + alpha)      (兩式等價, s0=0 時)
```

- integer part 3:每個 reference period 至少走過 3 個完整 VCO cycles。
- `alpha`:每拍相對 VCO phase grid 的額外 phase rotation。
- off-grid 的 `alpha`(如 0.13)仍給出連續、deterministic 的 trajectory;
  off-grid 不是 phase 不存在,而是 actuator (PMUX+DTC) 無法每拍精確表示它。

例:`N=3.13 → x_ideal = 0, 0.13, 0.26, 0.39, 0.52, 0.65, 0.78, 0.91, 0.04, …`

實作註記:`s_ideal[k] = s0 + k*N` 用乘法(非累加)計算,float64 下兩語言逐位一致。

---

## 4. Feedback path:/3-/4 + 4-phase PMUX + 6-bit DTC `[EXACT]`

high-resolution ideal fine code(單位:1/256 cycle):

```
A_ideal[k] = G * s_ideal[k]          (G = 256, 實數)
```

量化為整數 code(quantizer 見 §6):

```
A_FB[k] = Q_FB(A_ideal[k])           (非負整數)
```

Decode:

```
I_FB[k]  = floor(A_FB[k] / G)        # integer cycle index
R_FB[k]  = A_FB[k] mod G             # in {0..255}
m_FB[k]  = floor(R_FB[k] / 64)       # PMUX code in {0,1,2,3}
c_FB[k]  = R_FB[k] mod 64            # DTC code in {0..63}
```

實際 feedback edge(digital-exact 部分):

```
s_FB_actual[k] = A_FB[k] / G                  (cycles, absolute)
t_FB_actual[k] = s_FB_actual[k] * T_vco       (seconds)
u_FB_digital[k] = R_FB[k] / G                 (fractional, cycles)
```

Integer divider action 由 absolute code 推導:

```
n_integer[k] = I_FB[k+1] - I_FB[k]
```

對 `N ∈ [3, 3.25]` 正常操作,`n_integer[k] ∈ {3, 4}`(nearest/floor quantizer;
DSM quantizer 允許暫態出現 2 或 5,MASH 1-1 理論範圍更寬,測試檢查 `{2,3,4,5}`)。

feedback absolute quantization error:

```
e_FB_abs[k] = wrapCycles(s_FB_actual[k] - s_ideal[k])
```

**Assertions**(pytest / vitest 皆需):

- `A_FB[k+1] > A_FB[k]`(edge monotonic、無 duplicate、無 backward)
- 所有 code 在合法 range
- PMUX wrap 時 `n_integer` 合法
- on-grid case(`alpha*G` 為整數,如 N=3.125)必須 exact:`e_FB_abs ≡ 0`

Analog 層(見 §10):

```
u_FB_analog[k] = pmux_actual(m_FB[k]) + dtc_fb_actual(c_FB[k]) + route_FB
pmux_actual(m) = m/4 + delta_pmux[m]
```

---

## 5. Reverse injection 幾何 `[EXACT]` 與 zero-crossing equation

### 5.1 Zero-crossing condition

第 k 拍 reference edge 到來時,VCO base phase:

```
x_vco_actual[k] = x_nominal[k] + eta_vco[k]
```

- `x_nominal[k]`:deterministic fractional trajectory(= `x_ideal[k]`,或含 deterministic scheduling 後的 nominal)
- `eta_vco[k]`:VCO noise / PLL residual / detuning 造成的 random deviation(cycles)

第 j 個 injection tap:

```
phi_tap[j]        = j/8                          (nominal, cycles)
phi_tap_actual[j] = j/8 + delta_tap[j]           (with mismatch)
```

Injection DTC delay:`tau_INJ[k]`,normalized `d_INJ[k] = tau_INJ[k]/T_vco`。

實際 zero-crossing alignment error:

```
e_ZC[k] = wrapCycles( x_vco_actual[k] + phi_tap_actual[j[k]] + d_INJ[k] - z0 )
theta_ZC[k] = 2*pi * e_ZC[k]
```

### 5.2 理想 scheduler 條件與 reverse 的物理來源

deterministic scheduler 應滿足:

```
phi_tap[j[k]] + d_INJ_ideal[k] = wrap01( z0 - x_nominal[k] )
```

因此 injection 的理想 normalized command:

```
u_INJ_ideal[k] = wrap01( z0 - x_nominal[k] )
z0 = 0 時:u_INJ_ideal[k] = wrap01( -x_nominal[k] )
```

**這就是 reverse injection 的來源**:VCO 相對 reference 每拍多轉 `+alpha`,
要讓 injection pulse 落在固定的 VCO zero crossing,pulse 相對 reference 每拍要**倒轉** `−alpha`。

### 5.3 必須嚴格區分的誤差種類

1. deterministic fractional phase(DSM/accumulator **可**預測)
2. VCO random phase noise(**不可**預測 — 這正是 injection 要修正的對象)
3. scheduler quantization error
4. injection tap mismatch
5. DTC error(gain/offset/INL/DNL)
6. reference jitter
7. digital latency error

---

## 6. Final phase quantizer `[EXACT]`

輸入:實數 fine code `u`(單位 LSB = 1/256 cycle)。輸出:整數 code。
所有 mode 對 Python/TS 逐位一致(容許 |diff| ≤ 1e-12 的浮點誤差,整數輸出必須完全相等)。

1. `floor`: `y = floor(u)`
2. `nearest`: `y = floor(u + 0.5)`
3. `truncate`: 對非負輸入與 floor 相同(單獨列出以對應規格)
4. `ef1` — first-order error-feedback DSM:
   ```
   state e (init 0)
   v = u + e
   y = floor(v)
   e = v - y        # e ∈ [0,1)
   ```
5. `mash11` — MASH 1-1 phase quantizer:
   ```
   M = floor(u); f = u - M
   acc1 += f;    c1 = floor(acc1); acc1 -= c1
   acc2 += acc1; c2 = floor(acc2); acc2 -= c2
   y = M + c1 + (c2 - c2_prev);  c2_prev = c2
   ```
   (acc1, acc2, c2_prev init 0)
6. optional triangular dither:`u' = u + d_amp * (U1 + U2 - 1)`,U 來自 §12 PRNG,
   在 quantize 前加入,預設 off。

**0.3 LSB canonical example** `[EXACT]`(Test 4):
`u[k] = m[k] + 0.3` 時:

- `nearest` → 每拍 error 固定 `−0.3 LSB`
- `ef1` → error sequence `−0.3, −0.3, −0.3, +0.7, −0.3, …`(pattern 0,0,0,1 循環),
  長期平均 → 0,但 peak instantaneous |error| 由 0.3 增為 0.7 LSB。

---

## 7. 四種架構 mode `[EXACT]`

Feedback 一律 `A_FB = Q_FB(A_ideal)`。差別在 injection code 如何產生:

- **Mode A — independent ideal-target quantization**:
  `R_INJ[k] = Q_INJ(G * u_INJ_ideal[k]) mod G`,Q_INJ 與 Q_FB 同型但**獨立 instance**(獨立 error state)。
- **Mode B — independent DSMs**:同 A 但兩邊都用 DSM 型 quantizer、不同 state/seed。
  平均正確,cycle-by-cycle reverse 關係錯誤 → 標記「不建議」。
- **Mode C — shared high-resolution phase state**:兩邊共用 master accumulator 值
  `P[k] = A_ideal[k]`(以及由它導出的 `u_INJ_ideal`),但**各自 quantize**。
- **Mode D — quantize once + modular reverse(預設推薦)**:
  ```
  R_INJ[k] = (R_zero - R_FB[k]) mod 256
  R_zero = 0 時:R_INJ[k] = (-R_FB[k]) mod 256
  ```
  Identity `[EXACT]`:`(R_FB[k] + R_INJ[k]) mod 256 = R_zero`,
  故 ideal digital mapping 下 `e_pair_digital[k] = 0`(所有 k、所有 quantizer mode)。

Pairwise reverse error(digital 或 analog 層皆用同式):

```
e_pair[k] = wrapCycles( u_FB_actual[k] + u_INJ_actual[k] - u_zero_offset )
u_zero_offset = R_zero / G
```

Shared final code 消除的是 **feedback/injection 的數位相對 mismatch**;
**不能**消除:absolute quantization error、DTC analog gain/INL、tap mismatch、
route mismatch、latency error、VCO random noise。

---

## 8. Injection tap + DTC decode 與 redundancy `[EXACT]`

Tap spacing = 1/8 cycle = 32 LSB。Injection DTC codes `0..63` 覆蓋 1/4 cycle = 64 LSB。
→ 同一 target 可由 `(j, c)` 或 `(j-1 mod 8, c+32)` 表示(redundant representation)。

三種 mapping(輸入 digital code `R_INJ` 或 real target `u_target`):

1. **naive floor**:`j = floor(R_INJ/32)`, `c = R_INJ mod 32`(只用 DTC 下半 range)
2. **nearest phase**:argmin over `j∈{0..7}, c∈{0..63}` of
   `|wrapCycles(u_target - (j/8 + c/256))|`(ideal 參數;tie-break:較小 c 優先,其次較小 j)
3. **calibrated joint optimization**:
   ```
   (j*, c*) = argmin over j,c of
     | wrapCycles( u_target - ( tap_actual[j] + DTC_actual(c) + route_INJ ) ) |
   ```
   `DTC_actual` 含 gain/offset/INL、normalized 或 fixed-time LSB(§10、§11)。
   integer-cycle offset `l` 已由 `wrapCycles` 隱含處理。tie-break 同上。

`u_INJ_digital[k] = (32*j + c)/256 mod 1`(naive 時 = `R_INJ/256`)。

---

## 9. Sub-LSB canonical example `[EXACT]`(Test 1, 3)

`N = 3.125, f_vco = 12.5 GHz, T_vco = 80 ps`:

```
1 LSB   = 80 ps / 256   = 312.5 fs
phase LSB = 360/256     = 1.40625°
half-LSB  = 156.25 fs   = 0.703125°
```

`u_FB_ideal = 0.337`:

```
ideal fine code = 86.272 → nearest R_FB = 86
u_FB_actual = 86/256 = 0.3359375
e_FB_abs = -0.0010625 cycle = -85 fs   (× 80 ps)
R_INJ = (0-86) mod 256 = 170
u_INJ_actual = 0.6640625;  ideal = 0.663
e_INJ_abs = +0.0010625 cycle = +85 fs
u_FB_actual + u_INJ_actual = 1.0 → e_pair_digital = 0
```

結論:absolute phase 各差 85 fs,但 pair 數位上 exact reverse。
shared code 不會創造不存在的 sub-LSB analog delay;VCO 追蹤的是 quantized common trajectory。

---

## 10. Analog non-idealities `[ASSUMPTION]`(behavioral models)

全部以 cycles 為單位加在 digital 值之後,各自可獨立 enable/disable:

1. 8-tap mismatch:`delta_tap[j]`(LUT,cycles;預設由「1° 全部」或 per-tap 給定)
2. PMUX mismatch:`delta_pmux[m]`
3. FB DTC gain error `g_FB`:delay = `g_FB * c * LSB_cyc`
4. INJ DTC gain error `g_INJ`
5. DTC offset:`+ off_cyc`
6. sinusoidal INL:`inl_a * sin(2*pi*c/64)`(cycles)
7. polynomial INL:`p2*(c/63)^2 + p3*(c/63)^3`(cycles)
8. user LUT INL:64-entry array(cycles)
9. DNL:per-code random step error(PRNG stream `dnl`,frozen per instance)
10. route skew:`route_FB`, `route_INJ`(cycles)
11. reference jitter:`sigma_ref`(seconds rms,white,PRNG stream `ref`)
12. VCO white phase noise:per-ref-cycle phase step `sigma_vco_w`(rad,stream `vco_w`)
13. VCO random walk:accumulated,`sigma_vco_rw`(rad/√cycle,stream `vco_rw`)
14. fixed digital latency `L`(reference cycles)
15. random command latency(整數 cycles,機率 p_late,stream `lat`)
16. injection pulse timing noise:`sigma_pulse`(seconds,stream `pulse`)

檢查值 `[EXACT]`(Test 6, 7;`T_vco = 80 ps`):

- 1° tap mismatch = `80 ps/360 = 222.22... fs ≈ 0.711 LSB`
- DTC full range = `T_vco/4 = 20 ps`;1% gain mismatch → max `200 fs ≈ 0.64 LSB`
- 兩者都**大於** half-LSB (156.25 fs) `[INFERENCE]`

---

## 11. Normalized vs fixed-time DTC `[EXACT]`

- **normalized**:`Delta_t = T_vco/256`,phase LSB 恆為 `1.40625°`
- **fixed-time**:`Delta_t` 固定(預設 312.5 fs,即 12.5 GHz 時的 normalized 值);
  phase LSB = `360° * Delta_t / T_vco`,隨 f_vco 改變

頻率表 `[EXACT]`:

| N | f_vco | T_vco | normalized LSB |
|---|---|---|---|
| 3.000 | 12.000 GHz | 83.333 ps | 325.521 fs |
| 3.125 | 12.500 GHz | 80.000 ps | 312.500 fs |
| 3.250 | 13.000 GHz | 76.923 ps | 300.481 fs |

---

## 12. Deterministic PRNG `[EXACT]`(Python 與 TS 必須逐位一致)

**mulberry32**(uint32 state;所有運算 mod 2^32;`>>` 為 logical shift):

```
next():
  s = (s + 0x6D2B79F5) mod 2^32
  t = s
  t = ( (t XOR (t >> 15)) * (t OR 1) ) mod 2^32
  t = ( t + ( ( (t XOR (t >> 7)) * (t OR 61) ) mod 2^32 ) ) XOR t   # 再 mod 2^32
  return ( (t XOR (t >> 14)) mod 2^32 ) / 2^32        # -> [0,1)
```

Gaussian(Box-Muller,成對產生、cache 第二個值):

```
u1 = next(); if u1 == 0: u1 = 2^-32
u2 = next()
r  = sqrt(-2*ln(u1))
z0 = r*cos(2*pi*u2);  z1 = r*sin(2*pi*u2)
```

每個 noise source 使用**獨立 named stream**,seed = `base_seed + streamOffset`:
`ref:1, vco_w:2, vco_rw:3, dither_fb:4, dither_inj:5, dnl_fb:6, dnl_inj:7, lat:8, pulse:9`。
預設 `base_seed = 12345`。
跨語言 tolerance:純數位路徑 `1e-12`(整數 code 完全相等);含 noise 路徑 `1e-9`(libm 差異)。

---

## 13. Pipeline latency 與 look-ahead `[EXACT]`

latency `L`:cycle k 計算的 command 於 cycle `k+L` 被 apply。

- **正確(look-ahead)**:apply 於 k+L 的 command 由 `s_ideal[k+L]`(即 state `P[k+L]`)計算。
  理想 accumulator 的 look-ahead:`x[k+L] = wrap01(x[k] + L*alpha)`。
- **錯誤(bug mode)**:apply 於 k+L 的 command 由 `s_ideal[k]` 計算,
  phase error = `wrapCycles(L*alpha)`。

Canonical example `[EXACT]`(Test 5):`alpha=0.13, L=1` → error `= 0.13 cycle = 46.8°`,
遠大於 half-LSB `0.703125°`(66.6 倍)。

每筆 command 附帶 metadata:`{k_computed, k_intended, k_applied, P_state, R_FB, R_INJ, seq_id}`。

---

## 14. VCO injection dynamics(每 reference cycle 一次 injection)

residual phase `theta`(rad;deterministic trajectory 已移除):

```
theta_minus[k] = theta_plus[k-1] + 2*pi*Delta_f*T_ref + w_vco[k]      [ASSUMPTION]
epsilon_hw[k]  = 2*pi * e_ZC_hardware[k]      (deterministic scheduling error)
e_inj[k]       = wrapRadians( theta_minus[k] + epsilon_hw[k] )
```

- `Delta_f`:VCO free-running detuning(Hz,相對 N*f_ref)
- `w_vco[k]`:VCO accumulated noise per ref period(rad,stream vco_w/vco_rw)

三種 injection response:

1. **ideal reset** `[ASSUMPTION]`(理想上限):`theta_plus[k] = theta_minus[k] - e_inj[k]`
   (phase 被拉到 pulse 位置;若 `epsilon_hw≠0`,VCO 停在 `-epsilon_hw`)
2. **linearized** `[APPROX]`:`Delta_theta = -K_inj * e_inj[k]`,`K_inj ∈ [0,1]`
3. **nonlinear sinusoidal** `[APPROX]`:`Delta_theta = -K_inj * sin(e_inj[k])`
   + optional PDR/PRC LUT(CSV import:兩欄 `e_inj_rad, delta_theta_rad`,linear interp,
   超出範圍 clamp 至端點值)

```
theta_plus[k] = wrapRadians( theta_minus[k] + Delta_theta[k] )
```

Sinusoidal map 的 fixed point / lock `[APPROX]`:

```
K_inj * sin(theta_ss) = 2*pi*Delta_f*T_ref
lock condition: |2*pi*Delta_f*T_ref| <= K_inj
local stability: |1 - K_inj*cos(theta_ss)| < 1  → 取 cos(theta_ss) > 0 的解為 stable
```

`K_inj → 0`:無 injection(random walk / detuning ramp);K_inj 增大:更快收斂、更小 residual
(behavioral approximation,**不**宣稱等同 transistor-level shorting)。

---

## 15. Shorting injection zero-crossing error `[APPROX]`

differential waveform:`v_d(t) = V_p * sin(2*pi*(t - t_z)/T_vco)`。
timing error `epsilon_t`:

```
v_d/V_p = sin(2*pi*epsilon_t/T_vco) ≈ 2*pi*epsilon_t/T_vco  (small signal)
E_short_norm = sin^2(2*pi*epsilon_t/T_vco)     (normalized proxy, 非真實 energy)
```

half-LSB check `[EXACT]`:`epsilon_t = T_vco/512` →
`|v_d|/V_p ≈ 2π/512 ≈ 1.227%`,`E ≈ (2π/512)^2 ≈ 1.5e-4`。

Error 性質 → 頻譜後果 `[INFERENCE]`:
固定 error → static phase offset;periodic error → deterministic spur;
noise-like error → phase-noise floor。

---

## 16. Error decomposition `[EXACT]` 的定義

```
e_ZC[k] = e_VCO_noise + e_reference_jitter + e_phase_schedule + e_quantization
        + e_DSM + e_tap_mismatch + e_DTC_gain + e_DTC_INL + e_route + e_latency
```

各項為對 baseline(全 ideal)逐項開啟的 delta(linear regime 下近似可加 `[APPROX]`;
model 需同時輸出 individual contributions 與 jointly-simulated total,並顯示兩者差異)。

三種**不可混淆**的 error:

- `e_abs[k]`:actual − ideal(單邊 absolute)
- `e_pair[k]`:FB + INJ − integer cycle(兩邊相對)
- `e_ZC[k]`:VCO actual phase at pulse − desired zero crossing(最終物理量)

---

## 17. Measurement conventions `[EXACT]`

- per-reference-cycle sequence 的 sample rate = **f_ref**(**不是** f_vco)
- period-P sequence 的 spur:`f_spur,m = (m/P) * f_ref`
- FFT:截為 2 的冪長度;PSD 用 Hann window periodogram(one-sided);
  time sequence、histogram、RMS、peak-to-peak、integrated phase 皆提供
- **dBc convention**:phase sequence `phi[k]`(rad)中幅度 `a` rad 的 tone,
  small-angle 下 SSB spur = `20*log10(a/2)` dBc;
  PSD 曲線標 `10*log10(S_phi/2)` dBc/Hz(`S_phi` 單位 rad²/Hz)。
  未經 carrier normalization 的 phase PSD **不可**直接標 dBc。
- 固定 seed 12345 使 Python 與 browser 結果一致。

---

## 18. Test vectors `[EXACT]`

Python 產生 `test_vectors/*.json`,TS 讀取並比對。Schema:

```json
{
  "name": "...", "generator": "python", "seed": 12345,
  "config": { ...完整參數... },
  "tolerance": { "int": 0, "float_abs": 1e-12, "noise_abs": 1e-9 },
  "columns": ["k", "s_ideal", "A_FB", "R_FB", "m_FB", "c_FB", "n_int",
              "R_INJ", "j_INJ", "c_INJ", "u_FB_digital", "u_INJ_digital",
              "e_FB_abs", "e_pair", "..."],
  "data": [[...], ...]
}
```

必備 vectors(至少;各 512 cycles):

`n3p000_nearest`, `n3p125_nearest`, `n3p130_floor`, `n3p130_nearest`,
`n3p130_ef1_shared`(Mode D + ef1), `n3p130_ef1_independent`(Mode B),
`n3p130_mash11`, `n3p130_latency_bug`(L=1, no look-ahead),
`n3p130_lookahead`(L=1, correct), `n3p125_tap_mismatch_1deg`,
`n3p125_dtc_gain_1pct`, `n3p130_dynamics_sin`(K_inj=0.3, Δf=1 MHz, noise on)。

另產生 `test_vectors/csv/` 每-cycle command CSV(給 Verilog-A testbench):
欄位 `k, t_ref_ns, n_int, m_FB, c_FB, j_INJ, c_INJ, R_FB, R_INJ, seq_id`。

---

## 19. Acceptance tests(對應規格 §25)

| # | 內容 | 期望 |
|---|---|---|
| 1 | N=3.125 常數 | LSB=312.5 fs, phase LSB=1.40625°, half=0.703125° |
| 2 | Mode D identity | `R_INJ=(−R_FB) mod 256`, `e_pair_digital≡0` |
| 3 | u=0.337 例 | R_FB=86, R_INJ=170, ∓85 fs, pair=0 |
| 4 | 0.3 LSB ef1 | mean→0;instantaneous ∈ {−0.3, +0.7} LSB |
| 5 | α=0.13, L=1 bug | 46.8° |
| 6 | 1° tap @80 ps | 222.22 fs |
| 7 | 1% gain @20 ps | 200 fs |
| 8 | N∈[3,3.25] sweep | monotonic edges、合法 codes、n_int 合法 |
| 9 | Python↔TS vectors | 整數全等;float ≤1e-12;noise ≤1e-9 |
| 10 | `npm run build` | 成功 |
| 11 | 所有 presets | 載入無 runtime exception |
| 12 | PSD 軸 | sample rate = f_ref |
| 13 | shared vs independent | pair-error 行為不同(shared≡0, independent≠0)|
| 14 | injection models | K_inj→0 無修正;K_inj↑ residual↓;三種 model 趨勢合理 |

---

## 20. 已知限制(honesty)

- scheduler equations 是 **exact digital timing model**
- DTC/tap mismatch 是 **behavioral nonideality model**
- sinusoidal injection map 是 **approximation**;真實 phase response 需
  transistor-level transient/PSS/PDR extraction
- shorting energy 是 **normalized proxy**
- 本專案**未執行 Spectre**;Verilog-A 提供 source 與 usage guide,未經 simulator 驗證
- behavioral result **不等同** silicon result
