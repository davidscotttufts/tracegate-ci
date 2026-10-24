#!/usr/bin/env node
// Broker tests (docs/design/broker.md).
//
// Part 1 drives the PURE scheduler (src/broker/core.mjs) with an explicit clock,
// including regressions F1–F3: the three coordination failures that motivated
// the broker, each rebuilt as a scenario that must now resolve by itself.
// Part 2 runs a real broker process on a temp socket and checks the properties
// only a live process can show: a SIGKILLed holder frees its lease (I3), a nested
// request runs inside its parent (I2), a preempted wrapper exits 75, and the MCP
// server answers. Every check is a ✓/✗ line; the exit code is the verdict.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, explain, initialState, PREEMPT_GAP, schedule } from '../src/broker/core.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'src', 'cli.mjs');
let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

// ── Part 1: the pure scheduler ────────────────────────────────────────────────
// A tiny driver: enqueue/release by hand, run schedule() and apply its decisions
// the way the server does, keeping the full event log for replay.
function sim(capacity) {
  const st = initialState({ capacity });
  const log = [];
  let now = 1_000_000;
  const ev = (e) => { const x = { seq: st.seq + 1, at: now, ...e }; log.push(x); apply(st, x); return x; };
  const step = () => {
    const out = { grants: [], preempts: [], expires: [], reservation: null };
    for (let i = 0; i < 20; i++) {
      const d = schedule(st, now);
      out.reservation = d.reservation;
      if (!d.grants.length && !d.preempts.length && !d.expires.length) break;
      for (const id of d.expires) { ev({ type: 'expire', id, reason: 'deadline' }); out.expires.push(id); }
      for (const g of d.grants) { ev({ type: 'grant', id: g.id, tokens: g.tokens, nested: g.nested }); out.grants.push(g.id); }
      for (const p of d.preempts) { ev({ type: 'preempt', id: p.id, by: p.by }); out.preempts.push(p.id); }
    }
    return out;
  };
  let n = 0;
  return {
    st, log, step,
    tick: (s) => { now += s * 1000; },
    now: () => now,
    add: (o) => { const id = `j${++n}`; ev({ type: 'enqueue', id, class: 'adhoc', tokens: 1, ...o }); return id; },
    end: (id, reason = 'done') => ev({ type: st.jobs.get(id)?.state === 'running' ? 'release' : 'cancel', id, reason }),
    state: (id) => st.jobs.get(id)?.state ?? 'gone',
  };
}

{
  const s = sim(4);
  const a = s.add({ class: 'gate', tokens: 3, est: 600 });
  const b = s.add({ class: 'gate', tokens: 3, est: 600 });
  s.step();
  check('capacity: the first gate runs, the second waits', s.state(a) === 'running' && s.state(b) === 'queued');
  s.end(a); s.step();
  check('capacity: releasing the first grants the second, with no message from anyone', s.state(b) === 'running');
}
{
  const s = sim(2);
  const busy = s.add({ class: 'gate', tokens: 2, est: 600 }); s.step();
  const low = s.add({ class: 'adhoc', tokens: 2 });
  const high = s.add({ class: 'deploy', tokens: 2 });
  s.end(busy); s.step();
  check('priority: a deploy queued later starts before an adhoc run', s.state(high) === 'running' && s.state(low) === 'queued');
}
{
  const s = sim(2);
  const g = [s.add({ class: 'gate', tokens: 2, est: 60 }), s.add({ class: 'gate', tokens: 2, est: 60 }), s.add({ class: 'gate', tokens: 2, est: 60 })];
  s.step(); s.end(g[0]); s.step();
  check('FIFO within a tier', s.state(g[1]) === 'running' && s.state(g[2]) === 'queued');
}

// F1 — the cross-wait deadlock. A measurement needed a quiet machine and waited
// for "no other suite"; the daemon's batch WAS another suite, and the daemon only
// yielded to a lock the measurement could not take while the batch ran.
{
  const s = sim(8);
  const daemon = s.add({ class: 'daemon', tokens: 2, label: 'pre-gate PR heads' }); s.step();
  const measure = s.add({ class: 'measure', exclusive: true, label: 'A/B' });
  const d1 = s.step();
  check('F1: an exclusive measurement preempts the running daemon batch (no cross-wait)', d1.preempts.includes(daemon), JSON.stringify(d1));
  check('F1: ...and waits for it to yield rather than overlapping', s.state(measure) === 'queued');
  s.end(daemon, 'preempted'); s.step();
  check('F1: ...then starts by itself once the daemon has released', s.state(measure) === 'running');
  const again = s.add({ class: 'daemon', tokens: 1 }); s.step();
  check('F1: a requeued daemon batch does not start inside the exclusive window', s.state(again) === 'queued');
}

// F2 — the self-deadlock. A measurement held the machine-wide claim; its own
// test runs went through a wrapper that waited while ANY claim existed.
{
  const s = sim(8);
  const measure = s.add({ class: 'measure', exclusive: true }); s.step();
  const child = s.add({ class: 'adhoc', tokens: 2, parent: measure }); s.step();
  check('F2: a request from inside a running lease is granted at once (no self-deadlock)', s.state(child) === 'running');
  check('F2: ...as a nested grant that uses none of the capacity', s.st.jobs.get(child).nested === true);
  const outsider = s.add({ class: 'adhoc', tokens: 1 }); s.step();
  check('F2: a request from OUTSIDE the lease still waits for the exclusive window', s.state(outsider) === 'queued');
  s.end(measure); s.step();
  check('F2: the parent ending ends its nested child too', s.state(child) === 'gone');
}

// F3 — the missed window. The machine went quiet and the coordinator forgot to
// send "GO". Here the reservation is state: it starts when capacity frees.
{
  // The gate leaves tokens free, so only the reservation can stop a later gate.
  const s = sim(4);
  const gate = s.add({ class: 'gate', tokens: 2, est: 900 }); s.step();
  const measure = s.add({ class: 'measure', exclusive: true, est: 1500 });
  const r = s.step().reservation;
  check('F3: a blocked exclusive job gets a reservation at the running gate\'s expected end', r?.id === measure && r.at === s.st.jobs.get(gate).grantedAt + 900_000, JSON.stringify(r));
  const longGate = s.add({ class: 'gate', tokens: 1, est: 3600 }); s.step();
  check('F3: a later gate that would overrun the reservation does not jump ahead', s.state(longGate) === 'queued');
  s.tick(900); s.end(gate); s.step();
  check('F3: when the gate ends, the measurement starts with nobody sending GO', s.state(measure) === 'running' && s.state(longGate) === 'queued');
}

// I5 — EASY backfill
{
  // Three tokens stay free, so capacity alone would admit all three later jobs:
  // only the reservation can keep the long and the unknown ones out.
  const s = sim(6);
  const gate = s.add({ class: 'gate', tokens: 3, est: 900 }); s.step();
  const big = s.add({ class: 'gate', tokens: 6, est: 900 }); s.step();
  const short = s.add({ class: 'adhoc', tokens: 1, est: 60 });
  const long = s.add({ class: 'adhoc', tokens: 1, est: 1800 });
  const unknown = s.add({ class: 'adhoc', tokens: 1 });
  s.step();
  check('I5: a short job that ends before the reservation backfills the free token', s.state(short) === 'running');
  check('I5: a job that would overrun the reservation does not', s.state(long) === 'queued');
  check('I5: a job with no estimate does not backfill (it might never end)', s.state(unknown) === 'queued');
  check('I5: the blocked job keeps its place', s.state(big) === 'queued' && s.state(gate) === 'running');
}

// I6 — preemption rules
{
  const s = sim(2);
  const gate = s.add({ class: 'gate', tokens: 2, est: 600 }); s.step();
  const deploy = s.add({ class: 'deploy', tokens: 2 });
  const d = s.step();
  check('I6: a running gate is never preempted, even for a deploy', !d.preempts.includes(gate) && s.state(deploy) === 'queued');
}
{
  const s = initialState({ capacity: 2, classes: { low: { priority: 10, preemptible: true }, near: { priority: 10 + PREEMPT_GAP - 1, preemptible: false } } });
  let seq = 0; const at = 5;
  apply(s, { seq: ++seq, at, type: 'enqueue', id: 'j1', class: 'low', tokens: 2 });
  apply(s, { seq: ++seq, at, type: 'grant', id: 'j1', tokens: 2 });
  apply(s, { seq: ++seq, at, type: 'enqueue', id: 'j2', class: 'near', tokens: 2 });
  check(`I6: no preemption across a priority gap below ${PREEMPT_GAP}`, schedule(s, at).preempts.length === 0);
}

// I7 — fencing
{
  const s = sim(1);
  const ids = [1, 2, 3].map(() => s.add({ tokens: 1 }));
  const fences = [];
  for (const id of ids) { s.step(); fences.push(s.st.jobs.get(id).fence); s.end(id); }
  check('I7: fence tokens strictly increase across grants', fences.every((f, i) => i === 0 || f > fences[i - 1]), JSON.stringify(fences));
}

// Deadlines
{
  const s = sim(1);
  s.add({ class: 'gate', tokens: 1 }); s.step();
  const late = s.add({ tokens: 1, deadline: s.now() + 60_000 });
  s.tick(61); const d = s.step();
  check('a queued job past its deadline expires with a logged event', d.expires.includes(late) && s.log.some((e) => e.type === 'expire' && e.id === late));
}

// Estimates from history
{
  const s = sim(1);
  for (const secs of [100, 110, 120, 130, 400]) { const id = s.add({ class: 'gate', label: 'gate api' }); s.step(); s.tick(secs); s.end(id); }
  const j = s.add({ class: 'gate', label: 'gate api' }); s.step();
  const blocked = s.add({ class: 'gate', tokens: 1 });
  const r = s.step().reservation;
  check('estimates: p90 of past runs of the same (class, label) sets the reservation', r?.id === blocked && r.at === s.st.jobs.get(j).grantedAt + 400_000, JSON.stringify(r));
}

// I8 — replay
{
  const s = sim(3);
  const a = s.add({ class: 'gate', tokens: 2, est: 300 }); const b = s.add({ class: 'daemon', tokens: 1 }); s.step();
  s.add({ class: 'measure', exclusive: true }); s.step(); s.end(b, 'preempted'); s.tick(300); s.end(a); s.step();
  const r = initialState({ capacity: 3 });
  for (const e of s.log) apply(r, JSON.parse(JSON.stringify(e)));
  const view = (st) => JSON.stringify([...st.jobs.values()].map((j) => [j.id, j.state, j.fence, j.granted]));
  check('I8: replaying the event log rebuilds the same state', view(r) === view(s.st) && r.fence === s.st.fence);
  check('I8: ...and the same next decision', JSON.stringify(schedule(r, s.now())) === JSON.stringify(schedule(s.st, s.now())));
}

// explain
{
  const s = sim(2);
  s.add({ class: 'gate', tokens: 2, est: 600, label: 'gate main' }); s.step();
  const q = s.add({ class: 'adhoc', tokens: 1, label: 'my tests' }); s.step();
  const e = explain(s.st, q, s.now());
  check('explain names the position, the holder of the capacity and the reservation', e.position === 1 && /gate main/.test(JSON.stringify(e.blockers)) && /reserved to start/.test(e.text), e.text);
}

// ── Part 2: a live broker ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-broker-test-'));
const env = { ...process.env, TRACEGATE_BROKER_DIR: path.join(tmp, 'broker'), TRACEGATE_BROKER_SOCKET: path.join(tmp, 's.sock'), TRACEGATE_BROKER_CAPACITY: '2' };
delete env.TRACEGATE_LEASE;
const broker = spawn(process.execPath, [CLI, 'broker', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let brokerOut = ''; broker.stdout.on('data', (d) => { brokerOut += d; }); broker.stderr.on('data', (d) => { brokerOut += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50 && !fs.existsSync(env.TRACEGATE_BROKER_SOCKET); i++) await sleep(100);
check('broker: starts and listens on its socket', fs.existsSync(env.TRACEGATE_BROKER_SOCKET), brokerOut);

const raw = () => new Promise((resolve, reject) => {
  const s = net.connect(env.TRACEGATE_BROKER_SOCKET); let buf = ''; const msgs = [];
  s.setEncoding('utf8');
  s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { msgs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  s.once('connect', () => resolve({ s, msgs, send: (m) => s.write(JSON.stringify(m) + '\n'), wait: async (pred, ms = 5000) => { const t = Date.now() + ms; while (Date.now() < t) { const m = msgs.find(pred); if (m) return m; await sleep(25); } return null; } }));
  s.once('error', reject);
});
const lease = (args, extraEnv = {}) => spawn(process.execPath, [CLI, 'lease', '--quiet', ...args], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });

try {
  // I3: a holder killed with SIGKILL frees its lease (the kernel closes the socket).
  const holder = spawn(process.execPath, ['-e', `
    const net=require('net'); const s=net.connect(${JSON.stringify(env.TRACEGATE_BROKER_SOCKET)});
    s.on('connect',()=>{ s.write(JSON.stringify({op:'request',class:'gate',tokens:2,label:'victim'})+'\\n'); });
    s.on('data',d=>{ if(String(d).includes('"granted"')) process.stdout.write('GRANTED\\n'); });
    setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((r) => holder.stdout.on('data', (d) => { if (String(d).includes('GRANTED')) r(); }));
  const w = await raw();
  w.send({ op: 'request', class: 'gate', tokens: 2, label: 'waiter' });
  const q = await w.wait((m) => m.type === 'queued');
  check('I3: a second full-capacity request queues behind a live holder', !!q);
  holder.kill('SIGKILL');
  const g = await w.wait((m) => m.type === 'granted');
  check('I3: SIGKILL of the holder frees its lease; the waiter is granted with no cleanup step', !!g);
  w.s.destroy(); await sleep(150);

  // The wrapper: env, exit code, nesting.
  const r1 = spawnSync(process.execPath, [CLI, 'lease', '--quiet', '--tokens', '2', '--', process.execPath, '-e',
    'console.log([process.env.TRACEGATE_TOKENS, process.env.VITEST_MAX_WORKERS, !!process.env.TRACEGATE_LEASE, Number(process.env.TRACEGATE_FENCE) > 0].join(",")); process.exit(7)'], { env, encoding: 'utf8' });
  check('lease: the command sees TRACEGATE_TOKENS, VITEST_MAX_WORKERS, TRACEGATE_LEASE and a fence', r1.stdout.trim() === '2,2,true,true', r1.stdout + r1.stderr);
  check('lease: the command\'s exit code is forwarded', r1.status === 7, String(r1.status));
  const r2 = spawnSync(process.execPath, [CLI, 'lease', '--quiet', '--class', 'measure', '--exclusive', '--',
    process.execPath, CLI, 'lease', '--quiet', '--tokens', '1', '--', process.execPath, '-e', 'console.log("inner ran")'], { env, encoding: 'utf8', timeout: 15000 });
  check('I2 live: a lease taken inside an exclusive lease runs (no self-deadlock)', r2.stdout.includes('inner ran') && r2.status === 0, `${r2.status} ${r2.stdout}${r2.stderr}`);

  // Preemption: a daemon lease is stopped for an exclusive measurement; its wrapper exits 75.
  const d = lease(['--class', 'daemon', '--tokens', '1', '--', process.execPath, '-e', 'setInterval(()=>{},1000)']);
  await sleep(600);
  const m = lease(['--class', 'measure', '--exclusive', '--', process.execPath, '-e', 'console.log("measured")']);
  const dCode = await new Promise((r) => d.on('exit', r));
  let mOut = ''; m.stdout.on('data', (x) => { mOut += x; });
  const mCode = await new Promise((r) => m.on('exit', r));
  check('I6 live: the daemon\'s wrapper is preempted and exits 75 (EX_TEMPFAIL)', dCode === 75, String(dCode));
  check('I6 live: ...and the measurement then runs', mCode === 0 && mOut.includes('measured'), `${mCode} ${mOut}`);

  // Deadline through the wrapper
  const hog = await raw(); hog.send({ op: 'request', class: 'gate', tokens: 2 }); await hog.wait((x) => x.type === 'granted');
  const late = spawnSync(process.execPath, [CLI, 'lease', '--quiet', '--deadline-min', '0.02', '--', process.execPath, '-e', '1'], { env, encoding: 'utf8', timeout: 15000 });
  check('lease: a deadline that passes in the queue exits 75 without running the command', late.status === 75, `${late.status} ${late.stderr}`);
  hog.s.destroy(); await sleep(150);

  // MCP
  const mcp = spawn(process.execPath, [CLI, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let mbuf = ''; const answers = [];
  mcp.stdout.on('data', (x) => { mbuf += x; let i; while ((i = mbuf.indexOf('\n')) >= 0) { answers.push(JSON.parse(mbuf.slice(0, i))); mbuf = mbuf.slice(i + 1); } });
  const rpc = (id, method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  rpc(2, 'tools/list', {});
  rpc(3, 'tools/call', { name: 'queue_status', arguments: {} });
  rpc(4, 'tools/call', { name: 'cancel_queued', arguments: { id: 'j1' } });
  for (let i = 0; i < 50 && answers.length < 4; i++) await sleep(100);
  const by = (id) => answers.find((a) => a.id === id);
  check('MCP: initialize negotiates the protocol version', by(1)?.result?.protocolVersion === '2025-06-18', JSON.stringify(by(1)));
  const names = by(2)?.result?.tools?.map((t) => t.name) ?? [];
  check('MCP: read-only by default (no write tool listed)', names.includes('queue_status') && names.includes('explain_job') && !names.includes('cancel_queued'), JSON.stringify(names));
  check('MCP: queue_status returns the broker\'s capacity', JSON.parse(by(3)?.result?.content?.[0]?.text ?? '{}').capacity === 2, JSON.stringify(by(3)));
  check('MCP: an unlisted write tool is refused', !!by(4)?.error, JSON.stringify(by(4)));
  mcp.stdin.end();

  // The log is the record
  const events = fs.readFileSync(path.join(env.TRACEGATE_BROKER_DIR, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const seqs = events.map((e) => e.seq);
  check('I8 live: every event is in the log with a strictly increasing seq', seqs.every((x, i) => i === 0 || x === seqs[i - 1] + 1), seqs.slice(0, 20).join(','));
  check('I8 live: the SIGKILLed holder\'s release is recorded with its reason', events.some((e) => e.type === 'release' && e.reason === 'holder-exited'));
} finally {
  broker.kill('SIGTERM');
  await sleep(200);
}

// ── Part 3: the advisor hook (models may only permute a tier) ─────────────────
async function withAdvisor(name, advisorJs, mode, fn) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'advisor.mjs');
  fs.writeFileSync(script, advisorJs);
  const cfg = path.join(dir, 'tracegate.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ broker: { advisor: { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, mode } } }));
  const e = { ...env, TRACEGATE_CONFIG: cfg, TRACEGATE_BROKER_DIR: path.join(dir, 'broker'), TRACEGATE_BROKER_SOCKET: path.join(dir, 's.sock'), TRACEGATE_BROKER_CAPACITY: '1' };
  const b = spawn(process.execPath, [CLI, 'broker', 'serve'], { env: e, stdio: 'ignore' });
  for (let i = 0; i < 50 && !fs.existsSync(e.TRACEGATE_BROKER_SOCKET); i++) await sleep(100);
  const conn = () => new Promise((resolve) => {
    const s = net.connect(e.TRACEGATE_BROKER_SOCKET); let buf = ''; const msgs = [];
    s.setEncoding('utf8');
    s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { msgs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    s.once('connect', () => resolve({ s, msgs, send: (m) => s.write(JSON.stringify(m) + '\n') }));
  });
  const events = () => fs.readFileSync(path.join(e.TRACEGATE_BROKER_DIR, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  try { await fn({ conn, events }); } finally { b.kill('SIGTERM'); await sleep(150); }
}
// Hold the one token, then queue three adhoc jobs in one tier: j2, j3, j4.
async function tierOfThree({ conn }) {
  const hog = await conn(); hog.send({ op: 'request', class: 'gate', tokens: 1, label: 'hog' });
  const cs = [];
  for (const label of ['first', 'second', 'third']) { const c = await conn(); c.send({ op: 'request', class: 'adhoc', tokens: 1, label }); cs.push(c); await sleep(80); }
  await sleep(1200); // advisor runs async (≤ 10 s); these answer at once
  return { hog, cs };
}
const REVERSE = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);process.stdout.write(JSON.stringify({order:i.jobs.map(j=>j.id).reverse(),reasons:"test"}))})';
const INVENT = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);process.stdout.write(JSON.stringify({order:[...i.jobs.map(j=>j.id),"j999"]}))})';

await withAdvisor('shadow', REVERSE, 'shadow', async (h) => {
  const { hog, cs } = await tierOfThree(h);
  const adv = h.events().filter((e) => e.type === 'advice');
  check('advisor (shadow): advice is logged', adv.some((a) => Array.isArray(a.order) && a.applied === false), JSON.stringify(adv));
  check('advisor (shadow): ...and not applied (no rank events)', !h.events().some((e) => e.type === 'rank'));
  hog.s.destroy(); await sleep(300);
  check('advisor (shadow): FIFO order stands — the first queued job is granted next', cs[0].msgs.some((m) => m.type === 'granted'));
  for (const c of cs) c.s.destroy();
});
await withAdvisor('enforce', REVERSE, 'enforce', async (h) => {
  const { hog, cs } = await tierOfThree(h);
  check('advisor (enforce): a valid permutation is applied as rank events', h.events().some((e) => e.type === 'rank'));
  hog.s.destroy(); await sleep(300);
  check('advisor (enforce): ...so the job it put first is granted next', cs[2].msgs.some((m) => m.type === 'granted') && !cs[0].msgs.some((m) => m.type === 'granted'));
  for (const c of cs) c.s.destroy();
  await sleep(300);
  check('advisor: each answer is stored under the hash of its input (the same input is never asked twice)', fs.readdirSync(path.join(tmp, 'enforce', 'broker', 'advice-cache')).length > 0);
});
await withAdvisor('invent', INVENT, 'enforce', async (h) => {
  const { hog, cs } = await tierOfThree(h);
  const adv = h.events().filter((e) => e.type === 'advice');
  check('advisor: an answer that adds a job is rejected and logged', adv.length > 0 && adv.every((a) => a.applied === false && /permutation/.test(a.rejected ?? '')), JSON.stringify(adv));
  check('advisor: ...and changes nothing', !h.events().some((e) => e.type === 'rank'));
  hog.s.destroy(); for (const c of cs) c.s.destroy();
});
fs.rmSync(tmp, { recursive: true, force: true });

console.log(fail ? `\n== broker tests: ${fail} FAILED, ${pass} passed ==` : `\n== broker tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
