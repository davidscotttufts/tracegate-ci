#!/usr/bin/env node
// Jobserver tests (Phase 0.5c; makeJobserver in src/broker/client.mjs). The FIFO
// protocol is checked directly, then through a real lease on a temp broker, with
// a child that behaves as make does: take a byte per extra job, put it back. If a
// GNU make ≥ 4.4 is on PATH (as gmake or make), a real parallel build is also
// checked to stay within the grant; otherwise that check says it was skipped.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeJobserver } from '../src/broker/client.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'src', 'cli.mjs');
let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

check('one token: no jobserver (the lease is the only job slot)', makeJobserver(1) === null);
const js = makeJobserver(4);
check('four tokens: the FIFO holds three (the lease is the implicit first)', js.available() === 3);
check('MAKEFLAGS uses the fifo form make 4.4+, Ninja and cargo read', js.env.MAKEFLAGS === `-j4 --jobserver-auth=fifo:${js.fifo}` && js.env.CARGO_MAKEFLAGS === js.env.MAKEFLAGS);
const fd = fs.openSync(js.fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
const took = fs.readSync(fd, Buffer.alloc(2), 0, 2, null);
check('a job that takes two tokens leaves one', took === 2 && js.available() === 1);
fs.writeSync(fd, Buffer.from('++')); fs.closeSync(fd);
check('...and both are back once it returns them', js.available() === 3);
js.close();
check('closing removes the FIFO', !fs.existsSync(js.fifo));

// Through a real lease.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-js-test-')));
const env = { ...process.env, TRACEGATE_BROKER_DIR: path.join(tmp, 'b'), TRACEGATE_BROKER_SOCKET: path.join(tmp, 's.sock'), TRACEGATE_BROKER_CAPACITY: '4', TRACEGATE_BROKER_ADAPTIVE: 'off' };
const child = path.join(tmp, 'child.mjs');
fs.writeFileSync(child, `import fs from 'node:fs';
const m = /--jobserver-auth=fifo:(\\S+)/.exec(process.env.MAKEFLAGS ?? '');
if (!m) { console.log(JSON.stringify({ none: true })); process.exit(0); }
const fd = fs.openSync(m[1], fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
let n = 0; try { n = fs.readSync(fd, Buffer.alloc(16), 0, 16, null); } catch {}
fs.writeSync(fd, Buffer.alloc(n, '+'));
console.log(JSON.stringify({ fifo: m[1], tokens: n, j: /-j(\\d+)/.exec(process.env.MAKEFLAGS)[1] }));
`);
const lease = (args) => spawnSync(process.execPath, [CLI, 'lease', '--quiet', ...args, '--', process.execPath, child], { env, encoding: 'utf8', cwd: tmp, timeout: 60_000 });
try {
  const r = lease(['--class', 'adhoc', '--tokens', '3', '--jobserver']);
  const out = JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
  check('lease --jobserver: the command sees a jobserver sized to its grant', r.status === 0 && out.tokens === 2 && out.j === '3', `${r.status} ${r.stdout} ${r.stderr}`);
  check('lease --jobserver: the FIFO is gone after the lease', out.fifo && !fs.existsSync(out.fifo));
  const r2 = lease(['--class', 'adhoc', '--tokens', '3']);
  check('lease without --jobserver exports none', JSON.parse(r2.stdout.trim().split('\n').pop() || '{}').none === true, r2.stdout);

  // A real GNU make, when one that speaks the fifo protocol is installed.
  const makeBin = ['gmake', 'make'].find((b) => { try { const v = /GNU Make (\d+)\.(\d+)/.exec(execFileSync(b, ['--version'], { encoding: 'utf8' })); return v && (Number(v[1]) > 4 || (Number(v[1]) === 4 && Number(v[2]) >= 4)); } catch { return false; } });
  if (makeBin) {
    const mk = path.join(tmp, 'Makefile'); const log = path.join(tmp, 'par.log');
    fs.writeFileSync(mk, `all: ${[1, 2, 3, 4, 5, 6].map((i) => `t${i}`).join(' ')}\nt%:\n\t@echo start >> ${log}; sleep 0.4; echo end >> ${log}\n`);
    const r3 = spawnSync(process.execPath, [CLI, 'lease', '--quiet', '--tokens', '2', '--jobserver', '--', makeBin, '-f', mk], { env, encoding: 'utf8', cwd: tmp, timeout: 60_000 });
    let cur = 0, peak = 0; for (const l of fs.readFileSync(log, 'utf8').split('\n')) { if (l === 'start') peak = Math.max(peak, ++cur); else if (l === 'end') cur--; }
    check(`${makeBin}: a 6-target build under a 2-token lease never runs more than 2 at once`, r3.status === 0 && peak <= 2 && peak >= 1, `status ${r3.status} peak ${peak}`);
  } else {
    console.log('  - (skipped) no GNU make ≥ 4.4 on PATH: the real-make check needs one (the FIFO protocol is checked above)');
  }
} finally {
  spawnSync(process.execPath, [CLI, 'broker', 'stop'], { env, cwd: tmp, timeout: 10_000 });
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fail ? `\n== jobserver tests: ${fail} FAILED, ${pass} passed ==` : `\n== jobserver tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
