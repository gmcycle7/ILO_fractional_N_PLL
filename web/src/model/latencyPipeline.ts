/**
 * Pipeline latency and look-ahead.
 *
 * Contract: MODEL_SPEC.md section 13 [EXACT].
 * Mirror of model/python/latency_pipeline.py.
 *
 * A command computed at cycle c is applied at cycle c + L (+ random extra
 * latency of 1 cycle with probability p_late, drawn from the 'lat' stream).
 *
 * - lookahead=true (correct): the scheduler anticipates L, so the command
 *   applied at cycle k was computed from state s_ideal[k - extra] (the fixed
 *   L is fully compensated; only the un-anticipated random extra latency
 *   leaks).
 * - lookahead=false (bug mode): the command applied at cycle k was computed
 *   from state s_ideal[k - L - extra]; phase error = wrapCycles(L*alpha).
 *
 * Start-up: for k where the index would be negative it is clamped to 0
 * (pipeline pre-filled with the k=0 command).
 *
 * [Resolved ambiguity: random extra latency is drawn once per applied cycle
 * (behavioral simplification of per-command transport with possible
 * collisions); p_late defaults to 0 so digital vectors are unaffected.]
 */

import type { SimConfig } from './config';
import type { Mulberry32 } from './rng';

export interface LatencyMetadata {
  k_computed: number;
  k_intended: number;
  k_applied: number;
  seq_id: number;
}

export interface LatencyResult {
  idx: Int32Array;
  k_computed: Int32Array;
  k_intended: Int32Array;
  k_applied: Int32Array;
  seq_id: Int32Array;
  extra: Int32Array;
  metadata: LatencyMetadata[];
}

/**
 * Map applied cycle k -> state index of the command in effect at k.
 */
export function applyLatency(
  cfg: SimConfig,
  n: number,
  latStream: Mulberry32 | null = null,
): LatencyResult {
  const extra = new Int32Array(n);
  if (cfg.p_late > 0.0 && latStream !== null) {
    for (let k = 0; k < n; k++) {
      if (latStream.next() < cfg.p_late) {
        extra[k] = 1;
      }
    }
  }

  const L = Math.trunc(cfg.latency_cycles);
  const kApplied = new Int32Array(n);
  const kComputed = new Int32Array(n);
  const kIntended = new Int32Array(n);
  const idx = new Int32Array(n);
  const seqId = new Int32Array(n);

  for (let k = 0; k < n; k++) {
    kApplied[k] = k;
    kComputed[k] = Math.max(k - L - extra[k], 0);
    if (cfg.lookahead) {
      idx[k] = Math.max(k - extra[k], 0);
      kIntended[k] = idx[k];
    } else {
      idx[k] = kComputed[k];
      kIntended[k] = kComputed[k];
    }
    seqId[k] = idx[k];
  }

  const metadata: LatencyMetadata[] = [];
  for (let k = 0; k < n; k++) {
    metadata.push({
      k_computed: kComputed[k],
      k_intended: kIntended[k],
      k_applied: k,
      seq_id: seqId[k],
    });
  }

  return {
    idx,
    k_computed: kComputed,
    k_intended: kIntended,
    k_applied: kApplied,
    seq_id: seqId,
    extra,
    metadata,
  };
}
