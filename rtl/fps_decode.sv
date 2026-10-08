// -----------------------------------------------------------------------------
// fps_decode.sv -- command decode from the QUANTIZED absolute code
//                  (combinational)
//
// Contract: MODEL_SPEC.md section 4 [EXACT] (feedback decode) and
//           section 7 Mode D [EXACT] (quantize once + modular reverse).
//
//   I_FB[k]  = floor(A_FB[k] / 256)          R_FB[k] = A_FB[k] mod 256
//   n_int[k] = I_FB[k+1] - I_FB[k]           (integer divider action)
//   R_INJ[k] = (R_zero - R_FB[k]) mod 256    (modular reverse)
//
// n_int is derived from the quantized code of BOTH indices k and k+1, so a
// rounding carry out of the 8 fractional-cycle bits (nearest / ef1) moves
// into the integer divider command exactly as in the golden model.
//
// The absolute code is kept modulo 2^(IW+8); the subtraction below is
// modulo 2^IW, which equals the true I_FB difference whenever
// 0 <= n_int < 2^IW (always true for N + 1 < 2^IW).
// -----------------------------------------------------------------------------
`default_nettype none

module fps_decode #(
    parameter int IW = 4     // integer-cycle bits kept (n_int width)
) (
    input  wire logic [IW+7:0] a_cur,    // A_FB[k]   mod 2^(IW+8)
    input  wire logic [IW+7:0] a_nxt,    // A_FB[k+1] mod 2^(IW+8)
    input  wire logic [7:0]    r_zero,   // modular-reverse zero offset R_zero
    output      logic [IW-1:0] n_int,    // I_FB[k+1] - I_FB[k]
    output      logic [7:0]    r_fb,     // R_FB[k]
    output      logic [7:0]    r_inj     // (R_zero - R_FB[k]) mod 256
);

    assign n_int = a_nxt[IW+7:8] - a_cur[IW+7:8];
    assign r_fb  = a_cur[7:0];
    assign r_inj = r_zero - a_cur[7:0];

endmodule

`default_nettype wire
