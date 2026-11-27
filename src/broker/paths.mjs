// Where the broker lives, and its configuration.
//
// ONE BROKER PER MACHINE (scope `machine`, the default after 0.10.x). Every repo
// and every worktree on this host, for this user, talks to the same broker, so a
// daemon in one repo yields to a gate in another and the machine's capacity is
// handed out once. Its state is $HOME/.tracegate/broker/<host>/ (events.jsonl,
// broker.pid, broker.log, advice-cache/). It is per host because what it learns
// (durations, memory per worker) and the capacity it hands out are properties of
// one machine, and a home directory may sit on storage several machines share.
// The socket lives in the OS temp dir (per user on macOS), named by the user id
// and a hash of that directory, because unix socket paths are limited to ~104
// bytes on macOS.
//
// What a broker LEARNS is still per ledger: every job carries the ledger it came
// from, and durations and memory are keyed by (class, label, ledger), so two repos'
// "gate main" never share an estimate. `tracegate queue` shows each job's repo.
//
// The first broker to start reads ITS repo's config (capacity, classes, adaptive,
// advisor) and keeps it until it exits. A client whose own config says otherwise
// gets a warning naming the repo that started the broker; it is not refused.
//
// Scope `ledger` (TRACEGATE_BROKER_SCOPE=ledger, or "broker": {"scope": "ledger"})
// restores the old layout exactly: state in <ledger>/broker/<host>/ and the socket
// keyed by that directory, so a ledger-scoped client still finds a broker an older
// version started. Such a broker sees only its own ledger's work.
//
// tracegate.config.json:
//   "broker": {
//     "scope": "machine" | "ledger",     default machine (see above)
//     "capacity": 8,                     tokens; default: this host's cores (a container's
//                                        CPU quota counts). A number, or a share of the
//                                        cores: "75%".
//     "idleMinutes": 30,                 exit after this long with nothing to do (0 = never)
//     "adaptive": { "mode": "on" | "shadow" | "off", ... }   see src/broker/adapt.mjs
//     "hosts": { "<host>": { "capacity": …, "adaptive": {…} } }   per-machine overrides
//     "classes": { "gate": { "priority": 50, "preemptible": false }, ... }   merged over the defaults
//     "advisor": { "command": "…", "mode": "shadow" | "enforce", "version": "1" }
//   }
// Environment: TRACEGATE_BROKER_SCOPE (machine|ledger), TRACEGATE_BROKER_DIR,
// TRACEGATE_BROKER_SOCKET, TRACEGATE_BROKER_CAPACITY, TRACEGATE_BROKER_ADAPTIVE
// (off|shadow|on), TRACEGATE_BROKER_SAMPLE_FILE (sampler.mjs). An explicit
// TRACEGATE_BROKER_DIR or TRACEGATE_BROKER_SOCKET wins over the scope.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ctx } from '../config.mjs';
import { resolvePolicy } from './adapt.mjs';
import { DEFAULT_CLASSES } from './core.mjs';
import { parseCgroupCpu } from './sampler.mjs';

/** This host's cores: the available parallelism, within a container's CPU quota. */
export function hostCapacity() {
  const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  let quota = null;
  if (process.platform === 'linux') { try { quota = parseCgroupCpu(fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8')); } catch { /* no cgroup v2 */ } }
  return quota === null ? n : Math.max(1, Math.min(n, quota));
}

// The socket protocol (docs/design/broker.md §5.2). Bump it when a client needs
// something an older broker would silently ignore. 1: everything up to 0.10.x (its
// brokers send no number). 2 (after 0.10.x): ledger/repo on requests, `onDemand`.
export const PROTOCOL = 2;
// The oldest client protocol this broker serves. A client without a number is 1.
export const MIN_CLIENT_PROTOCOL = 1;
// A client that cannot use the broker on its socket exits with this (sysexits EX_PROTOCOL).
export const EX_PROTOCOL = 76;

/** This package's version, or null when the broker files are vendored without package.json. */
export function packageVersion() {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? null; } catch { return null; }
}

const hostName = () => { try { return ctx().host; } catch { return (os.hostname().split('.')[0] || 'host').replace(/[^A-Za-z0-9_-]/g, '_'); } };

export const SCOPES = Object.freeze(['machine', 'ledger']);

/** `machine` (one broker per host, the default) or `ledger` (one per ledger, as in 0.10.x). */
export function brokerScope() {
  let fromConfig;
  try { fromConfig = ctx().broker?.scope; } catch { /* not in a repo */ }
  const v = String(process.env.TRACEGATE_BROKER_SCOPE || fromConfig || 'machine').trim().toLowerCase();
  if (!SCOPES.includes(v)) throw new Error(`broker scope must be one of ${SCOPES.join(', ')} (got ${JSON.stringify(v)}, from ${process.env.TRACEGATE_BROKER_SCOPE ? 'TRACEGATE_BROKER_SCOPE' : 'broker.scope in the config'})`);
  return v;
}

export function brokerDir() {
  if (process.env.TRACEGATE_BROKER_DIR) return path.resolve(process.env.TRACEGATE_BROKER_DIR);
  if (brokerScope() === 'ledger') return path.join(ctx().ledger, 'broker', hostName());
  return path.join(os.homedir(), '.tracegate', 'broker', hostName());
}

/**
 * Which ledger (and so which repo) this process works for, or nulls outside a repo.
 * Sent with every request: the broker keys what it learns by it, and shows `repo`.
 */
export function ledgerIdentity() {
  try {
    const ledger = ctx().ledger;
    // <clone>/.git/tracegate → "clone"; a configured ledger dir → its own name.
    let d = ledger;
    if (path.basename(d) === 'tracegate') d = path.dirname(d);
    if (path.basename(d) === '.git') d = path.dirname(d);
    return { ledger, repo: path.basename(d) || ledger };
  } catch { return { ledger: null, repo: null }; }
}

/** A capacity setting: a positive integer, or a share of this host's cores ("75%"). */
export function capacityOf(v, cores = hostCapacity()) {
  if (Number.isInteger(v) && v > 0) return v;
  const m = /^(\d+(?:\.\d+)?)%$/.exec(String(v ?? '').trim());
  if (m && Number(m[1]) > 0) return Math.max(1, Math.floor((cores * Number(m[1])) / 100));
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function socketPath() {
  if (process.env.TRACEGATE_BROKER_SOCKET) return path.resolve(process.env.TRACEGATE_BROKER_SOCKET);
  const dir = brokerDir();
  // Scope `ledger`, or an explicit directory, keeps the old name byte for byte (a hash
  // of the directory), so it still reaches a broker an older version started there.
  if (process.env.TRACEGATE_BROKER_DIR || brokerScope() === 'ledger') return path.join(os.tmpdir(), `tracegate-${crypto.createHash('sha256').update(dir).digest('hex').slice(0, 12)}.sock`);
  // Machine scope: one name per (user, host), short enough for the macOS limit.
  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username;
  const h = crypto.createHash('sha256').update(`machine\u0000${hostName()}\u0000${uid}\u0000${dir}`).digest('hex').slice(0, 10);
  return path.join(os.tmpdir(), `tracegate-m${uid}-${h}.sock`);
}

export function brokerConfig() {
  let raw = {};
  try { raw = ctx().broker ?? {}; } catch { /* not in a repo: defaults */ }
  // One committed config serves every machine: a host's own block wins.
  const mine = raw.hosts?.[hostName()] ?? {};
  const capacity = capacityOf(process.env.TRACEGATE_BROKER_CAPACITY) ?? capacityOf(mine.capacity) ?? capacityOf(raw.capacity) ?? hostCapacity();
  const adaptive = resolvePolicy({ ...(raw.adaptive ?? {}), ...(mine.adaptive ?? {}), ...(process.env.TRACEGATE_BROKER_ADAPTIVE ? { mode: process.env.TRACEGATE_BROKER_ADAPTIVE } : {}) });
  const classes = { ...DEFAULT_CLASSES };
  for (const [k, v] of Object.entries(raw.classes ?? {})) classes[k] = { ...(DEFAULT_CLASSES[k] ?? { priority: 30, preemptible: false }), ...v };
  return { capacity, classes, adaptive, host: hostName(), scope: brokerScope(), idleMinutes: raw.idleMinutes ?? 30, advisor: raw.advisor ?? null };
}
