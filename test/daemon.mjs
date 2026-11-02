#!/usr/bin/env node
// Daemon tests (src/daemon.mjs): the nightly full lane and pre-gating queued PRs, each
// in a throwaway worktree. The gate is a script (no broker, no vitest) that logs where
// it ran and what it saw, and exits with whatever the test asks for.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-daemon-test-')));
const repo = path.join(tmp, 'repo'); const ledger = path.join(tmp, 'ledger'); const seen = path.join(tmp, 'seen.log'); const exitFile = path.join(tmp, 'exit');
fs.mkdirSync(repo);
for (const k of Object.keys(process.env)) if (k.startsWith('TRACEGATE')) delete process.env[k];
Object.assign(process.env, { TRACEGATE_ROOT: repo, TRACEGATE_LEDGER: ledger, TRACEGATE_HOST: 'daemon' });
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
// The gate: log "<cwd> <tree> <node_modules?> <TRACEGATE_DAEMON>", then exit with the code in exitFile (0 by default).
const GATE = `node -e 'const fs=require("fs"),{execSync}=require("child_process"); fs.appendFileSync(${JSON.stringify(seen)}, [process.cwd(), execSync("git rev-parse HEAD^{tree}",{encoding:"utf8"}).trim(), fs.existsSync("node_modules")?"nm":"-", process.env.TRACEGATE_DAEMON].join(" ")+"\\n"); process.exit(Number(fs.existsSync(${JSON.stringify(exitFile)}) ? fs.readFileSync(${JSON.stringify(exitFile)},"utf8") : 0))'`;

g('init', '-q', '-b', 'main');
w('tracegate.config.json', JSON.stringify({ lanes: { app: { dir: '.', src: 'src' } } }));
w('src/a.txt', 'a\n'); w('package-lock.json', '{"lockfileVersion":3}\n');
w('.gitignore', 'node_modules\n');
g('add', '-A'); g('commit', '-qm', 'base');
fs.mkdirSync(path.join(repo, 'node_modules')); // installed packages the worktree borrows
const branch = (name, file, text) => { g('checkout', '-q', '-b', name, 'main'); w(file, text); g('add', '-A'); g('commit', '-qm', name); g('checkout', '-q', 'main'); };
branch('pr1', 'src/one.txt', 'one\n');
branch('pr2', 'package-lock.json', '{"lockfileVersion":3,"packages":{"x":{}}}\n');

const D = await import('../src/daemon.mjs');
const T = await import('../src/train.mjs');
const night = new Date(); night.setHours(3, 0, 0, 0);
const noon = new Date(); noon.setHours(12, 0, 0, 0);
const opts = (o = {}) => ({ gate: GATE, 'no-lease': true, quiet: true, now: night, ...o });
const seenLines = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean) : []);
const log = () => { try { return fs.readFileSync(path.join(ledger, 'daemon-daemon.tsv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t')); } catch { return []; } };

// ── the window ──────────────────────────────────────────────────────────────
check('window: 1-6 holds 1..5, not 6 or 0', D.inWindow('1-6', 1) && D.inWindow('1-6', 5) && !D.inWindow('1-6', 6) && !D.inWindow('1-6', 0));
check('window: 22-4 wraps past midnight', D.inWindow('22-4', 23) && D.inWindow('22-4', 2) && !D.inWindow('22-4', 4) && !D.inWindow('22-4', 12));
check('window: a malformed window is never open', !D.inWindow('nights', 3));

// ── the full lane, at night, in a worktree ──────────────────────────────────
{
  const day = D.plan({ now: noon });
  check('plan: a lane with no full run is due, but not outside the window', !day.todo.length && day.skipped.some((s) => s.kind === 'full' && /outside the window/.test(s.skip)), JSON.stringify(day));
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'uncommitted edit\n');
  const headBefore = g('rev-parse', 'HEAD');
  const r = D.tick(opts());
  const lines = seenLines();
  const full = lines.find((l) => l.endsWith(' full'))?.split(' ');
  check('tick: the full lane ran, green, at main\'s tree', r.ran.some((x) => x.kind === 'full' && x.result === 'green') && full?.[1] === g('rev-parse', 'main^{tree}'), JSON.stringify({ ran: r.ran, lines }));
  check('tick: ...in a worktree, never in the user\'s checkout, with the checkout\'s node_modules', full && full[0] !== repo && full[2] === 'nm');
  check('tick: the user\'s checkout is untouched: same HEAD, the uncommitted edit still there', g('rev-parse', 'HEAD') === headBefore && fs.readFileSync(path.join(repo, 'src', 'a.txt'), 'utf8') === 'uncommitted edit\n');
  check('tick: the worktree is removed afterwards', g('worktree', 'list').split('\n').length === 1 && !fs.existsSync(full?.[0] ?? '/nonexistent'), g('worktree', 'list'));
  check('tick: the piece is logged', log().some((row) => row[1] === 'full' && row[5] === 'green'));
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'a\n');
  const again = D.plan({ now: night });
  check('plan: a full lane already run at this commit is not run again in the window', !again.todo.some((t) => t.kind === 'full') && again.skipped.some((s) => /already run/.test(s.skip)), JSON.stringify(again));
}

// ── pre-gating the train queue ──────────────────────────────────────────────
{
  fs.rmSync(seen, { force: true });
  T.add({ pr: 'pr1' });
  const r = D.tick(opts());
  const pre = seenLines().find((l) => l.endsWith(' pregate'))?.split(' ');
  check('pregate: a queued PR runs at its pinned commit', r.ran.some((x) => x.kind === 'pregate' && x.ref === 'pr1' && x.result === 'green') && pre?.[1] === g('rev-parse', 'pr1^{tree}'), JSON.stringify(r.ran));
  const r2 = D.tick(opts());
  check('pregate: a PR already run at that commit is not run again', !r2.ran.some((x) => x.ref === 'pr1'), JSON.stringify(r2.ran));
  T.add({ pr: 'pr2' });
  const r3 = D.tick(opts());
  const p2 = r3.ran.find((x) => x.ref === 'pr2');
  check('pregate: a PR whose lockfile differs from the installed one is skipped, not run', p2?.result === 'skipped' && /lockfile differs/.test(p2.note) && !seenLines().some((l) => l.includes(g('rev-parse', 'pr2^{tree}'))), JSON.stringify(p2));
  T.drop({ pr: 'pr2' });
}

// ── preempted: yielded, stops the tick, and is retried ──────────────────────
{
  fs.rmSync(seen, { force: true });
  branch('pr3', 'src/three.txt', 'three\n'); branch('pr4', 'src/four.txt', 'four\n');
  T.add({ pr: 'pr3' }); T.add({ pr: 'pr4' });
  fs.writeFileSync(exitFile, '75');
  const r = D.tick(opts());
  check('yield: a piece the broker preempted (exit 75) is logged yielded, and the tick stops there', r.ran.length === 1 && r.ran[0].result === 'yielded', JSON.stringify(r.ran));
  fs.rmSync(exitFile);
  const r2 = D.tick(opts());
  check('yield: the next tick retries it', r2.ran.some((x) => x.ref === r.ran[0].ref && x.result === 'green'), JSON.stringify(r2.ran));
  fs.writeFileSync(exitFile, '1');
  branch('pr5', 'src/five.txt', 'five\n'); T.add({ pr: 'pr5' });
  const r3 = D.tick(opts());
  fs.rmSync(exitFile);
  const r4 = D.tick(opts());
  check('red: a red piece is logged red and not retried', r3.ran.some((x) => x.ref === 'pr5' && x.result === 'red') && !r4.ran.some((x) => x.ref === 'pr5'), JSON.stringify({ r3: r3.ran, r4: r4.ran }));
}

// ── one tick at a time ──────────────────────────────────────────────────────
{
  const lock = path.join(ledger, 'daemon-daemon.lock');
  fs.writeFileSync(lock, String(process.pid));
  const r = D.tick(opts());
  check('lock: a second tick while one runs does nothing', r.busy === true && !r.ran.length);
  fs.writeFileSync(lock, '999999');
  const r2 = D.tick(opts());
  check('lock: a lock left by a dead tick is taken over', !r2.busy && !fs.existsSync(lock));
}

// ── install: the scheduler files ────────────────────────────────────────────
{
  const home = path.join(tmp, 'home');
  const mac = D.unitFiles({ home, platform: 'darwin', every: 15 });
  const plist = mac.files[0].text;
  check('install (macOS): a launchd agent that runs `daemon tick` every 15 min at background priority', mac.files[0].path.startsWith(path.join(home, 'Library', 'LaunchAgents')) && plist.includes('<string>daemon</string><string>tick</string>') && plist.includes('<integer>900</integer>') && plist.includes('<string>Background</string>'), plist);
  const lin = D.unitFiles({ home, platform: 'linux', every: 15 });
  check('install (Linux): a systemd user service and timer', lin.files.length === 2 && lin.files[1].text.includes('OnUnitActiveSec=15min') && lin.files[0].text.includes('daemon" "tick"'), JSON.stringify(lin.files.map((f) => f.path)));
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.mjs');
  const env = { ...process.env, HOME: home };
  execFileSync(process.execPath, [cli, 'daemon', 'install', '--no-load', '--home', home], { env, stdio: 'ignore' });
  const unit = (process.platform === 'darwin' ? mac : process.platform === 'linux' ? lin : null);
  if (unit) {
    check('install --no-load writes the files and loads nothing', unit.files.every((f) => fs.existsSync(f.path)));
    execFileSync(process.execPath, [cli, 'daemon', 'uninstall', '--no-load', '--home', home], { env, stdio: 'ignore' });
    check('uninstall removes them', unit.files.every((f) => !fs.existsSync(f.path)));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== daemon tests: ${fail} FAILED, ${pass} passed ==` : `\n== daemon tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
