#!/usr/bin/env node
// Red Reader tests (Phase 1; src/red.mjs). A throwaway git repo and ledger; a
// synthetic red run; then the packet, the closed-world opinion, the escalate-only
// property, scoring against triage, and the MCP surface. Every check is a ✓/✗ line.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'src', 'cli.mjs');
let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-red-test-')));
const repo = path.join(tmp, 'repo'); const ledger = path.join(tmp, 'ledger');
fs.mkdirSync(repo);
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
g('init', '-q');
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const commit = (m) => { g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', m); return g('rev-parse', 'HEAD').trim(); };
w('src/a.ts', 'export const a = 1;\n'); w('test/a.test.ts', "it('a', () => {});\n"); w('test/b.test.ts', "it('b', () => {});\n");
const C1 = commit('one');
w('src/a.ts', 'export const a = 2; // the change\n');
const C2 = commit('two');
process.env.TRACEGATE_ROOT = repo; process.env.TRACEGATE_LEDGER = ledger; process.env.TRACEGATE_HOST = 'redtest';
delete process.env.TRACEGATE_CONTENDED;
const red = await import('../src/red.mjs');

// A red run: a.test.ts failed as a MISS (predicted reusable), b.test.ts failed and was predicted to run.
const run = path.join(tmp, 'run'); fs.mkdirSync(run);
fs.writeFileSync(path.join(run, 'predict.json'), JSON.stringify({ lane: 'default', mode: 'enforce', head: C2, decisions: {
  'test/a.test.ts': { run: false, audit: true, reason: 'reusable' }, 'test/b.test.ts': { run: true, reason: 'body of a function the test ran (src/a.ts)' } } }));
fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify({ testResults: [
  { name: path.join(repo, 'test/a.test.ts'), status: 'failed', assertionResults: [{ fullName: 'a works', status: 'failed', failureMessages: ['\x1b[31mexpected 2 to be 1\x1b[0m\n    at test/a.test.ts:1:1'] }] },
  { name: path.join(repo, 'test/b.test.ts'), status: 'failed', message: 'x'.repeat(9000), assertionResults: [] },
  { name: path.join(repo, 'test/c.test.ts'), status: 'passed', assertionResults: [{ fullName: 'c', status: 'passed' }] },
] }));
fs.writeFileSync(path.join(run, 'misses.txt'), 'test/a.test.ts\n');
const p = red.writePacket({ lane: 'default', run, rechecks: { 'test/a.test.ts': 'failed' } });

const A = p.failed.find((f) => f.file === 'test/a.test.ts'); const B = p.failed.find((f) => f.file === 'test/b.test.ts');
check('packet: every failing file, and only those', p.failedCount === 2 && !!A && !!B && !p.failed.some((f) => f.file === 'test/c.test.ts'), JSON.stringify(p.failed.map((f) => f.file)));
check('packet: failure text, with terminal colour codes removed', A.text.includes('expected 2 to be 1') && !A.text.includes('\x1b'), A.text);
check('packet: the prediction and its reason per file', A.prediction?.run === false && A.prediction.audit === true && /function the test ran/.test(B.prediction?.reason ?? ''));
check('packet: the MISS and how its re-run alone went', A.miss === true && A.recheckAlone === 'failed' && B.miss === false);
check('packet: long failure text is clipped, and says so', B.text.length < 4200 && /more characters clipped/.test(B.text));
check('packet: what changed against the first parent, with the diff', p.base === `${C2}^` && p.changed.some((l) => l.endsWith('src/a.ts')) && p.diff.includes('the change'), JSON.stringify(p.changed));
check('packet: stored in the ledger and indexed', fs.existsSync(path.join(ledger, 'red', `${p.id}.json`)) && red.listRed()[0]?.id === p.id);
// The traversal target EXISTS (a JSON file just outside red/), so only the id rule can refuse it.
fs.writeFileSync(path.join(ledger, 'outside.json'), JSON.stringify({ id: 'outside' }));
check('packet: read back by id; a path in the id is refused', red.readPacket(p.id).id === p.id && (() => { try { red.readPacket('../outside'); return false; } catch { return true; } })());

// Opinions: closed world.
const refused = (o) => { try { red.annotate(o); return false; } catch (e) { return /opinion refused/.test(e.message); } };
const good = { id: p.id, verdict: 'real', escalate: true, confidence: 0.8, reasons: 'src/a.ts:1 changed a from 1 to 2; test/a.test.ts:1 expects 1.' };
check('opinion: an unknown verdict is refused', refused({ ...good, verdict: 'green' }));
check('opinion: escalate must be a boolean', refused({ ...good, escalate: 'yes' }));
check('opinion: confidence outside 0..1 is refused', refused({ ...good, confidence: 1.5 }));
check('opinion: an unknown field is refused (no smuggled "triage" or "pass")', refused({ ...good, triage: 'flake' }) && refused({ ...good, pass: true }));
check('opinion: a file that did not fail in the packet is refused', refused({ ...good, files: ['test/c.test.ts'] }));
check('opinion: a missing packet is refused', refused({ ...good, id: 'default-000000000000-x' }));
check('opinion: nothing was stored by the refused ones', red.opinions().length === 0);
const rec = red.annotate(good);
check('opinion: a valid one is stored with the packet\'s lane and head', rec.head === C2 && red.opinions().length === 1 && red.listRed()[0].opinion?.verdict === 'real');

// Escalate-only: an opinion never reaches triage or the miss log.
const triageFiles = () => { try { return fs.readdirSync(ledger).filter((f) => f.startsWith('triage-')); } catch { return []; } };
red.annotate({ ...good, verdict: 'flake-suspect', escalate: false, confidence: 0.9, reasons: 'a flake, says the model' });
check('escalate-only: a flake-suspect opinion writes NO triage row', triageFiles().length === 0);
check('escalate-only: nothing in the predictor imports the Red Reader', !fs.readFileSync(path.join(PKG, 'src', 'predictor.mjs'), 'utf8').includes('red.mjs'));
fs.writeFileSync(path.join(run, 'misses.txt'), '');
const q = red.writePacket({ lane: 'default', run, base: C1 });
red.annotate({ id: q.id, verdict: 'infra', escalate: false, confidence: 0.5, reasons: 'load' });
check('packet ids are unique even for two packets in the same second from one process', q.id !== p.id && fs.existsSync(path.join(ledger, 'red', `${p.id}.json`)) && fs.existsSync(path.join(ledger, 'red', `${q.id}.json`)), `${p.id} ${q.id}`);
check('list: newest first when nothing is escalated', red.listRed()[0].id === q.id);
red.annotate({ ...good, reasons: 'escalating again with new evidence' });
check('list: an escalated packet sorts above a newer one that is not', red.listRed()[0].id === p.id && red.listRed()[0].opinion.escalate === true);
check('packet: --base is honoured', red.readPacket(q.id).base === C1);

// Score against triage (the person's verdict).
fs.writeFileSync(path.join(ledger, 'triage-redtest.tsv'), `at\tlane\tfile\thead\tverdict\n${new Date().toISOString()}\tdefault\ttest/a.test.ts\t${C2.slice(0, 12)}\thole\n`);
const sc = red.score();
check('score: an opinion is compared with the later triage of the same file and head', sc.scored === 3 && sc.agree === 2 && sc.disagree.length === 1 && sc.disagree[0].said === 'flake-suspect', JSON.stringify(sc));

// Phase 1b: an escalated `real` opinion on a MISS raises the runner's flake to a hole.
const pred = await import('../src/predictor.mjs');
const h12 = C2.slice(0, 12);
const t0 = new Date(Date.now() - 60_000).toISOString(); const t1 = new Date(Date.now() - 30_000).toISOString();
fs.writeFileSync(path.join(ledger, 'misses-redtest.tsv'), `at\tlane\thead\tfile\treason\n${t0}\tdefault\t${h12}\ttest/a.test.ts\treusable\n`);
fs.writeFileSync(path.join(ledger, 'triage-redtest.tsv'), `at\tlane\tfile\thead\tverdict\n${t1}\tdefault\ttest/a.test.ts\t${h12}\tflake\n`);
fs.rmSync(path.join(ledger, 'escalations-redtest.tsv'), { force: true });
check('escalation: before any opinion, the recheck flake excuses the miss', pred.entryBar('default').recentMiss === false);
check('escalation: a red that was NOT a miss is not escalated', red.annotate({ ...good, files: ['test/b.test.ts'], confidence: 0.95 }).escalated.length === 0 && pred.entryBar('default').recentMiss === false);
check('escalation: below the confidence floor nothing is raised', red.annotate({ ...good, confidence: 0.5 }).escalated.length === 0 && pred.entryBar('default').recentMiss === false);
check('escalation: a flake-suspect or un-escalated opinion raises nothing', red.annotate({ ...good, escalate: false, confidence: 0.95 }).escalated.length === 0 && pred.entryBar('default').recentMiss === false);
const esc = red.annotate({ ...good, confidence: 0.9 });
check('escalation: a confident escalated MISS suspends the lane again', esc.escalated.join() === 'test/a.test.ts' && pred.entryBar('default').recentMiss === true, JSON.stringify(esc.escalated));
await new Promise((r) => setTimeout(r, 5));
pred.triage({ lane: 'default', file: 'test/a.test.ts', head: h12, verdict: 'flake' });
check('escalation: a person who says flake afterwards has the last word', pred.entryBar('default').recentMiss === false);
check('escalation: score counts it raised, and overridden by the person', (() => { const x = red.score(); return x.raised === 1 && x.overridden === 1; })(), JSON.stringify(red.score()));

// MCP: read tools always; the write tool only with --allow-write.
async function mcpTools(args) {
  const m = spawn(process.execPath, [CLI, 'mcp', ...args], { env: { ...process.env, TRACEGATE_BROKER_DIR: path.join(tmp, 'b'), TRACEGATE_BROKER_SOCKET: path.join(tmp, 's.sock') }, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = ''; const answers = [];
  m.stdout.on('data', (x) => { buf += x; let i; while ((i = buf.indexOf('\n')) >= 0) { answers.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const rpc = (id, method, params) => m.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  rpc(2, 'tools/list', {}); rpc(3, 'tools/call', { name: 'read_red', arguments: { id: p.id } });
  for (let i = 0; i < 50 && answers.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
  m.stdin.end(); m.kill();
  return { names: answers.find((a) => a.id === 2)?.result?.tools?.map((t) => t.name) ?? [], read: answers.find((a) => a.id === 3) };
}
const ro = await mcpTools([]); const rw = await mcpTools(['--allow-write']);
check('MCP: red_runs and read_red are read tools; annotate_red is not listed without --allow-write', ro.names.includes('red_runs') && ro.names.includes('read_red') && !ro.names.includes('annotate_red'), JSON.stringify(ro.names));
check('MCP: annotate_red is listed with --allow-write', rw.names.includes('annotate_red'));
check('MCP: read_red returns the packet', JSON.parse(ro.read?.result?.content?.[0]?.text ?? '{}').id === p.id);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== red reader tests: ${fail} FAILED, ${pass} passed ==` : `\n== red reader tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
