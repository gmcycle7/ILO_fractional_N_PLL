#!/usr/bin/env bash
# =============================================================================
# run_all.sh -- one-command Spectre validation of the four Verilog-A models
#
#   STATUS: UNRUN. This script has never been executed against Spectre or
#   Ocean (none was available where it was written). Only its Python steps
#   (gen_stimulus.py, check_results.py) and its shell plumbing (with stub
#   spectre/ocean executables) were exercised. Expect to fix first-run issues.
#
# Usage (from anywhere):
#   model/veriloga/validation/run_all.sh                 # all four benches
#   model/veriloga/validation/run_all.sh dtc_nonideal_model   # a subset
#
# Steps per run:
#   1. python3 gen_stimulus.py --all --verify   (PWL stimuli + Ocean scripts)
#   2. python3 check_results.py --lint          (netlists vs manifest vs vectors)
#   per bench:
#   3. spectre tb_<tb>.scs -format psfbin -raw build/raw/tb_<tb>.raw
#   4. ocean -nograph -restore build/ocean/export_tb_<tb>.ocn  -> CSV
#   5. python3 check_results.py --tb <tb> --result build/results/tb_<tb>.csv
#
# Environment overrides:
#   SPECTRE (default: spectre)   OCEAN (default: ocean)   PYTHON (default: python3)
#   SPECTRE_ARGS  extra spectre arguments, e.g. "+aps" or "-64"
#   CHECK_ARGS    extra checker arguments, e.g. "--tol-delay-fs 20"
#
# Exit status: 0 = every selected bench PASS, 1 = at least one FAIL,
#              2 = setup/tool error (missing tool, simulator/export failure).
# Outputs (all under model/veriloga/validation/build/, safe to delete):
#   stim/ ocean/ raw/ results/ log/
# The netlists reference build/stim/*.pwl relative to this directory, so the
# script always runs from here and the build directory name is fixed.
# =============================================================================
set -u

cd "$(dirname "$0")" || exit 2

PYTHON=${PYTHON:-python3}
SPECTRE=${SPECTRE:-spectre}
OCEAN=${OCEAN:-ocean}
SPECTRE_ARGS=${SPECTRE_ARGS:-}
CHECK_ARGS=${CHECK_ARGS:-}
BUILD=build
ALL_TBS="fractional_phase_scheduler reverse_injection_scheduler dtc_nonideal_model pulsed_injection_phase_model"
TBS=${*:-$ALL_TBS}

for tb in $TBS; do
    if [ ! -f "tb_${tb}.scs" ]; then
        echo "ERROR: unknown bench '$tb' (valid: $ALL_TBS)"
        exit 2
    fi
done
for tool in "$PYTHON" "$SPECTRE" "$OCEAN"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: '$tool' not found in PATH (set SPECTRE/OCEAN/PYTHON)"
        exit 2
    fi
done

echo "== [1] stimulus + Ocean export scripts"
"$PYTHON" gen_stimulus.py --all --verify --build "$BUILD" || { echo "ERROR: stimulus generation"; exit 2; }
echo "== [2] netlist lint"
"$PYTHON" check_results.py --lint || { echo "ERROR: lint failed -- netlists out of sync with kit_common.py"; exit 2; }

overall=0
summary=""
for tb in $TBS; do
    log_sp="$BUILD/log/tb_${tb}.spectre.log"
    log_oc="$BUILD/log/tb_${tb}.ocean.log"
    log_ck="$BUILD/log/tb_${tb}.check.log"
    raw="$BUILD/raw/tb_${tb}.raw"
    csv="$BUILD/results/tb_${tb}.csv"
    t0=$(date +%s)

    echo "== [3] spectre tb_${tb}.scs"
    rm -rf "$raw"
    # shellcheck disable=SC2086
    "$SPECTRE" "tb_${tb}.scs" -format psfbin -raw "$raw" =log "$log_sp" $SPECTRE_ARGS
    rc=$?
    if [ $rc -ne 0 ]; then
        echo "   spectre exited $rc -- see $log_sp"
        summary="$summary\n  tb_${tb}: SIMULATOR ERROR (spectre rc=$rc, $log_sp)"
        overall=2
        continue
    fi

    echo "== [4] ocean export -> $csv"
    rm -f "$csv"
    "$OCEAN" -nograph -restore "$BUILD/ocean/export_tb_${tb}.ocn" < /dev/null > "$log_oc" 2>&1
    if [ ! -s "$csv" ]; then
        echo "   no CSV written -- see $log_oc"
        summary="$summary\n  tb_${tb}: EXPORT ERROR ($log_oc)"
        overall=2
        continue
    fi

    echo "== [5] check"
    # shellcheck disable=SC2086
    "$PYTHON" check_results.py --tb "$tb" --result "$csv" $CHECK_ARGS > "$log_ck" 2>&1
    rc=$?
    cat "$log_ck"
    t1=$(date +%s)
    case $rc in
        0) verdict="PASS" ;;
        1) verdict="FAIL"; [ $overall -eq 0 ] && overall=1 ;;
        *) verdict="CHECK ERROR (rc=$rc)"; overall=2 ;;
    esac
    summary="$summary\n  tb_${tb}: $verdict ($((t1 - t0)) s, $log_ck)"
done

echo "== summary"
printf "%b\n" "$summary"
exit $overall
