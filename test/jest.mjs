#!/usr/bin/env node
// Jest-adapter tests that need no Jest: the recorder as the Jest environment
// drives it. Jest compiles each module again for every test file in a worker,
// through vm.compileFunction, and V8 reuses the compiled script for identical
// source. These reproduce that in one process: a function that runs in the
// first and third "test files" must be in both footprints.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-jest-test-')));
const repo = path.join(tmp, 'repo'); const rec = path.join(tmp, 'rec');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
for (const k of Object.keys(process.env)) if (k.startsWith('TRACEGATE')) delete process.env[k];
process.env.TRACEGATE_RECORD = rec;

const { recorderState, takeFootprint } = await import('../src/recorder.mjs');
const jestAdapter = await import('../src/runners/jest.mjs');
const { runnerOf } = await import('../src/runners/index.mjs');

// A module as Babel would emit it, with an inline source map (identity, one line each).
const body = 'function add(a, b) { return a + b; }\nfunction sub(a, b) { return a - b; }\nmodule.exports = { add, sub };\n';
const map = { version: 3, sources: ['math.ts'], names: [], mappings: 'AAAA;AACA;AACA' };
const code = `${body}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
const MOD = path.join(repo, 'src', 'math.js');
const evaluate = (text = code) => { const m = { exports: {} }; vm.compileFunction(text, ['module', 'exports'], { filename: MOD, parsingContext: vm.createContext({}) })(m, m.exports); return m.exports; };
const raw = (t) => JSON.parse(fs.readFileSync(path.join(rec, 'raw', fs.readdirSync(path.join(rec, 'raw')).find((f) => JSON.parse(fs.readFileSync(path.join(rec, 'raw', f), 'utf8')).testFile === t)), 'utf8'));

const st = await recorderState({ repoRoot: repo, srcPrefix: 'src/', callCount: true });
// file 1 runs add; file 2 runs nothing of math; file 3 runs add again.
evaluate().add(1, 2); await takeFootprint(st, path.join(repo, 'test/one.test.ts'));
evaluate(); await takeFootprint(st, path.join(repo, 'test/two.test.ts'));
evaluate().add(3, 4); await takeFootprint(st, path.join(repo, 'test/three.test.ts'));
const one = raw('test/one.test.ts'), two = raw('test/two.test.ts'), three = raw('test/three.test.ts');
check('the module compiled through vm.compileFunction is captured and mapped', one.exec['src/math.js']?.offs.length === 1 && one.unmapped.length === 0, JSON.stringify(one));
check('a file that did not call add() does not get it', two.exec['src/math.js']?.offs.length === 0, JSON.stringify(two.exec));
check('a function that ran in an EARLIER file of the worker is in a later file\'s footprint too', three.exec['src/math.js']?.offs.length === 1 && three.exec['src/math.js'].offs[0] === one.exec['src/math.js'].offs[0], JSON.stringify(three));
evaluate(code.replace('a - b', 'b - a')).sub(1, 2); await takeFootprint(st, path.join(repo, 'test/four.test.ts'));
check('a module compiled with two different texts in one worker is unmapped, never mapped against one of them', raw('test/four.test.ts').unmapped.includes('src/math.js'), JSON.stringify(raw('test/four.test.ts')));

// ── the adapter ─────────────────────────────────────────────────────────────
check('a jest lane gets the jest adapter; an unknown runner is an error', runnerOf({ runner: 'jest' }) === jestAdapter && (() => { try { runnerOf({ name: 'x', runner: 'mocha' }); return false; } catch { return true; } })());
check('a selection is passed by path, never as patterns', JSON.stringify(jestAdapter.filesArgs(['/r/a.test.ts'])) === '["--runTestsByPath","/r/a.test.ts"]' && jestAdapter.filesArgs([]).length === 0);
check('jest results parse like vitest\'s: a failed assertion fails the file', JSON.stringify(jestAdapter.parseResults({ testResults: [{ name: '/r/a.test.ts', status: 'passed', startTime: 1, endTime: 4, assertionResults: [{ status: 'failed' }] }] })) === '[{"name":"/r/a.test.ts","status":"failed","durationMs":3}]');
check('a worker count already given is respected (-w, --maxWorkers)', jestAdapter.hasWorkersArg(['-w', '2']) && jestAdapter.hasWorkersArg(['--maxWorkers=3']) && !jestAdapter.hasWorkersArg(['--ci']));

check('the Jest environment asks the recorder for call counts', /recorderState\(\{ \.\.\.laneTarget\(\), callCount: true \}\)/.test(fs.readFileSync(new URL('../src/jest-environment.mjs', import.meta.url), 'utf8')));

st.session.disconnect();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== jest tests: ${fail} FAILED, ${pass} passed ==` : `\n== jest tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
