#!/usr/bin/env node
// Self-test for Tracegate.
//
// Builds a throwaway git repo with three lanes, records ONE footprint for a test
// file, then makes one commit per kind of change and asserts the decision.
// Both directions are asserted on purpose: a predictor that always says "run"
// fails the SKIP rows, and one that always says "skip" fails the RUN rows, so
// neither degenerate predictor can pass. Every rule here has been broken on
// purpose at least once to check that its row goes red (see docs/guide.md, "Testing and releasing").
//
// Only this script's ✓/✗ lines are shown; the tool's own output ("1 MISS(ES)…")
// is part of the scenarios and would read like a real miss in a CI log. Set
// TRACEGATE_SELFTEST_VERBOSE=1 to see it.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-selftest-')));
const ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-ledger-'));
for (const k of Object.keys(process.env)) if (k.startsWith('TRACEGATE')) delete process.env[k];
process.env.TRACEGATE_ROOT = repo;
process.env.TRACEGATE_LEDGER = ledger;
process.env.TRACEGATE_HOST = 'selftest';
const SRC = 'packages/api/src/a.ts';
const BSRC = 'packages/api/src/b.ts';
const TEST = 'packages/api/test/x.test.ts';
process.env.TRACEGATE_TEST_LIST = TEST;
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gc = (...a) => g('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a);
const w = (relp, text) => { fs.mkdirSync(path.dirname(path.join(repo, relp)), { recursive: true }); fs.writeFileSync(path.join(repo, relp), text); };

const base = `import { helper } from './b';
export interface Shape { id: string }
export type Id = string;

export const TABLE = ['alpha', 'beta'];
export const OTHER = { unused: true };

export function foo(): number {
  return TABLE.length + helper() + parseInt('0', 10);
}

export function bar(): number {
  return 42;
}

export function baz(): number {
  return TABLE.filter((x) => x === 'zz').length;
}

export const router = { get: (_p: string, h: () => number) => h };
router.get('/hit', () => foo());
router.get('/cold', () => bar());
`;
w('tracegate.config.json', JSON.stringify({
  lanes: {
    // Early entry: 1 day instead of the default 14, auditing 20% until day 14.
    api: { dir: 'packages/api', src: 'src', globals: ['test/setup/'], entryBar: { days: 1, earlyAudit: 0.2 } },
    web: { dir: 'packages/web', src: 'src', entryBar: { days: 1, earlyAudit: 0.2 } },
    // The default bar (14 days, 20 observations).
    plain: { dir: 'packages/plain', src: 'src' },
  },
}, null, 2));
w(SRC, base);
const bBase = "export function helper(): number { return USED.size; }\nexport const USED = new Set(['x']);\nexport const IDLE = new Set(['y']);\nexport function wrongHelper(): number { return 2; }\nexport function parseInt(_text: string, _radix?: number): number { return 100; }\n";
w(BSRC, bBase);
w(TEST, "import { foo } from '../src/a';\nfoo();\n");
w('packages/api/package-lock.json', '{"lockfileVersion":3}\n');
w('data/read.json', '{"x":1}\n');
w('data/unread.json', '{"y":1}\n');
g('init', '-q'); gc('commit', '-qm', 'empty', '--allow-empty');
g('add', '-A'); gc('commit', '-qm', 'base');

const realLog = console.log;
if (!process.env.TRACEGATE_SELFTEST_VERBOSE) console.log = (...a) => { if (/^\s*[✓✗]|^\n?== tracegate self-test/.test(String(a[0]))) realLog(...a); };
const tg = await import('../src/index.mjs');
const C1 = tg.head();
const lines = base.split('\n');
const lineOf = (needle) => lines.findIndex((l) => l.includes(needle)) + 1;
const LOADED = [SRC, BSRC, TEST];
const passedResult = (files) => JSON.stringify({ testResults: files.map((f) => ({ name: path.join(repo, f), status: 'passed', startTime: 0, endTime: 10, assertionResults: [] })) });
// Every run directory lives under one parent, removed at the end: several callers below
// keep theirs, and each one left a tracegate-run-* in the OS temp dir per test run.
const RUNS = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-selftest-runs-'));
const tmpRun = () => fs.mkdtempSync(path.join(RUNS, 'run-'));
/** One recorded run of TEST (raw v1: exec as source start lines), ingested at HEAD. */
const recordAt = (exec, o = {}) => {
  const r = tmpRun();
  fs.mkdirSync(path.join(r, 'raw'));
  fs.writeFileSync(path.join(r, 'raw', 'x.json'), JSON.stringify({ v: 1, testFile: TEST, node: process.version, loaded: LOADED, exec, unmapped: [], reads: ['data/read.json'], ...(o.raw ?? {}) }));
  fs.writeFileSync(path.join(r, 'results.json'), o.status === 'failed'
    ? JSON.stringify({ testResults: [{ name: path.join(repo, TEST), status: 'failed', startTime: 0, endTime: 10, assertionResults: [] }] })
    : passedResult([TEST]));
  const res = tg.ingest({ lane: 'api', run: r, ...(o.expectHead ? { 'expect-head': o.expectHead } : {}) });
  fs.rmSync(r, { recursive: true, force: true });
  return res;
};
const execAt = (text) => { const ls = text.split('\n'); const at = (n) => ls.findIndex((l) => l.includes(n)) + 1; return { [SRC]: [at('export function foo'), at("'/hit'"), at('export function baz')], [BSRC]: [1] }; };
const decideApi = (H = tg.head(), node = process.version) => tg.decide(TEST, H, node, tg.lockHash('api'), 'api');
let fail = 0, passed = 0;
const check = (name, cond, detail = '') => { if (cond) passed++; else fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  — ${detail}`}`); };
const commit = (msg) => { g('add', '-A'); gc('commit', '-qm', msg); return tg.head(); };

// One recorded run: foo, the /hit handler, baz and b.helper executed; bar and /cold did not.
recordAt(execAt(base));

// The two binding cases below are also EXECUTED, so the evidence that behaviour
// changed is not just a fabricated footprint: foo() is 3 at base.
const ts = createRequire(import.meta.url)('typescript');
const executeFoo = (source) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-binding-'));
  try {
    for (const [name, text] of [['a', source.replaceAll("'./b'", "'./b.cjs'")], ['b', bBase]]) {
      fs.writeFileSync(path.join(dir, `${name}.cjs`), ts.transpileModule(text, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText);
    }
    return Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(require(process.argv[1]).foo()))', path.join(dir, 'a.cjs')], { encoding: 'utf8' }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
const baselineValue = executeFoo(base);
check('binding witness baseline executes to 3', baselineValue === 3, `got ${baselineValue}`);

// ── decide(): one commit per kind of change ──────────────────────────────────
const cases = [
  ['body of a function the test never ran', 'skip', () => w(SRC, base.replace('return 42;', 'return 43;'))],
  ['handler the test never hit', 'skip', () => w(SRC, base.replace('() => bar());', '() => bar() + 1);'))],
  ['constant the test never references', 'skip', () => w(SRC, base.replace('unused: true', 'unused: false'))],
  ['interface (erased by the transform)', 'skip', () => w(SRC, base.replace('id: string', 'id: number'))],
  ['import line only', 'skip', () => w(SRC, base.replace("import { helper } from './b';", "import { helper } from './b';\nimport type { Thing } from './c';"))],
  // A value import pulls a module graph into load, which can reorder
  // vi.mock(importOriginal) resolution (openwop-app #5360), or rebind a name an
  // executed function uses. Loaded membership cannot prove either neutral, so
  // every added, removed or edited value import runs. Type-only stays neutral.
  ['value import of a module the test never loaded', 'run', () => w(SRC, base.replace("import { helper } from './b';", "import { helper } from './b';\nimport { toModelToolResult } from './c.js';"))],
  ['value re-export of a module the test never loaded', 'run', () => w(SRC, base + "export { toModelToolResult } from './c';\n")],
  ['value import of a module the test already loaded', 'run', () => w(SRC, base.replace("import { helper } from './b';", "import { helper } from './b';\nimport { USED } from './b.js';"))],
  // Both stay valid programs and leave foo's text alone. The first is
  // insertion-only (its old character span is empty); the second adds a binding
  // over a global foo uses. b.ts was already loaded in the recorded run.
  ['pure insertion retargets an executed import binding', 'run', () => w(SRC, base.replace('import { helper }', 'import { wrongHelper as helper }')), 4],
  ['new import shadows a global used by an executed function', 'run', () => w(SRC, "import { parseInt } from './b';\n" + base), 103],
  ['value import of an already-loaded module removed', 'run', () => w(SRC, base.replace("import { helper } from './b';\n", ''))],
  ['value import specifier edited between two loaded modules', 'run', () => w(SRC, base.replace("from './b';", "from './a';"))],
  ['type-only declaration removed', 'skip', () => w(SRC, base.replace('export type Id = string;\n', ''))],
  ['a repo file the test never read', 'skip', () => w('data/unread.json', '{"y":2}\n')],
  ['body of a function the test ran', 'run', () => w(SRC, base.replace('TABLE.length + helper()', 'TABLE.length + helper() + 1'))],
  ['handler the test hit', 'run', () => w(SRC, base.replace('() => foo());', '() => foo() * 2);'))],
  ['constant an executed function reads', 'run', () => w(SRC, base.replace("'beta'", "'beta', 'gamma'"))],
  // Regressions: a line shared by an executed function and a callback that never
  // ran, and a new top-level call whose only text is a callback.
  ['executed function, on a line shared with a callback', 'run', () => w(SRC, base.replace('.length;\n}\n\nexport const router', '.length + 1;\n}\n\nexport const router'))],
  ['callback body only, on that shared line', 'skip', () => w(SRC, base.replace("x === 'zz'", "x === 'yy'"))],
  ['top-level statement of a loaded module', 'run', () => w(SRC, base + "router.get('/new', () => 1);\n")],
  ['function in another loaded module the test ran', 'run', () => w(BSRC, 'export function helper(): number { return 2; }\n')],
  // `new Set([...])` is a constant, not a top-level statement.
  ['Set member of a constant the test never references', 'skip', () => w(BSRC, bBase.replace("'y'", "'z'"))],
  ['Set member of a constant an executed function reads', 'run', () => w(BSRC, bBase.replace("'x'", "'w'"))],
  ['a new empty Map cache nothing names yet', 'skip', () => w(SRC, base + 'const cache = new Map<string, number>();\n')],
  // The local binding is a parameter of a function the test never runs, not an
  // import: a value import now runs on its own, which would hide this rule.
  ['a Set built by a LOCALLY bound constructor', 'run', () => w(BSRC, bBase.replace("'y'", "'z'") + 'export function shadow(Set: unknown): unknown { return Set; }\n')],
  ['a loaded source module deleted', 'run', () => fs.rmSync(path.join(repo, BSRC))],
  ['a repo file the test read', 'run', () => w('data/read.json', '{"x":2}\n')],
  ['the test file itself', 'run', () => w(TEST, "import { foo } from '../src/a';\nfoo();\nfoo();\n")],
  ['a setup file (lane global from the config)', 'run', () => w('packages/api/test/setup/seam.ts', 'export const x = 1;\n')],
  ['a test file that lives in the setup directory', 'skip', () => w('packages/api/test/setup/__tests__/seam.test.ts', "it.todo('x');\n")],
  ['the lane vitest config (default lane global)', 'run', () => w('packages/api/vitest.config.ts', 'export default {};\n')],
  ['.nvmrc (default root global)', 'run', () => w('.nvmrc', '22\n')],
  ['another lane\'s vitest config', 'skip', () => w('packages/web/vitest.config.ts', 'export default {};\n')],
  ['the lockfile (global input)', 'run', () => w('packages/api/package-lock.json', '{"lockfileVersion":3,"x":1}\n')],
];
for (const [name, want, mutate, expectedValue] of cases) {
  g('checkout', '-q', C1, '--', '.');
  g('checkout', '-q', '--detach', C1);
  mutate();
  if (expectedValue !== undefined) {
    const actual = executeFoo(fs.readFileSync(path.join(repo, SRC), 'utf8'));
    check(`executed binding witness: ${name} (${baselineValue} -> ${expectedValue})`, actual === expectedValue && actual !== baselineValue, `got ${actual}`);
  }
  commit(name);
  const d = decideApi();
  const got = d.run ? 'run' : 'skip';
  check(`${want.toUpperCase().padEnd(4)} ${name}`, got === want, `got ${got} (${d.reason})`);
}
// Unchanged tree: the footprint's own commit must be reusable.
g('checkout', '-q', '--detach', C1);
const same = decideApi(C1);
check('SKIP unchanged commit', !same.run, `got run (${same.reason})`);
// A different Node is a different runtime: never reuse across it.
check('RUN  different node version', decideApi(C1, 'v0.0.0').run);
// A footprint of another format version is never reused.
{
  const dir = path.join(ledger, 'fp', 'api', fs.readdirSync(path.join(ledger, 'fp', 'api'))[0]);
  const f = path.join(dir, fs.readdirSync(dir)[0]);
  const orig = fs.readFileSync(f);
  const fp = JSON.parse(zlib.gunzipSync(orig).toString()); fp.v = -1;
  fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(fp)));
  const d = decideApi(C1);
  check('RUN  a footprint of another format version', d.run && d.reason === 'footprint format changed', d.reason);
  fs.writeFileSync(f, orig);
}

// ── ingest: what may and may not be recorded ─────────────────────────────────
{
  g('checkout', '-q', '--detach', C1);
  const fpd = path.join(ledger, 'fp', 'api');
  const before = JSON.stringify(fs.readdirSync(fpd, { recursive: true }).sort());
  w(SRC, base.replace('return 42;', 'return 44;')); // uncommitted
  const dirty = recordAt(execAt(base));
  check('ingest refuses a dirty working tree (records nothing)', dirty.refused === 'dirty' && JSON.stringify(fs.readdirSync(fpd, { recursive: true }).sort()) === before, JSON.stringify(dirty));
  g('checkout', '-q', '--', '.');
  const moved = recordAt(execAt(base), { expectHead: '0'.repeat(40) });
  check('ingest refuses a tree that moved during the run (--expect-head)', moved.refused === 'moved' && JSON.stringify(fs.readdirSync(fpd, { recursive: true }).sort()) === before, JSON.stringify(moved));
  const ok = recordAt(execAt(base), { expectHead: C1 });
  check('ingest records at an unmoved, clean tree', ok.recorded === 1, JSON.stringify(ok));
  const red = recordAt(execAt(base), { status: 'failed' });
  check('ingest drops every footprint of a file that FAILED', red.dropped === 1 && decideApi(C1).reason === 'no footprint', JSON.stringify(red));
  recordAt(execAt(base)); // restore
}

// ── composition: a merge of two branches reuses either branch's footprint ────
g('checkout', '-q', '--detach', C1);
const aText = base.replace('TABLE.length + helper()', 'TABLE.length + helper() + 2');
w(SRC, aText); const A = commit('branch A');
recordAt(execAt(aText)); // A's head was run and recorded
g('checkout', '-q', '--detach', C1);
w(SRC, base.replace('return 42;', 'return 7;')); commit('branch B');
const B = tg.head();
g('checkout', '-q', '--detach', A);
gc('merge', '-q', '--no-edit', B);
const T = tg.head();
const dT = decideApi(T);
check('SKIP merge A+B: reuses the footprint recorded at A (B touches nothing it ran)', !dT.run && dT.from === A, `${dT.run ? 'run' : 'skip'} (${dT.reason})`);
const fpDir = path.join(ledger, 'fp', 'api'); const testHashDir = fs.readdirSync(fpDir)[0];
fs.rmSync(path.join(fpDir, testHashDir, `${A}.json.gz`));
const dT2 = decideApi(T);
check('RUN  merge A+B without A\'s footprint (the base one is invalidated by A)', dT2.run, dT2.reason);

// ── reasons ──────────────────────────────────────────────────────────────────
check('reasonKey folds the function name, keeping the file', tg.reasonKey('executed function foo@3 in src/a.ts') === 'executed code in src/a.ts');
check('reasonKey folds the constant name, keeping the file', tg.reasonKey('constant MANIFEST in src/b.ts') === 'constant in src/b.ts');
check('reasonKey leaves a reason without per-test detail alone', tg.reasonKey('lockfile changed') === 'lockfile changed');
{
  g('checkout', '-q', '--detach', T);
  const wr = tmpRun();
  tg.select({ lane: 'api', run: wr, mode: 'shadow' });
  const rl = fs.readdirSync(ledger).find((f) => f.startsWith('reasons-'));
  const row = rl ? fs.readFileSync(path.join(ledger, rl), 'utf8').trim().split('\n').pop().split('\t') : [];
  const top = (() => { try { return JSON.parse(row[6]); } catch { return []; } })();
  const want = tg.reasonKey(dT2.reason);
  check('select logs one reasons row per run, keyed on the folded reason of the file that must run', row[3] === T.slice(0, 12) && top.some(([k, n]) => k === want && n >= 1), `${row.join(' | ')} (want ${want})`);
  const sel = fs.readFileSync(path.join(wr, 'selected.txt'), 'utf8');
  check('shadow selects every file, reusable or not', sel.includes(TEST));
  fs.rmSync(wr, { recursive: true, force: true });
}

// ── enforce, audits, misses, triage ──────────────────────────────────────────
g('checkout', '-q', '--detach', C1);
{
  const r0 = tmpRun();
  tg.select({ lane: 'api', run: r0, mode: 'enforce', audit: '0' });
  const p0 = JSON.parse(fs.readFileSync(path.join(r0, 'predict.json'), 'utf8'));
  check('enforce + audit 0: the reusable file is NOT selected', !p0.decisions[TEST].run && !p0.decisions[TEST].audit && fs.readFileSync(path.join(r0, 'selected.txt'), 'utf8') === '', JSON.stringify(p0.decisions[TEST]));
  // Uniform random audit: at 0.5 over 100 independent selections, about half.
  let audited = 0;
  for (let i = 0; i < 100; i++) { const s = tg.select({ lane: 'api', run: r0, mode: 'enforce', audit: '0.5' }); audited += s.audit; }
  check('enforce + audit 0.5: about half of 100 selections audit the file (25..75)', audited >= 25 && audited <= 75, `audited ${audited}/100`);
  fs.rmSync(r0, { recursive: true, force: true });
}
// ── uncommitted changes: the tests run on the working tree, so predict against it ──
{
  const sel = (label) => { const r = tmpRun(); tg.select({ lane: 'api', run: r, mode: 'enforce', audit: '0' }); const d = JSON.parse(fs.readFileSync(path.join(r, 'predict.json'), 'utf8')).decisions[TEST]; fs.rmSync(r, { recursive: true, force: true }); return d; };
  const orig = fs.readFileSync(path.join(repo, SRC), 'utf8');
  w(SRC, base.replace('TABLE.length + helper()', 'TABLE.length + helper() + 1'));
  const ran = sel();
  check('an UNCOMMITTED edit to a function the test ran makes it run in enforce', ran.run === true && /executed function/.test(ran.reason), JSON.stringify(ran));
  w(SRC, base.replace('return 42;', 'return 43;'));
  const idle = sel();
  check('...an uncommitted edit to a function it never ran still reuses its verdict', idle.run === false, JSON.stringify(idle));
  check('...and the snapshot leaves no stash entry and no ref', g('stash', 'list').trim() === '' && g('status', '--porcelain', '--untracked-files=no').trim() !== '');
  w(SRC, orig);
  check('...a clean tree predicts against HEAD itself', tg.treeUnderTest().at === tg.head() && sel().reason === 'green at this commit', JSON.stringify(tg.treeUnderTest()));
}
const er = tmpRun();
tg.select({ lane: 'api', run: er, mode: 'enforce', audit: '1' });
const pred = JSON.parse(fs.readFileSync(path.join(er, 'predict.json'), 'utf8'));
check('enforce + audit 1.0: the reusable file is selected as an AUDIT', pred.decisions[TEST]?.audit === true && fs.readFileSync(path.join(er, 'selected.txt'), 'utf8').includes(TEST), JSON.stringify(pred.decisions[TEST]));
fs.writeFileSync(path.join(er, 'results.json'), JSON.stringify({ testResults: [{ name: path.join(repo, TEST), status: 'failed', startTime: 0, endTime: 5, assertionResults: [] }] }));
tg.report({ lane: 'api', run: er });
const missLog = fs.readdirSync(ledger).find((f) => f.startsWith('misses-'));
check('the failed audit is logged as a MISS', !!missLog && fs.readFileSync(path.join(ledger, missLog), 'utf8').includes(TEST));
check('...and listed in the run\'s misses.txt, which the runner re-runs alone', (() => { try { return fs.readFileSync(path.join(er, 'misses.txt'), 'utf8').includes(TEST); } catch { return false; } })());
check('...and the footprint that lied is dropped', decideApi(C1).reason === 'no footprint');
check('...and the lane is barred from enforcement', tg.entryBar('api').recentMiss === true && tg.effectiveMode('api') === 'shadow');
check('...and the observation is logged in shadow-<host>.tsv', fs.readFileSync(path.join(ledger, 'shadow-selftest.tsv'), 'utf8').trim().split('\n').pop().split('\t')[9] === '1');
// A `hole` keeps the suspension; a `flake` lifts it. The runner triages with
// --head <first 12 of HEAD>; that key must match the ledger's.
tg.triage({ lane: 'api', file: TEST, verdict: 'hole', head: C1.slice(0, 12) });
check('a miss triaged as a HOLE still suspends enforcement', tg.entryBar('api').recentMiss === true);
tg.triage({ lane: 'api', file: TEST, verdict: 'flake', head: C1.slice(0, 12) });
check('a miss triaged as a FLAKE no longer counts against the entry bar', tg.entryBar('api').recentMiss === false);
check('triage of a file with no logged miss records nothing', tg.triage({ lane: 'api', file: 'nope.test.ts', verdict: 'flake' }) === 0);
process.exitCode = 0;
// A file the prediction said to RUN that fails is not a miss, but its footprints
// must go too (they may be valid again on a later tree that reverts the change).
{
  recordAt(execAt(base));
  w(SRC, base.replace('TABLE.length + helper()', 'TABLE.length + helper() + 3')); const F = commit('an edit the test ran');
  const fr = tmpRun();
  tg.select({ lane: 'api', run: fr, mode: 'shadow' });
  fs.writeFileSync(path.join(fr, 'results.json'), JSON.stringify({ testResults: [{ name: path.join(repo, TEST), status: 'failed', startTime: 0, endTime: 5, assertionResults: [] }] }));
  const rep = tg.report({ lane: 'api', run: fr });
  g('checkout', '-q', '--detach', C1);
  check('report drops the footprints of a failed file that was predicted to run (not a miss)', rep.misses.length === 0 && decideApi(C1).reason === 'no footprint', `${F.slice(0, 9)} ${JSON.stringify(rep)} ${decideApi(C1).reason}`);
  fs.rmSync(fr, { recursive: true, force: true });
}
// Footprints older than maxAgeHours are never reused (the clock is not an observed input).
recordAt(execAt(base));
{
  const dir = path.join(ledger, 'fp', 'api', fs.readdirSync(path.join(ledger, 'fp', 'api'))[0]);
  const fpFile = path.join(dir, fs.readdirSync(dir)[0]);
  const old = JSON.parse(zlib.gunzipSync(fs.readFileSync(fpFile)).toString());
  old.recordedAt = new Date(Date.now() - (tg.ctx().maxAgeHours + 1) * 3_600_000).toISOString();
  fs.writeFileSync(fpFile, zlib.gzipSync(JSON.stringify(old)));
  const aged = decideApi(C1);
  check(`RUN  a footprint older than ${tg.ctx().maxAgeHours} h, even on an unchanged tree`, aged.run && /older than/.test(aged.reason), aged.reason);
}

// The ingest budget: past it, nothing more is recorded (never a partial footprint).
{
  g('checkout', '-q', '--detach', C1);
  const r = tmpRun();
  fs.mkdirSync(path.join(r, 'raw'));
  fs.writeFileSync(path.join(r, 'raw', 'x.json'), JSON.stringify({ v: 1, testFile: TEST, node: process.version, loaded: [SRC], exec: { [SRC]: [1] }, unmapped: [], reads: [] }));
  fs.writeFileSync(path.join(r, 'results.json'), passedResult([TEST]));
  const fpd = path.join(ledger, 'fp', 'api'); fs.rmSync(fpd, { recursive: true, force: true });
  tg.ingest({ lane: 'api', run: r, 'budget-s': '-1' });
  check('ingest past its time budget records nothing (no partial footprint)', !fs.existsSync(fpd) || fs.readdirSync(fpd).length === 0);
  fs.rmSync(r, { recursive: true, force: true });
}

// ── modes and the entry bar ──────────────────────────────────────────────────
fs.rmSync(path.join(ledger, missLog));
const shadow = 'shadow-selftest.tsv';
const HDR = 'at\tlane\tmode\thead\tfiles\tmust_run\treusable\taudited\trun_time_pct\tmisses\n';
const obsRows = (laneName, n, startDaysAgo, stepDays) => Array.from({ length: n }, (_, i) => [new Date(Date.now() - (startDaysAgo - i * stepDays) * 86_400_000).toISOString(), laneName, 'shadow', 'x', 10, 1, 9, 0, '10.0', 0].join('\t'));
const writeObs = (rows) => fs.writeFileSync(path.join(ledger, shadow), HDR + rows.join('\n') + '\n');
// A recent complete full run, so these entry-bar cases see the bar, not the backstop.
const fullLog = path.join(ledger, 'full-selftest.tsv');
const fullRow = (laneName, hoursAgo) => [new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), laneName, 'x'].join('\t');
fs.writeFileSync(fullLog, 'at\tlane\thead\n' + ['api', 'web', 'plain'].map((l) => fullRow(l, 1)).join('\n') + '\n');
writeObs(obsRows('api', 20, 15, 0.7));
check('entry bar MET after 20 clean observations over 15 days → auto = enforce', tg.entryBar('api').ok && tg.effectiveMode('api') === 'enforce', JSON.stringify(tg.entryBar('api')));
check('...and a lane past the default 14-day bar audits at the normal 5%', tg.entryBar('api').auditRate === 0.05, JSON.stringify(tg.entryBar('api')));
// The same record with an un-triaged miss from an hour ago: suspended, whatever the bar.
{
  const ml = path.join(ledger, 'misses-selftest.tsv');
  fs.writeFileSync(ml, 'at\tlane\thead\tfile\treason\n' + [new Date(Date.now() - 3_600_000).toISOString(), 'api', 'deadbeef0000', TEST, 'x'].join('\t') + '\n');
  check('...but a recent un-triaged MISS suspends a lane that otherwise meets the bar', !tg.entryBar('api').ok && tg.effectiveMode('api') === 'shadow', JSON.stringify(tg.entryBar('api')));
  fs.writeFileSync(ml, 'at\tlane\thead\tfile\treason\n' + [new Date(Date.now() - 15 * 86_400_000).toISOString(), 'api', 'deadbeef0000', TEST, 'x'].join('\t') + '\n');
  check('...and a miss older than the suspension window no longer does', tg.entryBar('api').ok && tg.effectiveMode('api') === 'enforce', JSON.stringify(tg.entryBar('api')));
  fs.rmSync(ml);
}
writeObs(obsRows('api', 20, 15, 0.7).slice(-10));
check('entry bar NOT met with 10 observations → auto = shadow', !tg.entryBar('api').ok && tg.effectiveMode('api') === 'shadow');
// Early entry (a per-lane bar): 20 clean observations over 2 days.
const early = (laneName) => obsRows(laneName, 20, 2, 0.09);
writeObs([...early('api'), ...early('web'), ...early('plain')]);
check('api enters EARLY: 20 clean observations over 2 days → enforce', tg.entryBar('api').ok && tg.effectiveMode('api') === 'enforce', JSON.stringify(tg.entryBar('api')));
check('...auditing 20% until the default 14-day bar would have been met', tg.entryBar('api').auditRate === 0.2);
check('web enters EARLY on the same record, auditing 20%', tg.entryBar('web').ok && tg.effectiveMode('web') === 'enforce' && tg.entryBar('web').auditRate === 0.2, JSON.stringify(tg.entryBar('web')));
check('a lane on the DEFAULT bar does not enter on the same 2-day record', !tg.entryBar('plain').ok && tg.effectiveMode('plain') === 'shadow', JSON.stringify(tg.entryBar('plain')));
// ...but not before the 1-day floor: 20 clean observations inside 12 hours.
writeObs([...early('api'), ...obsRows('web', 20, 0.5, 0.02)]);
check('web does NOT enter on 20 observations inside 12 hours (the 1-day floor)', !tg.entryBar('web').ok && tg.effectiveMode('web') === 'shadow', JSON.stringify(tg.entryBar('web')));
// Full-run backstop: an enforce-eligible lane runs FULL when its last complete
// full run is ≥ 24 h old, or was never recorded — and enforces again once one is.
fs.writeFileSync(fullLog, 'at\tlane\thead\n' + fullRow('api', 31) + '\n');
const dOld = tg.modeDecision('api');
check('backstop: last full run 31h ago → this run executes FULL (shadow), and says why', dOld.mode === 'shadow' && dOld.full && /31h ago/.test(dOld.why), JSON.stringify(dOld));
fs.writeFileSync(fullLog, 'at\tlane\thead\n');
check('backstop: no full run ever recorded → FULL', tg.modeDecision('api').full === true && /never recorded/.test(tg.modeDecision('api').why));
tg.fullDone({ lane: 'api' });
check('backstop: full-done records one → enforce again', tg.effectiveMode('api') === 'enforce', JSON.stringify(tg.modeDecision('api')));
process.env.TRACEGATE = 'enforce'; fs.writeFileSync(fullLog, 'at\tlane\thead\n');
check('an explicit TRACEGATE=enforce wins over the backstop', tg.effectiveMode('api') === 'enforce');
process.env.TRACEGATE = 'off';
check('TRACEGATE=off → off', tg.effectiveMode('api') === 'off');
process.env.TRACEGATE_API = 'shadow';
check('a per-lane TRACEGATE_<LANE> wins over TRACEGATE', tg.effectiveMode('api') === 'shadow' && tg.effectiveMode('web') === 'off');
delete process.env.TRACEGATE; delete process.env.TRACEGATE_API;
fs.rmSync(fullLog);

// ── replay: a past run re-decided offline, with causes removed ───────────────
{
  g('checkout', '-q', '--detach', C1);
  recordAt({ [SRC]: [lineOf('export function foo')], [BSRC]: [1] });
  w('packages/api/package-lock.json', '{"lockfileVersion":3,"replay":1}\n');
  w(SRC, base.replace('TABLE.length + helper()', 'TABLE.length + helper() + 7'));
  const RH = commit('replay: a lockfile bump and an edit the test ran');
  const now = new Date().toISOString();
  const live = decideApi(RH);
  const r0 = tg.replay({ lane: 'api', head: RH, at: now });
  check('replay reproduces decide() at the same head and clock', live.reason === 'lockfile changed' && r0.mustRun === 1 && r0.top[0]?.[0] === 'lockfile changed', JSON.stringify({ live, r0: r0.top }));
  const r1 = tg.replay({ lane: 'api', head: RH, at: now, 'ignore-lock': true, drop: 'package-lock\\.json$' });
  check('replay without the lockfile still RUNS for the edit the test ran', r1.mustRun === 1 && (r1.top[0]?.[0] ?? '') === `executed code in ${SRC}`, JSON.stringify(r1.top));
  const r2 = tg.replay({ lane: 'api', head: RH, at: now, 'ignore-lock': true, drop: '(package-lock\\.json|src/a\\.ts)$' });
  check('replay with both causes removed SKIPS', r2.mustRun === 0, JSON.stringify(r2.top));
  const r3 = tg.replay({ lane: 'api', head: RH, at: '2000-01-01T00:00:00Z' });
  check('replay before any footprint existed sees none, and counts it as replaced', r3.mustRun === 1 && r3.top[0]?.[0] === 'no footprint' && r3.evicted === 1, JSON.stringify(r3));
  const after = decideApi(RH);
  check('replay leaves the live decision untouched', after.run === live.run && after.reason === live.reason, JSON.stringify({ live, after }));
}

// ── keyed inputs: a data file read by key re-runs only on a key it read ─────
{
  const CAT = 'data/i18n.json';
  // decide() reuses a verdict when ANY stored footprint allows it, so each case starts
  // from this test's one new footprint, not from the ones recorded before it.
  const only = (raw) => { fs.rmSync(path.join(ledger, 'fp', 'api'), { recursive: true, force: true }); recordAt(execAt(fs.readFileSync(path.join(repo, SRC), 'utf8')), { raw }); };
  const cat = (o) => w(CAT, JSON.stringify({ 'greet.hello': 'Hello', 'greet.bye': 'Bye', nested: { a: 1, b: 2 }, ...o }, null, 1) + '\n');
  cat({}); commit('a keyed catalog');
  only({ reads: ['data/read.json', CAT], keyReads: { [CAT]: ['greet.hello', 'nested.a'] } });
  cat({ 'greet.bye': 'Goodbye', nested: { a: 1, b: 3 } }); commit('keys the test did not read');
  const d1 = decideApi();
  check('keyed: a change only to keys the test never read reuses its verdict', d1.run === false, JSON.stringify(d1));
  cat({ 'greet.hello': 'Hi', 'greet.bye': 'Goodbye' }); commit('a key the test read');
  const d2 = decideApi();
  check('keyed: a change to a key it read (a dotted name, held whole) runs it, and names the key', d2.run === true && /read key greet\.hello in data\/i18n\.json/.test(d2.reason), JSON.stringify(d2));
  cat({}); commit('back');
  only({ reads: ['data/read.json', CAT], keyReads: { [CAT]: ['nested.a'] } });
  cat({ nested: { a: 9, b: 2 } }); commit('a nested key the test read');
  check('keyed: a dotted path reaches into nested objects', /read key nested\.a/.test(decideApi().reason ?? ''), JSON.stringify(decideApi()));
  cat({}); commit('back again');
  only({ reads: ['data/read.json', CAT] });
  cat({ 'greet.bye': 'Later' }); commit('no keys recorded');
  check('keyed: with no keys recorded, the whole-file rule stands', /^read input data\/i18n\.json/.test(decideApi().reason ?? ''), JSON.stringify(decideApi()));
  // A test that imports the JSON itself read all of it, whatever keys a plugin saw.
  const testBefore = fs.readFileSync(path.join(repo, TEST), 'utf8');
  w(TEST, `import cat from '../../../${CAT}';\n` + testBefore); cat({}); commit('the test imports the catalog');
  only({ keyReads: { [CAT]: ['greet.hello'] } });
  cat({ 'greet.bye': 'Bye now' }); commit('an unread key, in an imported catalog');
  check('keyed: an IMPORTED json keeps the whole-file rule', /^read input data\/i18n\.json/.test(decideApi().reason ?? ''), JSON.stringify(decideApi()));
  w(TEST, testBefore); commit('the test no longer imports it');
}

// ── keyed inputs in a table written as code, through the lane's extractor ───
{
  const TBL = 'packages/api/src/i18n.ts';
  const tbl = (o) => w(TBL, 'export const messages = {\n' + Object.entries({ hello: 'Hello', bye: 'Bye', ...o }).map(([k, v]) => `  ${k}: '${v}',`).join('\n') + '\n};\n');
  const ex = path.join(os.tmpdir(), `tg-extract-${process.pid}.mjs`);
  fs.writeFileSync(ex, "let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => { if (s.includes('BROKEN')) process.exit(1); const o = {}; for (const m of s.matchAll(/(\\w+): '([^']*)'/g)) o[m[1]] = m[2]; console.log(JSON.stringify(o)); });\n");
  const cfgPath = path.join(os.tmpdir(), `tg-keyed-config-${process.pid}.json`);
  const c = JSON.parse(fs.readFileSync(path.join(repo, 'tracegate.config.json'), 'utf8')); c.lanes.api.keyedExtract = `node ${ex}`;
  fs.writeFileSync(cfgPath, JSON.stringify(c));
  const useExtractor = (on) => { if (on) process.env.TRACEGATE_CONFIG = cfgPath; else delete process.env.TRACEGATE_CONFIG; tg.resetContext(); };
  const only = (raw) => { fs.rmSync(path.join(ledger, 'fp', 'api'), { recursive: true, force: true }); recordAt(execAt(fs.readFileSync(path.join(repo, SRC), 'utf8')), { raw }); };
  tbl({}); commit('a table written as code');
  useExtractor(true);
  // The table is ALSO a loaded module here: the keyed rule must come first.
  only({ loaded: [...LOADED, TBL], keyReads: { [TBL]: ['hello'] } });
  tbl({ bye: 'Goodbye' }); commit('an unread key in a code table');
  check('keyed (code table): an unread key reuses the verdict, even though the table is a loaded module', decideApi().run === false, JSON.stringify(decideApi()));
  tbl({ hello: 'Hi', bye: 'Goodbye' }); commit('a read key in a code table');
  check('keyed (code table): a key it read runs it, through the lane\'s extractor', /read key hello in packages\/api\/src\/i18n\.ts/.test(decideApi().reason ?? ''), JSON.stringify(decideApi()));
  tbl({}); commit('table back');
  w(TBL, fs.readFileSync(path.join(repo, TBL), 'utf8') + "globalThis.registered = true;\n"); commit('code, not data, in the table module');
  check('keyed (code table): an edit to its CODE falls back to the module rule', /top-level change in packages\/api\/src\/i18n\.ts/.test(decideApi().reason ?? ''), JSON.stringify(decideApi()));
  tbl({}); commit('table back, without the code');
  only({ keyReads: { [TBL]: ['*'] } });
  tbl({ bye: 'Later' }); commit('any edit, for a whole-table read');
  check('keyed: the key * is a whole-table read: any edit runs it', /read key \* in/.test(decideApi().reason ?? ''), JSON.stringify(decideApi()));
  tbl({}); commit('table back again');
  only({ keyReads: { [TBL]: ['hello'] } });
  tbl({ bye: 'BROKEN' }); commit('a table the extractor cannot read');
  check('keyed: an extractor that fails counts as a change', /read key \* in/.test(decideApi().reason ?? ''), JSON.stringify(decideApi()));
  tbl({}); commit('table back once more');
  useExtractor(false);
  only({ keyReads: { [TBL]: ['hello'] } });
  tbl({ bye: 'See you' }); commit('no extractor configured');
  check('keyed: with no extractor, a reported code table is a whole-file read input', /^read input packages\/api\/src\/i18n\.ts/.test(decideApi().reason ?? ''), JSON.stringify(decideApi()));
  fs.rmSync(ex, { force: true }); fs.rmSync(cfgPath, { force: true });
}

// ── the recorder writes the keys a plugin reported into the raw footprint ───
{
  const { recordKeyRead, takeFootprint } = await import('../src/recorder.mjs');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-keys-'));
  fs.mkdirSync(path.join(out, 'raw'));
  const saved = globalThis.__tracegate;
  const st = { session: { post: async () => ({ result: [] }) }, repoRoot: repo, srcPrefix: 'packages/api/src/', modules: new Map(), reads: new Set(), keyReads: new Map(), pkgReads: new Set(), pkgsKnown: true, outDir: out, write: fs.writeFileSync };
  globalThis.__tracegate = st;
  try {
    recordKeyRead(path.join(repo, 'data/i18n.json'), 'greet.hello');
    recordKeyRead('./data/i18n.json', 'nested.a');
    recordKeyRead('data/i18n.json', 'greet.hello');
    recordKeyRead('/elsewhere/x.json', 'k');
    recordKeyRead('../outside.json', 'k');
    await takeFootprint(st, path.join(repo, TEST));
  } finally { globalThis.__tracegate = saved; }
  const raw = JSON.parse(fs.readFileSync(path.join(out, 'raw', fs.readdirSync(path.join(out, 'raw'))[0]), 'utf8'));
  check('recordKeyRead: keys land in the raw footprint per repo path, deduplicated; paths outside the repo are dropped', JSON.stringify(raw.keyReads) === JSON.stringify({ 'data/i18n.json': ['greet.hello', 'nested.a'] }), JSON.stringify(raw.keyReads));
  fs.rmSync(out, { recursive: true, force: true });
}

// ── the pre-select hook adds files, never removes; a failure runs the lane ──
{
  recordAt(execAt(fs.readFileSync(path.join(repo, SRC), 'utf8')));
  // The hook's config lives OUTSIDE the repo (TRACEGATE_CONFIG): editing the repo's own
  // tracegate.config.json is a global input change, and would run every file anyway.
  const cfg0 = fs.readFileSync(path.join(repo, 'tracegate.config.json'), 'utf8');
  const cfgPath = path.join(os.tmpdir(), `tg-hook-config-${process.pid}.json`);
  const withHook = (cmd) => { const c = JSON.parse(cfg0); c.lanes.api.preSelect = cmd; fs.writeFileSync(cfgPath, JSON.stringify(c)); process.env.TRACEGATE_CONFIG = cfgPath; tg.resetContext(); };
  const sel = () => { const r = tmpRun(); const o = tg.select({ lane: 'api', run: r, mode: 'enforce', audit: '0' }); const p = JSON.parse(fs.readFileSync(path.join(r, 'predict.json'), 'utf8')); fs.rmSync(r, { recursive: true, force: true }); return { ...o, p }; };
  const base0 = sel();
  check('hook: without one, the recorded test is reused', !base0.selected.includes(TEST), JSON.stringify(base0.selected));
  const seen = path.join(os.tmpdir(), `tg-hook-${process.pid}.json`);
  withHook(`node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(seen)},s);console.log(${JSON.stringify(TEST)})})'`);
  const h1 = sel(); const input = JSON.parse(fs.readFileSync(seen, 'utf8'));
  check('hook: a file it names runs, marked as the hook\'s', h1.selected.includes(TEST) && h1.p.decisions[TEST].reason === 'pre-select hook' && input.reused.includes(TEST) && input.lane === 'api', JSON.stringify({ sel: h1.selected, d: h1.p.decisions[TEST] }));
  withHook('true');
  const h2 = sel();
  check('hook: naming nothing removes nothing', h2.selected.join() === base0.selected.join());
  withHook('exit 3');
  const h3 = sel();
  check('hook: a hook that fails runs the whole lane', h3.selected.length === h3.files && /pre-select hook failed: exit 3/.test(h3.p.decisions[TEST].reason), JSON.stringify(h3.p.decisions[TEST]));
  withHook('echo packages/api/src/a.ts');
  const h4 = sel();
  check('hook: naming a file that is not a test of the lane is a failure, not a selection', h4.selected.length === h4.files && /not test files of the lane/.test(h4.p.decisions[TEST].reason), JSON.stringify(h4.p.decisions[TEST]));
  delete process.env.TRACEGATE_CONFIG; tg.resetContext(); fs.rmSync(cfgPath, { force: true }); fs.rmSync(seen, { force: true });
}

// ── sync: two ledgers become their union; each keeps its own log name ────────
{
  const peer = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-other-'));
  fs.mkdirSync(path.join(peer, 'blobs')); fs.writeFileSync(path.join(peer, 'blobs', 'feedface.json.gz'), 'x');
  fs.writeFileSync(path.join(peer, 'shadow-othermac.tsv'), 'at\tlane\n');
  tg.sync({ remote: peer });
  check('sync pulls the other machine\'s blobs and log', fs.existsSync(path.join(ledger, 'blobs', 'feedface.json.gz')) && fs.existsSync(path.join(ledger, 'shadow-othermac.tsv')));
  check('sync pushes ours to it', fs.readdirSync(path.join(peer, 'blobs')).length > 1 && fs.existsSync(path.join(peer, 'shadow-selftest.tsv')));
  // The evidence added after sync was first written travels too: an escalation on the
  // other machine must suspend the lane here, and a person's approved skip must hold here.
  fs.writeFileSync(path.join(peer, 'escalations-othermac.tsv'), 'at\tlane\tfile\thead\tverdict\n');
  fs.writeFileSync(path.join(peer, 'silence-allow-othermac.tsv'), 'at\tlane\n');
  fs.writeFileSync(path.join(peer, 'red-opinions-othermac.jsonl'), '{}\n');
  fs.mkdirSync(path.join(peer, 'red'), { recursive: true }); fs.writeFileSync(path.join(peer, 'red', 'api-0123456789ab-x.json'), '{}');
  fs.writeFileSync(path.join(peer, 'trainq-othermac.tsv'), 'at\tpr\n');
  fs.writeFileSync(path.join(ledger, 'escalations-selftest.tsv'), 'at\tlane\tfile\thead\tverdict\n');
  tg.sync({ remote: peer });
  check('sync carries escalations, approved skips, opinions and red packets both ways',
    ['escalations-othermac.tsv', 'silence-allow-othermac.tsv', 'red-opinions-othermac.jsonl', 'red/api-0123456789ab-x.json'].every((f) => fs.existsSync(path.join(ledger, f)))
    && fs.existsSync(path.join(peer, 'escalations-selftest.tsv')));
  check('sync leaves the other machine\'s train queue there: it is not ours to run', !fs.existsSync(path.join(ledger, 'trainq-othermac.tsv')));
  fs.rmSync(peer, { recursive: true, force: true });
}

// ── every log the code writes is either shared or deliberately local ────────
{
  const { SHARED_LOGS, LOCAL_LOGS } = await import('../src/sync.mjs');
  const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const src = fs.readdirSync(path.join(PKG, 'src')).filter((f) => f.endsWith('.mjs')).map((f) => fs.readFileSync(path.join(PKG, 'src', f), 'utf8')).join('\n');
  const written = new Set([...src.matchAll(/appendTsv\('([a-z-]+-)'/g), ...src.matchAll(/`([a-z-]+-)\$\{ctx\(\)\.host\}\.jsonl`/g)].map((m) => m[1]));
  const known = new Set([...SHARED_LOGS, ...LOCAL_LOGS]);
  const missing = [...written].filter((p) => !known.has(p));
  const both = SHARED_LOGS.filter((p) => LOCAL_LOGS.includes(p));
  check('sync: every log the code writes is in SHARED_LOGS or LOCAL_LOGS, and none is in both', written.size >= 15 && !missing.length && !both.length, JSON.stringify({ missing, both, written: written.size }));
}

fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(er, { recursive: true, force: true });
fs.rmSync(ledger, { recursive: true, force: true });
fs.rmSync(RUNS, { recursive: true, force: true });
realLog(fail ? `\n== tracegate self-test: ${fail} FAILED, ${passed} passed ==` : `\n== tracegate self-test: ${passed} passed ==`);
process.exit(fail ? 1 : 0);
