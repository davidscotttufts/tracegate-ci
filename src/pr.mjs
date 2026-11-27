// `tracegate pr [--base <ref>] [--head <ref>] [--post-status] [--repo <owner/name>] [--sha <sha>]`
//
// The per-PR bar as one command: is this branch ready to join a batch? For the
// change base...head (the merge-base of base and head, then head), lane by lane:
//   1. changed   the PR's own added and changed test files
//   2. must-run  the files Tracegate cannot reuse a verdict for at this tree
//                (decide(), the same rule `tracegate run` uses under enforce)
//   3. always    files matching the config's `pr.alwaysRun` globs: ratchets,
//                censuses, anything a reviewer wants on every PR
// then the static and typecheck commands of `pr.commands`. It prints a short
// verdict with counts and exits 0 (green), 1 (red), 3 (refused), 4 (green, but
// the commit status could not be posted).
//
// With `--post-status` it posts a GitHub commit status (`local/pr-bar`) on the
// exact head sha: success with the counts, or failure with the first failing
// item. It refuses (exit 3, nothing posted, nothing run) on a dirty tree or when
// --head/--sha is not the checked-out HEAD, and posts nothing if the tree or HEAD
// moved while the bar ran. A new commit has no status, so a changed PR must pass
// again. The runs record nothing: a PR bar is not a lane run, and it never feeds
// the entry bar. Unless --no-lease, the whole bar runs under one broker lease
// (class `pr`), so heavy work on the machine queues fairly.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ctx, git } from './config.mjs';
import { allTestFiles, decide, head, loadResults, lockHash, treeUnderTest } from './predictor.mjs';
import { runnerOf } from './runners/index.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
export const CONTEXT = 'local/pr-bar';
export const EX = { GREEN: 0, RED: 1, REFUSED: 3, POST_FAILED: 4 };

class Refused extends Error { constructor(m) { super(m); this.exitCode = EX.REFUSED; } }

/** A glob to a regex: `**` crosses directories, `*` and `?` do not. A pattern
 *  with no `/` is matched against the file's base name. */
export function globRe(pat) {
  let s = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*' && pat[i + 1] === '*') { i++; if (pat[i + 1] === '/') { i++; s += '(?:.*/)?'; } else s += '.*'; } else if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${s}$`);
}
export function matchesAny(file, pats) {
  return pats.some((p) => globRe(p).test(p.includes('/') ? file : path.posix.basename(file)));
}

/** The `pr` settings: top level, with a lane's own `pr` added to it. */
export function prConfig() {
  let raw = {};
  const c = ctx();
  if (c.configFound) { try { raw = JSON.parse(fs.readFileSync(c.configPath, 'utf8')); } catch { raw = {}; } }
  const top = raw.pr ?? {};
  const lanes = {};
  for (const name of Object.keys(c.lanes)) {
    const own = raw.lanes?.[name]?.pr ?? {};
    lanes[name] = {
      alwaysRun: [...(top.alwaysRun ?? []), ...(own.alwaysRun ?? [])],
      commands: own.commands ?? [],
      mustRun: own.mustRun ?? top.mustRun ?? true,
    };
  }
  return { base: top.base ?? 'origin/main', commands: top.commands ?? [], lanes };
}

const rev = (ref) => git('rev-parse', '--verify', `${ref}^{commit}`).trim();
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
/** Untracked (not ignored) or modified tracked files. */
export const dirtyFiles = () => git('status', '--porcelain', '--untracked-files=all').split('\n').filter((l) => l.trim());

/** What the bar runs for base...head, per lane. Reads the repo; runs nothing. */
export function plan(o = {}) {
  const pc = prConfig();
  const H = rev(o.head && o.head !== true ? o.head : 'HEAD');
  const baseRef = o.base && o.base !== true ? o.base : pc.base;
  const mergeBase = git('merge-base', rev(baseRef), H).trim();
  const changed = new Set(lines(git('diff', '--name-only', '--diff-filter=ACMR', mergeBase, H)));
  // Running on the checked-out tree: uncommitted test edits are part of the change.
  const atHead = H === head();
  if (atHead) for (const f of [...lines(git('diff', '--name-only', '--diff-filter=ACMR', 'HEAD')), ...lines(git('ls-files', '--others', '--exclude-standard'))]) changed.add(f);
  const T = atHead ? treeUnderTest() : { at: H };
  const lanes = [];
  const inLane = new Set();
  for (const [name, ln] of Object.entries(ctx().lanes)) {
    const lc = pc.lanes[name];
    const files = allTestFiles(ln);
    const set = new Map(); // file → why
    const add = (f, why) => { if (!set.has(f)) set.set(f, why); };
    const counts = { changed: 0, mustRun: 0, always: 0 };
    for (const f of files) if (changed.has(f)) { add(f, 'changed'); counts.changed++; inLane.add(f); }
    if (lc.mustRun) {
      const lock = lockHash(name);
      for (const f of files) {
        let d; try { d = T.at ? decide(f, T.at, process.version, lock, name) : { run: true, reason: 'tree not snapshotted' }; } catch (e) { d = { run: true, reason: `predictor error: ${e.message}` }; }
        if (d.run) { counts.mustRun++; add(f, `must-run: ${d.reason}`); }
      }
    }
    if (lc.alwaysRun.length) for (const f of files) if (matchesAny(f, lc.alwaysRun)) { counts.always++; add(f, 'always-run'); }
    lanes.push({ lane: name, runner: ln.runner, dir: ln.dir, total: files.length, counts, files: [...set.keys()], why: Object.fromEntries(set), commands: lc.commands, mustRun: lc.mustRun });
  }
  const strayTests = [...changed].filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) && !inLane.has(f));
  return { head: H, base: baseRef, mergeBase, changed: [...changed].sort(), lanes, commands: pc.commands, strayTests };
}

function runCommand(cmd, cwd) {
  const r = spawnSync(cmd, { shell: true, cwd, stdio: 'inherit', env: { ...process.env, TRACEGATE_RECORD: '' } });
  return r.status ?? 1;
}

function runLaneFiles(lp) {
  const ln = ctx().lanes[lp.lane];
  const r = runnerOf(ln);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tracegate-pr-${lp.lane}-`));
  try {
    const tokens = Number(process.env.TRACEGATE_TOKENS);
    const workers = Number.isInteger(tokens) && tokens > 0 ? [r.workersArg(tokens)] : [];
    const abs = lp.files.map((f) => path.join(ctx().root, f));
    const rc = r.spawn(ln, [...workers, ...r.resultsArgs(dir), ...r.filesArgs(abs)], { TRACEGATE_RECORD: '' });
    const res = loadResults(dir, ln);
    const failed = lp.files.filter((f) => res.get(f)?.status === 'failed');
    // A red exit with no failing file named (a crash, a config error) still fails.
    return { rc, failed, missing: lp.files.filter((f) => !res.has(f)) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** The status description (GitHub caps it at 140 characters). */
export function describe(res) {
  if (res.ok) {
    const per = res.lanes.filter((l) => l.files.length).map((l) => `${l.lane} ${l.files.length}/${l.total} (${l.counts.changed} changed, ${l.counts.mustRun} must-run, ${l.counts.always} always)`);
    return `ok: ${per.length ? per.join('; ') : 'no test files'}; ${res.commandsRun} command(s)`.slice(0, 140);
  }
  return `failed: ${res.failures[0]}`.slice(0, 140);
}

export function postStatus({ repo, sha, state, description }) {
  const r = spawnSync('gh', ['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${CONTEXT}`, '-f', `description=${description}`], { cwd: ctx().root, encoding: 'utf8' });
  if (r.error || r.status !== 0) throw Object.assign(new Error(`gh api failed: ${(r.stderr || r.error?.message || '').trim()}`), { exitCode: EX.POST_FAILED });
  return { repo, sha, state, context: CONTEXT, description };
}

/** The checks --post-status needs before anything runs. */
export function preflight(o) {
  const H = head();
  if (o.head && o.head !== true && rev(o.head) !== H) throw new Refused(`--head ${o.head} is not the checked-out HEAD (${H.slice(0, 12)}); the bar tests the working tree, so check the PR out first`);
  if (o.sha && o.sha !== true && rev(o.sha) !== H) throw new Refused(`--sha ${o.sha} is not the checked-out HEAD (${H.slice(0, 12)}); a status is posted only for the commit that was tested`);
  if (o['post-status']) {
    const d = dirtyFiles();
    if (d.length) throw new Refused(`the tree is dirty (${d.length} path(s), e.g. ${d[0].slice(3)}); --post-status posts only for a committed, clean tree`);
  }
  return H;
}

/** Run the bar. { ok, failures[], lanes, commandsRun, head, posted } */
export function prBar(o = {}) {
  const H = preflight(o);
  const p = plan({ ...o, head: H });
  const failures = [];
  let commandsRun = 0;
  const say = (m) => { if (!o.quiet) console.log(m); };
  say(`tracegate pr: ${p.head.slice(0, 12)} against ${p.base} (merge-base ${p.mergeBase.slice(0, 12)}), ${p.changed.length} changed path(s).`);
  if (p.strayTests.length) say(`tracegate pr: ${p.strayTests.length} changed test file(s) are in no lane's test list, e.g. ${p.strayTests[0]} — they do not run.`);
  const failFast = !!o['fail-fast'];
  const stop = () => failFast && failures.length > 0;
  for (const cmd of p.commands) {
    if (stop()) break;
    say(`tracegate pr: command ${cmd}`); commandsRun++;
    if (runCommand(cmd, ctx().root) !== 0) failures.push(`command ${cmd}`);
  }
  for (const lp of p.lanes) {
    for (const cmd of lp.commands) {
      if (stop()) break;
      say(`tracegate pr (${lp.lane}): command ${cmd}`); commandsRun++;
      if (runCommand(cmd, path.join(ctx().root, lp.dir)) !== 0) failures.push(`${lp.lane} command ${cmd}`);
    }
    if (stop()) break;
    if (!lp.files.length) { say(`tracegate pr (${lp.lane}): nothing to run.`); continue; }
    say(`tracegate pr (${lp.lane}): running ${lp.files.length} of ${lp.total} test file(s) — ${lp.counts.changed} changed, ${lp.counts.mustRun} must-run${lp.mustRun ? '' : ' (off)'}, ${lp.counts.always} always-run.`);
    const r = runLaneFiles(lp);
    for (const f of r.failed) failures.push(`${lp.lane} ${f}`);
    if (r.rc !== 0 && !r.failed.length) failures.push(`${lp.lane} runner exit ${r.rc}${r.missing.length ? ` (${r.missing.length} file(s) without a result, e.g. ${r.missing[0]})` : ''}`);
  }
  const res = { ok: failures.length === 0, failures, lanes: p.lanes, commandsRun, head: H, posted: null };
  res.description = describe(res);
  if (o['post-status']) {
    // Only a run of exactly HEAD's clean tree is evidence about HEAD.
    const moved = head() !== H ? `HEAD moved to ${head().slice(0, 12)}` : dirtyFiles().length ? 'the tree changed' : null;
    if (moved) throw new Refused(`${moved} while the bar ran; nothing posted`);
    res.posted = postStatus({ repo: o.repo && o.repo !== true ? o.repo : '{owner}/{repo}', sha: H, state: res.ok ? 'success' : 'failure', description: res.description });
  }
  return res;
}

/** argv to re-run this command under a broker lease, or null to run here. */
export function leasedArgv(o, argv) {
  if (o['no-lease'] || o['dry-run'] || process.env.TRACEGATE_LEASE) return null;
  const branch = (() => { try { return git('rev-parse', '--abbrev-ref', 'HEAD').trim(); } catch { return 'HEAD'; } })();
  return [process.execPath, CLI, 'lease', '--class', 'pr', '--tokens', String(o.tokens && o.tokens !== true ? o.tokens : 2), '--label', `pr ${branch}`, '--quiet', '--', process.execPath, CLI, 'pr', ...argv];
}

export function prCli(o, argv) {
  const leased = leasedArgv(o, argv);
  if (leased) {
    // Refuse before queueing, so a dirty tree does not wait for capacity to be told no.
    preflight(o);
    const r = spawnSync(leased[0], leased.slice(1), { stdio: 'inherit', cwd: process.cwd() });
    return r.status ?? 1;
  }
  if (o['dry-run']) {
    const p = plan(o);
    if (o.json) { console.log(JSON.stringify(p, null, 2)); return 0; }
    console.log(`tracegate pr --dry-run: ${p.head.slice(0, 12)} against ${p.base} (merge-base ${p.mergeBase.slice(0, 12)})`);
    for (const lp of p.lanes) {
      console.log(`  ${lp.lane}: ${lp.files.length} of ${lp.total} — ${lp.counts.changed} changed, ${lp.counts.mustRun} must-run, ${lp.counts.always} always-run`);
      for (const f of lp.files) console.log(`    ${f}  (${lp.why[f]})`);
      for (const c of lp.commands) console.log(`    $ ${c}`);
    }
    for (const c of p.commands) console.log(`  $ ${c}`);
    return 0;
  }
  const res = prBar(o);
  if (o.json) console.log(JSON.stringify({ ok: res.ok, failures: res.failures, description: res.description, head: res.head, posted: res.posted }, null, 2));
  else {
    console.log(res.ok ? `tracegate pr: GREEN — ${res.description}` : `tracegate pr: RED — ${res.failures.length} failure(s): ${res.failures.join('; ')}`);
    if (res.posted) console.log(`tracegate pr: posted ${CONTEXT} = ${res.posted.state} on ${res.head.slice(0, 12)}.`);
  }
  return res.ok ? EX.GREEN : EX.RED;
}
