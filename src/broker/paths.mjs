// Where the broker lives, and its configuration.
//
// The broker serves one ledger ON ONE HOST: every worktree of a clone shares it,
// so they all see one queue. Its state is <ledger>/broker/<host>/ (events.jsonl,
// broker.pid, advice-cache/). It is per host because what it learns (durations,
// memory per worker) and the capacity it hands out are properties of one
// machine, and a ledger may sit on storage several machines share. The socket lives in the OS temp dir instead, keyed by the
// ledger path, because unix socket paths are limited to ~104 bytes on macOS.
//
// tracegate.config.json:
//   "broker": {
//     "capacity": 8,                     tokens; default: this host's cores (a container's
//                                        CPU quota counts). A number, or a share of the
//                                        cores: "75%".
//     "idleMinutes": 30,                 exit after this long with nothing to do (0 = never)
//     "adaptive": { "mode": "on" | "shadow" | "off", ... }   see src/broker/adapt.mjs
//     "hosts": { "<host>": { "capacity": …, "adaptive": {…} } }   per-machine overrides
//     "classes": { "gate": { "priority": 50, "preemptible": false }, ... }   merged over the defaults
//     "advisor": { "command": "…", "mode": "shadow" | "enforce", "version": "1" }
//   }
// Environment: TRACEGATE_BROKER_DIR, TRACEGATE_BROKER_SOCKET, TRACEGATE_BROKER_CAPACITY,
// TRACEGATE_BROKER_ADAPTIVE (off|shadow|on), TRACEGATE_BROKER_SAMPLE_FILE (sampler.mjs).
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

const hostName = () => { try { return ctx().host; } catch { return (os.hostname().split('.')[0] || 'host').replace(/[^A-Za-z0-9_-]/g, '_'); } };

export function brokerDir() {
  return process.env.TRACEGATE_BROKER_DIR ? path.resolve(process.env.TRACEGATE_BROKER_DIR) : path.join(ctx().ledger, 'broker', hostName());
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
  const h = crypto.createHash('sha256').update(brokerDir()).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `tracegate-${h}.sock`);
}

export function brokerConfig() {
  let raw = {};
  try { raw = ctx().broker ?? {}; } catch { /* not in a repo: defaults (TRACEGATE_BROKER_DIR must be set) */ }
  // One committed config serves every machine: a host's own block wins.
  const mine = raw.hosts?.[hostName()] ?? {};
  const capacity = capacityOf(process.env.TRACEGATE_BROKER_CAPACITY) ?? capacityOf(mine.capacity) ?? capacityOf(raw.capacity) ?? hostCapacity();
  const adaptive = resolvePolicy({ ...(raw.adaptive ?? {}), ...(mine.adaptive ?? {}), ...(process.env.TRACEGATE_BROKER_ADAPTIVE ? { mode: process.env.TRACEGATE_BROKER_ADAPTIVE } : {}) });
  const classes = { ...DEFAULT_CLASSES };
  for (const [k, v] of Object.entries(raw.classes ?? {})) classes[k] = { ...(DEFAULT_CLASSES[k] ?? { priority: 30, preemptible: false }), ...v };
  return { capacity, classes, adaptive, host: hostName(), idleMinutes: raw.idleMinutes ?? 30, advisor: raw.advisor ?? null };
}
