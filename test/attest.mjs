#!/usr/bin/env node
// Attestation tests: `tracegate attest` / `verify` in a temporary repository,
// signed with a throwaway ssh key. A commit is attested only from green runs at
// its exact tree; a tampered, moved or unsigned attestation does not verify.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-attest-test-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
for (const k of Object.keys(process.env)) if (k.startsWith('TRACEGATE')) delete process.env[k];
Object.assign(process.env, {
  TRACEGATE_ROOT: repo, TRACEGATE_LEDGER: path.join(tmp, 'ledger'), TRACEGATE_HOST: 'att',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
});
const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const throws = (f) => { try { f(); return ''; } catch (e) { return e.message; } };

g('init', '-q', '-b', 'main');
w('tracegate.config.json', JSON.stringify({ lanes: { api: { dir: 'api' }, web: { dir: 'web' } } }));
w('api/a.ts', 'a\n'); w('web/b.ts', 'b\n');
g('add', '-A'); g('commit', '-qm', 'base');
const C = g('rev-parse', 'HEAD');

// A throwaway signing key, and an allowed-signers file naming it.
const key = path.join(tmp, 'id_ed25519');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'dana@example.invalid', '-f', key]);
const allowed = path.join(tmp, 'allowed_signers');
fs.writeFileSync(allowed, `dana@example.invalid namespaces="tracegate-attest" ${fs.readFileSync(`${key}.pub`, 'utf8')}`);
g('config', 'gpg.format', 'ssh'); g('config', 'user.signingkey', key); g('config', 'gpg.ssh.allowedSignersFile', allowed);

const A = await import('../src/attest.mjs');
const rep = { total: 10, reusable: 7, audited: 1 };

// ── nothing is attested that was not run green ──────────────────────────────
check('no green run at the commit: no attestation', /lane api has no green tracegate run/.test(throws(() => A.attest({}))));
A.recordGreen({ lane: 'api', mode: 'enforce', head: C, rep });
check('every lane needs its green run (web has none yet)', /lane web has no green/.test(throws(() => A.attest({}))));
A.recordGreen({ lane: 'web', mode: 'shadow', head: C, rep: { total: 4, reusable: 0, audited: 0 } });

// ── signed and verified ─────────────────────────────────────────────────────
const st = A.attest({});
check('attest signs with the repository\'s ssh signing key', st.signed && st.format === 'ssh' && st.tree === g('rev-parse', 'HEAD^{tree}'), JSON.stringify(st));
check('the statement says what ran: api enforce 4 of 10 (3 ran + 1 audit), 6 reused', (() => { const l = st.lanes.find((x) => x.lane === 'api'); return l.mode === 'enforce' && l.ran === 4 && l.reused === 6 && l.audited === 1 && l.node === process.version; })(), JSON.stringify(st.lanes));
const v = A.verify({});
check('verify: good signature, by the allowed signer, commit and tree match', v.ok && v.signature === 'good' && v.signer === 'dana@example.invalid', JSON.stringify(v));

// ── what must not verify ────────────────────────────────────────────────────
const note = JSON.parse(g('notes', '--ref=tracegate', 'show', C));
const forged = JSON.parse(note.payload); forged.lanes[0].ran = 10; forged.lanes[0].reused = 0;
g('notes', '--ref=tracegate', 'add', '-f', '-m', JSON.stringify({ ...note, payload: JSON.stringify(forged) }), C);
const vf = A.verify({});
check('a statement edited after signing does not verify', !vf.ok && vf.signature === 'bad', JSON.stringify(vf));
g('notes', '--ref=tracegate', 'add', '-f', '-m', JSON.stringify(note), C);
w('api/a.ts', 'changed\n'); g('commit', '-qam', 'next');
const D = g('rev-parse', 'HEAD');
g('notes', '--ref=tracegate', 'copy', C, D);
const vm = A.verify({ commit: D });
check('an attestation copied to another commit does not verify for it', !vm.ok && vm.why.some((x) => /not this commit/.test(x)) && vm.why.some((x) => /tree/.test(x)), JSON.stringify(vm.why));
A.recordGreen({ lane: 'api', mode: 'enforce', head: D, rep });
fs.appendFileSync(path.join(tmp, 'ledger', 'green-att.tsv'), [new Date().toISOString(), 'web', 'shadow', D, 'f'.repeat(40), 4, 4, 0, 0, process.version, 'none'].join('\t') + '\n');
check('a green row for another tree does not count', /lane web has no green/.test(throws(() => A.attest({ commit: D }))));

// ── unsigned ────────────────────────────────────────────────────────────────
g('config', '--unset', 'user.signingkey');
A.recordGreen({ lane: 'web', mode: 'shadow', head: D, rep });
check('--sign without a key refuses', /no signing key/.test(throws(() => A.attest({ commit: D, sign: true }))));
const u = A.attest({ commit: D });
check('without a key the attestation is stored unsigned, and says so', u.signed === false);
check('verify refuses an unsigned one unless told to accept it', !A.verify({ commit: D }).ok && A.verify({ commit: D, 'allow-unsigned': true }).ok);
check('verify of a commit with no attestation fails', (() => { w('web/b.ts', 'c\n'); g('commit', '-qam', 'third'); const r = A.verify({}); return !r.ok && r.why[0] === 'no attestation on this commit'; })());

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== attest tests: ${fail} FAILED, ${pass} passed ==` : `\n== attest tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
