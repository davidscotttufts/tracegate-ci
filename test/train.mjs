#!/usr/bin/env node
// Merge-train tests: three PRs with one red, in a temporary repository. The gate
// is a script (no broker, no vitest) that fails when the tree holds "BAD" and logs
// the tree it passed, so the invariants can be checked against what was gated:
//   a red PR never lands; the target only points at a gated-green tree;
//   bisection ends within 2n − 1 gates; a moved target lands nothing.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-train-test-')));
const repo = path.join(tmp, 'repo'); const ledger = path.join(tmp, 'ledger'); const green = path.join(tmp, 'green.log');
fs.mkdirSync(repo);
for (const k of Object.keys(process.env)) if (k.startsWith('TRACEGATE')) delete process.env[k];
Object.assign(process.env, { TRACEGATE_ROOT: repo, TRACEGATE_LEDGER: ledger, TRACEGATE_HOST: 'train' });
const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
// The gate: red when any tracked file says BAD; on green, log the tree it saw.
const GATE = `node -e 'const {execSync}=require("child_process"); const files=execSync("git ls-files",{encoding:"utf8"}).split("\\n").filter(Boolean); if (files.some((f)=>require("fs").readFileSync(f,"utf8").includes("BAD"))) process.exit(1); require("fs").appendFileSync(${JSON.stringify(green)}, execSync("git rev-parse HEAD^{tree}",{encoding:"utf8"}))'`;

g('init', '-q', '-b', 'main');
w('tracegate.config.json', JSON.stringify({ lanes: { app: { dir: '.', src: 'src' } } }));
w('src/base.txt', 'base\n');
g('add', '-A'); g('commit', '-qm', 'base');
const branch = (name, file, text) => { g('checkout', '-q', '-b', name, 'main'); w(file, text); g('add', '-A'); g('commit', '-qm', name); g('checkout', '-q', 'main'); };
branch('pr1', 'src/one.txt', 'one\n');
branch('pr2', 'src/two.txt', 'BAD\n');
branch('pr3', 'src/three.txt', 'three\n');
branch('pr4', 'src/base.txt', 'conflicting edit\n');
branch('pr5', 'src/base.txt', 'another edit\n');

const T = await import('../src/train.mjs');
const { trainScore } = await import('../src/conductor.mjs');
const opts = { gate: GATE, 'no-lease': true, quiet: true };

// ── queueing ────────────────────────────────────────────────────────────────
for (const p of ['pr1', 'pr2', 'pr3']) T.add({ pr: p });
check('add pins each PR to its commit', T.queue().map((q) => q.sha).join() === ['pr1', 'pr2', 'pr3'].map((b) => g('rev-parse', b)).join());
let threw = false; try { T.add({ pr: 'pr1' }); } catch { threw = true; }
check('a PR cannot be queued twice', threw);
T.add({ pr: 'x=pr3' }); T.drop({ pr: 'x' });
check('drop takes a PR out of the queue', T.queue().map((q) => q.pr).join() === 'pr1,pr2,pr3');

// ── one red PR among three ──────────────────────────────────────────────────
const base = g('rev-parse', 'main');
const r = T.run(opts);
check('the two green PRs land, the red one is rejected', r.landed.sort().join() === 'pr1,pr3' && r.rejected.map((x) => x.pr).join() === 'pr2', JSON.stringify(r));
const tree = (ref) => g('rev-parse', `${ref}^{tree}`);
check('a red PR never lands: its commit is not in main', (() => { try { g('merge-base', '--is-ancestor', 'pr2', 'main'); return false; } catch { return true; } })());
const greens = fs.readFileSync(green, 'utf8').trim().split('\n');
check('main points at a commit whose exact tree was gated green', tree('main') === greens.at(-1) && g('rev-parse', 'main') !== base, `${tree('main')} vs ${greens.at(-1)}`);
check('every landed commit is a merge on top of the old main', (() => { try { g('merge-base', '--is-ancestor', base, 'main'); return true; } catch { return false; } })());
check('bisection ends within 2n − 1 gates (here 5: abc, ab, a, b, c)', r.gates === 5, String(r.gates));
check('the checked-out main was fast-forwarded and is clean', g('rev-parse', 'HEAD') === g('rev-parse', 'main') && g('status', '--porcelain') === '');
check('the queue is empty and the log says why pr2 was rejected', T.queue().length === 0 && T.status().recent.some((e) => e.pr === 'pr2' && e.event === 'rejected' && e.note.startsWith('red gate')));
check('the outcome reached the Conductor: one train, one red PR', (() => { const s = trainScore(); return s.trains === 1 && s.red === 1; })(), JSON.stringify(trainScore()));
check('no worktree is left behind', g('worktree', 'list').split('\n').length === 1, g('worktree', 'list'));

// ── conflicts ───────────────────────────────────────────────────────────────
T.add({ pr: 'pr4' }); T.add({ pr: 'pr5' });
const r2 = T.run(opts);
check('a PR that does not merge cleanly is rejected as a conflict; the other lands', r2.landed.join() === 'pr4' && r2.rejected[0]?.pr === 'pr5' && r2.rejected[0].why === 'merge conflict', JSON.stringify(r2));

// ── a moved target lands nothing ────────────────────────────────────────────
branch('pr6', 'src/six.txt', 'six\n');
T.add({ pr: 'pr6' });
g('checkout', '-q', '--detach', 'main'); // main is not checked out: the compare-and-swap path
const before = g('rev-parse', 'main');
const mover = `${GATE} && git -C ${JSON.stringify(repo)} update-ref refs/heads/main $(git -C ${JSON.stringify(repo)} commit-tree -p main -m moved main^{tree})`;
const r3 = T.run({ ...opts, gate: mover });
const moved = g('rev-parse', 'main');
check('a target that moved during the gate lands nothing', r3.landed.length === 0 && r3.invalidated === 'the target moved' && moved !== before && g('log', '-1', '--format=%s', 'main') === 'moved', JSON.stringify(r3));
check('...and the PR stays queued for the next train', T.queue().map((q) => q.pr).join() === 'pr6');
const r4 = T.run(opts);
check('the next train lands it on the moved target (compare-and-swap path)', r4.landed.join() === 'pr6' && g('rev-parse', 'main^1') === moved, JSON.stringify(r4));

// ── a checked-out target with local changes is not touched ──────────────────
g('checkout', '-q', 'main'); branch('pr7', 'src/seven.txt', 'seven\n'); T.add({ pr: 'pr7' });
w('src/base.txt', 'uncommitted\n');
const r5 = T.run(opts);
check('main checked out with local changes: nothing lands, the work is untouched', r5.landed.length === 0 && /local changes/.test(r5.invalidated ?? '') && fs.readFileSync(path.join(repo, 'src/base.txt'), 'utf8') === 'uncommitted\n', JSON.stringify(r5));
g('checkout', '-q', '--', 'src/base.txt'); T.drop({ pr: 'pr7' });

// ── every PR red ────────────────────────────────────────────────────────────
for (const n of ['a', 'b', 'c', 'd']) { branch(`bad-${n}`, `src/bad-${n}.txt`, 'BAD\n'); T.add({ pr: `bad-${n}` }); }
const tip = g('rev-parse', 'main');
const r6 = T.run(opts);
check('four red PRs: all rejected, main unchanged, at most 7 gates', r6.rejected.length === 4 && r6.landed.length === 0 && g('rev-parse', 'main') === tip && r6.gates <= 7, JSON.stringify(r6));

// ── one train at a time ─────────────────────────────────────────────────────
const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(ledger, 'train.lock'), String(sleeper.pid));
let busy = ''; try { T.run(opts); } catch (e) { busy = e.message; }
check('a second train refuses while one runs', /another train is running/.test(busy), busy);
sleeper.kill();
fs.writeFileSync(path.join(ledger, 'train.lock'), '999999');
let stale = true; try { T.run(opts); } catch { stale = false; }
check('...and a lock left by a dead process is taken over', stale && !fs.existsSync(path.join(ledger, 'train.lock')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== train tests: ${fail} FAILED, ${pass} passed ==` : `\n== train tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
