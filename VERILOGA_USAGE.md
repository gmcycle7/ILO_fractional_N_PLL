# VERILOGA_USAGE.md — Verilog-A Behavioral Models: Usage Guide

## Status and honesty statement (read first)

**Spectre was NOT run on these models. No Verilog-A/AMS simulator of any kind
was available in the development environment, so the four `.va` files under
`model/veriloga/` are unvalidated source code.** They were written by hand
against the Verilog-AMS 2.4 LRM and against the binding math contract in
`MODEL_SPEC.md`; the executable reference implementation is the Python golden
model (`model/python/`). Expect to fix elaboration warnings/errors on first
load. Behavioral results are **not** silicon results (`MODEL_SPEC.md` §20).

The math contract is `MODEL_SPEC.md` (repo root), assumptions are in
`ASSUMPTIONS.md`. Any numerical disagreement between a `.va` file and
`MODEL_SPEC.md` is a bug in the `.va` file.

## Files

| File | Purpose |
|---|---|
| `model/veriloga/fractional_phase_scheduler.va` | Feedback-path scheduler: per-reference-edge divider modulus `n_int`, PMUX code `m_FB`, DTC code `c_FB` from the exact digital model of `MODEL_SPEC.md` §3–4, quantizer §6 |
| `model/veriloga/reverse_injection_scheduler.va` | Injection-path scheduler: `R_INJ = (R_zero − R_FB) mod 256` (Mode D shared code) or independent re-quantization (Mode A), tap/DTC decode §8, pipeline latency §13 |
| `model/veriloga/pulsed_injection_phase_model.va` | Behavioral ILO: free-running VCO phase, per-pulse kick `Δθ = −K_inj·sin(e_inj)` (or linear / ideal-reset), §14 |
| `model/veriloga/dtc_nonideal_model.va` | Non-ideal DTC delay line: gain/offset/sinusoidal INL/polynomial INL, optional per-tap skew, §10–11 |

All ports are **scalar electrical**. Integer codes travel as piecewise-constant
voltages, `v = code × v_per_code` (default 1 V per LSB). Debug phase outputs
are 1 V per cycle or 1 V per rad, as noted per port.

---

## 1. `fractional_phase_scheduler`

On each rising edge *k* of `ref_clk`:
`s_ideal[k] = s0 + k·N` (multiplicative, §3), `A_FB[k] = Q(256·s_ideal[k])`
(§6), decode per §4, and `n_int[k] = I_FB[k+1] − I_FB[k]` via one-index
look-ahead quantization (the ef1 state still advances exactly once per edge,
in order, matching the Python model).

### Ports

| Port | Dir | Encoding | Meaning |
|---|---|---|---|
| `ref_clk` | in | analog edge, threshold `vth` | reference clock, rising edges only |
| `n_int_out` | out | code × `v_per_code` | divider modulus command; {3,4} for floor/nearest; ef1 transients {2,3,4} (2 only for alpha < ~0.012; 5 unreachable for N in [3,3.25]) — MODEL_SPEC.md §4 |
| `m_fb_out` | out | code × `v_per_code` | PMUX code 0..3 |
| `c_fb_out` | out | code × `v_per_code` | feedback DTC code 0..63 |
| `s_ideal_out` | out | 1 V/cycle | debug: `s_ideal[k]` — **grows without bound** |
| `x_frac_out` | out | 1 V/cycle | debug: `wrap01(s_ideal[k])` |
| `r_fb_out` | out | code × `v_per_code` | debug: `R_FB[k]` 0..255 — feed to `reverse_injection_scheduler.r_fb_in` |

### Parameters

| Parameter | Default | Unit | Meaning (spec ref) |
|---|---|---|---|
| `f_ref` | 4.0e9 | Hz | reference frequency (§1). Informational — timing comes from the `ref_clk` waveform |
| `n_int_base` | 3 | – | integer part of N (§1) |
| `alpha` | 0.13 | cycles/edge | fractional part of N; presets 0 / .125 / .13 / .1375 / .25 (§1) |
| `s0` | 0.0 | cycles | initial absolute phase coordinate (§1) |
| `b_dtc` | 6 | bits | DTC bits; G = 4·2^b_dtc = 256 (§1) |
| `q_mode` | 1 | – | quantizer §6: 0 = floor, 1 = nearest (half-up `floor(u+0.5)`), 2 = ef1. `mash11`/dither are Python-only |
| `vth` | 0.5 | V | clock threshold |
| `v_per_code` | 1.0 | V/LSB | output code scaling |
| `t_tran` | 1e-12 | s | output transition time |

---

## 2. `reverse_injection_scheduler`

### Ports

| Port | Dir | Encoding | Meaning |
|---|---|---|---|
| `ref_clk` | in | analog edge | compute/apply clock |
| `r_fb_in` | in | code × `v_per_code` | `R_FB[k]` (used only in `shared_mode=1`; ground it otherwise) |
| `j_inj_out` | out | code × `v_per_code` | injection tap select 0..7 |
| `c_inj_out` | out | code × `v_per_code` | injection DTC code 0..63 |
| `r_inj_out` | out | code × `v_per_code` | debug: applied `R_INJ` 0..255 |
| `u_inj_out` | out | 1 V/cycle | debug: `u_INJ_digital = (32j+c)/256 mod 1` (§8) |

### Parameters

| Parameter | Default | Unit | Meaning (spec ref) |
|---|---|---|---|
| `r_zero` | 0 | LSB | modular-reverse zero offset `R_zero` (§1, A6) |
| `shared_mode` | 1 | – | 1 = Mode D shared code (recommended, §7); 0 = Mode A independent re-quantization |
| `map_mode` | 0 | – | §8 decode: 0 = naive floor (`j=⌊R/(G/8)⌋, c=R mod G/8`); 1 = nearest phase (tie-break smaller c, then smaller j; candidate grid follows `b_dtc`: c ∈ 0..2^b_dtc−1, taps fixed at 8 — matches Python for any `b_dtc`). Calibrated joint optimization is Python-only |
| `lat_cycles` | 0 | ref cycles | pipeline latency L, 0..8 (B3, §13); shift register of reals |
| `look_ahead` | 1 | – | independent mode only: 1 = compute from state k+L (correct); 0 = from state k (bug mode; α=0.13, L=1 → 46.8°, Test 5). With `q_mode=2` and `lat_cycles≥1` the ef1 state is primed at `initial_step` (see below) |
| `n_int_base`, `alpha`, `s0`, `b_dtc` | 3, 0.13, 0, 6 | as above | independent-mode trajectory (§3) |
| `z0` | 0.0 | cycles | desired zero-crossing phase (§5, A5) |
| `q_mode` | 1 | – | independent-mode quantizer instance (own ef1 state, §7) |
| `e_q_init` | 0.0 | LSB frac | initial private ef1 state (`q_mode=2`, `shared_mode=0`). The Python model seeds this from the first `'dsm_inj'` mulberry32 draw (§7/§12); set 0.7047782763838768 for base seed 12345 to be vector-exact. Default 0.0 is the neutral §6 init, **not** vector-exact vs Python A/B/C + ef1 |
| `vth`, `v_per_code`, `t_tran` | 0.5, 1.0, 1e-12 | V, V/LSB, s | encoding |

Latency note: in `shared_mode=1` this block cannot look ahead (it does not own
the phase state) — the shift register then models pure transport delay, and
correct-by-construction operation requires the *feedback* command path to be
delayed by the same `lat_cycles` so both arms stay aligned (§13 metadata
discussion). Pair-error identity `(R_FB + R_INJ) mod 256 = R_zero` holds
per-edge only when both codes are sampled from the same k.

ef1 look-ahead priming: the Python golden model quantizes *every* state index
0, 1, 2, … in order and only re-times when each command is applied
(`injection_scheduler.py` + `latency_pipeline.py`). With `shared_mode=0`,
`q_mode=2` (ef1) and `look_ahead=1`, this module's first quantization (edge 0)
targets state index `lat_cycles`, so `@(initial_step)` pre-runs the private
quantizer over state indices `0..lat_cycles−1` (outputs discarded) — the ef1
state is `frac(cumsum of inputs)`, so skipping them would offset the state and
the `R_INJ` stream **permanently**, not just at start-up. With priming — and
with `e_q_init` set to the golden model's seeded initial state (§7 seeds the
injection-side ef1 instance from the `'dsm_inj'` stream; 0.7047782763838768
at base seed 12345) — the applied `R_INJ` stream is vector-exact against the
Python vectors for every edge `k ≥ lat_cycles`; the first `lat_cycles`
outputs are start-up fill values (Python instead applies command k already at
edge k < L, as if look-ahead had been running before t = 0). `look_ahead=0`
(bug mode) needs no priming — there edge k quantizes state index k, the same
order as Python — but still needs the matching `e_q_init`.

---

## 3. `pulsed_injection_phase_model`

Free-running phase from `idtmod(f0 + delta_f)`; each rising edge on `inj_in`
samples the VCO phase, forms `e_inj = wrapRadians(2π(φ − z0))` and applies the
§14 kick. The trigger's arrival time carries the scheduler+DTC error, so
`ε_hw` needs no separate port. The model is **deterministic**: the mulberry32
PRNG streams (§12) are not reproducible in Verilog-A, so all noise studies
belong to the Python model (or inject noise externally via trigger timing).

### Ports

| Port | Dir | Encoding | Meaning |
|---|---|---|---|
| `inj_in` | in | analog edge, threshold `vth_trig` | injection trigger (one pulse per T_ref, A4) |
| `vco_out` | out | volts | VCO output: sine (`out_mode=0`) or square (`out_mode=1`) |
| `e_inj_dbg` | out | 1 V/rad | last sampled `e_inj` |
| `dtheta_dbg` | out | 1 V/rad | last applied `Δθ` |
| `theta_dbg` | out | 1 V/rad | accumulated kick offset, wrapped (−π, π] |

### Parameters

| Parameter | Default | Unit | Meaning (spec ref) |
|---|---|---|---|
| `f0` | 12.5e9 | Hz | nominal VCO frequency N·f_ref (§1; 12.5 GHz = canonical §9 point) |
| `delta_f` | 0.0 | Hz | free-running detuning Δf (§14); lock iff \|2π·Δf·T_ref\| ≤ K_inj |
| `k_inj` | 0.3 | rad/rad | lumped injection strength K_inj ∈ [0,1] (D3; 0.3 = canonical dynamics vector §18) |
| `inj_map` | 1 | – | §14 response: 0 = linear `−K·e`, 1 = sinusoidal `−K·sin e`, 2 = ideal reset `−e`. PDR/PRC CSV LUT is Python-only |
| `k_scale` | 1.0 | – | extra strength scaling (effective K = k_inj·k_scale) |
| `pulse_width` | 5e-12 | s | **documentation only** — kick is an instantaneous phase step (D1); parameter carried for netlist bookkeeping |
| `z0` | 0.0 | cycles | desired zero-crossing phase (A5) |
| `theta0` | 0.0 | rad | initial phase offset |
| `out_mode` | 0 | – | 0 = sine, 1 = square |
| `v_amp`, `vhi`, `vlo` | 0.5, 1, 0 | V | output levels |
| `vth_trig` | 0.5 | V | trigger threshold |
| `t_tran` | 1e-12 | s | output/debug transition time |
| `t_kick` | 1e-13 | s | smoothing ramp for the discrete kick step (must be ≪ 1/f0) |
| `en_bound_step` | 1 | – | 1 = `$bound_step(0.05/f0)` timestep ceiling |

---

## 4. `dtc_nonideal_model`

Rising edge on `trig_in` is reproduced on `trig_out` after
`t_d = offset_s + gain·c·lsb_s + inl_sin_amp_s·sin(2πc/64) + p2_s(c/63)² +
p3_s(c/63)³ + tap_j` (§10 items 1, 3–7, 10; seconds-domain — cycles =
seconds / T_vco). Falling input edge is propagated with the same captured
delay, so the output pulse width follows the input.

### Ports

| Port | Dir | Encoding | Meaning |
|---|---|---|---|
| `trig_in` | in | analog edges | edge/pulse to be delayed |
| `code_in` | in | code × `v_per_code` | DTC code 0..63, sampled at the rising edge |
| `tap_sel_in` | in | code × `v_per_code` | tap select 0..7 (only if `use_tap=1`; ground otherwise) |
| `trig_out` | out | `vlo`/`vhi` | delayed edge/pulse |

### Parameters

| Parameter | Default | Unit | Meaning (spec ref) |
|---|---|---|---|
| `lsb_s` | 312.5e-15 | s | DTC LSB; default = fixed-time value (B2). Normalized mode: set to T_vco/256 (§11: 325.521 / 312.5 / 300.481 fs) |
| `gain` | 1.0 | – | gain factor (items 3–4); 1.01 → canonical 1 % / 200 fs check (Test 7) |
| `offset_s` | 0.0 | s | static offset (item 5); also usable as route skew (item 10, C6) |
| `inl_sin_amp_s` | 0.0 | s | sinusoidal INL amplitude (item 6) |
| `p2_s`, `p3_s` | 0.0 | s | polynomial INL coefficients (item 7) |
| `use_tap` | 0 | – | 1 = add per-tap skew from `tap_sel_in` (item 1, C1) |
| `tap0`..`tap7` | 0.0 | s | per-tap static skew; canonical "1° all taps" @ 80 ps → 222.22e-15 each (Test 6). Defaults are **mismatch-only**: in an all-behavioral full loop fold the nominal `N·T_vco/8` tap phase (10 ps/tap @ 80 ps) into `tapN` — see hookup rule 3 |
| `n_codes` | 64 | – | 2^b_dtc (B1) |
| `vth`, `v_per_code` | 0.5, 1.0 | V, V/LSB | input encoding |
| `vhi`, `vlo`, `t_rise` | 1, 0, 1e-12 | V, V, s | output shape |
| `t_d_min` | 1e-15 | s | causality clamp on total delay |

Not modeled (Python-only): 64-entry LUT INL (item 8 — array parameter,
portability), frozen random DNL (item 9 — needs the §12 PRNG), all random
noise items.

---

## Hooking into a transistor-level testbench

Typical replacement ladder (behavioral → transistor block by block):

```
                 +---------------------------+
 ref_clk ------->| fractional_phase_scheduler|--- n_int_out ---> (multi-modulus divider ctrl)
   (4 GHz       |                           |--- m_fb_out ----> (PMUX select DAC/decoder)
    pulse src)  |                           |--- c_fb_out ----> dtc_nonideal_model (FB) code_in
                 |                           |--- r_fb_out --+
                 +---------------------------+               |
                 +---------------------------+               |
 ref_clk(+skew)->| reverse_injection_schedulr|<-- r_fb_in ---+
                 |                           |--- j_inj_out --> tap mux select / tap_sel_in
                 |                           |--- c_inj_out --> dtc_nonideal_model (INJ) code_in
                 +---------------------------+
 ref_clk(+t_arm)---------------------------------> dtc_nonideal_model (INJ) trig_in
                    dtc (INJ) trig_out ----------> pulsed_injection_phase_model inj_in
                    pulsed_injection... vco_out --> divider / PMUX / probes
```

Practical rules:

1. **Codes are voltages.** Drive `c_FB`/`c_INJ`/`j_INJ` nets straight between
   the modules (both sides default to 1 V/LSB). To drive a real transistor
   DTC instead, decode the voltage with an ideal ADC bridge or replace the
   scheduler output stage with a `wreal`/bus bridge in an AMS (not pure
   Verilog-A) flow.
2. **Sampling skew.** Scheduler outputs update *on* the reference edge through
   a `transition()` ramp (`t_tran`). Any block that samples them on the same
   edge is racing (cross-module same-time event order is not LRM-guaranteed).
   Give consumers a delayed copy of `ref_clk` (e.g. +T_ref/4) or arm the DTC
   trigger later in the cycle, so codes are settled when sampled.
3. **Nominal tap/PMUX phases are part of the loop math — include them.** The
   schedulers' codes assume the analog paths add the *nominal* phase offsets
   on top of the DTC delay: `j_INJ·T_vco/8` (injection tap) and
   `m_FB·T_vco/4` (feedback PMUX). In the Python golden model these live in
   `tap_actual(j) = j/8 + delta_tap[j]` and `pmux_actual(m) = m/4 +
   delta_pmux[m]` (§4–§5, `model/python/tap_model.py`), and `u_INJ_analog`
   includes the `j/8` term. `dtc_nonideal_model`'s `tap0..tap7` default to
   **mismatch-only** (0 s), so an all-behavioral testbench that wires
   `j_inj_out → tap_sel_in` with default taps drops the nominal tap phase
   entirely and the injection pulses land nowhere near the intended zero
   crossing. The rule for an all-behavioral bench:
   * **Injection path**: on the INJ `dtc_nonideal_model` set `use_tap = 1`
     and `tapN = N·(T_vco/8) + skew_N`. At the canonical 12.5 GHz
     (T_vco = 80 ps): tap0..tap7 = 0, 10, 20, 30, 40, 50, 60, 70 ps plus
     any per-tap mismatch. `tap0..tap7` then carry **nominal + mismatch**,
     not mismatch only.
   * **Feedback path**: add the nominal PMUX delay `m_FB·(T_vco/4)`
     (= 0/20/40/60 ps at 80 ps T_vco) plus any PMUX skew — e.g. a second
     `dtc_nonideal_model` in tap mode (`use_tap = 1`,
     `tap_sel_in ← m_fb_out`, `tapM = M·(T_vco/4) + pmux-skew_M` for
     M = 0..3; taps 4..7 unused) in series with the FB DTC.
   When replacing a behavioral block with the transistor tap mux / PMUX,
   the real circuit provides these nominal phases itself — drop them from
   the behavioral parameters again.
4. **One pulse per reference cycle** into the injection model (A4); keep DTC
   input pulses shorter than `T_ref − max(t_d)`.
5. **Divider modulus**: `n_int_out` is the modulus for the interval [k, k+1),
   issued at edge k — registered-output semantics, sample it like RTL.
6. The `s_ideal_out` debug node grows without bound; don't lint/limit-check
   that node, or leave it unconnected.

## Driving from the CSV command vectors (`test_vectors/csv/`)

The Python CLI emits per-cycle command CSVs (they may not exist until you run
it; the format is contractual — `MODEL_SPEC.md` §18):

```
k, t_ref_ns, n_int, m_FB, c_FB, j_INJ, c_INJ, R_FB, R_INJ, seq_id
```

| Column | Meaning |
|---|---|
| `k` | reference-edge index 0,1,2,… |
| `t_ref_ns` | time of edge k in **ns** (= k/f_ref·1e9 for the ideal reference) |
| `n_int` | divider modulus command for [k, k+1) |
| `m_FB` | feedback PMUX code 0..3 |
| `c_FB` | feedback DTC code 0..63 |
| `j_INJ` | injection tap select 0..7 |
| `c_INJ` | injection DTC code 0..63 |
| `R_FB`, `R_INJ` | fine codes 0..255 (identity: `(R_FB+R_INJ) mod 256 = R_zero` in Mode D) |
| `seq_id` | command sequence id (§13 metadata) |

Two ways to use them:

* **As stimulus** (bypassing the scheduler modules): script a converter (a few
  lines of Python) that turns each code column into a piecewise-linear source,
  e.g. a Spectre `vsource type=pwl` holding `value = code × 1 V` from
  `t_ref_ns` to the next edge with ~1 ps ramps. Feed those PWL nets into
  `dtc_nonideal_model.code_in`, the tap mux, and the divider control. Verilog-A
  file I/O (`$fopen`/`$fscanf` in analog context) is *not* used in these
  models — support is too tool-specific.
* **As reference** (checking the scheduler modules): run the schedulers from a
  clean reference source, save `n_int_out`/`m_fb_out`/`c_fb_out`/`r_inj_out`
  (strobe at, say, `t_ref_ns + T_ref/2`), export to CSV, and diff against the
  Python vectors. Integer codes must match **exactly** (§18 tolerance: int 0).

## Known simulator portability caveats

* **Array ports / array parameters** — avoided entirely. Tap mismatch is
  flattened to `tap0..tap7` scalars; LUT INL and PDR/PRC LUTs are Python-only.
  Rationale: array parameter override syntax and array-port support differ
  across Spectre / AMS Designer / Questa-ADMS versions.
* **Event scheduling** — the LRM does not define the order of `cross()` events
  in *different* modules at the same time point. All inter-module hand-offs
  here assume registered-output/sample-later discipline; add clock skew in the
  testbench (see rule 2 above).
* **`cross()` precision** — edge times are found by interpolation within
  solver tolerances; digital identities remain exact because all digital math
  is done in float64 state variables, but *edge timestamps* carry solver
  tolerance.
* **Analog memory** — all module state lives in analog-block variables updated
  inside events. This is standard Verilog-A, but initialization before
  `initial_step`, multi-analysis re-runs, and save/restart handling of such
  state are tool-specific. Every variable is explicitly initialized in
  `@(initial_step)`.
* **`transition()` with variable delay** (`dtc_nonideal_model`) — legal, but
  pending-event preemption when a shorter delay overtakes a longer one is
  tool-specific. Safe here because pulses are ≥ T_ref apart and delays ≤ ~25 ps.
  `absdelay()` cannot be used (constant delay only).
* **`idtmod()`** (`pulsed_injection_phase_model`) — solver-owned wrapped
  integrator; wrap-point event handling and tolerances differ slightly across
  tools. Standard VCO idiom, but unvalidated here. A timer-based event-driven
  oscillator alternative is sketched in the file's comments; dynamically
  re-armed `timer()` events are themselves simulator-dependent, which is why
  the idtmod form was chosen.
* **`$bound_step`** — widely but not universally supported; parameter
  `en_bound_step=0` disables it.
* **32-bit integers** — edge counters and absolute codes are kept in `real`
  (exact to 2^53) because Verilog-A `integer` is 32-bit and `A_FB ≈ 256·3.13·k`
  overflows after ~2.6e6 edges.
* **No `%` on reals** — all modular arithmetic is spelled `a − b·floor(a/b)`.
* **No PRNG parity** — the §12 mulberry32 streams are not implemented;
  `$rdist_*` calls are deliberately absent (call-count per timestep is
  tool-dependent, and bit-parity with Python would be impossible anyway).
  The one PRNG-derived value needed for *digital* vector parity — the §7
  seeded initial ef1 state of the independent injection quantizer (first
  `'dsm_inj'` draw) — is passed in by hand via
  `reverse_injection_scheduler.e_q_init` instead.

## Suggested bring-up sequence

1. **Scheduler alone.** `fractional_phase_scheduler` + ideal 4 GHz pulse
   source, `alpha = 0.125`, `q_mode = 1`. Strobe the code outputs each cycle
   and diff against `test_vectors/csv/` (or the Python CLI directly). Expect
   *exact* integer agreement; on-grid N = 3.125 must give `e_FB_abs ≡ 0`
   (§4). Then repeat with `alpha = 0.13` (off-grid) and `q_mode = 2` (ef1).
   Add `reverse_injection_scheduler` in `shared_mode = 1` and assert
   `(R_FB + R_INJ) mod 256 = 0` every cycle (§7 Mode D identity, Test 2).
2. **DTC next.** Insert `dtc_nonideal_model` on the c_FB path with all
   non-idealities zero: output edges must land on the ideal grid to within
   solver tolerance. Then enable one impairment at a time and reproduce the
   canonical checks — 1 % gain → 200 fs max (Test 7), 1° tap → 222.22 fs
   (Test 6) at T_vco = 80 ps.
3. **Injection model last.** Drive `pulsed_injection_phase_model` from the
   delayed trigger chain. Sanity ladder (§14, Test 14): `k_inj = 0` → phase
   ramps at `delta_f` uncorrected; `k_inj = 0.3, delta_f = 1 MHz` → locks with
   static offset `theta_ss = asin(2π·Δf·T_ref/K_inj)`; `k_inj` ↑ → residual ↓;
   `inj_map = 2` (ideal reset) is the upper bound. Only then close the full
   loop (scheduler → DTC → injection) — with the nominal tap/PMUX phases
   folded into the behavioral delay path per hookup rule 3, otherwise the
   injection pulses miss the intended zero crossing by up to 7·T_vco/8 —
   and look at `e_inj_dbg` per cycle.

Each step has a Python golden-model counterpart — debug numerical mismatches
against Python *before* suspecting the simulator.
