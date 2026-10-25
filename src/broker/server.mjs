// The broker process: owns the clock, the unix socket and the event log, and
// drives the pure scheduler in core.mjs.
//
// Liveness (I3): a lease lives exactly as long as the connection that asked for
// it. The kernel closes a socket when its process dies, SIGKILL included, so no
// stale-lock cleanup exists that could race (the classic mkdir-lock failure).
//
// Persistence (I8): every state change is an event appended to
// <ledger>/broker/events.jsonl BEFORE it is acted on. On start the log is
// replayed; jobs a previous broker left queued or running are closed with
// reason `broker-restart` (their connections died with it).
//
// Adaptive capacity (I9): every `sampleSeconds` it reads the machine (sampler.mjs)
// and the memory of each lease's process tree, asks adapt.mjs for the budgets,
// and logs a `capacity` event when they change. Each release records the peak
// memory of the job's tree, which is what the next run of that job reserves.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { adapt, changed, deriveDefaults } from './adapt.mjs';
import { apply, explain, initialState, queueOf, runningOf, schedule, snapshot } from './core.mjs';
import { brokerConfig, brokerDir, socketPath } from './paths.mjs';
import { hardware, sample } from './sampler.mjs';

const ADVISOR_TIMEOUT_MS = 10_000;

export async function serve({ quiet = false } = {}) {
  const cfg = brokerConfig();
  const dir = brokerDir();
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'events.jsonl');
  const sock = socketPath();
  const log = (...a) => { if (!quiet) console.log(new Date().toISOString(), ...a); };

  // Every memory default is a share of THIS machine (the config is shared by all).
  const hw = await hardware();
  const policy = deriveDefaults(cfg.adaptive, hw);

  // ── replay ────────────────────────────────────────────────────────────────
  const st = initialState({ capacity: cfg.capacity, classes: cfg.classes, defaultTokenMB: policy.defaultTokenMB, starvationS: policy.starvationS });
  if (fs.existsSync(logFile)) {
    for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { apply(st, JSON.parse(line)); } catch { /* a torn last line is skipped */ }
    }
  }
  const emit = (ev) => {
    const e = { seq: st.seq + 1, at: Date.now(), ...ev };
    fs.appendFileSync(logFile, JSON.stringify(e) + '\n');
    apply(st, e);
    return e;
  };
  for (const j of [...st.jobs.values()]) emit({ type: j.state === 'running' ? 'release' : 'cancel', id: j.id, reason: 'broker-restart' });
  if (st.capacity !== cfg.capacity) st.capacity = cfg.capacity; // config wins over the log
  // A limit from a previous broker's last sample is stale: start from the full
  // capacity, logged, so a replay of this log sees the same reset (I8).
  emit({ type: 'capacity', cpu: st.capacity, memMB: null, pressure: null, why: ['broker start'], applied: true,
    host: cfg.host, hw: { cores: hw.cores, perfCores: hw.perfCores, totalMB: hw.totalMB, arch: hw.arch, platform: hw.platform, cgroup: hw.cgroup } });

  // ── connections ───────────────────────────────────────────────────────────
  const conns = new Map(); // socket → { owner, jobs: Set<id> }
  const ownerOf = new Map(); // job id → socket
  const trees = new Map(); // job id → { pid, currentMB, peakMB }: its holder's process tree
  const send = (s, msg) => { try { s.write(JSON.stringify(msg) + '\n'); } catch { /* closed */ } };

  const endJob = (id, type, reason) => {
    const j = st.jobs.get(id);
    if (!j) return;
    // Children first: their authority came from this job.
    for (const c of [...st.jobs.values()]) if (c.parent === id) endJob(c.id, c.state === 'running' ? 'release' : 'cancel', 'parent-ended');
    const peak = trees.get(id)?.peakMB;
    emit({ type, id, reason, ...(type === 'release' && Number.isFinite(peak) && peak > 0 ? { peakMB: peak } : {}) });
    trees.delete(id);
    const s = ownerOf.get(id);
    if (s && reason !== 'done' && reason !== 'holder-exited') send(s, { type: 'ended', id, reason });
    ownerOf.delete(id);
    if (s) conns.get(s)?.jobs.delete(id);
  };

  let ticking = false;
  const tick = () => {
    if (ticking) return; ticking = true;
    try {
      for (let guard = 0; guard < 50; guard++) {
        const d = schedule(st, Date.now());
        if (!d.expires.length && !d.grants.length && !d.preempts.length) break;
        // endJob tells the holder (`ended`, reason `deadline`).
        for (const id of d.expires) endJob(id, 'expire', 'deadline');
        for (const g of d.grants) {
          // An observed job that would have waited: say behind whom, before the grant changes the picture.
          const would = g.observed && g.wouldWait ? explain(st, g.id, Date.now()) : null;
          const e = emit({ type: 'grant', id: g.id, tokens: g.tokens, nested: g.nested, ...(g.memMB ? { memMB: g.memMB } : {}), ...(g.contended ? { contended: true } : {}),
            ...(g.observed ? { observed: true, wouldWait: !!g.wouldWait, ...(would ? { behind: would.blockers, wouldWhy: would.text } : {}) } : {}) });
          const j = st.jobs.get(g.id);
          log(`grant ${g.id} ${j.class} ${j.label} tokens=${g.tokens}${g.memMB ? ` mem=${g.memMB}MB` : ''} fence=${j.fence}${g.nested ? ' (nested)' : ''}${g.contended ? ' CONTENDED' : ''}${g.observed ? (g.wouldWait ? ' OBSERVED (would have waited)' : ' observed') : ''}`);
          const s = ownerOf.get(g.id);
          if (s) {
            const pid = conns.get(s)?.pid;
            if (!g.nested && pid) trees.set(g.id, { pid, currentMB: null, peakMB: 0 });
            send(s, { type: 'granted', id: g.id, tokens: g.tokens, fence: j.fence, nested: g.nested, memMB: g.memMB ?? 0, contended: !!g.contended, at: e.at });
          }
        }
        for (const p of d.preempts) {
          emit({ type: 'preempt', id: p.id, by: p.by });
          log(`preempt ${p.id} for ${p.by}`);
          const s = ownerOf.get(p.id); if (s) send(s, { type: 'preempt', id: p.id, by: p.by });
        }
      }
    } finally { ticking = false; }
  };

  // ── advisor (models): may only permute a priority tier; shadow by default ──
  const adviceCacheDir = path.join(dir, 'advice-cache');
  const advise = (priority) => {
    const a = cfg.advisor;
    if (!a?.command) return;
    const tier = queueOf(st).filter((j) => j.priority === priority && !j.parent);
    if (tier.length < 2) return;
    const input = { tier: priority, jobs: tier.map((j) => ({ id: j.id, class: j.class, label: j.label, est: j.est, meta: j.meta ?? null })) };
    const key = crypto.createHash('sha256').update(JSON.stringify([a.command, a.version ?? '', input])).digest('hex');
    const cached = path.join(adviceCacheDir, `${key}.json`);
    const finish = (result, source) => {
      const ids = new Set(input.jobs.map((j) => j.id));
      const order = Array.isArray(result?.order) ? result.order : null;
      const valid = order && order.length === ids.size && new Set(order).size === ids.size && order.every((id) => ids.has(id));
      if (!valid) { emit({ type: 'advice', tier: priority, key, source, applied: false, rejected: 'not a permutation of the tier' }); return; }
      const applied = a.mode === 'enforce';
      emit({ type: 'advice', tier: priority, key, source, order, reasons: result.reasons ?? null, applied });
      if (applied) {
        // Re-use the tier's own rank values, so other tiers are unaffected.
        const ranks = tier.map((j) => j.rank).sort((x, y) => x - y);
        order.forEach((id, i) => { if (st.jobs.get(id)?.state === 'queued') emit({ type: 'rank', id, rank: ranks[i] }); });
        tick();
      }
    };
    if (fs.existsSync(cached)) { try { finish(JSON.parse(fs.readFileSync(cached, 'utf8')), 'cache'); return; } catch { /* re-ask */ } }
    const child = spawn(a.command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = ''; let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); emit({ type: 'advice', tier: priority, key, source: 'advisor', applied: false, rejected: 'timeout' }); } }, ADVISOR_TIMEOUT_MS);
    child.stdout.on('data', (b) => { out += b; });
    child.on('close', () => {
      if (done) return; done = true; clearTimeout(timer);
      let r = null; try { r = JSON.parse(out); } catch { /* invalid */ }
      if (r) { fs.mkdirSync(adviceCacheDir, { recursive: true }); fs.writeFileSync(cached, JSON.stringify(r)); }
      finish(r, 'advisor');
    });
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); emit({ type: 'advice', tier: priority, key, source: 'advisor', applied: false, rejected: 'advisor failed to start' }); } });
    child.stdin.end(JSON.stringify(input));
  };

  // ── adaptive capacity (I9) ────────────────────────────────────────────────
  let lastSample = null; let decision = null; let logged = null; let sampling = false;
  const resample = async () => {
    if (sampling) return; sampling = true;
    try {
      const smp = await sample([...new Set([...trees.values()].map((t) => t.pid))]);
      lastSample = smp;
      let growthMB = 0;
      for (const [id, t] of trees) {
        const mb = smp.trees?.[t.pid];
        if (Number.isFinite(mb)) { t.currentMB = mb; t.peakMB = Math.max(t.peakMB, mb); }
        const j = st.jobs.get(id);
        if (j) growthMB += Math.max(0, j.reservedMB - (Number.isFinite(mb) ? mb : 0));
      }
      const run = runningOf(st).filter((j) => !j.nested);
      // A lease whose holder sent no pid cannot be measured: count all of its reservation as still to come.
      for (const j of run) if (!trees.has(j.id)) growthMB += j.reservedMB;
      const ours = { usedTokens: run.reduce((a, j) => a + j.granted, 0), reservedMB: run.reduce((a, j) => a + j.reservedMB, 0), growthMB };
      if (policy.mode === 'off') return;
      decision = adapt(policy, smp, decision, ours, st.capacity, Date.now());
      if (changed(logged, decision, policy.memQuantumMB)) {
        const applied = policy.mode === 'on';
        emit({ type: 'capacity', cpu: decision.cpu, memMB: Number.isFinite(decision.memMB) ? Math.round(decision.memMB) : null, pressure: decision.pressure, why: decision.why, applied });
        logged = { cpu: decision.cpu, memMB: decision.memMB, pressure: decision.pressure };
        log(`capacity ${applied ? '' : '(shadow) '}cpu=${decision.cpu}/${st.capacity} mem=${Number.isFinite(decision.memMB) ? Math.round(decision.memMB) + 'MB' : '∞'}${decision.pressure ? ` pressure=${decision.pressure}` : ''}${decision.why.length ? ` — ${decision.why.join('; ')}` : ''}`);
        tick();
      }
    } catch (e) { log(`sample failed: ${e.message}`); } finally { sampling = false; }
  };

  const handle = (s, msg) => {
    const c = conns.get(s);
    const now = Date.now();
    switch (msg.op) {
      case 'hello':
        c.owner = String(msg.owner ?? c.owner);
        if (Number.isInteger(msg.pid) && msg.pid > 1) c.pid = msg.pid; // whose process tree to measure
        send(s, { type: 'hello', capacity: st.capacity, pid: process.pid }); break;
      case 'request': {
        const tokens = Number.isInteger(msg.tokens) && msg.tokens > 0 ? Math.min(msg.tokens, st.capacity) : 1;
        if (msg.class && !st.classes[msg.class]) { send(s, { type: 'error', ref: msg.ref, error: `unknown class ${msg.class}; known: ${Object.keys(st.classes).join(', ')}` }); break; }
        const parent = typeof msg.parent === 'string' && st.jobs.get(msg.parent)?.state === 'running' ? msg.parent : null;
        const id = `j${st.jobNo + 1}`;
        emit({ type: 'enqueue', id, owner: c.owner, class: msg.class ?? 'adhoc', label: String(msg.label ?? '').slice(0, 200), tokens,
          ...(Number.isInteger(msg.minTokens) && msg.minTokens > 0 && msg.minTokens < tokens ? { minTokens: msg.minTokens } : {}),
          ...(Number.isFinite(msg.memPerToken) && msg.memPerToken > 0 ? { memPerToken: msg.memPerToken } : {}),
          ...(msg.observe === true ? { observe: true, ...(msg.yield === true ? { yieldOthers: true } : {}) } : {}),
          exclusive: !!msg.exclusive, est: Number.isFinite(msg.est) && msg.est > 0 ? msg.est : null, parent,
          deadline: Number.isFinite(msg.deadline) ? msg.deadline : null });
        ownerOf.set(id, s); c.jobs.add(id);
        const j = st.jobs.get(id);
        log(`enqueue ${id} ${j.class} ${j.label} tokens=${tokens}${j.exclusive ? ' exclusive' : ''}${parent ? ` parent=${parent}` : ''}`);
        tick();
        if (st.jobs.get(id)?.state === 'queued') send(s, { type: 'queued', id, ref: msg.ref, explain: explain(st, id, Date.now()) });
        else if (st.jobs.get(id)) send(s, { type: 'accepted', id, ref: msg.ref });
        advise(j.priority);
        break;
      }
      case 'release': if (c.jobs.has(msg.id)) { endJob(msg.id, st.jobs.get(msg.id)?.state === 'running' ? 'release' : 'cancel', msg.reason === 'preempted' ? 'preempted' : 'done'); tick(); } send(s, { type: 'ok', ref: msg.ref }); break;
      case 'cancel': {
        const j = st.jobs.get(msg.id);
        if (!j) { send(s, { type: 'error', ref: msg.ref, error: `no live job ${msg.id}` }); break; }
        if (j.state !== 'queued' && !c.jobs.has(msg.id)) { send(s, { type: 'error', ref: msg.ref, error: `${msg.id} is running; only its holder can end it` }); break; }
        endJob(msg.id, j.state === 'queued' ? 'cancel' : 'release', `cancelled by ${c.owner}`);
        tick(); send(s, { type: 'ok', ref: msg.ref }); break;
      }
      case 'status': send(s, { type: 'status', ref: msg.ref, ...snapshot(st, now), pid: process.pid, socket: sock, log: logFile }); break;
      case 'explain': send(s, { type: 'explain', ref: msg.ref, ...explain(st, String(msg.id), now) }); break;
      case 'machine': {
        const { trees: _t, ...reading } = lastSample ?? {};
        send(s, { type: 'machine', ref: msg.ref, host: cfg.host, hw, mode: policy.mode,
          policy: { ...policy }, sample: lastSample ? reading : null,
          limit: snapshot(st, now).limit, shadowLimit: snapshot(st, now).shadowLimit,
          leases: [...trees].map(([id, t]) => ({ id, pid: t.pid, currentMB: t.currentMB, peakMB: t.peakMB, reservedMB: st.jobs.get(id)?.reservedMB ?? 0 })) });
        break;
      }
      case 'history': {
        const n = Math.min(Math.max(1, msg.n | 0 || 50), 1000);
        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        send(s, { type: 'history', ref: msg.ref, events: lines }); break;
      }
      default: send(s, { type: 'error', ref: msg.ref, error: `unknown op ${msg.op}` });
    }
  };

  // ── socket ────────────────────────────────────────────────────────────────
  const server = net.createServer((s) => {
    conns.set(s, { owner: `conn-${crypto.randomBytes(4).toString('hex')}`, jobs: new Set() });
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d) => {
      buf += d;
      if (buf.length > 1 << 20) { s.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { send(s, { type: 'error', error: 'invalid JSON' }); continue; }
        try { handle(s, msg); } catch (e) { send(s, { type: 'error', ref: msg.ref, error: String(e?.message ?? e) }); }
      }
    });
    const gone = () => {
      const c = conns.get(s); if (!c) return;
      conns.delete(s);
      for (const id of [...c.jobs]) endJob(id, st.jobs.get(id)?.state === 'running' ? 'release' : 'cancel', 'holder-exited');
      tick();
    };
    s.on('close', gone); s.on('error', gone);
  });

  // The first budget is decided BEFORE the socket opens: a request that arrived
  // earlier would be granted against the full configured capacity.
  await resample();
  await listen(server, sock);
  fs.writeFileSync(path.join(dir, 'broker.pid'), String(process.pid));
  log(`tracegate broker: pid ${process.pid}, capacity ${st.capacity}, ${hw.cores} cores${hw.perfCores ? ` (${hw.perfCores} performance)` : ''}, ${hw.totalMB} MB${hw.cgroup ? ' (container limits)' : ''}, adaptive ${policy.mode}, socket ${sock}`);
  const timer = setInterval(tick, 1000); timer.unref();
  const sampler = setInterval(resample, Math.max(1, policy.sampleSeconds) * 1000); sampler.unref();

  // Idle exit: no connections and no jobs for idleMinutes (0 = never).
  let idleSince = Date.now();
  const idle = setInterval(() => {
    if (conns.size || st.jobs.size) { idleSince = Date.now(); return; }
    if (cfg.idleMinutes > 0 && Date.now() - idleSince > cfg.idleMinutes * 60_000) shutdown('idle');
  }, 5_000);
  idle.unref();
  const shutdown = (why) => {
    log(`tracegate broker: stopping (${why})`);
    clearInterval(timer); clearInterval(idle); clearInterval(sampler);
    server.close(); try { fs.unlinkSync(sock); } catch { /* gone */ }
    for (const s of conns.keys()) s.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

// Bind the socket. A leftover socket file from a dead broker is removed; a LIVE
// broker on it means we are a duplicate, and we exit quietly.
function listen(server, sock) {
  return new Promise((resolve, reject) => {
    const tryListen = (retry) => {
      server.once('error', (e) => {
        if (e.code !== 'EADDRINUSE' || !retry) { reject(e); return; }
        const probe = net.connect(sock);
        probe.once('connect', () => { probe.destroy(); console.error(`tracegate broker: another broker is already serving ${sock}`); process.exit(0); });
        probe.once('error', () => { try { fs.unlinkSync(sock); } catch { /* gone */ } tryListen(false); });
      });
      server.listen(sock, () => { try { fs.chmodSync(sock, 0o600); } catch { /* best effort */ } resolve(); });
    };
    tryListen(true);
  });
}
