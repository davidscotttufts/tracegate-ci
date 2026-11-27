// Roles: a cross-machine lease with fencing, such as "this machine deploys".
//
// A role record lives in a store every machine can reach (stores.mjs) and changes only
// by compare-and-swap, so two machines that race for a role cannot both win. The
// record:
//   { role, epoch, holder: { host, user, session } | null, since, until, renewedAt,
//     offer: { to, by, at } | null, history: [ audit records ] }
//
// THE EPOCH is the fencing token. It increases by one on every change of holder:
// claim, accepted handover, take and release. A renew (the heartbeat) keeps it.
// Whoever holds epoch N may act; `role check --epoch N` exits 0 only while N is
// still current, this host still holds it and the lease has not expired. A deploy
// script calls it right before its irreversible step (the traffic shift).
//
// A TAKEOVER NEVER KILLS ANYTHING. `take` moves the role at once, even from a live
// holder. The old holder's running deploy is not stopped: tracegate cannot reach it,
// and killing a deploy half way is worse than letting it reach its check. Its next
// `role check` fails, so it stops before shipping, and it cannot start a new deploy
// (`lease --role` refuses).
//
// HOLDING A ROLE IS NOT AN APPROVAL. It answers "which machine deploys", never
// "may this be deployed". Approvals stay with the people and scripts that give them.
//
// Names. `deployer` is global; `deployer:<repo>` is one repo's. For an unqualified
// name, in repo R: `deployer:R` if the config declares it or the store has a record
// for it, else `deployer`. A qualified name is used as given. R is "roles.repo" in
// the config, else the name of the clone's directory.
//
// Commands (exit codes below):
//   status [<role>] | claim <role> [--ttl 30m] [--hold] | renew <role> [--epoch N]
//   release <role> | handover <role> --to <host> | take <role> --reason "…" [--skip-preflight]
//   check <role> --epoch N
// A handover is an OFFER: the holder names the next host and keeps the role until that
// host runs `claim`, which runs its own preflight there and accepts. If it never does,
// nothing changes hands, so a planned move can never leave the role with nobody.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ctx } from '../config.mjs';
import { openStore } from './stores.mjs';

export const EX = Object.freeze({ OK: 0, USAGE: 2, HELD: 3, FENCED: 4, PREFLIGHT: 5, STORE: 6 });
const HISTORY_MAX = 200;
const DEFAULT_TTL = '30m';

export class RoleError extends Error {
  constructor(code, message) { super(message); this.exitCode = code; }
}

/** "30m", "2h", "90s", or a bare number of minutes → ms. */
export function parseTtl(v) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(String(v ?? DEFAULT_TTL).trim());
  if (!m) throw new RoleError(EX.USAGE, `bad --ttl ${JSON.stringify(v)} (use 90s, 30m or 2h)`);
  return Math.round(Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 'm']);
}

function settings() {
  let c = null; try { c = ctx(); } catch { /* outside a repo */ }
  const cfg = c?.roles ?? {};
  const url = process.env.TRACEGATE_ROLES_STORE || cfg.store || null;
  const repo = cfg.repo || (c ? path.basename(path.dirname(c.commonDir ?? path.join(c.root, '.git'))) : null);
  return { c, cfg, url, repo, host: c?.host ?? (os.hostname().split('.')[0] || 'host').replace(/[^A-Za-z0-9_-]/g, '_') };
}

/** Open the store: `opts.store` (tests) or the configured URL. */
function storeOf(opts, s) {
  if (opts.store) return opts.store;
  if (!s.url) throw new RoleError(EX.STORE, 'no role store: set "roles": {"store": "gs://…" | "git+<remote>" | "file:///dir"} or TRACEGATE_ROLES_STORE');
  return openStore(s.url, { root: s.c?.root });
}

const guardStore = (fn) => { try { return fn(); } catch (e) { if (e instanceof RoleError) throw e; throw new RoleError(EX.STORE, `role store: ${e.message}`); } };

/** Which record an unqualified name means here (see the header). */
export function resolveRole(name, opts = {}) {
  if (!name || name === true) throw new RoleError(EX.USAGE, 'name a role, e.g. `deployer`');
  const s = settings();
  if (name.includes(':') || !s.repo) return { role: name, scope: name.includes(':') ? 'repo' : 'global', why: name.includes(':') ? 'named in full' : 'not in a repo' };
  const own = `${name}:${s.repo}`;
  if (s.cfg[own]) return { role: own, scope: 'repo', why: `the config declares ${own}` };
  const st = storeOf(opts, s);
  if (guardStore(() => st.read(own)).data) return { role: own, scope: 'repo', why: `the store has a record for ${own}` };
  return { role: name, scope: 'global', why: `no ${own} in the config or the store` };
}

const live = (rec, now) => !!rec?.holder && Date.parse(rec.until) > now;
const me = (s) => ({ host: s.host, user: os.userInfo().username, session: process.env.TRACEGATE_SESSION || process.env.CLAUDE_CODE_SESSION_ID || null });
const who = (h) => (h ? `${h.host}${h.user ? ` (${h.user})` : ''}` : 'nobody');

/**
 * Compare-and-swap: read, let `change(record, now)` return the next record (or throw a
 * RoleError), write it at the generation read; on a lost race, read again and re-decide.
 */
function mutate(st, role, change) {
  let lost = 0;
  for (let i = 0; i < 50; i++) {
    const { gen, data } = guardStore(() => st.read(role));
    if (process.env.TRACEGATE_ROLE_TEST_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.TRACEGATE_ROLE_TEST_DELAY_MS)); // tests: widen the race
    let next;
    try { next = change(data, Date.now()); } catch (e) {
      if (lost && e.exitCode === EX.HELD) e.message += ` (lost the race: it changed while this machine was writing)`;
      throw e;
    }
    if (next === null) return data; // nothing to write
    if (guardStore(() => st.write(role, gen, next))) return next;
    lost++;
  }
  throw new RoleError(EX.STORE, `role ${role}: the record kept changing; try again`);
}

function audit(prev, entry) {
  const h = [...(prev?.history ?? []), entry];
  return h.slice(-HISTORY_MAX);
}

function preflight(s, role, base, { skip, reason } = {}) {
  const cmd = s.cfg[role]?.preflight ?? s.cfg[base]?.preflight ?? null;
  if (!cmd) return 'none';
  if (skip) {
    process.stderr.write(`\n!!! tracegate role: PREFLIGHT SKIPPED for ${role} on ${s.host} (${cmd}). This is recorded in the role's audit trail.\n\n`);
    return 'skipped';
  }
  process.stderr.write(`tracegate role: preflight for ${role}: ${cmd}\n`);
  const r = spawnSync(cmd, { shell: true, cwd: s.c?.root ?? process.cwd(), stdio: ['ignore', 2, 2], timeout: 5 * 60_000, env: { ...process.env, TRACEGATE_ROLE: role } });
  if (r.status !== 0) throw new RoleError(EX.PREFLIGHT, `preflight failed for ${role} on ${s.host} (exit ${r.status ?? r.signal}): ${cmd}. Nothing was claimed${reason ? '' : ''}`);
  return 'passed';
}

// ── operations (each returns a result object; failures are RoleErrors) ─────────

export function status(name, opts = {}) {
  const s = settings(); const st = storeOf(opts, s);
  const r = resolveRole(name, { ...opts, store: st });
  const { data } = guardStore(() => st.read(r.role));
  const now = Date.now();
  return { ...r, host: s.host, record: data, live: live(data, now), mine: live(data, now) && data.holder.host === s.host };
}

export function claim(name, opts = {}) {
  const s = settings(); const st = storeOf(opts, s);
  const { role } = resolveRole(name, { ...opts, store: st });
  const base = role.split(':')[0];
  const ttl = parseTtl(opts.ttl ?? s.cfg[role]?.ttl ?? s.cfg[base]?.ttl);
  // Who may claim: 'mine' (already held: a renew), 'accept' (an offer to this host),
  // 'free' (never held, released or expired); a live holder's role is refused.
  const decide = (rec, now) => {
    if (!live(rec, now)) return 'free';
    if (rec.holder.host === s.host) return 'mine';
    if (rec.offer?.to === s.host) return 'accept';
    throw new RoleError(EX.HELD, `${role} is held by ${who(rec.holder)} at epoch ${rec.epoch} until ${rec.until}. Ask them to hand it over, or \`tracegate role take ${role} --reason "…"\``);
  };
  // Decide first without writing, so a claim that will be refused runs no preflight.
  if (decide(guardStore(() => st.read(role)).data, Date.now()) === 'mine') return renew(name, { ...opts, store: st, ttl: opts.ttl });
  const pf = preflight(s, role, base);
  return mutate(st, role, (rec, now) => {
    const d = decide(rec, now);
    if (d === 'mine') return null;
    const accepting = d === 'accept';
    const epoch = (rec?.epoch ?? 0) + 1;
    return {
      role, epoch, holder: me(s), since: new Date(now).toISOString(), until: new Date(now + ttl).toISOString(), renewedAt: new Date(now).toISOString(), offer: null,
      history: audit(rec, { epoch, action: accepting ? 'handover' : 'claim', host: s.host, user: me(s).user, at: new Date(now).toISOString(), reason: accepting ? `offered by ${rec.offer.by}` : rec?.holder ? `previous lease expired at ${rec.until}` : null,
        previous: rec?.holder ? { host: rec.holder.host, epoch: rec.epoch } : null, preflight: pf }),
    };
  });
}

export function renew(name, opts = {}) {
  const s = settings(); const st = storeOf(opts, s);
  const { role } = resolveRole(name, { ...opts, store: st });
  const base = role.split(':')[0];
  const ttl = parseTtl(opts.ttl ?? s.cfg[role]?.ttl ?? s.cfg[base]?.ttl);
  const want = opts.epoch !== undefined && opts.epoch !== true ? Number(opts.epoch) : null;
  return mutate(st, role, (rec, now) => {
    if (!rec?.holder || rec.holder.host !== s.host) throw new RoleError(EX.FENCED, `${role} is not held by ${s.host} (holder: ${who(rec?.holder)}, epoch ${rec?.epoch ?? 0})`);
    if (want !== null && rec.epoch !== want) throw new RoleError(EX.FENCED, `${role} is at epoch ${rec.epoch}, not ${want}: it changed hands since`);
    // An expired lease that nobody took is still ours to renew; the epoch says nothing moved.
    return { ...rec, until: new Date(now + ttl).toISOString(), renewedAt: new Date(now).toISOString() };
  });
}

export function release(name, opts = {}) {
  const s = settings(); const st = storeOf(opts, s);
  const { role } = resolveRole(name, { ...opts, store: st });
  return mutate(st, role, (rec, now) => {
    if (!rec?.holder || rec.holder.host !== s.host) throw new RoleError(EX.FENCED, `${role} is not held by ${s.host} (holder: ${who(rec?.holder)})`);
    const epoch = rec.epoch + 1;
    return { ...rec, epoch, holder: null, until: null, offer: null,
      history: audit(rec, { epoch, action: 'release', host: s.host, user: me(s).user, at: new Date(now).toISOString(), reason: opts.reason && opts.reason !== true ? String(opts.reason) : null, previous: { host: s.host, epoch: rec.epoch } }) };
  });
}

export function handover(name, opts = {}) {
  const s = settings(); const st = storeOf(opts, s);
  const { role } = resolveRole(name, { ...opts, store: st });
  const to = opts.to && opts.to !== true ? String(opts.to) : null;
  if (!to) throw new RoleError(EX.USAGE, 'handover: --to <host> is required');
  if (to === s.host) throw new RoleError(EX.USAGE, `handover: ${s.host} already holds ${role}`);
  return mutate(st, role, (rec, now) => {
    if (!live(rec, now) || rec.holder.host !== s.host) throw new RoleError(EX.FENCED, `${role} is not held by ${s.host} (holder: ${who(rec?.holder)}); only the holder can hand it over`);
    return { ...rec, offer: { to, by: s.host, at: new Date(now).toISOString() },
      history: audit(rec, { epoch: rec.epoch, action: 'offer', host: s.host, user: me(s).user, at: new Date(now).toISOString(), reason: `handover offered to ${to}`, previous: null }) };
  });
}

export function take(name, opts = {}) {
  const s = settings(); const st = storeOf(opts, s);
  const { role } = resolveRole(name, { ...opts, store: st });
  const base = role.split(':')[0];
  const reason = opts.reason && opts.reason !== true ? String(opts.reason).slice(0, 500) : null;
  if (!reason) throw new RoleError(EX.USAGE, 'take: --reason "<why>" is required; it goes in the audit trail');
  const ttl = parseTtl(opts.ttl ?? s.cfg[role]?.ttl ?? s.cfg[base]?.ttl);
  const pf = preflight(s, role, base, { skip: !!opts['skip-preflight'] });
  return mutate(st, role, (rec, now) => {
    const epoch = (rec?.epoch ?? 0) + 1;
    const from = live(rec, now) ? rec.holder : null;
    if (from && from.host !== s.host) process.stderr.write(`tracegate role: taking ${role} from ${who(from)}, who is LIVE at epoch ${rec.epoch}. Its running deploy is not stopped; its next \`role check\` fails.\n`);
    return {
      role, epoch, holder: me(s), since: new Date(now).toISOString(), until: new Date(now + ttl).toISOString(), renewedAt: new Date(now).toISOString(), offer: null,
      history: audit(rec, { epoch, action: 'take', host: s.host, user: me(s).user, at: new Date(now).toISOString(), reason, previous: rec?.holder ? { host: rec.holder.host, epoch: rec.epoch, live: !!from } : null, preflight: pf }),
    };
  });
}

/** Is `epoch` still current for this host? Throws FENCED if not. */
export function check(name, opts = {}) {
  const s = settings(); const st = storeOf(opts, s);
  const { role } = resolveRole(name, { ...opts, store: st });
  const want = Number(opts.epoch);
  if (!Number.isInteger(want) || want < 1) throw new RoleError(EX.USAGE, 'check: --epoch N is required (TRACEGATE_ROLE_EPOCH in a `lease --role` command)');
  const rec = guardStore(() => st.read(role)).data;
  const now = Date.now();
  if (!rec || rec.epoch !== want) throw new RoleError(EX.FENCED, `${role}: epoch ${want} is no longer current (now ${rec?.epoch ?? 0}, held by ${who(rec?.holder)}). Stop before the irreversible step`);
  if (!rec.holder || rec.holder.host !== s.host) throw new RoleError(EX.FENCED, `${role}: epoch ${want} is not held by ${s.host}`);
  if (!live(rec, now)) throw new RoleError(EX.FENCED, `${role}: the lease expired at ${rec.until}; renew it (\`tracegate role renew ${role}\`) before continuing`);
  return rec;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const print = (o, json) => { if (json) { console.log(JSON.stringify(o, null, 2)); return; } };

function describe(r) {
  const rec = r.record;
  const lines = [`${r.role} (${r.scope}: ${r.why})`];
  if (!rec) lines.push('  never claimed');
  else {
    lines.push(`  epoch ${rec.epoch}, holder ${who(rec.holder)}${rec.holder ? `, until ${rec.until}${r.live ? '' : ' (EXPIRED: anyone may claim it)'}` : ''}${r.mine ? ' — this machine' : ''}`);
    if (rec.offer) lines.push(`  offered to ${rec.offer.to} by ${rec.offer.by} at ${rec.offer.at} (it takes effect when ${rec.offer.to} runs \`claim\`)`);
    for (const h of (rec.history ?? []).slice(-5)) lines.push(`  ${h.at}  epoch ${h.epoch} ${h.action.padEnd(8)} ${h.host}${h.previous ? ` (from ${h.previous.host}@${h.previous.epoch})` : ''}${h.preflight && h.preflight !== 'none' ? ` preflight ${h.preflight}` : ''}${h.reason ? ` — ${h.reason}` : ''}`);
  }
  return lines.join('\n');
}

/** `tracegate role <sub> [<role>] [options]` → exit code. */
export function roleCli(sub, name, o = {}) {
  try {
    if (sub === 'status') {
      const roles = name ? [name] : ['deployer'];
      for (const n of roles) { const r = status(n, o); if (o.json) print(r, true); else console.log(describe(r)); }
      return EX.OK;
    }
    if (sub === 'claim') {
      const rec = claim(name, o);
      console.log(`${rec.role}: held by ${rec.holder.host} at epoch ${rec.epoch} until ${rec.until}`);
      if (o.hold) return hold(name, o, rec);
      return EX.OK;
    }
    if (sub === 'renew') { const rec = renew(name, o); console.log(`${rec.role}: renewed, epoch ${rec.epoch}, until ${rec.until}`); return EX.OK; }
    if (sub === 'release') { const rec = release(name, o); console.log(`${rec.role}: released (epoch ${rec.epoch})`); return EX.OK; }
    if (sub === 'handover') { const rec = handover(name, o); console.log(`${rec.role}: offered to ${rec.offer.to}; ${rec.holder.host} keeps it until ${rec.offer.to} runs \`tracegate role claim ${rec.role}\``); return EX.OK; }
    if (sub === 'take') { const rec = take(name, o); console.log(`${rec.role}: taken by ${rec.holder.host} at epoch ${rec.epoch} until ${rec.until}`); return EX.OK; }
    if (sub === 'check') { const rec = check(name, o); console.log(`${rec.role}: epoch ${rec.epoch} is current, held by ${rec.holder.host} until ${rec.until}`); return EX.OK; }
    console.error('usage: tracegate role status [<role>] | claim <role> [--ttl 30m] [--hold] | renew <role> | release <role> | handover <role> --to <host> | take <role> --reason "…" [--skip-preflight] | check <role> --epoch N');
    return EX.USAGE;
  } catch (e) {
    if (!(e instanceof RoleError)) throw e;
    console.error(`tracegate role ${sub}: ${e.message}`);
    return e.exitCode;
  }
}

/** `claim --hold`: renew every third of the TTL until SIGINT/SIGTERM (then release) or the role is lost. */
function hold(name, o, rec) {
  const ttl = parseTtl(o.ttl);
  const every = Math.max(1000, Math.floor(ttl / 3));
  process.stderr.write(`tracegate role: holding ${rec.role} at epoch ${rec.epoch}, renewing every ${Math.round(every / 1000)} s\n`);
  return new Promise((resolve) => {
    const stop = (code) => { clearInterval(t); resolve(code); };
    const t = setInterval(() => {
      try { renew(name, { ...o, epoch: rec.epoch }); } catch (e) { process.stderr.write(`tracegate role: lost ${rec.role}: ${e.message}\n`); stop(e.exitCode ?? EX.FENCED); }
    }, every);
    const end = () => { try { release(name, o); process.stderr.write(`tracegate role: released ${rec.role}\n`); } catch (e) { process.stderr.write(`tracegate role: ${e.message}\n`); } stop(EX.OK); };
    process.once('SIGINT', end); process.once('SIGTERM', end);
  });
}
