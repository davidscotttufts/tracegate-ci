#!/usr/bin/env node
// Conductor tests (Phase 2; src/conductor.mjs and src/vitest-sequencer.mjs).
// Ordering is pure over predict.json's decisions; train advice reads footprints
// ingested from synthetic raw files into a throwaway repo, with one branch per PR.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-conductor-test-')));
const repo = path.join(tmp, 'repo'); const ledger = path.join(tmp, 'ledger');
fs.mkdirSync(repo);
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const commit = (m) => { g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', m); return g('rev-parse', 'HEAD').trim(); };
g('init', '-q', '-b', 'main');
process.env.TRACEGATE_ROOT = repo; process.env.TRACEGATE_LEDGER = ledger; process.env.TRACEGATE_HOST = 'condtest';
delete process.env.TRACEGATE_CONDUCTOR;

const c = await import('../src/conductor.mjs');

// ── ordering ────────────────────────────────────────────────────────────────
const decisions = {
  'test/global.test.ts': { run: true, reason: 'global input tsconfig.json', durationMs: 50 },
  'test/own.test.ts': { run: true, reason: 'the test file changed', durationMs: 9000 },
  'test/exec.test.ts': { run: true, reason: 'executed function foo in src/a.ts', durationMs: 300 },
  'test/exec-fast.test.ts': { run: true, reason: 'executed function bar in src/a.ts', durationMs: 20 },
  'test/audit.test.ts': { run: false, audit: true, reason: 'green at abc, nothing it depends on changed', durationMs: 10 },
  'test/flaky.test.ts': { run: true, reason: 'global input tsconfig.json', durationMs: 50 },
};
const selected = Object.keys(decisions);
const order = c.rank(decisions, selected, new Map([['test/flaky.test.ts', 2]]));
check('order: a file that failed recently comes first', order[0] === 'test/flaky.test.ts', JSON.stringify(order));
check('order: then its own test file changed, then code it executed, then lane-wide reasons', order.indexOf('test/own.test.ts') < order.indexOf('test/exec.test.ts') && order.indexOf('test/exec.test.ts') < order.indexOf('test/global.test.ts'), JSON.stringify(order));
check('order: among equals, the shorter file first', order.indexOf('test/exec-fast.test.ts') < order.indexOf('test/exec.test.ts'));
check('order: an audit (predicted reusable) goes last', order[order.length - 1] === 'test/audit.test.ts');
check('order: it never adds or drops a file', order.length === selected.length && new Set(order).size === selected.length && selected.every((f) => order.includes(f)));
const fr = c.firstFailRank(['a', 'b', 'c', 'd', 'e'], new Set(['b', 'e']));
check('score: first failing rank, and what a random order would average', fr.rank === 2 && fr.randomExpected === 2 && fr.failed === 2);
check('score: a green run is not scored', c.firstFailRank(['a'], new Set()) === null);

// ── the sequencer ───────────────────────────────────────────────────────────
const { default: Seq } = await import('../src/vitest-sequencer.mjs');
const of = path.join(tmp, 'order.txt'); fs.writeFileSync(of, '/r/c.ts\n/r/a.ts\n');
process.env.TRACEGATE_ORDER = of;
const sorted = await new Seq({}).sort([{ moduleId: '/r/a.ts' }, { moduleId: '/r/b.ts' }, { moduleId: '/r/c.ts' }]);
check('sequencer: sorts by the order file; files it does not list keep their place after', sorted.map((x) => x.moduleId).join() === '/r/c.ts,/r/a.ts,/r/b.ts', JSON.stringify(sorted));
const tuples = await new Seq({}).sort([[{}, '/r/b.ts'], [{}, '/r/a.ts']]);
check('sequencer: also the older [project, file] specs', tuples.map((x) => x[1]).join() === '/r/a.ts,/r/b.ts');
delete process.env.TRACEGATE_ORDER;
const same = await new Seq({}).sort([{ moduleId: '/r/b.ts' }, { moduleId: '/r/a.ts' }]);
check('sequencer: without an order file, nothing moves', same.map((x) => x.moduleId).join() === '/r/b.ts,/r/a.ts');

// ── train advice ────────────────────────────────────────────────────────────
for (const n of ['a', 'b', 'c', 'd']) w(`src/${n}.ts`, `export const ${n} = 1;\n`);
for (let i = 0; i < 8; i++) w(`test/t${i}.test.ts`, "it('t', () => {});\n");
w('package.json', '{"name":"x"}\n');
commit('base');
const tg = await import('../src/predictor.mjs');
{
  const run = fs.mkdtempSync(path.join(tmp, 'run-'));
  fs.mkdirSync(path.join(run, 'raw'));
  // t0..t5 load src/a.ts (the wide one); t6 loads b; t7 loads c; d is loaded by no test.
  const loads = (i) => (i < 6 ? ['src/a.ts'] : i === 6 ? ['src/b.ts'] : ['src/c.ts']);
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(run, 'raw', `t${i}.json`), JSON.stringify({ v: 1, testFile: `test/t${i}.test.ts`, node: process.version, loaded: [`test/t${i}.test.ts`, ...loads(i)], exec: {}, unmapped: [], reads: [] }));
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify({ testResults: [...Array(8).keys()].map((i) => ({ name: path.join(repo, `test/t${i}.test.ts`), status: 'passed', assertionResults: [] })) }));
  const q = console.log; console.log = () => {}; try { tg.ingest({ lane: 'default', run }); } finally { console.log = q; }
}
const branch = (name, file, text) => { g('checkout', '-q', '-b', name, 'main'); w(file, text); commit(name); g('checkout', '-q', 'main'); };
branch('pr-wide', 'src/a.ts', 'export const a = 2;\n');
branch('pr-b', 'src/b.ts', 'export const b = 2;\n');
branch('pr-c', 'src/c.ts', 'export const c = 2;\n');
branch('pr-global', 'package.json', '{"name":"y"}\n');
const adv = c.trainAdvice({ lane: 'default', base: 'main', pr: ['1=pr-wide', '2=pr-b', '3=pr-c', '4=pr-global'] });
check('advice: a PR that touches a global input goes alone', adv.alone.includes('4') && adv.reach['4'] === 'global', JSON.stringify(adv));
check('advice: a PR that reaches far more of the lane than the others goes alone', adv.alone.includes('1') && adv.reach['1'] === 6, JSON.stringify(adv.reach));
check('advice: narrow PRs are batched together', adv.together.join() === '2,3', JSON.stringify(adv.together));
check('advice: disjoint reach is predicted independent; a global PR never is', adv.independent.some(([x, y]) => x === '2' && y === '3') && !adv.independent.some((p) => p.includes('4')) && adv.independent.some(([x, y]) => x === '1' && y === '2'), JSON.stringify(adv.independent));
check('advice: it is logged with an id', (await import('../src/ledger.mjs')).readTsv('train-advice-').some((r) => r.id === adv.id));
c.trainOutcome({ id: adv.id, red: '1' });
let sc = c.trainScore();
check('train score: a red PR the advice had sent alone counts as a saved bisection', sc.trains === 1 && sc.red === 1 && sc.flaggedRed === 1, JSON.stringify(sc));
const adv2 = c.trainAdvice({ lane: 'default', base: 'main', pr: ['2=pr-b', '3=pr-c'] });
c.trainOutcome({ id: adv2.id, red: '2,3', combination: true });
sc = c.trainScore();
check('train score: a pair called independent that was red only together is a false independence', sc.falseIndependent === 1 && sc.independentPairs >= 2 && sc.falseIndependenceRate > 0, JSON.stringify(sc));
check('train outcome: an unknown advice id is refused', (() => { try { c.trainOutcome({ id: 'nope' }); return false; } catch { return true; } })());

// ── a red run's order is scored in the ledger ───────────────────────────────
c.scoreOrder({ lane: 'default', head: g('rev-parse', 'HEAD').trim(), order: ['x', 'y', 'z'], failed: new Set(['x']), mode: 'shadow' });
const sum = c.orderSummary();
check('order summary: mean rank against random', sum.runs === 1 && sum.meanRank === 1 && sum.meanRandom === 2 && sum.better === 1, JSON.stringify(sum));
check('the predictor does not read the Conductor (it only orders and advises)', !fs.readFileSync(new URL('../src/predictor.mjs', import.meta.url), 'utf8').includes('conductor'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== conductor tests: ${fail} FAILED, ${pass} passed ==` : `\n== conductor tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
