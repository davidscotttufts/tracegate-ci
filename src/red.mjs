// Red Reader (Phase 1): an escalate-only second opinion on every red run, given
// by an AI agent session (for example Claude Code) that already works in the
// repository. No model is called from here and nothing is sent anywhere: the run
// writes a PACKET into the ledger, an agent reads it through the MCP tools in
// mcp.mjs, and records an OPINION.
//
// The guardrails are structural, not promises:
//   - An opinion is closed-world validated (verdict enum, boolean escalate,
//     confidence 0..1, bounded text) and stored in its own log. Nothing in
//     Tracegate reads opinions when it selects, reports, ingests or triages.
//   - There is no path from an opinion to `triage`, so a model can never mark a
//     miss a flake, lift a suspension, turn a red green or merge anything.
//   - `escalate: true` is the only thing an opinion can do that a person sees
//     first; `red list` sorts escalations to the top.
//   - Phase 1b, the one effect an opinion can have, and only in the strict
//     direction: an escalated `real` opinion on a MISS (confidence ≥
//     red.escalateMinConfidence) writes an `escalations-` row, which the entry
//     bar reads as `hole`. That can SUSPEND enforcement (run more), never lift it
//     (run less). A person's later `triage --verdict flake` still has the last word.
//   - `red score` compares opinions with the triage a person later recorded, so
//     the reader's accuracy is measured before anyone leans on it.
//
// Files (all under the ledger, per host where a host writes them):
//   red/<id>.json               one packet per red run
//   red-<host>.tsv              index: at, id, lane, head, failed, misses
//   red-opinions-<host>.jsonl   one opinion per line
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ctx, git } from './config.mjs';
import { appendTsv, ledgerDir, readTsv, ESCALATIONS_HEADER } from './ledger.mjs';

export const RED_HEADER = ['at', 'id', 'lane', 'head', 'failed', 'misses'];
export const VERDICTS = Object.freeze(['real', 'flake-suspect', 'infra', 'unclear']);
const MAX_MSG = 4000; // per failing file, of failure text
const MAX_DIFF = 40_000; // per packet, of unified diff
const MAX_FAILED = 50; // files described in full; the rest are listed by name

const redDir = () => path.join(ledgerDir(), 'red');
const opinionsFile = () => path.join(ledgerDir(), `red-opinions-${ctx().host}.jsonl`);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more characters clipped]` : s);
// Terminal colour codes carry no meaning for a reader and cost tokens.
const plain = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

/** Failing files of a vitest JSON report, with their failure text. Pure over the parsed JSON. */
export function failuresOf(json, root) {
  const out = [];
  for (const r of json?.testResults ?? []) {
    const failedCases = (r.assertionResults ?? []).filter((a) => a.status === 'failed');
    if (r.status !== 'failed' && !failedCases.length) continue;
    let name = r.name; try { name = fs.realpathSync.native(name); } catch { /* as reported */ }
    const file = path.relative(root, name).split(path.sep).join('/');
    const parts = [];
    if (r.message) parts.push(plain(r.message));
    for (const a of failedCases) parts.push(`✗ ${a.fullName ?? a.title}\n${(a.failureMessages ?? []).map(plain).join('\n')}`);
    out.push({ file, cases: failedCases.map((a) => a.fullName ?? a.title), text: clip(parts.join('\n\n'), MAX_MSG) });
  }
  return out;
}

/**
 * Build and store the packet for a red run. `rechecks` maps a missed file to
 * 'passed' | 'failed' (the runner re-runs each miss alone). Returns the packet.
 */
export function writePacket({ lane: laneName, run, base, rechecks = {}, note = null }) {
  const c = ctx();
  let pred = null; try { pred = JSON.parse(fs.readFileSync(path.join(run, 'predict.json'), 'utf8')); } catch { /* no prediction: a plain run */ }
  let json = null; try { json = JSON.parse(fs.readFileSync(path.join(run, 'results.json'), 'utf8')); } catch { /* no report */ }
  let missed = []; try { missed = fs.readFileSync(path.join(run, 'misses.txt'), 'utf8').split('\n').filter(Boolean); } catch { /* none */ }
  const head = pred?.head ?? git('rev-parse', 'HEAD').trim();
  const failures = json ? failuresOf(json, c.root) : [];
  const triage = readTsv('triage-'); const misses = readTsv('misses-');
  const failed = failures.slice(0, MAX_FAILED).map((f) => ({
    ...f,
    prediction: pred?.decisions?.[f.file] ? { run: !!pred.decisions[f.file].run, audit: !!pred.decisions[f.file].audit, reason: pred.decisions[f.file].reason } : null,
    miss: missed.includes(f.file),
    recheckAlone: rechecks[f.file] ?? null,
    history: {
      misses: misses.filter((m) => m.file === f.file).length,
      triaged: triage.filter((t) => t.file === f.file).map((t) => ({ at: t.at, head: t.head, verdict: t.verdict })).slice(-5),
    },
  }));
  // What changed: against --base when given, else against the first parent.
  const baseRef = base && base !== true ? base : `${head}^`;
  const tryGit = (...a) => { try { return git(...a); } catch { return ''; } };
  const names = tryGit('diff', '--name-status', baseRef, head).trim();
  const diff = tryGit('diff', '--unified=3', '--no-color', baseRef, head);
  const at = new Date().toISOString();
  // Milliseconds plus a random suffix: two packets from one process within the same
  // second must not share an id (MEASURED: they did, and the second overwrote the first).
  const id = `${laneName}-${head.slice(0, 12)}-${at.replace(/[-:.TZ]/g, '').slice(0, 17)}-${crypto.randomBytes(3).toString('hex')}`;
  const packet = {
    v: 1, id, at, host: c.host, lane: laneName, head, base: baseRef, mode: pred?.mode ?? null,
    contended: process.env.TRACEGATE_CONTENDED === '1',
    machine: { cores: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length, load1: +os.loadavg()[0].toFixed(2), freeMB: Math.round(os.freemem() / 1048576) },
    failedCount: failures.length, failed, moreFailed: failures.slice(MAX_FAILED).map((f) => f.file),
    changed: names ? names.split('\n') : [], diff: clip(diff, MAX_DIFF), note,
  };
  fs.mkdirSync(redDir(), { recursive: true });
  fs.writeFileSync(path.join(redDir(), `${id}.json`), JSON.stringify(packet, null, 1));
  appendTsv('red-', RED_HEADER, [at, id, laneName, head.slice(0, 12), failures.length, missed.length]);
  return packet;
}

export function readPacket(id) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(id))) throw new Error(`bad packet id ${JSON.stringify(id)}`);
  return JSON.parse(fs.readFileSync(path.join(redDir(), `${id}.json`), 'utf8'));
}

export function opinions() {
  let lines = [];
  for (const f of (() => { try { return fs.readdirSync(ledgerDir()).filter((n) => n.startsWith('red-opinions-') && n.endsWith('.jsonl')); } catch { return []; } })()) {
    lines = lines.concat(fs.readFileSync(path.join(ledgerDir(), f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
  }
  return lines;
}

/** Recent packets, newest first, each with its latest opinion (if any). */
export function listRed(n = 20) {
  const ops = opinions();
  return readTsv('red-').filter((r) => r.id).slice(-n).reverse().map((r) => {
    const mine = ops.filter((o) => o.id === r.id);
    const last = mine[mine.length - 1] ?? null;
    return { ...r, opinion: last && { verdict: last.verdict, escalate: last.escalate, confidence: last.confidence, by: last.by, at: last.at } };
  }).sort((a, b) => Number(!!b.opinion?.escalate) - Number(!!a.opinion?.escalate));
}

/**
 * Validate and store an opinion. Closed world: anything else is refused with a
 * reason, and nothing is stored. Returns the stored opinion.
 */
export function annotate(o) {
  const errors = [];
  const known = new Set(['id', 'verdict', 'escalate', 'confidence', 'reasons', 'files', 'owner', 'by']);
  for (const k of Object.keys(o)) if (!known.has(k)) errors.push(`unknown field ${k}`);
  if (!VERDICTS.includes(o.verdict)) errors.push(`verdict must be one of ${VERDICTS.join(', ')}`);
  if (typeof o.escalate !== 'boolean') errors.push('escalate must be true or false');
  if (!(typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1)) errors.push('confidence must be a number from 0 to 1');
  if (typeof o.reasons !== 'string' || !o.reasons.trim() || o.reasons.length > 4000) errors.push('reasons must be 1–4000 characters');
  if (o.files !== undefined && !(Array.isArray(o.files) && o.files.every((f) => typeof f === 'string') && o.files.length <= 200)) errors.push('files must be a list of paths');
  if (o.owner !== undefined && (typeof o.owner !== 'string' || o.owner.length > 200)) errors.push('owner must be a short string');
  let packet = null;
  try { packet = readPacket(o.id); } catch { errors.push(`no packet ${o.id}`); }
  if (packet && o.files) for (const f of o.files) if (!packet.failed.some((x) => x.file === f) && !packet.moreFailed.includes(f)) errors.push(`file ${f} did not fail in ${o.id}`);
  if (errors.length) throw new Error(`opinion refused: ${errors.join('; ')}`);
  const rec = { at: new Date().toISOString(), id: o.id, lane: packet.lane, head: packet.head, by: String(o.by ?? 'agent').slice(0, 100),
    verdict: o.verdict, escalate: o.escalate, confidence: o.confidence, reasons: o.reasons, files: o.files ?? packet.failed.map((f) => f.file), owner: o.owner ?? null };
  fs.mkdirSync(ledgerDir(), { recursive: true });
  fs.appendFileSync(opinionsFile(), JSON.stringify(rec) + '\n');
  rec.escalated = escalate(rec, packet);
  return rec;
}

/**
 * Phase 1b: the stricter verdict wins. Only an escalated `real` opinion, at or
 * above the configured confidence, and only for files that were a MISS in the
 * packet, is recorded, as `hole`. Returns the files it escalated.
 */
function escalate(rec, packet) {
  const cfg = ctx().red;
  if (!cfg.escalate || rec.verdict !== 'real' || rec.escalate !== true || !(rec.confidence >= cfg.escalateMinConfidence)) return [];
  const files = rec.files.filter((f) => packet.failed.some((x) => x.file === f && x.miss));
  for (const f of files) appendTsv('escalations-', ESCALATIONS_HEADER, [rec.at, packet.lane, f, packet.head.slice(0, 12), 'hole', rec.by, packet.id, rec.confidence]);
  return files;
}

/**
 * How well opinions agreed with what a person later decided. A `triage` row for
 * the same file and head is the ground truth for misses: `hole` = real, `flake` =
 * flake-suspect. Opinions with no matching triage are counted as unscored.
 */
export function score() {
  const triage = readTsv('triage-');
  const out = { opinions: 0, scored: 0, agree: 0, disagree: [], unscored: 0, escalations: 0, raised: 0, overridden: 0 };
  // Phase 1b: how many escalations raised a miss to `hole`, and how many a person
  // later overrode with `flake` (each override is a false escalation).
  for (const e of readTsv('escalations-')) {
    out.raised++;
    if (triage.some((t) => t.lane === e.lane && t.file === e.file && t.head === e.head && t.verdict === 'flake' && t.at > e.at)) out.overridden++;
  }
  for (const o of opinions()) {
    out.opinions++; if (o.escalate) out.escalations++;
    const truth = o.files.map((f) => triage.filter((t) => t.file === f && o.head.startsWith(t.head)).pop()).filter(Boolean);
    if (!truth.length || !['real', 'flake-suspect'].includes(o.verdict)) { out.unscored++; continue; }
    out.scored++;
    const want = truth.some((t) => t.verdict === 'hole') ? 'real' : 'flake-suspect';
    if (want === o.verdict) out.agree++; else out.disagree.push({ id: o.id, said: o.verdict, triaged: want });
  }
  return out;
}

export function red(sub, o) {
  if (sub === 'list') { for (const r of listRed(Number(o.n ?? 20))) console.log(`${r.opinion?.escalate ? '!' : ' '} ${r.at}  ${r.id}  failed ${r.failed}, misses ${r.misses}${r.opinion ? `  → ${r.opinion.verdict} (${r.opinion.confidence}) by ${r.opinion.by}` : '  (no opinion)'}`); return; }
  if (sub === 'show') { console.log(JSON.stringify(readPacket(o._id), null, 2)); return; }
  if (sub === 'write') { const p = writePacket({ lane: o.lane, run: o.run, base: o.base }); console.log(`tracegate red: packet ${p.id} (${p.failedCount} failed)`); return; }
  if (sub === 'annotate') {
    const rec = annotate({ id: o._id, verdict: o.verdict, escalate: o.escalate === true || o.escalate === 'true' ? true : o.escalate === 'false' ? false : o.escalate,
      confidence: Number(o.confidence), reasons: o.reasons, ...(o.owner ? { owner: o.owner } : {}), by: o.by ?? 'cli' });
    console.log(`tracegate red: opinion on ${rec.id}: ${rec.verdict}${rec.escalate ? ' (ESCALATED)' : ''}`);
    if (rec.escalated.length) console.log(`tracegate red: raised to HOLE (enforcement suspends for the lane until a person triages it): ${rec.escalated.join(', ')}`);
    return;
  }
  if (sub === 'score') { console.log(JSON.stringify(score(), null, 2)); return; }
  throw new Error('red: list | show <id> | write --lane l --run dir [--base ref] | annotate <id> --verdict v --escalate true|false --confidence 0..1 --reasons "…" | score');
}

