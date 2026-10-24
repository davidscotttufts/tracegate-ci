// sync (optional): share the ledger with another machine over rsync.
//
// Footprints and blobs are content-addressed and immutable, so a union is always
// correct; logs are per host (`shadow-<host>.tsv`), so they never collide.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ctx } from './config.mjs';
import { ledgerDir } from './ledger.mjs';

const LOGS = ['shadow-', 'misses-', 'triage-', 'reasons-', 'full-'];

export function sync(o) {
  const remote = (o.remote && o.remote !== true ? o.remote : null) || ctx().sync;
  if (!remote) { console.log('tracegate sync: no --remote and no "sync" in tracegate.config.json — nothing to do.'); return false; }
  const L = ledgerDir();
  const host = ctx().host;
  fs.mkdirSync(path.join(L, 'fp'), { recursive: true });
  fs.mkdirSync(path.join(L, 'blobs'), { recursive: true });
  // A value starting with '-' would reach rsync as an option, not a path.
  if (remote.startsWith('-')) throw new Error(`tracegate sync: refusing remote ${JSON.stringify(remote)} (starts with '-')`);
  const r = remote.replace(/\/+$/, '');
  const rs = (...a) => { try { execFileSync('rsync', ['-a', ...a], { stdio: ['ignore', 'inherit', 'inherit'] }); return true; } catch { return false; } };
  let ok = true;
  for (const d of ['fp', 'blobs']) {
    // Ours first: rsync creates their directory if this is a brand-new ledger.
    ok = rs('--ignore-existing', `${L}/${d}/`, `${r}/${d}/`) && ok; // ours → theirs
    ok = rs('--ignore-existing', `${r}/${d}/`, `${L}/${d}/`) && ok; // theirs → ours
  }
  // Their logs (never our own name), then ours to them.
  ok = rs(...LOGS.map((p) => `--exclude=${p}${host}.tsv`), ...LOGS.map((p) => `--include=${p}*.tsv`), '--exclude=*', `${r}/`, `${L}/`) && ok;
  const mine = LOGS.map((p) => path.join(L, `${p}${host}.tsv`)).filter((f) => fs.existsSync(f));
  if (mine.length) ok = rs(...mine, `${r}/`) && ok;
  console.log(`tracegate sync: ${ok ? 'ledger exchanged with' : 'PARTIAL exchange with'} ${remote}`);
  if (!ok) process.exitCode = 1;
  return ok;
}
