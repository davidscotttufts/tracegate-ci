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

export function initialState({ capacity, classes = DEFAULT_CLASSES } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`capacity must be a positive integer (got ${capacity})`);
  return { capacity, classes, seq: 0, fence: 0, jobNo: 0, jobs: new Map(), durations: new Map() };
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
        priority: ev.priority ?? cls.priority, preemptible: ev.preemptible ?? cls.preemptible,
        state: 'queued', enqueuedAt: ev.at, enqueueSeq: st.seq, rank: st.seq, grantedAt: null, fence: null,
        granted: 0, nested: false, preemptRequested: false,
      });
      break;
    }
    case 'grant':
      if (!j || j.state !== 'queued') break;
      j.state = 'running'; j.grantedAt = ev.at; j.granted = ev.tokens; j.nested = !!ev.nested;
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
      st.jobs.delete(ev.id);
      // A parent's end ends its nested children: their authority came from it.
      for (const c of [...st.jobs.values()]) if (c.parent === ev.id) st.jobs.delete(c.id);
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

const order = (a, b) => (b.priority - a.priority) || (a.rank - b.rank) || (a.enqueueSeq - b.enqueueSeq);

export function queueOf(st) { return [...st.jobs.values()].filter((j) => j.state === 'queued').sort(order); }
export function runningOf(st) { return [...st.jobs.values()].filter((j) => j.state === 'running'); }

const needOf = (st, j) => (j.exclusive ? st.capacity : Math.min(Math.max(1, j.tokens | 0), st.capacity));

/**
 * Decide what to do at time `now` (ms). Pure.
 * Returns { expires: [id], grants: [{id, tokens, nested}], preempts: [{id, by}], reservation: {id, at}|null }.
 * `reservation.at` is ms, or Infinity when a blocking job has no duration estimate.
 */
export function schedule(st, now) {
  const out = { expires: [], grants: [], preempts: [], reservation: null };
  const running = runningOf(st).filter((j) => !j.nested);
  let used = running.reduce((s, j) => s + j.granted, 0);
  let exclusiveRunning = running.some((j) => j.exclusive);

  for (const j of queueOf(st)) {
    if (j.deadline !== null && now >= j.deadline) { out.expires.push(j.id); continue; }
    // I2: a request made from inside a running lease runs inside it, at once.
    const parent = j.parent ? st.jobs.get(j.parent) : null;
    if (parent && parent.state === 'running') {
      out.grants.push({ id: j.id, tokens: Math.min(needOf(st, j), parent.granted), nested: true });
      continue;
    }
    const need = needOf(st, j);
    const fits = !exclusiveRunning && (j.exclusive ? used === 0 : used + need <= st.capacity);
    const res = out.reservation;
    const allowedByReservation = !res || j.preemptible || (() => {
      const e = estimateOf(st, j);
      return e !== null && Number.isFinite(res.at) && now + e * 1000 <= res.at;
    })();
    if (fits && allowedByReservation) {
      out.grants.push({ id: j.id, tokens: need, nested: false });
      used += need; if (j.exclusive) exclusiveRunning = true;
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
    const feasibleAfter = j.exclusive ? keep.length === 0 : keepUsed + need <= st.capacity;
    if (feasibleAfter && victims.length) {
      let freed = st.capacity - used + pending.filter((r) => victims.includes(r)).reduce((s, r) => s + r.granted, 0);
      for (const v of victims) {
        if (j.exclusive ? false : freed >= need) break;
        if (!v.preemptRequested) out.preempts.push({ id: v.id, by: j.id });
        if (!pending.includes(v)) freed += v.granted;
      }
    }
    // I4: when could it start? Walk running jobs by expected end.
    const ends = running.map((r) => {
      const e = estimateOf(st, r);
      const preempting = r.preemptRequested || out.preempts.some((p) => p.id === r.id);
      return { r, at: preempting ? now : e === null ? Infinity : r.grantedAt + e * 1000 };
    }).sort((a, b) => a.at - b.at);
    let free = st.capacity - used; let at = now;
    for (const { r, at: t } of ends) {
      if (j.exclusive ? false : free >= need) break;
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
    return { id, state: 'running', fence: j.fence, tokens: j.granted, since: j.grantedAt, nested: j.nested,
      text: `running since ${new Date(j.grantedAt).toISOString()} with ${j.granted} token(s), fence ${j.fence}${j.nested ? ` (inside ${j.parent})` : ''}${j.preemptRequested ? '; asked to yield' : ''}` };
  }
  const q = queueOf(st);
  const pos = q.findIndex((x) => x.id === id);
  const s = schedule(st, now);
  const blockers = runningOf(st).filter((r) => !r.nested).map((r) => ({ id: r.id, class: r.class, label: r.label, tokens: r.granted }));
  const ahead = q.slice(0, pos).map((x) => ({ id: x.id, class: x.class, label: x.label, priority: x.priority }));
  const res = s.reservation;
  const eta = res && res.id === id ? (Number.isFinite(res.at) ? new Date(res.at).toISOString() : 'unknown (a running job has no duration estimate)') : null;
  const parts = [`queued at position ${pos + 1} of ${q.length}`];
  if (ahead.length) parts.push(`behind ${ahead.map((a) => `${a.id} (${a.class}${a.label ? ` ${a.label}` : ''})`).join(', ')}`);
  if (blockers.length) parts.push(`capacity ${st.capacity} is held by ${blockers.map((b) => `${b.id} (${b.class}, ${b.tokens})`).join(', ')}`);
  if (eta) parts.push(`reserved to start at ${eta}`);
  if (res && res.id !== id) parts.push(`${res.id} holds the reservation; this job may start earlier only if it ends before ${Number.isFinite(res.at) ? new Date(res.at).toISOString() : 'an unknown time'}`);
  return { id, state: 'queued', position: pos + 1, of: q.length, ahead, blockers, reservation: res, text: parts.join('; ') };
}

/** A JSON-safe snapshot for status output. Pure. */
export function snapshot(st, now) {
  const s = schedule(st, now);
  const view = (j) => ({ id: j.id, class: j.class, label: j.label, priority: j.priority, tokens: j.state === 'running' ? j.granted : j.tokens,
    exclusive: j.exclusive, preemptible: j.preemptible, state: j.state, fence: j.fence, nested: j.nested, parent: j.parent,
    enqueuedAt: j.enqueuedAt, grantedAt: j.grantedAt, est: estimateOf(st, j) });
  const run = runningOf(st);
  return {
    capacity: st.capacity, used: run.filter((j) => !j.nested).reduce((a, j) => a + j.granted, 0), seq: st.seq, fence: st.fence,
    running: run.map(view), queued: queueOf(st).map(view),
    reservation: s.reservation && { id: s.reservation.id, at: Number.isFinite(s.reservation.at) ? new Date(s.reservation.at).toISOString() : null },
  };
}
