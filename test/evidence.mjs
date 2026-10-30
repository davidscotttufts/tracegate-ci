#!/usr/bin/env node
// Evidence tests: `tracegate savings` (day-one value from the shadow log) and
// `tracegate report-card` (the published error rates), on fixture logs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-evidence-test-')));
const repo = path.join(tmp, 'repo'); const ledger = path.join(tmp, 'ledger');
fs.mkdirSync(repo);
fs.writeFileSync(path.join(repo, 'tracegate.config.json'), JSON.stringify({ lanes: { app: { dir: '.', src: 'src' } } }));
execFileSync('git', ['-C', repo, 'init', '-q']);
for (const k of Object.keys(process.env)) if (k.startsWith('TRACEGATE')) delete process.env[k];
Object.assign(process.env, { TRACEGATE_ROOT: repo, TRACEGATE_LEDGER: ledger, TRACEGATE_HOST: 'ev' });

const P = await import('../src/predictor.mjs');
const E = await import('../src/evidence.mjs');
const { appendTsv, readTsv, SHADOW_HEADER } = await import('../src/ledger.mjs');
const quiet = (f) => { const log = console.log; console.log = () => {}; try { return f(); } finally { console.log = log; } };
const day = 86_400_000;
const ago = (d) => new Date(Date.now() - d * day).toISOString();
const reset = () => fs.rmSync(ledger, { recursive: true, force: true });

// ── report() writes the seconds a reuse would have saved ────────────────────
// a: must run (2 s); b: reusable, passed (3 s); c: reusable, FAILED (4 s) — a miss.
const run = path.join(tmp, 'run');
fs.mkdirSync(run);
fs.writeFileSync(path.join(run, 'predict.json'), JSON.stringify({ lane: 'app', mode: 'shadow', head: 'abc123def4567890', decisions: {
  'a.test.ts': { run: true, reason: 'no footprint' }, 'b.test.ts': { run: false, reason: 'green' }, 'c.test.ts': { run: false, reason: 'green' } } }));
const res = (f, status, ms) => ({ name: path.join(repo, f), status, startTime: 0, endTime: ms, assertionResults: [] });
fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify({ testResults: [res('a.test.ts', 'passed', 2000), res('b.test.ts', 'passed', 3000), res('c.test.ts', 'failed', 4000)] }));
quiet(() => P.report({ lane: 'app', run }));
const row = readTsv('shadow-').at(-1);
check('the shadow row records the total test time', row.total_s === '9.000', JSON.stringify(row));
check('a MISS is not a saving: only the reusable files that passed count', row.reusable_s === '3.000', JSON.stringify(row));

// ── an older log gains the new columns without losing its rows ──────────────
reset(); fs.mkdirSync(ledger);
const oldHdr = SHADOW_HEADER.slice(0, 10);
fs.writeFileSync(path.join(ledger, 'shadow-ev.tsv'), oldHdr.join('\t') + '\n' + [ago(3), 'app', 'shadow', 'x', 10, 4, 6, 0, '40.0', 0].join('\t') + '\n');
appendTsv('shadow-', SHADOW_HEADER, [ago(2), 'app', 'shadow', 'y', 10, 2, 8, 0, '20.0', 0, '100.0', '80.0']);
const rows = readTsv('shadow-');
check('the header widens: a new row is read in full', rows[1]?.reusable_s === '80.0', JSON.stringify(rows));
check('...and the old row is kept, without the new columns', rows.length === 2 && rows[0].reusable === '6' && rows[0].reusable_s === undefined, JSON.stringify(rows[0]));
fs.writeFileSync(path.join(ledger, 'other-ev.tsv'), 'a\tb\n1\t2\n');
appendTsv('other-', ['a', 'c', 'd'], [3, 4, 5]);
check('a header that is not a prefix of the new one is left alone', fs.readFileSync(path.join(ledger, 'other-ev.tsv'), 'utf8').startsWith('a\tb\n'));

// ── savings ─────────────────────────────────────────────────────────────────
const s = P.savings({ lane: 'app' })[0];
check('savings counts every observed run, timed or not', s.runs === 2 && s.files === 20 && s.reusableFiles === 14, JSON.stringify(s));
check('...minutes only from rows that carry them', s.timedRuns === 1 && s.totalS === 100 && s.reusableS === 80, JSON.stringify(s));
check('...and the projection keeps the audit (5%: 80 s → 76 s)', s.projectedS === 76 && s.projectedPct === 76, JSON.stringify(s));
check('...and counts down to the entry bar', !s.entryBar.ok && s.entryBar.observationsLeft === 18 && s.entryBar.daysLeft === 11, JSON.stringify(s.entryBar));
check('the one-line summary names the saving and the countdown', /14 of 20 file runs .* 1\.3 min of 1\.7 min .* 1\.3 min \(76%\).* 18 observation\(s\) and 11 day\(s\)/.test(P.savingsLine(s)), P.savingsLine(s));

// ── Wilson interval ─────────────────────────────────────────────────────────
const w0 = E.wilson(0, 10), w5 = E.wilson(5, 10);
check('Wilson: 0 of 10 is not 0%: its upper bound is ≈ 27.8%', w0[0] === 0 && Math.abs(w0[1] - 0.2775) < 1e-3, JSON.stringify(w0));
check('Wilson: 5 of 10 is ≈ 23.7% – 76.3%; no trials gives no interval', Math.abs(w5[0] - 0.2366) < 1e-3 && Math.abs(w5[1] - 0.7634) < 1e-3 && E.wilson(0, 0) === null, JSON.stringify(w5));

// ── report card on fixture logs ─────────────────────────────────────────────
reset(); fs.mkdirSync(ledger);
const tsv = (name, hdr, rs) => fs.writeFileSync(path.join(ledger, `${name}-ev.tsv`), hdr.join('\t') + '\n' + rs.map((r) => r.join('\t')).join('\n') + '\n');
tsv('shadow', SHADOW_HEADER, [
  [ago(10), 'app', 'shadow', 'h1', 100, 10, 90, 0, '10.0', 0, '60', '54'],  // 90 reused verdicts checked
  [ago(5), 'app', 'enforce', 'h2', 100, 20, 80, 4, '20.0', 1, '60', '48'],  // 80 reused, only 4 checked
  [ago(1), 'app', 'enforce', 'h3', 100, 30, 70, 6, '30.0', 1, '60', '42'],  // 6 checked
]);
tsv('misses', ['at', 'lane', 'head', 'file', 'reason'], [[ago(5), 'app', 'h2', 'x.test.ts', 'green'], [ago(1), 'app', 'h3', 'y.test.ts', 'green']]);
tsv('triage', ['at', 'lane', 'file', 'head', 'verdict'], [[ago(4.9), 'app', 'x.test.ts', 'h2', 'flake'], [ago(4), 'app', 'x.test.ts', 'h2', 'hole']]);
tsv('full', ['at', 'lane', 'head'], [[ago(6), 'app', 'f1'], [ago(5.5), 'app', 'f2'], [ago(0.5), 'app', 'f3']]);
const card = E.reportCard({ lane: 'app' }).lanes[0];
check('report card: a verdict is checked when shadow ran it or enforce audited it, not when enforce reused it', card.misses.checked === 100 && card.misses.missed === 2 && card.misses.rate === 0.02, JSON.stringify(card.misses));
check('...with a Wilson interval on that rate and on the per-run rate', card.misses.wilson95?.[1] > 0.02 && card.misses.runsWithMiss === 2 && card.misses.perRunWilson95 !== null, JSON.stringify(card.misses));
check('...the LATEST triage verdict decides (a flake later called a hole is a hole)', card.triage.hole === 1 && card.triage.untriaged === 1 && card.triage.flake === 0, JSON.stringify(card.triage));
check('...exposure runs from the last full run BEFORE the miss (12 h), not a later one', card.longestExposure?.exposureHours === 12 && card.longestExposure.file === 'x.test.ts', JSON.stringify(card.longestExposure));
check('...audit cost is audited files over the files enforce had to run', card.auditCost.audited === 10 && card.auditCost.mustRun === 50 && card.auditCost.ratio === 0.2, JSON.stringify(card.auditCost));
check('...and the mean share selected is per run', card.observations.meanSelected === 0.2 && card.observations.runs === 3, JSON.stringify(card.observations));
const md = E.cardMarkdown(E.reportCard({}));
check('the Markdown card states the rate with its interval and the exposure bound', /2\.00% per checked verdict \(95% CI \d/.test(md) && md.includes('12 h (x.test.ts at h2)') && md.includes('upper bound'), md);

// ── through the CLI ─────────────────────────────────────────────────────────
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.mjs');
const env = { ...process.env };
const out = path.join(tmp, 'card.json');
execFileSync(process.execPath, [cli, 'report-card', '--json', '--out', out], { env, stdio: 'ignore' });
check('`tracegate report-card --json --out` writes the card', JSON.parse(fs.readFileSync(out, 'utf8')).lanes[0].misses.checked === 100);
const sv = JSON.parse(execFileSync(process.execPath, [cli, 'savings', '--json'], { env, encoding: 'utf8' }));
check('`tracegate savings --json` sums the reusable seconds', sv[0].reusableS === 144, JSON.stringify(sv));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== evidence tests: ${fail} FAILED, ${pass} passed ==` : `\n== evidence tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
