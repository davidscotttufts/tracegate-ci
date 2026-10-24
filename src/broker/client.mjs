// Talking to the broker: a connection (starting the broker if none is running),
// request/response calls, and `tracegate lease`, which runs a command under a lease.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brokerDir, socketPath } from './paths.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
export const EX_TEMPFAIL = 75; // preempted: try again later

/** Connect, starting a broker in the background if none answers. */
export async function connect({ autostart = true, timeoutMs = 8000 } = {}) {
  const sock = socketPath();
  const tryOnce = () => new Promise((resolve, reject) => {
    const s = net.connect(sock);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  try { return wrap(await tryOnce()); } catch (e) {
    if (!autostart || !['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e;
  }
  const dir = brokerDir();
  fs.mkdirSync(dir, { recursive: true });
  const out = fs.openSync(path.join(dir, 'broker.log'), 'a');
  const child = spawn(process.execPath, [CLI, 'broker', 'serve'], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  const until = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 100));
    try { return wrap(await tryOnce()); } catch (e) {
      if (Date.now() > until) throw new Error(`no broker on ${sock} after starting one (see ${path.join(dir, 'broker.log')}): ${e.code ?? e.message}`);
    }
  }
}

function wrap(s) {
  s.setEncoding('utf8');
  let buf = '';
  let ref = 0;
  const waiting = new Map();
  const listeners = new Set();
  s.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.ref !== undefined && waiting.has(m.ref)) { waiting.get(m.ref)(m); waiting.delete(m.ref); }
      for (const l of listeners) l(m);
    }
  });
  const closed = new Promise((r) => s.once('close', r));
  return {
    socket: s,
    closed,
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    send: (msg) => s.write(JSON.stringify(msg) + '\n'),
    call(msg) {
      const r = ++ref;
      return new Promise((resolve, reject) => {
        waiting.set(r, (m) => (m.type === 'error' ? reject(new Error(m.error)) : resolve(m)));
        s.write(JSON.stringify({ ...msg, ref: r }) + '\n');
      });
    },
    close: () => s.end(),
  };
}

/** One-shot calls for status, explain, history and cancel. */
export async function call(msg, opts) {
  const c = await connect(opts);
  try { return await c.call(msg); } finally { c.close(); }
}

/**
 * `tracegate lease [--class c] [--tokens n] [--exclusive] [--est s] [--label l]
 *                  [--deadline-min m] [--requeue] -- <command…>`
 * Waits for a grant, runs the command with TRACEGATE_LEASE / TRACEGATE_FENCE /
 * TRACEGATE_TOKENS / VITEST_MAX_WORKERS set, releases on exit, forwards the exit
 * code. Preempted: SIGTERM to the command's process group, exit 75 (or requeue).
 */
export async function lease(o, argv) {
  if (!argv.length) throw new Error('lease: nothing to run (put the command after --)');
  const req = {
    op: 'request',
    class: o.class && o.class !== true ? o.class : 'adhoc',
    tokens: o.tokens !== undefined ? Number(o.tokens) : 1,
    exclusive: !!o.exclusive,
    est: o.est !== undefined ? Number(o.est) : undefined,
    label: o.label && o.label !== true ? o.label : argv.join(' ').slice(0, 120),
    parent: process.env.TRACEGATE_LEASE || undefined,
    deadline: o['deadline-min'] !== undefined ? Date.now() + Number(o['deadline-min']) * 60_000 : undefined,
  };
  const quiet = !!o.quiet;
  const say = (m) => { if (!quiet) process.stderr.write(`tracegate lease: ${m}\n`); };
  for (;;) {
    const c = await connect();
    c.send({ op: 'hello', owner: `${process.pid}` });
    const rc = await new Promise((resolve) => {
      let id = null; let child = null; let preempted = false; let lastSay = 0;
      c.on((m) => {
        if (m.type === 'queued' && !id) {
          id = m.id;
          say(`${id} queued — ${m.explain?.text ?? ''}`); lastSay = Date.now();
        } else if (m.type === 'accepted' && !id) {
          id = m.id;
        } else if (m.type === 'granted' && m.id === (id ?? m.id) && !child) {
          id = m.id;
          say(`${id} granted ${m.tokens} token(s), fence ${m.fence}${m.nested ? ' (inside the parent lease)' : ''}`);
          child = spawn(argv[0], argv.slice(1), {
            stdio: 'inherit', detached: true,
            env: { ...process.env, TRACEGATE_LEASE: id, TRACEGATE_FENCE: String(m.fence), TRACEGATE_TOKENS: String(m.tokens), VITEST_MAX_WORKERS: String(m.tokens) },
          });
          const fwd = (sig) => { try { process.kill(-child.pid, sig); } catch { /* gone */ } };
          process.on('SIGINT', () => fwd('SIGINT'));
          process.on('SIGTERM', () => fwd('SIGTERM'));
          child.on('exit', (code, sig) => {
            const r = preempted ? EX_TEMPFAIL : code ?? (sig ? 128 + (os.constants.signals[sig] ?? 1) : 1);
            c.call({ op: 'release', id, reason: preempted ? 'preempted' : 'done' }).catch(() => {}).finally(() => { c.close(); resolve(r); });
          });
          child.on('error', (e) => { say(`could not start ${argv[0]}: ${e.message}`); c.call({ op: 'release', id }).catch(() => {}).finally(() => { c.close(); resolve(127); }); });
        } else if (m.type === 'preempt' && m.id === id && child) {
          preempted = true;
          say(`${id} preempted for ${m.by} — stopping the command`);
          try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
          setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 10_000).unref();
        } else if (m.type === 'ended' && m.id === id) {
          if (child) { say(`${id} ended by the broker (${m.reason}) — stopping the command`); preempted = true; try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }
          else { say(`${id} ${m.reason === 'deadline' ? 'expired before it could start' : `ended (${m.reason})`}`); c.close(); resolve(m.reason === 'deadline' ? EX_TEMPFAIL : 1); }
        } else if (m.type === 'error') {
          say(`broker refused: ${m.error}`); c.close(); resolve(2);
        }
      });
      const heartbeat = setInterval(() => {
        if (child || !id || quiet || Date.now() - lastSay < 60_000) return;
        c.call({ op: 'explain', id }).then((e) => { say(`${id} still waiting — ${e.text}`); lastSay = Date.now(); }).catch(() => {});
      }, 5_000);
      heartbeat.unref();
      c.closed.then(() => { clearInterval(heartbeat); if (!child) resolve(id ? 1 : 2); else if (child.exitCode === null) say('lost the broker connection; the command keeps running without a lease'); });
      c.send(req);
    });
    if (rc === EX_TEMPFAIL && o.requeue) { say('requeueing'); continue; }
    return rc;
  }
}
