#!/usr/bin/env node
// Adaptive capacity tests (Phase 0.6; docs/design/broker.md §9).
//
// Part 1: the OS parsers, against fixtures captured from real machines.
// Part 2: the pure policy (adapt.mjs) across different hardware.
// Part 3: the pure scheduler with `capacity` events (I9).
// Part 4: a live broker fed samples from a file, with real process trees.
// Every check is a ✓/✗ line; the exit code is the verdict.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapt, changed, deriveDefaults, resolvePolicy } from '../src/broker/adapt.mjs';
import { apply, explain, initialState, memPerTokenOf, schedule, snapshot } from '../src/broker/core.mjs';
import { capacityOf } from '../src/broker/paths.mjs';
import { busyCores, parseCgroupCpu, parseCgroupMem, parseMeminfo, parsePs, parsePsi, parseTherm, parseVmStat, parseVmstatLinux, treeRss } from '../src/broker/sampler.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'src', 'cli.mjs');
let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

// ── Part 1: parsers ───────────────────────────────────────────────────────────
// An Apple-silicon Mac (16 KB pages), captured 2026-10-24.
const VM_STAT_ARM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               65023.
Pages active:                            363818.
Pages inactive:                          348718.
Pages speculative:                        12259.
Pages throttled:                              0.
Pages wired down:                        143281.
Pages purgeable:                            717.
"Translation faults":                5435286675.
Pages occupied by compressor:             79735.
Swapins:                                2229618.
Swapouts:                               3104816.
`;
const VM_STAT_X86 = VM_STAT_ARM.replace('page size of 16384 bytes', 'page size of 4096 bytes');
{
  const a = parseVmStat(VM_STAT_ARM); const x = parseVmStat(VM_STAT_X86);
  check('vm_stat: available = free + inactive + speculative + purgeable, in MB (16 KB pages)', a.availMB === Math.round(((65023 + 348718 + 12259 + 717) * 16384) / 1048576), JSON.stringify(a));
  check('vm_stat: the page size is read, not assumed (4 KB pages give a quarter)', x.availMB === Math.round(((65023 + 348718 + 12259 + 717) * 4096) / 1048576) && x.pageBytes === 4096, JSON.stringify(x));
  check('vm_stat: compressor and swap-ins are read', a.compressorMB === Math.round((79735 * 16384) / 1048576) && a.swapins === 2229618);
  check('vm_stat: unreadable text gives null, never zeros', parseVmStat('') === null && parseVmStat('garbage') === null);
}
{
  const mi = parseMeminfo('MemTotal:       65843012 kB\nMemFree:         1234567 kB\nMemAvailable:   40000000 kB\n');
  check('meminfo: MemAvailable, not MemFree', mi.availMB === Math.round(40000000 / 1024) && mi.totalMB === Math.round(65843012 / 1024), JSON.stringify(mi));
  check('PSI: some avg10', parsePsi('some avg10=12.50 avg60=3.00 avg300=1.00 total=123\nfull avg10=1.00 avg60=0 avg300=0 total=1') === 12.5);
  check('vmstat: pswpin', parseVmstatLinux('pgpgin 5\npswpin 4242\npswpout 1\n') === 4242);
  check('cgroup cpu.max: quota/period rounded up; "max" is no limit', parseCgroupCpu('250000 100000') === 3 && parseCgroupCpu('max 100000') === null);
  const cg = parseCgroupMem('4294967296\n', '1073741824\n');
  check('cgroup memory: limit and what is left under it', cg.limitMB === 4096 && cg.availMB === 3072, JSON.stringify(cg));
  check('cgroup memory: "max" is no limit', parseCgroupMem('max', '123') === null);
  check('pmset therm: CPU speed limit, or null when none is recorded', parseTherm('CPU_Speed_Limit \t= 70') === 70 && parseTherm('Note: No thermal warning level has been recorded') === null);
}
{
  const c = (u, i) => ({ times: { user: u, nice: 0, sys: 0, idle: i, irq: 0 } });
  check('busy cores: busy share of all ticks × cores (2 cores, one busy, one idle → 1)', busyCores([c(0, 0), c(0, 0)], [c(100, 0), c(0, 100)]) === 1);
  check('busy cores: needs two readings of the same machine', busyCores(null, [c(1, 1)]) === null && busyCores([c(0, 0)], [c(1, 1), c(1, 1)]) === null);
}
{
  const procs = parsePs('  1 0 1000\n 100 1 2048\n 101 100 4096\n 102 101 1024\n 200 1 9999\n');
  const t = treeRss(procs, [100, 999]);
  check('process tree: RSS of a root and all its descendants', t[100] === Math.round((2048 + 4096 + 1024) / 1024), JSON.stringify(t));
  check('process tree: a vanished root is left out, not zero', !(999 in t));
  const loop = parsePs(' 5 6 1024\n 6 5 1024\n');
  check('process tree: a ppid cycle terminates', treeRss(loop, [5])[5] === 2);
}

// ── Part 2: the policy, across hardware ───────────────────────────────────────
const P = (o = {}) => deriveDefaults(resolvePolicy({ upHoldS: 30, ...o }), { cores: 8, totalMB: 16384 });
const S = (o = {}) => ({ at: 0, cores: 8, load1: 0, totalMB: 16384, availMB: 12000, pressure: 'normal', swapMBps: 0, ...o });
const ours0 = { usedTokens: 0, reservedMB: 0, growthMB: 0 };
{
  const d = adapt(P(), S({ load1: 6 }), null, ours0, 8, 0);
  check('cpu: load that is not ours is subtracted (8 cores, load 6 → 2)', d.cpu === 2 && /not ours/.test(d.why.join()), JSON.stringify(d));
  const m = adapt(P(), S({ load1: 10.3, busyCores: 5.6 }), null, ours0, 8, 0);
  check('cpu: measured busy cores win over the load average (load 10.3, 5.6 busy → 2, not 1)', m.cpu === 2 && /5\.6 cores busy/.test(m.why.join()), JSON.stringify(m));
  const o = adapt(P(), S({ load1: 6 }), null, { ...ours0, usedTokens: 6 }, 8, 0);
  check('cpu: our own granted work is not counted against us', o.cpu === 8, JSON.stringify(o));
  check('cpu: never below minTokens', adapt(P(), S({ load1: 40 }), null, ours0, 8, 0).cpu === 1);
  check('cpu: never above the configured capacity', adapt(P(), S({ cores: 64 }), null, ours0, 8, 0).cpu === 8);
  check('cpu: a thermal speed limit scales it', adapt(P(), S({ cpuSpeedLimit: 50 }), null, ours0, 8, 0).cpu === 4);
  check('cpu: memory pressure warn caps it at warnFactor', adapt(P(), S({ pressure: 'warn' }), null, ours0, 8, 0).cpu === 4);
  const c = adapt(P(), S({ pressure: 'critical' }), null, { ...ours0, reservedMB: 3000 }, 8, 0);
  check('critical pressure: cpu at the minimum and no NEW memory (budget = what is reserved)', c.cpu === 1 && c.memMB === 3000, JSON.stringify(c));
  check('sustained swapping counts as warn even when the kernel says normal', adapt(P(), S({ swapMBps: 50 }), null, ours0, 8, 0).pressure === 'warn');
}
{
  const p = P();
  const d1 = adapt(p, S({ at: 0, load1: 6 }), null, ours0, 8, 0);
  const d2 = adapt(p, S({ at: 5000, load1: 0 }), d1, ours0, 8, 5000);
  check('hysteresis: a higher budget is held back at first', d2.cpu === 2, JSON.stringify(d2));
  const d3 = adapt(p, S({ at: 36000, load1: 0 }), d2, ours0, 8, 36000);
  check('hysteresis: ...after upHoldS it rises by one step only', d3.cpu === 3, JSON.stringify(d3));
  const d4 = adapt(p, S({ at: 37000, load1: 7 }), d3, ours0, 8, 37000);
  check('hysteresis: a lower budget applies at once', d4.cpu === 1);
}
{
  const p = P({ headroomMB: 1000 });
  const a = adapt(p, S({ at: 0, availMB: 4000 }), null, ours0, 8, 0);
  const b = adapt(p, S({ at: 5000, availMB: 12000 }), a, ours0, 8, 5000);
  check('memory: available is the MINIMUM over the window (a cache flush opens nothing)', b.memMB === 3000, JSON.stringify(b));
  const c = adapt(p, S({ at: 5000, availMB: 12000 }), a, { usedTokens: 2, reservedMB: 2000, growthMB: 1500 }, 8, 5000);
  check('memory: budget = reserved + (available − headroom − growth still to come)', c.memMB === 2000 + (4000 - 1000 - 1500), JSON.stringify(c));
  const u = adapt(p, S({ availMB: undefined, pressure: undefined, load1: undefined }), null, ours0, 8, 0);
  check('a missing reading is ignored for that signal alone, and named in why', u.cpu === 8 && u.memMB === Infinity && /unknown/.test(u.why.join()), JSON.stringify(u));
}
{
  const hw = (cores, gb) => deriveDefaults(resolvePolicy({}), { cores, totalMB: gb * 1024 });
  const laptop = hw(8, 8); const mac = hw(8, 16); const work = hw(16, 64); const big = hw(64, 128); const tiny = hw(2, 4);
  check('defaults: an 8 GB, 8-core laptop → 512 MB per token, 1024 MB headroom', laptop.defaultTokenMB === 512 && laptop.headroomMB === 1024, JSON.stringify(laptop));
  check('defaults: a 16 GB, 8-core Mac → 1024 MB per token, 1638 MB headroom', mac.defaultTokenMB === 1024 && mac.headroomMB === 1638, JSON.stringify(mac));
  check('defaults: a 64 GB, 16-core workstation → 2048 MB per token, 6554 MB headroom', work.defaultTokenMB === 2048 && work.headroomMB === 6554);
  check('defaults: a 128 GB, 64-core runner → 1024 MB per token, headroom capped at 8192', big.defaultTokenMB === 1024 && big.headroomMB === 8192);
  check('defaults: a 4 GB, 2-core container → 1024 MB per token, 1024 MB headroom', tiny.defaultTokenMB === 1024 && tiny.headroomMB === 1024);
  check('defaults: an explicit setting wins over the derived one', deriveDefaults(resolvePolicy({ defaultTokenMB: 700 }), { cores: 8, totalMB: 16384 }).defaultTokenMB === 700);
  check('capacity: a share of this host\'s cores ("75%" of 8 → 6; of 2 → 1)', capacityOf('75%', 8) === 6 && capacityOf('75%', 2) === 1 && capacityOf(4, 8) === 4 && capacityOf('x', 8) === null);
  check('changed(): small memory moves are not logged, cpu moves are', !changed({ cpu: 4, memMB: 5000, pressure: null }, { cpu: 4, memMB: 5100, pressure: null }, 256) && changed({ cpu: 4, memMB: 5000, pressure: null }, { cpu: 3, memMB: 5000, pressure: null }, 256));
}

// ── Part 3: the scheduler under budgets ───────────────────────────────────────
function sim(capacity, o = {}) {
  const st = initialState({ capacity, defaultTokenMB: 1000, starvationS: 300, ...o });
  const log = []; let now = 1_000_000;
  const ev = (e) => { const x = { seq: st.seq + 1, at: now, ...e }; log.push(x); apply(st, JSON.parse(JSON.stringify(x))); return x; };
  const step = () => {
    const out = { grants: [], preempts: [] };
    for (let i = 0; i < 20; i++) {
      const d = schedule(st, now);
      if (!d.grants.length && !d.preempts.length && !d.expires.length) break;
      for (const id of d.expires) ev({ type: 'expire', id });
      for (const g of d.grants) { ev({ type: 'grant', id: g.id, tokens: g.tokens, nested: g.nested, memMB: g.memMB, contended: g.contended }); out.grants.push(g); }
      for (const p of d.preempts) { ev({ type: 'preempt', id: p.id, by: p.by }); out.preempts.push(p); }
    }
    return out;
  };
  let n = 0;
  return {
    st, log, step, tick: (s) => { now += s * 1000; }, now: () => now,
    add: (e) => { const id = `j${++n}`; ev({ type: 'enqueue', id, class: 'adhoc', tokens: 1, ...e }); return id; },
    end: (id, extra = {}) => ev({ type: st.jobs.get(id)?.state === 'running' ? 'release' : 'cancel', id, reason: 'done', ...extra }),
    cap: (e) => ev({ type: 'capacity', applied: true, why: ['test'], ...e }),
    job: (id) => st.jobs.get(id), state: (id) => st.jobs.get(id)?.state ?? 'gone',
  };
}
{
  const s = sim(8); s.cap({ cpu: 2, memMB: null });
  const g = s.add({ class: 'gate', tokens: 4 }); s.step();
  check('I9: a request is clamped to the cpu budget, as it is to the capacity (4 asked, 2 allowed)', s.job(g).granted === 2);
}
{
  const s = sim(8); s.cap({ cpu: 6, memMB: null });
  const a = s.add({ tokens: 4, minTokens: 1 }); const b = s.add({ tokens: 4, minTokens: 1 }); const c = s.add({ tokens: 4 });
  s.step();
  check('I9 elastic: the first job gets 4, the second the 2 that are left', s.job(a).granted === 4 && s.job(b).granted === 2, `${s.job(a).granted} ${s.job(b).granted}`);
  check('I9: a job that is not elastic waits for its full width', s.state(c) === 'queued');
}
{
  const s = sim(8); s.cap({ cpu: 8, memMB: 2500 });
  const a = s.add({ tokens: 4 }); s.step();
  check('I9 memory: 2500 MB at 1000 MB per token clamps a 4-token request to 2', s.job(a).granted === 2 && s.job(a).reservedMB === 2000, JSON.stringify(s.job(a)));
  const b = s.add({ tokens: 1 }); s.step();
  check('I9 memory: a job that needs more memory than is left waits', s.state(b) === 'queued');
  s.end(b); // it holds the reservation, which (EASY) keeps out a job with no estimate
  const c = s.add({ tokens: 1, memPerToken: 400 }); s.step();
  check('I9 memory: a job that declares a smaller need fits beside it', s.state(c) === 'running' && s.job(c).reservedMB === 400);
}
{
  const s = sim(8); s.cap({ cpu: 8, memMB: 100000 });
  for (const peak of [6000, 5000]) { const id = s.add({ class: 'gate', label: 'gate api', tokens: 2 }); s.step(); s.tick(10); s.end(id, { peakMB: peak }); }
  const probe = { class: 'gate', label: 'gate api', memPerToken: null };
  check('I9 learning: memory per token is the p90 of past peaks per granted token', memPerTokenOf(s.st, probe) === 3000, String(memPerTokenOf(s.st, probe)));
  check('I9 learning: a job with no history uses this machine\'s default', memPerTokenOf(s.st, { class: 'gate', label: 'other' }) === 1000);
  const n = s.add({ class: 'gate', label: 'gate api', tokens: 2 }); s.step();
  check('I9 learning: ...and the next run of that job reserves it', s.job(n).reservedMB === 6000);
}
{
  const s = sim(8);
  const d = s.add({ class: 'daemon', tokens: 4 }); const g = s.add({ class: 'gate', tokens: 4 }); s.step();
  s.cap({ cpu: 4, memMB: null }); const out = s.step();
  check('I9 shedding: the budget falls below what runs → the preemptible daemon is asked to yield', out.preempts.some((p) => p.id === d && p.by === 'pressure'), JSON.stringify(out));
  check('I9 shedding: ...and the gate is never preempted for load', !out.preempts.some((p) => p.id === g));
  const again = s.step();
  check('I9 shedding: a job already asked is not asked twice', !again.preempts.length);
}
{
  const s = sim(8);
  const g = s.add({ class: 'gate', tokens: 8 }); s.step();
  s.cap({ cpu: 2, memMB: null }); const out = s.step();
  check('I9 shedding: a gate alone over a reduced budget keeps running (only preemptible work is shed)', !out.preempts.length && s.state(g) === 'running', JSON.stringify(out));
}
{
  const s = sim(8);
  const d1 = s.add({ class: 'daemon', tokens: 1 }); const d2 = s.add({ class: 'daemon', tokens: 1 }); s.step();
  s.cap({ cpu: 1, memMB: 0, pressure: 'critical' }); const out = s.step();
  check('I9 critical pressure: every preemptible job is shed', [d1, d2].every((id) => out.preempts.some((p) => p.id === id)), JSON.stringify(out));
}
{
  const s = sim(8); s.cap({ cpu: 1, memMB: 0, pressure: 'critical' });
  const g = s.add({ class: 'gate', tokens: 4, minTokens: 2 }); s.step();
  check('I9: no new memory under critical pressure → the gate waits', s.state(g) === 'queued');
  check('I9: explain says the machine is what holds it, and why', /machine allows/.test(explain(s.st, g, s.now()).text) && /test/.test(explain(s.st, g, s.now()).text), explain(s.st, g, s.now()).text);
  s.tick(299); s.step();
  check('I9 starvation: still waiting just before starvationS', s.state(g) === 'queued');
  s.tick(2); s.step();
  check('I9 starvation: after starvationS with none of our work running, it runs CONTENDED at its narrowest', s.state(g) === 'running' && s.job(g).contended && s.job(g).granted === 1, JSON.stringify(s.job(g)));
}
{
  const s = sim(8); s.cap({ cpu: 8, memMB: 1000 });
  const a = s.add({ class: 'gate', tokens: 1 }); s.step();
  const b = s.add({ class: 'gate', tokens: 1 }); s.tick(1000); s.step();
  check('I9 starvation: not while our own work runs (it will free the room)', s.state(a) === 'running' && s.state(b) === 'queued');
}
{
  const s = sim(8);
  s.log.push(s.cap({ cpu: 1, memMB: 0, pressure: 'critical', applied: false }));
  const a = s.add({ tokens: 4 }); s.step();
  check('I9 shadow: a shadow capacity event changes no grant', s.job(a).granted === 4 && snapshot(s.st, s.now()).shadowLimit.cpu === 1);
}
{
  const s = sim(8);
  const a = s.add({ class: 'gate', tokens: 4, minTokens: 2 }); s.step(); s.cap({ cpu: 3, memMB: 5000 });
  const b = s.add({ tokens: 2, minTokens: 1 }); s.step(); s.end(a, { peakMB: 3000 }); s.step();
  const r = initialState({ capacity: 8, defaultTokenMB: 1000, starvationS: 300 });
  for (const e of s.log) apply(r, JSON.parse(JSON.stringify(e)));
  const view = (st) => JSON.stringify([[...st.jobs.values()].map((j) => [j.id, j.state, j.granted, j.reservedMB]), st.limit, [...st.memory]]);
  check('I8 + I9: replaying a log with capacity events rebuilds the same state and budgets', view(r) === view(s.st), `${view(r)} vs ${view(s.st)}`);
  check('I8 + I9: ...and the same next decision', JSON.stringify(schedule(r, s.now())) === JSON.stringify(schedule(s.st, s.now())));
  check('I9: JSON turns an unlimited memory budget into null, and replay reads it back as unlimited', (() => { const t = initialState({ capacity: 2 }); apply(t, JSON.parse(JSON.stringify({ seq: 1, at: 0, type: 'capacity', cpu: 2, memMB: Infinity }))); return t.limit.memMB === Infinity; })());
  void b;
}

// ── Part 4: a live broker fed samples from a file ─────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-adaptive-test-'));
const sampleFile = path.join(tmp, 'sample.json');
const writeSample = (o) => fs.writeFileSync(sampleFile, JSON.stringify({ cores: 8, load1: 0, totalMB: 65536, availMB: 40000, pressure: 'normal', swapMBps: 0, ...o }));
writeSample({});
const cfg = path.join(tmp, 'tracegate.config.json');
fs.writeFileSync(cfg, JSON.stringify({ broker: { adaptive: { mode: 'on', sampleSeconds: 1, upHoldS: 1, starvationS: 2, headroomMB: 1000, defaultTokenMB: 500 } } }));
const env = { ...process.env, TRACEGATE_CONFIG: cfg, TRACEGATE_BROKER_DIR: path.join(tmp, 'broker'), TRACEGATE_BROKER_SOCKET: path.join(tmp, 's.sock'),
  TRACEGATE_BROKER_CAPACITY: '8', TRACEGATE_BROKER_SAMPLE_FILE: sampleFile };
delete env.TRACEGATE_LEASE; delete env.TRACEGATE_BROKER_ADAPTIVE; delete env.TRACEGATE_CONTENDED;
const started = new Set();
const stopAll = () => { for (const p of started) { try { p.kill('SIGKILL'); } catch { /* gone */ } } };
process.on('exit', stopAll);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { stopAll(); process.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const broker = spawn(process.execPath, [CLI, 'broker', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
started.add(broker);
let out = ''; broker.stdout.on('data', (d) => { out += d; }); broker.stderr.on('data', (d) => { out += d; });
for (let i = 0; i < 50 && !fs.existsSync(env.TRACEGATE_BROKER_SOCKET); i++) await sleep(100);
const events = () => fs.readFileSync(path.join(env.TRACEGATE_BROKER_DIR, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const leaseSync = (args, js) => spawnSync(process.execPath, [CLI, 'lease', '--quiet', ...args, '--', process.execPath, '-e', js], { env, encoding: 'utf8', timeout: 30000 });
const SHOW = 'console.log([process.env.TRACEGATE_TOKENS, process.env.TRACEGATE_CONTENDED ?? "-"].join(","))';
try {
  const r1 = leaseSync(['--tokens', '8', '--min-tokens', '1'], SHOW);
  check('live: a quiet machine grants the full 8 tokens', r1.stdout.trim() === '8,-', r1.stdout + r1.stderr);

  writeSample({ load1: 6 }); await sleep(2500);
  const r2 = leaseSync(['--tokens', '8', '--min-tokens', '1'], SHOW);
  check('live: load that is not ours (6 of 8 cores) → the same request is granted 2 workers', r2.stdout.trim() === '2,-', r2.stdout + r2.stderr);
  check('live: the change is a logged capacity event with its reason', events().some((e) => e.type === 'capacity' && e.cpu === 2 && /not ours/.test(e.why.join())));

  const st = JSON.parse(spawnSync(process.execPath, [CLI, 'machine', '--json'], { env, encoding: 'utf8' }).stdout);
  check('live: `tracegate machine` reports the hardware, the sample and the budget', st.hw?.cores > 0 && st.sample?.load1 === 6 && st.limit?.cpu === 2 && st.mode === 'on', JSON.stringify(st).slice(0, 300));

  writeSample({}); await sleep(3500);
  // A job that holds ~200 MB for a few seconds: its tree's peak is measured.
  const r3 = leaseSync(['--tokens', '2', '--label', 'mem-hog'], 'const b=Buffer.alloc(200*1024*1024,1); setTimeout(()=>console.log(b.length>0?"held":""),3000)');
  await sleep(300);
  const rel = events().filter((e) => e.type === 'release' && Number.isFinite(e.peakMB)).pop();
  check('live: the release records the peak memory of the job\'s process tree', r3.stdout.includes('held') && rel?.peakMB >= 150, `${JSON.stringify(rel)} ${r3.stderr}`);

  // Shedding: a daemon lease is stopped when pressure turns critical; a gate then waits, then runs contended.
  const d = spawn(process.execPath, [CLI, 'lease', '--quiet', '--class', 'daemon', '--', process.execPath, '-e', 'setInterval(()=>{},1000)'], { env, stdio: 'ignore' });
  started.add(d);
  await sleep(800);
  writeSample({ pressure: 'critical' });
  const dCode = await Promise.race([new Promise((r) => d.on('exit', r)), sleep(10000).then(() => 'timeout')]);
  check('live: critical memory pressure sheds the running daemon lease (exit 75)', dCode === 75, String(dCode));
  const t0 = Date.now();
  const r4 = leaseSync(['--class', 'gate', '--tokens', '4', '--min-tokens', '2'], SHOW);
  check('live: under critical pressure a gate waits, then runs CONTENDED after starvationS, as narrow as the cpu budget (1)', r4.stdout.trim() === '1,1' && Date.now() - t0 >= 1500, `${r4.stdout} ${r4.stderr} after ${Date.now() - t0} ms`);
} finally {
  broker.kill('SIGTERM'); await sleep(200);
}

// Shadow mode, live: the budget is computed and logged, never applied.
{
  const dir = path.join(tmp, 'shadow');
  fs.mkdirSync(dir);
  writeSample({ load1: 7 });
  const e2 = { ...env, TRACEGATE_BROKER_DIR: path.join(dir, 'broker'), TRACEGATE_BROKER_SOCKET: path.join(dir, 's.sock'), TRACEGATE_BROKER_ADAPTIVE: 'shadow' };
  const b = spawn(process.execPath, [CLI, 'broker', 'serve'], { env: e2, stdio: 'ignore' }); started.add(b);
  for (let i = 0; i < 50 && !fs.existsSync(e2.TRACEGATE_BROKER_SOCKET); i++) await sleep(100);
  await sleep(500);
  const r = spawnSync(process.execPath, [CLI, 'lease', '--quiet', '--tokens', '8', '--', process.execPath, '-e', SHOW], { env: e2, encoding: 'utf8', timeout: 15000 });
  const evs = fs.readFileSync(path.join(e2.TRACEGATE_BROKER_DIR, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('live shadow: the reduced budget is logged as not applied', evs.some((e) => e.type === 'capacity' && e.applied === false && e.cpu === 1));
  check('live shadow: ...and the lease still gets the full 8', r.stdout.trim() === '8,-', r.stdout + r.stderr);
  b.kill('SIGTERM'); await sleep(200);
}
// MCP: the machine_load tool.
{
  const dir = path.join(tmp, 'mcp'); fs.mkdirSync(dir); writeSample({});
  const e3 = { ...env, TRACEGATE_BROKER_DIR: path.join(dir, 'broker'), TRACEGATE_BROKER_SOCKET: path.join(dir, 's.sock') };
  const b = spawn(process.execPath, [CLI, 'broker', 'serve'], { env: e3, stdio: 'ignore' }); started.add(b);
  for (let i = 0; i < 50 && !fs.existsSync(e3.TRACEGATE_BROKER_SOCKET); i++) await sleep(100);
  const mcp = spawn(process.execPath, [CLI, 'mcp'], { env: e3, stdio: ['pipe', 'pipe', 'ignore'] }); started.add(mcp);
  let buf = ''; const answers = [];
  mcp.stdout.on('data', (x) => { buf += x; let i; while ((i = buf.indexOf('\n')) >= 0) { answers.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const rpc = (id, method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  rpc(2, 'tools/list', {}); rpc(3, 'tools/call', { name: 'machine_load', arguments: {} });
  for (let i = 0; i < 50 && answers.length < 3; i++) await sleep(100);
  const by = (id) => answers.find((a) => a.id === id);
  check('MCP: machine_load is listed as a read-only tool', by(2)?.result?.tools?.some((t) => t.name === 'machine_load' && t.annotations?.readOnlyHint));
  const ml = JSON.parse(by(3)?.result?.content?.[0]?.text ?? '{}');
  check('MCP: machine_load returns the hardware, the budgets and the policy defaults for this host', ml.hw?.totalMB > 0 && ml.limit?.cpu === 8 && ml.policy?.defaultTokenMB === 500, JSON.stringify(ml).slice(0, 300));
  mcp.stdin.end(); b.kill('SIGTERM'); await sleep(200);
}
// The broker's state is per host by default (a ledger can be shared by machines).
{
  const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.env.TRACEGATE_LEDGER = ${JSON.stringify(path.join(tmp, 'ledger'))};
    delete process.env.TRACEGATE_BROKER_DIR; process.env.TRACEGATE_HOST = 'mac-a';
    const { brokerDir } = await import(${JSON.stringify(path.join(PKG, 'src/broker/paths.mjs'))});
    console.log(brokerDir());`], { encoding: 'utf8', cwd: repo, env: { ...process.env, TRACEGATE_BROKER_DIR: '' } });
  check('the broker directory is per host: <ledger>/broker/<host>', r.stdout.trim().endsWith(path.join('ledger', 'broker', 'mac-a')), r.stdout + r.stderr);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== adaptive tests: ${fail} FAILED, ${pass} passed ==` : `\n== adaptive tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
