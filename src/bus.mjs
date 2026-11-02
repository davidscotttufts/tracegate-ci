// The release bus (optional): what OTHER machines are gating, deploying or releasing.
//
// The broker sees one machine. Two machines that share a repository (two laptops, a
// laptop and a build box) can each start a train or a deploy while the other's is
// running, and neither knows. The bus is one small shared record both can read:
//   state     the live leases, one per running gate, deploy or release, each with the
//             host, session, kind, lane, PRs, tree and a time it expires
//   events/   one create-only JSON object per start, result, end or note
//
// RULES (each has a test in test/bus.mjs and a sabotage witness):
//   - ADVISORY. A lease never holds anything. A reader WARNS that another machine is
//     busy; nothing here ever waits for, refuses or freezes another machine's work.
//   - An expired lease is STALE: a crashed train or a closed laptop lid reads as
//     stale, never as busy. Writes drop leases a day past their expiry.
//   - No lock. The state is written by compare-and-swap on its generation; a writer
//     that lost the race re-reads and re-applies its change.
//   - Never fail the caller. One deadline for the whole call; no CLI, no login,
//     offline, a hung call or a malformed record all return { ok: false, why }, and
//     the command that asked carries on with its own exit code.
//
// Stores:
//   "bus": "gs://bucket[/prefix]"   Google Cloud Storage through the gcloud CLI
//                                   (TRACEGATE_GCLOUD names another binary)
//   "bus": "/shared/dir"            a directory: a shared disk, and every test
//   TRACEGATE_BUS=<url>|off         overrides the config
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ctx } from './config.mjs';

export const KINDS = ['gate', 'train', 'deploy', 'release', 'note'];
// About twice each kind's typical length, so a slow run is not read as stale.
export const LEASE_MIN = { gate: 90, train: 180, deploy: 40, release: 40, note: 0 };
const DROP_AFTER_MS = 24 * 3600_000;
const TEXT_MAX = 500;
// A note is read by other sessions and kept for months: refuse anything shaped like a key.
const SECRET = /\b(gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

/** The configured store, or null when there is none or it is turned off. */
export function busUrl() {
  const env = process.env.TRACEGATE_BUS;
  if (env === 'off') return null;
  if (env) return env;
  let c; try { c = ctx(); } catch { return null; }
  const v = c.bus;
  if (!v) return null;
  return typeof v === 'string' ? v : v.url ?? null;
}

const timeoutMs = () => Number(process.env.TRACEGATE_BUS_TIMEOUT_MS) || 10_000;
const hostName = () => { try { return ctx().host; } catch { return 'host'; } };
const session = () => process.env.TRACEGATE_SESSION || process.env.CLAUDE_CODE_SESSION_ID || '';
const stamp = (t = new Date()) => t.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const eventName = () => `${stamp()}-${hostName()}-${crypto.randomBytes(3).toString('hex')}.json`;

// ── stores ───────────────────────────────────────────────────────────────────
// Both offer: read() → { gen, data }, write(gen, data) → true | false (lost the race),
// event(name, data), events(n) → [data].

/** A directory. The state is a series of generations, `state/<gen>.json`, and the
 *  highest is current. A write creates the next generation with link(2), which fails
 *  if that name exists, so of two writers exactly one wins, with no lock file. */
function dirStore(root) {
  const st = path.join(root, 'state');
  const ev = path.join(root, 'events');
  const gens = () => { try { return fs.readdirSync(st).map((f) => /^(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])); } catch { return []; } };
  return {
    read() {
      const g = gens();
      if (!g.length) return { gen: 0, data: null };
      const gen = Math.max(...g);
      return { gen, data: JSON.parse(fs.readFileSync(path.join(st, `${gen}.json`), 'utf8')) };
    },
    write(gen, data) {
      fs.mkdirSync(st, { recursive: true });
      const tmp = path.join(st, `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      fs.writeFileSync(tmp, JSON.stringify(data));
      try { fs.linkSync(tmp, path.join(st, `${gen + 1}.json`)); }
      catch (e) { if (e.code === 'EEXIST') return false; throw e; }
      finally { fs.rmSync(tmp, { force: true }); }
      for (const g of gens()) if (g < gen - 20) fs.rmSync(path.join(st, `${g}.json`), { force: true });
      return true;
    },
    event(name, data) {
      fs.mkdirSync(ev, { recursive: true });
      fs.writeFileSync(path.join(ev, name), JSON.stringify(data), { flag: 'wx' });
    },
    events(n) {
      let names = []; try { names = fs.readdirSync(ev).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
      return names.slice(-n).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(ev, f), 'utf8')); } catch { return null; } }).filter(Boolean);
    },
  };
}

/** Google Cloud Storage through the gcloud CLI. The state object is read pinned to its
 *  generation and written with `--if-generation-match`, so a concurrent write is a 412
 *  and the loser retries. Events are written with `--if-generation-match=0`: create-only. */
function gcsStore(url, deadline) {
  const base = url.replace(/\/+$/, '');
  const bin = process.env.TRACEGATE_GCLOUD || 'gcloud';
  const g = (args, input) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('timed out');
    const r = spawnSync(bin, args, { input, encoding: 'utf8', timeout: left, stdio: ['pipe', 'pipe', 'pipe'] });
    if (r.error) throw new Error(r.error.code === 'ENOENT' ? `${bin} not found` : r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message);
    return r;
  };
  const why = (r) => (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').pop().slice(0, 200);
  const notFound = (r) => /not ?found|404|No URLs matched|does not exist/i.test(r.stderr || '');
  const obj = `${base}/state.json`;
  return {
    read() {
      const d = g(['storage', 'objects', 'describe', obj, '--format=value(generation)']);
      if (d.status !== 0) { if (notFound(d)) return { gen: 0, data: null }; throw new Error(why(d)); }
      const gen = Number(d.stdout.trim());
      if (!Number.isFinite(gen)) throw new Error(`bad generation ${JSON.stringify(d.stdout.trim())}`);
      const c = g(['storage', 'cat', `${obj}#${gen}`]);
      if (c.status !== 0) { if (notFound(c)) return this.read(); throw new Error(why(c)); } // replaced between the two calls
      return { gen, data: JSON.parse(c.stdout) };
    },
    write(gen, data) {
      const r = g(['storage', 'cp', '-', obj, `--if-generation-match=${gen}`], JSON.stringify(data));
      if (r.status === 0) return true;
      if (/412|precondition/i.test(r.stderr || '')) return false;
      throw new Error(why(r));
    },
    event(name, data) {
      const r = g(['storage', 'cp', '-', `${base}/events/${name}`, '--if-generation-match=0'], JSON.stringify(data));
      if (r.status !== 0) throw new Error(why(r));
    },
    events(n) {
      const l = g(['storage', 'ls', `${base}/events/`]);
      if (l.status !== 0) { if (notFound(l)) return []; throw new Error(why(l)); }
      return l.stdout.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.json')).sort().slice(-n)
        .map((u) => { const c = g(['storage', 'cat', u]); try { return c.status === 0 ? JSON.parse(c.stdout) : null; } catch { return null; } }).filter(Boolean);
    },
  };
}

function open() {
  const url = busUrl();
  if (!url) return null;
  const deadline = Date.now() + timeoutMs();
  let store;
  if (url.startsWith('gs://')) store = gcsStore(url, deadline);
  else {
    let root = url.replace(/^file:\/\//, '');
    try { root = path.resolve(ctx().root, root); } catch { root = path.resolve(root); }
    store = dirStore(root);
  }
  return { url, store, deadline };
}

/** Run `fn` against the store. Never throws: every failure is { ok: false, why }. */
function guarded(fn) {
  let b;
  try { b = open(); } catch (e) { return { ok: false, why: e.message }; }
  if (!b) return { ok: false, why: 'off' };
  try { return { ok: true, ...fn(b) }; } catch (e) { return { ok: false, why: e.message || String(e) }; }
}

const clean = (data, now = Date.now()) => ({
  version: 1,
  leases: (Array.isArray(data?.leases) ? data.leases : []).filter((l) => l && typeof l === 'object' && !(Date.parse(l.leaseUntil) + DROP_AFTER_MS < now)),
});

/** Compare-and-swap loop: re-read and re-apply until the write lands or time runs out. */
function update(b, change) {
  for (;;) {
    if (Date.now() > b.deadline) throw new Error('timed out (the state kept changing)');
    const { gen, data } = b.store.read();
    const next = change(clean(data));
    next.updatedAt = new Date().toISOString();
    if (b.store.write(gen, next)) return next;
  }
}

const text = (v) => {
  if (v === undefined || v === null || v === true) return undefined;
  const s = String(v).slice(0, TEXT_MAX);
  if (SECRET.test(s)) throw new Error('refused: the text looks like it contains a credential');
  return s;
};

function event(b, kind, fields) {
  const e = { at: new Date().toISOString(), host: hostName(), session: session() || undefined, kind, ...fields };
  b.store.event(eventName(), e);
  return e;
}

/** Take a lease for work this machine is starting. Advisory: it never waits. */
export function claim(o = {}) {
  return guarded((b) => {
    const kind = o.kind && o.kind !== true ? String(o.kind) : 'gate';
    if (!KINDS.includes(kind) || kind === 'note') throw new Error(`claim: kind must be one of ${KINDS.filter((k) => k !== 'note').join(', ')}`);
    const minutes = Number(o.leaseMin) > 0 ? Number(o.leaseMin) : LEASE_MIN[kind];
    const now = new Date();
    const lease = {
      id: `${hostName()}-${stamp(now)}-${crypto.randomBytes(3).toString('hex')}`,
      host: hostName(), session: session() || undefined, kind,
      lane: o.lane && o.lane !== true ? String(o.lane) : undefined,
      target: o.target && o.target !== true ? String(o.target) : undefined,
      prs: Array.isArray(o.prs) ? o.prs.map(String).slice(0, 50) : undefined,
      tree: o.tree && o.tree !== true ? String(o.tree) : undefined,
      note: text(o.note),
      startedAt: now.toISOString(),
      leaseUntil: new Date(now.getTime() + minutes * 60_000).toISOString(),
    };
    update(b, (s) => ({ ...s, leases: [...s.leases, lease] }));
    event(b, 'start', { lease: lease.id, work: kind, lane: lease.lane, target: lease.target, prs: lease.prs });
    return { id: lease.id, lease };
  });
}

/** End a lease, with what happened. Releasing a lease that is already gone is fine. */
export function release(id, o = {}) {
  return guarded((b) => {
    if (!id || id === true) throw new Error('release: a lease id is required');
    let found = null;
    update(b, (s) => ({ ...s, leases: s.leases.filter((l) => (l.id === id ? ((found = l), false) : true)) }));
    const e = event(b, 'end', { lease: id, work: found?.kind, result: text(o.result), tree: o.tree && o.tree !== true ? String(o.tree) : undefined, landed: o.landed, rejected: o.rejected });
    return { released: !!found, event: e };
  });
}

/** A note for the other sessions and machines: `to` is a session, a host, or `*`. */
export function note(o = {}) {
  return guarded((b) => {
    const t = text(o.text);
    if (!t) throw new Error('note: --text is required');
    return { event: event(b, 'note', { to: o.to && o.to !== true ? String(o.to) : '*', text: t }) };
  });
}

/** Every lease (live and stale) and the latest events. */
export function busStatus(o = {}) {
  return guarded((b) => {
    const now = Date.now();
    const host = hostName();
    const { data } = b.store.read();
    const leases = clean(data, now).leases.map((l) => ({ ...l, stale: !(Date.parse(l.leaseUntil) > now), mine: l.host === host }));
    const n = Number(o.n) > 0 ? Number(o.n) : 10;
    return { url: b.url, host, leases, events: b.store.events(n) };
  });
}

/** Live leases held by OTHER machines: what a train or deploy should warn about. */
export function othersLive(o = {}) {
  const s = busStatus({ n: 1 });
  if (!s.ok) return s;
  const kinds = o.kinds ?? null;
  return { ok: true, leases: s.leases.filter((l) => !l.mine && !l.stale && (!kinds || kinds.includes(l.kind))) };
}

/** One line per live lease from another machine, for a caller to print. Never throws. */
export function warnings(o = {}) {
  const r = othersLive(o);
  if (!r.ok) return r.why === 'off' ? [] : [`bus: unavailable (${r.why})`];
  return r.leases.map((l) => `WARN bus: ${l.host} is running a ${l.kind}${l.lane ? ` (${l.lane})` : ''}${l.prs?.length ? ` of ${l.prs.join(', ')}` : ''} since ${l.startedAt.slice(11, 16)}Z, lease until ${l.leaseUntil.slice(11, 16)}Z${l.session ? ` [${l.session}]` : ''}`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
export function bus(sub, o) {
  const fail = (r) => { console.log(`tracegate bus: ${r.why === 'off' ? 'no bus configured ("bus" in tracegate.config.json, or TRACEGATE_BUS)' : `unavailable (${r.why})`}`); return 0; };
  if (sub === 'status' || sub === undefined) {
    const r = busStatus(o);
    if (!r.ok) return fail(r);
    if (o.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
    console.log(`bus ${r.url} (this machine: ${r.host})`);
    if (!r.leases.length) console.log('  no leases');
    for (const l of r.leases) console.log(`  ${l.stale ? 'STALE' : 'live '} ${l.kind.padEnd(7)} ${l.host}${l.mine ? ' (here)' : ''}${l.lane ? ` ${l.lane}` : ''}${l.prs?.length ? ` [${l.prs.join(', ')}]` : ''}  since ${l.startedAt}  until ${l.leaseUntil}  ${l.id}`);
    for (const e of r.events) console.log(`  ${e.at}  ${e.host}  ${e.kind}${e.work ? ` ${e.work}` : ''}${e.result ? `: ${e.result}` : ''}${e.text ? `: ${e.text}` : ''}${e.to && e.to !== '*' ? ` → ${e.to}` : ''}`);
    return 0;
  }
  if (sub === 'claim') {
    const r = claim({ ...o, leaseMin: o['lease-min'], prs: o.pr && o.pr !== true ? String(o.pr).split(',').filter(Boolean) : undefined });
    if (!r.ok) { if (/kind must|refused/.test(r.why)) { console.error(`tracegate bus: ${r.why}`); return 2; } return fail(r); }
    console.log(r.id); return 0;
  }
  if (sub === 'release') { const r = release(o._id, o); if (!r.ok) return fail(r); console.log(`tracegate bus: ${r.released ? 'released' : 'no such live lease;'} ${o._id}`); return 0; }
  if (sub === 'note') { const r = note(o); if (!r.ok) { if (/refused|required/.test(r.why)) { console.error(`tracegate bus: ${r.why}`); return 2; } return fail(r); } console.log('tracegate bus: note sent'); return 0; }
  if (sub === 'warn') { for (const w of warnings()) console.log(w); return 0; }
  throw new Error('bus: status [--json] [--n 10] | claim --kind gate|train|deploy|release [--lane l] [--pr a,b] [--lease-min m] [--note t] | release <id> [--result r] | note --text t [--to session|host|*] | warn');
}
