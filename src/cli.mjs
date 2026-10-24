#!/usr/bin/env node
// Tracegate CLI. See README.md "Usage".
import { lane } from './config.mjs';
import { effectiveMode, fullDone, ingest, modeDecision, report, select, status, triage } from './predictor.mjs';
import { replay } from './replay.mjs';
import { runLane } from './run.mjs';
import { sync } from './sync.mjs';

const USAGE = `usage: tracegate <command> [options]

  run     --lane <l> [--mode m] [--run <dir>] [--audit r] -- <vitest args>
                                       select → vitest (recorded) → report → ingest
  mode    --lane <l>                   print the effective mode (off|shadow|enforce)
  select  --lane <l> --run <dir> [--mode m] [--audit r]
                                       write <dir>/selected.txt and <dir>/predict.json
  report  --lane <l> --run <dir>       prediction vs <dir>/results.json; log misses
  ingest  --lane <l> --run <dir> [--expect-head <sha>] [--budget-s n]
                                       record footprints of green files
  triage  --lane <l> --file <path> --verdict flake|hole [--head <sha12>]
  replay  --lane <l> --head <commit> --at <iso> [--drop <regex>] [--ignore-lock] [--node <v>] [--out <json>]
  full-done --lane <l>                 record a complete, green whole-lane run
  status                               ledger, entry bar and mode per lane
  sync    [--remote <[user@]host:/abs/ledger>]

--lane may be omitted when the config has exactly one lane.`;

function parse(argv) {
  const o = {}; const rest = [];
  const dd = argv.indexOf('--');
  const a = dd < 0 ? argv : argv.slice(0, dd);
  if (dd >= 0) rest.push(...argv.slice(dd + 1));
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const eq = a[i].indexOf('=');
    if (eq > 0) { o[a[i].slice(2, eq)] = a[i].slice(eq + 1); continue; }
    o[a[i].slice(2)] = a[i + 1]?.startsWith('--') || a[i + 1] === undefined ? true : a[++i];
  }
  return { o, rest };
}

const cmd = process.argv[2];
const { o, rest } = parse(process.argv.slice(3));
try {
  if (cmd === 'mode') { const d = modeDecision(lane(o.lane).name); console.log(effectiveMode(lane(o.lane).name)); if (o.why) console.error(d.why); }
  else if (cmd === 'select') select(o);
  else if (cmd === 'ingest') ingest(o);
  else if (cmd === 'report') report(o);
  else if (cmd === 'status') status();
  else if (cmd === 'sync') sync(o);
  else if (cmd === 'triage') triage(o);
  else if (cmd === 'full-done') fullDone(o);
  else if (cmd === 'replay') replay(o);
  else if (cmd === 'run') process.exitCode = runLane(o, rest);
  else { console.error(USAGE); process.exit(cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2); }
} catch (e) {
  console.error(`tracegate ${cmd}: ${e.message}`);
  process.exit(2);
}
