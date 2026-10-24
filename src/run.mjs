// `tracegate run --lane <l> [--mode m] [--run <dir>] -- <vitest args>`
//
// One recorded vitest run of a lane under Tracegate:
//   1. mode     off → plain vitest, nothing recorded
//   2. select   which files must run (a failure here runs the whole lane and records nothing)
//   3. vitest   with the recorder on, the selection (under enforce) and a JSON reporter
//   4. report   prediction vs reality; misses logged, failing files' footprints dropped
//   5. recheck  each MISS re-run ONCE, alone, at the same tree; a pass is triaged `flake`
//   6. ingest   footprints of green files, only if HEAD did not move during the run
//   7. full     a green whole-lane run is recorded as a complete full run
// The exit code is vitest's. Nothing here can turn a red run green.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { ctx, lane } from './config.mjs';
import { effectiveMode, fullDone, head, ingest, loadResults, report, select, triage } from './predictor.mjs';

function vitestBin(laneAbs) {
  return path.join(path.dirname(createRequire(path.join(laneAbs, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs');
}

function vitest(ln, args, env) {
  const laneAbs = path.join(ctx().root, ln.dir);
  // Under a broker lease (`tracegate lease -- tracegate run …`), size vitest to the grant.
  const tokens = Number(process.env.TRACEGATE_TOKENS);
  const workers = Number.isInteger(tokens) && tokens > 0 && !args.some((a) => a.startsWith('--maxWorkers')) ? [`--maxWorkers=${tokens}`] : [];
  const r = spawnSync(process.execPath, [vitestBin(laneAbs), 'run', ...workers, ...args], { cwd: laneAbs, stdio: 'inherit', env: { ...process.env, ...env } });
  return r.status ?? 1;
}

export function runLane(o, userArgs) {
  const ln = lane(o.lane);
  if (process.env.TRACEGATE_CONTENDED === '1') console.log(`\x1b[33mtracegate (${ln.name}): running CONTENDED — the broker started this past its starvation limit on a busy machine. A red here is not evidence until it reproduces on a quiet one.\x1b[0m`);
  const c = ctx();
  const mode = o.mode && o.mode !== true ? o.mode : effectiveMode(ln.name);
  if (mode === 'off') return vitest(ln, userArgs, { TRACEGATE_RECORD: '' });
  const headAtStart = head();
  const run = o.run && o.run !== true ? path.resolve(o.run) : fs.mkdtempSync(path.join(os.tmpdir(), `tracegate-${ln.name}-`));
  let sel;
  try {
    sel = select({ lane: ln.name, run, mode, ...(o.audit !== undefined ? { audit: o.audit } : {}) });
  } catch (e) {
    console.log(`\x1b[33mtracegate: selection failed (${e.message}) — running the whole ${ln.name} lane, recording nothing.\x1b[0m`);
    return vitest(ln, userArgs, { TRACEGATE_RECORD: '' });
  }
  const recEnv = { TRACEGATE_RECORD: run, TRACEGATE_ROOT: c.root, TRACEGATE_LANE: ln.name };
  const reporters = ['--reporter=default', '--reporter=json', `--outputFile.json=${path.join(run, 'results.json')}`];
  let rc = 0;
  if (mode === 'enforce' && sel.selected.length === 0) {
    console.log(`tracegate: every ${ln.name} verdict is reusable at this tree — no file needs to run.`);
  } else {
    const files = mode === 'enforce' ? sel.selected.map((f) => path.join(c.root, f)) : [];
    rc = vitest(ln, [...reporters, ...userArgs, ...files], recEnv);
  }
  const results = loadResults(run);
  const rawDir = path.join(run, 'raw');
  if (results.size && !(fs.existsSync(rawDir) && fs.readdirSync(rawDir).length)) {
    console.log(`\x1b[33mtracegate: vitest ran but the recorder wrote nothing — add 'tracegate-ci/vitest-setup' to setupFiles when TRACEGATE_RECORD is set (see README).\x1b[0m`);
  }
  const rep = report({ lane: ln.name, run });
  // A footprint hole is a deterministic function of the tree, so it fails again
  // alone and stays a MISS. One that passes alone is triaged a flake. The run
  // stays red either way: the file did fail here.
  for (const m of rep?.misses ?? []) {
    console.log(`tracegate (${ln.name}): re-running the MISS ${m} alone at ${rep.head.slice(0, 12)} …`);
    const again = vitest(ln, [path.join(c.root, m)], { TRACEGATE_RECORD: '' });
    if (again === 0) {
      triage({ lane: ln.name, file: m, head: rep.head.slice(0, 12), verdict: 'flake' });
      console.log(`tracegate (${ln.name}): ${m} PASSED alone, so it is recorded as a flake and does not suspend the lane. Read its failure before believing that: a wrong argument whose assertion depends on timing can pass alone too. The run is still red.`);
    } else {
      console.log(`\x1b[31mtracegate (${ln.name}): ${m} FAILS alone at this tree too — a real MISS (a footprint hole). The lane stays suspended.\x1b[0m`);
    }
  }
  ingest({ lane: ln.name, run, 'expect-head': headAtStart });
  // A complete full run: the whole lane ran (shadow) and every listed file passed.
  if (rc === 0 && mode === 'shadow' && sel.files > 0) {
    const pred = JSON.parse(fs.readFileSync(path.join(run, 'predict.json'), 'utf8'));
    const all = Object.keys(pred.decisions).every((f) => results.get(f)?.status === 'passed');
    if (all && head() === headAtStart) fullDone({ lane: ln.name });
  }
  if (!o.run) fs.rmSync(run, { recursive: true, force: true });
  return rc;
}
