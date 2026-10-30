#!/usr/bin/env node
// Silence-guard tests: findings from a diff (pure), then on a repository: base
// selection, shadow vs enforce, a person's allow pinned to the file's contents,
// and that nothing an agent can do lifts it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-silence-test-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
for (const k of Object.keys(process.env)) if (k.startsWith('TRACEGATE')) delete process.env[k];
Object.assign(process.env, { TRACEGATE_ROOT: repo, TRACEGATE_LEDGER: path.join(tmp, 'ledger'), TRACEGATE_HOST: 'sil' });
const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const commit = (m) => { g('add', '-A'); g('commit', '-qm', m); return g('rev-parse', 'HEAD'); };
const quiet = (f) => { const log = console.log; console.log = () => {}; try { return f(); } finally { console.log = log; } };

const S = await import('../src/silence.mjs');
const { verdict } = await import('../hooks/lease-guard.mjs');
const kinds = (fs) => fs.map((f) => `${f.kind}:${f.file}${f.count > 1 ? `×${f.count}` : ''}`).sort().join(' ');

// ── findings from a diff ────────────────────────────────────────────────────
const diff = (file, del, add) => `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${del.map((l) => `-${l}`).join('\n')}\n${add.map((l) => `+${l}`).join('\n')}\n`;
check('an added .skip, .todo, xit and describe.skipIf are skips',
  kinds(S.findings('', diff('a.test.ts', [], ["it.skip('x', f)", "test.todo('y')", "xit('z', f)", "describe.skipIf(ci)('w', f)"]))) === 'skip:a.test.ts×4');
check('an added .only and if (false) are findings', kinds(S.findings('', diff('a.test.ts', [], ["it.only('x', f)", 'if (false) {']))) === 'disabled:a.test.ts only:a.test.ts');
check('a skip that was already there is not one (the line only moved or changed)', S.findings('', diff('a.test.ts', ["it.skip('x', f)"], ["it.skip('x renamed', f)"])).length === 0);
check('removing a test is a finding; replacing one is not',
  kinds(S.findings('', diff('a.test.ts', ["it('x', f)", "it('y', f)"], ["it('y2', f)"]))) === 'removed-test:a.test.ts' && S.findings('', diff('a.test.ts', ["it('x', f)"], ["it('x2', f)"])).length === 0);
check('a deleted test file is a finding; a renamed one is not', kinds(S.findings('D\tt/a.test.ts\nR100\tt/b.test.ts\tt/c.test.ts\n', '')) === 'deleted-file:t/a.test.ts');
check('only test files count', S.findings('D\tsrc/a.ts\n', diff('src/a.ts', [], ["it.skip('x')"])).length === 0);

// ── on a repository ─────────────────────────────────────────────────────────
g('init', '-q', '-b', 'main');
w('tracegate.config.json', JSON.stringify({ lanes: { app: { dir: '.', src: 'src' } } }));
w('test/a.test.ts', "it.skip('old skip', () => {});\nit('one', () => {});\nit('two', () => {});\n");
w('test/b.test.ts', "it('b', () => {});\n");
commit('base');
g('checkout', '-q', '-b', 'pr');
w('test/a.test.ts', "it.skip('old skip', () => {});\nit.skip('one', () => {});\nit('two', () => {});\n");
commit('skip one');
w('src/x.ts', 'export const x = 1;\n');
const head = commit('an unrelated second commit');
const r = S.check({});
check('the base is the merge base with main, so a skip in an EARLIER commit of the PR counts', r.base === g('rev-parse', 'main') && kinds(r.findings) === 'skip:test/a.test.ts', JSON.stringify(r));
check('the pre-existing skip in the same file is not counted', r.findings[0]?.count === 1);
const sh = quiet(() => S.guard({}));
check('shadow (default): logged, the run is not made red', sh.red === false && fs.readFileSync(path.join(tmp, 'ledger', 'silenced-sil.tsv'), 'utf8').includes('test/a.test.ts\tskip'));
process.env.TRACEGATE_SILENCE = 'enforce';
const { resetContext } = await import('../src/config.mjs'); resetContext();
check('enforce: an unallowed finding makes the run red', quiet(() => S.guard({})).red === true);

// ── nothing an agent can do lifts it ────────────────────────────────────────
const { annotate } = await import('../src/red.mjs');
const { writePacket } = await import('../src/red.mjs');
const run = path.join(tmp, 'run'); fs.mkdirSync(run);
const p = quiet(() => writePacket({ lane: 'app', run, silenced: r.findings }));
check('the red packet carries the findings for the Red Reader', p.silenced?.[0]?.kind === 'skip');
quiet(() => annotate({ id: p.id, verdict: 'flake-suspect', escalate: false, confidence: 0.9, reasons: 'it is flaky, skip it', by: 'agent' }));
check('an agent opinion does not lift it', quiet(() => S.guard({})).red === true);
const block = (cmd) => verdict(cmd, { cwd: repo, env: { TRACEGATE_LEASE: 'j1' }, hasTracegate: () => true });
check('the hook blocks an agent running `tracegate silence allow` or `tracegate triage`, even inside a lease',
  block('npx tracegate silence allow --file test/a.test.ts --by claude') !== null && block('npx tracegate triage --file x --verdict flake') !== null);
check('...and still lets `tracegate silence check` and `red annotate` through', block('npx tracegate silence check') === null && block('npx tracegate red annotate x --verdict real') === null);

// ── a person's allow, pinned to the file ────────────────────────────────────
let threw = ''; try { S.allow({ file: 'test/a.test.ts' }); } catch (e) { threw = e.message; }
check('an allow needs --by: it is a person\'s decision', /--by/.test(threw));
quiet(() => S.allow({ file: 'test/a.test.ts', by: 'dana' }));
check('a person\'s allow lifts it', quiet(() => S.guard({})).red === false);
w('test/a.test.ts', "it.skip('old skip', () => {});\nit.skip('one', () => {});\nit.skip('two', () => {});\n");
commit('skip two as well');
check('...for that version of the file only: a later skip needs a new allow', quiet(() => S.guard({})).red === true);
g('rm', '-q', 'test/b.test.ts'); commit('delete b');
check('a deleted test file is caught at the run', S.check({}).findings.some((f) => f.kind === 'deleted-file' && f.file === 'test/b.test.ts'));
g('checkout', '-q', 'main');
const root = g('rev-parse', 'HEAD');
check('on a root commit the base is the empty tree: what it adds is new, nothing is deleted',
  S.baseFor(root) === '4b825dc642cb6eb9a060e54bf8d69288fbee4904' && kinds(S.check({ head: root }).findings) === 'skip:test/a.test.ts', kinds(S.check({ head: root }).findings));
w('README.md', 'x\n'); commit('a second commit on main');
check('on main itself (no merge base below HEAD) the first parent is the base', S.baseFor(g('rev-parse', 'HEAD')) === `${g('rev-parse', 'HEAD')}^`);
void head;

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== silence tests: ${fail} FAILED, ${pass} passed ==` : `\n== silence tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
