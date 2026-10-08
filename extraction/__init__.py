"""PDR/PRC extraction kit (see PDR_EXTRACTION.md at the repo root).

* spectre_pdr_tb.scs  - Spectre testbench TEMPLATE (NOT RUN: no simulator was
                        available when it was written).
* run_sweep.py        - sweep driver (dry-run / render / anchor / collect /
                        synthetic).  The Spectre command lines it prints are
                        templates; --synthetic, --dry-run, --anchor and
                        --collect are real Python and tested.
* postprocess_pdr.py  - REAL, tested: raw transient-kick CSV -> MODEL_SPEC.md
                        section 14 LUT (e_inj_rad, delta_theta_rad) + report.
"""
