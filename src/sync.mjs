// sync (optional): share the ledger with another machine over rsync.
//
// Footprints and blobs are content-addressed and immutable, and red and dependency
// packets have unique ids, so a union of those directories is always correct. Logs are
// per host (`shadow-<host>.tsv`), so they never collide: each machine sends its own and
// takes the others'.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ctx } from './config.mjs';
import { ledgerDir } from './ledger.mjs';

// Every log the ledger keeps is in exactly one of these lists (the self-test checks it
// against every log the code writes). The first list was once five names long and
// stayed that way while escalations, approved skips, green rows and packets were added:
// an escalation on one machine then never suspended the lane on the other.
export const SHARED_LOGS = ['shadow-', 'misses-', 'triage-', 'reasons-', 'full-', 'escalations-', 'red-', 'red-opinions-',
  'silenced-', 'silence-allow-', 'green-', 'conductor-', 'train-advice-', 'train-outcome-', 'deps-', 'deps-packets-', 'deps-opinions-'];
// This machine's own work list: another machine's train queue is not ours to run.
export const LOCAL_LOGS = ['trainq-'];
const SHARED_DIRS = ['fp', 'blobs', 'red', 'deps'];
const EXT = ['.tsv', '.jsonl'];

export function sync(o) {
  const remote = (o.remote && o.remote !== true ? o.remote : null) || ctx().sync;
  if (!remote) { console.log('tracegate sync: no --remote and no "sync" in tracegate.config.json — nothing to do.'); return false; }
  const L = ledgerDir();
  const host = ctx().host;
  for (const d of SHARED_DIRS) fs.mkdirSync(path.join(L, d), { recursive: true });
  // A value starting with '-' would reach rsync as an option, not a path.
  if (remote.startsWith('-')) throw new Error(`tracegate sync: refusing remote ${JSON.stringify(remote)} (starts with '-')`);
  const r = remote.replace(/\/+$/, '');
  const rs = (...a) => { try { execFileSync('rsync', ['-a', ...a], { stdio: ['ignore', 'inherit', 'inherit'] }); return true; } catch { return false; } };
  let ok = true;
  for (const d of SHARED_DIRS) {
    // Ours first: rsync creates their directory if this is a brand-new ledger.
    ok = rs('--ignore-existing', `${L}/${d}/`, `${r}/${d}/`) && ok; // ours → theirs
    ok = rs('--ignore-existing', `${r}/${d}/`, `${L}/${d}/`) && ok; // theirs → ours
  }
  // Their logs (never our own name), then ours to them.
  const each = (f) => SHARED_LOGS.flatMap((p) => EXT.map((e) => f(p, e)));
  ok = rs(...each((p, e) => `--exclude=${p}${host}${e}`), ...each((p, e) => `--include=${p}*${e}`), '--exclude=*', `${r}/`, `${L}/`) && ok;
  const mine = each((p, e) => path.join(L, `${p}${host}${e}`)).filter((f) => fs.existsSync(f));
  if (mine.length) ok = rs(...mine, `${r}/`) && ok;
  console.log(`tracegate sync: ${ok ? 'ledger exchanged with' : 'PARTIAL exchange with'} ${remote}`);
  if (!ok) process.exitCode = 1;
  return ok;
}
