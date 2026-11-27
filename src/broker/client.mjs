// Talking to the broker: a connection (starting the broker if none is running),
// request/response calls, and `tracegate lease`, which runs a command under a lease.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brokerConfig, brokerDir, EX_PROTOCOL, ledgerIdentity, packageVersion, PROTOCOL, socketPath } from './paths.mjs';

// The broker-only entry: autostart loads nothing but the broker (see main.mjs).
const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.mjs');
export const EX_TEMPFAIL = 75; // preempted: try again later
export { EX_PROTOCOL }; // the broker on the socket cannot serve this client (76)

/** The broker on the socket cannot serve this client. Nothing is started beside it. */
export class BrokerProtocolError extends Error {
  constructor(message) { super(message); this.code = 'EBROKERPROTO'; this.exitCode = EX_PROTOCOL; }
}

const warned = new Set();
const warnOnce = (key, text) => { if (warned.has(key)) return; warned.add(key); process.stderr.write(`tracegate broker: ${text}\n`); };

/**
 * Connect, starting a broker in the background if none answers, then shake hands.
 * `need` is the lowest broker protocol this caller can use (2 for --on-demand): an
 * older broker on the socket is refused with BrokerProtocolError, never replaced and
 * never run beside. `hello` adds fields to the handshake (owner, pid).
 */
export async function connect({ autostart = true, timeoutMs = 8000, need = 1, hello = {} } = {}) {
  const sock = socketPath();
  // The socket sits in a temp dir: never talk to one another user put there.
  if (typeof process.getuid === 'function') {
    let st = null; try { st = fs.lstatSync(sock); } catch { /* none yet */ }
    if (st && st.uid !== process.getuid()) throw new Error(`refusing the broker socket ${sock}: it belongs to uid ${st.uid}, not to you (${process.getuid()})`);
  }
  const tryOnce = () => new Promise((resolve, reject) => {
    const s = net.connect(sock);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  let c = null;
  try { c = wrap(await tryOnce()); } catch (e) {
    if (!autostart || !['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e;
  }
  if (!c) c = await start(sock, timeoutMs, tryOnce);
  try { await handshake(c, sock, need, hello); } catch (e) { c.close(); throw e; }
  return c;
}

async function handshake(c, sock, need, extra) {
  const me = ledgerIdentity();
  let mine = null; try { mine = brokerConfig(); } catch { /* not in a repo, or a bad scope: no comparison */ }
  const ref = `hello-${process.pid}-${Date.now()}`;
  const reply = await new Promise((resolve) => {
    const t = setTimeout(() => { off(); resolve(null); }, 30_000); // generous: a broker on a swapping machine answers slowly
    // A 0.10.x broker answers hello without a ref; anything newer echoes it.
    const off = c.on((m) => {
      if ((m.type === 'hello' && (m.ref === ref || m.ref === undefined)) || (m.type === 'error' && m.ref === ref)) { clearTimeout(t); off(); resolve(m); }
    });
    c.send({ op: 'hello', ref, protocol: PROTOCOL, version: packageVersion(), ...me, ...(mine ? { capacity: mine.capacity } : {}), ...extra });
  });
  if (!reply) throw new BrokerProtocolError(`the broker on ${sock} did not answer the handshake within 30 s; nothing was started beside it (stop it with \`tracegate broker stop\`, or kill the pid in ${path.join(brokerDir(), 'broker.pid')})`);
  if (reply.type === 'error') throw new BrokerProtocolError(`${reply.error}. Upgrade this repo's tracegate-ci, or run a broker of its own with TRACEGATE_BROKER_SCOPE=ledger`);
  const theirs = Number.isInteger(reply.protocol) ? reply.protocol : 1;
  const who = `the broker on ${sock} (pid ${reply.pid ?? '?'}, tracegate-ci ${reply.version ?? (theirs === 1 ? '0.10.x or older' : '?')}, protocol ${theirs}${reply.startedBy?.repo ? `, started by ${reply.startedBy.repo}` : ''})`;
  if (theirs < need) throw new BrokerProtocolError(`${who} cannot honour this request: it needs protocol ${need} or later, and an older broker would silently ignore what it adds. Nothing was started beside it. Stop it once its jobs end (\`tracegate broker stop\`) so the next lease starts a current one`);
  if (theirs < PROTOCOL) warnOnce(`old:${sock}`, `${who} is older than this client (protocol ${PROTOCOL}); it does not record which repo a job came from, or serve --on-demand. Stop it once its jobs end to start a current one`);
  if (mine && Number.isInteger(reply.capacity) && reply.capacity !== mine.capacity && reply.startedBy?.ledger !== me.ledger) {
    warnOnce(`cap:${sock}`, `${who} hands out ${reply.capacity} token(s); this repo's config gives ${mine.capacity}. One broker serves the whole machine, and the config of the repo that started it wins until it exits${reply.startedBy?.config ? ` (${reply.startedBy.config})` : ''}`);
  }
  c.broker = reply;
}

async function start(sock, timeoutMs, tryOnce) {
  const dir = brokerDir();
  fs.mkdirSync(dir, { recursive: true });
  const out = fs.openSync(path.join(dir, 'broker.log'), 'a');
  // Another client may have started one meanwhile: the duplicate exits (server.mjs listen).
  const child = spawn(process.execPath, [MAIN, 'serve'], { detached: true, stdio: ['ignore', out, out], env: process.env });
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
 * Phase 0.5c: a make-compatible jobserver for one lease. GNU make 4.4+, Ninja
 * 1.13+, cargo and rustc read `--jobserver-auth=fifo:PATH` from MAKEFLAGS: each
 * job beyond the first takes one byte from the FIFO and puts it back when done,
 * so a whole build tree stays within the lease's grant. The lease itself is the
 * implicit first token, so the FIFO holds tokens − 1. Returns null for one token.
 */
export function makeJobserver(tokens) {
  if (!(tokens > 1)) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-js-'));
  const fifo = path.join(dir, 'jobserver');
  const r = spawnSync('mkfifo', ['-m', '600', fifo]);
  if (r.status !== 0) { fs.rmSync(dir, { recursive: true, force: true }); return null; }
  // Held open read-write by the lease for its whole life: a FIFO with no writer
  // left reads EOF, which make treats as a broken jobserver.
  const fd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  fs.writeSync(fd, Buffer.alloc(tokens - 1, '+'));
  const flags = `-j${tokens} --jobserver-auth=fifo:${fifo}`;
  return {
    fifo, flags,
    env: { MAKEFLAGS: flags, CARGO_MAKEFLAGS: flags },
    /** Tokens back in the FIFO now (a child that died holding one leaks it until the lease ends). */
    available() { const b = Buffer.alloc(tokens); let n = 0; try { n = fs.readSync(fd, b, 0, tokens, null); } catch { n = 0; } if (n > 0) fs.writeSync(fd, b.subarray(0, n)); return n; },
    close() { try { fs.closeSync(fd); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * `tracegate lease [--class c] [--tokens n] [--min-tokens m] [--mem-per-token MB]
 *                  [--exclusive] [--est s] [--label l] [--deadline-min m] [--requeue]
 *                  [--on-demand] -- <command…>`
 * `--on-demand` (I12) is for work a person asked for now, such as a deploy: it goes
 * ahead of every queued job and preemptible work yields to it at once; it still
 * never stops a running gate. It needs a protocol-2 broker: against an older one it
 * exits 76 (EX_PROTOCOL) without running the command, rather than be quietly queued.
 * Waits for a grant, runs the command with TRACEGATE_LEASE / TRACEGATE_FENCE /
 * TRACEGATE_TOKENS / VITEST_MAX_WORKERS (the granted width, which under adaptive
 * capacity may be less than --tokens and no less than --min-tokens), and
 * TRACEGATE_CONTENDED=1 when the broker started it on a busy machine past its
 * starvation limit. Releases on exit, forwards the exit code. Preempted: SIGTERM
 * to the command's process group, exit 75 (or requeue). `--jobserver` also
 * exports a make jobserver sized to the grant (makeJobserver, Phase 0.5c).
 */
export async function lease(o, argv) {
  if (!argv.length) throw new Error('lease: nothing to run (put the command after --)');
  const req = {
    op: 'request',
    class: o.class && o.class !== true ? o.class : 'adhoc',
    tokens: o.tokens !== undefined ? Number(o.tokens) : 1,
    minTokens: o['min-tokens'] !== undefined ? Number(o['min-tokens']) : undefined,
    memPerToken: o['mem-per-token'] !== undefined ? Number(o['mem-per-token']) : undefined,
    exclusive: !!o.exclusive,
    est: o.est !== undefined ? Number(o.est) : undefined,
    label: o.label && o.label !== true ? o.label : argv.join(' ').slice(0, 120),
    parent: process.env.TRACEGATE_LEASE || undefined,
    deadline: o['deadline-min'] !== undefined ? Date.now() + Number(o['deadline-min']) * 60_000 : undefined,
    ...ledgerIdentity(),
    ...(o['on-demand'] ? { onDemand: true } : {}),
  };
  const quiet = !!o.quiet;
  const say = (m) => { if (!quiet) process.stderr.write(`tracegate lease: ${m}\n`); };
  for (;;) {
    let c;
    try { c = await connect({ need: req.onDemand ? 2 : 1, hello: { owner: `${process.pid}`, pid: process.pid } }); } catch (e) {
      if (e.code !== 'EBROKERPROTO') throw e;
      process.stderr.write(`tracegate lease: ${e.message}\n`); return EX_PROTOCOL;
    }
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
          say(`${id} granted ${m.tokens} token(s)${m.memMB ? ` and ${m.memMB} MB` : ''}, fence ${m.fence}${m.nested ? ' (inside the parent lease)' : ''}`);
          if (m.contended) say(`${id} starts CONTENDED: the machine stayed busy past the starvation limit, so a red here is not evidence on its own`);
          const contended = m.contended || process.env.TRACEGATE_CONTENDED === '1';
          // A nested lease runs inside its parent's grant: it inherits the parent's jobserver.
          const js = o.jobserver && !m.nested ? makeJobserver(m.tokens) : null;
          if (js) say(`${id} jobserver ${js.fifo} with ${m.tokens - 1} token(s) (MAKEFLAGS=${js.flags})`);
          child = spawn(argv[0], argv.slice(1), {
            stdio: 'inherit', detached: true,
            env: { ...process.env, TRACEGATE_LEASE: id, TRACEGATE_FENCE: String(m.fence), TRACEGATE_TOKENS: String(m.tokens), VITEST_MAX_WORKERS: String(m.tokens),
              ...(contended ? { TRACEGATE_CONTENDED: '1' } : {}), ...(js ? js.env : {}) },
          });
          if (js) child.on('exit', () => { const back = js.available(); if (back < m.tokens - 1) say(`${id} jobserver: ${m.tokens - 1 - back} token(s) were never returned (a child died holding them)`); js.close(); });
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

/**
 * `tracegate observe --class c [--tokens n] [--label l] [--yield] --watch-pid P [--quiet]`
 * Phase 0.5b (I10): register work that is coordinated by something else, without
 * waiting. The broker grants it at once and records whether it WOULD have waited,
 * and behind whom; its tokens count, and P's process tree is measured. The holder
 * stays connected until P exits, then exits itself. Meant to be started in the
 * background by an existing script: `tracegate observe … --watch-pid $$ &`.
 * It never blocks, never fails its caller, and ignores preemption (it logs it).
 * `--yield` (I11): preemptible leases yield to it and wait while it lives.
 */
export async function observe(o) {
  const pid = Number(o['watch-pid']);
  if (!(Number.isInteger(pid) && pid > 1)) throw new Error('observe: --watch-pid <pid> is required');
  const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const quiet = !!o.quiet;
  const say = (m) => { if (!quiet) process.stderr.write(`tracegate observe: ${m}\n`); };
  let c;
  try { c = await connect({ hello: { owner: `observe:${pid}`, pid } }); } catch (e) { say(`no broker (${e.message}); nothing recorded`); return 0; }
  c.on((m) => {
    if (m.type === 'granted') say(`${m.id} registered with ${m.tokens} token(s)${m.memMB ? `, ${m.memMB} MB` : ''}`);
    else if (m.type === 'preempt') say(`${m.id}: the broker would have preempted this for ${m.by} (observe: not acted on)`);
    else if (m.type === 'error') say(`broker refused: ${m.error}`);
  });
  c.send({ op: 'request', observe: true, ...(o.yield ? { yield: true } : {}), class: o.class && o.class !== true ? o.class : 'adhoc', tokens: o.tokens !== undefined ? Number(o.tokens) : 1,
    exclusive: !!o.exclusive, label: o.label && o.label !== true ? o.label : `pid ${pid}`, ...ledgerIdentity() });
  await new Promise((resolve) => {
    const t = setInterval(() => { if (!alive()) { clearInterval(t); resolve(); } }, 2000);
    c.closed.then(() => { clearInterval(t); resolve(); });
  });
  c.close();
  return 0;
}
