// The predictor: test-impact selection from OBSERVED footprints.
//
// Every recorded vitest run deposits, per test file, a FOOTPRINT: the functions
// it executed, the modules it loaded and the repo files it read (recorder.mjs).
// A file's last green verdict is still valid on a later tree when nothing in its
// footprint changed in between, so a run only has to execute the files whose
// footprint a change touches.
//
// MODES (TRACEGATE / TRACEGATE_<LANE>):
//   shadow   run EVERYTHING; predict, then check the prediction.
//   enforce  run only what the prediction says, plus a uniform random AUDIT
//            sample of the files it would reuse. An audited file that fails is a MISS.
//   auto     (default) enforce once the lane has cleared its entry bar, else shadow.
//   off      do nothing.
// ENTRY BAR: ≥ N observations spanning ≥ D days and no un-triaged miss in the
// last missSuspendDays. A miss — a file predicted reusable that then FAILED — is
// a hole in the footprint. It drops `auto` back to shadow by itself, because the
// bar is re-checked on every run. No human has to notice.
//
// It can never turn a red into a green: a failing file's footprints are dropped,
// a tree that moved during the run is refused at ingest, footprints older than
// maxAgeHours are never reused, and any predictor error means "run".
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ctx, git, lane, lockfileOf, isTestFile, isTsFile, vitestTested, vitestVersion, FP_VERSION } from './config.mjs';
import { depsBar, depsOnlyPackageJson, lockDiff, repoKey } from './deps.mjs';
import { model } from './model.mjs';
import { ModuleMap } from './recorder.mjs';
import { runnerOf } from './runners/index.mjs';
import {
  appendTsv, dropFps, getBlob, ledgerDir, putBlob, readFps, readTsv, writeFp,
  DEPS_HEADER, FULL_HEADER, MISSES_HEADER, REASONS_HEADER, SHADOW_HEADER, TRIAGE_HEADER,
} from './ledger.mjs';

// ── replay state ─────────────────────────────────────────────────────────────
// `replay` (replay.mjs) evaluates decide() at a past head AS OF that run's clock,
// using only footprints recorded before it, optionally with some changed paths
// removed or the lockfile ignored. Nothing on a normal run path sets it.
export const REPLAY = { at: null, drop: null, ignoreLock: false };
const nowMs = () => (REPLAY.at === null ? Date.now() : REPLAY.at);
export const showAt = (commit, p) => { try { return git('show', `${commit}:${p}`); } catch { return null; } };
export const fpsFor = (ln, testFile) => readFps(ln, testFile, REPLAY.at);

export const head = () => git('rev-parse', 'HEAD').trim();
/**
 * The commit a selection predicts against. With uncommitted changes to tracked
 * files the tests run on the WORKING TREE, so that is what is compared: a commit
 * of it from `git stash create`, which writes no ref and no stash entry. Untracked
 * files need nothing: a new test has no footprint, and a new module is only
 * loaded through a tracked file that changed. `at` is null when the snapshot
 * fails (mid-merge, say): then nothing may be reused.
 */
export function treeUnderTest() {
  const H = head();
  if (!git('status', '--porcelain', '--untracked-files=no').trim()) return { head: H, at: H, dirty: false };
  try {
    const at = git('-c', 'user.name=tracegate', '-c', 'user.email=tracegate@localhost', 'stash', 'create').trim();
    return { head: H, at: at || H, dirty: !!at };
  } catch { return { head: H, at: null, dirty: true }; }
}
const hash16 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
/** The lane's lockfile hash on the working tree ('none' without one). */
export function lockHash(laneName) {
  const ln = lane(laneName);
  const f = lockfileOf(ln);
  if (!f) return 'none';
  try { return hash16(fs.readFileSync(path.join(ctx().root, f))); } catch { return 'none'; }
}
/** The lane's lockfile hash at a commit ('none' without one). */
export function lockHashAt(laneName, commit) {
  const ln = lane(laneName);
  const f = lockfileOf(ln, (p) => showAt(commit, p) !== null);
  if (!f) return 'none';
  try { return hash16(execFileSync('git', ['-C', ctx().root, 'show', `${commit}:${f}`], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return 'none'; }
}

// The lane's test files, from THE RUNNER ITSELF (src/runners/). A hand-written pattern was wrong
// twice in practice (it missed whole test directories), and under enforce a file
// the selector does not know about would never run at all. If this fails,
// select fails, and the lane runs whole.
export function allTestFiles(ln) {
  if (process.env.TRACEGATE_TEST_LIST) return process.env.TRACEGATE_TEST_LIST.split('\n').filter(Boolean);
  const r = runnerOf(ln);
  const files = r.list(ln).map((f) => path.relative(ctx().root, fs.realpathSync.native(f)).split(path.sep).join('/'));
  if (!files.length) throw new Error(`${r.name} listed no test files in ${ln.dir || '.'}`);
  return files;
}

// ── ingest: raw footprints + verdicts → ledger ───────────────────────────────
export function ingest(o) {
  const ln = lane(o.lane);
  const run = o.run; if (!run || run === true) throw new Error('--run <dir> is required');
  const H = head();
  // A footprint is attributed to a commit, so it must describe THAT commit: a
  // dirty tree or a HEAD that moved during the run records nothing.
  const dirty = git('status', '--porcelain', '--untracked-files=no').trim();
  if (dirty) { console.log(`tracegate ingest (${ln.name}): working tree has uncommitted changes — nothing recorded.`); return { recorded: 0, refused: 'dirty' }; }
  if (o['expect-head'] && o['expect-head'] !== true && o['expect-head'] !== H) { console.log(`tracegate ingest (${ln.name}): HEAD moved during the run — nothing recorded.`); return { recorded: 0, refused: 'moved' }; }
  const results = loadResults(run, ln);
  const rawDir = path.join(run, 'raw');
  const raws = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.json')) : [];
  const lock = lockHash(ln.name);
  const c = ctx();
  // Phase 3: packages the vitest main process loaded (vitest-reporter.mjs). Absent
  // or null = unknown, and the dependency rule does not apply to this run's footprints.
  let runnerPkgs = null; try { runnerPkgs = JSON.parse(fs.readFileSync(path.join(run, 'runner-pkgs.json'), 'utf8')); } catch { /* not recorded */ }
  const runnerBlob = Array.isArray(runnerPkgs) ? putBlob(runnerPkgs) : null;
  _fileInfo.clear(); refFiles.clear();
  let recorded = 0, dropped = 0, noVerdict = 0, unmapped = 0, mapped = 0, overBudget = 0;
  // A hard time budget, so ingest never holds the end of a run for long.
  // Footprints written before the budget runs out are complete and valid; the
  // rest are simply not recorded this time (their files run next time).
  const budgetMs = 1000 * Number(o['budget-s'] ?? c.ingestBudgetSeconds);
  const t0 = Date.now();
  for (const f of raws) {
    if (Date.now() - t0 > budgetMs) { overBudget++; continue; }
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8')); } catch { continue; }
    const verdict = results.get(raw.testFile);
    if (!verdict) { noVerdict++; continue; }
    if (verdict.status !== 'passed') { dropFps(ln.name, raw.testFile); dropped++; continue; } // a red file must run next time
    const keys = {}; const idents = new Set();
    for (const [file, ex] of Object.entries(raw.exec)) {
      // raw v2: { code: <sha of the compiled text>, offs: [V8 start offsets] },
      // mapped here, once per module per run, instead of in every test worker.
      // raw v1 (an array) is already source start lines.
      const startLines = Array.isArray(ex) ? ex : mapOffsets(run, ex);
      if (!startLines) { raw.unmapped.push(file); continue; }
      const fi = fileInfo(ln, file);
      if (!fi) continue;
      const ks = new Set();
      for (const l of startLines) {
        for (const k of fi.m.fnsStartingAt(l)) {
          ks.add(k);
          for (const w of fi.spanIdents(k)) idents.add(w);
        }
      }
      keys[file] = [...ks].sort();
    }
    unmapped += raw.unmapped.length; mapped += Object.keys(keys).length;
    // Reference closure: a referenced constant pulls in the names its initializer
    // uses. "Referenced" = named by an executed function, by any line of a
    // test-side module (assertions over a source table), or by a non-function
    // top-level statement of a loaded source module (`registerAll(FEATURES)`).
    // The last two are per-FILE facts, computed once per ingest (fileInfo) and
    // asked by name through refFiles, never re-scanned per test: rescanning every
    // loaded file per test made ingest take minutes on a large lane.
    const loaded = new Set(raw.loaded);
    const defs = [];
    const reads = new Set(raw.reads);
    for (const file of raw.loaded) {
      const fi = isTsFile(file) ? fileInfo(ln, file) : null;
      if (!fi) continue;
      for (const d of fi.defs) defs.push(d);
      for (const j of fi.jsonImports) reads.add(j);
    }
    const referenced = (name) => {
      if (idents.has(name)) return true;
      const files = refFiles.get(name);
      if (files) for (const fl of files) if (loaded.has(fl)) return true;
      return false;
    };
    const consts = new Set();
    let grew = true;
    while (grew) {
      grew = false;
      for (const [file, name, initIdents] of defs) {
        const id = `${file}::${name}`;
        if (consts.has(id) || !referenced(name)) continue;
        consts.add(id); grew = true;
        for (const w of initIdents) idents.add(w);
      }
    }
    writeFp(ln.name, {
      v: FP_VERSION, lane: ln.name, testFile: raw.testFile, commit: H, node: raw.node, lock,
      loaded: putBlob(raw.loaded), reads: putBlob([...reads].sort()), unmapped: raw.unmapped,
      ...(Array.isArray(raw.pkgs) && runnerBlob ? { pkgs: putBlob(raw.pkgs), runnerPkgs: runnerBlob } : {}),
      keys, consts: [...consts].sort(), durationMs: verdict.durationMs, recordedAt: new Date().toISOString(), host: c.host,
    });
    recorded++;
  }
  const share = mapped + unmapped ? (100 * unmapped / (mapped + unmapped)).toFixed(1) : '0.0';
  console.log(`tracegate ingest (${ln.name}): ${recorded} footprint(s) at ${H.slice(0, 9)} in ${Math.round((Date.now() - t0) / 1000)} s; ${dropped} dropped (not green); ${noVerdict} without a verdict; unmapped modules ${share}%.`);
  if (overBudget) console.log(`tracegate ingest (${ln.name}): time budget (${budgetMs / 1000} s) reached — ${overBudget} file(s) not recorded this run; they will simply run next time.`);
  if (Number(share) > 5) {
    const v = vitestVersion(ln);
    const where = v ? `vitest ${v}${vitestTested(v) ? '' : ' (outside the tested range)'}` : 'this vitest';
    console.log(`\x1b[33mtracegate: DEGRADED TO SAFE — ${share}% of loaded modules could not be mapped; ${where} may have moved the recorder's seam (see src/recorder.mjs; \`tracegate doctor\` checks it). Predictions stay safe (unmapped ⇒ run) but get coarse.\x1b[0m`);
  }
  return { recorded, dropped, noVerdict, overBudget, unmappedPct: Number(share) };
}

// Per-file facts for one ingest: the tree is fixed, so each file is read, parsed
// and scanned ONCE however many test files loaded it.
const _fileInfo = new Map();
const refFiles = new Map(); // identifier → files whose "always-running" text names it
const IDENT = /[A-Za-z_$][\w$]*/g;
function fileInfo(ln, file) {
  if (_fileInfo.has(file)) return _fileInfo.get(file);
  let fi = null;
  // Only a MISSING file may yield no info. A model() failure (no TypeScript
  // install, say) must throw: an empty key set reads as "executed nothing", and
  // every change to that file would then be skipped. Without this, a checkout
  // with no TypeScript silently turned several self-test RUN cases into SKIP.
  let src = null;
  try { src = fs.readFileSync(path.join(ctx().root, file), 'utf8'); } catch { /* not in this tree */ }
  if (src !== null) {
    const m = model(src, file);
    const testSide = !file.startsWith(ln.srcPrefix) || isTestFile(file);
    const always = new Set();
    m.lines.forEach((text, i) => {
      if (!testSide && !m.keysAt(i + 1).includes('<top>')) return;
      for (const w of text.match(IDENT) ?? []) always.add(w);
    });
    // Only TS modules hold references. A JSON module also reaches the executed
    // set (vitest evaluates it through the same vm path) and parses as one big
    // expression whose every word would look like a reference.
    if (isTsFile(file)) for (const w of always) { let s = refFiles.get(w); if (!s) refFiles.set(w, (s = [])); s.push(file); }
    const spanIdentCache = new Map();
    fi = {
      m,
      defs: [...m.consts].map(([name, init]) => [file, name, init.match(IDENT) ?? []]),
      jsonImports: m.jsonImports.map((j) => path.posix.normalize(path.posix.join(path.posix.dirname(file), j))),
      spanIdents(k) {
        let r = spanIdentCache.get(k);
        if (!r) {
          const sp = m.spanOf(k); const set = new Set();
          if (sp) for (let i = sp.s; i <= sp.e; i++) for (const w of m.lines[i - 1]?.match(IDENT) ?? []) set.add(w);
          spanIdentCache.set(k, (r = [...set]));
        }
        return r;
      },
    };
  }
  _fileInfo.set(file, fi);
  return fi;
}

const _maps = new Map();
function mapOffsets(run, ex) {
  const mk = run + '\0' + ex.code;
  let mm = _maps.get(mk);
  if (mm === undefined) {
    try { mm = new ModuleMap(fs.readFileSync(path.join(run, 'codes', ex.code + '.js'), 'utf8')); } catch { mm = null; }
    _maps.set(mk, mm);
  }
  if (!mm || !mm.mappings) return null;
  const lines = new Set();
  for (const off of ex.offs) { if (off < mm.prefix) continue; const l = mm.originalLine(off); if (l) lines.add(l); }
  return [...lines];
}

/** How many recorded modules in a run's raw footprints map to source, and how many do not
 *  (`tracegate doctor`'s seam canary; ingest counts the same way). */
export function seamShare(run) {
  let mapped = 0, unmapped = 0;
  const rawDir = path.join(run, 'raw');
  for (const f of fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((x) => x.endsWith('.json')) : []) {
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8')); } catch { continue; }
    unmapped += raw.unmapped.length;
    for (const ex of Object.values(raw.exec)) (Array.isArray(ex) || mapOffsets(run, ex) ? mapped++ : unmapped++);
  }
  return { mapped, unmapped };
}

/** Per-file verdicts from the runner's JSON results (`<run>/results.json`). */
export function loadResults(run, ln = null) {
  const out = new Map();
  let j; try { j = JSON.parse(fs.readFileSync(path.join(run, 'results.json'), 'utf8')); } catch { return out; }
  const root = ctx().root;
  for (const r of runnerOf(ln ?? { runner: 'vitest' }).parseResults(j)) {
    let name = r.name; try { name = fs.realpathSync.native(name); } catch { /* as reported */ }
    out.set(path.relative(root, name).split(path.sep).join('/'), { status: r.status, durationMs: r.durationMs });
  }
  return out;
}

// ── decide: may this file's verdict be reused on tree H? ─────────────────────
const _changes = new Map();
export function clearChangeCache() { _changes.clear(); _depsBar.clear(); }
function changesSince(C, H) {
  const ck = C + '..' + H + (REPLAY.drop ? ' -' + REPLAY.drop.source : '');
  if (_changes.has(ck)) return _changes.get(ck);
  let res;
  try {
    git('cat-file', '-e', C + '^{commit}');
    res = git('diff', '--no-renames', '--name-status', C, H).trim().split('\n').filter(Boolean)
      .map((l) => { const [st, p] = l.split('\t'); return { st, path: p, keys: null }; })
      .filter((c) => !(REPLAY.drop && REPLAY.drop.test(c.path)));
  } catch { res = null; } // commit gone (garbage-collected) → unknown → run
  _changes.set(ck, res);
  return res;
}

function changedKeys(C, H, ch) {
  if (ch.keys) return ch.keys;
  const keys = new Set();
  const diff = git('diff', '-U0', C, H, '--', ch.path);
  let pre = null, post = null;
  // A missing side is an add or a delete. A model() error is NOT: it propagates,
  // and select turns it into "run" (predictor error) instead of "nothing changed".
  const before = showAt(C, ch.path), after = showAt(H, ch.path);
  if (before !== null) pre = model(before, ch.path);
  if (after !== null) post = model(after, ch.path);
  // Hunks with their text, so a modified line can be narrowed to the columns that
  // actually changed (common prefix/suffix). A line diff alone cannot tell
  // `bar()` → `bar() + 1` (inside a callback) from an edit to the call around it.
  const hunks = diff.split(/^(?=@@ )/m).filter((h) => h.startsWith('@@'));
  for (const h of hunks) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h);
    const oldStart = +m[1], oldN = m[2] === undefined ? 1 : +m[2], newStart = +m[3], newN = m[4] === undefined ? 1 : +m[4];
    const body = h.split('\n').slice(1);
    const removed = body.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
    const added = body.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
    const paired = Math.min(removed.length, added.length);
    for (let i = 0; i < Math.max(oldN, newN, 1); i++) {
      let r0 = 0, r1 = Infinity, a0 = 0, a1 = Infinity;
      if (i < paired) {
        const o = removed[i], n = added[i];
        let p = 0; while (p < o.length && p < n.length && o[p] === n[p]) p++;
        let q = 0; while (q < o.length - p && q < n.length - p && o[o.length - 1 - q] === n[n.length - 1 - q]) q++;
        r0 = p; r1 = o.length - q; a0 = p; a1 = n.length - q;
      }
      // Each side contributes only the characters it actually has: an insertion is
      // described by the new side, a deletion by the old side, an edit by both.
      // An old-side value import is tagged <import-old:SPEC>: dropping or editing
      // it can stop a side-effect module evaluating or reorder vi.mock, so it
      // always invalidates, even when SPEC was loaded.
      if (pre && i < oldN && r1 > r0) for (const k of pre.keysAt(oldStart + i, r0, r1)) keys.add(k.startsWith('<import:') ? `<import-old:${k.slice(8)}` : k);
      if (post && i < newN && a1 > a0) for (const k of post.keysAt(newStart + i, a0, a1)) keys.add(k);
    }
  }
  ch.keys = keys;
  return keys;
}

// Phase 3: what a lockfile change changed between two commits (cached per pair).
const _lockDiffs = new Map();
function lockDiffBetween(ln, C, H) {
  const lf = lockfileOf(ln, (p) => showAt(H, p) !== null);
  if (!lf) return null;
  const k = `${lf}\0${C}\0${H}`;
  if (!_lockDiffs.has(k)) {
    const d = lockDiff(showAt(C, lf), showAt(H, lf));
    _lockDiffs.set(k, d && { lockfile: lf, changed: new Set([...d.changed].map((x) => repoKey(lf, x))), native: d.native.map((x) => repoKey(lf, x)), versions: d.versions });
  }
  return _lockDiffs.get(k);
}
export function clearLockDiffCache() { _lockDiffs.clear(); }

/**
 * The dependency rule for one footprint whose lockfile hash differs (deps.mjs).
 * Returns { reason } when the file must run, or { covered } (the lockfile path and
 * any dependency-only package.json edits that the rule has accounted for).
 */
export function depsVerdict(ln, fp, H) {
  if (ctx().deps.mode === 'off') return { reason: 'lockfile changed' };
  if (!fp.pkgs || !fp.runnerPkgs) return { reason: 'lockfile changed' };
  const d = lockDiffBetween(ln, fp.commit, H);
  if (!d) return { reason: 'lockfile changed' };
  if (d.native.length) return { reason: `lockfile changed: a package with native code (${d.native[0]})` };
  let pkgs, runner; try { pkgs = new Set(getBlob(fp.pkgs)); runner = new Set(getBlob(fp.runnerPkgs)); } catch { return { reason: 'footprint blob missing' }; }
  for (const k of d.changed) if (runner.has(k)) return { reason: `lockfile changed: ${k} (loaded by the vitest process)` };
  for (const k of d.changed) if (pkgs.has(k)) return { reason: `lockfile changed: package ${k}` };
  return { covered: d.lockfile };
}

/** Is one footprint still valid on H? Returns null if valid, else the reason. `info.deps` is set when the dependency rule alone made it valid. */
export function invalidates(ln, testFile, fp, H, nodeVersion, lock, info = {}) {
  if (fp.v !== FP_VERSION) return 'footprint format changed';
  if (fp.node !== nodeVersion) return `node ${fp.node} → ${nodeVersion}`;
  let covered = null;
  if (fp.lock !== lock && !REPLAY.ignoreLock) {
    const dv = depsVerdict(ln, fp, H);
    if (dv.reason) return dv.reason;
    covered = dv.covered;
  }
  const maxAge = ctx().maxAgeHours;
  const ageH = (nowMs() - Date.parse(fp.recordedAt)) / 3_600_000;
  if (!(ageH <= maxAge)) return `footprint older than ${maxAge} h (time-dependent tests)`;
  if (fp.commit === H) return null;
  const ch = changesSince(fp.commit, H);
  if (!ch) return `footprint commit ${fp.commit.slice(0, 9)} unavailable`;
  let loaded, reads;
  try { loaded = new Set(getBlob(fp.loaded)); reads = getBlob(fp.reads); } catch { return 'footprint blob missing'; }
  const consts = new Set(fp.consts);
  for (const c of ch) {
    const p = c.path;
    // A test FILE under a global directory (a setup dir's own __tests__) is not a
    // setup input: nothing loads it but itself, and if another test does load
    // it, the loaded-module check below still catches it. Treating it as global
    // made one edit to such a test re-run nearly a whole lane.
    // The dependency rule accounted for the lockfile, and for a package.json edit
    // that only moves dependency fields; any other edit to either is still global.
    // Only the GLOBAL rule is waived: a test that loaded or read the file itself
    // (one that reads the lockfile as data, say) still runs below.
    const waived = covered && (p === covered || (path.posix.basename(p) === 'package.json' && depsOnlyPackageJson(showAt(fp.commit, p), showAt(H, p))));
    if (!waived && ln.global.test(p) && !isTestFile(p)) return `global input ${p}`;
    if (p === testFile) return 'the test file changed';
    if (loaded.has(p)) {
      const isSrc = p.startsWith(ln.srcPrefix) && isTsFile(p) && !isTestFile(p);
      if (!isSrc) return `loaded module ${p}`;
      if (c.st === 'D') return `loaded module deleted ${p}`;
      if ((fp.unmapped ?? []).includes(p)) return `unmapped module ${p}`;
      const exec = fp.keys[p] ?? [];
      for (const k of changedKeys(fp.commit, H, c)) {
        if (k === '<blank>' || k === '<import>') continue;
        if (k.startsWith('<import-old:')) return `import ${k.slice(12, -1)} removed or changed in ${p}`;
        if (k.startsWith('<import:')) return `value import ${k.slice(8, -1)} added or changed in ${p}`;
        if (k === '<top>') return `top-level change in ${p}`;
        if (k.startsWith('<const:')) { if (consts.has(`${p}::${k.slice(7, -1)}`)) return `constant ${k.slice(7, -1)} in ${p}`; continue; }
        if (exec.includes(k)) return `executed function ${k} in ${p}`;
      }
      continue;
    }
    for (const r of reads) if (r === p || p.startsWith(r + '/')) return `read input ${p}`;
  }
  if (covered) info.deps = true;
  return null;
}

// The dependency rule's bar, read once per selection rather than once per file.
const _depsBar = new Map();
const depsBarOf = (l) => { if (!_depsBar.has(l)) _depsBar.set(l, depsBar(l)); return _depsBar.get(l); };

/** May testFile's last green verdict be reused on tree H? */
export function decide(testFile, H, nodeVersion, lock, laneName) {
  const ln = lane(laneName);
  const fps = fpsFor(ln.name, testFile);
  if (!fps.length) return { run: true, reason: 'no footprint' };
  let first = null; let viaDeps = null;
  for (const fp of fps) {
    const info = {};
    const why = invalidates(ln, testFile, fp, H, nodeVersion, lock, info);
    if (!why && info.deps) {
      // Valid only through the dependency rule: reuse it once that rule has met its
      // own bar; until then it runs, and the run scores what it would have reused.
      if (depsBarOf(ln.name).ok) return { run: false, deps: true, reason: `green at ${fp.commit.slice(0, 9)}; the lockfile changed, but no package it loaded did`, from: fp.commit, durationMs: fp.durationMs };
      viaDeps ??= fp; continue;
    }
    if (!why) return { run: false, reason: fp.commit === H ? 'green at this commit' : `green at ${fp.commit.slice(0, 9)}, nothing it depends on changed`, from: fp.commit, durationMs: fp.durationMs };
    first ??= why;
  }
  if (viaDeps) return { run: true, depsWouldReuse: true, reason: 'lockfile changed (the dependency rule would reuse this; its bar is not met yet)' };
  return { run: true, reason: first };
}

// ── mode + entry bar ─────────────────────────────────────────────────────────
export function entryBar(laneName) {
  const ln = lane(laneName);
  const c = ctx();
  const obs = readTsv('shadow-').filter((r) => r.lane === ln.name && (r.mode === 'shadow' || r.mode === 'enforce'));
  // A miss triaged as a flake (`tracegate triage ... --verdict flake`) is a test
  // problem, not a footprint hole: it does not suspend enforcement. A `hole` does.
  // The LATEST verdict for a (lane, file, head) decides. A Red Reader escalation
  // (Phase 1b, `escalations-`) is a `hole` that comes after the runner's own
  // recheck `flake`; a person who later says `flake` again overrides it.
  const verdicts = [...readTsv('triage-'), ...(ctx().red.escalate ? readTsv('escalations-') : [])]
    .filter((t) => t.verdict === 'flake' || t.verdict === 'hole').sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const last = new Map(); for (const t of verdicts) last.set(`${t.lane}\0${t.file}\0${t.head}`, t.verdict);
  const flakes = new Set([...last].filter(([, v]) => v === 'flake').map(([k]) => k));
  const misses = readTsv('misses-').filter((r) => r.lane === ln.name && !flakes.has(`${r.lane}\0${r.file}\0${r.head}`));
  const now = Date.now(), day = 86_400_000;
  const first = obs.length ? Math.min(...obs.map((r) => Date.parse(r.at))) : now;
  const bar = ln.bar;
  const recentMiss = misses.some((m) => now - Date.parse(m.at) < c.missSuspendDays * day);
  const spanDays = (now - first) / day;
  const ok = spanDays >= bar.days && obs.length >= bar.observations && !recentMiss;
  // An early entry (a lane bar shorter than the default) audits harder until the
  // default bar would have been met.
  const auditRate = spanDays < c.entryBar.days && bar.earlyAudit !== undefined ? bar.earlyAudit : c.audit;
  return { ok, spanDays: +spanDays.toFixed(1), observations: obs.length, recentMiss, missesTotal: misses.length, auditRate, bar };
}

// The full miss sweep over every reusable verdict needs a FULL run. A backstop
// that lives outside the gate (a nightly job, say) can silently never complete
// on a busy machine, so the backstop lives in the run itself: a lane whose last
// COMPLETE full run (`full-<host>.tsv`) is older than fullRunMaxHours runs whole.
export function lastFullHours(laneName) {
  const at = readTsv('full-').filter((r) => r.lane === laneName).map((r) => Date.parse(r.at)).filter(Number.isFinite);
  return at.length ? (Date.now() - Math.max(...at)) / 3_600_000 : Infinity;
}
const modeEnv = (laneName) => process.env[`TRACEGATE_${laneName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || process.env.TRACEGATE || 'auto';
export function modeDecision(laneName) {
  const ln = lane(laneName);
  const want = modeEnv(ln.name).toLowerCase();
  if (['off', 'shadow', 'enforce'].includes(want)) return { mode: want, why: 'set by TRACEGATE' };
  if (!entryBar(ln.name).ok) return { mode: 'shadow', why: 'entry bar not met' };
  const maxH = ctx().fullRunMaxHours;
  if (!maxH) return { mode: 'enforce', why: 'entry bar met' };
  const h = lastFullHours(ln.name);
  if (h >= maxH) {
    return { mode: 'shadow', full: true, why: `last complete full run ${Number.isFinite(h) ? `${Math.round(h)}h ago` : 'never recorded'} (≥ ${maxH}h) — this run executes the whole lane so the miss sweep happens` };
  }
  return { mode: 'enforce', why: `entry bar met; last complete full run ${Math.round(h)}h ago` };
}
export function effectiveMode(laneName) { return modeDecision(laneName).mode; }
/** Record a COMPLETE, green, whole-lane run. Call it only after one. */
export function fullDone(o) {
  const ln = lane(o.lane);
  appendTsv('full-', FULL_HEADER, [new Date().toISOString(), ln.name, head().slice(0, 12)]);
  console.log(`tracegate (${ln.name}): full run recorded — later runs may enforce for ${ctx().fullRunMaxHours}h.`);
}

// ── select: the files this run must execute ──────────────────────────────────
// Why a file runs, with the per-test detail (which function, which constant)
// folded away, so a run can say WHICH changed file drove a wide selection.
export function reasonKey(r) {
  return String(r)
    .replace(/^executed function .* in (\S+)$/, 'executed code in $1')
    .replace(/^constant \S+ in (\S+)$/, 'constant in $1')
    .replace(/^footprint commit \S+ unavailable$/, 'footprint commit unavailable')
    .replace(/^lockfile changed: package \S+$/, 'lockfile changed: a package it loaded')
    .replace(/^predictor error: [\s\S]*/, 'predictor error');
}
export const REASONS_TOP = 10;
export function select(o) {
  const ln = lane(o.lane);
  const run = o.run; if (!run || run === true) throw new Error('--run <dir> is required');
  const mode = o.mode && o.mode !== true ? o.mode : effectiveMode(ln.name);
  if (mode === 'shadow') { const d = modeDecision(ln.name); if (d.full) console.log(`tracegate (${ln.name}): running the FULL lane — ${d.why}.`); }
  const auditRate = o.audit === undefined ? entryBar(ln.name).auditRate : Number(o.audit);
  const T = treeUnderTest(); const H = T.head; const lock = lockHash(ln.name);
  if (T.dirty) console.log(`tracegate (${ln.name}): uncommitted changes — ${T.at ? `predicting against the working tree (${T.at.slice(0, 9)})` : 'the working tree could not be snapshotted, so every file runs'}.`);
  _depsBar.clear();
  const files = allTestFiles(ln);
  const out = { lane: ln.name, mode, head: H, ...(T.dirty ? { tree: T.at } : {}), at: new Date().toISOString(), auditRate, decisions: {} };
  const selected = [];
  const why = new Map();
  let reuse = 0, audit = 0;
  for (const f of files) {
    let d; try { d = T.at ? decide(f, T.at, process.version, lock, ln.name) : { run: true, reason: 'uncommitted changes not snapshotted' }; } catch (e) { d = { run: true, reason: `predictor error: ${e.message}` }; }
    if (!d.run) {
      reuse++;
      // Uniform and independent of the prediction's reason, so the miss rate it
      // measures is an unbiased estimate over every reused verdict.
      if (mode === 'enforce' && Math.random() < auditRate) { d.audit = true; audit++; }
    }
    out.decisions[f] = d;
    if (d.run) { const k = reasonKey(d.reason); why.set(k, (why.get(k) ?? 0) + 1); }
    if (mode !== 'enforce' || d.run || d.audit) selected.push(f);
  }
  const top = [...why].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, REASONS_TOP);
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'predict.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(run, 'selected.txt'), selected.map((f) => path.join(ctx().root, f)).join('\n') + (selected.length ? '\n' : ''));
  appendTsv('reasons-', REASONS_HEADER, [out.at, ln.name, mode, H.slice(0, 12), files.length, files.length - reuse, JSON.stringify(top)]);
  const bar = entryBar(ln.name);
  if (mode === 'enforce') {
    console.log(`tracegate (${ln.name}, enforce): running ${selected.length} of ${files.length} files — ${reuse - audit} verdicts reused, ${audit} of those re-run as an audit.`);
  } else {
    console.log(`tracegate (${ln.name}, ${mode}): ${reuse} of ${files.length} files could reuse a verdict at ${H.slice(0, 9)} — this run still executes all of them.`);
    console.log(`tracegate (${ln.name}): entry bar for enforcement — ${bar.observations}/${bar.bar.observations} observations over ${bar.spanDays}/${bar.bar.days} days, ${bar.recentMiss ? 'a recent MISS' : 'no recent miss'}.`);
  }
  if (top.length) {
    console.log(`tracegate (${ln.name}): why ${files.length - reuse} file(s) must run (top ${Math.min(5, top.length)} of ${why.size} reasons):`);
    for (const [k, n] of top.slice(0, 5)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  }
  return { mode, selected, files: files.length, reuse, audit };
}

// ── report: prediction vs reality ────────────────────────────────────────────
export function report(o) {
  const ln = lane(o.lane);
  const run = o.run; if (!run || run === true) throw new Error('--run <dir> is required');
  let pred; try { pred = JSON.parse(fs.readFileSync(path.join(run, 'predict.json'), 'utf8')); } catch { console.log(`tracegate report (${ln.name}): no prediction for this run.`); return null; }
  const results = loadResults(run, ln);
  let total = 0, reusable = 0, audited = 0, totalMs = 0, runMs = 0, savedMs = 0;
  const misses = [];
  for (const [f, d] of Object.entries(pred.decisions)) {
    const r = results.get(f);
    const ms = r?.durationMs ?? d.durationMs ?? 0;
    total++; totalMs += ms;
    if (d.run) { runMs += ms; continue; }
    reusable++;
    if (d.audit) audited++;
    // A MISS is a hole, not a saving: its time never counts as reusable.
    if (r && r.status === 'failed') misses.push(f); else savedMs += ms;
  }
  const share = totalMs ? (100 * runMs / totalMs).toFixed(1) : '0.0';
  const sec = (ms) => (ms / 1000).toFixed(3);
  appendTsv('shadow-', SHADOW_HEADER, [new Date().toISOString(), ln.name, pred.mode, pred.head.slice(0, 12), total, total - reusable, reusable, audited, share, misses.length, sec(totalMs), sec(savedMs)]);
  // Any file that failed here must run next time, whatever happens to ingest.
  for (const [f, r] of results) if (r.status === 'failed') dropFps(ln.name, f);
  for (const m of misses) appendTsv('misses-', MISSES_HEADER, [new Date().toISOString(), ln.name, pred.head.slice(0, 12), m, pred.decisions[m].reason]);
  // Phase 3: score the dependency rule on every run it took part in.
  const would = Object.entries(pred.decisions).filter(([, d]) => d.depsWouldReuse);
  const viaDeps = Object.entries(pred.decisions).filter(([, d]) => d.deps && !d.run);
  if (would.length || viaDeps.length) {
    const failedOfThose = would.filter(([f]) => results.get(f)?.status === 'failed').length;
    appendTsv('deps-', DEPS_HEADER, [new Date().toISOString(), ln.name, pred.mode, pred.head.slice(0, 12), '', would.length, viaDeps.length, failedOfThose, total]);
    console.log(`tracegate (${ln.name}): dependency rule — ${viaDeps.length ? `reused ${viaDeps.length} verdict(s) across the lockfile change` : `would have reused ${would.length} of ${total} file(s) across the lockfile change; ${failedOfThose} of those failed`}.`);
  }
  // A missed file must never be reused again on the footprint that lied.
  for (const m of misses) dropFps(ln.name, m);
  // The runner re-runs each miss alone before it exits (see run.mjs).
  fs.writeFileSync(path.join(run, 'misses.txt'), misses.map((m) => `${m}\n`).join(''));
  if (pred.mode === 'enforce') {
    console.log(`tracegate (${ln.name}, enforce): ran ${total - reusable} files that needed it + ${audited} audits; reused ${reusable - audited} of ${total} verdicts (the run cost ${share}% of the lane's full test time, before audits).`);
  } else {
    console.log(`tracegate (${ln.name}, ${pred.mode}): only ${total - reusable} of ${total} files needed to run (${share}% of the lane's test time); ${reusable} verdicts were reusable.`);
  }
  if (misses.length) {
    console.log(`\x1b[31mtracegate (${ln.name}): ${misses.length} MISS(ES) — a file predicted reusable FAILED. Unless it passes when re-run alone at this tree, that is a hole in its footprint: enforcement is suspended for this lane for ${ctx().missSuspendDays} days. Report it against the recorder:\x1b[0m`);
    for (const m of misses) console.log(`  ${m}  (${pred.decisions[m].reason})`);
  } else {
    console.log(`tracegate (${ln.name}): 0 misses.`);
  }
  return { total, reusable, audited, misses, head: pred.head, mode: pred.mode };
}

// ── savings: what reuse would have saved, from day one ───────────────────────
// Read from the shadow log alone, so it shows value while the entry bar is still
// being met. `reusable_s` (written since v0.7.0) is the test time of the files
// whose verdict was reusable and did not then fail; an older row without it is
// counted in files only. The projection keeps the audit: at rate a, a fraction a
// of the reusable time still runs.
export function savings(o = {}) {
  const c = ctx();
  const lanes = o.lane && o.lane !== true ? [lane(o.lane).name] : Object.keys(c.lanes);
  const rows = readTsv('shadow-');
  const out = [];
  for (const name of lanes) {
    const mine = rows.filter((r) => r.lane === name && (r.mode === 'shadow' || r.mode === 'enforce'));
    const b = entryBar(name);
    const s = { lane: name, runs: mine.length, files: 0, reusableFiles: 0, misses: 0, timedRuns: 0, totalS: 0, reusableS: 0 };
    for (const r of mine) {
      s.files += Number(r.files) || 0; s.reusableFiles += Number(r.reusable) || 0; s.misses += Number(r.misses) || 0;
      if (r.reusable_s === undefined || r.reusable_s === '') continue;
      s.timedRuns++; s.totalS += Number(r.total_s) || 0; s.reusableS += Number(r.reusable_s) || 0;
    }
    s.totalS = +s.totalS.toFixed(3); s.reusableS = +s.reusableS.toFixed(3);
    s.auditRate = b.auditRate;
    s.projectedS = +(s.reusableS * (1 - b.auditRate)).toFixed(3);
    s.projectedPct = s.totalS ? +(100 * s.projectedS / s.totalS).toFixed(1) : null;
    s.entryBar = { ok: b.ok, observationsLeft: Math.max(0, b.bar.observations - b.observations), daysLeft: +Math.max(0, b.bar.days - b.spanDays).toFixed(1), recentMiss: b.recentMiss };
    out.push(s);
  }
  return out;
}
// One unit for the whole line, chosen by the total.
const timeIn = (total) => (total >= 90 ? (x) => `${(x / 60).toFixed(1)} min` : total >= 1 ? (x) => `${x.toFixed(1)} s` : (x) => `${Math.round(x * 1000)} ms`);
export function savingsLine(s) {
  const mins = timeIn(s.totalS);
  const bar = s.entryBar.ok ? 'entry bar met'
    : s.entryBar.recentMiss ? 'entry bar held by a recent MISS'
    : `entry bar in ${s.entryBar.observationsLeft} observation(s) and ${s.entryBar.daysLeft} day(s)`;
  if (!s.runs) return `tracegate (${s.lane}): no observed runs yet.`;
  const time = s.timedRuns ? ` — ${mins(s.reusableS)} of ${mins(s.totalS)} test time; at a ${Math.round(s.auditRate * 100)}% audit enforce would have saved ${mins(s.projectedS)} (${s.projectedPct ?? 0}%)` : '';
  return `tracegate (${s.lane}): over ${s.runs} run(s), ${s.reusableFiles} of ${s.files} file runs could have reused a verdict${time}; ${s.misses} miss(es); ${bar}.`;
}
export function printSavings(o = {}) {
  const all = savings(o);
  if (o.json) { console.log(JSON.stringify(all, null, 2)); return all; }
  for (const s of all) console.log(savingsLine(s));
  return all;
}

// ── triage: record a verdict on a miss ───────────────────────────────────────
// `triage --lane <l> --file <path> --verdict flake|hole [--head <sha12>]`. A
// `hole` is a real footprint gap (fix the recorder); a `flake` is a test that
// fails on its own (fix or quarantine the test). Only `flake` lifts a suspension.
// Passing when re-run alone does NOT by itself make a red a flake: read its
// failure first. A wrong ARGUMENT whose assertion depends on timing can pass alone.
export function triage(o) {
  const ln = lane(o.lane);
  if (!o.file || o.file === true || !['flake', 'hole'].includes(o.verdict)) throw new Error('triage needs --file <path> and --verdict flake|hole');
  const misses = readTsv('misses-').filter((m) => m.lane === ln.name && m.file === o.file && (!o.head || m.head === o.head));
  if (!misses.length) { console.log(`tracegate triage: no logged miss for ${o.file}${o.head ? ` at ${o.head}` : ''}.`); process.exitCode = 1; return 0; }
  for (const m of misses) appendTsv('triage-', TRIAGE_HEADER, [new Date().toISOString(), ln.name, m.file, m.head, o.verdict]);
  console.log(`tracegate triage: ${misses.length} miss(es) for ${o.file} marked ${o.verdict}.`);
  return misses.length;
}

export function status() {
  const c = ctx();
  const count = (d) => { try { return fs.readdirSync(path.join(ledgerDir(), d), { recursive: true }).filter((f) => String(f).endsWith('.json.gz')).length; } catch { return 0; } };
  console.log(`root: ${c.root}\nconfig: ${c.configFound ? c.configPath : '(none — one lane "default" at the root, src/)'}\nledger: ${ledgerDir()}\nfootprints: ${count('fp')}  blobs: ${count('blobs')}`);
  for (const ln of Object.keys(c.lanes)) {
    const b = entryBar(ln);
    const d = modeDecision(ln);
    console.log(`${ln}: mode ${d.mode} (${d.why}) · entry bar ${b.ok ? 'MET' : 'not met'} (${b.observations}/${b.bar.observations} observations, ${b.spanDays}/${b.bar.days} days, misses: ${b.missesTotal}${b.recentMiss ? ', a recent one' : ''}; audit ${Math.round(b.auditRate * 100)}% once enforcing)`);
  }
  const rows = readTsv('shadow-').slice(-8);
  if (rows.length) { console.log('\nlast observations:'); for (const r of rows) console.log(`  ${r.at}  ${r.lane.padEnd(8)} ${r.mode.padEnd(7)} ${r.head}  must-run ${r.must_run}/${r.files}  time ${r.run_time_pct}%  misses ${r.misses}`); }
}
