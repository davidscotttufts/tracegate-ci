// `tracegate report-card [--lane l] [--json] [--out file]` — the published error rates.
//
// Everything here is read from the append-only logs (ledger.mjs); nothing is
// re-derived from footprints and nothing is written to the ledger. Per lane:
//   observations   runs in shadow or enforce, and how much of each had to run
//   misses         per CHECKED reused verdict (every reusable file in shadow, the
//                  audit sample in enforce), with a 95% Wilson interval, and per run
//   triage         each miss's latest verdict (hole / flake / untriaged)
//   exposure       per hole: the time since the lane's last complete full run
//                  before the miss. A full run checks every verdict, so this is an
//                  UPPER bound on how long the hole could have gone undetected.
//   audit cost     audited files as a share of the files enforce had to run anyway
// And once for the machine: the Red Reader's score (red.mjs) and the Conductor's
// order and train scores (conductor.mjs), unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { ctx, lane } from './config.mjs';
import { orderSummary, trainScore } from './conductor.mjs';
import { readTsv } from './ledger.mjs';
import { score as redScore } from './red.mjs';

/** The 95% Wilson score interval for k successes in n trials, as [lo, hi]; null when n = 0. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, z2 = z * z;
  const mid = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [+Math.max(0, mid - half).toFixed(4), +Math.min(1, mid + half).toFixed(4)];
}

const num = (x) => Number(x) || 0;
const hours = (ms) => +(ms / 3_600_000).toFixed(1);

export function laneCard(name) {
  const obs = readTsv('shadow-').filter((r) => r.lane === name && (r.mode === 'shadow' || r.mode === 'enforce'));
  const enf = obs.filter((r) => r.mode === 'enforce');
  const sh = obs.filter((r) => r.mode === 'shadow');
  const checked = sh.reduce((a, r) => a + num(r.reusable), 0) + enf.reduce((a, r) => a + num(r.audited), 0);
  const missed = obs.reduce((a, r) => a + num(r.misses), 0);
  const runsWithMiss = obs.filter((r) => num(r.misses) > 0).length;
  const mean = (xs) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null);

  // The latest triage verdict for each (file, head) decides, as in the entry bar.
  const verdict = new Map();
  for (const t of [...readTsv('triage-'), ...readTsv('escalations-')].filter((t) => t.lane === name).sort((a, b) => (a.at < b.at ? -1 : 1))) verdict.set(`${t.file}\0${t.head}`, t.verdict);
  const misses = readTsv('misses-').filter((m) => m.lane === name);
  const fulls = readTsv('full-').filter((r) => r.lane === name).map((r) => Date.parse(r.at)).filter(Number.isFinite).sort((a, b) => a - b);
  const triage = { hole: 0, flake: 0, untriaged: 0 };
  const holes = [];
  for (const m of misses) {
    const v = verdict.get(`${m.file}\0${m.head}`);
    if (v === 'hole') triage.hole++; else if (v === 'flake') triage.flake++; else triage.untriaged++;
    if (v !== 'hole') continue;
    const at = Date.parse(m.at);
    const before = fulls.filter((t) => t < at).pop();
    holes.push({ file: m.file, head: m.head, at: m.at, exposureHours: before === undefined ? null : hours(at - before) });
  }
  const known = holes.filter((h) => h.exposureHours !== null);
  const longest = known.length ? known.reduce((a, b) => (b.exposureHours > a.exposureHours ? b : a)) : null;
  const mustRun = enf.reduce((a, r) => a + num(r.must_run), 0);
  const audited = enf.reduce((a, r) => a + num(r.audited), 0);
  return {
    lane: name,
    observations: { runs: obs.length, shadow: sh.length, enforce: enf.length,
      first: obs[0]?.at ?? null, last: obs.at(-1)?.at ?? null,
      meanSelected: mean(obs.filter((r) => num(r.files)).map((r) => num(r.must_run) / num(r.files))),
      meanTimePct: mean(obs.map((r) => num(r.run_time_pct))) },
    misses: { checked, missed, rate: checked ? +(missed / checked).toFixed(4) : null, wilson95: wilson(missed, checked),
      runsWithMiss, perRun: obs.length ? +(runsWithMiss / obs.length).toFixed(4) : null, perRunWilson95: wilson(runsWithMiss, obs.length) },
    triage,
    holes,
    longestExposure: longest,
    auditCost: { audited, mustRun, ratio: mustRun ? +(audited / mustRun).toFixed(4) : null },
  };
}

export function reportCard(o = {}) {
  const lanes = o.lane && o.lane !== true ? [lane(o.lane).name] : Object.keys(ctx().lanes);
  return { generatedAt: new Date().toISOString(), host: ctx().host, lanes: lanes.map(laneCard), redReader: redScore(), conductor: { order: orderSummary(), train: trainScore() } };
}

const pct = (x) => (x === null || x === undefined ? '—' : `${(100 * x).toFixed(2)}%`);
const ci = (w) => (w ? `${pct(w[0])} – ${pct(w[1])}` : '—');

export function cardMarkdown(card) {
  const L = [`# Tracegate report card`, '', `Generated ${card.generatedAt} on \`${card.host}\` from the ledger's append-only logs.`, ''];
  for (const l of card.lanes) {
    const o = l.observations, m = l.misses;
    L.push(`## Lane \`${l.lane}\``, '',
      '| | |', '|---|---|',
      `| Observed runs | ${o.runs} (${o.shadow} shadow, ${o.enforce} enforce)${o.first ? `, ${o.first.slice(0, 10)} to ${o.last.slice(0, 10)}` : ''} |`,
      `| Mean share of files that had to run | ${pct(o.meanSelected)} |`,
      `| Mean share of test time that had to run | ${o.meanTimePct === null ? '—' : `${o.meanTimePct.toFixed(1)}%`} |`,
      `| Reused verdicts checked | ${m.checked} |`,
      `| Misses | ${m.missed} — ${pct(m.rate)} per checked verdict (95% CI ${ci(m.wilson95)}) |`,
      `| Runs with a miss | ${m.runsWithMiss} of ${o.runs} — ${pct(m.perRun)} (95% CI ${ci(m.perRunWilson95)}) |`,
      `| Triage of misses | ${l.triage.hole} hole, ${l.triage.flake} flake, ${l.triage.untriaged} untriaged |`,
      `| Longest hole exposure | ${l.longestExposure ? `${l.longestExposure.exposureHours} h (${l.longestExposure.file} at ${l.longestExposure.head})` : '—'} |`,
      `| Audit cost | ${l.auditCost.audited} audited files over ${l.auditCost.mustRun} that had to run (${pct(l.auditCost.ratio)}) |`, '');
  }
  const r = card.redReader, c = card.conductor;
  L.push('## Red Reader', '',
    `${r.opinions} opinion(s), ${r.scored} scored against a person's triage, ${r.agree} agreed. ${r.raised} escalation(s) raised a miss to a hole; a person overrode ${r.overridden}.`, '',
    '## Conductor', '',
    c.order.runs ? `Fail-first order on ${c.order.runs} red run(s): mean first-failure rank ${c.order.meanRank} against ${c.order.meanRandom} for a random order (ratio ${c.order.meanRatio}; better than random on ${c.order.better}).` : 'No scored red runs yet.',
    c.train.trains ? `Train advice on ${c.train.trains} train(s): ${c.train.flaggedRed} of ${c.train.red} red PRs were flagged to run alone; false-independence rate ${c.train.falseIndependenceRate ?? '—'}.` : 'No train outcomes yet.', '',
    '"Exposure" is the time since the lane\'s last complete full run before the miss: an upper bound on how long the hole could have gone undetected.', '');
  return L.join('\n');
}

export function printCard(o = {}) {
  const card = reportCard(o);
  const text = o.json ? JSON.stringify(card, null, 2) + '\n' : cardMarkdown(card);
  if (o.out && o.out !== true) { fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true }); fs.writeFileSync(o.out, text); console.log(`tracegate report-card: written to ${o.out}`); }
  else process.stdout.write(text);
  return card;
}
