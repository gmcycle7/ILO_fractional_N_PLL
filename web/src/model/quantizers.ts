/**
 * Final phase quantizers.
 *
 * Contract: MODEL_SPEC.md section 6 [EXACT].
 * Mirror of model/python/dsm_first_order.py, model/python/mash11.py and the
 * quantizer classes in model/python/feedback_scheduler.py.
 */

import type { Mulberry32 } from './rng';
import type { Quantizer as QuantizerName } from './config';

export interface QuantizerState {
  quantize(u: number): number;
  readonly state: number;
}

class FloorQuantizer implements QuantizerState {
  readonly state = 0.0;
  quantize(u: number): number {
    return Math.floor(u);
  }
}

class NearestQuantizer implements QuantizerState {
  readonly state = 0.0;
  quantize(u: number): number {
    return Math.floor(u + 0.5);
  }
}

/** Truncation: identical to floor for non-negative inputs (spec item 3). */
class TruncateQuantizer implements QuantizerState {
  readonly state = 0.0;
  quantize(u: number): number {
    return Math.floor(u);
  }
}

/**
 * First-order error-feedback DSM quantizer (``ef1``), spec section 6 item 4:
 *
 *     state e (init 0)
 *     v = u + e
 *     y = floor(v)
 *     e = v - y        # e in [0, 1)
 */
export class ErrorFeedbackFirstOrder implements QuantizerState {
  private e = 0.0;

  reset(): void {
    this.e = 0.0;
  }

  quantize(u: number): number {
    const v = u + this.e;
    const y = Math.floor(v);
    this.e = v - y;
    return y;
  }

  /** Current error-feedback state e in [0, 1). */
  get state(): number {
    return this.e;
  }
}

/**
 * MASH 1-1 phase quantizer, spec section 6 item 5:
 *
 *     M = floor(u); f = u - M
 *     acc1 += f;    c1 = floor(acc1); acc1 -= c1
 *     acc2 += acc1; c2 = floor(acc2); acc2 -= c2
 *     y = M + c1 + (c2 - c2_prev);  c2_prev = c2
 *
 * (acc1, acc2, c2_prev init 0)
 */
export class Mash11 implements QuantizerState {
  private acc1 = 0.0;
  private acc2 = 0.0;
  private c2Prev = 0;

  reset(): void {
    this.acc1 = 0.0;
    this.acc2 = 0.0;
    this.c2Prev = 0;
  }

  quantize(u: number): number {
    const m = Math.floor(u);
    const f = u - m;
    this.acc1 += f;
    const c1 = Math.floor(this.acc1);
    this.acc1 -= c1;
    this.acc2 += this.acc1;
    const c2 = Math.floor(this.acc2);
    this.acc2 -= c2;
    const y = m + c1 + (c2 - this.c2Prev);
    this.c2Prev = c2;
    return y;
  }

  /** First-stage accumulator (reported as dsm_state). */
  get state(): number {
    return this.acc1;
  }
}

/** Fresh (independent-state) quantizer instance. */
export function makeQuantizer(name: QuantizerName): QuantizerState {
  switch (name) {
    case 'floor':
      return new FloorQuantizer();
    case 'nearest':
      return new NearestQuantizer();
    case 'truncate':
      return new TruncateQuantizer();
    case 'ef1':
      return new ErrorFeedbackFirstOrder();
    case 'mash11':
      return new Mash11();
    default:
      throw new Error(`unknown quantizer '${name as string}'`);
  }
}

/**
 * Optional triangular dither (spec section 6 item 6), added pre-quantize:
 * u' = u + d_amp * (U1 + U2 - 1), U from the named PRNG stream.
 */
export function triangularDither(ditherAmpLsb: number, stream: Mulberry32): number {
  return ditherAmpLsb * (stream.next() + stream.next() - 1.0);
}
