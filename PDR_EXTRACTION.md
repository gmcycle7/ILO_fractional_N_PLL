# PDR_EXTRACTION.md — VCO PDR/PRC 萃取流程(給 MODEL_SPEC §14 `inj_model='lut'`)

> **狀態聲明(先讀)**
>
> - `extraction/spectre_pdr_tb.scs` 以及 `extraction/run_sweep.py` 印出 / 產生的 Spectre
>   指令與網表都是 **TEMPLATE — NOT RUN**:開發環境沒有任何 circuit simulator,
>   網表從未被 Spectre parse 過。primitive 名稱與參數是依 Spectre 手冊的記憶寫成,
>   第一次使用前請逐一以 `spectre -h <name>` 核對(`vsource`、`isource`、`tran`、
>   `relay`、`bsource`、`paramset`、`sweep`、`options`)。
> - `extraction/postprocess_pdr.py` 與 `run_sweep.py` 的 Python 部分(`--dry-run`、
>   `--render`、`--anchor`、`--collect`、`--synthetic`)是真的程式,由
>   `tests/test_pdr_postprocess.py`(18 tests)驗證 — 但**只用 synthetic 資料**驗證過,
>   從未處理過真實的 Spectre 輸出。
> - `examples/pdr_example_asymmetric.csv` 是 **synthetic** LUT(已知 truth + timing
>   noise 經完整 pipeline 產生),**不是**量測或電路模擬結果。
> - 萃取出的 LUT 仍只是 per-pulse discrete phase map(ASSUMPTIONS.md D1)的輸入;
>   「single-kick PRC = 每拍 injection 的 Δθ(e)」本身是 `[APPROX]`(見 §6 pitfall 1)。

---

## 0. 檔案一覽

| 檔案 | 狀態 | 用途 |
|---|---|---|
| `extraction/spectre_pdr_tb.scs` | TEMPLATE, NOT RUN | 單一 pulse transient testbench:VCO + injection switch placeholder、`phi_inj` 參數化 pulse、REF/INJ twin run、精度設定註解 |
| `extraction/run_sweep.py` | Python 真實可跑;Spectre 指令為 template | `--dry-run` 印計畫、`--render` 產生網表 + `run_all.sh` + `plan.json`、`--anchor` 量 pass-0 anchor、`--collect` 波形 → raw CSV、`--synthetic` 由已知 PDR 造 raw CSV |
| `extraction/postprocess_pdr.py` | 真實、已測 | raw CSV → §14 LUT CSV(+ 可選 Verilog-A `$table_model` 表、JSON report)+ quality report |
| `tests/test_pdr_postprocess.py` | 真實、已測 | synthetic round trip、sign mapping、`simulate()` lock、driver 測試 |
| `examples/pdr_example_asymmetric.csv` | synthetic | 64 點 asymmetric LUT,給網站 Ch13 / Python 載入 |

---

## 1. 定義與 sign convention `[EXACT]`(在下列定義之下)

MODEL_SPEC §14 的 residual phase `theta` 是 VCO 的 excess phase:
`theta_minus[k] = theta_plus[k-1] + 2*pi*Delta_f*T_ref + ...`,VCO 比 `N*f_ref` 快
(`Delta_f > 0`)時 `theta` 增加。因此 **`theta > 0` = VCO 領先 = 它的 edges 提早**。

- `e_inj` = pulse 時刻 VCO 的 phase − 目標 zero crossing 的 phase
  (`simulate.py`:「VCO actual phase at pulse − desired zero crossing」)。以時間表示:
  `e_inj = wrapRadians(2*pi*(t_pulse − t_zc)/T_vco)`。**pulse 晚於 zero crossing → `e_inj > 0`**。
- 一個 edge 的時間位移 `dt`(injected − reference,正 = 變晚)對應
  `Delta_theta = −2*pi*dt/T_vco`(edges 變晚 = VCO phase 被拉回)。
- 物理檢查:pulse 晚到(`e > 0`),injection 把振盪器往 pulse 拉 → VCO edges 變晚
  (`dt > 0`)→ `Delta_theta < 0`。在 `e = 0` 斜率為負,與 `Delta_theta = −K*sin(e)` 一致。
- 等效小訊號強度:`K_inj = −dΔθ/de |_(e=0) = d(dt)/d(phi*T_vco) |_(phi=0)`,
  即「一個 pulse 消去的小 timing error 比例」(1 = ideal reset)。

### 1.1 Testbench ↔ MODEL_SPEC §14 對照表

| 量 | testbench 量測 | MODEL_SPEC §14 |
|---|---|---|
| pulse 位置 | `phi_inj = (t_center − t_zc)/T_vco ∈ [0, 1]`(t_center = pulse **中心**) | `e_inj = wrapRadians(2*pi*phi_inj) ∈ (−pi, pi]` |
| pulse 晚於 zero crossing | `0 < phi_inj < 0.5` | `e_inj > 0` |
| pulse 早於下一個 zero crossing | `0.5 < phi_inj < 1` | `e_inj < 0` |
| `phi_inj = 0.5` | 半週期 | `e_inj = +pi`(wrap 範圍為 `(−pi, pi]`) |
| 相位位移 | `dt = t_cross_inj − t_cross_ref`(同一個 late edge) | `delta_theta = wrapRadians(−2*pi*dt/T_vco)` |
| VCO edges 被延後 | `dt > 0` | `delta_theta < 0` |
| 小訊號強度 | `d(dt)/d(phi*T_vco)` at `phi = 0` | `K_inj = −d(delta_theta)/de` at `e = 0` |
| ideal reset | `dt = phi*T_vco`(wrapped) | `delta_theta = −e`(winding −1) |
| VCO detuning | VCO 比 `N*f_ref` 快 | `a = 2*pi*Delta_f*T_ref > 0`;穩態 `a + delta_theta(e*) = 0` |
| zero-crossing 穩定性(`a = 0`) | — | fixed point `delta_theta(e*) = 0`,stable 若 `−2 < slope < 0` |

`postprocess_pdr.py` 的 `raw_to_samples()` 就是這張表的實作;
`test_sign_mapping_late_pulse_pulls_vco_later` 釘死它。

---

## 2. 主要方法:transient single-kick(逐步)

原理:同一份網表跑兩次 — REF(`inj_en=0`,pulse source 存在但 swing 為 0,
breakpoints 與時間格點相同)與 INJ(`inj_en=1`,單一 pulse)。兩者在 pulse 之前逐點相同
(deterministic、transient noise OFF),比較**同一個 late target-type zero crossing**
的時間差即得 `dt`。對 `phi_inj` 掃 0..1(≥ 64 等分,預設 128)得整條 PDR。

### 2.1 準備 DUT

1. 在 `spectre_pdr_tb.scs` section 1 以**絕對路徑** include PDK models、`vco_core`、
   `inj_switch`(`--render` 會把網表複製到各 run 目錄,相對路徑會壞)。
2. 刪除 section 2b 的 flow-debug placeholders(behavioral LC + ideal relay;
   其 PDR 不是你的電路的 PDR)。
3. `inj_switch` 必須是**真的** injection device(含 gate driver、layout parasitics);
   pulse 參數 `pw_inj`(flat-top width)、`tr_inj`、`v_gate_on` 設為設計值
   — PDR 同時依賴寬度與強度。
4. 確認 target crossing 種類(預設 `v(outp)−v(outn)` rising through 0 V)與
   scheduler 實際瞄準的 crossing 相同(MODEL_SPEC `z0_cycles`、所用 tap)。

### 2.2 Pass 0:anchor run

```sh
python3 extraction/run_sweep.py --render runs_pdr --n-phi 128      # placeholders
spectre ... runs_pdr/runs/anchor/netlist.scs                       # 只跑 anchor 那一行
# 匯出 runs_pdr/runs/anchor/vdiff.csv(time_s, v_diff_V;>= 12 位有效數字)
python3 extraction/run_sweep.py --anchor runs_pdr/runs/anchor/vdiff.csv \
        --n-settle 3000 --f-vco 12.5e9
```

`--anchor` 回報 `t_anchor_s`(`n_settle` 個 nominal cycle 後第一個 target crossing)、
`t_vco_s`(anchor 之後 50 個 crossing 的 least-squares period)與 `period_drift_rel`
(兩半窗口的 period 相對差;需 `< 1e-6`,否則加大 `n_settle`)。

### 2.3 Pass 1:twin sweep

```sh
python3 extraction/run_sweep.py --dry-run --n-phi 128 --t-anchor <T_A> --t-vco <T_V>  # 看計畫
python3 extraction/run_sweep.py --render runs_pdr --n-phi 128 --t-anchor <T_A> --t-vco <T_V>
sh runs_pdr/run_all.sh          # 2 x 129 runs(+ anchor 重跑一次,無害)
```

- `--mode paramset`:改為單一 Spectre job,把 analysis 區塊包進 `paramset` sweep
  (語法未驗證);之後需把每個 sweep point 匯出到 `runs/<id>/vdiff.csv`。
- `phi = i/n_phi, i = 0..n_phi`:`phi = 1` 與 `phi = 0` 是同一點,post-processing 會 dedupe。
- 每個 run 只存 `[t_anchor − 4 T, t_stop]` 視窗(`outputstart`)。

### 2.4 匯出與 collect

每個 run 把 `v(outp)−v(outn)` 匯出為兩欄數值 `time_s, v_diff_V`
(Ocean `ocnPrint(... ?precision 15 ...)` 或任何工具;非數值行會被略過)。
`t ≈ 2.4e-7 s` 時 1 fs 解析度需要相對 `4e-9`,即**至少 10 位、建議 15 位有效數字**。

```sh
python3 extraction/run_sweep.py --collect runs_pdr -o raw.csv
```

`--collect` 對每個 `phi`:REF run 取 `t_anchor + (n − 0.5)*t_vco` 之後第一個
target crossing(`n` = `--edges`,預設 100 與 190);INJ run 取**離它最近**的
crossing(自動得到 `|dt| <= T/2`,也避開 pulse 期間的 chatter);crossing 先以
bracketing + linear interpolation 求得,再以 4 點 cubic 修正(synthetic sine、
T/100 抖動取樣下:linear 誤差 0.099 fs,cubic 8.5e-5 fs),並加 5% amplitude
hysteresis。`t_vco_s` 由 REF run 自身 crossings 的 regression 求得。

Raw CSV schema(`postprocess_pdr.py` 的輸入契約):

```
phi_inj_cycles,t_cross_ref_s,t_cross_inj_s,t_vco_s[,edge_idx]
```

### 2.5 Post-process

```sh
python3 extraction/postprocess_pdr.py raw.csv -o pdr_lut.csv \
        [--n-points 64] [--smooth-harmonics 0] [--f-ref-hz 4e9] \
        [--va-table pdr_lut.tbl] [--json report.json]
```

步驟:sign mapping(§1)→ 有 `edge_idx` 時只用最晚的 edge 並做 settling check →
依 `e` 排序、dedupe(含 `±pi` seam,circular mean)、沿 `e` unwrap、決定 winding
(`delta_theta(e+2pi) = delta_theta(e) + 2*pi*winding`;一般 shorting PDR 為 0,
ideal reset 為 −1)→ periodic resample 到 `[−pi, pi]` 均勻格點(**含兩端點**,
model 的 clamp linear interpolation 因此涵蓋整個 `(−pi, pi]`)→ 寫 LUT。
`--smooth-harmonics H` 改用 H 階 least-squares Fourier fit(雜訊大時用;
有尖銳特徵的 PDR 請保持預設 0 = linear)。

Quality report 欄位:

| 欄位 | 意義 |
|---|---|
| `K_inj small-signal` | `−dΔθ/de` at `e = 0`,由 `|e| <= pi/4` 的 local cubic least-squares fit 求得;另列 LUT 在 0 附近那一段的 secant(model 實際看到的斜率) |
| `K1 first harmonic` | `−b1`:最佳 `−K*sin(e)` fit(給 sin map / Verilog-A `inj_map=1` 用) |
| harmonics | `a_n, b_n`(n = 1..5);偶次項 = 相對 `±pi/2` 的 skew |
| `max|kick|` | `max|Δθ|` 與位置,以及 max / min |
| odd-symmetry error | `max|Δθ(e) + Δθ(−e)|`(對稱 differential 電路應只剩 noise) |
| quarter-wave skew | `max|Δθ(e) − Δθ(pi − e)|`(純 sin 為 0) |
| zero crossings | LUT 的根、斜率、`stable`(`−2 < slope < 0`)/ `unstable` / `unstable(flip)` |
| static lock range | stable root 所在、斜率保持在 `(−2, 0)` 的分支上 `a ∈ [−max Δθ, −min Δθ]`,並換算成 `Delta_f`(`--f-ref-hz`) |
| noise | 對 8 階 Fourier fit 的 residual rms(雜訊上界) |
| settling | 兩個 late edge 之間的殘差:4 階 Fourier 擬合的 systematic 部分與相對 gain change |

### 2.6 精度設定(對應 testbench 註解)

| 設定 | 建議 | 理由 |
|---|---|---|
| transient noise | OFF(不設 `noisefmax`/`noiseseed`) | twin run 必須在 pulse 前逐點相同 |
| `method` | `traponly` | gear2 的 numerical damping 會扭曲高 Q tank 的 amplitude restoration(AM→PM 部分) |
| `errpreset` | `conservative`(明確參數會覆蓋 preset) | 較緊的 LTE |
| `maxstep` | `T_vco/200`(`maxstep_div=200`) | 每步 ≤ 1.8°;pulse 邊緣另有 breakpoints |
| `reltol` | `1e-6`(收斂檢查時再緊 10×) | crossing 時間需 sub-fs |
| `cmin` | 0,或 ≪ 0.1% tank capacitance,所有 run 相同 | 會 load tank |
| `n_settle` | ≥ 10× 最慢的 settling time constant(tank `tau_A ~ Q/(pi*f0)`;bias / amplitude-control loop 通常更慢) | anchor 前頻率必須穩定 |
| `n_post`、edges | 預設 200、edges 100 / 190 | AM→PM transient 必須消失;兩個 edge 互相檢查 |
| 匯出精度 | 15 位有效數字 | §2.4 |

收斂檢查:挑 ~5 個 `phi`,以 `maxstep_div=400`、`reltol` 緊 10× 重跑,PDR 變動須
`< 1% max|kick|`。數值 noise floor:`inj_en=1` 但 `v_gate_on = v_gate_off`,
量到的 `|Δθ|` 應 ≪ 1 mrad。

### 2.7 沒有 simulator 時的自我測試(本 repo 已實跑)

```sh
python3 extraction/run_sweep.py --dry-run --n-phi 64
python3 extraction/run_sweep.py --synthetic -o raw.csv       # 已知 asymmetric PDR
python3 extraction/postprocess_pdr.py raw.csv -o lut.csv
python3 -m pytest tests/test_pdr_postprocess.py -q
```

---

## 3. 替代方法:PSS + PXF / ISF-based(附 caveats)

做法 `[INFERENCE]`(Spectre RF 選項名稱未驗證):

1. 對 free-running VCO 跑 autonomous PSS(指定 oscillator node)。
2. 在 injection node 放一個小 current source,以 PXF(或 PNoise 的 ISF/PPV 輸出)
   求從該電流到輸出 phase 的週期性轉移,得 ISF `Gamma(x)`(`x` = 振盪器相位)。
3. 小電荷 `Δq` 的 kick:`Δφ = Gamma(x) * Δq / q_max`(Hajimiri 慣例,
   `V = A*cos(w0*t + φ)`)。`Δφ > 0` = 相位超前 = edges 提早 = 與 §14 的 `theta` **同號**;
   橫軸換算 `e = x − x_zc`,`x_zc` = target crossing 在 ISF 相位原點下的位置
   (`cos` 波形的 rising zero crossing 在 `x = −pi/2`)。
   因此 `delta_theta(e) ≈ Gamma(x_zc + e) * Δq/q_max`。

Caveats:

- **只對小訊號、線性(電荷注入型)injection 成立。** shorting switch 是大訊號、
  parametric 的(它改變 tank 阻抗、把差動電壓拉向 0),kick 對強度不是線性、會飽和
  (極限是 reset,`|Δθ| → |e|`);ISF 預測 kick ∝ `Δq`,當 `K_inj ≳ 0.1` 時可能嚴重失準
  `[INFERENCE]`。
- ISF 是 PSS 軌道上的 linear response,不含 pulse 期間 amplitude 大幅偏離軌道的效應,
  也不給 pulse-width 依賴性(除線性比例外)。
- PXF / PPV 的正負號與 normalization 依工具與版本而異;一律以 3–5 個 transient kick
  (§2)交叉驗證斜率與形狀後才可使用。
- 適用:快速取得 PDR 形狀、交叉檢查小訊號 `K_inj`、弱 injection 設計。

---

## 4. Sanity checklist

- [ ] 每對 REF/INJ 的 anchor crossing 與 pass 0 相同到 `< 1 fs`(twin run 確實相同)。
- [ ] `--anchor` 的 `period_drift_rel < 1e-6`。
- [ ] 零強度 kick(`v_gate_on = v_gate_off`、`inj_en=1`):`|Δθ| ≪ 1 mrad`(數值 floor)。
- [ ] 收斂:`maxstep_div=400`、`reltol` 緊 10× → PDR 變動 `< 1% max|kick|`。
- [ ] settling:report 的 systematic settling residual `< 1% max|kick|`(否則有 WARNING)。
- [ ] coverage:≥ 64 等分、max gap `≤ 2*pi/64`。
- [ ] `e = 0` 斜率為負,`0 < K_inj < 2`(map 在 `e = 0` 為 stable);shorting 典型 `K_inj ≤ 1`。
- [ ] stable zero crossing 在 `e ≈ 0`;若有 offset 而確認為物理效應,**保留**
      (等效 static timing offset;不要 re-center LUT)。
- [ ] odd-symmetry error 對對稱差動電路應只剩 noise;大 → 檢查 anchor crossing 種類、
      pulse 中心定義、switch / layout 不對稱。
- [ ] winding 應為 0;−1 表示 reset-like(`|kick|` 到 `pi`)。
- [ ] Python model 用此 LUT 在小 detuning 可 lock(§5.1 範例),lock range 涵蓋
      預期的 VCO detuning spread。
- [ ] 在 supply / temperature / process corners 重複(§6 pitfall 5)。

---

## 5. 匯入 LUT

### 5.1 Python golden model

```python
from extraction.postprocess_pdr import load_lut_csv
from model.python.config import SimConfig
from model.python.simulate import simulate

lut = load_lut_csv("examples/pdr_example_asymmetric.csv")   # [[e_inj_rad, delta_theta_rad], ...]
cfg = SimConfig(n_div=3.125, inj_model="lut", pdr_lut=lut, delta_f_hz=1e6)
res = simulate(cfg)                     # k_inj is ignored when inj_model == 'lut'
print(res.data["e_inj"][-1])            # steady state = LUT fixed point
```

`load_lut_csv` 採與網站 Ch13 相同的解析規則(`#` 與空行略過、以 `[,;\s]+` 分欄、
非數值行(如 header)略過、至少 2 點)。model 端(`injection_dynamics.py`)會排序、
linear interpolation、超出端點 clamp(MODEL_SPEC §14);本 kit 的格點含 `±pi`
兩端點,所以不會發生 clamp。

### 5.2 網站(Ch13 `#/vco-injection-dynamics`)

圖 #21 下方「**PDR/PRC LUT CSV 匯入**」:用檔案按鈕選 `pdr_lut.csv`(或貼到文字框後按
「解析文字框」)。格式即 `postprocess_pdr.py` 的輸出(`#` 註解、header 行會被略過、
分隔字元可為 `,` `;` 或空白)。載入成功後 model 自動切到 `lut`,LUT 以點列畫在
PRC 圖上。`examples/pdr_example_asymmetric.csv` 可直接載入(synthetic 示例)。

### 5.3 Verilog-A(`model/veriloga/pulsed_injection_phase_model.va`,未經 Spectre 驗證)

該 module 只有 `inj_map = 0/1/2`(linear / sinusoidal / reset);PDR LUT 目前是
**Python-only**(VERILOGA_USAGE.md)。選項:

1. `inj_map=1`,`k_inj = K1`(report 的 first-harmonic fit):保留大訊號 lock range 的
   一階近似,失去不對稱;或 `inj_map=0`,`k_inj = K_inj small-signal`:只適用於
   `|e_inj|` 很小的 locked 區域。兩者差異見 §7(K1 = 0.2997 vs small-signal 0.4791)。
2. 使用者自行修改(**不在 repo 內、NOT RUN**):以 `--va-table pdr_lut.tbl` 產生空白分隔表,
   在 module 中把 Δθ 的計算換成

   ```verilog
   dtheta = $table_model(e_inj, "pdr_lut.tbl", "1CC");  // linear interp, clamp both ends
   ```

   `"1CC"` = 一階(linear)內插、兩端 constant extrapolation,與 Python/TS 的
   clamp linear interpolation 語意相同。改完須自行在 Spectre 驗證。

---

## 6. Pitfalls

1. **Single-kick vs 週期 injection** `[INFERENCE]`:本架構每個 reference cycle 都打一次
   (`T_ref = N*T_vco ≈ 3.125` 個 VCO cycle),amplitude 在兩拍之間通常**來不及**回復;
   single-kick PRC 是在完全 settle 後量的,而 discrete map(D1)假設每拍獨立。
   驗證:跑一個 locked 的週期 injection transient(多個 detuning),比較穩態 `e_inj`
   對 `Delta_f` 與 `simulate(inj_model='lut')` 的預測;差異大時需改量「在週期 injection
   中只擾動一拍」的 steady-state PDR(本 kit 未提供)。
2. **Amplitude settling / AM→PM**:anchor 前的 `n_settle` 與 pulse 後量測的 edge 都必須
   在 amplitude transient 消失之後。兩個 late edge 的 settling check 會量化殘差
   (synthetic `--settle-tau 40` 範例:relative gain change −1.80%,觸發 WARNING)。
3. **Pulse width / strength 依賴**:LUT 只對所用的 `pw_inj`、`v_gate_on`、`tr_inj` 有效;
   小 pulse 時 `K_inj` 大致隨寬度增加,大 pulse 時趨向 reset 而飽和。若 pulse 寬度隨
   DTC code 或 tap 改變,需對應多組 LUT `[INFERENCE]`。
4. **Per-tap 重複**:8 個 tap(45° 間距)的 device、routing、parasitics 各不相同,
   每個 tap 應各萃取一次。model 只有一個 LUT,所有 tap 共用:取 worst case / 平均,
   並把 tap `j` 的 null offset `e*_j` 轉成 timing offset
   `tap_mismatch_cycles[j] = −e*_j/(2*pi)`
   `[INFERENCE]`(推導:`PDR_j(e) = PDR_0(e − e*_j)`,而 tap delay `δ` 使
   `e_inj` 增加 `2*pi*δ`,故 `δ = −e*_j/(2*pi)`)。
5. **Supply / temperature / process corners**:`f0`、tank Q、switch `R_on` 都會變;
   `phi` 以該 corner 量到的 `t_vco` 正規化(本流程自動),但 `K_inj` 與 lock range 會變。
   系統 lock range 取最差 corner。
6. **π-periodicity of differential shorting**:完全對稱的差動 shorting switch 在 rising
   與 falling zero crossing 效果相同 → `Δθ(e + pi) = Δθ(e)`,stable 點在 `0` 與 `pi`、
   unstable 在 `±pi/2`:injection 本身可能鎖在錯的半週期,需靠 scheduler / PLL 選對
   `[INFERENCE]`。LUT 能表達這種形狀,`−K*sin(e)` 不能。
7. **Target crossing 與 pulse 中心**:`phi_inj` 定義在 pulse **中心**
   (`t_center = delay + rise + width/2`);anchor 與 late edge 必須用同一種 crossing。
8. **數值細節**:gear2 damping、REF 少了 pulse source 造成 breakpoints 不同
   (所以 REF 保留 source 但 swing 為 0)、pulse 期間差動電壓被拉向 0 產生的
   chatter crossing(hysteresis + nearest-edge matching 處理)、匯出精度不足。
9. **`|kick|` 接近 `pi`**:reset-like PDR 的 winding 為 −1;`e = ±pi` 本質上有 2π 歧義,
   unwrap 會處理,但該區域的量測應加密。
10. **不要 re-center 或強制對稱化 LUT**:null offset 與不對稱都是物理資訊。

---

## 7. Synthetic 驗證結果(本 repo 實跑,`python3`)

設定:truth `delta_theta(e) = −0.3*(sin e + 0.3*sin 2e)`(K = 0.3;odd;quarter-wave skewed),
`f_vco = 12.5 GHz`(`T_vco = 80 ps`),128 個 `phi` 等分(129 列含 `phi = 1`),
每個 crossing 10 fs rms timing noise(每點 Δθ 預期 noise `2*pi*sqrt(2)*10 fs/80 ps = 1.111e-3 rad`),
seed 20261005,64 點 LUT。

| 量 | truth(解析) | recovered | 註 |
|---|---|---|---|
| `K_inj` small-signal | `0.3*(1 + 2*0.3) = 0.48` | 0.479055(−0.20%) | local cubic fit;LUT secant 0.490141 |
| `K1` first harmonic | 0.3 | 0.299713(−0.10%) | |
| `b2` | −0.09 | −0.089409 | |
| `max|kick|` | 0.340949 at `e = ∓1.154833` | 0.339669 at −1.147418 | LUT 格點不含 peak |
| min kick | −0.340949 at +1.154833 | −0.339300 at +1.147418 | |
| LUT error vs truth | — | max 2.49e-3 rad,rms 1.02e-3 rad | |
| noise 估計 | 1.111e-3 rad | 1.128e-3 rad | 8 階 fit residual |
| odd-symmetry error | 0 | max 3.20e-3,rms 1.15e-3 rad | 只剩 noise |
| quarter-wave skew | `2*0.3*0.3 = 0.18` | 0.178654 | |
| stable zero crossing | `e = 0`,slope −0.48 | `e = +0.002388`,slope −0.490141 | noise 造成的 null offset |
| unstable zero crossing | `e = ±pi`,slope +0.12 | `e = −3.139930`,slope +0.141979 | |
| static lock range `a` | ±0.340949 rad/ref-cycle(±217.05 MHz @ 4 GHz) | [−0.339669, +0.339300](−216.24 / +216.01 MHz) | `−K1*sin` 只給 ±0.3(±190.99 MHz) |
| settling residual(edges 100/190) | 0 | systematic 8.9e-4 rad,gain change +0.03% | 無 WARNING |

`simulate()`(`n_div = 3.125`、`f_ref = 4 GHz`)使用 recovered LUT:

| 情境 | 結果 |
|---|---|
| `Delta_f = 1 MHz`(`a = 1.5708e-3 rad`) | locked;`e_inj` 穩態 5.5926e-3 rad = LUT fixed point(truth fixed point 3.2725e-3;差值即 0.0024 rad 的 noise null offset);`Δθ` 穩態 = `−a` |
| `Delta_f = 203.72 MHz`(`a = 0.32 rad`) | LUT locked,`e_inj` 穩態 0.887242(truth 0.882455);同樣 detuning 下 `inj_model='sin'`、`k_inj = K1 = 0.2997` **失鎖**(tail std 1.146 rad,cycle slips) |

其他 synthetic 檢查:30 fs noise 時 LUT max error 7.60e-3(linear)vs 1.93e-3
(`--smooth-harmonics 4`);ideal reset truth → winding −1、`K_inj = 1.00015`、
`max|LUT + e| = 2.55e-4`;`--settle-tau 40` → relative gain change −1.802%
(解析 `0.25*(e^(−190/40) − e^(−100/40)) = −1.836%`)並觸發 WARNING。

---

## 8. 與 MODEL_SPEC / ASSUMPTIONS 的關係

- 本 kit **不改任何 model 數學**:MODEL_SPEC §14 的 LUT 契約(兩欄
  `e_inj_rad, delta_theta_rad`、linear interp、clamp)維持原樣;Python golden 與
  TS mirror 未動,沒有新增 / 修改 test vectors。
- 它是 ASSUMPTIONS.md D4(「PDR/PRC LUT 可由使用者以 CSV 匯入」)的產生流程,
  並讓 D3(`K_inj` 為 lumped 參數、未由電晶體萃取)有了可執行的萃取路徑
  — 但在有人真的跑過 Spectre 之前,D3 的狀態不變。
