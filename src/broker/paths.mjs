// Where the broker lives, and its configuration.
//
// The broker serves one ledger: every worktree of a clone shares it, so they all
// see one queue. Its state is <ledger>/broker/ (events.jsonl, broker.pid,
// advice-cache/). The socket lives in the OS temp dir instead, keyed by the
// ledger path, because unix socket paths are limited to ~104 bytes on macOS.
//
// tracegate.config.json:
//   "broker": {
//     "capacity": 8,                     tokens; default: the host's available parallelism
//     "idleMinutes": 30,                 exit after this long with nothing to do (0 = never)
//     "classes": { "gate": { "priority": 50, "preemptible": false }, ... }   merged over the defaults
//     "advisor": { "command": "…", "mode": "shadow" | "enforce", "version": "1" }
//   }
// Environment: TRACEGATE_BROKER_DIR, TRACEGATE_BROKER_SOCKET, TRACEGATE_BROKER_CAPACITY.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ctx } from '../config.mjs';
import { DEFAULT_CLASSES } from './core.mjs';

export const hostCapacity = () => (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);

export function brokerDir() {
  return process.env.TRACEGATE_BROKER_DIR ? path.resolve(process.env.TRACEGATE_BROKER_DIR) : path.join(ctx().ledger, 'broker');
}

export function socketPath() {
  if (process.env.TRACEGATE_BROKER_SOCKET) return path.resolve(process.env.TRACEGATE_BROKER_SOCKET);
  const h = crypto.createHash('sha256').update(brokerDir()).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `tracegate-${h}.sock`);
}

export function brokerConfig() {
  let raw = {};
  try { raw = ctx().broker ?? {}; } catch { /* not in a repo: defaults (TRACEGATE_BROKER_DIR must be set) */ }
  const envCap = Number(process.env.TRACEGATE_BROKER_CAPACITY);
  const capacity = Number.isInteger(envCap) && envCap > 0 ? envCap : Number.isInteger(raw.capacity) && raw.capacity > 0 ? raw.capacity : hostCapacity();
  const classes = { ...DEFAULT_CLASSES };
  for (const [k, v] of Object.entries(raw.classes ?? {})) classes[k] = { ...(DEFAULT_CLASSES[k] ?? { priority: 30, preemptible: false }), ...v };
  return { capacity, classes, idleMinutes: raw.idleMinutes ?? 30, advisor: raw.advisor ?? null };
}
