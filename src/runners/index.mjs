// The runner of a lane: `"runner": "vitest"` (the default) or `"jest"` in tracegate.config.json.
import * as jest from './jest.mjs';
import * as vitest from './vitest.mjs';

const RUNNERS = { vitest, jest };
export function runnerOf(ln) {
  const r = RUNNERS[ln.runner ?? 'vitest'];
  if (!r) throw new Error(`lane ${ln.name}: unknown runner "${ln.runner}" (known: ${Object.keys(RUNNERS).join(', ')})`);
  return r;
}
