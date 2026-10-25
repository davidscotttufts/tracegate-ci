// Dependency changes (Phase 3): a deterministic rule first, then an oracle in shadow.
//
// THE RULE. Before this, any lockfile change ran the whole lane (`lockfile
// changed`). Footprints now also record which INSTALLED packages a test file's
// worker had loaded (`pkgs`, from the same V8 coverage the recorder already
// takes) and which packages the vitest MAIN process had loaded (`runnerPkgs`,
// from the reporter: config, plugins, transforms). On a lockfile change a file
// keeps its verdict only when:
//   - both lists were recorded for its footprint, and the lane's node_modules
//     lives inside the repository (a symlinked node_modules is invisible, so the
//     lists would be empty, not small: the rule then does not apply);
//   - the lockfile is an npm v2/v3 lockfile (`packages`); others: whole lane;
//   - no changed package has an install script or an os/cpu restriction (native
//     code the coverage cannot see): whole lane;
//   - no changed package was loaded by the vitest main process: whole lane;
//   - no changed package was loaded by this file's worker.
// A change to `X/node_modules/b` also counts as a change to X (X now resolves a
// different b). A package.json edit that only moves dependency fields is covered
// by the lockfile; any other package.json edit is still a global input.
//
// It is held to its own bar (deps.mode `auto`, deps.bar): until `bar.runs`
// lockfile runs over `bar.days` days scored it with no failure among the files it
// would have reused, those files still run, and the run logs what it WOULD have
// reused (`deps-<host>.tsv`). Once enforcing, its reuses are ordinary reuse
// decisions: audited, and a miss among them suspends the lane like any other.
//
// THE ORACLE (shadow only). For a lockfile run, `writeDepsPacket` records the
// changed packages (versions, semver class, how many test files loaded each) and,
// after the run, which files failed. An agent session reads it over MCP
// (`read_deps`) and records which files it predicts the bump can affect
// (`annotate_deps`). Nothing reads those predictions back; `deps score` compares
// them with the full run. It skips nothing, ever.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ctx } from './config.mjs';
import { appendTsv, ledgerDir, readTsv } from './ledger.mjs';

export { pkgOf } from './pkg.mjs';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'overrides'];

/** Does a package.json edit touch ONLY dependency fields? Pure over the two texts. */
export function depsOnlyPackageJson(before, after) {
  if (before === null || after === null) return false;
  let a, b; try { a = JSON.parse(before); b = JSON.parse(after); } catch { return false; }
  for (const f of DEP_FIELDS) { delete a[f]; delete b[f]; }
  const canon = (o) => JSON.stringify(o, Object.keys(o).sort());
  return canon(a) === canon(b) && JSON.stringify(a) === JSON.stringify(b);
}

/** `packages` of an npm v2/v3 lockfile, or null for anything else. Pure. */
export function lockPackages(text) {
  if (text === null) return null;
  let j; try { j = JSON.parse(text); } catch { return null; }
  if (!(j.lockfileVersion >= 2) || !j.packages || typeof j.packages !== 'object') return null;
  return j.packages;
}

const native = (e) => !!(e && (e.hasInstallScript || e.os || e.cpu));
const same = (a, b) => !!a && !!b && a.version === b.version && a.resolved === b.resolved && a.integrity === b.integrity && !!a.link === !!b.link;

/**
 * What a lockfile change changed, keyed like the lockfile (`node_modules/x`,
 * `node_modules/a/node_modules/b`). Pure. Returns null when either side is not an
 * npm v2/v3 lockfile. `native` lists changed keys with native code.
 */
export function lockDiff(beforeText, afterText) {
  const a = lockPackages(beforeText), b = lockPackages(afterText);
  if (!a || !b) return null;
  const changed = new Set(); const nativeKeys = []; const versions = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === '' || !k.includes('node_modules/')) continue; // the root and workspace sources are repo files
    if (same(a[k], b[k])) continue;
    if (a[k]?.link || b[k]?.link) continue; // a link to a workspace: its source is a repo file
    changed.add(k);
    versions[k] = { from: a[k]?.version ?? null, to: b[k]?.version ?? null };
    if (native(a[k]) || native(b[k])) nativeKeys.push(k);
    // X/node_modules/b changed ⇒ X resolves something else now.
    let p = k;
    for (let i = p.lastIndexOf('/node_modules/'); i > 0; i = p.lastIndexOf('/node_modules/')) { p = p.slice(0, i); changed.add(p); }
  }
  return { changed, native: nativeKeys, versions };
}

/** A key relative to the lockfile's directory → repo-relative. */
export const repoKey = (lockfile, key) => (path.posix.dirname(lockfile) === '.' ? key : `${path.posix.dirname(lockfile)}/${key}`);

/** semver class of a version move: major | minor | patch | added | removed | other. Pure. */
export function semverClass(from, to) {
  if (!from) return 'added'; if (!to) return 'removed';
  const p = (v) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
  const x = p(from), y = p(to);
  if (!x || !y) return 'other';
  return x[0] !== y[0] ? 'major' : x[1] !== y[1] ? 'minor' : x[2] !== y[2] ? 'patch' : 'other';
}

// ── the rule's own bar ──────────────────────────────────────────────────────
/** May the dependency rule's reuses be enforced in this lane? */
export function depsBar(laneName) {
  const c = ctx(); const d = c.deps;
  if (d.mode === 'off' || d.mode === 'shadow') return { ok: false, mode: d.mode, why: `deps mode ${d.mode}` };
  if (d.mode === 'enforce') return { ok: true, mode: d.mode, why: 'deps mode enforce' };
  const rows = readTsv('deps-').filter((r) => r.lane === laneName);
  const now = Date.now(), day = 86_400_000;
  const scored = rows.filter((r) => Number(r.would_reuse) > 0);
  const bad = rows.some((r) => Number(r.failed_of_those) > 0 && now - Date.parse(r.at) < c.missSuspendDays * day);
  const first = scored.length ? Math.min(...scored.map((r) => Date.parse(r.at))) : now;
  const span = (now - first) / day;
  const ok = scored.length >= d.bar.runs && span >= d.bar.days && !bad;
  return { ok, mode: d.mode, runs: scored.length, spanDays: +span.toFixed(1), bad, why: ok ? 'deps bar met' : `deps bar not met (${scored.length}/${d.bar.runs} scored lockfile runs over ${span.toFixed(1)}/${d.bar.days} days${bad ? ', a recent failure among files it would have reused' : ''})` };
}

// ── the oracle (shadow) ─────────────────────────────────────────────────────
const depsDir = () => path.join(ledgerDir(), 'deps');
const depsOpinionsFile = () => path.join(ledgerDir(), `deps-opinions-${ctx().host}.jsonl`);
export const DEPS_PACKETS_HEADER = ['at', 'id', 'lane', 'head', 'packages', 'files', 'failed'];

/**
 * A packet for one lockfile run. `diff` is lockDiff's result (repo-relative keys),
 * `loadedBy` maps a repo key to how many test files' footprints loaded it.
 */
export function writeDepsPacket({ lane: laneName, head, lockfile, diff, loadedBy = null, runner = [], files = 0, failed = [] }) {
  const at = new Date().toISOString();
  const id = `deps-${laneName}-${head.slice(0, 12)}-${at.replace(/[-:.TZ]/g, '').slice(0, 17)}-${crypto.randomBytes(3).toString('hex')}`;
  const packages = [...diff.changed].sort().map((k) => {
    const v = diff.versions[k] ?? { from: null, to: null };
    return { key: k, name: k.slice(k.lastIndexOf('node_modules/') + 13), from: v.from, to: v.to, class: semverClass(v.from, v.to),
      native: diff.native.includes(k), loadedByFiles: loadedBy ? loadedBy[k] ?? 0 : null, loadedByRunner: runner.includes(k) };
  });
  const packet = { v: 1, id, at, lane: laneName, head, lockfile, files, packages, failed };
  fs.mkdirSync(depsDir(), { recursive: true });
  fs.writeFileSync(path.join(depsDir(), `${id}.json`), JSON.stringify(packet, null, 1));
  appendTsv('deps-packets-', DEPS_PACKETS_HEADER, [at, id, laneName, head.slice(0, 12), packages.length, files, failed.length]);
  return packet;
}

export function readDepsPacket(id) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(id))) throw new Error(`bad packet id ${JSON.stringify(id)}`);
  return JSON.parse(fs.readFileSync(path.join(depsDir(), `${id}.json`), 'utf8'));
}

export function listDeps(n = 20) {
  const ops = depsOpinions();
  return readTsv('deps-packets-').filter((r) => r.id).slice(-n).reverse().map((r) => ({ ...r, predicted: ops.some((o) => o.id === r.id) }));
}

export function depsOpinions() {
  let out = [];
  for (const f of (() => { try { return fs.readdirSync(ledgerDir()).filter((x) => x.startsWith('deps-opinions-') && x.endsWith('.jsonl')); } catch { return []; } })()) {
    out = out.concat(fs.readFileSync(path.join(ledgerDir(), f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
  }
  return out;
}

/** Closed world, like the Red Reader's opinions. `affected` is 'all', 'none' or a list of test files. */
export function annotateDeps(o) {
  const errors = [];
  const known = new Set(['id', 'affected', 'confidence', 'reasons', 'by']);
  for (const k of Object.keys(o)) if (!known.has(k)) errors.push(`unknown field ${k}`);
  if (!(o.affected === 'all' || o.affected === 'none' || (Array.isArray(o.affected) && o.affected.length <= 5000 && o.affected.every((f) => typeof f === 'string')))) errors.push("affected must be 'all', 'none' or a list of test files");
  if (!(typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1)) errors.push('confidence must be a number from 0 to 1');
  if (typeof o.reasons !== 'string' || !o.reasons.trim() || o.reasons.length > 4000) errors.push('reasons must be 1–4000 characters');
  let packet = null; try { packet = readDepsPacket(o.id); } catch { errors.push(`no packet ${o.id}`); }
  if (errors.length) throw new Error(`prediction refused: ${errors.join('; ')}`);
  const rec = { at: new Date().toISOString(), id: o.id, lane: packet.lane, head: packet.head, by: String(o.by ?? 'agent').slice(0, 100), affected: o.affected, confidence: o.confidence, reasons: o.reasons };
  fs.mkdirSync(ledgerDir(), { recursive: true });
  fs.appendFileSync(depsOpinionsFile(), JSON.stringify(rec) + '\n');
  return rec;
}

/**
 * Score predictions against the full run: recall over the files that failed, and
 * the share of the lane each prediction would have run. Published whatever it shows.
 */
export function scoreDeps() {
  const out = { predictions: 0, withFailures: 0, caught: 0, failures: 0, meanShare: null, rows: [] };
  const shares = [];
  for (const o of depsOpinions()) {
    let p; try { p = readDepsPacket(o.id); } catch { continue; }
    out.predictions++;
    const set = o.affected === 'all' ? null : new Set(o.affected === 'none' ? [] : o.affected);
    const share = p.files ? (set === null ? 1 : set.size / p.files) : null;
    if (share !== null) shares.push(share);
    const caught = p.failed.filter((f) => set === null || set.has(f)).length;
    if (p.failed.length) { out.withFailures++; out.failures += p.failed.length; out.caught += caught; }
    out.rows.push({ id: o.id, share, failed: p.failed.length, caught });
  }
  if (shares.length) out.meanShare = +(shares.reduce((a, b) => a + b, 0) / shares.length).toFixed(3);
  out.recall = out.failures ? +(out.caught / out.failures).toFixed(3) : null;
  return out;
}

export function deps(sub, o) {
  if (sub === 'list') { for (const r of listDeps(Number(o.n ?? 20))) console.log(`${r.at}  ${r.id}  packages ${r.packages}, failed ${r.failed}${r.predicted ? '  (predicted)' : ''}`); return; }
  if (sub === 'show') { console.log(JSON.stringify(readDepsPacket(o._id), null, 2)); return; }
  if (sub === 'annotate') {
    const affected = o.affected === 'all' || o.affected === 'none' ? o.affected : String(o.affected ?? '').split(',').filter(Boolean);
    const r = annotateDeps({ id: o._id, affected, confidence: Number(o.confidence), reasons: o.reasons, by: o.by ?? 'cli' });
    console.log(`tracegate deps: prediction on ${r.id} recorded (${Array.isArray(r.affected) ? `${r.affected.length} file(s)` : r.affected})`);
    return;
  }
  if (sub === 'score') { console.log(JSON.stringify(scoreDeps(), null, 2)); return; }
  if (sub === 'bar') { console.log(JSON.stringify(depsBar(o.lane && o.lane !== true ? o.lane : Object.keys(ctx().lanes)[0]), null, 2)); return; }
  throw new Error("deps: list | show <id> | annotate <id> --affected all|none|a,b --confidence 0..1 --reasons \"…\" | score | bar [--lane l]");
}
