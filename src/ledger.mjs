// The ledger: footprints, content-addressed blobs and append-only evidence logs.
//
//   fp/<lane>/<sha(test file)>/<commit>.json.gz   up to keepPerTest per test file
//   blobs/<sha>.json.gz                           large shared lists (loaded, reads)
//   shadow-<host>.tsv   one row per observed run   (the entry bar reads these)
//   misses-<host>.tsv   one row per MISS
//   triage-<host>.tsv   one row per triage verdict
//   reasons-<host>.tsv  one row per select: why files had to run
//   full-<host>.tsv     one row per complete full run (the backstop reads these)
//   escalations-<host>.tsv  one row per Red Reader escalation of a MISS (Phase 1b)
//   deps-<host>.tsv     one row per lockfile run: what the dependency rule would reuse, and how it went
//   conductor-<host>.tsv  one row per red run: where fail-first put the first failure
//
// It is a CACHE plus a LOG. Deleting `fp/` and `blobs/` is always safe and only
// costs predictions. The .tsv logs are the evidence; never delete them. Logs are
// per host, so ledgers synced between machines never write the same file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ctx } from './config.mjs';

export const ledgerDir = () => ctx().ledger;
const testDir = (ln, testFile) => path.join(ledgerDir(), 'fp', ln, crypto.createHash('sha256').update(testFile).digest('hex').slice(0, 32));
const blobPath = (h) => path.join(ledgerDir(), 'blobs', h + '.json.gz');

export function writeAtomic(p, buf) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, p);
}
const gz = (o) => zlib.gzipSync(JSON.stringify(o));
const ungz = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));

export function putBlob(list) {
  const h = crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 32);
  const p = blobPath(h);
  if (!fs.existsSync(p)) writeAtomic(p, gz(list));
  return h;
}
const _blobs = new Map();
export function getBlob(h) {
  const k = ledgerDir() + '\0' + h;
  if (!_blobs.has(k)) _blobs.set(k, ungz(blobPath(h)));
  return _blobs.get(k);
}

/** Footprints for a test file, newest first. Unreadable entries are skipped. `asOf` hides later ones. */
export function readFps(ln, testFile, asOf = null) {
  const d = testDir(ln, testFile);
  let names; try { names = fs.readdirSync(d).filter((f) => f.endsWith('.json.gz')); } catch { return []; }
  const out = [];
  for (const n of names) { try { out.push(ungz(path.join(d, n))); } catch { /* torn write: ignore */ } }
  const vis = asOf === null ? out : out.filter((f) => Date.parse(f.recordedAt ?? '') <= asOf);
  return vis.sort((a, b) => (b.recordedAt ?? '').localeCompare(a.recordedAt ?? ''));
}
export function writeFp(ln, fp) {
  const d = testDir(ln, fp.testFile);
  writeAtomic(path.join(d, `${fp.commit}.json.gz`), gz(fp));
  const all = fs.readdirSync(d).filter((f) => f.endsWith('.json.gz')).map((f) => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const x of all.slice(ctx().keepPerTest)) { try { fs.rmSync(path.join(d, x.f)); } catch { /* raced */ } }
}
export function dropFps(ln, testFile) { try { fs.rmSync(testDir(ln, testFile), { recursive: true, force: true }); } catch { /* none */ } }

/** Every row of every `<prefix><host>.tsv`, as objects keyed by the header. */
export function readTsv(prefix) {
  let names = []; try { names = fs.readdirSync(ledgerDir()).filter((f) => f.startsWith(prefix) && f.endsWith('.tsv')); } catch { return []; }
  const rows = [];
  for (const n of names) {
    const lines = fs.readFileSync(path.join(ledgerDir(), n), 'utf8').trim().split('\n');
    const hdr = lines.shift()?.split('\t') ?? [];
    for (const l of lines) { if (!l) continue; const v = l.split('\t'); rows.push(Object.fromEntries(hdr.map((h, i) => [h, v[i]]))); }
  }
  return rows;
}
/** Append one row to this host's `<prefix><host>.tsv`, writing the header first if new. */
export function appendTsv(prefix, header, values) {
  fs.mkdirSync(ledgerDir(), { recursive: true });
  const f = path.join(ledgerDir(), `${prefix}${ctx().host}.tsv`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, header.join('\t') + '\n');
  fs.appendFileSync(f, values.map((v) => String(v).replace(/[\t\n]/g, ' ')).join('\t') + '\n');
}
export const SHADOW_HEADER = ['at', 'lane', 'mode', 'head', 'files', 'must_run', 'reusable', 'audited', 'run_time_pct', 'misses'];
export const MISSES_HEADER = ['at', 'lane', 'head', 'file', 'reason'];
export const TRIAGE_HEADER = ['at', 'lane', 'file', 'head', 'verdict'];
export const REASONS_HEADER = ['at', 'lane', 'mode', 'head', 'files', 'must_run', 'top'];
export const FULL_HEADER = ['at', 'lane', 'head'];
export const ESCALATIONS_HEADER = ['at', 'lane', 'file', 'head', 'verdict', 'by', 'packet', 'confidence'];
export const DEPS_HEADER = ['at', 'lane', 'mode', 'head', 'changed', 'would_reuse', 'reused', 'failed_of_those', 'files'];
export const CONDUCTOR_HEADER = ['at', 'lane', 'head', 'files', 'failed', 'first_fail_rank', 'random_expected', 'mode'];
