#!/usr/bin/env node
// Sabotage witnesses: break one rule at a time and check the self-test goes RED.
//
// A test that stays green when the rule it guards is broken guards nothing. For
// each entry below, this copies the package to a temp dir, applies ONE textual
// mutation to src/, runs test/selftest.mjs there and expects (a) a non-zero exit
// and (b) the named check among the failures. The working tree is never touched.
//
//   node test/sabotage.mjs            all witnesses
//   node test/sabotage.mjs <id> ...   only these
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// [id, file, exact text to replace, replacement, a check that must go red]
// The text/replacement may be arrays, for a rule implemented at more than one site.
const WITNESSES = [
  ['column-narrowing', 'src/predictor.mjs',
    'r0 = p; r1 = o.length - q; a0 = p; a1 = n.length - q;', 'r0 = 0; r1 = o.length; a0 = 0; a1 = n.length;',
    'SKIP callback body only, on that shared line'],
  ['every-owner-of-a-line', 'src/model.mjs',
    'owner.fill(id(key), n.getStart(sf), n.getEnd());', 'owner.fill(id(key), n.getStart(sf), n.getStart(sf) + 1);',
    'SKIP body of a function the test never ran'],
  ['local-ctor-is-not-pure', 'src/model.mjs',
    'return !localBindings(sf).has(init.expression.text);', 'return true;',
    'RUN  a Set built by a LOCALLY bound constructor'],
  ['constants-are-inputs', 'src/predictor.mjs',
    "if (consts.has(`${p}::${k.slice(7, -1)}`)) return `constant ${k.slice(7, -1)} in ${p}`; continue;", 'continue;',
    'RUN  constant an executed function reads'],
  ['top-level-is-an-input', 'src/predictor.mjs',
    "if (k === '<top>') return `top-level change in ${p}`;", "if (k === '<top>') continue;",
    'RUN  top-level statement of a loaded module'],
  ['read-inputs', 'src/predictor.mjs',
    'for (const r of reads) if (r === p || p.startsWith(r + \'/\')) return `read input ${p}`;', '',
    'RUN  a repo file the test read'],
  ['globals', 'src/predictor.mjs',
    'if (ln.global.test(p) && !isTestFile(p)) return `global input ${p}`;', '',
    'RUN  a setup file (lane global from the config)'],
  ['test-file-is-not-global', 'src/predictor.mjs',
    'if (ln.global.test(p) && !isTestFile(p))', 'if (ln.global.test(p))',
    'SKIP a test file that lives in the setup directory'],
  ['lockfile', 'src/predictor.mjs',
    "if (fp.lock !== lock && !REPLAY.ignoreLock) return 'lockfile changed';", '',
    'replay reproduces decide() at the same head and clock'],
  ['node-version', 'src/predictor.mjs',
    'if (fp.node !== nodeVersion) return `node ${fp.node} → ${nodeVersion}`;', '',
    'RUN  different node version'],
  ['max-age', 'src/predictor.mjs',
    'if (!(ageH <= maxAge)) return', 'if (false) return',
    'RUN  a footprint older than 72 h, even on an unchanged tree'],
  ['fp-version', 'src/predictor.mjs',
    "if (fp.v !== FP_VERSION) return 'footprint format changed';", '',
    'RUN  a footprint of another format version'],
  ['ingest-refuses-dirty', 'src/predictor.mjs',
    "if (dirty) { console.log", "if (false) { console.log",
    'ingest refuses a dirty working tree (records nothing)'],
  ['ingest-refuses-moved', 'src/predictor.mjs',
    "o['expect-head'] !== H)", "o['expect-head'] === '')",
    'ingest refuses a tree that moved during the run (--expect-head)'],
  ['ingest-drops-red', 'src/predictor.mjs',
    "if (verdict.status !== 'passed') { dropFps(ln.name, raw.testFile); dropped++; continue; }", '',
    'ingest drops every footprint of a file that FAILED'],
  // Both sites drop a missed footprint (the second is belt and braces), so
  // the property only breaks when both go.
  ['miss-drops-footprint', 'src/predictor.mjs',
    ["for (const [f, r] of results) if (r.status === 'failed') dropFps(ln.name, f);", 'for (const m of misses) dropFps(ln.name, m);'], ['', ''],
    '...and the footprint that lied is dropped'],
  ['report-drops-red', 'src/predictor.mjs',
    "for (const [f, r] of results) if (r.status === 'failed') dropFps(ln.name, f);", '',
    'report drops the footprints of a failed file that was predicted to run (not a miss)'],
  ['audit-is-random', 'src/predictor.mjs',
    "if (mode === 'enforce' && Math.random() < auditRate)", "if (mode === 'enforce' && auditRate > 0)",
    'enforce + audit 0.5: about half of 100 selections audit the file (25..75)'],
  ['miss-suspends', 'src/predictor.mjs',
    'const ok = spanDays >= bar.days && obs.length >= bar.observations && !recentMiss;', 'const ok = spanDays >= bar.days && obs.length >= bar.observations;',
    '...but a recent un-triaged MISS suspends a lane that otherwise meets the bar'],
  ['miss-suspension-window', 'src/predictor.mjs',
    'now - Date.parse(m.at) < c.missSuspendDays * day', 'true',
    '...and a miss older than the suspension window no longer does'],
  ['only-flake-lifts', 'src/predictor.mjs',
    "readTsv('triage-').filter((t) => t.verdict === 'flake')", "readTsv('triage-')",
    'a miss triaged as a HOLE still suspends enforcement'],
  ['early-entry-floor', 'src/predictor.mjs',
    'const ok = spanDays >= bar.days &&', 'const ok =',
    'web does NOT enter on 20 observations inside 12 hours (the 1-day floor)'],
  ['early-audit-rate', 'src/predictor.mjs',
    'bar.earlyAudit !== undefined ? bar.earlyAudit : c.audit', 'false ? bar.earlyAudit : c.audit',
    '...auditing 20% until the default 14-day bar would have been met'],
  ['full-run-backstop', 'src/predictor.mjs',
    'if (h >= maxH) {', 'if (false) {',
    'backstop: no full run ever recorded → FULL'],
  ['ingest-budget', 'src/predictor.mjs',
    'if (Date.now() - t0 > budgetMs) { overBudget++; continue; }', '',
    'ingest past its time budget records nothing (no partial footprint)'],
  // Broker rules (test/broker.mjs; the optional 6th field names the test script).
  ['broker-nested-grant', 'src/broker/core.mjs',
    "if (parent && parent.state === 'running') {", 'if (false) {',
    'F2: a request from inside a running lease is granted at once (no self-deadlock)', 'broker.mjs'],
  ['broker-preempt-only-preemptible', 'src/broker/core.mjs',
    '.filter((r) => r.preemptible && r.priority <= j.priority - PREEMPT_GAP)', '.filter((r) => r.priority <= j.priority - PREEMPT_GAP)',
    'I6: a running gate is never preempted, even for a deploy', 'broker.mjs'],
  ['broker-preempt-gap', 'src/broker/core.mjs',
    '.filter((r) => r.preemptible && r.priority <= j.priority - PREEMPT_GAP)', '.filter((r) => r.preemptible && r.priority < j.priority)',
    'I6: no preemption across a priority gap below', 'broker.mjs'],
  ['broker-easy-backfill', 'src/broker/core.mjs',
    'const allowedByReservation = !res || j.preemptible ||', 'const allowedByReservation = true ||',
    'F3: a later gate that would overrun the reservation does not jump ahead', 'broker.mjs'],
  ['broker-fence-increases', 'src/broker/core.mjs',
    'st.fence = Math.max(st.fence + 1, ev.fence ?? 0);', 'st.fence = ev.fence ?? 1;',
    'I7: fence tokens strictly increase across grants', 'broker.mjs'],
  ['broker-liveness-is-the-connection', 'src/broker/server.mjs',
    "s.on('close', gone); s.on('error', gone);", '',
    'I3: SIGKILL of the holder frees its lease', 'broker.mjs'],
  ['broker-advisor-permutation-only', 'src/broker/server.mjs',
    "const valid = order && order.length === ids.size && new Set(order).size === ids.size && order.every((id) => ids.has(id));", 'const valid = !!order;',
    'advisor: an answer that adds a job is rejected and logged', 'broker.mjs'],
  ['broker-advisor-shadow', 'src/broker/server.mjs',
    "const applied = a.mode === 'enforce';", 'const applied = true;',
    'advisor (shadow): ...and not applied', 'broker.mjs'],
  ['broker-deadline', 'src/broker/core.mjs',
    'if (j.deadline !== null && now >= j.deadline) { out.expires.push(j.id); continue; }', '',
    'a queued job past its deadline expires with a logged event', 'broker.mjs'],
  // Adaptive capacity rules (test/adaptive.mjs, Phase 0.6).
  ['adaptive-cpu-budget', 'src/broker/core.mjs',
    'export const cpuCap = (st) => Math.max(1, Math.min(st.capacity, st.limit.cpu));', 'export const cpuCap = (st) => st.capacity;',
    'I9: a request is clamped to the cpu budget', 'adaptive.mjs'],
  ['adaptive-memory-fit', 'src/broker/core.mjs',
    'if (perTok > 0) t = Math.min(t, Math.floor((memCap - usedMB) / perTok));', '',
    'I9 memory: a job that needs more memory than is left waits', 'adaptive.mjs'],
  ['adaptive-critical-starts-nothing', 'src/broker/core.mjs',
    "if (st.limit.pressure === 'critical') return 0; // nothing new starts while memory is critical", '',
    'live: under critical pressure a gate waits', 'adaptive.mjs'],
  ['adaptive-shed-preemptible-only', 'src/broker/core.mjs',
    'const cand = running.filter((r) => r.preemptible).sort(', 'const cand = running.filter((r) => true).sort(',
    'I9 shedding: a gate alone over a reduced budget keeps running', 'adaptive.mjs'],
  ['adaptive-starvation-needs-idle', 'src/broker/core.mjs',
    'if (!res && !ourWorkRunning && !out.grants.length', 'if (!res && !out.grants.length',
    'I9 starvation: not while our own work runs', 'adaptive.mjs'],
  ['adaptive-starvation-waits', 'src/broker/core.mjs',
    '&& now - j.enqueuedAt >= st.starvationS * 1000', '',
    'I9 starvation: still waiting just before starvationS', 'adaptive.mjs'],
  ['adaptive-shadow-not-applied', 'src/broker/core.mjs',
    'if (ev.applied === false) st.shadowLimit = lim; else {', 'if (false) st.shadowLimit = lim; else {',
    'I9 shadow: a shadow capacity event changes no grant', 'adaptive.mjs'],
  ['adaptive-learned-memory', 'src/broker/core.mjs',
    'm.push(ev.peakMB / j.granted);', '',
    'I9 learning: memory per token is the p90', 'adaptive.mjs'],
  ['adaptive-hold-before-rise', 'src/broker/adapt.mjs',
    'if (now - upSince < policy.upHoldS * 1000) {', 'if (false) {',
    'hysteresis: a higher budget is held back at first', 'adaptive.mjs'],
  ['adaptive-ours-not-external', 'src/broker/adapt.mjs',
    'const external = Math.max(0, busy - (ours.usedTokens ?? 0));', 'const external = busy;',
    'cpu: our own granted work is not counted against us', 'adaptive.mjs'],
  ['adaptive-busy-over-load', 'src/broker/adapt.mjs',
    'const busy = Number.isFinite(s.busyCores) ? s.busyCores : Number.isFinite(s.load1) ? s.load1 : null;', 'const busy = Number.isFinite(s.load1) ? s.load1 : null;',
    'cpu: measured busy cores win over the load average', 'adaptive.mjs'],
  ['adaptive-memory-window-min', 'src/broker/adapt.mjs',
    'const avail = Math.min(...window.map((w) => w.mb));', 'const avail = window[window.length - 1].mb;',
    'memory: available is the MINIMUM over the window', 'adaptive.mjs'],
  ['adaptive-page-size', 'src/broker/sampler.mjs',
    "const pageBytes = Number(/page size of (\\d+) bytes/.exec(text)?.[1]) || 4096;", 'const pageBytes = 16384;',
    'vm_stat: the page size is read', 'adaptive.mjs'],
  ['adaptive-derived-defaults', 'src/broker/adapt.mjs',
    'defaultTokenMB: Number.isFinite(policy.defaultTokenMB) ? policy.defaultTokenMB : clamp(Math.round(totalMB / cores / 2), 256, 2048),', 'defaultTokenMB: 1024,',
    'defaults: an 8 GB, 8-core laptop', 'adaptive.mjs'],
  // Red Reader rules (test/red.mjs, Phase 1).
  ['red-unknown-field', 'src/red.mjs',
    "for (const k of Object.keys(o)) if (!known.has(k)) errors.push(`unknown field ${k}`);", '',
    'opinion: an unknown field is refused', 'red.mjs'],
  ['red-verdict-enum', 'src/red.mjs',
    "if (!VERDICTS.includes(o.verdict)) errors.push", "if (false) errors.push",
    'opinion: an unknown verdict is refused', 'red.mjs'],
  ['red-files-must-have-failed', 'src/red.mjs',
    "if (packet && o.files) for (const f of o.files)", "if (false) for (const f of o.files)",
    'opinion: a file that did not fail in the packet is refused', 'red.mjs'],
  ['red-id-is-a-name', 'src/red.mjs',
    "if (!/^[A-Za-z0-9_.-]+$/.test(String(id)))", "if (false)",
    'packet: read back by id; a path in the id is refused', 'red.mjs'],
  ['red-write-tool-gated', 'src/mcp.mjs',
    "const tools = [...READ_TOOLS, ...(o['allow-write'] ? WRITE_TOOLS : [])];", 'const tools = [...READ_TOOLS, ...WRITE_TOOLS];',
    'MCP: red_runs and read_red are read tools', 'red.mjs'],
  ['red-escalated-first', 'src/red.mjs',
    ".sort((a, b) => Number(!!b.opinion?.escalate) - Number(!!a.opinion?.escalate));", ';',
    'list: an escalated packet sorts above a newer one', 'red.mjs'],
  ['red-strip-colour', 'src/red.mjs',
    "const plain = (s) => String(s ?? '').replace(/\\x1b\\[[0-9;]*m/g, '');", "const plain = (s) => String(s ?? '');",
    'packet: failure text, with terminal colour codes removed', 'red.mjs'],
  // Observe mode (I10, Phase 0.5b; test/broker.mjs).
  ['observe-never-waits', 'src/broker/core.mjs',
    'if (j.observe) {', 'if (false) {',
    'I10: an observed job is granted at once, even with no room', 'broker.mjs'],
  ['observe-tokens-count', 'src/broker/core.mjs',
    "observed: true, wouldWait: !(width > 0 && allowedByReservation) });\n      used += t;", "observed: true, wouldWait: !(width > 0 && allowedByReservation) });\n      used += 0;",
    'I10: its tokens count, so ordinary work still sees the real load', 'broker.mjs'],
];

// A broken rule can make a check wait forever, and a test blocked in spawnSync
// cannot run its own signal handlers. So each witness runs in its own process
// group, which is SIGKILLed as a whole on timeout, and afterwards every process
// still naming this witness's temp dir is killed BY PID. That catches brokers the
// client started detached, outside the group. (MEASURED: removing the
// liveness rule left a witness, its broker and a lease waiting for 4 h.)
const TIMEOUT_MS = 300_000;
function killLeftovers(dir) {
  let out = '';
  try { out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }); } catch { return; }
  const real = fs.realpathSync(dir);
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) !== process.pid && (m[2].includes(dir) || m[2].includes(real))) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch { /* gone */ } }
  }
}
function runWitness(dir, script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'test', script)], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TRACEGATE_SELFTEST_VERBOSE: '' } });
    let stdout = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { stdout += d; }); child.stderr.resume();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, TIMEOUT_MS);
    child.on('close', (status) => {
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
      killLeftovers(dir);
      resolve({ status: timedOut ? 124 : status, stdout: timedOut ? `${stdout}\n  ✗ (witness timed out after ${TIMEOUT_MS / 1000} s and was killed)` : stdout });
    });
  });
}

const only = process.argv.slice(2);
const todo = only.length ? WITNESSES.filter((w) => only.includes(w[0])) : WITNESSES;
let bad = 0;
for (const [id, file, from, to, mustFail, script = 'selftest.mjs'] of todo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tracegate-sabotage-${id}-`));
  fs.cpSync(path.join(PKG, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.cpSync(path.join(PKG, 'test'), path.join(dir, 'test'), { recursive: true });
  fs.copyFileSync(path.join(PKG, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(PKG, 'node_modules'), path.join(dir, 'node_modules'));
  const f = path.join(dir, file);
  let text = fs.readFileSync(f, 'utf8');
  const froms = [from].flat(), tos = [to].flat();
  const counts = froms.map((x) => text.split(x).length - 1);
  if (counts.some((n) => n !== 1)) { console.log(`  ✗ ${id}: a mutation anchor occurs ${JSON.stringify(counts)} times in ${file} (expected 1 each) — update the witness`); bad++; fs.rmSync(dir, { recursive: true, force: true }); continue; }
  froms.forEach((x, i) => { text = text.replace(x, () => tos[i]); });
  fs.writeFileSync(f, text);
  const r = await runWitness(dir, script);
  const failed = (r.stdout ?? '').split('\n').filter((l) => l.trimStart().startsWith('✗')).map((l) => l.trim().slice(2));
  const hit = failed.some((l) => l.startsWith(mustFail));
  const ok = r.status !== 0 && hit;
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${id.padEnd(24)} ${ok ? `red (${failed.length} check(s) failed, incl. "${mustFail}")` : `NOT witnessed: exit ${r.status}, failed: ${JSON.stringify(failed)}`}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(bad ? `\n== sabotage: ${bad} of ${todo.length} rules NOT witnessed ==` : `\n== sabotage: ${todo.length} of ${todo.length} rules witnessed red ==`);
process.exit(bad ? 1 : 0);
