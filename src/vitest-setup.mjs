// Vitest setup file: `setupFiles: ['tracegate-ci/vitest-setup']`, listed FIRST so
// that modules the other setup files load are recorded too. It does nothing
// unless `TRACEGATE_RECORD=<dir>` is set; add it conditionally to be sure:
//
//   setupFiles: [...(process.env.TRACEGATE_RECORD ? ['tracegate-ci/vitest-setup'] : []), ...yours]
//
// The lane is `TRACEGATE_LANE` when set (`tracegate run` sets it), else the lane
// whose directory is vitest's working directory, else the only lane.
import path from 'node:path';
import fs from 'node:fs';
import { afterAll, expect } from 'vitest';
import { ctx } from './config.mjs';
import { installRecorder } from './recorder.mjs';

function target() {
  const c = ctx();
  const lanes = Object.values(c.lanes);
  let ln = null;
  if (process.env.TRACEGATE_LANE) ln = c.lanes[process.env.TRACEGATE_LANE];
  if (!ln) {
    let cwd = process.cwd(); try { cwd = fs.realpathSync.native(cwd); } catch { /* as is */ }
    const here = path.relative(c.root, cwd).split(path.sep).join('/');
    ln = lanes.find((l) => l.dir === here) ?? (lanes.length === 1 ? lanes[0] : null);
  }
  if (!ln) throw new Error(`tracegate: cannot tell which lane ${process.cwd()} is; set TRACEGATE_LANE`);
  return { repoRoot: c.root, srcPrefix: ln.srcPrefix };
}

if (process.env.TRACEGATE_RECORD) {
  const t = (globalThis.__tracegateTarget ??= target());
  await installRecorder({ afterAll, expect, ...t });
}
