#!/usr/bin/env node
// Tracegate CLI. See README.md "Usage".
import { lane } from './config.mjs';
import { effectiveMode, fullDone, ingest, modeDecision, report, select, status, triage } from './predictor.mjs';
import { replay } from './replay.mjs';
import { runLane } from './run.mjs';
import { sync } from './sync.mjs';

const USAGE = `usage: tracegate <command> [options]

  run     --lane <l> [--mode m] [--run <dir>] [--audit r] -- <vitest args>
                                       select → vitest (recorded) → report → ingest
  mode    --lane <l>                   print the effective mode (off|shadow|enforce)
  select  --lane <l> --run <dir> [--mode m] [--audit r]
                                       write <dir>/selected.txt and <dir>/predict.json
  report  --lane <l> --run <dir>       prediction vs <dir>/results.json; log misses
  ingest  --lane <l> --run <dir> [--expect-head <sha>] [--budget-s n]
                                       record footprints of green files
  triage  --lane <l> --file <path> --verdict flake|hole [--head <sha12>]
  replay  --lane <l> --head <commit> --at <iso> [--drop <regex>] [--ignore-lock] [--node <v>] [--out <json>]
  full-done --lane <l>                 record a complete, green whole-lane run
  status                               ledger, entry bar and mode per lane
  sync    [--remote <[user@]host:/abs/ledger>]

Broker (one queue for the machine's CI work; see docs/design/broker.md):
  lease   [--class c] [--tokens n] [--min-tokens m] [--mem-per-token MB] [--exclusive]
          [--est seconds] [--label l] [--deadline-min m] [--requeue] [--quiet] -- <command…>
                                       run a command when the broker grants capacity;
                                       --min-tokens makes it elastic (granted m..n workers)
  machine [--json]                     this host's hardware, the latest load/memory sample,
                                       and the cpu/memory budgets the broker hands out now
  queue   [--json]                     running leases, the queue and the reservation
  explain <job id>                     why a job waits, and when it is reserved to start
  history [--n 50]                     recent broker events
  broker  serve | stop                 run the broker in the foreground / stop it
  mcp     [--allow-write]              Model Context Protocol server (stdio) for agents

--lane may be omitted when the config has exactly one lane.`;

function parse(argv) {
  const o = {}; const rest = [];
  const dd = argv.indexOf('--');
  const a = dd < 0 ? argv : argv.slice(0, dd);
  if (dd >= 0) rest.push(...argv.slice(dd + 1));
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const eq = a[i].indexOf('=');
    if (eq > 0) { o[a[i].slice(2, eq)] = a[i].slice(eq + 1); continue; }
    o[a[i].slice(2)] = a[i + 1]?.startsWith('--') || a[i + 1] === undefined ? true : a[++i];
  }
  return { o, rest };
}

function printQueue(s, json) {
  if (json) { delete s.ref; delete s.type; console.log(JSON.stringify(s, null, 2)); return; }
  const row = (j) => `  ${j.id.padEnd(6)} ${j.class.padEnd(8)} ${String(j.tokens).padStart(3)}${j.minTokens ? `(≥${j.minTokens})` : ''}${j.exclusive ? ' excl' : '     '}${j.memMB ? ` ${j.memMB}MB` : ''}${j.contended ? ' CONTENDED' : ''}  ${j.label}`;
  const lim = s.limit ?? { cpu: s.capacity };
  console.log(`capacity ${lim.cpu} of ${s.capacity} token(s)${lim.memMB !== null && lim.memMB !== undefined ? `, memory budget ${lim.memMB} MB` : ''}, in use ${s.used}${s.usedMB ? ` (${s.usedMB} MB reserved)` : ''} (broker pid ${s.pid})`);
  if (lim.why?.length && (lim.cpu < s.capacity || lim.pressure)) console.log(`  reduced: ${lim.why.join('; ')}`);
  if (s.shadowLimit) console.log(`  adaptive (shadow) would allow ${s.shadowLimit.cpu} token(s)${s.shadowLimit.memMB !== null ? `, ${s.shadowLimit.memMB} MB` : ''}: ${s.shadowLimit.why.join('; ')}`);
  console.log(`running (${s.running.length}):`); for (const j of s.running) console.log(`${row(j)}  fence ${j.fence}${j.nested ? ` in ${j.parent}` : ''}`);
  console.log(`queued (${s.queued.length}):`); for (const j of s.queued) console.log(row(j));
  if (s.reservation) console.log(`reservation: ${s.reservation.id} starts ${s.reservation.at ?? 'when a job without an estimate ends'}`);
}

function printMachine(m, json) {
  delete m.ref; delete m.type;
  if (json) { console.log(JSON.stringify(m, null, 2)); return; }
  const h = m.hw; const x = m.sample;
  console.log(`${m.host}: ${h.cores} cores${h.perfCores ? ` (${h.perfCores} performance)` : ''}, ${h.totalMB} MB, ${h.platform}/${h.arch}${h.cgroup ? `, container limits ${JSON.stringify(h.cgroup)}` : ''}`);
  if (x) console.log(`now: load ${x.load1?.toFixed?.(2) ?? '?'}, ${x.availMB ?? '?'} MB available, pressure ${x.pressure ?? 'unknown'}${Number.isFinite(x.swapMBps) ? `, swap-in ${x.swapMBps.toFixed(1)} MB/s` : ''}${Number.isFinite(x.cpuSpeedLimit) ? `, CPU limit ${x.cpuSpeedLimit}%` : ''}${x.errors?.length ? ` (unread: ${x.errors.join(', ')})` : ''}`);
  console.log(`adaptive ${m.mode}: ${m.limit.cpu} token(s)${m.limit.memMB !== null ? `, ${m.limit.memMB} MB` : ''}${m.limit.why?.length ? ` — ${m.limit.why.join('; ')}` : ''}`);
  console.log(`defaults here: ${m.policy.defaultTokenMB} MB per token, ${m.policy.headroomMB} MB kept free`);
  for (const l of m.leases) console.log(`  ${l.id}: pid ${l.pid}, ${l.currentMB ?? '?'} MB now, peak ${l.peakMB} MB, reserved ${l.reservedMB} MB`);
}

const cmd = process.argv[2];
const { o, rest } = parse(process.argv.slice(3));
try {
  if (cmd === 'mode') { const d = modeDecision(lane(o.lane).name); console.log(effectiveMode(lane(o.lane).name)); if (o.why) console.error(d.why); }
  else if (cmd === 'select') select(o);
  else if (cmd === 'ingest') ingest(o);
  else if (cmd === 'report') report(o);
  else if (cmd === 'status') status();
  else if (cmd === 'sync') sync(o);
  else if (cmd === 'triage') triage(o);
  else if (cmd === 'full-done') fullDone(o);
  else if (cmd === 'replay') replay(o);
  else if (cmd === 'run') process.exitCode = runLane(o, rest);
  else if (cmd === 'lease') process.exitCode = await (await import('./broker/client.mjs')).lease(o, rest);
  else if (cmd === 'machine') printMachine(await (await import('./broker/client.mjs')).call({ op: 'machine' }), o.json);
  else if (cmd === 'queue') printQueue(await (await import('./broker/client.mjs')).call({ op: 'status' }), o.json);
  else if (cmd === 'explain') {
    const id = process.argv[3];
    if (!id || id.startsWith('--')) throw new Error('explain: give a job id, e.g. `tracegate explain j42`');
    console.log((await (await import('./broker/client.mjs')).call({ op: 'explain', id })).text);
  } else if (cmd === 'history') {
    for (const e of (await (await import('./broker/client.mjs')).call({ op: 'history', n: Number(o.n ?? 50) })).events) console.log(JSON.stringify(e));
  } else if (cmd === 'broker' && process.argv[3] === 'serve') await (await import('./broker/server.mjs')).serve();
  else if (cmd === 'broker' && process.argv[3] === 'stop') {
    const s = await (await import('./broker/client.mjs')).call({ op: 'status' }, { autostart: false }).catch(() => null);
    if (!s) console.log('tracegate broker: not running');
    else { process.kill(s.pid, 'SIGTERM'); console.log(`tracegate broker: stopped pid ${s.pid}`); }
  } else if (cmd === 'mcp') await (await import('./mcp.mjs')).mcp(o);
  else { console.error(USAGE); process.exit(cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2); }
} catch (e) {
  console.error(`tracegate ${cmd}: ${e.message}`);
  process.exit(2);
}
