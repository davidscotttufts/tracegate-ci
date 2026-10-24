// Adaptive capacity: how much of the machine the broker may hand out right now.
//
// A PURE function of (policy, the latest machine sample, the previous decision,
// what our own leases hold, now). The server samples the machine (sampler.mjs),
// calls `adapt`, and logs a `capacity` event whenever the decision changes, so
// replaying the event log reproduces every grant without the samples (I8).
//
// Two budgets:
//   cpu    tokens (≈ workers). The configured capacity is the ceiling. Load that
//          is not ours (load1 minus the tokens we have granted) is subtracted, a
//          thermal CPU speed limit scales it, and memory pressure caps it.
//   memMB  memory our leases may reserve in total: what is reserved now plus what
//          a new process can still get (available memory, minus a headroom, minus
//          the growth our running leases have reserved but not yet used).
//
// The rules lean towards FEWER workers, because contention produces reds that
// look like real bugs: a budget goes down at once, and comes back up only after
// it has stayed higher for `upHoldS` seconds, one token at a time. Available
// memory is read as its minimum over that same window, so a cache flush that
// frees a few GB for one sample opens nothing.
//
// A signal that could not be read is ignored for that signal alone (never guessed
// as pressure or as headroom), and the decision's `why` says it was missing.

export const DEFAULT_POLICY = Object.freeze({
  mode: 'on',            // off | shadow (log what it would do) | on
  sampleSeconds: 5,
  minTokens: 1,          // the cpu budget never goes below this
  upHoldS: 30,           // a higher budget must hold this long before it applies
  upStep: 1,             // ...and then rises by at most this many tokens per step
  // The memory defaults are null: they derive from the machine (deriveDefaults),
  // so one config serves an 8 GB laptop and a 128 GB runner.
  headroomMB: null,      // kept free for everything else; null = 10% of RAM, within [1024, 8192]
  defaultTokenMB: null,  // per token, for a job with no history and no --mem-per-token;
                         // null = half of RAM per core, within [256, 2048]
  warnFactor: 0.5,       // under memory pressure `warn`, the cpu budget is at most this share
  swapWarnMBps: 4,       // sustained swap-ins above this many MB/s count as pressure `warn`
  starvationS: 300,      // a job held back only by the budgets runs anyway (contended) after this
  memQuantumMB: 256,     // memory budget changes smaller than this are not logged
});

export function resolvePolicy(raw = {}) {
  const p = { ...DEFAULT_POLICY, ...(raw ?? {}) };
  if (!['off', 'shadow', 'on'].includes(p.mode)) p.mode = 'on';
  return p;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Fill the hardware-relative defaults from `hw` (sampler.hardware()). Pure. */
export function deriveDefaults(policy, hw) {
  const totalMB = Number.isFinite(hw?.totalMB) && hw.totalMB > 0 ? hw.totalMB : 8192;
  const cores = Number.isFinite(hw?.cores) && hw.cores > 0 ? hw.cores : 4;
  return {
    ...policy,
    headroomMB: Number.isFinite(policy.headroomMB) ? policy.headroomMB : clamp(Math.round(totalMB * 0.1), 1024, 8192),
    defaultTokenMB: Number.isFinite(policy.defaultTokenMB) ? policy.defaultTokenMB : clamp(Math.round(totalMB / cores / 2), 256, 2048),
  };
}

/**
 * @param policy    resolvePolicy(...)
 * @param s         a sample (sampler.mjs); null when none has been taken yet
 * @param prev      the previous decision (or null): { cpu, memMB, pressure, upSince, window }
 * @param ours      { usedTokens, reservedMB, growthMB } — what our running leases hold
 * @param nominal   the configured capacity (tokens)
 * @param now       ms
 * @returns { cpu, memMB, pressure, why: string[], upSince, window }
 */
export function adapt(policy, s, prev, ours, nominal, now) {
  const why = [];
  const minT = Math.max(1, Math.min(policy.minTokens | 0 || 1, nominal));
  if (!s) return { cpu: nominal, memMB: Infinity, pressure: null, why: ['no sample yet'], upSince: null, window: [] };

  // ── pressure: the kernel's own verdict, raised by sustained swapping ──────
  let pressure = s.pressure ?? null;
  if (pressure === null) why.push('memory pressure unknown');
  if (Number.isFinite(s.swapMBps) && s.swapMBps > policy.swapWarnMBps && pressure !== 'critical') {
    pressure = 'warn'; why.push(`swapping in ${s.swapMBps.toFixed(1)} MB/s`);
  }

  // ── cpu ───────────────────────────────────────────────────────────────────
  // Measured busy cores when there are two readings to compare, else the load
  // average (which overstates on macOS: it counts threads waiting to run).
  let cpu = nominal;
  const busy = Number.isFinite(s.busyCores) ? s.busyCores : Number.isFinite(s.load1) ? s.load1 : null;
  if (busy !== null) {
    const what = Number.isFinite(s.busyCores) ? `${busy.toFixed(1)} cores busy` : `load ${busy.toFixed(1)}`;
    const external = Math.max(0, busy - (ours.usedTokens ?? 0));
    const free = Math.floor((Number.isFinite(s.cores) ? s.cores : nominal) - external + 1e-9);
    if (free < cpu) { cpu = free; why.push(`${what}, ${external.toFixed(1)} of them not ours`); }
  } else why.push('cpu use unknown');
  if (Number.isFinite(s.cpuSpeedLimit) && s.cpuSpeedLimit < 100) {
    const t = Math.floor((nominal * s.cpuSpeedLimit) / 100);
    if (t < cpu) { cpu = t; why.push(`CPU throttled to ${s.cpuSpeedLimit}%`); }
  }
  if (pressure === 'warn') {
    const t = Math.floor(nominal * policy.warnFactor);
    if (t < cpu) { cpu = t; why.push('memory pressure warn'); }
  }
  if (pressure === 'critical') { cpu = minT; why.push('memory pressure critical'); }
  cpu = Math.max(minT, Math.min(nominal, cpu));

  // ── memory ────────────────────────────────────────────────────────────────
  const window = [...(prev?.window ?? []), ...(Number.isFinite(s.availMB) ? [{ at: s.at ?? now, mb: s.availMB }] : [])]
    .filter((w) => now - w.at <= policy.upHoldS * 1000);
  let memMB = Infinity;
  if (window.length) {
    const avail = Math.min(...window.map((w) => w.mb));
    const headroom = Number.isFinite(policy.headroomMB) ? policy.headroomMB : deriveDefaults(policy, { totalMB: s.totalMB, cores: s.cores }).headroomMB;
    const room = Math.max(0, avail - headroom - (ours.growthMB ?? 0));
    memMB = (ours.reservedMB ?? 0) + (pressure === 'critical' ? 0 : room);
    if (pressure === 'critical') why.push('no new memory while pressure is critical');
    else if (room < (policy.defaultTokenMB ?? 1024)) why.push(`${avail} MB available, ${headroom} MB kept free`);
  } else why.push('available memory unknown');

  // ── hysteresis: down at once, up slowly ───────────────────────────────────
  let upSince = prev?.upSince ?? null;
  if (prev && Number.isFinite(prev.cpu) && cpu > prev.cpu) {
    if (upSince === null) upSince = now;
    if (now - upSince < policy.upHoldS * 1000) { why.push(`holding ${prev.cpu} tokens until a higher budget has lasted ${policy.upHoldS} s`); cpu = prev.cpu; }
    else { cpu = Math.min(cpu, prev.cpu + Math.max(1, policy.upStep | 0)); upSince = cpu < nominal ? now : null; }
  } else upSince = null;

  return { cpu, memMB, pressure, why, upSince, window };
}

/** Is the change from `a` to `b` worth a logged `capacity` event? Pure. */
export function changed(a, b, quantumMB) {
  if (!a) return true;
  if (a.cpu !== b.cpu || a.pressure !== b.pressure) return true;
  if (Number.isFinite(a.memMB) !== Number.isFinite(b.memMB)) return true;
  return Number.isFinite(b.memMB) && Math.abs(a.memMB - b.memMB) >= quantumMB;
}
