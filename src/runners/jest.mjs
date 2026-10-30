// The Jest adapter (Jest 30). The recorder rides in a test environment
// (jest-environment.mjs), so the lane's Jest config needs
//   testEnvironment: 'tracegate-ci/jest-environment'
// and the lane `"runner": "jest"`. Jest reads positional arguments as regular
// expressions, so a selection is passed with --runTestsByPath. Its --json
// results have the same per-file shape as Vitest's. It records no runner
// packages (Vitest's reporter does), so the dependency rule does not apply to a
// Jest lane's footprints: a lockfile change runs every test that loaded a package.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ctx } from '../config.mjs';
import { parseResults as vitestParse } from './vitest.mjs';

const laneAbs = (ln) => path.join(ctx().root, ln.dir);

export const name = 'jest';
export const setupHint = "set testEnvironment: 'tracegate-ci/jest-environment' in the lane's Jest config (see README)";

export function bin(abs) {
  return path.join(path.dirname(createRequire(path.join(abs, 'package.json')).resolve('jest/package.json')), 'bin', 'jest.js');
}

export function list(ln) {
  const out = execFileSync(process.execPath, [bin(laneAbs(ln)), '--listTests', '--json'], {
    cwd: laneAbs(ln), encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, TRACEGATE_RECORD: '' },
  });
  return JSON.parse(out.slice(out.indexOf('[')));
}

export function spawn(ln, args, env) {
  const r = spawnSync(process.execPath, [bin(laneAbs(ln)), ...args], { cwd: laneAbs(ln), stdio: 'inherit', env: { ...process.env, ...env } });
  return r.status ?? 1;
}

export const recordArgs = (run) => ['--json', `--outputFile=${path.join(run, 'results.json')}`];
export const filesArgs = (files) => (files.length ? ['--runTestsByPath', ...files] : []);
export const workersArg = (n) => `--maxWorkers=${n}`;
export const hasWorkersArg = (args) => args.some((a) => a.startsWith('--maxWorkers') || a === '-w' || a.startsWith('-w='));
export const parseResults = vitestParse;
