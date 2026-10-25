// The broker's scheduler: a PURE state machine over an append-only event log.
//
// State is a function of the events applied so far (apply), and scheduling is a
// function of (state, now) (schedule). Neither reads the clock, the disk or the
// network, so replaying a log reproduces every decision exactly (see
// docs/design/broker.md §4, I8). The server owns time, sockets and persistence.
//
// Invariants enforced here (numbers as in the design):
//   I1  one ordered queue: nothing waits on anything but this scheduler
//   I2  a request whose parent lease is running is granted at once, inside it
//   I4  a blocked head job gets a reservation; it starts when capacity frees
//   I5  EASY backfill: a later job starts only if it ends before that reservation
//   I6  only preemptible jobs are preempted, across a priority gap ≥ PREEMPT_GAP
//   I7  every grant carries a strictly increasing fence token
//   I9  adaptive capacity (Phase 0.6): grants fit the CURRENT cpu and memory
//       budgets (a `capacity` event, decided by adapt.mjs from machine samples),
//       never just the configured capacity; an elastic job (minTokens) is granted
//       the most workers that fit; preemptible work is shed when the budget falls
//       below what is running; a job held back only by the budgets runs anyway,
//       flagged `contended`, after starvationS with none of our work running.
//   I10 observe (Phase 0.5b): an `observe` job is granted at once, whatever the
//       budgets say, so adopting the broker beside existing coordination changes
//       nothing; the grant records whether it WOULD have waited, and behind whom.
//       Its tokens count as used, so the broker's picture of the machine is true.
//   I11 yield (Phase 0.5b P2): an observed job registered with `yield` still
//       holds the floor against PREEMPTIBLE work across the priority gap: while
//       it lives, such work is asked to yield and none starts. That is the rule
//       the preemptible job's own script used to apply by itself ("yield to any
//       gate"), so retiring that script-side check loses nothing. An observed job
//       still never sheds, waits for or preempts work that is not preemptible.

export const PREEMPT_GAP = 10;

export const DEFAULT_CLASSES = Object.freeze({
  deploy: { priority: 70, preemptible: false },
  gate: { priority: 50, preemptible: false },
  train: { priority: 50, preemptible: false },
  measure: { priority: 50, preemptible: false },
  adhoc: { priority: 30, preemptible: false },
  daemon: { priority: 10, preemptible: true },
});

const KEEP_DURATIONS = 20; // per (class, label), for p90 estimates
const KEEP_MEMORY = 20; // per (class, label): peak MB per granted token

/**
 * `defaultTokenMB` and `starvationS` matter only once a `capacity` event sets a
 * finite memory budget; until then (adaptive off) the scheduler is Phase 0.5's.
 */
export function initialState({ capacity, classes = DEFAULT_CLASSES, defaultTokenMB = 1024, starvationS = 300 } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`capacity must be a positive integer (got ${capacity})`);
  return {
    capacity, classes, defaultTokenMB, starvationS, seq: 0, fence: 0, jobNo: 0, jobs: new Map(), durations: new Map(), memory: new Map(),
    // The budgets in force (I9). Equal to the configured capacity until a `capacity` event says otherwise.
    limit: { cpu: capacity, memMB: Infinity, pressure: null, why: [] },
    shadowLimit: null, // adaptive `shadow`: what it would have set
  };
}

export const durationKey = (cls, label) => `${cls}\u0000${label ?? ''}`;

/** Apply one event. Mutates and returns `st`. Events carry their own `seq` and `at` (ms). */
export function apply(st, ev) {
  st.seq = ev.seq ?? st.seq + 1;
  const j = ev.id !== undefined ? st.jobs.get(ev.id) : undefined;
  switch (ev.type) {
    case 'enqueue': {
      const cls = st.classes[ev.class] ?? st.classes.adhoc ?? { priority: 0, preemptible: false };
      st.jobNo = Math.max(st.jobNo, Number(String(ev.id).replace(/^j/, '')) || 0);
      st.jobs.set(ev.id, {
        id: ev.id, owner: ev.owner ?? null, class: ev.class, label: ev.label ?? '', tokens: ev.tokens ?? 1,
        exclusive: !!ev.exclusive, est: ev.est ?? null, parent: ev.parent ?? null, deadline: ev.deadline ?? null,
        minTokens: Number.isInteger(ev.minTokens) && ev.minTokens > 0 ? ev.minTokens : null, observe: !!ev.observe, wouldWait: null, yieldOthers: !!ev.observe && !!ev.yieldOthers,
        memPerToken: Number.isFinite(ev.memPerToken) && ev.memPerToken > 0 ? ev.memPerToken : null, reservedMB: 0, contended: false,
        priority: ev.priority ?? cls.priority, preemptible: ev.preemptible ?? cls.preemptible,
        state: 'queued', enqueuedAt: ev.at, enqueueSeq: st.seq, rank: st.seq, grantedAt: null, fence: null,
        granted: 0, nested: false, preemptRequested: false,
      });
      break;
    }
    case 'grant':
      if (!j || j.state !== 'queued') break;
      j.state = 'running'; j.grantedAt = ev.at; j.granted = ev.tokens; j.nested = !!ev.nested;
      j.reservedMB = Number.isFinite(ev.memMB) ? ev.memMB : 0; j.contended = !!ev.contended;
      if (ev.observed) j.wouldWait = !!ev.wouldWait;
      st.fence = Math.max(st.fence + 1, ev.fence ?? 0); j.fence = st.fence;
      break;
    case 'preempt':
      if (j && j.state === 'running') j.preemptRequested = true;
      break;
    case 'rank':
      if (j && j.state === 'queued') j.rank = ev.rank;
      break;
    case 'release': case 'cancel': case 'expire': {
      if (!j) break;
      if (ev.type === 'release' && j.state === 'running' && !j.nested && ev.reason === 'done') {
        const k = durationKey(j.class, j.label);
        const d = st.durations.get(k) ?? [];
        d.push(Math.max(0, (ev.at - j.grantedAt) / 1000));
        st.durations.set(k, d.slice(-KEEP_DURATIONS));
      }
      // What the job's process tree used at its peak, per token it was granted:
      // the next run of the same (class, label) reserves that much (I9).
      if (ev.type === 'release' && j.state === 'running' && !j.nested && Number.isFinite(ev.peakMB) && ev.peakMB > 0 && j.granted > 0) {
        const k = durationKey(j.class, j.label);
        const m = st.memory.get(k) ?? [];
        m.push(ev.peakMB / j.granted);
        st.memory.set(k, m.slice(-KEEP_MEMORY));
      }
      st.jobs.delete(ev.id);
      // A parent's end ends its nested children: their authority came from it.
      for (const c of [...st.jobs.values()]) if (c.parent === ev.id) st.jobs.delete(c.id);
      break;
    }
    case 'capacity': {
      const lim = { cpu: Math.max(1, Math.min(st.capacity, ev.cpu | 0 || st.capacity)), memMB: Number.isFinite(ev.memMB) ? ev.memMB : Infinity, pressure: ev.pressure ?? null, why: ev.why ?? [] };
      if (ev.applied === false) st.shadowLimit = lim; else { st.limit = lim; st.shadowLimit = null; }
      break;
    }
    case 'advice': break; // recorded for audit only; ranks arrive as `rank` events
    default: break;
  }
  return st;
}

/** p90 of recorded durations (seconds) for this job's (class, label), or null. */
export function estimateOf(st, job) {
  if (Number.isFinite(job.est) && job.est > 0) return job.est;
  const d = st.durations.get(durationKey(job.class, job.label));
  if (!d || d.length < 3) return null;
  const s = [...d].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
}

const p90 = (d) => { const s = [...d].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]; };

/** MB one token of this job is expected to use: declared, else p90 of its history, else the default. Pure. */
export function memPerTokenOf(st, job) {
  if (Number.isFinite(job.memPerToken) && job.memPerToken > 0) return job.memPerToken;
  const m = st.memory.get(durationKey(job.class, job.label));
  return m && m.length >= 2 ? Math.ceil(p90(m)) : st.defaultTokenMB;
}

const order = (a, b) => (b.priority - a.priority) || (a.rank - b.rank) || (a.enqueueSeq - b.enqueueSeq);

export function queueOf(st) { return [...st.jobs.values()].filter((j) => j.state === 'queued').sort(order); }
export function runningOf(st) { return [...st.jobs.values()].filter((j) => j.state === 'running'); }

/** The cpu budget for new grants: the configured capacity, or less under adaptive capacity. */
export const cpuCap = (st) => Math.max(1, Math.min(st.capacity, st.limit.cpu));
// The most a job may hold now; an exclusive job takes the whole budget.
const needOf = (st, j) => (j.exclusive ? cpuCap(st) : Math.min(Math.max(1, j.tokens | 0), cpuCap(st)));
// The fewest it accepts: its minTokens if it is elastic, else all of needOf.
const minOf = (st, j) => Math.min(needOf(st, j), j.minTokens ?? Infinity);

/**
 * Decide what to do at time `now` (ms). Pure.
 * Returns { expires: [id], grants: [{id, tokens, nested}], preempts: [{id, by}], reservation: {id, at}|null }.
 * `reservation.at` is ms, or Infinity when a blocking job has no duration estimate.
 */
export function schedule(st, now) {
  const out = { expires: [], grants: [], preempts: [], reservation: null };
  const running = runningOf(st).filter((j) => !j.nested);
  let used = running.reduce((s, j) => s + j.granted, 0);
  let usedMB = running.reduce((s, j) => s + j.reservedMB, 0);
  let exclusiveRunning = running.some((j) => j.exclusive);
  const cap = cpuCap(st);
  const memCap = st.limit.memMB;
  // I9 shedding: the budget fell below what is running (load, heat or memory
  // pressure). Ask preemptible work to yield, cheapest first, until what is left
  // fits. Work that is not preemptible keeps running: it is never killed for load.
  const overMem = () => Number.isFinite(memCap) && real.reduce((s, j) => s + j.reservedMB, 0) - shed.reduce((s, r) => s + r.reservedMB, 0) > memCap;
  const shed = [];
  // Only REAL leases decide shedding (I10): an observed job's tokens must never
  // make the broker preempt anything. The load it really puts on the machine still
  // reaches the budget, through the sampler.
  const real = running.filter((r) => !r.observe);
  const usedReal = real.reduce((s, j) => s + j.granted, 0);
  if (usedReal > cap || st.limit.pressure === 'critical' || (Number.isFinite(memCap) && real.reduce((s, j) => s + j.reservedMB, 0) > memCap)) {
    const cand = real.filter((r) => r.preemptible).sort((a, b) => (a.priority - b.priority) || (b.grantedAt - a.grantedAt));
    for (const r of cand) {
      const left = usedReal - shed.reduce((s, x) => s + x.granted, 0);
      if (left <= cap && !overMem() && st.limit.pressure !== 'critical') break;
      shed.push(r);
      if (!r.preemptRequested) out.preempts.push({ id: r.id, by: 'pressure' });
    }
  }
  const ourWorkRunning = running.length > 0;
  // I11: the highest observed job that asks preemptible work to yield, queued or running.
  const floor = [...st.jobs.values()].filter((x) => x.yieldOthers && !x.nested).sort((a, b) => b.priority - a.priority)[0] ?? null;
  const held = (j) => !!floor && !j.observe && j.preemptible && j.priority <= floor.priority - PREEMPT_GAP;
  if (floor) for (const r of real) if (held(r) && !r.preemptRequested && !out.preempts.some((p) => p.id === r.id)) out.preempts.push({ id: r.id, by: floor.id });

  for (const j of queueOf(st)) {
    if (j.deadline !== null && now >= j.deadline) { out.expires.push(j.id); continue; }
    if (held(j)) continue; // I11: waits, without a reservation, until the observed job ends
    // I2: a request made from inside a running lease runs inside it, at once.
    const parent = j.parent ? st.jobs.get(j.parent) : null;
    if (parent && parent.state === 'running') {
      out.grants.push({ id: j.id, tokens: Math.min(needOf(st, j), parent.granted), nested: true });
      continue;
    }
    const perTok = Number.isFinite(memCap) ? memPerTokenOf(st, j) : 0;
    // A request is clamped to what the machine allows in total, cpu and memory
    // alike, as it always was to the configured capacity; it waits only for room.
    const memTokens = perTok > 0 ? Math.max(1, Math.floor(memCap / perTok)) : Infinity;
    const need = Math.min(needOf(st, j), memTokens);
    const minNeed = Math.min(minOf(st, j), need);
    // The most tokens in [minNeed, need] that fit both budgets (0 = none fit).
    const width = (() => {
      if (exclusiveRunning || (j.exclusive && used > 0)) return 0;
      if (st.limit.pressure === 'critical') return 0; // nothing new starts while memory is critical
      let t = Math.min(need, cap - used);
      if (perTok > 0) t = Math.min(t, Math.floor((memCap - usedMB) / perTok));
      return t >= minNeed ? t : 0;
    })();
    const res = out.reservation;
    const allowedByReservation = !res || j.preemptible || (() => {
      const e = estimateOf(st, j);
      return e !== null && Number.isFinite(res.at) && now + e * 1000 <= res.at;
    })();
    // I10: an observed job never waits; the grant says whether it would have.
    if (j.observe) {
      const t = width > 0 ? width : Math.max(1, need);
      out.grants.push({ id: j.id, tokens: t, nested: false, memMB: t * perTok, observed: true, wouldWait: !(width > 0 && allowedByReservation) });
      used += t; usedMB += t * perTok; if (j.exclusive) exclusiveRunning = true;
      continue;
    }
    if (width > 0 && allowedByReservation) {
      out.grants.push({ id: j.id, tokens: width, nested: false, memMB: width * perTok });
      used += width; usedMB += width * perTok; if (j.exclusive) exclusiveRunning = true;
      continue;
    }
    // I9 starvation guard: none of our work is running, so nothing of ours will
    // free room; only the budgets (someone else's load) hold this job back. After
    // starvationS it runs anyway at its narrowest, flagged contended so its reds
    // are read as such. Without this, a busy machine could hold a gate forever.
    if (!res && !ourWorkRunning && !out.grants.length && now - j.enqueuedAt >= st.starvationS * 1000
      && (st.limit.pressure === 'critical' || perTok * minNeed > memCap - usedMB)) {
      const t = Math.max(1, Math.min(minNeed, cap));
      out.grants.push({ id: j.id, tokens: t, nested: false, memMB: t * perTok, contended: true });
      used += t; usedMB += t * perTok; if (j.exclusive) exclusiveRunning = true;
      continue;
    }
    if (res) continue; // EASY: only the first blocked job holds a reservation
    // I6: free room by preempting cheap work, lowest priority first, newest first.
    const victims = running
      .filter((r) => r.preemptible && r.priority <= j.priority - PREEMPT_GAP)
      .sort((a, b) => (a.priority - b.priority) || (b.grantedAt - a.grantedAt));
    const pending = running.filter((r) => r.preemptRequested);
    const keep = running.filter((r) => !victims.includes(r));
    const keepUsed = keep.reduce((s, r) => s + r.granted, 0);
    const feasibleAfter = j.exclusive ? keep.length === 0 : keepUsed + minNeed <= cap;
    if (feasibleAfter && victims.length) {
      let freed = cap - used + pending.filter((r) => victims.includes(r)).reduce((s, r) => s + r.granted, 0);
      for (const v of victims) {
        if (j.exclusive ? false : freed >= minNeed) break;
        if (!v.preemptRequested && !out.preempts.some((p) => p.id === v.id)) out.preempts.push({ id: v.id, by: j.id });
        if (!pending.includes(v)) freed += v.granted;
      }
    }
    // I4: when could it start? Walk running jobs by expected end.
    const ends = running.map((r) => {
      const e = estimateOf(st, r);
      const preempting = r.preemptRequested || out.preempts.some((p) => p.id === r.id);
      return { r, at: preempting ? now : e === null ? Infinity : r.grantedAt + e * 1000 };
    }).sort((a, b) => a.at - b.at);
    let free = cap - used; let at = now;
    for (const { r, at: t } of ends) {
      if (j.exclusive ? false : free >= minNeed) break;
      free += r.granted; at = Math.max(at, t);
    }
    if (j.exclusive) at = ends.length ? Math.max(now, ...ends.map((e) => e.at)) : now;
    out.reservation = { id: j.id, at };
  }
  return out;
}

/** Why is `id` where it is? A plain-language explanation plus structured facts. Pure. */
export function explain(st, id, now) {
  const j = st.jobs.get(id);
  if (!j) return { id, state: 'unknown', text: `no live job ${id} (finished, cancelled or never existed)` };
  if (j.state === 'running') {
    return { id, state: 'running', fence: j.fence, tokens: j.granted, memMB: j.reservedMB, contended: j.contended, since: j.grantedAt, nested: j.nested,
      text: `running since ${new Date(j.grantedAt).toISOString()} with ${j.granted} token(s), fence ${j.fence}${j.nested ? ` (inside ${j.parent})` : ''}${j.contended ? '; started CONTENDED (the machine was busy past the starvation limit)' : ''}${j.preemptRequested ? '; asked to yield' : ''}` };
  }
  const q = queueOf(st);
  const pos = q.findIndex((x) => x.id === id);
  const yielder = [...st.jobs.values()].filter((x) => x.yieldOthers && !x.nested).sort((a, b) => b.priority - a.priority)[0];
  if (yielder && j.preemptible && !j.observe && j.priority <= yielder.priority - PREEMPT_GAP) {
    return { id, state: 'queued', position: pos + 1, of: q.length, ahead: [], blockers: [{ id: yielder.id, class: yielder.class, label: yielder.label, tokens: yielder.granted }], reservation: null,
      text: `held: preemptible work yields while ${yielder.id} (${yielder.class}${yielder.label ? ` ${yielder.label}` : ''}) runs, and starts when it ends` };
  }
  const s = schedule(st, now);
  const blockers = runningOf(st).filter((r) => !r.nested).map((r) => ({ id: r.id, class: r.class, label: r.label, tokens: r.granted }));
  const ahead = q.slice(0, pos).map((x) => ({ id: x.id, class: x.class, label: x.label, priority: x.priority }));
  const res = s.reservation;
  const eta = res && res.id === id ? (Number.isFinite(res.at) ? new Date(res.at).toISOString() : 'unknown (a running job has no duration estimate)') : null;
  const parts = [`queued at position ${pos + 1} of ${q.length}`];
  if (ahead.length) parts.push(`behind ${ahead.map((a) => `${a.id} (${a.class}${a.label ? ` ${a.label}` : ''})`).join(', ')}`);
  if (blockers.length) parts.push(`capacity ${cpuCap(st)} is held by ${blockers.map((b) => `${b.id} (${b.class}, ${b.tokens})`).join(', ')}`);
  if (st.limit.cpu < st.capacity || Number.isFinite(st.limit.memMB)) {
    const mem = Number.isFinite(st.limit.memMB) ? `, memory budget ${Math.round(st.limit.memMB)} MB (this job needs ~${memPerTokenOf(st, j)} MB per token)` : '';
    parts.push(`the machine allows ${cpuCap(st)} of ${st.capacity} token(s) now${mem}${st.limit.why?.length ? ` — ${st.limit.why.join('; ')}` : ''}`);
  }
  if (eta) parts.push(`reserved to start at ${eta}`);
  if (res && res.id !== id) parts.push(`${res.id} holds the reservation; this job may start earlier only if it ends before ${Number.isFinite(res.at) ? new Date(res.at).toISOString() : 'an unknown time'}`);
  return { id, state: 'queued', position: pos + 1, of: q.length, ahead, blockers, reservation: res, text: parts.join('; ') };
}

/** A JSON-safe snapshot for status output. Pure. */
export function snapshot(st, now) {
  const s = schedule(st, now);
  const view = (j) => ({ id: j.id, class: j.class, label: j.label, priority: j.priority, tokens: j.state === 'running' ? j.granted : j.tokens,
    exclusive: j.exclusive, preemptible: j.preemptible, state: j.state, fence: j.fence, nested: j.nested, parent: j.parent,
    minTokens: j.minTokens, memMB: j.state === 'running' ? j.reservedMB : null, memPerToken: memPerTokenOf(st, j), contended: j.contended,
    observe: j.observe, wouldWait: j.wouldWait, yieldOthers: j.yieldOthers,
    enqueuedAt: j.enqueuedAt, grantedAt: j.grantedAt, est: estimateOf(st, j) });
  const run = runningOf(st);
  return {
    capacity: st.capacity, used: run.filter((j) => !j.nested).reduce((a, j) => a + j.granted, 0), seq: st.seq, fence: st.fence,
    limit: { cpu: cpuCap(st), memMB: Number.isFinite(st.limit.memMB) ? Math.round(st.limit.memMB) : null, pressure: st.limit.pressure, why: st.limit.why },
    shadowLimit: st.shadowLimit && { cpu: st.shadowLimit.cpu, memMB: Number.isFinite(st.shadowLimit.memMB) ? Math.round(st.shadowLimit.memMB) : null, pressure: st.shadowLimit.pressure, why: st.shadowLimit.why },
    usedMB: run.filter((j) => !j.nested).reduce((a, j) => a + j.reservedMB, 0),
    running: run.map(view), queued: queueOf(st).map(view),
    reservation: s.reservation && { id: s.reservation.id, at: Number.isFinite(s.reservation.at) ? new Date(s.reservation.at).toISOString() : null },
  };
}
