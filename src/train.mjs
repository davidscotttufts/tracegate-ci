// `tracegate train add | drop | status | run` — a local merge train.
//
// A PR is a ref, pinned to its commit when it is added. `train run` lands the
// queue onto a target branch (default main) and nothing else:
//   1. advice    the Conductor's `train` advice (logged, scored later) says which
//                PRs go ALONE; the rest form one batch, in queue order
//   2. build     each batch is a real merge commit (--no-ff, one per PR) on the
//                target's CURRENT commit, in a throwaway worktree. A PR that does
//                not merge cleanly is rejected as a conflict.
//   3. gate      the gate command runs IN that worktree, under a broker lease of
//                class `train`. Default: `tracegate run`, so selection and verdict
//                reuse apply, and re-gating half a batch costs only what the split
//                changed.
//   4. land      green: the target moves to the gated commit by compare-and-swap
//                on its old value. A target that moved since the batch was built
//                invalidates the train: nothing lands. A branch checked out in a
//                worktree is fast-forwarded there, and only when it is clean.
//   5. bisect    red: split the batch in halves and gate the first, then the
//                second on top of whatever landed. A single red PR is rejected.
//                Each level halves the batch, so it ends after at most 2n − 1 gates.
//   6. outcome   which PRs were red goes to `conductor outcome`, so
//                `conductor score` measures what the advice saved.
// INVARIANTS (test/train.mjs): a red PR never lands; the target only ever points
// at a commit whose exact tree was gated green; a moved target lands nothing.
// Pushing is opt-in (`--push`), never the default.
//
// The queue is `trainq-<host>.tsv`, append-only: add, drop, landed, rejected.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trainAdvice, trainOutcome } from './conductor.mjs';
import { ctx, git, lane } from './config.mjs';
import { appendTsv, ledgerDir, readTsv } from './ledger.mjs';

export const TRAINQ_HEADER = ['at', 'pr', 'ref', 'sha', 'target', 'event', 'note'];
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const now = () => new Date().toISOString();
const ID = /^[A-Za-z0-9._#/-]{1,100}$/;

/** The queue: every PR whose latest event is `add`, in the order it was added. */
export function queue(target = null) {
  const last = new Map();
  for (const r of readTsv('trainq-').sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    if (r.event === 'add') last.set(r.pr, r); else if (last.has(r.pr)) last.set(r.pr, { ...last.get(r.pr), event: r.event, note: r.note });
  }
  return [...last.values()].filter((r) => r.event === 'add' && (!target || r.target === target));
}
export function history(n = 20) { return readTsv('trainq-').slice(-n); }

export function add(o) {
  const [id, ref] = String(o.pr ?? '').split('=');
  if (!id || !ID.test(id)) throw new Error('train add: --pr <id>=<ref> (or --pr <branch>)');
  const r = ref || id;
  const sha = git('rev-parse', '--verify', `${r}^{commit}`).trim();
  const target = o.target && o.target !== true ? o.target : 'main';
  if (queue().some((q) => q.pr === id)) throw new Error(`train add: ${id} is already queued`);
  appendTsv('trainq-', TRAINQ_HEADER, [now(), id, r, sha, target, 'add', '']);
  return { pr: id, ref: r, sha, target };
}

export function drop(o) {
  const id = String(o.pr ?? '');
  if (!queue().some((q) => q.pr === id)) throw new Error(`train drop: ${id} is not queued`);
  appendTsv('trainq-', TRAINQ_HEADER, [now(), id, '', '', '', 'drop', o.note && o.note !== true ? o.note : '']);
  return { dropped: id };
}

// Only one train runs per ledger at a time. A lock whose pid is gone is stale.
function lock() {
  const p = path.join(ledgerDir(), 'train.lock');
  fs.mkdirSync(ledgerDir(), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(p, String(process.pid), { flag: 'wx' }); return () => { try { fs.rmSync(p); } catch { /* gone */ } }; } catch {
      const pid = Number(fs.readFileSync(p, 'utf8'));
      let alive = false; try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) throw new Error(`train run: another train is running (pid ${pid})`);
      fs.rmSync(p, { force: true });
    }
  }
  throw new Error('train run: could not take the train lock');
}

/** Where `branch` is checked out, if anywhere. */
function checkedOutAt(branch) {
  let wt = null;
  for (const l of git('worktree', 'list', '--porcelain').split('\n')) {
    if (l.startsWith('worktree ')) wt = l.slice(9);
    else if (l === `branch refs/heads/${branch}`) return wt;
  }
  return null;
}

const sh = (args, opts) => spawnSync(args[0], args.slice(1), { encoding: 'utf8', ...opts });
const gitIn = (dir, ...a) => sh(['git', '-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });

/** Build the merge of `prs` on `base` in a fresh worktree: { dir, head, merged, conflicts }. */
function build(base, prs, id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tracegate-train-${id}-`));
  const r = gitIn(ctx().root, 'worktree', 'add', '--detach', '--quiet', dir, base);
  if (r.status !== 0) throw new Error(`train: worktree add failed: ${r.stderr.trim()}`);
  // A fresh worktree has no node_modules; the gate uses the repository's.
  const nm = path.join(ctx().root, 'node_modules');
  if (fs.existsSync(nm) && !fs.existsSync(path.join(dir, 'node_modules'))) fs.symlinkSync(nm, path.join(dir, 'node_modules'));
  const merged = [], conflicts = [];
  const id8 = ['-c', 'user.name=tracegate train', '-c', 'user.email=train@tracegate.invalid', '-c', 'commit.gpgsign=false'];
  for (const p of prs) {
    const m = gitIn(dir, ...id8, 'merge', '--no-ff', '--no-edit', '-m', `train: merge ${p.pr} (${p.ref})`, p.sha);
    if (m.status === 0) merged.push(p);
    else { gitIn(dir, 'merge', '--abort'); conflicts.push(p); }
  }
  return { dir, head: gitIn(dir, 'rev-parse', 'HEAD').stdout.trim(), merged, conflicts };
}
function remove(dir) {
  gitIn(ctx().root, 'worktree', 'remove', '--force', dir);
  fs.rmSync(dir, { recursive: true, force: true });
  gitIn(ctx().root, 'worktree', 'prune');
}

/** Run the gate in `dir`; true when it exits 0. */
function gate(dir, o, label) {
  const env = { ...process.env, TRACEGATE_TRAIN: label };
  delete env.TRACEGATE_ROOT; // the gate works on the worktree, not the caller's checkout
  const cmd = o.gate && o.gate !== true ? ['sh', '-c', o.gate] : [process.execPath, CLI, 'run', ...(o.lane && o.lane !== true ? ['--lane', o.lane] : [])];
  const leased = o['no-lease'] || process.env.TRACEGATE_LEASE ? cmd
    : [process.execPath, CLI, 'lease', '--class', 'train', '--tokens', String(o.tokens ?? 2), '--label', `train ${label}`, '--quiet', '--', ...cmd];
  const r = sh(leased, { cwd: dir, env, stdio: o.quiet ? 'ignore' : 'inherit' });
  return r.status === 0;
}

/** Move `target` from `from` to `to` atomically, or explain why not. */
function land(target, from, to) {
  const wt = checkedOutAt(target);
  if (wt) {
    if (gitIn(wt, 'rev-parse', 'HEAD').stdout.trim() !== from) return 'the target moved';
    if (gitIn(wt, 'status', '--porcelain', '--untracked-files=no').stdout.trim()) return `${target} is checked out with local changes at ${wt}`;
    const r = gitIn(wt, 'merge', '--ff-only', '--quiet', to);
    return r.status === 0 ? null : `fast-forward failed: ${r.stderr.trim()}`;
  }
  const r = gitIn(ctx().root, 'update-ref', `refs/heads/${target}`, to, from);
  return r.status === 0 ? null : 'the target moved';
}

export function run(o = {}) {
  const target = o.target && o.target !== true ? o.target : 'main';
  const say = o.quiet ? () => {} : (m) => console.log(`tracegate train: ${m}`);
  const unlock = lock();
  const out = { target, landed: [], rejected: [], gates: 0, invalidated: null, advice: null };
  try {
    const q = queue(target);
    if (!q.length) { say(`nothing queued for ${target}.`); return out; }
    let tip = git('rev-parse', '--verify', `refs/heads/${target}^{commit}`).trim();
    // 1. advice: which PRs go alone. Advice only; an error here just means one batch.
    let alone = [];
    try {
      const ln = lane(o.lane);
      const a = trainAdvice({ lane: ln.name, base: tip, pr: q.map((p) => `${p.pr}=${p.sha}`) });
      out.advice = a.id; alone = a.alone;
      if (alone.length) say(`advice ${a.id}: ${alone.join(', ')} alone (reach ${alone.map((p) => a.reach[p]).join(', ')})`);
    } catch (e) { say(`no advice (${e.message}); one batch.`); }
    const batches = [...q.filter((p) => alone.includes(p.pr)).map((p) => [p]), q.filter((p) => !alone.includes(p.pr))].filter((b) => b.length);
    const reject = (p, why) => { appendTsv('trainq-', TRAINQ_HEADER, [now(), p.pr, p.ref, p.sha, target, 'rejected', why]); out.rejected.push({ pr: p.pr, why }); say(`${p.pr} rejected: ${why}`); };
    // Gate `prs` on top of `tip`; land on green, bisect on red. Returns the new tip.
    const step = (prs) => {
      if (!prs.length || out.invalidated) return;
      const b = build(tip, prs, `${out.gates + 1}`);
      try {
        for (const p of b.conflicts) reject(p, 'merge conflict');
        if (!b.merged.length) return;
        const label = `${target}+${b.merged.map((p) => p.pr).join('+')}`;
        out.gates++;
        say(`gate ${out.gates}: ${b.merged.map((p) => p.pr).join(', ')} on ${tip.slice(0, 9)}`);
        if (gate(b.dir, o, label)) {
          const tree = gitIn(b.dir, 'rev-parse', `${b.head}^{tree}`).stdout.trim();
          const why = land(target, tip, b.head);
          if (why) { out.invalidated = why; say(`not landed: ${why}. The train stops; the queue is kept.`); return; }
          tip = b.head;
          for (const p of b.merged) { appendTsv('trainq-', TRAINQ_HEADER, [now(), p.pr, p.ref, p.sha, target, 'landed', `${b.head.slice(0, 12)} tree ${tree.slice(0, 12)}`]); out.landed.push(p.pr); }
          say(`landed ${b.merged.map((p) => p.pr).join(', ')}: ${target} is ${b.head.slice(0, 9)}`);
          return;
        }
        if (b.merged.length === 1) { reject(b.merged[0], `red gate at ${b.head.slice(0, 12)}`); return; }
        const half = Math.ceil(b.merged.length / 2);
        say(`red: bisecting ${b.merged.length} PRs`);
        remove(b.dir); b.dir = null;
        step(b.merged.slice(0, half));
        step(b.merged.slice(half));
      } finally { if (b.dir) remove(b.dir); }
    };
    for (const batch of batches) step(batch);
    if (out.advice) { try { trainOutcome({ id: out.advice, red: out.rejected.filter((r) => r.why.startsWith('red')).map((r) => r.pr).join(',') || true }); } catch { /* scoring only */ } }
    if (o.push && out.landed.length && !out.invalidated) {
      const r = gitIn(ctx().root, 'push', o.remote && o.remote !== true ? o.remote : 'origin', `${tip}:refs/heads/${target}`);
      out.pushed = r.status === 0; say(r.status === 0 ? `pushed ${target}` : `push failed: ${r.stderr.trim()}`);
    }
    say(`${out.landed.length} landed, ${out.rejected.length} rejected, ${out.gates} gate(s)${out.invalidated ? `, stopped: ${out.invalidated}` : ''}.`);
    return out;
  } finally { unlock(); }
}

export function status(o = {}) {
  const q = queue(o.target && o.target !== true ? o.target : null);
  return { queued: q.map(({ pr, ref, sha, target, at }) => ({ pr, ref, sha: sha.slice(0, 12), target, at })), recent: history(10).filter((r) => r.event !== 'add') };
}

export function train(sub, o) {
  if (sub === 'add') { const r = add(o); console.log(`tracegate train: ${r.pr} queued for ${r.target} at ${r.sha.slice(0, 12)}`); return 0; }
  if (sub === 'drop') { drop(o); console.log(`tracegate train: ${o.pr} dropped`); return 0; }
  if (sub === 'status') { const s = status(o); console.log(o.json ? JSON.stringify(s, null, 2) : [`queued (${s.queued.length}):`, ...s.queued.map((p) => `  ${p.pr.padEnd(16)} ${p.sha} → ${p.target}  (${p.ref})`), 'recent:', ...s.recent.map((r) => `  ${r.at}  ${r.pr.padEnd(16)} ${r.event}${r.note ? `  ${r.note}` : ''}`)].join('\n')); return 0; }
  if (sub === 'run') { const r = run(o); if (o.json) console.log(JSON.stringify(r, null, 2)); return r.invalidated || r.rejected.length ? 1 : 0; }
  throw new Error('train: add --pr <id>=<ref> [--target main] | drop --pr <id> | status [--json] | run [--target main] [--lane l] [--gate "<cmd>"] [--tokens n] [--no-lease] [--push] [--json]');
}
