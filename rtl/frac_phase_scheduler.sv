// -----------------------------------------------------------------------------
// frac_phase_scheduler.sv -- fractional-N phase scheduler (digital reference)
//
// Synthesizable reference RTL of the digital scheduler of MODEL_SPEC.md:
//   section 3  ideal trajectory        A_ideal[k] = 256 * k * N
//   section 6  final phase quantizer   nearest | floor | ef1
//   section 4  feedback decode         n_int / m_FB / c_FB / R_FB
//   section 7  Mode D modular reverse  R_INJ = (R_zero - R_FB) mod 256
//   section 8  naive injection decode  j = R_INJ[7:5], c = R_INJ[4:0]
//   section 13 correct look-ahead      LAT pipeline stages, accumulator
//                                      pre-advanced by LAT
//
// Verified BIT-EXACT against the Python golden model (model/python) with
// rtl/run_sim.py; see RTL_USAGE.md.
//
// Fixed point
// -----------
//   FCW = round(N * 256 * 2^F)            (phase increment per reference cycle)
//   ACC[j] = j * FCW  (mod 2^W),  W = IW + 8 + F,  format UQ(IW+8).F
//     [W-1 : 8+F]  IW bits   integer VCO cycles (modulo 2^IW)
//     [8+F-1 : F]  8 bits    fine code, 1 LSB = 1/256 VCO cycle
//     [F-1 : 0]    F bits    sub-LSB fraction
//
// Timing / cycle convention
// -------------------------
//   `en` is the reference-cycle strobe (tie high when clk IS the reference
//   clock).  "Reference cycle k" is the state after exactly k strobes since
//   reset release.  For every k >= LAT the outputs equal the golden-model
//   command of state k (seq_id == k) and `valid` is 1.  For k < LAT the
//   pipeline is still filling: `valid` is 0 and the command outputs are 0.
//
//   Internally the core runs LAT cycles ahead: after reset its state index is
//   j = LAT (accumulator, quantizer residual and seq counter are loaded with
//   their closed-form values for index LAT), and the command of index j is
//   delayed by LAT register stages, so it emerges at reference cycle j.
//
//   With LAT = 0 the outputs are a combinational decode of the state
//   registers; with LAT >= 1 every output comes straight from a flop.
//
// Configuration inputs (fcw, q_mode, r_zero) are quasi-static: they must be
// stable while rst is asserted and are assumed constant afterwards (the
// closed-form pre-advance assumes a constant FCW).
//
// Plain synthesizable SystemVerilog-2012 subset (accepted by
// `yosys read_verilog -sv`): logic / always_ff / always_comb / parameters.
// Synchronous active-high reset.  Single clock domain.
// -----------------------------------------------------------------------------
`default_nettype none

module frac_phase_scheduler #(
    parameter int F    = 24,  // fractional sub-LSB bits of the fine code (>= 1)
    parameter int IW   = 4,   // integer-cycle bits kept (n_int width, N+1 < 2^IW)
    parameter int LAT  = 0,   // look-ahead pipeline latency, 0..8 register stages
    parameter int SEQW = 16   // seq_id counter width (wraps modulo 2^SEQW)
) (
    input  wire logic              clk,
    input  wire logic              rst,     // synchronous, active high
    input  wire logic              en,      // one strobe per reference cycle
    input  wire logic [IW+8+F-1:0] fcw,     // round(N * 256 * 2^F), UQ(IW+8).F
    input  wire logic [1:0]        q_mode,  // 0 nearest, 1 floor, 2 ef1
    input  wire logic [7:0]        r_zero,  // modular-reverse zero offset R_zero
    output      logic              valid,   // 1 once the LAT pipeline has filled
    output      logic [IW-1:0]     n_int,   // integer divider action I[k+1]-I[k]
    output      logic [1:0]        m_fb,    // feedback PMUX code   = R_FB[7:6]
    output      logic [5:0]        c_fb,    // feedback DTC code    = R_FB[5:0]
    output      logic [7:0]        r_fb,    // feedback fine code   R_FB
    output      logic [7:0]        r_inj,   // injection fine code  R_INJ
    output      logic [2:0]        j_inj,   // injection tap (naive)= R_INJ[7:5]
    output      logic [5:0]        c_inj,   // injection DTC (naive)= R_INJ[4:0]
    output      logic [SEQW-1:0]   seq_id   // index k of the presented command
);

    // ------------------------------------------------------------------
    // derived widths
    // ------------------------------------------------------------------
    localparam int CW = IW + 8;                 // quantized code width
    localparam int W  = CW + F;                 // accumulator width
    localparam int PW = 1 + IW + 8 + 8 + SEQW;  // pipelined command word

    // ------------------------------------------------------------------
    // look-ahead pre-advance constants (state index after reset = LAT)
    //   ACC[LAT+1]        = (LAT+1) * FCW
    //   ACC[LAT]          =  LAT    * FCW
    //   ef1 e[LAT-1]      = frac( FCW * sum_{i=0}^{LAT-1} i )
    //                     = frac( FCW * LAT*(LAT-1)/2 )
    // ------------------------------------------------------------------
    localparam int TRI_PREV = (LAT * (LAT - 1)) / 2;

    localparam logic [W-1:0]    K_ACC = LAT + 1;
    localparam logic [W-1:0]    K_CUR = LAT;
    localparam logic [F-1:0]    K_EF  = TRI_PREV;
    localparam logic [SEQW-1:0] K_SEQ = LAT;

    // elaboration-time parameter guard (portable: unresolved-module trick)
    generate
        if (LAT < 0 || LAT > 8) begin : g_bad_lat
            ERROR_frac_phase_scheduler_LAT_must_be_in_0_to_8 u_bad_lat ();
        end
        if (F < 1 || IW < 3) begin : g_bad_width
            ERROR_frac_phase_scheduler_needs_F_ge_1_and_IW_ge_3 u_bad_width ();
        end
    endgenerate

    // ------------------------------------------------------------------
    // core state (index j = k + LAT)
    // ------------------------------------------------------------------
    logic [W-1:0]    acc_q;     // ACC[j+1]   unquantized code of the NEXT index
    logic [F-1:0]    ef_q;      // ef1 residual e[j] (0 in nearest/floor)
    logic [CW-1:0]   a_cur_q;   // A_FB[j]    quantized absolute code
    logic [SEQW-1:0] seq_q;     // j

    // closed-form reset values for index LAT (constant-coefficient products;
    // they fold to constants for LAT = 0)
    logic [W-1:0]  acc_rst;
    logic [W-1:0]  cur_rst_u;
    logic [F-1:0]  ef_prev_rst;
    logic [CW-1:0] a_cur_rst;
    logic [F-1:0]  ef_rst;

    assign acc_rst     = K_ACC * fcw;
    assign cur_rst_u   = K_CUR * fcw;
    assign ef_prev_rst = K_EF * fcw[F-1:0];

    fps_quantizer #(.F(F), .CW(CW)) u_q_rst (
        .a      (cur_rst_u),
        .e_in   (ef_prev_rst),
        .q_mode (q_mode),
        .y      (a_cur_rst),
        .e_out  (ef_rst)
    );

    // quantizer of the look-ahead index j+1 (needed for n_int[j])
    logic [CW-1:0] a_nxt;
    logic [F-1:0]  ef_nxt;

    fps_quantizer #(.F(F), .CW(CW)) u_q_run (
        .a      (acc_q),
        .e_in   (ef_q),
        .q_mode (q_mode),
        .y      (a_nxt),
        .e_out  (ef_nxt)
    );

    always_ff @(posedge clk) begin
        if (rst) begin
            acc_q   <= acc_rst;
            ef_q    <= ef_rst;
            a_cur_q <= a_cur_rst;
            seq_q   <= K_SEQ;
        end else if (en) begin
            acc_q   <= acc_q + fcw;
            ef_q    <= ef_nxt;
            a_cur_q <= a_nxt;
            seq_q   <= seq_q + 1'b1;
        end
    end

    // ------------------------------------------------------------------
    // command decode for index j
    // ------------------------------------------------------------------
    logic [IW-1:0] n_int_c;
    logic [7:0]    r_fb_c;
    logic [7:0]    r_inj_c;

    fps_decode #(.IW(IW)) u_decode (
        .a_cur  (a_cur_q),
        .a_nxt  (a_nxt),
        .r_zero (r_zero),
        .n_int  (n_int_c),
        .r_fb   (r_fb_c),
        .r_inj  (r_inj_c)
    );

    logic [PW-1:0] cmd_core;
    assign cmd_core = {1'b1, n_int_c, r_fb_c, r_inj_c, seq_q};

    // ------------------------------------------------------------------
    // look-ahead latency pipeline: LAT register stages (section 13)
    // ------------------------------------------------------------------
    logic [PW-1:0] cmd_out;

    generate
        if (LAT == 0) begin : g_lat0
            assign cmd_out = cmd_core;
        end else begin : g_lat
            logic [LAT*PW-1:0]     pipe_q;      // [PW-1:0] newest .. top = oldest
            logic [(LAT+1)*PW-1:0] pipe_shift;

            assign pipe_shift = {pipe_q, cmd_core};

            always_ff @(posedge clk) begin
                if (rst)     pipe_q <= '0;
                else if (en) pipe_q <= pipe_shift[LAT*PW-1:0];
            end

            assign cmd_out = pipe_q[LAT*PW-1 -: PW];
        end
    endgenerate

    // ------------------------------------------------------------------
    // output field split (pure wiring)
    // ------------------------------------------------------------------
    assign valid  = cmd_out[PW-1];
    assign n_int  = cmd_out[PW-2 -: IW];
    assign r_fb   = cmd_out[SEQW+8 +: 8];
    assign r_inj  = cmd_out[SEQW   +: 8];
    assign seq_id = cmd_out[SEQW-1:0];

    assign m_fb   = r_fb[7:6];
    assign c_fb   = r_fb[5:0];
    assign j_inj  = r_inj[7:5];
    assign c_inj  = {1'b0, r_inj[4:0]};

endmodule

`default_nettype wire
