// -----------------------------------------------------------------------------
// fps_quantizer.sv -- final phase quantizer (combinational, fixed point)
//
// Contract: MODEL_SPEC.md section 6 [EXACT], modes `nearest`, `floor`, `ef1`.
//
// The input is the unquantized absolute fine code in unsigned fixed point
// UQ(CW).F : CW integer bits (1 LSB = 1/256 VCO cycle) and F fractional
// sub-LSB bits.  All arithmetic is modulo 2^(CW+F), which is exact for the
// decode in fps_decode.sv (only differences / low bits of the code are used).
//
//   nearest : y = floor(u + 0.5)          -> add 2^(F-1), drop F bits
//   floor   : y = floor(u)                -> drop F bits
//   ef1     : v = u + e ; y = floor(v) ; e = v - y   (first-order error
//             feedback; the residual e in [0,1) is exactly the F dropped bits)
//
// q_mode encoding (shared by every module of this reference design):
//   2'd0 nearest, 2'd1 floor, 2'd2 ef1, 2'd3 reserved (behaves as floor).
//
// Plain synthesizable SystemVerilog-2012 subset (accepted by
// `yosys read_verilog -sv`): logic / always_comb / parameters only.
// -----------------------------------------------------------------------------
`default_nettype none

module fps_quantizer #(
    parameter int F  = 24,   // fractional sub-LSB bits (F >= 1)
    parameter int CW = 12    // integer (fine-code) bits kept
) (
    input  wire logic [CW+F-1:0] a,       // unquantized code, UQ(CW).F
    input  wire logic [F-1:0]    e_in,    // ef1 residual carried in  (UQ0.F)
    input  wire logic [1:0]      q_mode,  // 0 nearest, 1 floor, 2 ef1
    output      logic [CW-1:0]   y,       // quantized code (mod 2^CW)
    output      logic [F-1:0]    e_out    // ef1 residual carried out (0 if not ef1)
);

    localparam logic [1:0] Q_NEAREST = 2'd0;
    localparam logic [1:0] Q_EF1     = 2'd2;

    // 0.5 LSB in UQ(CW).F
    localparam logic [CW+F-1:0] HALF = {{(CW+F-1){1'b0}}, 1'b1} << (F - 1);

    logic [CW+F-1:0] off;
    logic [CW+F-1:0] v;

    always_comb begin
        case (q_mode)
            Q_NEAREST: off = HALF;
            Q_EF1:     off = {{CW{1'b0}}, e_in};
            default:   off = '0;               // floor (and reserved 2'd3)
        endcase
        v = a + off;
    end

    assign y     = v[CW+F-1:F];
    assign e_out = (q_mode == Q_EF1) ? v[F-1:0] : '0;

endmodule

`default_nettype wire
