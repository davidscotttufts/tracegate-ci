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
import { apply, DEFAULT_CLASSES, explain, initialState, PREEMPT_GAP, schedule } from '../src/broker/core.mjs';
import { summarize } from '../src/broker/observed.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'src', 'cli.mjs');
let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

// ── Part 1: the pure scheduler ────────────────────────────────────────────────
// A tiny driver: enqueue/release by hand, run schedule() and apply its decisions
// the way the server does, keeping the full event log for replay.
function sim(capacity, opts = {}) {
  const st = initialState({ capacity, ...opts });
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
      for (const g of d.grants) { ev({ type: 'grant', ...g }); out.grants.push(g.id); }
      for (const p of d.preempts) { ev({ type: 'preempt', id: p.id, by: p.by }); out.preempts.push(p.id); }
    }
    return out;
  };
  let n = 0;
  return {
    st, log, step,
    tick: (s) => { now += s * 1000; },
    setNow: (t) => { now = t; },
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

// I10 — observe: adopt the broker beside other coordination without changing it
{
  // Capacity 3: the gate leaves 1 token free, so only the OBSERVED job's tokens
  // can make the later 1-token job wait.
  const s = sim(3);
  const gate = s.add({ class: 'gate', tokens: 2, est: 600 }); s.step();
  // Both queued before one step, so they are decided in the SAME scheduling pass:
  // the observed grant must use up its tokens there, not only from the next pass.
  const obs = s.add({ class: 'gate', tokens: 2, observe: true, label: 'observed gate' });
  const later = s.add({ class: 'adhoc', tokens: 1 }); s.step();
  check('I10: an observed job is granted at once, even with no room', s.state(obs) === 'running');
  check('I10: ...and records that it WOULD have waited', s.st.jobs.get(obs).wouldWait === true && s.log.some((e) => e.type === 'grant' && e.id === obs && e.observed && e.wouldWait));
  check('I10: its tokens count, so ordinary work still sees the real load', s.state(later) === 'queued');
  s.end(gate); s.end(obs); s.step();
  const free = s.add({ class: 'gate', tokens: 1, observe: true });
  s.end(later); s.step();
  check('I10: with room, an observed job records that it would NOT have waited', s.st.jobs.get(free).wouldWait === false);
}
{
  const s = sim(4);
  const d = s.add({ class: 'daemon', tokens: 4 }); s.step();
  const m = s.add({ class: 'measure', exclusive: true, observe: true }); const out = s.step();
  check('I10: an observed job never preempts anything', !out.preempts.length && s.state(d) === 'running' && s.state(m) === 'running', JSON.stringify(out));
}
// I11 — yield: an observed gate registered with `yield` keeps the daemon's old
// "yield to any gate" rule, inside the broker, so the daemon's own check can go.
{
  const s = sim(8);
  const d = s.add({ class: 'daemon', tokens: 2 }); s.step();
  const g = s.add({ class: 'gate', tokens: 2, observe: true, yieldOthers: true }); const out = s.step();
  check('I11: a running daemon is asked to yield to an observed gate with yield, even with room for both', out.preempts.includes(d) && s.state(g) === 'running', JSON.stringify(out));
  s.end(d, 'preempted');
  const d2 = s.add({ class: 'daemon', tokens: 1 }); s.step();
  check('I11: a new daemon lease waits while that gate lives', s.state(d2) === 'queued' && /yields while/.test(explain(s.st, d2, s.now()).text), explain(s.st, d2, s.now()).text);
  const a = s.add({ class: 'adhoc', tokens: 1 }); s.step();
  check('I11: work that is not preemptible is not held', s.state(a) === 'running');
  s.end(g); s.step();
  check('I11: when the gate ends, the daemon starts', s.state(d2) === 'running');
}
{
  const s = sim(8);
  const d = s.add({ class: 'daemon', tokens: 2 }); s.step();
  const g = s.add({ class: 'gate', tokens: 2, observe: true }); const out = s.step();
  check('I11: without yield, an observed gate preempts nothing (I10 unchanged)', !out.preempts.length && s.state(d) === 'running' && s.state(g) === 'running', JSON.stringify(out));
}
{
  const s = sim(8);
  const m = s.add({ class: 'measure', tokens: 2 }); s.step();
  const dep = s.add({ class: 'deploy', tokens: 2, observe: true, yieldOthers: true }); const out = s.step();
  check('I11: yield never touches work that is not preemptible', !out.preempts.includes(m) && s.state(m) === 'running' && s.state(dep) === 'running', JSON.stringify(out));
  const yl = s.add({ class: 'adhoc', tokens: 1, yieldOthers: true }); s.step();
  check('I11: only an OBSERVED job can carry yield', s.st.jobs.get(yl).yieldOthers === false);
}
{
  const t0 = 1_000_000;
  const ev = [
    { type: 'enqueue', id: 'j1', class: 'gate', label: 'a', at: t0 }, { type: 'grant', id: 'j1', tokens: 2, at: t0 },
    { type: 'enqueue', id: 'j2', class: 'train', label: 'b', observe: true, at: t0 + 60_000 },
    { type: 'grant', id: 'j2', tokens: 2, observed: true, wouldWait: true, behind: [{ class: 'gate', label: 'a' }], at: t0 + 60_000 },
    { type: 'release', id: 'j2', at: t0 + 180_000 }, { type: 'release', id: 'j1', at: t0 + 240_000 },
  ];
  const r = summarize(ev, { capacity: 2, now: t0 + 300_000 });
  check('observed report: would-have-waited grants, behind whom, and minutes over the budget', r.observed === 1 && r.wouldWait === 1 && r.waits[0].behind[0] === 'gate a' && r.overCapacityMinutes === 2 && r.peakTokens === 4, JSON.stringify(r));
}

// I12 — on demand: a deploy a person asked for goes first, and preemptible work yields at once
{
  const s = sim(2);
  const busy = s.add({ class: 'gate', tokens: 2, est: 600, label: 'gate busy' }); s.step();
  const gate = s.add({ class: 'gate', tokens: 2, label: 'queued gate' });
  const deploy = s.add({ class: 'deploy', tokens: 2, label: 'nightly deploy' });
  const asked = s.add({ class: 'deploy', tokens: 2, label: 'deploy someone asked for', onDemand: true });
  const out = s.step();
  check('I12: an on-demand job never preempts a running gate', !out.preempts.includes(busy) && s.state(busy) === 'running' && s.state(asked) === 'queued', JSON.stringify(out));
  check('I12: ...it holds the reservation, ahead of a deploy and a gate queued before it', out.reservation?.id === asked, JSON.stringify(out.reservation));
  s.end(busy); s.step();
  check('I12: ...and takes the freed capacity first', s.state(asked) === 'running' && s.state(deploy) === 'queued' && s.state(gate) === 'queued');
}
{
  const s = sim(8);
  const d = s.add({ class: 'daemon', tokens: 2 }); s.step();
  const asked = s.add({ class: 'deploy', tokens: 1, onDemand: true }); const out = s.step();
  check('I12: a running daemon is asked to yield at once, even with room for both', out.preempts.includes(d) && s.state(asked) === 'running', JSON.stringify(out));
  s.end(d, 'preempted');
  const d2 = s.add({ class: 'daemon', tokens: 1 }); s.step();
  check('I12: no preemptible work starts while it lives', s.state(d2) === 'queued' && /on demand/.test(explain(s.st, d2, s.now()).text), explain(s.st, d2, s.now()).text);
  const a = s.add({ class: 'adhoc', tokens: 1 }); s.step();
  check('I12: work that is not preemptible is not held', s.state(a) === 'running');
  s.end(asked); s.step();
  check('I12: when it ends, the daemon starts', s.state(d2) === 'running');
}
{
  // The priority gap does not protect preemptible work from an on-demand job.
  const s = initialState({ capacity: 2, classes: { low: { priority: 45, preemptible: true }, mid: { priority: 50, preemptible: false } } });
  let seq = 0; const at = 5;
  apply(s, { seq: ++seq, at, type: 'enqueue', id: 'j1', class: 'low', tokens: 2 });
  apply(s, { seq: ++seq, at, type: 'grant', id: 'j1', tokens: 2 });
  apply(s, { seq: ++seq, at, type: 'enqueue', id: 'j2', class: 'mid', tokens: 2 });
  const without = schedule(s, at).preempts.length;
  apply(s, { seq: ++seq, at, type: 'enqueue', id: 'j3', class: 'mid', tokens: 2, onDemand: true });
  check(`I12: an on-demand job preempts preemptible work inside the ${PREEMPT_GAP}-point gap; an ordinary one does not`, without === 0 && schedule(s, at).preempts.some((p) => p.id === 'j1'));
  apply(s, { seq: ++seq, at, type: 'enqueue', id: 'j4', class: 'low', tokens: 1, onDemand: true });
  check('I12: a preemptible job cannot be on demand', s.jobs.get('j4').onDemand === false);
}
// Several ledgers on one broker: what is learned stays per ledger
{
  const s = sim(1);
  for (const secs of [100, 100, 100]) { const id = s.add({ class: 'gate', label: 'gate main', ledger: '/a/.git/tracegate' }); s.step(); s.tick(secs); s.end(id); }
  for (const secs of [900, 900, 900]) { const id = s.add({ class: 'gate', label: 'gate main', ledger: '/b/.git/tracegate' }); s.step(); s.tick(secs); s.end(id); }
  const a = s.add({ class: 'gate', label: 'gate main', ledger: '/a/.git/tracegate' }); s.step();
  const b = s.st.jobs.get(a); const est = (l) => s.st.durations.get(`gate\u0000gate main\u0000${l}`);
  check('ledgers: durations are kept per ledger, so repo B\'s "gate main" does not set repo A\'s estimate',
    est('/a/.git/tracegate')?.every((x) => x === 100) && est('/b/.git/tracegate')?.every((x) => x === 900) && b.ledger === '/a/.git/tracegate', JSON.stringify([...s.st.durations]));
  const old = s.add({ class: 'gate', label: 'gate main' });
  check('ledgers: a job with no ledger (an older client) keys as before', s.st.jobs.get(old).ledger === null);
}

// ── I13: release windows (ADR 1166 D9.3) ────────────────────────────────────
// A class may carry a window: it starts only inside it, in that zone, and such
// jobs run one at a time. The rule exists because the nightly release window is a
// wall-clock promise (23:00-06:00 America/New_York), and a scheduler that ignores
// it turns "release by night" back into "whoever is awake".
{
  const NIGHT = { from: '23:00', to: '06:00', tz: 'America/New_York' };
  const classes = { ...DEFAULT_CLASSES, night: { priority: 50, preemptible: false, window: NIGHT } };
  const s = sim(4, { classes });
  s.setNow(Date.parse('2026-11-28T19:00:00Z')); // 14:00 ET, window closed
  const a = s.add({ class: 'night', tokens: 1, est: 600 });
  s.step();
  check('I13: a night job does NOT start outside the window (14:00 ET)', s.state(a) === 'queued');
  check('I13: ...and explain names the closed window', /window is closed/.test(explain(s.st, a, s.now()).text), explain(s.st, a, s.now()).text);

  s.setNow(Date.parse('2026-11-29T04:30:00Z')); // 23:30 ET, open
  s.step();
  check('I13: ...and starts once the window opens (23:30 ET)', s.state(a) === 'running');

  const b = s.add({ class: 'night', tokens: 1, est: 600 });
  s.step();
  check('I13: windowed jobs run ONE at a time even with spare capacity', s.state(b) === 'queued');
  s.end(a); s.step();
  check('I13: ...and the next starts when the first ends', s.state(b) === 'running');

  s.setNow(Date.parse('2026-11-29T11:30:00Z')); // 06:30 ET, window closed
  const d = schedule(s.st, s.now());
  check('I13: a job running past the close is NOT interrupted', s.state(b) === 'running' && d.preempts.length === 0);
  const c = s.add({ class: 'night', tokens: 1, est: 60 });
  s.step();
  check('I13: ...and nothing NEW starts after the close', s.state(c) === 'queued');

  // A class with no window is unaffected (the default for every existing class).
  const plain = sim(2);
  const g = plain.add({ class: 'gate', tokens: 1 });
  plain.step();
  check('I13: classes without a window are unaffected', plain.state(g) === 'running');
}

// ── Part 2: a live broker ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-broker-test-'));
const env = { ...process.env, TRACEGATE_BROKER_DIR: path.join(tmp, 'broker'), TRACEGATE_BROKER_SOCKET: path.join(tmp, 's.sock'), TRACEGATE_BROKER_CAPACITY: '2', TRACEGATE_BROKER_ADAPTIVE: 'off' };
delete env.TRACEGATE_LEASE;
// Every broker this test starts is stopped however the test ends, including when a
// harness kills it on a timeout (a sabotaged rule can make a check wait forever).
const started = new Set();
const stopAll = () => { for (const p of started) { try { p.kill('SIGKILL'); } catch { /* gone */ } } };
process.on('exit', stopAll);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { stopAll(); process.exit(1); });
const startBroker = (e, stdio) => { const p = spawn(process.execPath, [CLI, 'broker', 'serve'], { env: e, stdio }); started.add(p); p.on('exit', () => started.delete(p)); return p; };
const broker = startBroker(env, ['ignore', 'pipe', 'pipe']);
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
    'console.log([process.env.TRACEGATE_TOKENS, process.env.VITEST_MAX_WORKERS, !!process.env.TRACEGATE_LEASE, Number(process.env.TRACEGATE_FENCE) > 0].join(",")); process.exit(7)'], { env, encoding: 'utf8', timeout: 15000 });
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

  // I11 live: `observe --yield` for a gate stops a running daemon lease (exit 75).
  const d3 = lease(['--class', 'daemon', '--tokens', '1', '--', process.execPath, '-e', 'setInterval(()=>{},1000)']);
  await sleep(600);
  const gatePid = spawn(process.execPath, ['-e', 'setTimeout(()=>{},4000)'], { stdio: 'ignore' });
  const ob = spawn(process.execPath, [CLI, 'observe', '--quiet', '--class', 'gate', '--yield', '--watch-pid', String(gatePid.pid)], { env, stdio: 'ignore' });
  const d3Code = await Promise.race([new Promise((r) => d3.on('exit', r)), sleep(8000).then(() => 'still running')]);
  check('I11 live: observe --yield makes a running daemon lease exit 75', d3Code === 75, String(d3Code));
  if (d3Code !== 75) d3.kill('SIGKILL');
  gatePid.kill('SIGKILL'); await new Promise((r) => ob.on('exit', r));

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

  // observe, live: never blocks, and ends with the process it watches.
  {
    const hog2 = await raw(); hog2.send({ op: 'request', class: 'gate', tokens: 2, label: 'holder' }); await hog2.wait((x) => x.type === 'granted');
    const target = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 2500)']);
    const t0 = Date.now();
    const ob = spawn(process.execPath, [CLI, 'observe', '--quiet', '--class', 'train', '--tokens', '2', '--label', 'observed train', '--watch-pid', String(target.pid)], { env, stdio: 'ignore' });
    started.add(ob);
    const obCode = await Promise.race([new Promise((r) => ob.on('exit', r)), sleep(12000).then(() => 'timeout')]);
    const evs = fs.readFileSync(path.join(env.TRACEGATE_BROKER_DIR, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const g = evs.filter((e) => e.type === 'grant' && e.observed).pop();
    check('observe live: granted at once while the machine is full, logged as would-have-waited behind the holder', !!g && g.wouldWait === true && JSON.stringify(g.behind ?? []).includes('holder'), JSON.stringify(g));
    check('observe live: exits 0 soon after the watched process ends', obCode === 0 && Date.now() - t0 < 9000, `${obCode} after ${Date.now() - t0} ms`);
    check('observe live: its lease is released when it exits', evs.some((e) => e.type === 'release' && e.id === g?.id) || (await sleep(300), fs.readFileSync(path.join(env.TRACEGATE_BROKER_DIR, 'events.jsonl'), 'utf8').includes(`"id":"${g?.id}","reason":"holder-exited"`)));
    hog2.s.destroy(); await sleep(150);
  }

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
  const b = startBroker(e, 'ignore');
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
// ── Part 4: one broker per machine (scope), version skew, on demand, live ─────
// Two git repos, each with its own ledger (<repo>/.git/tracegate), and NO broker
// override: only the scope decides whether they meet. HOME and TMPDIR are private to
// the test, so the machine broker it starts is not this machine's real one.
const mroot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgm-'));
const home = path.join(mroot, 'home'); const tdir = path.join(mroot, 't'); fs.mkdirSync(home); fs.mkdirSync(tdir);
const mkRepo = (name, cfg) => { const r = path.join(mroot, name); fs.mkdirSync(r); spawnSync('git', ['init', '-q', r]); if (cfg) fs.writeFileSync(path.join(r, 'tracegate.config.json'), JSON.stringify(cfg)); return fs.realpathSync(r); };
const repoA = mkRepo('repo-a', { broker: { capacity: 2, adaptive: { mode: 'off' } } });
const repoB = mkRepo('repo-b', { broker: { capacity: 3, adaptive: { mode: 'off' } } });
const menv = { ...process.env, HOME: home, TMPDIR: tdir, TRACEGATE_HOST: 'testhost' };
for (const k of ['TRACEGATE_BROKER_DIR', 'TRACEGATE_BROKER_SOCKET', 'TRACEGATE_BROKER_CAPACITY', 'TRACEGATE_BROKER_ADAPTIVE', 'TRACEGATE_BROKER_SCOPE', 'TRACEGATE_LEASE', 'TRACEGATE_LEDGER', 'TRACEGATE_ROOT', 'TRACEGATE_CONFIG', 'TRACEGATE_CONTENDED']) delete menv[k];
const leaseIn = (cwd, args, extra = {}) => { const p = spawn(process.execPath, [CLI, 'lease', '--quiet', ...args], { cwd, env: { ...menv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); started.add(p); const code = new Promise((r) => p.on('exit', (c) => { started.delete(p); r(c); })); return { p, code, out: () => out }; };
const forever = [process.execPath, '-e', 'setInterval(()=>{},1000)'];
const within = (pr, ms) => Promise.race([pr, sleep(ms).then(() => 'still running')]);
// Stop every broker a scope test started (they are detached, with a 30 min idle exit).
const stopBrokersUnder = (dir) => {
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name === 'broker.pid') { try { process.kill(Number(fs.readFileSync(f, 'utf8')), 'SIGTERM'); } catch { /* gone */ } } } };
  walk(dir);
};
process.on('exit', () => stopBrokersUnder(mroot));
const evsIn = (dir) => { try { return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
const machineDir = path.join(home, '.tracegate', 'broker', 'testhost');

try {
  // Two ledgers, one machine: a daemon lease from repo A yields to a gate from repo B.
  {
    const d = leaseIn(repoA, ['--class', 'daemon', '--tokens', '1', '--label', 'pregate', '--', ...forever]);
    for (let i = 0; i < 80 && !evsIn(machineDir).some((e) => e.type === 'grant'); i++) await sleep(100);
    const q = spawnSync(process.execPath, [CLI, 'queue', '--json'], { cwd: repoB, env: menv, encoding: 'utf8', timeout: 15000 });
    let st = {}; try { st = JSON.parse(q.stdout); } catch { /* shown below */ }
    check('scope machine: repo B sees repo A\'s running job, with its repo', st.scope === 'machine' && st.running?.some((j) => j.class === 'daemon' && j.repo === 'repo-a'), q.stdout + q.stderr);
    const g = leaseIn(repoB, ['--class', 'gate', '--tokens', '2', '--', process.execPath, '-e', 'console.log("gate ran")']);
    const dCode = await within(d.code, 10000);
    check('scope machine: repo A\'s daemon lease yields (exit 75) to repo B\'s gate', dCode === 75, `${dCode} ${d.out()}`);
    if (dCode !== 75) d.p.kill('SIGKILL');
    const gCode = await within(g.code, 10000);
    check('scope machine: ...and the gate runs', gCode === 0 && g.out().includes('gate ran'), `${gCode} ${g.out()}`);
    check('scope machine: repo B was warned that the first broker\'s config (capacity 2, repo A\'s) is in force, not its own 3', /hands out 2 token\(s\); this repo's config gives 3/.test(g.out()) && /repo-a/.test(g.out()), g.out());
    const evs = evsIn(machineDir);
    const enq = evs.filter((e) => e.type === 'enqueue');
    check('scope machine: one event log for both, each job recording its ledger and repo',
      enq.some((e) => e.repo === 'repo-a' && e.ledger === path.join(repoA, '.git', 'tracegate')) && enq.some((e) => e.repo === 'repo-b' && e.ledger === path.join(repoB, '.git', 'tracegate')), JSON.stringify(enq));
    check('scope machine: neither ledger got a broker of its own', !fs.existsSync(path.join(repoA, '.git', 'tracegate', 'broker')) && !fs.existsSync(path.join(repoB, '.git', 'tracegate', 'broker')));
    const sock = fs.readdirSync(tdir).filter((f) => f.endsWith('.sock'));
    check('scope machine: one socket, named by user and host (not by ledger), within the macOS length limit', sock.length === 1 && /^tracegate-m/.test(sock[0]) && Buffer.byteLength(path.join(tdir, sock[0])) < 104, JSON.stringify(sock));
  }
  // On demand, live: a daemon lease yields at once, though there is room for both.
  {
    const d = leaseIn(repoA, ['--class', 'daemon', '--tokens', '1', '--', ...forever]);
    for (let i = 0; i < 80 && !(evsIn(machineDir).filter((e) => e.type === 'grant').length >= 3); i++) await sleep(100);
    const od = leaseIn(repoB, ['--class', 'deploy', '--tokens', '1', '--on-demand', '--', process.execPath, '-e', 'console.log("deployed")']);
    const dCode = await within(d.code, 10000);
    check('on-demand live: a running daemon lease is stopped at once (exit 75), though 1 of 2 tokens was free', dCode === 75, `${dCode} ${d.out()}`);
    if (dCode !== 75) d.p.kill('SIGKILL');
    const odCode = await within(od.code, 10000);
    check('on-demand live: ...and the requested deploy runs', odCode === 0 && od.out().includes('deployed'), `${odCode} ${od.out()}`);
    const bad = spawnSync(process.execPath, [CLI, 'lease', '--class', 'daemon', '--on-demand', '--', process.execPath, '-e', '1'], { cwd: repoA, env: menv, encoding: 'utf8', timeout: 15000 });
    check('on-demand live: a preemptible class is refused', bad.status === 2 && /preemptible/.test(bad.stderr), `${bad.status} ${bad.stderr}`);
  }
  // A second broker is never started beside a live one on the same socket.
  {
    const sockFile = path.join(tdir, fs.readdirSync(tdir).find((f) => f.endsWith('.sock')));
    const pid0 = fs.readFileSync(path.join(machineDir, 'broker.pid'), 'utf8');
    const dup = spawnSync(process.execPath, [CLI, 'broker', 'serve'], { cwd: repoB, env: menv, encoding: 'utf8', timeout: 15000 });
    const again = spawnSync(process.execPath, [CLI, 'queue', '--json'], { cwd: repoA, env: menv, encoding: 'utf8', timeout: 15000 });
    check('duplicate: `broker serve` beside a live broker exits, and the first keeps serving', /already serving/.test(dup.stderr) && JSON.parse(again.stdout || '{}').pid === Number(pid0) && fs.existsSync(sockFile), `${dup.status} ${dup.stderr} ${again.stdout}`);
  }
  stopBrokersUnder(home); await sleep(300);
  fs.rmSync(path.join(home, '.tracegate'), { recursive: true, force: true });

  // Scope ledger: the old separation. Each ledger gets its own broker, and they do not meet.
  {
    const le = { TRACEGATE_BROKER_SCOPE: 'ledger' };
    const d = leaseIn(repoA, ['--class', 'daemon', '--tokens', '1', '--', ...forever], le);
    const dirA = path.join(repoA, '.git', 'tracegate', 'broker', 'testhost');
    for (let i = 0; i < 80 && !evsIn(dirA).some((e) => e.type === 'grant'); i++) await sleep(100);
    const g = leaseIn(repoB, ['--class', 'gate', '--tokens', '2', '--', process.execPath, '-e', 'console.log("gate ran")'], le);
    const gCode = await within(g.code, 10000);
    await sleep(500);
    check('scope ledger: repo B\'s gate runs on a broker of its own', gCode === 0 && fs.existsSync(path.join(repoB, '.git', 'tracegate', 'broker', 'testhost', 'events.jsonl')), `${gCode} ${g.out()}`);
    check('scope ledger: ...and repo A\'s daemon is not asked to yield (the old behaviour)', d.p.exitCode === null && !evsIn(dirA).some((e) => e.type === 'preempt'), `${d.p.exitCode}`);
    check('scope ledger: no machine broker was started', !fs.existsSync(machineDir));
    d.p.kill('SIGTERM'); await within(d.code, 5000);
  }
  stopBrokersUnder(mroot); await sleep(300);

  // Version skew: a 0.10.x broker (no protocol number in its hello) on the socket.
  {
    const oldSock = path.join(tdir, 'old.sock'); const oldDir = path.join(mroot, 'old-broker');
    const conns = []; let requests = 0;
    const old = net.createServer((s) => {
      conns.push(s); let buf = ''; s.setEncoding('utf8');
      s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (m.op === 'hello') s.write(JSON.stringify({ type: 'hello', capacity: 2, pid: 4242 }) + '\n');
        else if (m.op === 'request') { requests++; s.write(JSON.stringify({ type: 'granted', id: `j${requests}`, tokens: 1, fence: requests, nested: false, memMB: 0, contended: false }) + '\n'); }
        else if (m.op === 'release') s.write(JSON.stringify({ type: 'ok', ref: m.ref }) + '\n'); } });
    });
    await new Promise((r) => old.listen(oldSock, r));
    const oe = { TRACEGATE_BROKER_SOCKET: oldSock, TRACEGATE_BROKER_DIR: oldDir };
    // Async: the fake broker runs in this process, so a spawnSync would starve it.
    const run = (args) => new Promise((resolve) => { const p = spawn(process.execPath, [CLI, 'lease', '--quiet', ...args], { cwd: repoA, env: { ...menv, ...oe }, stdio: ['ignore', 'pipe', 'pipe'] }); started.add(p); const r = { stdout: '', stderr: '' }; p.stdout.on('data', (d) => { r.stdout += d; }); p.stderr.on('data', (d) => { r.stderr += d; }); const t = setTimeout(() => p.kill('SIGKILL'), 15000); p.on('exit', (c) => { clearTimeout(t); started.delete(p); resolve({ ...r, status: c }); }); });
    const od = await run(['--class', 'deploy', '--on-demand', '--', process.execPath, '-e', 'console.log("RAN")']);
    check('skew: --on-demand against a protocol-1 broker exits 76 without running the command', od.status === 76 && !od.stdout.includes('RAN') && requests === 0, `${od.status} ${od.stdout}${od.stderr}`);
    check('skew: ...and says why: protocol, version, and what to do', /protocol 1/.test(od.stderr) && /0\.10\.x or older/.test(od.stderr) && /Nothing was started beside it/.test(od.stderr), od.stderr);
    check('skew: ...and starts no second broker beside it', !fs.existsSync(path.join(oldDir, 'broker.pid')) && !fs.existsSync(path.join(oldDir, 'broker.log')));
    const plain = await run(['--', process.execPath, '-e', 'console.log("RAN")']);
    check('skew: a plain lease still runs on the older broker, with a warning', plain.status === 0 && plain.stdout.includes('RAN') && /older than this client/.test(plain.stderr), `${plain.status} ${plain.stdout}${plain.stderr}`);
    for (const c of conns) c.destroy(); old.close();
  }
  // Version skew, the other way: the broker refuses a client older than it serves.
  {
    const e = { ...env, TRACEGATE_BROKER_DIR: path.join(mroot, 'skew-b'), TRACEGATE_BROKER_SOCKET: path.join(tdir, 'sk.sock') };
    const b = startBroker(e, 'ignore');
    for (let i = 0; i < 50 && !fs.existsSync(e.TRACEGATE_BROKER_SOCKET); i++) await sleep(100);
    const s = await new Promise((resolve) => { const c = net.connect(e.TRACEGATE_BROKER_SOCKET); const msgs = []; let buf = ''; c.setEncoding('utf8'); c.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { msgs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } }); c.once('connect', () => resolve({ c, msgs })); });
    s.c.write(JSON.stringify({ op: 'hello', ref: 'h', protocol: 0 }) + '\n');
    s.c.write(JSON.stringify({ op: 'hello', ref: 'h2', protocol: 2 }) + '\n');
    await sleep(400);
    const r0 = s.msgs.find((m) => m.ref === 'h'); const r2 = s.msgs.find((m) => m.ref === 'h2');
    check('skew: the broker refuses a hello below its minimum protocol, with a code', r0?.type === 'error' && r0.code === 'protocol', JSON.stringify(r0));
    check('skew: ...and answers a current one with its protocol, version and who started it', r2?.type === 'hello' && r2.protocol === 2 && 'startedBy' in r2 && r2.minProtocol === 1, JSON.stringify(r2));
    s.c.destroy(); b.kill('SIGTERM'); await sleep(200);
  }
} finally {
  stopBrokersUnder(mroot); await sleep(200);
  fs.rmSync(mroot, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(fail ? `\n== broker tests: ${fail} FAILED, ${pass} passed ==` : `\n== broker tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
