// Conductor (Phase 2): fail-first ordering, and advice on how to compose a merge train.
//
// ORDERING never changes WHICH files run, only the order they start in. `rank`
// scores each file that will run from facts the predictor already has: why it
// must run (its own test file changed > code it executed changed > something it
// loaded or read changed > a lane-wide reason), how often it failed recently, and
// its duration (shorter first, so the first red arrives sooner). Ties keep the
// selection's order. conductor.mode:
//   shadow  (default) the order is written and SCORED: on a red run, the rank of
//           the first failing file vs what a random order would give
//           (`conductor-<host>.tsv`). Vitest runs in its own order.
//   order   the order is also handed to vitest through TRACEGATE_ORDER; the host
//           adds `tracegate-ci/sequencer` as `test.sequence.sequencer`.
//   off     nothing.
//
// TRAIN ADVICE (`tracegate conductor train`) is advice, never an action: for each
// PR it computes the test files the change can reach (file level, from the latest
// footprint of each test), flags PRs that touch a global input or reach far more
// than the others to be trained ALONE, and names the pairs whose reach is
// disjoint (Phase 3+ footprint-partitioned trains: predicted, logged, scored by
// `conductor outcome`, relied on by nothing).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ctx, git, lane } from './config.mjs';
import { appendTsv, getBlob, ledgerDir, readTsv, CONDUCTOR_HEADER } from './ledger.mjs';

// Higher = more likely to fail on this change. Matched against decide()'s reason.
const REASON_WEIGHTS = [
  [/^the test file changed$/, 4],
  [/^(executed function|constant|top-level change in|loaded module deleted|unmapped module)/, 3],
  [/^(loaded module|read input|lockfile changed: package)/, 2],
  [/^no footprint$/, 1.5],
  [/./, 1], // lane-wide: global input, lockfile, node, age, format, unavailable commit
];
export const reasonWeight = (reason) => REASON_WEIGHTS.find(([re]) => re.test(String(reason ?? '')))?.[1] ?? 1;

/** Files that failed in recent red runs, with counts (from the Red Reader's index and packets). */
export function recentFailures(n = 50) {
  const out = new Map();
  for (const r of readTsv('red-').slice(-n)) {
    let p; try { p = JSON.parse(fs.readFileSync(path.join(ledgerDir(), 'red', `${r.id}.json`), 'utf8')); } catch { continue; }
    for (const f of [...(p.failed ?? []).map((x) => x.file), ...(p.moreFailed ?? [])]) out.set(f, (out.get(f) ?? 0) + 1);
  }
  return out;
}

/**
 * The fail-first order of the files that will run. Pure over its inputs:
 * `decisions` as in predict.json, `selected` the files that run (in selection
 * order), `fails` a Map of recent failure counts.
 */
export function rank(decisions, selected, fails = new Map()) {
  const score = (f) => {
    const d = decisions[f] ?? {};
    const w = d.run ? reasonWeight(d.reason) : 0.5; // an audit: predicted reusable
    return w + 2 * Math.min(3, fails.get(f) ?? 0);
  };
  return selected.map((f, i) => ({ f, i, s: score(f), ms: decisions[f]?.durationMs ?? Infinity }))
    .sort((a, b) => (b.s - a.s) || (a.ms - b.ms) || (a.i - b.i)).map((x) => x.f);
}

/** Where the first failure landed in `order`, against a random order's expectation. Pure. */
export function firstFailRank(order, failed) {
  const k = order.filter((f) => failed.has(f)).length;
  if (!k) return null;
  const r = order.findIndex((f) => failed.has(f)) + 1;
  return { rank: r, randomExpected: +((order.length + 1) / (k + 1)).toFixed(2), files: order.length, failed: k };
}

/** Log the score of one red run's order (shadow and order modes alike). */
export function scoreOrder({ lane: laneName, head, order, failed, mode }) {
  const s = firstFailRank(order, failed);
  if (!s) return null;
  appendTsv('conductor-', CONDUCTOR_HEADER, [new Date().toISOString(), laneName, head.slice(0, 12), s.files, s.failed, s.rank, s.randomExpected, mode]);
  return s;
}

/** Summary of the ordering's score so far: mean first-failure rank vs random. */
export function orderSummary() {
  const rows = readTsv('conductor-').filter((r) => Number(r.files) > 1);
  if (!rows.length) return { runs: 0 };
  const mean = (xs) => +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
  const ratio = rows.map((r) => Number(r.first_fail_rank) / Number(r.random_expected));
  return { runs: rows.length, meanRank: mean(rows.map((r) => Number(r.first_fail_rank))), meanRandom: mean(rows.map((r) => Number(r.random_expected))), meanRatio: mean(ratio), better: ratio.filter((x) => x < 1).length };
}

// ── train advice ─────────────────────────────────────────────────────────────
/** The newest footprint of every test file in a lane: [{ testFile, loaded:Set, reads:[] }]. */
function latestFootprints(laneName) {
  const out = [];
  const root = path.join(ledgerDir(), 'fp', laneName);
  let dirs = []; try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let names = []; try { names = fs.readdirSync(path.join(root, d)).filter((n) => n.endsWith('.json.gz')); } catch { continue; }
    let best = null;
    for (const n of names) { try { const fp = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, d, n))).toString('utf8')); if (!best || fp.recordedAt > best.recordedAt) best = fp; } catch { /* torn */ } }
    if (!best) continue;
    try { out.push({ testFile: best.testFile, loaded: new Set(getBlob(best.loaded)), reads: getBlob(best.reads) }); } catch { /* blob gone */ }
  }
  return out;
}

/** Test files a set of changed paths can reach, at file level (coarse on purpose: advice only). */
export function reach(ln, fps, changed) {
  const global = changed.filter((p) => ln.global.test(p));
  if (global.length) return { global, files: null };
  const files = new Set();
  for (const fp of fps) {
    for (const p of changed) {
      if (p === fp.testFile || fp.loaded.has(p) || fp.reads.some((r) => r === p || p.startsWith(r + '/'))) { files.add(fp.testFile); break; }
    }
  }
  return { global: [], files };
}

/**
 * Advice for a train. Pure over `reaches`: { [pr]: { global:[], files:Set|null } }.
 * A PR goes ALONE if it touches a global input, or reaches more than `aloneShare`
 * of the lane and more than twice the median reach of the others.
 */
export function advise(reaches, laneFiles, { aloneShare = 0.25 } = {}) {
  const prs = Object.keys(reaches);
  const size = (pr) => (reaches[pr].files === null ? Infinity : reaches[pr].files.size);
  const sizes = prs.map(size).filter(Number.isFinite).sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)] : 0;
  // A global PR's reach is Infinity, so it always clears both bars.
  const alone = prs.filter((pr) => size(pr) > aloneShare * laneFiles && size(pr) > 2 * median);
  const together = prs.filter((pr) => !alone.includes(pr));
  const independent = [];
  for (let i = 0; i < prs.length; i++) for (let j = i + 1; j < prs.length; j++) {
    const a = reaches[prs[i]].files, b = reaches[prs[j]].files;
    if (a && b && ![...a].some((f) => b.has(f))) independent.push([prs[i], prs[j]]);
  }
  return { alone, together, independent, reach: Object.fromEntries(prs.map((pr) => [pr, size(pr) === Infinity ? 'global' : size(pr)])) };
}

export const ADVICE_HEADER = ['at', 'id', 'lane', 'prs', 'alone', 'independent_pairs', 'advice'];
export const OUTCOME_HEADER = ['at', 'id', 'red', 'combination'];

/** `conductor train --lane l --pr <id>=<ref> … [--base origin/main]`: advice, logged. */
export function trainAdvice(o) {
  const ln = lane(o.lane);
  const base = o.base && o.base !== true ? o.base : 'origin/main';
  const prs = [o.pr].flat().filter(Boolean).map((x) => { const [id, ref] = String(x).split('='); return { id, ref: ref ?? id }; });
  if (prs.length < 1) throw new Error('conductor train: give at least one --pr <id>=<ref>');
  const fps = latestFootprints(ln.name);
  const reaches = {};
  for (const p of prs) {
    const changed = git('diff', '--name-only', `${base}...${p.ref}`).trim().split('\n').filter(Boolean);
    reaches[p.id] = reach(ln, fps, changed);
  }
  const a = advise(reaches, fps.length);
  const id = `t-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`;
  appendTsv('train-advice-', ADVICE_HEADER, [new Date().toISOString(), id, ln.name, prs.map((p) => p.id).join(','), a.alone.join(','), a.independent.length, JSON.stringify(a)]);
  return { id, ...a };
}

/** Record how a train went, so advice can be scored: which PRs were red, and whether the red needed two PRs together. */
export function trainOutcome(o) {
  if (!o.id || o.id === true) throw new Error('conductor outcome: --id <advice id> is required');
  if (!readTsv('train-advice-').some((r) => r.id === o.id)) throw new Error(`conductor outcome: no advice ${o.id}`);
  appendTsv('train-outcome-', OUTCOME_HEADER, [new Date().toISOString(), o.id, o.red && o.red !== true ? o.red : '', o.combination ? 'yes' : 'no']);
}

/**
 * How the advice did: of the PRs that turned out red, how many it had said to
 * train alone (bisections it would have saved), and how often a pair it called
 * independent was red only in combination (the false-independence rate).
 */
export function trainScore() {
  const adv = new Map(readTsv('train-advice-').map((r) => [r.id, r]));
  const out = { trains: 0, red: 0, flaggedRed: 0, flagged: 0, independentPairs: 0, falseIndependent: 0 };
  for (const r of readTsv('train-outcome-')) {
    const a = adv.get(r.id); if (!a) continue;
    out.trains++;
    let advice; try { advice = JSON.parse(a.advice); } catch { continue; }
    const red = r.red ? r.red.split(',') : [];
    out.red += red.length; out.flagged += advice.alone.length;
    out.flaggedRed += red.filter((pr) => advice.alone.includes(pr)).length;
    out.independentPairs += advice.independent.length;
    if (r.combination === 'yes') out.falseIndependent += advice.independent.filter(([x, y]) => red.includes(x) && red.includes(y)).length;
  }
  out.falseIndependenceRate = out.independentPairs ? +(out.falseIndependent / out.independentPairs).toFixed(3) : null;
  return out;
}

export function conductor(sub, o) {
  if (sub === 'train') { console.log(JSON.stringify(trainAdvice(o), null, 2)); return; }
  if (sub === 'outcome') { trainOutcome(o); console.log(`tracegate conductor: outcome recorded for ${o.id}`); return; }
  if (sub === 'score') { console.log(JSON.stringify({ order: orderSummary(), train: trainScore() }, null, 2)); return; }
  throw new Error('conductor: train --lane l --pr <id>=<ref>… [--base ref] | outcome --id <advice> [--red a,b] [--combination] | score');
}

export const conductorMode = () => ctx().conductor.mode;
