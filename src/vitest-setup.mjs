// Vitest setup file: `setupFiles: ['tracegate-ci/vitest-setup']`, listed FIRST so
// that modules the other setup files load are recorded too. It does nothing
// unless `TRACEGATE_RECORD=<dir>` is set; add it conditionally to be sure:
//
//   setupFiles: [...(process.env.TRACEGATE_RECORD ? ['tracegate-ci/vitest-setup'] : []), ...yours]
//
// The lane is `TRACEGATE_LANE` when set (`tracegate run` sets it), else the lane
// whose directory is vitest's working directory, else the only lane.
import { afterAll, expect } from 'vitest';
import { laneTarget } from './config.mjs';
import { installRecorder } from './recorder.mjs';

if (process.env.TRACEGATE_RECORD) {
  const t = (globalThis.__tracegateTarget ??= laneTarget());
  await installRecorder({ afterAll, expect, ...t });
}
