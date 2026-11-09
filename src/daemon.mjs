// `tracegate daemon tick | status | install | uninstall` — CI work for an idle machine.
//
// One `tick` is one pass, meant to run every ~20 minutes from launchd or systemd:
//   1. full     per lane, when its last complete full run is older than
//               `fullRunMaxHours` and the local hour is inside `daemon.window` (default
//               1–6): the whole lane at the target branch's tip. A green one records the
//               full run, so the >24 h backstop does not land on someone's gate.
//   2. pregate  each PR in the merge-train queue not yet run at its pinned commit: the
//               lane at that commit, so `train run` finds the PR's verdicts waiting and
//               re-runs only what the merge itself changed.
// Each piece runs in a throwaway worktree, under a broker lease of class `daemon`. That
// class is preemptible: a gate, train or deploy takes the machine back at once (the
// lease exits 75, logged `yielded`), and the piece is tried again on a later tick.
//
// RULES (test/daemon.mjs, with sabotage witnesses):
//   - Never in the user's checkout: a detached worktree, removed afterwards.
//   - The worktree borrows the checkout's node_modules, so a piece whose lockfile differs
//     from what is installed is SKIPPED: its footprints would name packages it never had.
//   - A piece is not retried within the same window once it ran (green, red or failed);
//     a yielded piece is.
//   - A TRACEGATE_CONFIG inside the repository is the worktree's own copy of that file,
//     at the piece's commit; one outside it is passed on as given.
//   - `install` carries TRACEGATE_CONFIG, TRACEGATE_LEDGER and the broker's location into
//     the scheduler, which starts ticks with no environment of its own. A second ledger
//     on one machine (a package beside a fork, say) yields to the gates only on THEIR
//     broker: set TRACEGATE_BROKER_DIR to it (the socket is keyed by that directory).
//   - `daemon.target` names a local branch or, failing that, a remote-tracking one
//     ("origin/main"), for a checkout whose local main is not kept current.
//
// Log: `daemon-<host>.tsv`, machine-local (src/sync.mjs).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ctx, git } from './config.mjs';
import { appendTsv, ledgerDir, readTsv } from './ledger.mjs';
import { lastFullHours, lockHash, lockHashAt } from './predictor.mjs';
import { queue } from './train.mjs';

export const DAEMON_HEADER = ['at', 'kind', 'lane', 'ref', 'sha', 'result', 'seconds', 'note'];
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
export const DEFAULTS = { window: '1-6', target: 'main', pregate: true, tokens: 2, every: 20, timeoutMin: 120 };
const config = () => ({ ...DEFAULTS, ...(ctx().daemon ?? {}) });

/** Is local hour `h` inside "a-b" (a ≤ h < b; "22-4" wraps past midnight)? */
export function inWindow(win, h = new Date().getHours()) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(win ?? '').trim());
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

/** The target's commit: refs/heads/<target>, else refs/remotes/<target> ("origin/main"). */
function tipOf(target) {
  for (const ref of [`refs/heads/${target}`, `refs/remotes/${target}`]) {
    try { return git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).trim(); } catch { /* try the next */ }
  }
  return null;
}

/** The variables a scheduled tick needs and the scheduler won't pass: absolute paths, as set now. */
export function carriedEnv(env = process.env) {
  const out = {};
  for (const k of ['TRACEGATE_CONFIG', 'TRACEGATE_LEDGER', 'TRACEGATE_BROKER_DIR', 'TRACEGATE_BROKER_SOCKET']) if (env[k]) out[k] = path.resolve(env[k]);
  return out;
}

/** What the next tick would do: [{ kind, lane, ref, sha, why }] and [{ ..., skip }]. */
export function plan(o = {}) {
  const c = config();
  const target = o.target && o.target !== true ? o.target : c.target;
  const log = readTsv('daemon-');
  const done = (kind, lane, sha, sinceMs) => log.some((r) => r.kind === kind && r.lane === lane && r.sha === sha && r.result !== 'yielded' && (!sinceMs || Date.parse(r.at) >= sinceMs));
  const todo = []; const skipped = [];
  const tip = tipOf(target);
  const lanes = o.lane && o.lane !== true ? [o.lane] : Object.keys(ctx().lanes);
  const maxH = ctx().fullRunMaxHours;
  const now = o.now ?? new Date();
  const windowOk = o.anyTime || inWindow(c.window, now.getHours());
  for (const lane of lanes) {
    if (!tip || !maxH) continue;
    const h = lastFullHours(lane);
    if (!(h >= maxH)) continue;
    if (!windowOk) { skipped.push({ kind: 'full', lane, ref: target, sha: tip, skip: `outside the window ${c.window}` }); continue; }
    if (done('full', lane, tip, now.getTime() - maxH * 3_600_000)) { skipped.push({ kind: 'full', lane, ref: target, sha: tip, skip: 'already run at this commit' }); continue; }
    todo.push({ kind: 'full', lane, ref: target, sha: tip, why: `last complete full run ${Number.isFinite(h) ? `${Math.round(h)} h ago` : 'never recorded'}` });
  }
  if (c.pregate) {
    for (const p of queue()) {
      for (const lane of lanes) {
        if (done('pregate', lane, p.sha)) continue;
        todo.push({ kind: 'pregate', lane, ref: p.pr, sha: p.sha, why: `queued for ${p.target}` });
      }
    }
  }
  return { todo, skipped, window: c.window, inWindow: windowOk };
}

/** Run one piece in a throwaway worktree. Returns { result, seconds, note }. */
function runPiece(item, o) {
  const c = config();
  const root = ctx().root;
  // The worktree borrows this checkout's installed packages; a different lockfile
  // would record footprints against packages that commit never had.
  let lockAt, lockNow;
  try { lockAt = lockHashAt(item.lane, item.sha); lockNow = lockHash(item.lane); } catch (e) { return { result: 'skipped', seconds: 0, note: `lockfile: ${e.message}` }; }
  if (lockAt !== lockNow) return { result: 'skipped', seconds: 0, note: 'its lockfile differs from the installed one' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-daemon-'));
  const t0 = Date.now();
  try {
    git('worktree', 'add', '--detach', '--quiet', dir, item.sha);
    for (const d of new Set(['', ...Object.values(ctx().lanes).map((l) => l.dir)])) {
      const nm = path.join(root, d, 'node_modules');
      if (fs.existsSync(nm) && !fs.existsSync(path.join(dir, d, 'node_modules'))) { fs.mkdirSync(path.join(dir, d), { recursive: true }); fs.symlinkSync(nm, path.join(dir, d, 'node_modules')); }
    }
    const gate = o.gate && o.gate !== true ? o.gate : c.gate ?? `"${process.execPath}" "${CLI}" run --lane ${item.lane}${item.kind === 'full' ? ' --mode shadow' : ''}`;
    const cmd = o['no-lease'] ? gate : `"${process.execPath}" "${CLI}" lease --class daemon --tokens ${Number(c.tokens) || 2} --label "daemon ${item.kind} ${item.lane} ${item.ref}" --quiet -- ${gate}`;
    const env = { ...process.env, TRACEGATE_ROOT: dir, TRACEGATE_DAEMON: item.kind };
    // The worktree's own config, at that commit: the default file, or the same path inside it.
    const cfg = process.env.TRACEGATE_CONFIG ? path.resolve(root, process.env.TRACEGATE_CONFIG) : null;
    const rel = cfg ? path.relative(root, cfg) : '';
    if (!cfg) delete env.TRACEGATE_CONFIG;
    else if (!rel.startsWith('..') && !path.isAbsolute(rel)) env.TRACEGATE_CONFIG = path.join(dir, rel);
    else env.TRACEGATE_CONFIG = cfg;
    const r = spawnSync(cmd, { shell: true, cwd: dir, env, stdio: o.quiet ? 'ignore' : 'inherit', timeout: (Number(c.timeoutMin) || 120) * 60_000 });
    const seconds = Math.round((Date.now() - t0) / 1000);
    if (r.error) return { result: 'failed', seconds, note: r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message };
    if (r.status === 75) return { result: 'yielded', seconds, note: 'the broker gave the machine to other work' };
    return { result: r.status === 0 ? 'green' : 'red', seconds, note: r.status === 0 ? '' : `exit ${r.status}` };
  } catch (e) {
    return { result: 'failed', seconds: Math.round((Date.now() - t0) / 1000), note: e.message.split('\n')[0] };
  } finally {
    try { git('worktree', 'remove', '--force', dir); } catch { /* the directory goes below either way */ }
    fs.rmSync(dir, { recursive: true, force: true });
    try { git('worktree', 'prune'); } catch { /* best effort */ }
  }
}

/** One pass. Stops at the first yielded piece: the machine is busy, so is the rest. */
export function tick(o = {}) {
  const say = o.quiet ? () => {} : (m) => console.log(`tracegate daemon: ${m}`);
  const lock = path.join(ledgerDir(), `daemon-${ctx().host}.lock`);
  fs.mkdirSync(ledgerDir(), { recursive: true });
  let fd; try { fd = fs.openSync(lock, 'wx'); } catch {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let alive = false; try { process.kill(pid, 0); alive = true; } catch { /* dead */ }
    if (alive) { say(`a tick is already running (pid ${pid}).`); return { ran: [], busy: true }; }
    fs.rmSync(lock, { force: true }); fd = fs.openSync(lock, 'wx');
  }
  fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
  const ran = [];
  try {
    const p = plan(o);
    for (const s of p.skipped) say(`skip ${s.kind} ${s.lane} at ${s.sha.slice(0, 9)}: ${s.skip}`);
    if (!p.todo.length) { say('nothing to do.'); return { ran, plan: p }; }
    for (const item of p.todo) {
      if (o['dry-run']) { say(`would run ${item.kind} ${item.lane} at ${item.ref} ${item.sha.slice(0, 9)} (${item.why})`); continue; }
      say(`${item.kind} ${item.lane} at ${item.ref} ${item.sha.slice(0, 9)} (${item.why})`);
      const r = runPiece(item, o);
      appendTsv('daemon-', DAEMON_HEADER, [new Date().toISOString(), item.kind, item.lane, item.ref, item.sha, r.result, r.seconds, r.note]);
      ran.push({ ...item, ...r });
      say(`${item.kind} ${item.lane}: ${r.result}${r.note ? ` (${r.note})` : ''}`);
      if (r.result === 'yielded') break;
    }
    return { ran, plan: p };
  } finally { fs.rmSync(lock, { force: true }); }
}

// ── install: a launchd agent (macOS) or a systemd user timer (Linux) ─────────
// One unit per repository and config: a second config (its own lanes and ledger) gets its own.
const unitName = (env = carriedEnv()) => `dev.tracegate.${crypto.createHash('sha256').update(env.TRACEGATE_CONFIG ? `${ctx().root}\0${env.TRACEGATE_CONFIG}` : ctx().root).digest('hex').slice(0, 10)}`;

/** The scheduler files for this repository: [{ path, text }], and the commands to load them. */
export function unitFiles(o = {}) {
  const c = config();
  const every = Number(o.every) > 0 ? Number(o.every) : Number(c.every) || 20;
  const home = o.home ?? os.homedir();
  const env = carriedEnv(o.env ?? process.env);
  const name = unitName(env);
  const logFile = path.join(ledgerDir(), 'daemon.log');
  const args = [process.execPath, CLI, 'daemon', 'tick', '--quiet'];
  const platform = o.platform ?? process.platform;
  if (platform === 'darwin') {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const plist = path.join(home, 'Library', 'LaunchAgents', `${name}.plist`);
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${name}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${esc(ctx().root)}</string>
${Object.keys(env).length ? `  <key>EnvironmentVariables</key>\n  <dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${esc(v)}</string>`).join('')}</dict>\n` : ''}  <key>StartInterval</key><integer>${every * 60}</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict>
</plist>
`;
    return { name, files: [{ path: plist, text }], load: [['launchctl', 'load', '-w', plist]], unload: [['launchctl', 'unload', '-w', plist]] };
  }
  if (platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user');
    const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
    return {
      name,
      files: [
        { path: path.join(dir, `${name}.service`), text: `[Unit]\nDescription=Tracegate daemon tick for ${ctx().root}\n\n[Service]\nType=oneshot\nWorkingDirectory=${ctx().root}\n${Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}\n`).join('')}ExecStart=${args.map(q).join(' ')}\nNice=10\nIOSchedulingClass=idle\nStandardOutput=append:${logFile}\nStandardError=append:${logFile}\n` },
        { path: path.join(dir, `${name}.timer`), text: `[Unit]\nDescription=Tracegate daemon tick every ${every} min\n\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=${every}min\n\n[Install]\nWantedBy=timers.target\n` },
      ],
      load: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', `${name}.timer`]],
      unload: [['systemctl', '--user', 'disable', '--now', `${name}.timer`]],
    };
  }
  throw new Error(`daemon install: unsupported platform ${platform} (run \`tracegate daemon tick\` from your own scheduler)`);
}

export function daemon(sub, o = {}) {
  if (sub === 'tick') { const r = tick(o); return r.busy ? 0 : r.ran.some((x) => x.result === 'failed') ? 1 : 0; }
  if (sub === 'status' || sub === undefined) {
    const p = plan({ ...o, anyTime: false });
    let u = null; try { u = unitFiles(o); } catch { /* unsupported platform */ }
    const installed = u ? u.files.every((f) => fs.existsSync(f.path)) : false;
    const recent = readTsv('daemon-').slice(-(Number(o.n) || 10));
    if (o.json) { console.log(JSON.stringify({ installed, unit: u?.name ?? null, window: p.window, inWindow: p.inWindow, next: p.todo, skipped: p.skipped, recent }, null, 2)); return 0; }
    console.log(`daemon: ${installed ? `installed (${u.name})` : 'not installed (tracegate daemon install)'}; window ${p.window} (${p.inWindow ? 'open now' : 'closed now'})`);
    for (const t of p.todo) console.log(`  next: ${t.kind} ${t.lane} at ${t.ref} ${t.sha.slice(0, 9)} (${t.why})`);
    for (const s of p.skipped) console.log(`  skip: ${s.kind} ${s.lane}: ${s.skip}`);
    for (const r of recent) console.log(`  ${r.at}  ${r.kind.padEnd(7)} ${r.lane} ${r.ref} ${r.sha.slice(0, 9)}  ${r.result}${r.note ? ` (${r.note})` : ''}  ${r.seconds}s`);
    return 0;
  }
  if (sub === 'install' || sub === 'uninstall') {
    const u = unitFiles(o);
    if (sub === 'install') {
      if (o.print) { for (const f of u.files) console.log(`# ${f.path}\n${f.text}`); console.log(`# then: ${u.load.map((c) => c.join(' ')).join(' && ')}`); return 0; }
      for (const f of u.files) { fs.mkdirSync(path.dirname(f.path), { recursive: true }); fs.writeFileSync(f.path, f.text); console.log(`tracegate daemon: wrote ${f.path}`); }
    } else {
      if (!o['no-load']) for (const c of u.unload) spawnSync(c[0], c.slice(1), { stdio: 'inherit' });
      for (const f of u.files) if (fs.existsSync(f.path)) { fs.rmSync(f.path); console.log(`tracegate daemon: removed ${f.path}`); }
      return 0;
    }
    if (o['no-load']) { console.log(`tracegate daemon: not loaded (--no-load); load with: ${u.load.map((c) => c.join(' ')).join(' && ')}`); return 0; }
    for (const c of u.load) { const r = spawnSync(c[0], c.slice(1), { stdio: 'inherit' }); if (r.status !== 0) { console.error(`tracegate daemon: ${c.join(' ')} failed`); return 1; } }
    console.log(`tracegate daemon: ${u.name} runs a tick every ${Number(o.every) || config().every} min; log ${path.join(ledgerDir(), 'daemon.log')}`);
    return 0;
  }
  throw new Error('daemon: tick [--dry-run] [--lane l] [--gate "<cmd>"] [--no-lease] | status [--json] | install [--every 20] [--print] [--no-load] | uninstall');
}
