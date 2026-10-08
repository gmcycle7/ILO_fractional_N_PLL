# RTL_USAGE.md — Synthesizable Reference RTL of the Digital Scheduler

## Status (read first)

`rtl/frac_phase_scheduler.sv` is a **synthesizable SystemVerilog reference**
of the digital scheduler defined by `MODEL_SPEC.md` (§3 trajectory, §6
quantizer, §4 feedback decode, §7 Mode D modular reverse, §8 naive injection
decode, §13 correct look-ahead). It is verified **bit-exact** against the
Python golden model (`model/python/`) with a pip-only flow
(`yowasp-yosys` → CXXRTL → system C++ compiler): 50 cases × 2 passes ×
2048 reference cycles, 204 634 cycles / 1 637 072 output values compared,
zero mismatches (`python3 rtl/run_sim.py`, see §6).

It is a **reference**, not a tape-out block: single clock domain, no CDC to
the analog (DTC / PMUX / injection) domains, no DFT, no timing closure,
`ef1` only (no MASH), naive injection decode only (§9 lists everything).

The math contract is `MODEL_SPEC.md`; any numerical disagreement between the
RTL and the golden model is a bug in the RTL.

## 1. Files

| File | Purpose |
|---|---|
| `rtl/frac_phase_scheduler.sv` | top: fixed-point phase accumulator, look-ahead pre-advance, LAT pipeline, `seq_id`, output field split |
| `rtl/fps_quantizer.sv` | combinational §6 quantizer (`nearest` / `floor` / `ef1`) in fixed point |
| `rtl/fps_decode.sv` | combinational §4 / §7-D decode: `n_int`, `R_FB`, `R_INJ` from the **quantized** absolute code |
| `rtl/gen_vectors.py` | writes `rtl/vectors/*.csv` + `manifest.json` from the Python golden model (exact dyadic `N`) |
| `rtl/vectors/` | 50 committed golden vector cases, 2048 cycles each (columns `k,n_int,m_fb,c_fb,r_fb,r_inj,j_inj,c_inj,seq_id`) |
| `rtl/tb/tb_main.cc` | CXXRTL testbench (two passes: continuous `en`, then mid-run re-reset + sparse `en`) |
| `rtl/run_sim.py` | build once (yosys → CXXRTL → C++), run every case, PASS/FAIL with first mismatch, synth + `stat` |
| `rtl/synth_stat.txt` | generated cell counts (yosys generic gates) for LAT = 0 / 1 / 3 |
| `tests/test_rtl_bitexact.py` | pytest: vectors current vs golden model; all cases bit-exact; runner detects an injected mismatch (skips cleanly without the toolchain) |

## 2. Block diagram

```
                     +-----------------------------------------------------------------+
  fcw ---------------|  reset closed form (index LAT):                                 |
  (UQ(IW+8).F)       |    acc_rst = (LAT+1)*fcw      cur_rst = LAT*fcw                  |
                     |    ef_prev = frac(fcw * LAT*(LAT-1)/2)   -> fps_quantizer (rst)  |
                     +------------------+-----------------------+-------------------------+
                                        | acc_rst / a_cur_rst / ef_rst   (muxed on rst)
                                        v
            +----------+  +-------------------------------------------------------------+
  clk ----->|          |  |  STATE  (index j = k + LAT)                                 |
  rst ----->| control  |  |   acc_q   [W]   = ACC[j+1] = (j+1)*FCW  mod 2^W             |
  en  ----->| (en = 1  |  |   ef_q    [F]   = ef1 residual e[j]                          |
            |  strobe) |  |   a_cur_q [CW]  = A_FB[j]  (quantized absolute code)         |
            +----------+  |   seq_q   [SEQW]= j                                           |
                          +-----+----------------------------+------------------------+
                                |  acc_q, ef_q               |  a_cur_q
                                v                            |
                     +---------------------+                 |
  q_mode ----------->|  fps_quantizer      |  a_nxt = A_FB[j+1]
  (0 nearest,        |  v = acc + off      |  ef_nxt = e[j+1]  --> state update on en
   1 floor, 2 ef1)   |  y = v >> F         |                 |
                     +----------+----------+                 |
                                |                            |
                                v                            v
                     +------------------------------------------------+
  r_zero ----------->|  fps_decode                                     |
                     |   n_int = I(a_nxt) - I(a_cur)   (mod 2^IW)      |
                     |   r_fb  = a_cur[7:0]                           |
                     |   r_inj = (r_zero - r_fb) mod 256              |
                     +----------------------+-------------------------+
                                            | cmd(j) = {1, n_int, r_fb, r_inj, seq}
                                            v
                     +------------------------------------------------+
                     |  LAT register stages (reset to 0 -> valid = 0) |
                     +----------------------+-------------------------+
                                            | cmd(k)   (k = j - LAT)
                                            v
          valid  n_int  m_fb=r_fb[7:6]  c_fb=r_fb[5:0]  r_fb  r_inj  j_inj=r_inj[7:5]  c_inj={0,r_inj[4:0]}  seq_id
```

Per reference cycle the core produces the command of index `j` from the
quantized codes of `j` (register) and `j+1` (combinational, needed for
`n_int[j] = I_FB[j+1] − I_FB[j]`), then advances `acc_q += fcw`.

## 3. Parameters and ports

### Parameters

| Parameter | Default | Range | Meaning |
|---|---|---|---|
| `F` | 24 | ≥ 1 (16 / 24 / 32 verified) | fractional sub-LSB bits of the fine code; frequency resolution `f_ref / 2^(8+F)` |
| `IW` | 4 | ≥ 3 | integer-cycle bits kept in the accumulator (modulo `2^IW`); also the `n_int` width. Requires `N + 1 < 2^IW` |
| `LAT` | 0 | 0 … 8 (0, 1, 3, 8 verified) | look-ahead pipeline latency in reference cycles = number of output register stages |
| `SEQW` | 16 | ≥ 1 | `seq_id` counter width (wraps modulo `2^SEQW`) |

Fixed by the spec defaults (not parameterized): `G = 256` fine codes per
VCO cycle (`B_DTC = 6`, 4-phase PMUX), 8 injection taps.

Out-of-range `LAT` / `F` / `IW` fail elaboration (an instance of a
deliberately undefined module named `ERROR_frac_phase_scheduler_…`).

### Ports

| Port | Dir | Width | Meaning (spec ref) |
|---|---|---|---|
| `clk` | in | 1 | clock (reference clock, or a faster system clock with `en` strobes) |
| `rst` | in | 1 | **synchronous, active-high** reset; loads the pre-advanced state (§5) |
| `en` | in | 1 | one strobe per reference cycle (tie high when `clk` is the reference clock); state and pipeline advance only when `en = 1` |
| `fcw` | in | `IW+8+F` | frequency control word `round(N·256·2^F)`, format UQ(IW+8).F (§4) |
| `q_mode` | in | 2 | quantizer: `0` nearest (`floor(u+0.5)`), `1` floor, `2` ef1, `3` reserved (= floor) (MODEL_SPEC §6) |
| `r_zero` | in | 8 | modular-reverse zero offset `R_zero` (§7 Mode D) |
| `valid` | out | 1 | 1 once the `LAT` pipeline has filled (always 1 for `LAT = 0`) |
| `n_int` | out | `IW` | integer divider action `I_FB[k+1] − I_FB[k]` (§4); {3,4} for nearest/floor, {2,3,4} for ef1 near-integer N |
| `m_fb` | out | 2 | feedback PMUX code `floor(R_FB/64)` = `R_FB[7:6]` |
| `c_fb` | out | 6 | feedback DTC code `R_FB mod 64` = `R_FB[5:0]` |
| `r_fb` | out | 8 | feedback fine code `R_FB = A_FB mod 256` |
| `r_inj` | out | 8 | injection fine code `R_INJ = (R_zero − R_FB) mod 256` (§7 Mode D) |
| `j_inj` | out | 3 | injection tap, naive decode `floor(R_INJ/32)` = `R_INJ[7:5]` (§8) |
| `c_inj` | out | 6 | injection DTC code, naive decode `R_INJ mod 32` = `{0, R_INJ[4:0]}` (§8; lower half of the DTC range only) |
| `seq_id` | out | `SEQW` | index `k` of the presented command (§13 metadata) |

`fcw`, `q_mode`, `r_zero` are quasi-static: they must be stable while `rst`
is asserted (the pre-advance is computed from them) and are assumed constant
afterwards. With `LAT = 0` the outputs are a combinational decode of the state
registers; with `LAT ≥ 1` every output comes straight from a flop.

### Timing / cycle convention

"Reference cycle `k`" is the state after exactly `k` `en` strobes since reset
release. For every `k ≥ LAT` the outputs equal the golden-model command of
state `k` (`seq_id = k`, `valid = 1`); for `k < LAT` the pipeline is filling
(`valid = 0`, command outputs 0). The command for cycle `k` is therefore
presented *before* strobe `k` — the strobe edge that the analog actuators
consume it on — exactly like `k_applied = k` with `lookahead = True` in
`model/python/latency_pipeline.py`.

## 4. Fixed-point format and FCW

The accumulator holds the **absolute fine code** `A_ideal[k] = 256·k·N`
(MODEL_SPEC §4) in unsigned fixed point UQ(IW+8).F, width `W = IW + 8 + F`:

```
bit  [W-1 : 8+F]   IW bits   integer VCO cycles           (kept modulo 2^IW)
bit  [8+F-1 : F]    8 bits   fine code, 1 LSB = 1/256 VCO cycle = T_vco/256
bit  [F-1 : 0]      F bits   sub-LSB fraction
```

Phase increment per reference cycle (round half up, exact rational
arithmetic in `rtl/gen_vectors.py::fcw_of`):

```
FCW         = round( N · 256 · 2^F )
ACC[k]      = k · FCW  (mod 2^W)            =  256 · k · N_realized · 2^F
N_realized  = FCW / 2^(8+F)
resolution  : ΔN = 2^-(8+F)   →   Δf_vco = f_ref / 2^(8+F)
```

Quantizers (§6) on the accumulator value `u = ACC / 2^F` (LSB units):

| mode | operation on `ACC` | identical to |
|---|---|---|
| nearest | `A_FB = (ACC + 2^(F-1)) >> F` | `floor(u + 0.5)` (half-up, never banker's rounding) |
| floor | `A_FB = ACC >> F` | `floor(u)` |
| ef1 | `v = ACC + e; A_FB = v >> F; e = v mod 2^F` | `v = u + e; y = floor(v); e = v − y` with `e ∈ [0,1)` |

The rounding carry of `nearest`/`ef1` can propagate out of the 8 fine-code
bits into the integer cycle; `n_int` is taken from the **quantized** codes of
`k` and `k+1`, so this carry lands in the divider command exactly as in the
golden model (e.g. the tie case below).

### Worked example `[EXACT]` — N = 3.13, F = 24, f_ref = 4 GHz

```
N · 256 · 2^F   = 3.13 · 256 · 16 777 216 = 13 443 247 636.48
FCW             = round(13 443 247 636.48) = 13 443 247 636 = 0x3_2147_AE14   (34 bits; W = 36 with IW = 4)
N_realized      = 13 443 247 636 / 2^32 = 3.1299999998882413
f_vco realized  = N_realized · 4 GHz = 12 519 999 999.552965 Hz
frequency error = (N_realized − 3.13) · 4 GHz = −0.447035 Hz   (−0.0357 ppb)
resolution      = f_ref / 2^32 = 0.931 Hz        (F = 16: 238.4 Hz;  F = 32: 3.64 mHz)
```

Other committed cases (all `F = 24` unless noted):

| N target | FCW | N_realized | f_vco error |
|---|---|---|---|
| 3.125 (on-grid) | 13 421 772 800 = 0x3_2000_0000 | 3.125 exactly | 0 |
| 3.126953125 (half-LSB tie, `A[k] = 800.5·k`) | 13 430 161 408 = 0x3_2080_0000 | exact | 0 |
| 3.2 | 13 743 895 347 | 3.199999999953434 | −0.186 Hz |
| 3.001 (near-integer, ef1 reaches `n_int = 2`) | 12 889 196 855 | 3.000999999931082 | −0.276 Hz |
| 3.13, F = 16 | 52 512 686 | 3.1299999952316284 | −19.1 Hz |

Golden vectors are generated with the golden model's `n_div` set to the exact
dyadic `N_realized`, so every float64 operation on the digital path is exact
(asserted per case: `k·N`, `256·s`, `u + 0.5`, ef1 state all fit in 53 bits),
and the golden rows are additionally cross-checked against an independent
pure-integer reference (`gen_vectors.int_reference`) before being written.

## 5. Look-ahead (MODEL_SPEC §13)

A command computed at cycle `k` is applied at cycle `k + LAT`. Correct
look-ahead means the command applied at `k + LAT` is computed from state
`k + LAT`, so the core runs `LAT` cycles ahead of the outputs. Instead of a
warm-up, the reset loads the closed-form state of index `LAT`
(constant-coefficient products of `fcw`, they fold to constants for `LAT = 0`):

```
acc_q   = ACC[LAT+1] = (LAT+1) · FCW                        (mod 2^W)
a_cur_q = A_FB[LAT]  = Q( LAT · FCW ,  e[LAT−1] )
ef_q    = e[LAT]     = frac( FCW · LAT·(LAT+1)/2 )           (ef1)
          e[LAT−1]   = frac( FCW · LAT·(LAT−1)/2 )           (ef1 input to the reset quantizer)
seq_q   = LAT
```

(`e[k] = frac(Σ_{i≤k} u[i])` for the first-order error-feedback quantizer with
constant input increment.) The command of index `j` then passes through
`LAT` register stages (reset to 0, so `valid = 0` until they fill) and emerges
at reference cycle `j`. The verification compares `k ≥ LAT` against the
golden rows and checks `valid = 0` / zero outputs for `k < LAT`. The golden
model's applied-domain output is `LAT`-invariant under correct look-ahead
(`idx = k`), and so is the RTL's: the same vector set passes for
`LAT ∈ {0, 1, 3, 8}`.

## 6. Verification: method and how to run

```
pip3 install --user yowasp-yosys       # WASM yosys from PyPI (no brew/apt needed)
python3 rtl/gen_vectors.py --check     # committed vectors == fresh golden-model emission
python3 rtl/run_sim.py                 # build once, run all 50 cases, synth + stat
python3 -m pytest tests/test_rtl_bitexact.py -q
```

Flow of `rtl/run_sim.py`:

1. **Toolchain discovery**: yosys = `$YOSYS` → `yowasp_yosys` Python package
   (run in-process via `python -c "import yowasp_yosys; …"`, so the console
   script does not need to be on `PATH`) → `yowasp-yosys` / `yosys` on `PATH`.
   CXXRTL runtime headers = `$CXXRTL_INCLUDE` →
   `<yowasp_yosys package>/share/include/backends/cxxrtl/runtime` (the
   package ships yosys's `share/` tree; this is the directory
   `yosys-config --datdir` would point at for a native install, which is the
   fallback). C++ = `$CXX` → `c++` → `g++` → `clang++` (C++14).
2. **Build** (cached by a hash of the RTL, testbench, wrapper and yosys
   version): a generated wrapper `simtop.sv` instantiates one scheduler per
   distinct `(F, LAT)` in the manifest on shared inputs (`sel` picks the
   outputs); `read_verilog -sv; hierarchy -check; write_cxxrtl` →
   `$CXX -std=c++14 -O1 tb/tb_main.cc` (which `#include`s the generated
   `simtop.cc`).
3. **Run** every case of `rtl/vectors/manifest.json`. The testbench does two
   passes per case: (0) power-up, 1-clock synchronous reset, `en` tied high;
   (1) reset re-asserted mid-run with `en = 1` on the same edge (reset must
   win), then `en` as a sparse strobe with 0–3 pseudo-random idle clocks,
   during which the outputs must hold. Every row `k` is compared on all of
   `n_int, m_fb, c_fb, r_fb, r_inj, j_inj, c_inj, seq_id` plus `valid`.
   Output: `PASS name (cycles × signals)` or
   `FAIL name first mismatch: pass P cycle K signal S: got G expected E`.
4. **Synthesizability**: `hierarchy -check -chparam LAT {0,1,3}; synth -flatten;
   check -assert; stat -json` on the bare `frac_phase_scheduler`; latches are
   rejected; cell counts go to `rtl/synth_stat.txt`.
5. Exit code: 0 = all cases bit-exact, 1 = any mismatch, 2 = toolchain /
   build failure.

Measured on the development machine (Apple clang 21, yowasp-yosys 0.69,
warm WASM cache): yosys → CXXRTL 0.9 s, C++ compile 1.9 s (7 variants),
50 cases 4.6 s, synth 1.5 s; `pytest tests/test_rtl_bitexact.py` 5 s warm,
~10 s cold. The first ever `yowasp-yosys` invocation compiles the WASM module
(≈15–60 s, then cached by wasmtime).

Case matrix (`rtl/gen_vectors.py`): N ∈ {3.13, 3.125, 3.2, 3.126953125,
3.001} × quantizer ∈ {nearest, floor, ef1} × LAT ∈ {0, 1, 3} with
`R_zero ∈ {0, 10}` alternating (45 cases), plus LAT = 8 (ef1, nearest),
F = 16 (ef1; nearest tie) and F = 32 (ef1) — 50 cases, 2048 cycles each.
Result: **50/50 PASS, 204 634 cycles compared (2 passes × (2048 − LAT) per
case), 1 637 072 output values, 0 mismatches.** The pytest additionally
corrupts one value of a copied vector and asserts that the runner reports
`FAIL … pass 0 cycle 777 signal c_fb`.

### Sensitivity check (manual, not committed)

Changing the nearest-quantizer offset from `2^(F−1)` to `2^(F−2)` makes all
14 off-grid `nearest` cases fail at the first rounding cycle (e.g.
`n3p126953125_nearest_lat0_rz10: cycle 1 signal c_fb: got 32 expected 33`),
while the on-grid `3.125` cases still pass — i.e. the comparison is sensitive
to the §6 half-up rule and the tie vectors exercise it.

## 7. Synthesis statistics

`rtl/synth_stat.txt` (yosys 0.69 `synth -flatten`, generic gate library —
technology independent, **no timing information**), `F = 24, IW = 4, SEQW = 16`:

| | LAT = 0 | LAT = 1 | LAT = 3 |
|---|---|---|---|
| cells total | 577 | 837 | 1240 |
| flip-flops | 88 | 125 | 199 |
| combinational | 489 | 712 | 1041 |
| latches | 0 | 0 | 0 |

Flop budget: `acc_q` 36 + `ef_q` 24 + `a_cur_q` 12 + `seq_q` 16 = 88, plus
37 per pipeline stage (`1 + IW + 8 + 8 + SEQW`). The growth of the
combinational count with `LAT` is the reset-time closed-form pre-advance
(§5: two constant-coefficient products and a second quantizer instance,
all folded away for `LAT = 0`); a production design would rather accept a
`LAT`-cycle warm-up or load software-computed initial values.

## 8. Integration notes

* `clk` = reference clock, `en = 1`: one command per clock, `k` = clock index
  since reset release.
* Faster system clock: pulse `en` once per reference cycle; outputs hold
  between strobes (checked by pass 1 of the testbench).
* Use `LAT ≥ 1` if the actuator interfaces need glitch-free (flop-driven)
  outputs; `LAT = 0` exposes the combinational decode.
* `valid` gates the first `LAT` cycles after reset; `seq_id` tags each
  command with its reference-cycle index (§13 metadata) and wraps modulo
  `2^SEQW`.
* The same `R_FB → R_INJ` word goes to both actuators (Mode D), so the
  digital pair error is identically zero (§7 identity
  `(R_FB + R_INJ) mod 256 = R_zero`), also asserted in the pytest on the
  integer reference.

## 9. Limitations (explicit)

* **Reference RTL only.** Single synchronous clock domain; **no CDC** to the
  analog DTC / PMUX / injection-pulse domains, no retiming of the actuator
  interfaces, no reset synchronizer.
* **No DFT** (scan, BIST), **no timing closure** (the 36-bit accumulator +
  quantizer adder are single-cycle; a 4 GHz reference needs the `LAT`
  stages retimed into the datapath or a slower digital clock with `en`
  strobes), no power intent, no technology mapping.
* **Quantizers: nearest, floor, ef1 only — no MASH 1-1 / 1-1-1**, no dither
  (§6 items 5–7), no `dsm_only` / `qnc` actuator modes (§7.1, §7.2).
* **Mode D only** (quantize once + modular reverse); arch modes A/B/C are not
  implemented.
* **Naive injection decode only** (`j = R_INJ[7:5]`, `c = R_INJ[4:0]`); the
  nearest-phase and calibrated joint mappings of §8 are not implemented.
* `G = 256` (6-bit DTC, 4-phase PMUX), 8 taps fixed; `N + 1 < 2^IW` required
  (`IW = 4` → `N < 15`); `fcw`, `q_mode`, `r_zero` must be static from reset
  (no on-the-fly frequency hopping semantics — a changed `fcw` simply
  continues the accumulation with the new increment).
* Verified with yosys's CXXRTL semantics only (no event-driven simulator was
  available; no iverilog / Verilator / commercial tool run). Synthesizability
  is shown with yosys generic `synth`; no vendor tool, no gate-level
  simulation.
* Behavioral results are **not** silicon results (`MODEL_SPEC.md` §20).
