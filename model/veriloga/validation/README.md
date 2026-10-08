# Spectre validation kit — `model/veriloga/*.va`

> **STATUS: UNRUN.** No simulator able to compile these Verilog-A models was
> available where this kit was written. The four netlists, the generated Ocean
> export scripts and `run_all.sh` have **never been executed by Spectre or
> Ocean**. Expect first-run fixes. What *was* run (outputs quoted below):
> `gen_stimulus.py --all --verify`, `check_results.py --lint`,
> `check_results.py --self-test`, and `run_all.sh` with **stub**
> `spectre`/`ocean` executables (shell plumbing and exit codes only).

The goal is that, on a machine with a Cadence install, validating the four
models against the committed golden vectors takes one command:

```
cd model/veriloga/validation
./run_all.sh                         # all four benches; exit 0 = all PASS
./run_all.sh dtc_nonideal_model      # one bench
```

## Why a commercial simulator is required

The `.va` files are event-driven behavioral models: `@(cross())`,
`@(initial_step)`, `transition()` (including a *variable* delay in
`dtc_nonideal_model`), `idtmod()`, `$bound_step`, and state variables that
persist between analog events. The open-source OSDI flow (OpenVAF compiling
for ngspice or Xyce) supports the compact-model subset of Verilog-A: no
analog events and no analog filters such as `transition()`/`idtmod()`. It
therefore cannot compile these files. Validation needs a full Verilog-A
simulator: Spectre (including APS/X), Siemens AFS, or Xcelium/AMS Designer.
This kit targets **Spectre + Ocean**. The other simulators need their own
netlists; the CSV contract and `check_results.py` still apply.

## Prerequisites

| Item | Notes |
|---|---|
| `spectre` in `PATH` | Any release that supports `ahdl_include`. The `.va` files compile on first use, so the AHDL compiler must work |
| `ocean` in `PATH` | Ocean (Virtuoso) is used only to export PSF to CSV (`value()` / `cross()`) |
| `python3` ≥ 3.8 | `gen_stimulus.py` and the scheduler checks use the stdlib only |
| `numpy` | needed by the checks that call the golden model (`dtc_gain`, `dtc_inl`, all `pulsed_injection_phase_model` instances) |
| this repo | `test_vectors/` (committed vectors) and `model/python/` (golden model) |
| licenses | Spectre (with Verilog-A), Virtuoso/Ocean |

Environment overrides: `SPECTRE`, `OCEAN`, `PYTHON`, `SPECTRE_ARGS` (e.g.
`"+aps"`), `CHECK_ARGS` (e.g. `"--tol-delay-fs 20"`).

**Expected runtime (estimate, not measured).** Each bench is a 128 ns
transient (512 reference cycles at 4 GHz). The scheduler and DTC benches are
event-driven with a few breakpoints per cycle, so they should take seconds
each after the one-time AHDL compile, which can take tens of seconds per
module. In the injection bench, `$bound_step(0.05/f0)` ≈ 4 ps forces at least
32 k time points across 3 instances, so expect seconds to about a minute. The
Ocean `cross()` loops in the DTC export take seconds. Total: a few minutes.

## Files

| File | Real / UNRUN | Purpose |
|---|---|---|
| `tb_fractional_phase_scheduler.scs` | UNRUN | 3 instances: `fps_a` ↔ `n3p130_nearest`, `fps_b` ↔ `n3p125_nearest`, `fps_c` ↔ `n3p130_ef1_shared` |
| `tb_reverse_injection_scheduler.scs` | UNRUN | `rev_d` (Mode D, R_FB from PWL) and `rev_chain` (Mode D fed by a live `fps`) ↔ `n3p130_nearest`; `rev_b` (Mode A/B ef1, `e_q_init` seeded) ↔ `n3p130_ef1_independent`; `rev_lb` / `rev_la` (L = 1, bug / look-ahead) ↔ `n3p130_latency_bug` / `n3p130_lookahead` |
| `tb_dtc_nonideal_model.scs` | UNRUN | `dtc_tap` ↔ `n3p125_tap_mismatch_1deg`; `dtc_ideal` ↔ `n3p130_nearest`; `dtc_gain` (gain 1.01) and `dtc_inl` (offset + sin INL + poly INL) ↔ golden re-run of `n3p130_nearest` |
| `tb_pulsed_injection_phase_model.scs` | UNRUN | `ilo_sin` / `ilo_lin` / `ilo_rst` (inj_map 1/0/2) with `n3p130_dynamics_sin` parameters ↔ golden `run_dynamics` (noise off) |
| `run_all.sh` | UNRUN | gen stimulus → lint → spectre → ocean export → check, with a summary and exit status |
| `gen_stimulus.py` | real | CSV vector → Spectre PWL files (`--verify` re-reads them); writes the Ocean export scripts |
| `check_results.py` | real | result CSV vs vectors/golden; `--lint`, `--self-test`, `--all` |
| `kit_common.py` | real | the single manifest: timing plan, instances ↔ vectors, probes, netlist/.va parsers |
| `va_emulator.py` | real | statement-by-statement Python transcription of the `.va` event math. Used only to fabricate self-test exports and to show the `.va` arithmetic reproduces the vectors. It is not a simulator |

Generated files go to `build/` (`stim/`, `ocean/`, `raw/`, `results/`,
`log/`). Delete the directory freely. The netlists refer to `build/stim/*.pwl`
relative to this directory, which is why `run_all.sh` always `cd`s here.

## Timing plan (shared by netlists, stimuli, export and checker)

| Symbol | Value | Meaning |
|---|---|---|
| `T_REF` | 250 ps | 4 GHz reference; 512 cycles, `tstop` = 128 ns |
| `T_EDGE` | 10 ps | rising-edge *k* of `ref_clk` crosses 0.5 V at `k·T_REF + 10 ps` (1 ps ramps) |
| `T_CODE` | 20 ps | PWL code *k* ramps (1 ps) at `k·T_REF + 20 ps` (clock-to-q after the edge) |
| `T_SKEW` | 62.5 ps | reverse-scheduler clock = `ref_clk` + T_REF/4, so R_FB has settled when it is sampled (VERILOGA_USAGE rule 2) |
| `T_ARM_DTC` / `W_DTC` | 100 ps / 120 ps | DTC trigger crossing / high time. The high time is longer than the largest delay (~90 ps with nominal taps); see suspected issue 2 |
| `T_STROBE` | 200 ps | `'v'` columns are sampled at `k·T_REF + 200 ps`, after every output has settled and before the next edge |
| ILO trigger | `k·T_REF + T_vco + u_dig[k]·T_vco` | `u_dig = ((32·j_INJ + c_INJ) mod 256)/256` from the committed CSV, `T_vco = 1/f0`; 10 ps pulse |

`check_results.py --lint` checks that every netlist value matches these
numbers (`parameters` lines, pulse-source crossing instants, `tran stop`).

## Export: the exact command and the CSV contract

`gen_stimulus.py --all` writes `build/ocean/export_tb_<tb>.ocn`. `run_all.sh`
runs each one as:

```
ocean -nograph -restore build/ocean/export_tb_<tb>.ocn < /dev/null
```

Each script opens `build/raw/tb_<tb>.raw` (`openResults`, `selectResult('tran)`).
It then writes `build/results/tb_<tb>.csv` with **one row per reference cycle
k = 0..511**:

```
k,t_s,<col>,<col>,...
```

* **`'v'` columns.** `value(v("<net>") t_s)` with `t_s = k·T_REF + T_STROBE`.
  This samples each code/debug output once per edge, after it has settled.
* **`'cross'` columns.** `cross(v("<net>") 0.5 k+1 'rising)` gives the time
  of the (k+1)-th rising 0.5 V crossing. Used for `trig`, `inj` and the DTC
  outputs. Missing crossings are written as `nan`.

If `selectResult('tran)` fails, run `results()` in Ocean to list the result
names and change `resName` in the script. The checker needs only this CSV.
Any other exporter works if it writes the same columns. The column list is
`kit_common.probes(tb)`, and the header line of each `.ocn` repeats it. To
run one bench by hand:

```
python3 gen_stimulus.py --all --verify
spectre tb_dtc_nonideal_model.scs -format psfbin -raw build/raw/tb_dtc_nonideal_model.raw =log build/log/dtc.log
ocean -nograph -restore build/ocean/export_tb_dtc_nonideal_model.ocn < /dev/null
python3 check_results.py --tb dtc_nonideal_model --result build/results/tb_dtc_nonideal_model.csv
```

## What PASS means

`check_results.py` exits 0 only when every compared sample of every check is
within tolerance. Otherwise it exits 1 and prints the first mismatch (k,
column, measured, expected, source); exit 2 means the input is malformed.
Per bench:

| Bench | Compared per edge (512 rows) | Expected from | Default tolerance |
|---|---|---|---|
| fractional | `n_int`, `m_FB`, `c_FB`, `R_FB` codes; `s_ideal`, `x_frac` | committed CSV / JSON | codes: rounded value **equal**, and \|V − integer\| ≤ 0.25 LSB; floats 1e-6 |
| reverse | `j_INJ`, `c_INJ`, `R_INJ` codes; `u_INJ_digital`; stimulus `rfb_pwl`, `fps_r_fb` | committed CSV / JSON | same |
| DTC | delay = t_cross(out) − t_cross(trig) − t_rise/2 vs `u_INJ_analog[k]·T_vco`; stimulus codes; trig timing | committed JSON (`dtc_tap`, `dtc_ideal`), golden re-run (`dtc_gain`, `dtc_inl`) | 10 fs (impairments under test: 97 fs gain, 160 fs INL, 222 fs tap) |
| injection | `e_inj_dbg`, `dtheta_dbg`, `theta_dbg`; trigger timing | golden `run_dynamics`, noise off, ε corrected (below) | 5e-4 rad (≈ 6.4 fs at 12.52 GHz) |

On the scheduler benches, PASS means the `.va` event code *and* the
simulator's event handling reproduce the golden model **bit-exactly** on
every edge of these configurations. That covers the half-up nearest
quantizer, floor, the ef1 state, the seeded Mode-B ef1 (`e_q_init`), the
latency pipeline with and without look-ahead, the `n_int` look-ahead, and the
skewed inter-module hand-off. On the DTC and injection benches, PASS means
the delay and kick equations reproduce the golden numbers within the timing
accuracy shown.

Notes on the comparison:

* The last row's `n_int` is skipped. The Python vectors pad it with the
  previous value; the `.va` computes the true `I[512] − I[511]`, which
  differs for `n3p125_nearest` (4 vs 3).
* `rev_lb` and `rev_la` reproduce the two latency vectors, which are Mode D
  in Python, through the Mode-A code path. For the stateless nearest
  quantizer, `Q(256·wrap01(−x)) mod 256 = (−Q(256·x)) mod 256` except at exact
  half-LSB ties, and these vectors contain none (`va_emulator` agrees on all
  512 rows). The start-up fill of the `.va` pipeline (R_INJ = 0) also equals
  Python's clamped command 0 here.
* `dtc_gain` / `dtc_inl` are compared with a golden re-run because the
  committed `n3p125_dtc_gain_1pct` is degenerate for this purpose. At
  N = 3.125 with naive mapping `c_INJ ≡ 0` on every row, so the 1 % gain never
  acts, and its `u_INJ_analog` is identical to `n3p125_nearest`. The re-run
  uses the `n3p130_nearest` codes (c_INJ 0..31, so the gain effect reaches
  up to 96.7 fs) and asserts that the golden codes equal the stimulus codes.
* `t_d_min` clamp: zero code on tap 0 gives t_d = 0, which the `.va` clamps
  to 1 fs. That is inside the 10 fs tolerance.

### Injection-bench expectation (continuous time vs the discrete map)

`n3p130_dynamics_sin` includes VCO white noise (σ = 0.01 rad), which the
deterministic `.va` cannot reproduce. The expected values therefore come from
the golden recursion `model/python/injection_dynamics.run_dynamics` with
noise off. In the `.va`, the free-running phase is `idtmod(f0+Δf)`, and a
trigger at `t_k` samples
`φ = (f0+Δf)·t_k = N·k + 1 + u_dig[k] + Δf·t_k` (mod 1). Define
`Θ := 2π·θ_c + 2π·Δf·(k+1)·T_REF`. The `.va` recursion is then exactly the
golden recursion (MODEL_SPEC §14) with

```
epsilon_hw[k]  ->  epsilon_hw[k] + 2*pi*delta_f*(t_k - (k+1)*T_REF)
theta_dbg[k]    =  wrapRadians(theta_plus[k] - 2*pi*delta_f*(k+1)*T_REF)
```

The correction is the detuning phase that accrues while the pulse waits
inside its cycle. It reaches 1.07e-3 rad here, larger than the tolerance, so
it is applied rather than ignored. Verified here: the VA-literal emulation
and the corrected golden recursion agree to 4.3e-12 rad. Without the
correction they differ by 1.07e-3 rad. The committed noisy vector differs
from the noise-free result by up to 0.048 rad (information only; not
checked). `ilo_lin` cannot be distinguished from `ilo_sin` in this regime:
|e| ≤ 0.017 rad, so −K·e and −K·sin e differ by < 4e-7 rad.

## What is NOT covered

* **Noise and jitter of any kind.** The `.va` models have no PRNG (mulberry32
  parity is impossible). VCO/reference/pulse noise, DNL and dither stay in
  the Python model.
* **PDR/PRC realism.** The injection kick is the behavioral §14 map. PASS
  says nothing about a real shorting-switch ILO; that needs transistor-level
  PSS/PDR extraction (MODEL_SPEC §20).
* **Features the benches do not exercise:** `map_mode = 1` (nearest-phase
  decode; no committed vector uses it), LUT INL / route skew / calibrated
  mapping, `mash11` / `mash111` / dither / `dsm_only` / `qnc` (not
  implemented in Verilog-A), `out_mode = 1` square VCO output, `vco_out`
  waveform quality, the DTC falling-edge delay, and `r_zero ≠ 0`.
* **The closed all-behavioral chain** (scheduler → DTC → ILO). Each bench
  isolates one model behind exact stimuli. Close the loop afterwards, per
  `VERILOGA_USAGE.md` (bring-up step 3, hookup rule 3).
* **Long runs.** Benches run 512 cycles; see suspected issue 1 for what
  happens after about 2000 cycles.
* Simulator-tolerance studies, and simulators other than Spectre.

## Bring-up order

1. **Without a simulator** (any machine): `python3 check_results.py --lint`
   and `python3 check_results.py --self-test`. Both must PASS.
2. `./run_all.sh fractional_phase_scheduler`. It needs no stimulus files and
   exercises AHDL compile, `cross`, `initial_step` and `transition` on the
   simplest model.
3. `./run_all.sh reverse_injection_scheduler`. Adds a PWL source and a
   two-module hand-off on a skewed clock.
4. `./run_all.sh dtc_nonideal_model`. Variable-delay `transition()` and
   femtosecond timing.
5. `./run_all.sh pulsed_injection_phase_model`. `idtmod`, `$bound_step`, and
   phase accuracy.
6. Only then build the full chain (VERILOGA_USAGE.md "Suggested bring-up
   sequence").

### Diagnosing a FAIL

* **Spectre parse/elaboration error.** The `.va` files were never compiled;
  fix the `.va` or the netlist, and report what changed.
* **Every code mismatches at the same k** (e.g. from k = 1) **and matches the
  previous row.** This is an event-ordering or sampling problem (the
  `same_edge_race` / `one_cycle_skew` self-test cases show this signature).
  Check clock skew.
* **A code whose \|V − integer\| > 0.25.** The export sampled during a ramp;
  check `T_STROBE` against the actual edge times.
* **DTC delay off by the same amount on every row.** About 0.5 ps means the
  `transition()` delay/ramp semantics differ from the LRM reading used here
  (crossing at start + t_rise/2). A few fs means `cross()` event-location
  tolerance; try tighter transient tolerances before widening `--tol-delay-fs`.
* **DTC `nan` crossings.** The output edge was lost; see suspected issue 2.
* **Injection error growing linearly with k** points to a frequency mismatch
  (`f0`, `delta_f`). A constant offset points to the phase origin (`idtmod`
  initial condition, the `T_vco` trigger offset). Small random errors point
  to event-timing tolerance (1 fs ≈ 7.9e-5 rad).

## Measured outputs of the runnable parts (this checkout)

`python3 gen_stimulus.py --all --verify` (abridged): six PWL files. Code
PWLs: values equal `code[k]` exactly at the consumer instant and at the
strobe, and no breakpoint lies within ±10 ps of either. Trigger PWL: 512
pulses with crossings exactly at `t_k`, offsets 79.872–158.808 ps, and every
pulse lands on phase `x_k + u_k` (|err| ≤ 1e-9 cycle). `stimulus
verification: PASS`.

`python3 check_results.py --self-test`:

```
[lint] netlists vs manifest vs .va ports/params vs vector configs: PASS
[fractional_phase_scheduler]   emulator_exact PASS (code 0 LSB; float 2.3e-13 = %.15e CSV rounding)
  matching+noise PASS; corrupt lsb_glitch FAIL (k=137 fps_a_c_fb 16 vs 15);
  corrupt one_cycle_skew FAIL (k=7 fps_b_n_int 3 vs 4)
[reverse_injection_scheduler]  emulator_exact PASS (code 0 LSB; float 0)
  matching+noise PASS; corrupt same_edge_race FAIL (k=1 rev_chain_j 0 vs 6);
  corrupt ef1_unseeded FAIL (k=1 rev_b_c 30 vs 31)
[dtc_nonideal_model]           emulator_exact PASS (delay 1.000 fs = t_d_min clamp)
  matching+noise PASS; corrupt gain_missing FAIL (k=1 69.576186 vs 69.672898 ps);
  corrupt nominal_taps_missing FAIL (k=1 0.222 vs 70.222 ps)
[pulsed_injection_phase_model] emulator_exact PASS (rad 4.3e-12)
  matching+noise PASS; corrupt k_inj_0p2 FAIL (k=2 e_inj -8.74e-3 vs -9.71e-3 rad);
  corrupt kick_glitch FAIL (k=300)
[input] truncated CSV: status 2 (expected 2)
SELF-TEST PASS
```

"emulator_exact" is the evidence that the `.va` *arithmetic as written*
reproduces the committed vectors and golden model at every edge. It does not
cover simulator behavior, which only the Spectre run tests.

## Suspected `.va` issues found while building the kit (reported, not fixed)

The `.va` sources were not modified.

1. **`pulsed_injection_phase_model.va`: waveform glitch when `theta_c`
   wraps.** `theta_c` is kept wrapped to (−0.5, 0.5] cycle and smoothed by
   `transition(theta_c, 0, t_kick, t_kick)`. When it wraps, the ±1-cycle
   step is ramped over `t_kick` = 0.1 ps, so `vco_out` sweeps one extra full
   cycle almost instantly. With `out_mode = 1`, this also produces two
   spurious `cross(xs)` edges. In lock with Δf ≠ 0, `theta_c` drifts by
   −Δf·T_REF cycles per reference cycle (−2.5e-4 at 1 MHz; −0.127 cycle after
   512 cycles here), so it wraps after about 2000 cycles (≈ 0.5 µs). The
   `e_inj` computation is unaffected because it uses the unsmoothed
   `theta_c`. Any consumer that counts `vco_out` edges (a divider in a closed
   loop) would miscount. These 512-cycle benches do not reach the wrap. Fix
   idea: smooth an unwrapped accumulator, and wrap only inside `sin()` and
   the `e_cyc` computation.
2. **`dtc_nonideal_model.va`: the falling edge reuses the same `transition()`
   delay while the rising transition may still be pending.** The header
   argues that this is safe because t_d ≤ ~25 ps. Hookup rule 3, however,
   folds the nominal tap phase into `tap0..tap7`, so t_d reaches ~90 ps,
   longer than the 5–20 ps injection pulses (`pulse_width` 5 ps). The LRM
   `transition()` is not a transport delay: a new target issued while an
   earlier delayed transition has not started may cancel or merge with it,
   depending on the tool. The output pulse can then be lost or shortened.
   This bench avoids the case with a 120 ps trigger high time. Fix idea:
   schedule both output edges from the rising event (`timer()` at
   `t + t_d` and `t + t_d + width`), or require width > max t_d.
3. **Vector observation, not a `.va` bug.** `n3p125_dtc_gain_1pct` cannot
   detect a DTC gain error, because `c_INJ ≡ 0` (see above). The 200 fs
   figure of Test 7 is analytic and is not exercised by any committed vector.
