// replay: re-decide a past run offline (the counterfactual harness).
//
// `replay --lane <l> --head <commit> --at <iso time of the run>` evaluates
// decide() at a past head AS OF that run's clock, using only footprints
// recorded before it. Optionally with some changed paths removed (`--drop
// <regex>`) or the lockfile ignored (`--ignore-lock`). It answers "what would
// this run have executed if <cause> were narrowed?" exactly, where the reasons
// log only says which reason came FIRST. It is read-only on the ledger.
import fs from 'node:fs';
import { git, isTestFile, lane } from './config.mjs';
import { REPLAY, REASONS_TOP, clearChangeCache, decide, fpsFor, lockHashAt, reasonKey } from './predictor.mjs';
import { readFps } from './ledger.mjs';

export function replay(o) {
  const ln = lane(o.lane);
  if (!o.head || o.head === true) throw new Error('replay needs --head <commit>');
  if (!o.at || o.at === true || Number.isNaN(Date.parse(o.at))) throw new Error('replay needs --at <iso time of the run> (footprints recorded later are not used)');
  const H = git('rev-parse', `${o.head}^{commit}`).trim();
  Object.assign(REPLAY, { at: Date.parse(o.at), drop: o.drop && o.drop !== true ? new RegExp(o.drop) : null, ignoreLock: o['ignore-lock'] === true || o['ignore-lock'] === 'true' });
  clearChangeCache();
  try { return replayAt(o, ln, H); } finally { Object.assign(REPLAY, { at: null, drop: null, ignoreLock: false }); clearChangeCache(); }
}

function replayAt(o, ln, H) {
  const lock = lockHashAt(ln.name, H);
  // The test list at H, from the tree (the original run listed it with vitest at H).
  const files = process.env.TRACEGATE_TEST_LIST
    ? process.env.TRACEGATE_TEST_LIST.split('\n').filter(Boolean)
    : git('ls-tree', '-r', '--name-only', H, ...(ln.dir ? ['--', ln.dir] : [])).split('\n')
      .filter((f) => isTestFile(f) && !f.includes('/node_modules/') && !ln.replayExclude.some((re) => re.test(f)));
  // The Node the run used is not logged; the newest footprint before it was
  // recorded by an earlier run on the same runtime, so take its node unless told.
  let node = o.node && o.node !== true ? o.node : null;
  if (!node) {
    let best = null;
    for (const f of files.slice(0, 200)) for (const fp of fpsFor(ln.name, f)) if (!best || fp.recordedAt > best.recordedAt) best = fp;
    node = best?.node ?? process.version;
  }
  const why = new Map(); const selected = [];
  // A file whose footprints were all recorded AFTER the run (the ones the run
  // used were since replaced by keepPerTest eviction, or dropped on a failure)
  // replays as "no footprint" although the run may have reused it. Count them,
  // so a replay says how far it can be trusted: must-run is exact only when 0.
  let evicted = 0;
  for (const f of files) {
    let d; try { d = decide(f, H, node, lock, ln.name); } catch (e) { d = { run: true, reason: `predictor error: ${e.message}` }; }
    if (d.reason === 'no footprint' && readFps(ln.name, f).length) evicted++;
    if (d.run) { selected.push(f); const k = reasonKey(d.reason); why.set(k, (why.get(k) ?? 0) + 1); }
  }
  const top = [...why].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, REASONS_TOP);
  const res = { lane: ln.name, head: H, at: o.at, drop: REPLAY.drop?.source ?? null, ignoreLock: REPLAY.ignoreLock, node, files: files.length, mustRun: selected.length, evicted, top, selected };
  if (o.out && o.out !== true) fs.writeFileSync(o.out, JSON.stringify(res, null, 1));
  console.log(`tracegate replay (${ln.name}) ${H.slice(0, 9)} at ${o.at}${res.drop ? ` without /${res.drop}/` : ''}${res.ignoreLock ? ', lock ignored' : ''}: must run ${selected.length} of ${files.length}${evicted ? ` — ${evicted} of those only because their footprints were replaced after the run, so the true count may be up to ${evicted} lower` : ''}; node ${node}${o.node && o.node !== true ? '' : ' (from the newest earlier footprint)'}.`);
  // A footprint DROPPED after a later failure leaves no trace at all, so even
  // with 0 replaced a replay can read a file or two high: compare scenarios with
  // each other, never one replay with a logged count.
  for (const [k, n] of top.slice(0, 5)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  return res;
}
