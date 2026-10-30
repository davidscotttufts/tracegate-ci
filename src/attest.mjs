// `tracegate attest [--sign] [--status]` and `tracegate verify <commit>`.
//
// A signoff ("this commit is green") is a declaration: it does not say which tree
// was tested, how, or with what evidence. An attestation does. `tracegate run`
// logs every green run at an unmoved tree to `green-<host>.tsv` (commit, tree,
// mode, how many files ran, were reused and audited, the Node version and the
// lockfile hash). `attest` turns the green rows for HEAD, one per lane, into a
// statement and stores it as a git note on the commit (refs/notes/tracegate):
//   { kind, v, commit, tree, at, host, lanes: [{ lane, mode, files, ran, reused,
//     audited, node, lock }], evidence: sha256 of those rows }
// signed with the user's git signing key when one is configured (gpg.format ssh
// or openpgp, user.signingkey). A lane with no green run at HEAD, or one at a
// different tree, means no attestation: nothing is declared green that was not.
// `verify` checks the note's signature (ssh: gpg.ssh.allowedSignersFile), that
// its commit and tree are the commit's, and prints what was run.
// Share notes with `git push origin refs/notes/tracegate`; nothing is pushed here.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ctx, git, lane } from './config.mjs';
import { appendTsv, readTsv } from './ledger.mjs';
import { lockHash } from './predictor.mjs';

export const GREEN_HEADER = ['at', 'lane', 'mode', 'head', 'tree', 'files', 'ran', 'reused', 'audited', 'node', 'lock'];
const NOTES = 'tracegate';
const NS = 'tracegate-attest';

/** Called by `tracegate run` after a green run whose tree did not move. */
export function recordGreen({ lane: laneName, mode, head, rep }) {
  const tree = git('rev-parse', `${head}^{tree}`).trim();
  appendTsv('green-', GREEN_HEADER, [new Date().toISOString(), laneName, mode, head, tree, rep.total, rep.total - rep.reusable + rep.audited, rep.reusable - rep.audited, rep.audited, process.version, lockHash(laneName)]);
}

const cfg = (k) => { try { return git('config', '--get', k).trim(); } catch { return ''; } };

/** The statement for `commit`, from the green log; throws when a lane has no green run there. */
export function statement(commit, o = {}) {
  const tree = git('rev-parse', `${commit}^{tree}`).trim();
  const lanes = o.lane && o.lane !== true ? [lane(o.lane).name] : Object.keys(ctx().lanes);
  const rows = readTsv('green-');
  const picked = [];
  for (const l of lanes) {
    const r = rows.filter((x) => x.lane === l && x.head === commit && x.tree === tree).pop();
    if (!r) throw new Error(`lane ${l} has no green tracegate run at ${commit.slice(0, 12)} (tree ${tree.slice(0, 12)}); run it first`);
    picked.push(r);
  }
  const lanesOut = picked.map((r) => ({ lane: r.lane, mode: r.mode, files: +r.files, ran: +r.ran, reused: +r.reused, audited: +r.audited, node: r.node, lock: r.lock }));
  const evidence = crypto.createHash('sha256').update(picked.map((r) => GREEN_HEADER.map((h) => r[h]).join('\t')).join('\n')).digest('hex');
  return { kind: 'tracegate-attestation', v: 1, commit, tree, at: new Date().toISOString(), host: ctx().host, lanes: lanesOut, evidence };
}

function sign(payload, o) {
  const format = (o.format && o.format !== true ? o.format : cfg('gpg.format')) || 'openpgp';
  const key = o.key && o.key !== true ? o.key : cfg('user.signingkey');
  if (!key) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-attest-'));
  try {
    const f = path.join(dir, 'statement.json'); fs.writeFileSync(f, payload);
    if (format === 'ssh') {
      const keyFile = key.startsWith('key::') ? (() => { const k = path.join(dir, 'key.pub'); fs.writeFileSync(k, key.slice(5) + '\n'); return k; })() : key.replace(/^~/, os.homedir());
      execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', keyFile, '-n', NS, f], { stdio: ['ignore', 'ignore', 'pipe'] });
      return { format: 'ssh', signature: fs.readFileSync(`${f}.sig`, 'utf8') };
    }
    const out = execFileSync('gpg', ['--batch', '--armor', '--detach-sign', '--local-user', key, '--output', '-', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { format: 'openpgp', signature: out };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export function attest(o = {}) {
  const commit = git('rev-parse', '--verify', `${o.commit && o.commit !== true ? o.commit : 'HEAD'}^{commit}`).trim();
  const st = statement(commit, o);
  const payload = JSON.stringify(st);
  let sig = null;
  if (!o['no-sign']) {
    sig = sign(payload, o);
    if (!sig && o.sign) throw new Error('attest --sign: no signing key (set user.signingkey, or pass --key)');
  }
  const note = JSON.stringify({ payload, ...(sig ?? { format: null, signature: null }) });
  git('notes', `--ref=${NOTES}`, 'add', '-f', '-m', note, commit);
  if (o.status) {
    // Opt-in, outward-facing: a GitHub commit status, as `gh signoff` sets one.
    const r = spawnSync('gh', ['api', '-X', 'POST', `repos/{owner}/{repo}/statuses/${commit}`, '-f', 'state=success', '-f', 'context=tracegate', '-f', `description=${st.lanes.map((l) => `${l.lane} ${l.mode}: ${l.ran}/${l.files} ran`).join('; ').slice(0, 140)}`], { cwd: ctx().root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`attest --status: gh failed: ${(r.stderr || '').trim()}`);
  }
  return { ...st, signed: !!sig, format: sig?.format ?? null };
}

/** { ok, commit, tree, signed, signature: 'good' | 'bad' | 'none' | 'unchecked', why[], statement } */
export function verify(o = {}) {
  const commit = git('rev-parse', '--verify', `${o.commit && o.commit !== true ? o.commit : 'HEAD'}^{commit}`).trim();
  const tree = git('rev-parse', `${commit}^{tree}`).trim();
  let note; try { note = JSON.parse(git('notes', `--ref=${NOTES}`, 'show', commit)); } catch { return { ok: false, commit, tree, signature: 'none', why: ['no attestation on this commit'], statement: null }; }
  const why = [];
  let st = null; try { st = JSON.parse(note.payload); } catch { why.push('the attestation does not parse'); }
  if (st && st.commit !== commit) why.push(`it attests ${String(st.commit).slice(0, 12)}, not this commit`);
  if (st && st.tree !== tree) why.push(`it attests tree ${String(st.tree).slice(0, 12)}; this commit's tree is ${tree.slice(0, 12)}`);
  let signature = 'none';
  if (note.signature) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegate-verify-'));
    try {
      const f = path.join(dir, 'statement.json'); fs.writeFileSync(f, note.payload);
      fs.writeFileSync(`${f}.sig`, note.signature);
      if (note.format === 'ssh') {
        const allowed = (o['allowed-signers'] && o['allowed-signers'] !== true ? o['allowed-signers'] : cfg('gpg.ssh.allowedSignersFile')).replace(/^~/, os.homedir());
        if (!allowed) signature = 'unchecked';
        else {
          const who = spawnSync('ssh-keygen', ['-Y', 'find-principals', '-f', allowed, '-s', `${f}.sig`], { encoding: 'utf8' });
          const principal = who.status === 0 ? who.stdout.trim().split('\n')[0] : null;
          const r = principal ? spawnSync('ssh-keygen', ['-Y', 'verify', '-f', allowed, '-I', principal, '-n', NS, '-s', `${f}.sig`], { input: note.payload, encoding: 'utf8' }) : { status: 1 };
          signature = r.status === 0 ? 'good' : 'bad';
          if (principal) note.signer = principal;
        }
      } else {
        const r = spawnSync('gpg', ['--batch', '--verify', `${f}.sig`, f], { encoding: 'utf8' });
        signature = r.status === 0 ? 'good' : 'bad';
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  if (signature === 'bad') why.push('the signature does not verify');
  if (signature === 'none' && !o['allow-unsigned']) why.push('the attestation is unsigned (pass --allow-unsigned to accept that)');
  if (signature === 'unchecked') why.push('no allowed signers file to check the ssh signature against (gpg.ssh.allowedSignersFile or --allowed-signers)');
  return { ok: why.length === 0, commit, tree, signature, signer: note.signer ?? null, why, statement: st };
}

export function attestCli(o) {
  const r = attest(o);
  console.log(`tracegate attest: ${r.commit.slice(0, 12)} (tree ${r.tree.slice(0, 12)}) — ${r.lanes.map((l) => `${l.lane} ${l.mode}: ${l.ran} of ${l.files} files ran, ${l.reused} reused, ${l.audited} audited`).join('; ')}; ${r.signed ? `signed (${r.format})` : 'UNSIGNED (no signing key)'}; stored in refs/notes/${NOTES}.`);
  return 0;
}
export function verifyCli(o) {
  const r = verify(o);
  if (o.json) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  if (r.statement) console.log(`${r.commit.slice(0, 12)}: attested ${r.statement.at} on ${r.statement.host} — ${r.statement.lanes.map((l) => `${l.lane} ${l.mode}: ${l.ran}/${l.files} ran (node ${l.node}, lock ${l.lock})`).join('; ')}; signature ${r.signature}${r.signer ? ` by ${r.signer}` : ''}.`);
  console.log(r.ok ? 'tracegate verify: OK' : `tracegate verify: FAILED — ${r.why.join('; ')}`);
  return r.ok ? 0 : 1;
}
