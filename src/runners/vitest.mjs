// The Vitest adapter: everything Tracegate needs to know about one test runner.
//
// A runner adapter answers five questions, and nothing outside src/runners/ asks
// a runner anything else:
//   list(ln)                   the lane's test files, from the runner itself
//   spawn(ln, args, env)       run it; the exit code is the runner's
//   recordArgs(run)            arguments for a recorded run (reporters, results file)
//   filesArgs(files)           arguments that run exactly these test files
//   workersArg(n) / hasWorkersArg(args)   size it to a broker grant
//   parseResults(json)         per-file verdicts from its JSON results
// The recorder itself is wired by the runner's setup file (vitest-setup.mjs) and
// is runner-agnostic below that: recorder.mjs, the predictor and the ledger
// never see which runner produced a footprint.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ctx } from '../config.mjs';

const REPORTER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vitest-reporter.mjs');
const laneAbs = (ln) => path.join(ctx().root, ln.dir);

export const name = 'vitest';
export const setupHint = "add 'tracegate-ci/vitest-setup' to setupFiles when TRACEGATE_RECORD is set (see README)";

export function bin(abs) {
  return path.join(path.dirname(createRequire(path.join(abs, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs');
}

export function list(ln) {
  const out = execFileSync(process.execPath, [bin(laneAbs(ln)), 'list', '--filesOnly', '--json'], {
    cwd: laneAbs(ln), encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, TRACEGATE_RECORD: '' },
  });
  return JSON.parse(out.slice(out.indexOf('['))).map((e) => e.file);
}

export function spawn(ln, args, env) {
  const r = spawnSync(process.execPath, [bin(laneAbs(ln)), 'run', ...args], { cwd: laneAbs(ln), stdio: 'inherit', env: { ...process.env, ...env } });
  return r.status ?? 1;
}

export const recordArgs = (run) => ['--reporter=default', '--reporter=json', `--outputFile.json=${path.join(run, 'results.json')}`, `--reporter=${REPORTER}`];
export const filesArgs = (files) => files;
export const workersArg = (n) => `--maxWorkers=${n}`;
export const hasWorkersArg = (args) => args.some((a) => a.startsWith('--maxWorkers'));

/** [{ name: absolute path as reported, status: 'failed' | 'passed' | other, durationMs }] */
export function parseResults(json) {
  return (json.testResults ?? []).map((r) => {
    const failed = r.status === 'failed' || (r.assertionResults ?? []).some((a) => a.status === 'failed');
    return { name: r.name, status: failed ? 'failed' : r.status === 'passed' ? 'passed' : r.status, durationMs: Math.max(0, (r.endTime ?? 0) - (r.startTime ?? 0)) };
  });
}
