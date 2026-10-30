// The silence guard: a change that makes the suite test LESS cannot pass as green.
//
// Edit-level guards (protect-tests, TDD Guard) watch an agent's edits. This one
// watches the verdict: on every `tracegate run` it diffs the lane's test files
// against the base (`--base`, else the merge base with `silence.base`, default
// main, else the first parent) and flags NET additions only, so a skip that was
// already there is never a finding:
//   skip           .skip / .todo / .skipIf / .runIf, xit / xtest / xdescribe
//   only           .only (every other test in the file stops running)
//   disabled       an added `if (false)`
//   removed-test   more it( / test( calls removed than added
//   deleted-file   a test file deleted (a rename is not a deletion)
// silence.mode:
//   shadow   (default) findings are logged (`silenced-<host>.tsv`), printed, and
//            put in the red packet; the run's exit code is untouched
//   enforce  the run exits red until a PERSON allows each finding
//   off      nothing
// `tracegate silence allow --file f --by <name>` allows a file's current findings,
// pinned to that file's exact contents at HEAD: a later edit needs a new allow.
// Nothing an agent can call lifts it: there is no MCP tool, a Red Reader opinion
// does not touch it, and the Claude Code hook blocks `tracegate silence allow`.
import { ctx, git, lane } from './config.mjs';
import { appendTsv, readTsv } from './ledger.mjs';

export const SILENCED_HEADER = ['at', 'lane', 'head', 'file', 'kind', 'count', 'blob', 'allowed', 'mode'];
export const ALLOW_HEADER = ['at', 'lane', 'file', 'kind', 'blob', 'by'];
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const KINDS = {
  skip: /\b(?:it|test|describe|suite|bench)(?:\.\w+)*\.(?:skip|todo|skipIf|runIf)\b|\bx(?:it|test|describe)\s*\(/g,
  only: /\b(?:it|test|describe|suite)(?:\.\w+)*\.only\b|\bf(?:it|describe)\s*\(/g,
  disabled: /\bif\s*\(\s*(?:false|0)\s*\)/g,
};
const CALL = /\b(?:it|test)(?:\.\w+)*\s*\(/g;
const count = (lines, re) => lines.reduce((n, l) => n + (l.match(re)?.length ?? 0), 0);

/** Pure: findings from `git diff --name-status -M` and `git diff -U0` text. */
export function findings(nameStatus, diff) {
  const out = [];
  for (const l of nameStatus.split('\n').filter(Boolean)) {
    const [st, a] = l.split('\t');
    if (st === 'D' && TEST.test(a)) out.push({ file: a, kind: 'deleted-file', count: 1 });
  }
  const files = new Map(); let cur = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { const p = l.slice(4).replace(/^b\//, ''); cur = p !== '/dev/null' && TEST.test(p) ? p : null; if (cur && !files.has(cur)) files.set(cur, { add: [], del: [] }); continue; }
    if (l.startsWith('--- ') || !cur) continue;
    if (l.startsWith('+')) files.get(cur).add.push(l.slice(1));
    else if (l.startsWith('-')) files.get(cur).del.push(l.slice(1));
  }
  for (const [file, { add, del }] of files) {
    for (const [kind, re] of Object.entries(KINDS)) { const n = count(add, re) - count(del, re); if (n > 0) out.push({ file, kind, count: n }); }
    const removed = count(del, CALL) - count(add, CALL);
    if (removed > 0) out.push({ file, kind: 'removed-test', count: removed });
  }
  return out;
}

export function baseFor(head, o = {}) {
  if (o.base && o.base !== true) return o.base;
  const target = ctx().silence.base;
  try { const mb = git('merge-base', head, target).trim(); if (mb && mb !== head) return mb; } catch { /* no such branch */ }
  return `${head}^`;
}

const blobAt = (head, file) => { try { return git('rev-parse', `${head}:${file}`).trim().slice(0, 12); } catch { return 'deleted'; } };

/** Findings for a lane at `head`, each with `allowed` from a person's allow. */
export function check(o = {}) {
  const ln = lane(o.lane);
  const head = o.head ?? git('rev-parse', 'HEAD').trim();
  const base = baseFor(head, o);
  const scope = !ln.dir || ln.dir === '.' ? [] : ['--', ln.dir];
  const all = findings(git('diff', '--name-status', '-M', base, head, ...scope), git('diff', '-U0', '--no-color', '-M', base, head, ...scope));
  const allows = readTsv('silence-allow-').filter((a) => a.lane === ln.name);
  return { lane: ln.name, head, base, findings: all.map((f) => { const blob = blobAt(head, f.file); return { ...f, blob, allowed: allows.some((a) => a.file === f.file && a.kind === f.kind && a.blob === blob) }; }) };
}

/** Called by `tracegate run`: log, print, and say whether the run must go red. */
export function guard(o) {
  const mode = ctx().silence.mode;
  if (mode === 'off') return { mode, findings: [], red: false };
  const r = check(o);
  const at = new Date().toISOString();
  for (const f of r.findings) appendTsv('silenced-', SILENCED_HEADER, [at, r.lane, r.head.slice(0, 12), f.file, f.kind, f.count, f.blob, f.allowed ? 'yes' : 'no', mode]);
  const open = r.findings.filter((f) => !f.allowed);
  if (open.length) {
    const say = mode === 'enforce' ? '\x1b[31m' : '\x1b[33m';
    console.log(`${say}tracegate (${r.lane}): this change makes the suite test less — ${open.length} finding(s) against ${r.base.slice(0, 12)}${mode === 'enforce' ? '. The run is RED until a person allows each one' : ' (shadow: logged, the run is not changed)'}:\x1b[0m`);
    for (const f of open) console.log(`  ${f.kind.padEnd(13)} ${f.file}${f.count > 1 ? ` (${f.count})` : ''}`);
    console.log(`  A person allows one with: npx tracegate silence allow --lane ${r.lane} --file <file> --by <name>`);
  }
  return { mode, ...r, red: mode === 'enforce' && open.length > 0 };
}

export function allow(o) {
  if (!o.file || o.file === true) throw new Error('silence allow: --file <test file> is required');
  if (!o.by || o.by === true) throw new Error('silence allow: --by <your name> is required: an allow is a person\'s decision');
  const r = check(o);
  const mine = r.findings.filter((f) => f.file === o.file && (!o.kind || o.kind === f.kind));
  if (!mine.length) { console.log(`tracegate silence: no finding for ${o.file} at ${r.head.slice(0, 12)}.`); process.exitCode = 1; return 0; }
  for (const f of mine) appendTsv('silence-allow-', ALLOW_HEADER, [new Date().toISOString(), r.lane, f.file, f.kind, f.blob, o.by]);
  console.log(`tracegate silence: ${mine.map((f) => f.kind).join(', ')} in ${o.file} allowed by ${o.by}, for this version of the file.`);
  return mine.length;
}

export function silence(sub, o) {
  if (sub === 'check') { const r = check(o); console.log(o.json ? JSON.stringify(r, null, 2) : r.findings.length ? r.findings.map((f) => `${f.allowed ? 'allowed ' : 'OPEN    '} ${f.kind.padEnd(13)} ${f.file}`).join('\n') : `no findings against ${r.base.slice(0, 12)}`); return r.findings.some((f) => !f.allowed) ? 1 : 0; }
  if (sub === 'allow') { allow(o); return process.exitCode ?? 0; }
  throw new Error('silence: check [--lane l] [--base ref] [--json] | allow --file <f> [--kind k] --by <name>');
}
