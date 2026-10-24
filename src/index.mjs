// Programmatic API.
export { ctx, resetContext, lane, FP_VERSION, DEFAULTS } from './config.mjs';
export { model } from './model.mjs';
export {
  decide, invalidates, ingest, select, report, triage, entryBar, modeDecision, effectiveMode,
  fullDone, lastFullHours, reasonKey, head, lockHash, lockHashAt, loadResults, status,
} from './predictor.mjs';
export { replay } from './replay.mjs';
export { sync } from './sync.mjs';
export { runLane } from './run.mjs';
export { installRecorder, ModuleMap } from './recorder.mjs';
