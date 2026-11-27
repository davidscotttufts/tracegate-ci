#!/usr/bin/env node
// `tracegate pr` tests: the per-PR bar in a temporary repository. The runner is a
// fake vitest (node_modules/vitest/vitest.mjs) that lists the test files, fails a
// file containing "FAIL" and logs which files it ran; `gh` is a stub on PATH that
// logs its arguments. Nothing touches the network.
//   base...head selects the PR's added and changed tests; alwaysRun globs are added;
//   a red bar exits non-zero and posts failure; --post-status refuses a dirty tree
//   or another sha; the status names local/pr-bar and the exact head sha.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pr-test-')));
const repo = path.join(tmp, 'repo'); const bin = path.join(tmp, 'bin');
const runLog = path.join(tmp, 'ran.log'); const ghLog = path.join(tmp, 'gh.log');
fs.mkdirSync(repo); fs.mkdirSync(bin);
for (const k of Object.keys(process.env)) if (k.startsWith('TRACEGATE')) delete process.env[k];
const env = {
  ...process.env, TRACEGATE_ROOT: repo, TRACEGATE_LEDGER: path.join(tmp, 'ledger'), TRACEGATE_HOST: 'pr',
  TRACEGATE_BROKER_DIR: path.join(tmp, 'broker'), TRACEGATE_BROKER_SOCKET: path.join(tmp, 'b.sock'), TRACEGATE_BROKER_CAPACITY: '2', TRACEGATE_BROKER_ADAPTIVE: 'off',
  PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_RUN_LOG: runLog, GH_LOG: ghLog,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const tg = (args, extra = {}) => spawnSync(process.execPath, [CLI, 'pr', ...args], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
const ran = () => { try { return fs.readFileSync(runLog, 'utf8').split('\n').filter(Boolean).map((f) => path.relative(repo, f)).sort(); } catch { return []; } };
const posts = () => { try { return fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const field = (args, k) => { const i = args.findIndex((a) => a.startsWith(`${k}=`)); return i < 0 ? null : args[i].slice(k.length + 1); };
const reset = () => { fs.rmSync(runLog, { force: true }); fs.rmSync(ghLog, { force: true }); };

// The fake runner: `list` prints every *.test.ts under the lane; `run` writes the
// JSON results vitest would, logs each file it ran, and exits 1 if one says FAIL.
w('node_modules/vitest/package.json', JSON.stringify({ name: 'vitest', version: '4.1.0' }));
w('node_modules/vitest/vitest.mjs', `import fs from 'node:fs'; import path from 'node:path';
const a = process.argv.slice(2);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === 'node_modules' || e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : /\\.test\\.ts$/.test(e.name) ? [path.join(d, e.name)] : []);
if (a[0] === 'list') { console.log(JSON.stringify(walk(process.cwd()).map((file) => ({ file })))); process.exit(0); }
const out = a.find((x) => x.startsWith('--outputFile.json='))?.split('=')[1];
const files = a.slice(1).filter((x) => !x.startsWith('-'));
const res = files.map((f) => ({ name: f, status: fs.readFileSync(f, 'utf8').includes('FAIL') ? 'failed' : 'passed', startTime: 0, endTime: 1 }));
for (const f of files) fs.appendFileSync(process.env.FAKE_RUN_LOG, f + '\\n');
if (out) fs.writeFileSync(out, JSON.stringify({ testResults: res }));
process.exit(res.some((r) => r.status === 'failed') ? 1 : 0);
`);
// The gh stub: logs its argv as one JSON line; GH_FAIL=1 makes it fail.
fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
require('fs').appendFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(process.env.GH_FAIL === '1' ? 1 : 0);
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}');

g('init', '-q', '-b', 'main');
w('.gitignore', 'node_modules/\n');
w('tracegate.config.json', JSON.stringify({
  lanes: { app: { dir: '.', src: 'src' } },
  pr: { base: 'main', mustRun: false, alwaysRun: ['**/*ratchet*', 'census.test.ts'], commands: ['node check.cjs'] },
}));
w('check.cjs', "if (require('fs').readFileSync('lint.txt', 'utf8').includes('BAD')) process.exit(1);\n");
w('package.json', '{"type":"commonjs"}');
w('lint.txt', 'ok\n');
w('src/a.ts', 'export const a = 1;\n');
w('test/a.test.ts', 'a\n'); w('test/b.test.ts', 'b\n'); w('test/c.test.ts', 'c\n');
w('test/deep/x.ratchet.test.ts', 'r\n'); w('test/census.test.ts', 'census\n');
g('add', '-A'); g('commit', '-qm', 'base');
g('checkout', '-qb', 'feat');
w('test/a.test.ts', 'a changed\n'); w('test/new.test.ts', 'new\n'); w('src/a.ts', 'export const a = 2;\n');
g('add', '-A'); g('commit', '-qm', 'feature');
// main moves on after the branch point: base...head must not pick up its test.
g('checkout', '-q', 'main'); w('test/main-only.test.ts', 'm\n'); w('test/c.test.ts', 'c on main\n'); g('add', '-A'); g('commit', '-qm', 'main moves'); g('checkout', '-q', 'feat');
const HEAD = g('rev-parse', 'HEAD');

// ── selection: base...head, plus always-run ──────────────────────────────────
const dry = tg(['--dry-run', '--json']);
const p = JSON.parse(dry.stdout || '{}');
const lp = p.lanes?.[0] ?? { files: [] };
check('selection: the PR\'s changed and added test files are selected', lp.files.includes('test/a.test.ts') && lp.files.includes('test/new.test.ts') && lp.counts.changed === 2, JSON.stringify(lp));
check('selection: base...head is from the merge-base (main\'s later tests are not the PR\'s)', !lp.files.includes('test/main-only.test.ts') && !p.changed.includes('test/main-only.test.ts') && !p.changed.includes('test/c.test.ts'), JSON.stringify(p.changed));
check('selection: unchanged tests outside the always-run set are not selected', !lp.files.includes('test/b.test.ts') && !lp.files.includes('test/c.test.ts'), JSON.stringify(lp.files));
check('always-run: "**/*ratchet*" matches in a subdirectory, and a bare name matches the base name', lp.files.includes('test/deep/x.ratchet.test.ts') && lp.files.includes('test/census.test.ts') && lp.counts.always === 2, JSON.stringify(lp));
const mr = tg(['--dry-run', '--json'], { TRACEGATE_CONFIG: (() => { const f = path.join(tmp, 'mustrun.json'); fs.writeFileSync(f, JSON.stringify({ lanes: { app: { dir: '.', src: 'src' } }, pr: { base: 'main' } })); return f; })() });
const mlp = JSON.parse(mr.stdout || '{}').lanes?.[0] ?? { files: [] };
check('must-run: with no footprints every file must run (nothing is reusable)', mlp.counts?.mustRun === 6 && mlp.files.length === 6 && /no footprint/.test(mlp.why['test/b.test.ts']), JSON.stringify(mlp));

// ── green: runs the plan, posts success on the exact head ────────────────────
reset();
const green = tg(['--post-status', '--repo', 'o/r', '--no-lease']);
check('green: exit 0', green.status === 0, green.stdout + green.stderr);
check('green: ran exactly the selected files', JSON.stringify(ran()) === JSON.stringify(['test/a.test.ts', 'test/census.test.ts', 'test/deep/x.ratchet.test.ts', 'test/new.test.ts']), JSON.stringify(ran()));
const ok = posts()[0] ?? [];
check('status: POSTs to repos/<repo>/statuses/<head sha> with context local/pr-bar', ok.includes('POST') && ok.includes(`repos/o/r/statuses/${HEAD}`) && field(ok, 'context') === 'local/pr-bar' && field(ok, 'state') === 'success', JSON.stringify(ok));
check('status: the description carries the counts, ≤ 140 chars', /2 changed, 0 must-run, 2 always/.test(field(ok, 'description') ?? '') && field(ok, 'description').length <= 140, field(ok, 'description'));

// ── red: a failing test exits 1 and posts failure naming it ──────────────────
w('test/new.test.ts', 'FAIL\n'); g('commit', '-qam', 'breaks'); const RED = g('rev-parse', 'HEAD');
reset();
const red = tg(['--post-status', '--repo', 'o/r', '--no-lease']);
const bad = posts()[0] ?? [];
check('red: a failing test exits non-zero', red.status === 1, `exit ${red.status}`);
check('red: posts state=failure on the head, naming the first failing item', field(bad, 'state') === 'failure' && bad.includes(`repos/o/r/statuses/${RED}`) && /test\/new\.test\.ts/.test(field(bad, 'description') ?? ''), JSON.stringify(bad));
w('test/new.test.ts', 'new\n'); w('lint.txt', 'BAD\n'); g('commit', '-qam', 'lint breaks');
reset();
const lint = tg(['--post-status', '--repo', 'o/r', '--no-lease']);
check('red: a failing command fails the bar and is the item named', lint.status === 1 && /command node check\.cjs/.test(field(posts()[0] ?? [], 'description') ?? ''), JSON.stringify(posts()));
w('lint.txt', 'ok\n'); g('commit', '-qam', 'lint fixed');

// ── refusals: dirty tree, another sha ────────────────────────────────────────
reset();
w('scratch.txt', 'untracked\n');
const dirty = tg(['--post-status', '--repo', 'o/r', '--no-lease']);
check('refuse: --post-status on a dirty tree exits 3, runs nothing and posts nothing', dirty.status === 3 && ran().length === 0 && posts().length === 0 && /dirty/.test(dirty.stderr), `exit ${dirty.status}: ${dirty.stderr}`);
fs.rmSync(path.join(repo, 'scratch.txt'));
const other = tg(['--post-status', '--repo', 'o/r', '--no-lease', '--sha', HEAD]);
check('refuse: --sha that is not the checked-out HEAD exits 3 and posts nothing', other.status === 3 && posts().length === 0 && /not the checked-out HEAD/.test(other.stderr), `exit ${other.status}: ${other.stderr}`);
const otherHead = tg(['--post-status', '--repo', 'o/r', '--no-lease', '--head', 'main']);
check('refuse: --head that is not the checked-out HEAD exits 3', otherHead.status === 3 && posts().length === 0, `exit ${otherHead.status}`);
const ghDown = tg(['--post-status', '--repo', 'o/r', '--no-lease'], { GH_FAIL: '1' });
check('a green bar whose status cannot be posted exits 4, not 0', ghDown.status === 4, `exit ${ghDown.status}: ${ghDown.stderr}`);

// ── the broker: the bar runs under a `pr` lease ──────────────────────────────
reset();
const leased = tg(['--repo', 'o/r']);
const hist = spawnSync(process.execPath, [CLI, 'history', '--n', '50'], { cwd: repo, env, encoding: 'utf8' });
check('broker: without --no-lease the bar runs under a lease of class pr', leased.status === 0 && ran().length === 4 && /"class":"pr"/.test(hist.stdout) && /pr feat/.test(hist.stdout), `exit ${leased.status} ${leased.stderr} | ${hist.stdout.slice(0, 400)}`);
spawnSync(process.execPath, [CLI, 'broker', 'stop'], { cwd: repo, env });

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== pr tests: ${fail} FAILED, ${pass} passed ==` : `\n== pr tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
