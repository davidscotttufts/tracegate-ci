#!/usr/bin/env node
// Dependency-change tests (Phase 3; src/deps.mjs and the lockfile path in
// src/predictor.mjs). A throwaway repo with an npm v3 lockfile; footprints are
// ingested from synthetic raw files (as the self-test does), each carrying the
// packages its worker loaded, beside the packages the vitest process loaded.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-deps-test-')));
const repo = path.join(tmp, 'repo'); const ledger = path.join(tmp, 'ledger');
fs.mkdirSync(repo);
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
g('init', '-q');
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const commit = (m) => { g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', m); return g('rev-parse', 'HEAD').trim(); };
process.env.TRACEGATE_ROOT = repo; process.env.TRACEGATE_LEDGER = ledger; process.env.TRACEGATE_HOST = 'depstest';
delete process.env.TRACEGATE_DEPS;

const pkgJson = (deps, extra = {}) => JSON.stringify({ name: 'app', version: '1.0.0', scripts: { test: 'vitest' }, dependencies: deps, ...extra }, null, 2) + '\n';
const lock = (pk) => JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', version: '1.0.0' }, ...pk } }, null, 2) + '\n';
const P0 = { 'node_modules/a': { version: '1.0.0', integrity: 'sha-a1' }, 'node_modules/b': { version: '1.0.0', integrity: 'sha-b1' }, 'node_modules/r': { version: '1.0.0', integrity: 'sha-r1' } };
w('package.json', pkgJson({ a: '^1.0.0', b: '^1.0.0' }));
w('package-lock.json', lock(P0));
w('src/x.ts', 'export const x = 1;\n');
for (const t of ['test/ta.test.ts', 'test/tb.test.ts', 'test/tlock.test.ts', 'test/told.test.ts']) w(t, "it('t', () => {});\n");
const C1 = commit('base');

const tg = await import('../src/predictor.mjs');
const deps = await import('../src/deps.mjs');
const { ctx } = await import('../src/config.mjs');
const { pkgOf } = await import('../src/pkg.mjs');

// ── pure parts ───────────────────────────────────────────────────────────────
check('pkgOf: a nested, scoped package in a lane directory', pkgOf('/r/be/node_modules/a/node_modules/@s/b/lib/c.js', '/r') === 'be/node_modules/a/node_modules/@s/b');
check('pkgOf: outside the repository, or in a dot directory, is unknown (null)', pkgOf('/o/node_modules/a/x.js', '/r') === null && pkgOf('/r/node_modules/.vite/deps/a.js', '/r') === null);
check('package.json: a dependency-only edit is recognised', deps.depsOnlyPackageJson(pkgJson({ a: '^1.0.0' }), pkgJson({ a: '^1.1.0' })));
check('package.json: any other edit is not', !deps.depsOnlyPackageJson(pkgJson({ a: '^1.0.0' }), pkgJson({ a: '^1.1.0' }, { type: 'module' })) && !deps.depsOnlyPackageJson('{', pkgJson({})));
check('lockfile: only npm v2/v3 lockfiles are understood', deps.lockDiff('{"lockfileVersion":1,"dependencies":{}}', lock(P0)) === null && deps.lockDiff(lock(P0), 'not json') === null);
const nd = deps.lockDiff(lock(P0), lock({ ...P0, 'node_modules/a/node_modules/c': { version: '2.0.0' } }));
check('lockfile: a new nested copy also changes the package that resolves it', nd.changed.has('node_modules/a/node_modules/c') && nd.changed.has('node_modules/a') && !nd.changed.has('node_modules/b'), JSON.stringify([...nd.changed]));
check('lockfile: a workspace link is a repo file, not a package', deps.lockDiff(lock(P0), lock({ ...P0, 'node_modules/ws': { resolved: 'packages/ws', link: true } })).changed.size === 0);
check('semver class', deps.semverClass('1.2.3', '2.0.0') === 'major' && deps.semverClass('1.2.3', '1.3.0') === 'minor' && deps.semverClass('1.2.3', '1.2.4') === 'patch' && deps.semverClass(null, '1.0.0') === 'added');

// ── footprints: ta loaded a, tb loaded b, tlock read the lockfile, told has no package list
const { dropFps } = await import('../src/ledger.mjs');
const ingestAt = (runner = ['node_modules/r']) => {
  for (const t of ['ta', 'tb', 'tlock', 'told']) dropFps('default', `test/${t}.test.ts`); // one footprint per file: each case reads only its own
  const run = fs.mkdtempSync(path.join(tmp, 'run-'));
  fs.mkdirSync(path.join(run, 'raw'));
  const raw = (testFile, pkgs, reads = []) => fs.writeFileSync(path.join(run, 'raw', `${path.basename(testFile)}.json`), JSON.stringify({ v: 1, testFile, node: process.version, loaded: [testFile], exec: {}, unmapped: [], reads, ...(pkgs === undefined ? {} : { pkgs }) }));
  raw('test/ta.test.ts', ['node_modules/a']); raw('test/tb.test.ts', ['node_modules/b']); raw('test/tlock.test.ts', ['node_modules/b'], ['package-lock.json']); raw('test/told.test.ts', undefined);
  if (runner !== 'none') fs.writeFileSync(path.join(run, 'runner-pkgs.json'), JSON.stringify(runner));
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify({ testResults: ['ta', 'tb', 'tlock', 'told'].map((t) => ({ name: path.join(repo, `test/${t}.test.ts`), status: 'passed', startTime: 0, endTime: 5, assertionResults: [] })) }));
  tg.ingest({ lane: 'default', run });
};
ingestAt();
const decideAll = () => { tg.clearChangeCache(); tg.clearLockDiffCache(); return Object.fromEntries(['ta', 'tb', 'tlock', 'told'].map((t) => [t, tg.decide(`test/${t}.test.ts`, tg.head(), process.version, tg.lockHash('default'), 'default')])); };
const back = () => { g('checkout', '-q', C1, '--', '.'); };

// A bump of a (package.json + lockfile together, as a real bump is).
w('package.json', pkgJson({ a: '^1.1.0', b: '^1.0.0' }));
w('package-lock.json', lock({ ...P0, 'node_modules/a': { version: '1.1.0', integrity: 'sha-a2' } }));
commit('bump a');
let d = decideAll();
check('rule: a file that loaded the bumped package runs', d.ta.run && d.ta.reason === 'lockfile changed: package node_modules/a', d.ta.reason);
check('rule (auto, bar not met): a file that did not still runs, marked would-reuse', d.tb.run && d.tb.depsWouldReuse === true, JSON.stringify(d.tb));
check('rule: a file that READ the lockfile runs (only the global rule is waived)', d.tlock.run && /read input package-lock\.json/.test(d.tlock.reason), d.tlock.reason);
check('rule: a footprint recorded without a package list runs, as before', d.told.run && d.told.reason === 'lockfile changed', d.told.reason);
ctx().deps.mode = 'enforce';
d = decideAll();
check('rule (enforce): a file that loaded no changed package keeps its verdict', !d.tb.run && d.tb.deps === true, JSON.stringify(d.tb));
check('rule (enforce): the file that loaded it still runs', d.ta.run);
ctx().deps.mode = 'off';
d = decideAll();
check('rule (off): every file runs on a lockfile change', d.tb.run && d.tb.reason === 'lockfile changed' && !d.tb.depsWouldReuse);
ctx().deps.mode = 'enforce';

// A bump of a package the vitest process loaded: global.
back(); commit('back'); ingestAt();
w('package-lock.json', lock({ ...P0, 'node_modules/r': { version: '1.0.1', integrity: 'sha-r2' } })); commit('bump r');
d = decideAll();
check('rule: a package the vitest process loaded is a global input', d.tb.run && /loaded by the vitest process/.test(d.tb.reason), d.tb.reason);
// A package with an install script: global.
back(); commit('back2'); ingestAt();
w('package-lock.json', lock({ ...P0, 'node_modules/b': { version: '1.0.1', integrity: 'sha-b2', hasInstallScript: true } })); commit('native b');
d = decideAll();
check('rule: a changed package with native code runs the whole lane', d.ta.run && /native code/.test(d.ta.reason), d.ta.reason);
// A run whose vitest-process list is unknown: the rule does not apply.
back(); commit('back3'); ingestAt('none');
w('package-lock.json', lock({ ...P0, 'node_modules/a': { version: '1.2.0', integrity: 'sha-a3' } })); commit('bump a again');
d = decideAll();
check('rule: no list from the vitest process → the rule does not apply', d.tb.run && d.tb.reason === 'lockfile changed', d.tb.reason);
// package.json edited beyond its dependencies: still global.
back(); commit('back4'); ingestAt();
w('package.json', pkgJson({ a: '^1.1.0', b: '^1.0.0' }, { type: 'module' }));
w('package-lock.json', lock({ ...P0, 'node_modules/a': { version: '1.1.0', integrity: 'sha-a2' } })); commit('bump a + type');
d = decideAll();
check('rule: a package.json edit beyond dependencies is still a global input', d.tb.run && d.tb.reason === 'global input package.json', d.tb.reason);
// An ordinary source change is unaffected by the rule.
back(); commit('back5'); ingestAt();
w('package.json', pkgJson({ a: '^1.1.0', b: '^1.0.0' }));
w('package-lock.json', lock({ ...P0, 'node_modules/a': { version: '1.1.0', integrity: 'sha-a2' } }));
w('test/tb.test.ts', "it('t2', () => {});\n"); commit('bump a + edit tb');
d = decideAll();
check('rule: the other rules still apply across a lockfile change', d.tb.run && d.tb.reason === 'the test file changed', d.tb.reason);

// ── the rule's own bar ───────────────────────────────────────────────────────
ctx().deps.mode = 'auto';
const rows = (list) => fs.writeFileSync(path.join(ledger, 'deps-depstest.tsv'), 'at\tlane\tmode\thead\tchanged\twould_reuse\treused\tfailed_of_those\tfiles\n' + list.map((r) => `${r.at}\tdefault\tshadow\th\t\t${r.would}\t0\t${r.failed}\t4\n`).join(''));
const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
rows([{ at: ago(2), would: 3, failed: 0 }, { at: ago(1.5), would: 3, failed: 0 }]);
check('bar: two scored lockfile runs are not enough', !deps.depsBar('default').ok);
rows([{ at: ago(2), would: 3, failed: 0 }, { at: ago(1.5), would: 3, failed: 0 }, { at: ago(1), would: 1, failed: 0 }]);
check('bar: three over a day, none failing, are', deps.depsBar('default').ok, JSON.stringify(deps.depsBar('default')));
rows([{ at: ago(0.2), would: 3, failed: 0 }, { at: ago(0.1), would: 3, failed: 0 }, { at: ago(0.05), would: 1, failed: 0 }]);
check('bar: ...but not inside one day', !deps.depsBar('default').ok);
rows([{ at: ago(2), would: 3, failed: 0 }, { at: ago(1.5), would: 3, failed: 0 }, { at: ago(1), would: 1, failed: 0 }, { at: ago(0.5), would: 2, failed: 1 }]);
check('bar: a recent failure among files it would have reused holds it back', !deps.depsBar('default').ok && deps.depsBar('default').bad);
fs.rmSync(path.join(ledger, 'deps-depstest.tsv'));

// ── report scores it ─────────────────────────────────────────────────────────
const run = fs.mkdtempSync(path.join(tmp, 'rep-'));
fs.writeFileSync(path.join(run, 'predict.json'), JSON.stringify({ lane: 'default', mode: 'shadow', head: tg.head(), decisions: {
  'test/ta.test.ts': { run: true, reason: 'lockfile changed: package node_modules/a' }, 'test/tb.test.ts': { run: true, depsWouldReuse: true, reason: 'lockfile changed (…)' },
  'test/tlock.test.ts': { run: true, depsWouldReuse: true, reason: 'lockfile changed (…)' } } }));
fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify({ testResults: [
  { name: path.join(repo, 'test/ta.test.ts'), status: 'passed', assertionResults: [] }, { name: path.join(repo, 'test/tb.test.ts'), status: 'failed', assertionResults: [] },
  { name: path.join(repo, 'test/tlock.test.ts'), status: 'passed', assertionResults: [] }] }));
const quiet = console.log; console.log = () => {};
try { tg.report({ lane: 'default', run }); } finally { console.log = quiet; }
const dr = (await import('../src/ledger.mjs')).readTsv('deps-');
check('report: a lockfile run logs what the rule would have reused and how many of those failed', dr.length === 1 && dr[0].would_reuse === '2' && dr[0].failed_of_those === '1', JSON.stringify(dr));

// ── the oracle, in shadow ────────────────────────────────────────────────────
const diff = { changed: new Set(['node_modules/a']), native: [], versions: { 'node_modules/a': { from: '1.0.0', to: '2.0.0' } } };
const pk = deps.writeDepsPacket({ lane: 'default', head: tg.head(), lockfile: 'package-lock.json', diff, loadedBy: { 'node_modules/a': 1 }, files: 4, failed: ['test/ta.test.ts'] });
check('oracle: a packet lists each changed package with its semver class and how many files loaded it', pk.packages[0].class === 'major' && pk.packages[0].loadedByFiles === 1 && deps.readDepsPacket(pk.id).id === pk.id);
const refused = (o) => { try { deps.annotateDeps(o); return false; } catch (e) { return /prediction refused/.test(e.message); } };
check('oracle: a prediction is closed-world (unknown field, bad affected, bad confidence)', refused({ id: pk.id, affected: 'all', confidence: 0.5, reasons: 'x', skip: true }) && refused({ id: pk.id, affected: 'some', confidence: 0.5, reasons: 'x' }) && refused({ id: pk.id, affected: [], confidence: 2, reasons: 'x' }));
deps.annotateDeps({ id: pk.id, affected: ['test/tb.test.ts'], confidence: 0.6, reasons: 'a is only used by tb' });
const sc = deps.scoreDeps();
check('oracle: score is recall over the files that failed, and the share it would have run', sc.predictions === 1 && sc.recall === 0 && sc.meanShare === 0.25, JSON.stringify(sc));
check('oracle: nothing in the predictor reads predictions', !fs.readFileSync(new URL('../src/predictor.mjs', import.meta.url), 'utf8').includes('depsOpinions') && !fs.readFileSync(new URL('../src/predictor.mjs', import.meta.url), 'utf8').includes('annotateDeps'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== dependency tests: ${fail} FAILED, ${pass} passed ==` : `\n== dependency tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
