/**
 * Public API of the TypeScript mirror model (single compute entry point for
 * chapters — see web/ARCHITECTURE.md section 6 and web/src/model/README.md).
 *
 * The mathematical contract is MODEL_SPEC.md + ASSUMPTIONS.md at the repo
 * root; the reference implementation is model/python/.  Everything exported
 * here is pure data / pure functions (no DOM, no node imports).
 */

// units and constants (MODEL_SPEC sections 1, 9, 11)
export * from './units';

// wrap conventions and quantization primitives (section 2)
export {
  TWO_PI,
  wrap01,
  wrapCycles,
  wrapRadians,
  cyclesToTime,
  cyclesToDegrees,
  cyclesToRadians,
  timeToCycles,
  qFloor,
  qNearest,
  wrap01Arr,
  wrapCyclesArr,
  wrapRadiansArr,
  pymod,
} from './phaseMath';

// configuration (sections 1, 6-8, 10, 11, 13, 14)
export type {
  SimConfig,
  Quantizer,
  ArchMode,
  InjMapping,
  DtcModeName,
  InjModel,
  ActuatorMode,
  InjGateMode,
  LoopMode,
} from './config';
export {
  defaultConfig,
  fromPartial,
  replaceConfig,
  validateConfig,
  configG,
  configAlpha,
  configTRefS,
  configTVcoS,
} from './config';

// ideal trajectory (section 3)
export { sIdeal, xIdeal, aIdeal } from './phaseAccumulator';

// quantizers (section 6)
export type { QuantizerState } from './quantizers';
export {
  makeQuantizer,
  ErrorFeedbackFirstOrder,
  Mash11,
  Mash111,
  triangularDither,
} from './quantizers';

// deterministic PRNG (section 12)
export type { StreamName, Streams } from './rng';
export { Mulberry32, STREAM_OFFSETS, makeStream, makeAllStreams } from './rng';

// analog element models (sections 4, 5, 10, 11)
export type { DTCModelOptions } from './dtcModel';
export { DTCModel, makeDtc } from './dtcModel';
export { tapActual, pmuxActual, tapTable, pmuxTable } from './tapModel';

// schedulers (sections 4-8)
export type { FeedbackResult } from './feedbackScheduler';
export { runFeedback, uFbAnalog, lmsQncStep } from './feedbackScheduler';
export type { InjectionResult } from './injectionScheduler';
export { uInjIdeal, runInjection, ePair } from './injectionScheduler';

// latency pipeline (section 13)
export type { LatencyMetadata, LatencyResult } from './latencyPipeline';
export { applyLatency } from './latencyPipeline';

// injection dynamics (section 14)
export type { DynamicsResult } from './injectionDynamics';
export { lockCondition, sinFixedPointRad, runDynamics } from './injectionDynamics';

// measurements (section 17)
export type { Spur } from './measurements';
export {
  rms,
  peakToPeak,
  mean,
  histogram,
  fftComplex,
  fftMag,
  periodogramPsd,
  detectSpurs,
  integratedPhase,
  toneAmpToDbc,
  psdToDbcPerHz,
  db10,
  db20,
} from './measurements';

// error decomposition (section 16)
export type { Decomposition } from './errorDecomposition';
export { decompose } from './errorDecomposition';

// experiments / presets (the 23 canonical numerical experiments)
export type { Experiment } from './experiments';
export { EXPERIMENTS, PRESETS, getPreset, presetConfigs } from './experiments';

// simulation engine
export type { SimResult, SimSummary, SignalSummary, ColumnName } from './simulate';
export { simulate, COLUMNS, INT_COLUMNS, toRows, summary } from './simulate';
