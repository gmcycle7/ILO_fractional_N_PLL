# CHAPTER_GUIDE.md — 網站章節內容契約

寫章節內容的 agent 必須遵守本文件。數學一律以 `MODEL_SPEC.md` 為準;
component API 以 `web/ARCHITECTURE.md` 為準;compute 一律經由 `import { ... } from '../model'`。

## 0. 語言與風格(硬性規定)

- **繁體中文**為主,英文 technical terms 保留英文(DTC、DSM、injection、quantization、
  zero crossing、look-ahead…)。**禁止簡體中文**。
- 專業工程師語氣;高資訊密度但不擁擠;不用 emoji、不用驚嘆號堆砌。
- 每個重要結論掛 `<EpistemicTag>` 標記:EXACT / ASSUMPTION / APPROX / EXPERIMENT / INFERENCE。
- 數學用 KaTeX(`<M>`/`<MathBlock>`);變數名與 MODEL_SPEC 一致。
- 圖用 EChart wrapper 或 SVG components;顏色取自 theme tokens,不硬編色碼。

## 1. 每章固定 11 節結構(用 ChapterShell 的 Section components,順序固定)

1. SectionQuestion — 這一章要回答的問題(3–6 條 bullet)
2. SectionIntuition — physical intuition(含 timing 圖或 phase wheel)
3. SectionMath — 完整數學推導(每個公式怎麼來、sign convention 明確)
4. SectionExample — 一個簡單數值例子(手算可驗)
5. SectionFigure — 互動圖(可多個;含 caption 說明軸與單位)
6. SectionCode — 對應 behavioral code 摘錄(從 web/src/model 真實碼節錄,勿捏造)
7. SectionLineByLine — 逐行解說(挑 6–15 行關鍵行)
8. SectionObserve — 圖上應該觀察什麼(具體:哪條線、哪個值、為什麼)
9. SectionMisconception — 常見誤解(至少 1 條,說明為何錯)
10. SectionTakeaway — design implication
11. SectionLimitation — model limitation(誠實標示近似)

互動參數用 ParamPanel + Slider/Select/Toggle;模擬用 `useMemo` 包 `simulate(cfg)`,
`n_cycles` 預設 ≤ 1024(互動流暢);跑模擬前後用 SimStatusContext 更新狀態。
單位切換一律用 UnitSwitch(cycles/deg/time),軸標籤跟著換。

## 2. 各章內容規定(章號 = 檔名 ChapterNN.tsx)

**Ch0 Executive Overview 執行摘要**
系統一句話;預設參數表(f_ref=4GHz, N=3+α, α∈[0,0.25], 12–13GHz, G=256);
關鍵數字卡片(312.5 fs LSB、1.40625°、half-LSB 156.25 fs、46.8° latency bug、
222 fs/1° tap、200 fs/1% gain);全站結論預覽(Mode D 推薦鏈);導覽地圖。
不需要互動模擬,但要一張小的 phase wheel 靜態示意。

**Ch1 System Architecture 系統架構**
互動圖#1 System block diagram(SVG):ref → PFD/sampling → LF → VCO(8 taps)→
feedback:/3-/4 → 4-phase PMUX → 6-bit DTC → PD;injection:ref → scheduler →
8-tap select → 6-bit DTC → pulse gen → VCO node。hover 各 block 顯示說明。
說明兩條路徑共享 phase 資訊的位置(master accumulator)。列 ASSUMPTIONS.md 對應假設。

**Ch2 Timing and Sign Convention 時序與符號慣例**
MODEL_SPEC §2 全部:cycles 為內部單位、wrap01/wrapCycles/wrapRadians 定義與圖示
(數線上 wrap 行為)、error=actual−ideal、delay 為正。
互動圖#4 EdgeTimeline:ref/VCO/feedback/injection 四列 edges(用 simulate 的
t_FB 等欄位,N 可調)。數值例:wrapCycles(0.7)=−0.3。
說明為什麼禁止用內建 round()(banker's rounding 跨語言不一致)。

**Ch3 Ideal Fractional Phase Trajectory 理想分數相位軌跡**
s_ideal[k]=s0+kN、x_ideal 遞迴、integer 3 與 α 的意義、off-grid 的正確理解
(§MODEL_SPEC 3)。5 個 preset N(3.000/3.125/3.130/3.1375/3.250)。
互動圖#2 動畫 phase wheel(逐拍旋轉 +α,play/pause/step)、#5 absolute
coordinate staircase、#6 fractional accumulator plot、cycle-by-cycle 小表。
N=3.13 序列 0,0.13,0.26,… 必須逐字出現。

**Ch4 /3-/4 + 4-phase PMUX Operation**
MODEL_SPEC §4:A_ideal→A_FB→I/R/m/c decode;n_int=I[k+1]−I[k];
為何 n_int∈{3,4};PMUX wrap 時 /3-/4 怎麼補。
互動圖#7 divider command plot、#8 PMUX code plot、ideal vs actual edge、
assertions 清單(monotonic/duplicate/backward)。
數值例:N=3.13, k=0..7 手算 A_ideal, R_FB, m_FB。

**Ch5 6-bit Feedback DTC**
DTC decode c_FB、LSB=T_vco/256;normalized vs fixed-time DTC(MODEL_SPEC §11,
含 12/12.5/13 GHz 表格與 325.521/312.500/300.481 fs);quantizer modes 選單。
互動圖#9 DTC code plot、#12 ideal vs quantized phase、#13 absolute error plot、
#28 frequency sweep(time LSB/phase LSB/peak error vs f_vco)。
數值例即 §9 的 0.337 例(feedback 半邊)。

**Ch6 Reverse Injection Geometry 反向注入幾何**
本章是核心推導:MODEL_SPEC §5 全文 — zero-crossing condition 出發,
推出 u_INJ_ideal=wrap01(z0−x_nominal),z0=0 時 = wrap01(−x)。
必須清楚區分七類誤差(deterministic/random/quantization/tap/DTC/ref jitter/latency),
說明 DSM 只能預測 deterministic 部分、random VCO noise 正是 injection 要修的。
互動:phase wheel 同時畫 x_ideal(正轉)與 u_INJ_ideal(反轉)動畫;e_ZC 公式分解圖。

**Ch7 8-phase Injection Tap Mapping**
MODEL_SPEC §8:tap spacing 32 LSB、DTC range 64 LSB → redundancy;
naive/nearest/calibrated 三種 mapping;calibrated argmin 公式。
互動圖#3 8-tap phase wheel(必含:8 taps、ideal target、選中 tap、DTC fine 移動、
實際 zero crossing、residual error、redundant 替代解、開 mismatch 後 calibrated 為何改選)、
#10 tap code plot、#11 injection DTC code plot。
數值例:u_target=0.40 → naive (j=3,c=6) vs 替代 (j=2,c=38);開 1° tap3 mismatch 後
calibrated 改選誰、residual 各多少。

**Ch8 Shared Phase State 共享相位狀態**
MODEL_SPEC §7 四 mode 全比較。Mode D identity (R_FB+R_INJ) mod 256 = R_zero 的證明;
e_pair 定義;shared code 消除什麼/不能消除什麼(逐項列表)。
互動:mode A/B/C/D 切換,#14 pair error plot + #13 absolute error 對照,
Mode B 的 pair error 非零、Mode D 恆零 [EXACT]。附 cycle 表(k, R_FB, R_INJ, sum mod 256)。

**Ch9 Why DSM Output Alone Is Insufficient 為何只看 DSM 輸出不夠**
MODEL_SPEC 對應原始需求 §11:q_N[k]=N−n[k] 是瞬時量,phase 是累積量
p[k+1]=p[k]+N−n[k];z-domain P(z)=z^-1/(1−z^-1)(N−N_div)。
必做例子:找兩個 cycle,DSM output 同為 /3 但 accumulator state 不同 →
所需 injection phase 不同(用 N=3.13 序列指出具體 k)。
互動圖#19 DSM internal state、#20 DSM output vs accumulated phase、
「只看 bit 的錯誤 injection」vs「用 state 的正確 injection」對照(experiment 20)。
結論:要拉 shared master accumulator state / accumulated quantization error /
final common code,不是瞬時 bit。

**Ch10 Sub-LSB Quantization**
MODEL_SPEC §9 全例(0.337→86/170、∓85 fs、pair=0)逐步呈現;
「VCO 追蹤 quantized common trajectory」「shared code 不創造 sub-LSB delay」。
互動:u_ideal 滑桿(0..1)即時算 R_FB/R_INJ/兩側 error/pair;
放大鏡圖顯示 sub-LSB gap。

**Ch11 Fixed Rounding versus Phase DSM**
MODEL_SPEC §6:0.3 LSB canonical case;nearest 固定 −0.3 vs ef1 的 {−0.3,+0.7} 序列;
mean/peak/RMS/histogram/PSD/tones 全比較(experiment 7/8/9)。
互動圖#16 error histogram、#17 PSD、時序圖;quantizer 全模式選單 + dither。
必寫:DSM 能做 temporal averaging/noise shaping/改變頻譜;不能做 sub-LSB analog timing、
不能消 tap/DTC/latency error、不能預知 VCO noise。

**Ch12 Pipeline Latency and Look-Ahead**
MODEL_SPEC §13。互動圖#27 latency 圖(command 產生/apply 時間軸、seq_id、
intended vs applied)、latency slider L=0..8、correct vs bug 對照(46.8° @ α=0.13,L=1)、
與 half-LSB 0.703° 的 66.6× 對比。metadata 表(k_computed/k_intended/k_applied)。

**Ch13 Actual VCO Injection Dynamics**
MODEL_SPEC §14。三 model(reset/linear/sin+LUT);為何 scheduler 先驗證再加 dynamics
(避免 bug 被 loop 隱藏)。互動圖#21 phase response curve(sin map、stable/unstable
fixed points 標記)、#22 convergence plot(θ[k] 軌跡,K_inj/Δf/noise 可調)、
lock range |2πΔf·T_ref|≤K_inj 檢查、K_inj→0 與加大之趨勢。PDR LUT CSV import UI。
全章掛 APPROX 標記。

**Ch14 Zero-Crossing Miss and Shorting Energy**
MODEL_SPEC §15。v_d/V_p=sin(2πε_t/T_vco)、E∝sin²、half-LSB → 1.227% / 1.5e-4。
互動圖#23 differential voltage vs timing offset、#24 energy proxy、#15 actual
zero-crossing miss 時序;固定/周期/隨機 error → offset/spur/noise floor 對照
(experiment 16)。誠實標示 proxy 性質。

**Ch15 Analog Mismatch**
MODEL_SPEC §10 全 16 項清單與 enable/disable;數值例 1°=222.22 fs≈0.711 LSB、
1%×20 ps=200 fs≈0.64 LSB,均 > half-LSB。
互動圖#25 tap mismatch polar plot、#26 DTC INL plot(sin/poly/LUT)、
error decomposition 堆疊圖(逐項開關,MODEL_SPEC §16);
naive vs calibrated mapping 在 mismatch 下的差異(experiment 12/13/14/19)。

**Ch16 Spur and Phase-Noise Analysis**
MODEL_SPEC §17:sample rate=f_ref(不是 f_vco)、f_spur=m/P·f_ref、Hann PSD、
dBc convention 全文引用。互動圖#17 PSD、#18 spur markers(標 m/P·f_ref)、
deterministic spur vs broadband vs static offset vs RJ vs PJ 五分類各給一例
(不同 config 一鍵切換)。固定 seed 說明。

**Ch17 Interactive Architecture Comparisons 互動式架構比較**
22 個 experiment 一鍵 preset(from '../model' 的 EXPERIMENTS),每個顯示:
setup(config diff)、equations 連結、expected、simulation result、
what to observe、engineering conclusion。
互動圖#29 comparison dashboard(多 config 同跑、指標表:RMS/peak/pair/ZC miss、
PSD 疊圖、cursor 同步 group)、#30 cycle-by-cycle debug table(全 24+ 欄,
DebugTable + CSV export)。

**Ch18 Python Golden Model**
模組結構圖、SimConfig 欄位表、CLI 用法(--list-presets/--preset/--emit-vectors)、
test vector schema、pytest 摘要、Python↔TS 交叉驗證方法與 tolerance。
節錄 3–4 段真實 Python 碼(feedback_scheduler、mode D、mulberry32)。

**Ch19 Verilog-A Model**
四個 .va 模組用途/ports/parameters 表、VERILOGA_USAGE.md 重點、CSV 驅動法、
simulator-dependent constructs 清單、bring-up 順序;
誠實聲明:未跑 Spectre、行為級 ≠ silicon。節錄 .va 關鍵段落。

**Ch20 Design Rules and Conclusions 設計準則與結論**
逐條回答原始需求 §26 的 18 個問題(每題:答案 + 依據哪個 experiment/公式 + 標記)。
推薦架構鏈(shared accumulator → common final code → FB decode → modular reverse →
calibrated tap/DTC decode → fixed-latency look-ahead → nearest baseline →
評估後才選 shared DSM),並引用 experiment 結果支持,不硬寫結論。
最後放 honesty 清單(MODEL_SPEC §20)。

**Ch21 PD 輸入端誤差逐級解析 PD-Input Phase Error Anatomy**
主題:feedback chain「/3-/4 divider → 4-to-1 PMUX → 6-bit DTC」在不同 divide ratio
下於 PD 輸入端產生的 phase error;全章 open-loop(scheduler error at PD input)。
四層結構:
(1) 基本數學:e_PD[k]=wrapCycles(s_FB_actual−s_ideal)(= §4 e_FB_abs,S=256 時與
simulate() 逐位相等);stage grid Δ=1/G,G∈{1,4,256};α=p/q(最簡)→ 週期
P=q/gcd(q,G)、peak=(⌊P/2⌋/P)·Δ ≤ Δ/2、spur 間距 f_ref/P [EXACT]。5 preset N × 3
stage 的公式 vs 量測驗證表(即時計算 + python3 交叉驗證)。錨點:N=3.13@DTC →
P=25、peak 0.48 LSB=149.8 fs、160 MHz;N=3.125@DTC exact;N=3.125@PMUX P=2 交錯;
N=3.000 全級 0。
(2) 逐級暫態:stage×quantizer 互動模擬(runStage helper:v=A_ideal·S/256,S/256 為
2 的冪 → 跨語言逐位一致;quantizer fresh state per run)。圖:edge staircase(前 40
拍)、e_PD 三級同軸疊圖(UnitSwitch)、code-level 暫態(n_int/m_FB/c_FB + DSM
state)、stage×quantizer peak/rms/n_int 矩陣、cycle-by-cycle DebugTable + CSV。
SectionExample = N=3.13 ef1@PMUX grid 的 25 拍 startup 全表(手算可驗,
ErrorFeedbackFirstOrder 手動 step;ef1 以 e₀=0 起步即為週期穩態、mash 前 1–2 拍有
差分 transient;float64 準週期 ~1e-9 漂移需容差比較)。
(3) DSM 有效解析度:per-edge 誤差不變細、峰值反而變大(N=3.13@DTC:0.48→0.76→
1.36→1.76 LSB);DSM 買的是 in-band(proxy band f<f_ref/64)平均解析度。誠實呈現:
對 P=25 的 N=3.13,band 內本無量化功率(~1e-9 cyc,leakage 位階)→ 用診斷微擾
N*=N±(2⁻¹³+2⁻²⁵)(長週期 rational)量測:DTC 級 in-band 抑制 ef1 +6.4 dB(+1.1
bit)、mash11 +32.3 dB(+5.4 bits)、mash111 +51.8 dB(+8.6 bits);mash111@PMUX
shaped 擺幅 ±0.92 cyc → wrap 摺疊 132 拍 → in-band 反劣化 22 dB(摺疊條件:shaped
擺幅 × Δ ≥ 0.5 cycle 即毀)。dither 在 error-feedback 結構不被 shaping → 墊高
in-band floor。
(4) 每級頻譜 + sanity checklist(1024 cycles、Hann、sample rate=f_ref,y 軸 dB re
cycle²/Hz,不標 dBc):5 項即時 pass/fail 檢查與容差:①spur 間距=f_ref/P:每根
strong spur(nearest、30 dB 窗)落在 m·f_ref/P 格點 ±1 bin;P=2 走 Nyquist-bin
特例;非短週期 rational 或 P>512 → N/A ②shaping
斜率:誤差對其 n 重(去 mean)累加的 PSD 比值 =|2sin(πf/f_ref)|^{2n} [EXACT],
[f_ref/64, f_ref/6.4] fit ≈ +20n dB/dec(python 實測 19.5–19.8/39.0–39.5/59.6–61.7,
容差 ±4;恆用 N* 未 wrap 診斷序列)③Parseval:ΣS·df/mean(e²)∈[0.8,1.2](preset
67 組實測 0.865–1.101;僅 P≤128 或有效 dither 時檢查,慢 tonal 可偏到 1.9 → N/A)
④DC bin ↔ 時域 mean:μ=2√(S₀·f_ref·U/N),U=3/8(N=3.125@PMUX 的 1/16 cycle 精確
回收;容差 max(2e-4, 10%, peak·P/N);dither 或 P>128 → N/A)⑤nearest comb(集中度
≥0.9,preset 實測 0.987–1.000、slider P≤128 掃描 ≥0.94)↔ dither≥0.5 floor(≤0.5,
實測 0.003–0.090;0<dither<0.5 轉換區 → N/A;divider 級 dither 經 wrap 不可見 → 仍
comb)。dither toggle 展示 tone→floor。
misconception:「DSM 提高 DTC 解析度所以每個 edge 更準」(錯:峰值變大);「grid
越細 spur 越高頻」(錯:P 只依 gcd(q,G),N=3.13 PMUX/DTC 同為 160 MHz)。takeaway:
grid 優先、DSM 其次(摺疊條件限階數)、dither 是頻譜工具的 trade-off 表。limitation:
PD 線性度/loop dynamics 未建模、divider/PMUX 截斷級為思想實驗、單 realization
seed 12345、N* 為人為構造。ParamPanel:stage/quantizer/N(useChapterNDiv)/dither/
n_cycles≤512/log-x toggle。


## 3. 互動圖總表(30 圖 → 章)

1→Ch1, 2→Ch3, 3→Ch7, 4→Ch2, 5→Ch3, 6→Ch3, 7→Ch4, 8→Ch4, 9→Ch5, 10→Ch7,
11→Ch7, 12→Ch5, 13→Ch5/8, 14→Ch8, 15→Ch14, 16→Ch11, 17→Ch11/16, 18→Ch16,
19→Ch9, 20→Ch9, 21→Ch13, 22→Ch13, 23→Ch14, 24→Ch14, 25→Ch15, 26→Ch15,
27→Ch12, 28→Ch5, 29→Ch17, 30→Ch17。

## 4. 技術注意

- chapter 檔案只能寫 `web/src/chapters/ChapterNN.tsx` 與(如需)`web/src/chapters/chNN/` 子目錄。
- 不可修改 registry、components、model、全域 CSS(如需新樣式,章內 inline style 或
  chNN/ 內 CSS module)。
- TypeScript strict;不可有未使用變數;`npm run build` 必須通過。
- 模擬計算放 useMemo;大圖 data 下採樣(>4096 點時 stride)。
- 所有數字格式化用 lib/format.ts;不要自己 toFixed 硬寫單位。
