// Role stores: where a role record lives, so that every machine can reach it, and
// how it is changed by compare-and-swap.
//
// Every store offers the same two calls, per role:
//   read(role)            → { gen, data }   data is null (and gen the "absent" value)
//                                           when the role has never been written
//   write(role, gen, data) → true            the record was `gen` and is now `data`
//                          → false           someone else wrote first: re-read
// A write is accepted only if the record is still at `gen`, so of two machines that
// read the same record and both try to change it, exactly one wins. Nothing here
// decides who may hold a role; that is src/role/index.mjs, which loops on `false`.
//
// URLs (config "roles": {"store": "<url>"}, or TRACEGATE_ROLES_STORE):
//   file:///abs/dir, or a path     a directory (a shared disk, and the tests). Each write
//                                  creates generation N+1 with link(2), which fails if the
//                                  name exists, so there is no lock file to go stale.
//   gs://bucket[/prefix]           Google Cloud Storage through the gcloud CLI
//                                  (TRACEGATE_GCLOUD names another binary): the object's
//                                  generation is the gen, written with --if-generation-match.
//   git+<remote>[#<ref prefix>]    a git remote, no cloud account needed: one ref per role
//                                  (default prefix refs/tracegate/roles), the commit sha is
//                                  the gen, written with push --force-with-lease=<ref>:<sha>.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A role name as one path segment, object name or ref component. */
export const encodeRole = (role) => encodeURIComponent(role).replace(/\./g, '%2E');

// ── a directory ──────────────────────────────────────────────────────────────
export function fileStore(root) {
  const dirOf = (role) => path.join(root, encodeRole(role));
  const gens = (d) => { try { return fs.readdirSync(d).map((f) => /^(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])); } catch { return []; } };
  return {
    kind: 'file',
    read(role) {
      const d = dirOf(role); const g = gens(d);
      if (!g.length) return { gen: 0, data: null };
      const gen = Math.max(...g);
      return { gen, data: JSON.parse(fs.readFileSync(path.join(d, `${gen}.json`), 'utf8')) };
    },
    write(role, gen, data) {
      const d = dirOf(role);
      fs.mkdirSync(d, { recursive: true });
      const tmp = path.join(d, `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
      // link(2) is atomic and refuses an existing name: the compare-and-swap.
      try { fs.linkSync(tmp, path.join(d, `${gen + 1}.json`)); } catch (e) { if (e.code === 'EEXIST') return false; throw e; } finally { fs.rmSync(tmp, { force: true }); }
      for (const g of gens(d)) if (g < gen - 20) fs.rmSync(path.join(d, `${g}.json`), { force: true });
      return true;
    },
  };
}

// ── Google Cloud Storage ─────────────────────────────────────────────────────
/** The gcloud runner: (args, input) → { status, stdout, stderr }. Tests pass a fake. */
export function gcloudRunner(deadline) {
  const bin = process.env.TRACEGATE_GCLOUD || 'gcloud';
  return (args, input) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('timed out');
    const r = spawnSync(bin, args, { input, encoding: 'utf8', timeout: left, stdio: ['pipe', 'pipe', 'pipe'] });
    if (r.error) throw new Error(r.error.code === 'ENOENT' ? `${bin} not found` : r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message);
    return r;
  };
}

export function gcsStore(url, run) {
  const base = url.replace(/\/+$/, '');
  const obj = (role) => `${base}/roles/${encodeRole(role)}.json`;
  const why = (r) => (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').pop().slice(0, 200);
  const notFound = (r) => /not ?found|404|No URLs matched|does not exist/i.test(r.stderr || '');
  const store = {
    kind: 'gs',
    read(role) {
      const d = run(['storage', 'objects', 'describe', obj(role), '--format=value(generation)']);
      if (d.status !== 0) { if (notFound(d)) return { gen: 0, data: null }; throw new Error(why(d)); }
      const gen = Number(String(d.stdout).trim());
      if (!Number.isFinite(gen) || gen <= 0) throw new Error(`bad generation ${JSON.stringify(String(d.stdout).trim())}`);
      // Pinned to that generation: a write in between cannot be read under the old gen.
      const c = run(['storage', 'cat', `${obj(role)}#${gen}`]);
      if (c.status !== 0) { if (notFound(c)) return store.read(role); throw new Error(why(c)); }
      return { gen, data: JSON.parse(c.stdout) };
    },
    write(role, gen, data) {
      // Generation 0 means "must not exist yet": create-only.
      const r = run(['storage', 'cp', '-', obj(role), `--if-generation-match=${gen}`], JSON.stringify(data, null, 1));
      if (r.status === 0) return true;
      if (/412|precondition/i.test(`${r.stderr}${r.stdout}`)) return false;
      throw new Error(why(r));
    },
  };
  return store;
}

// ── a git remote ─────────────────────────────────────────────────────────────
export function gitStore(remote, prefix = 'refs/tracegate/roles', { deadline = Date.now() + 20_000 } = {}) {
  const pfx = (prefix.startsWith('refs/') ? prefix : `refs/${prefix}`).replace(/\/+$/, '');
  const ref = (role) => `${pfx}/${encodeRole(role)}`;
  // A private scratch repository per store: no FETCH_HEAD shared with another process.
  let scratch = null;
  const git = (args, input) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('timed out');
    if (!scratch) {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-roles-'));
      const i = spawnSync('git', ['init', '-q', '--bare', scratch], { encoding: 'utf8' });
      if (i.status !== 0) throw new Error(`git init: ${i.stderr.trim()}`);
      process.once('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ } });
    }
    const r = spawnSync('git', ['-C', scratch, '-c', 'user.name=tracegate', '-c', 'user.email=tracegate@localhost', '-c', 'commit.gpgsign=false', ...args],
      { input, encoding: 'utf8', timeout: left, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message);
    return r;
  };
  const why = (r) => (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').pop().slice(0, 200);
  return {
    kind: 'git',
    read(role) {
      const f = git(['fetch', '-q', '--no-tags', remote, `+${ref(role)}:refs/tg/r`]);
      if (f.status !== 0) {
        if (/couldn't find remote ref|no such ref|not our ref/i.test(f.stderr)) return { gen: '', data: null };
        throw new Error(`git fetch ${remote}: ${why(f)}`);
      }
      const gen = git(['rev-parse', 'refs/tg/r']).stdout.trim();
      const c = git(['show', `${gen}:role.json`]);
      if (c.status !== 0) throw new Error(`${ref(role)} at ${gen} has no role.json`);
      return { gen, data: JSON.parse(c.stdout) };
    },
    write(role, gen, data) {
      const blob = git(['hash-object', '-w', '--stdin'], JSON.stringify(data, null, 1)).stdout.trim();
      const tree = git(['mktree'], `100644 blob ${blob}\trole.json\n`).stdout.trim();
      const commit = git(['commit-tree', tree, ...(gen ? ['-p', gen] : []), '-m', `role ${role}: epoch ${data.epoch} ${data.history?.at(-1)?.action ?? ''}`]).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('git commit-tree failed');
      // The lease: the ref must still be `gen` (empty = must not exist) or the push is refused.
      const p = git(['push', '-q', '--porcelain', `--force-with-lease=${ref(role)}:${gen}`, remote, `${commit}:${ref(role)}`]);
      if (p.status === 0) return true;
      if (/stale info|rejected|fetch first|non-fast-forward|already exists/i.test(`${p.stdout}${p.stderr}`)) return false;
      throw new Error(`git push ${remote}: ${why(p)}`);
    },
  };
}

/** The store a URL names. `root` resolves a relative directory. */
export function openStore(url, { root = process.cwd(), timeoutMs = Number(process.env.TRACEGATE_ROLES_TIMEOUT_MS) || 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  if (url.startsWith('gs://')) return gcsStore(url, gcloudRunner(deadline));
  if (url.startsWith('git+')) {
    const rest = url.slice(4); const i = rest.lastIndexOf('#');
    return gitStore(i >= 0 ? rest.slice(0, i) : rest, i >= 0 && rest.slice(i + 1) ? rest.slice(i + 1) : undefined, { deadline });
  }
  const dir = url.startsWith('file://') ? decodeURIComponent(new URL(url).pathname) : path.resolve(root, url);
  return fileStore(dir);
}
