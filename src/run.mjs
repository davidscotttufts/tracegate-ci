// `tracegate run --lane <l> [--mode m] [--run <dir>] -- <vitest args>`
//
// One recorded run of a lane under Tracegate (the lane's runner: src/runners/):
//   1. mode     off → plain vitest, nothing recorded
//   2. select   which files must run (a failure here runs the whole lane and records nothing)
//   3. vitest   with the recorder on, the selection (under enforce) and a JSON reporter
//   4. report   prediction vs reality; misses logged, failing files' footprints dropped
//   5. recheck  each MISS re-run ONCE, alone, at the same tree; a pass is triaged `flake`
//   6. ingest   footprints of green files, only if HEAD did not move during the run
//   7. full     a green whole-lane run is recorded as a complete full run
// After report, the silence guard (silence.mjs) checks the change for skipped,
// focused or deleted tests; under silence.mode `enforce` an unallowed one makes
// the run red. Beside those: the Conductor's fail-first order is written (and handed to
// vitest under conductor.mode `order`) and scored on a red run; a lockfile run
// leaves a dependency packet for the oracle (Phases 2 and 3, both shadow).
// The exit code is vitest's. Nothing here can turn a red run green.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rank, recentFailures, scoreOrder } from './conductor.mjs';
import { ctx, git, lane, lockfileOf } from './config.mjs';
import { lockDiff, writeDepsPacket } from './deps.mjs';
import { effectiveMode, fullDone, head, ingest, loadResults, report, savings, savingsLine, select, triage } from './predictor.mjs';
import { writePacket } from './red.mjs';
import { runnerOf } from './runners/index.mjs';
import * as vitestAdapter from './runners/vitest.mjs';
import { guard } from './silence.mjs';
import { recordGreen } from './attest.mjs';

export const vitestBin = vitestAdapter.bin;

function vitest(ln, args, env) {
  const r = runnerOf(ln);
  // Under a broker lease (`tracegate lease -- tracegate run …`), size the runner to the grant.
  const tokens = Number(process.env.TRACEGATE_TOKENS);
  const workers = Number.isInteger(tokens) && tokens > 0 && !r.hasWorkersArg(args) ? [r.workersArg(tokens)] : [];
  return r.spawn(ln, [...workers, ...args], env);
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
  const reporters = runnerOf(ln).recordArgs(run);
  // Phase 2: the fail-first order of what will run. It never changes the set.
  const cmode = c.conductor.mode;
  let order = null;
  if (cmode !== 'off') {
    try {
      const pred = JSON.parse(fs.readFileSync(path.join(run, 'predict.json'), 'utf8'));
      order = rank(pred.decisions, sel.selected, recentFailures());
      fs.writeFileSync(path.join(run, 'order.txt'), order.map((f) => path.join(c.root, f)).join('\n') + '\n');
      if (cmode === 'order') recEnv.TRACEGATE_ORDER = path.join(run, 'order.txt');
    } catch (e) { console.log(`tracegate (${ln.name}): no fail-first order (${e.message}); vitest's own order is used.`); order = null; }
  }
  let rc = 0;
  if (mode === 'enforce' && sel.selected.length === 0) {
    console.log(`tracegate: every ${ln.name} verdict is reusable at this tree — no file needs to run.`);
  } else {
    const files = mode === 'enforce' ? sel.selected.map((f) => path.join(c.root, f)) : [];
    rc = vitest(ln, [...reporters, ...userArgs, ...runnerOf(ln).filesArgs(files)], recEnv);
  }
  const results = loadResults(run, ln);
  const rawDir = path.join(run, 'raw');
  if (results.size && !(fs.existsSync(rawDir) && fs.readdirSync(rawDir).length)) {
    console.log(`\x1b[33mtracegate: ${runnerOf(ln).name} ran but the recorder wrote nothing — ${runnerOf(ln).setupHint}.\x1b[0m`);
  }
  const rep = report({ lane: ln.name, run });
  // A footprint hole is a deterministic function of the tree, so it fails again
  // alone and stays a MISS. One that passes alone is triaged a flake. The run
  // stays red either way: the file did fail here.
  const rechecks = {};
  for (const m of rep?.misses ?? []) {
    console.log(`tracegate (${ln.name}): re-running the MISS ${m} alone at ${rep.head.slice(0, 12)} …`);
    const again = vitest(ln, runnerOf(ln).filesArgs([path.join(c.root, m)]), { TRACEGATE_RECORD: '' });
    rechecks[m] = again === 0 ? 'passed' : 'failed';
    if (again === 0) {
      triage({ lane: ln.name, file: m, head: rep.head.slice(0, 12), verdict: 'flake' });
      console.log(`tracegate (${ln.name}): ${m} PASSED alone, so it is recorded as a flake and does not suspend the lane. Read its failure before believing that: a wrong argument whose assertion depends on timing can pass alone too. The run is still red.`);
    } else {
      console.log(`\x1b[31mtracegate (${ln.name}): ${m} FAILS alone at this tree too — a real MISS (a footprint hole). The lane stays suspended.\x1b[0m`);
    }
  }
  if (rc !== 0 && order) {
    const failed = new Set([...results].filter(([, r]) => r.status === 'failed').map(([f]) => f));
    const sc = scoreOrder({ lane: ln.name, head: rep?.head ?? headAtStart, order, failed, mode: cmode });
    if (sc) console.log(`tracegate (${ln.name}): fail-first (${cmode}) put the first failure at ${sc.rank} of ${sc.files}; a random order would average ${sc.randomExpected}.`);
  }
  // Phase 3 oracle (shadow): a run whose lockfile differs from its first parent's
  // leaves a dependency packet. Nothing reads predictions back.
  if (process.env.TRACEGATE_DEPS_PACKET !== 'off') {
    try {
      const lf = lockfileOf(ln);
      const H = rep?.head ?? headAtStart;
      const baseRef = o.base && o.base !== true ? o.base : `${H}^`;
      const show = (ref) => { try { return git('show', `${ref}:${lf}`); } catch { return null; } };
      const d = lf ? lockDiff(show(baseRef), show(H)) : null;
      if (d && d.changed.size) {
        const key = (k) => (path.posix.dirname(lf) === '.' ? k : `${path.posix.dirname(lf)}/${k}`);
        let runner = []; try { runner = JSON.parse(fs.readFileSync(path.join(run, 'runner-pkgs.json'), 'utf8')) ?? []; } catch { /* none */ }
        const failed = [...results].filter(([, r]) => r.status === 'failed').map(([f]) => f);
        const diff = { changed: new Set([...d.changed].map(key)), native: d.native.map(key), versions: Object.fromEntries(Object.entries(d.versions).map(([k, v]) => [key(k), v])) };
        const p = writeDepsPacket({ lane: ln.name, head: H, lockfile: lf, diff, runner, files: sel.files, failed });
        console.log(`tracegate (${ln.name}): dependency packet ${p.id} (${p.packages.length} changed package(s)) — an agent can predict which tests it affects with the MCP tool annotate_deps; it is scored, never used.`);
      }
    } catch (e) { console.log(`tracegate (${ln.name}): no dependency packet (${e.message}).`); }
  }
  // Silence guard: skips, .only, deleted tests. Shadow logs them; enforce makes the run red.
  let silenced = null;
  try { silenced = guard({ lane: ln.name, head: rep?.head ?? headAtStart, base: o.base }); }
  catch (e) { console.log(`tracegate (${ln.name}): silence guard skipped (${e.message}).`); }
  if (silenced?.red && rc === 0) rc = 1;
  // Red Reader (Phase 1): a red run leaves a packet for an agent to read. It
  // only records; the one thing an opinion can do is escalate a MISS (Phase 1b).
  // TRACEGATE_RED=off skips it.
  if (rc !== 0 && process.env.TRACEGATE_RED !== 'off') {
    try { const p = writePacket({ lane: ln.name, run, base: o.base, rechecks, silenced: silenced?.findings?.length ? silenced.findings : null }); console.log(`tracegate (${ln.name}): red packet ${p.id} — an agent can read it with \`tracegate red show ${p.id}\` or the MCP tool read_red.`); }
    catch (e) { console.log(`tracegate (${ln.name}): could not write the red packet (${e.message}); the run is red either way.`); }
  }
  ingest({ lane: ln.name, run, 'expect-head': headAtStart });
  // A complete full run: the whole lane ran (shadow) and every listed file passed.
  if (rc === 0 && mode === 'shadow' && sel.files > 0) {
    const pred = JSON.parse(fs.readFileSync(path.join(run, 'predict.json'), 'utf8'));
    const all = Object.keys(pred.decisions).every((f) => results.get(f)?.status === 'passed');
    if (all && head() === headAtStart) fullDone({ lane: ln.name });
  }
  // Day-one value: what reuse would have saved so far, while still in shadow.
  if (mode === 'shadow') { try { console.log(savingsLine(savings({ lane: ln.name })[0])); } catch { /* evidence only */ } }
  // A green run at an unmoved tree is evidence `tracegate attest` can sign (attest.mjs).
  if (rc === 0 && rep && head() === headAtStart) {
    try { recordGreen({ lane: ln.name, mode, head: rep.head, rep }); } catch { /* evidence only */ }
  }
  if (!o.run) fs.rmSync(run, { recursive: true, force: true });
  return rc;
}
