"""Pipeline latency and look-ahead.

Contract: MODEL_SPEC.md section 13 [EXACT].

A command computed at cycle c is applied at cycle c + L (+ random extra
latency of 1 cycle with probability p_late, drawn from the 'lat' stream).

- lookahead=True (correct): the scheduler anticipates L, so the command
  applied at cycle k was computed from state s_ideal[k - extra] (the fixed L
  is fully compensated; only the un-anticipated random extra latency leaks).
- lookahead=False (bug mode): the command applied at cycle k was computed
  from state s_ideal[k - L - extra]; phase error = wrapCycles(L*alpha).

Start-up: for k where the index would be negative it is clamped to 0
(pipeline pre-filled with the k=0 command).

[Resolved ambiguity: random extra latency is drawn once per applied cycle
(behavioral simplification of per-command transport with possible collisions);
p_late defaults to 0 so digital vectors are unaffected.]
"""

import numpy as np


def apply_latency(cfg, n: int, lat_stream=None) -> dict:
    """Map applied cycle k -> state index of the command in effect at k.

    Returns dict with:
        idx        : state index (into the computed-domain command arrays)
        k_computed : cycle the command was computed at   = k - L - extra
        k_intended : cycle the command was intended for
                     (lookahead: k - extra; bug: k - L - extra)
        k_applied  : k
        seq_id     : unique id of the applied command (== idx)
        metadata   : list of per-cycle dicts {k_computed, k_intended,
                     k_applied, seq_id}
    """
    ks = np.arange(n, dtype=np.int64)
    extra = np.zeros(n, dtype=np.int64)
    if cfg.p_late > 0.0 and lat_stream is not None:
        for k in range(n):
            if lat_stream.next() < cfg.p_late:
                extra[k] = 1

    L = int(cfg.latency_cycles)
    k_computed = np.clip(ks - L - extra, 0, None)
    if cfg.lookahead:
        idx = np.clip(ks - extra, 0, None)
        k_intended = idx.copy()
    else:
        idx = k_computed.copy()
        k_intended = k_computed.copy()

    seq_id = idx.copy()
    metadata = [
        {"k_computed": int(k_computed[k]), "k_intended": int(k_intended[k]),
         "k_applied": int(k), "seq_id": int(seq_id[k])}
        for k in range(n)
    ]
    return {
        "idx": idx,
        "k_computed": k_computed,
        "k_intended": k_intended,
        "k_applied": ks,
        "seq_id": seq_id,
        "extra": extra,
        "metadata": metadata,
    }
