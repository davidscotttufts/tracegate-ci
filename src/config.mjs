// Configuration, paths and constants for Tracegate.
//
// Everything here is resolved LAZILY (on first use) and cached, so a caller (the
// self-test, say) can point the tool at another checkout by setting environment
// variables before its first call. `resetContext()` drops the cache.
//
// Environment (all optional):
//   TRACEGATE_ROOT          the repository to work on (default: git toplevel of cwd)
//   TRACEGATE_CONFIG        config file (default: <root>/tracegate.config.json)
//   TRACEGATE_LEDGER        ledger directory (default: <git common dir>/tracegate)
//   TRACEGATE_HOST          host name used in log file names (default: hostname)
//   TRACEGATE               mode for every lane: off|shadow|enforce|auto (default auto)
//   TRACEGATE_<LANE>        mode for one lane (upper-cased, non-alphanumerics → _)
//   TRACEGATE_MAX_AGE_HOURS footprint age limit (default 72)
//   TRACEGATE_INGEST_BUDGET_S  ingest time budget in seconds (default 300)
//   TRACEGATE_TEST_LIST     newline-separated test files (skips `vitest list`)
//   TRACEGATE_RED_ESCALATE  on|off: may a Red Reader escalation raise a flake to a hole (default on)
//   TRACEGATE_DEPS          off|shadow|auto: the dependency rule for lockfile changes (default auto)
//   TRACEGATE_CONDUCTOR     off|shadow|order: fail-first ordering (default shadow)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directory of this package (where the CLI lives). */
export const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Bump whenever the meaning of a stored footprint changes. A footprint's derived
// facts (its constant list, its function keys) are computed at ingest, so one
// ingested under an older rule can silently SKIP an edit the new rule would catch:
// footprints of another version are never reused.
export const FP_VERSION = 1;

export const DEFAULTS = Object.freeze({
  // ≥ `observations` shadow/enforce observations spanning ≥ `days` days, and no
  // un-triaged miss in the last `missSuspendDays` days.
  entryBar: { days: 14, observations: 20 },
  // Share of reusable verdicts re-run anyway, uniformly at random, under enforce.
  audit: 0.05,
  // A miss suspends enforcement for this long, whatever the lane's entry bar.
  missSuspendDays: 14,
  // A footprint cannot see the wall clock, so a verdict can go stale with no
  // change at all (a date bomb). Never reuse one older than this.
  maxAgeHours: 72,
  // A lane whose last COMPLETE full run is older than this runs whole (shadow),
  // so the full miss sweep over every reusable verdict happens at least this often.
  // 0 disables the backstop.
  fullRunMaxHours: 24,
  // Footprints kept per test file (newest first). Several are what let a tree
  // that merges two branches reuse the footprint recorded at either branch head.
  keepPerTest: 6,
  // Ingest stops recording after this many seconds; the rest simply run next time.
  ingestBudgetSeconds: 300,
  // Phase 1b: an escalated `real` opinion on a MISS, at or above this confidence,
  // raises the runner's `flake` to `hole` (the stricter verdict wins; a person's
  // later triage still has the last word).
  red: { escalate: true, escalateMinConfidence: 0.7 },
  // Phase 3: on a lockfile change, a test whose footprint loaded no changed
  // package keeps its verdict. `auto` enforces that only after `bar` lockfile runs
  // scored it with no failure among the files it would have reused.
  deps: { mode: 'auto', bar: { runs: 3, days: 1 } },
  // Phase 2: fail-first ordering. `shadow` scores it; `order` hands vitest the order.
  conductor: { mode: 'shadow' },
});

// Inputs every test in a lane depends on. A change to any of them runs the whole
// lane. Lane patterns are relative to the lane directory, root patterns to the
// repository root. `*` matches within one path segment; a trailing `/` matches a
// directory and everything under it. The config ADDS to these, never removes:
// a missing global input is a silent hole, an extra one only costs runs.
export const DEFAULT_LANE_GLOBALS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'vitest.config.*', 'vitest.workspace.*', 'vitest.setup.*', 'vite.config.*', 'tsconfig*.json'];
export const DEFAULT_ROOT_GLOBALS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  '.nvmrc', '.node-version', '.tool-versions', 'tracegate.config.json'];
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];

/** Join repo-relative path parts, posix-style, with no leading `./`. */
export function rel(...parts) {
  const p = path.posix.normalize(path.posix.join(...parts.filter((x) => x !== '' && x !== '.')));
  return p === '.' ? '' : p.replace(/^\.\//, '').replace(/\/$/, '');
}

/** Compile one glob-ish pattern (see DEFAULT_LANE_GLOBALS) to a regex source. */
export function patternSource(pat) {
  const dir = pat.endsWith('/');
  const body = (dir ? pat.slice(0, -1) : pat).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return dir ? `${body}/` : `${body}$`;
}

export const isTestFile = (p) => /\.(test|spec)\.tsx?$/.test(p);
export const isTsFile = (p) => /\.tsx?$/.test(p);

let _ctx = null;
export function resetContext() { _ctx = null; }

function gitAt(root, ...a) {
  return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });
}

function buildLane(name, raw, cfg) {
  const dir = rel(raw.dir ?? '.');
  const src = rel(dir, raw.src ?? 'src');
  const laneGlobals = [...DEFAULT_LANE_GLOBALS, ...(raw.globals ?? [])].map((g) => '^' + (dir ? `${dir.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}/` : '') + patternSource(g));
  const rootGlobals = [...DEFAULT_ROOT_GLOBALS, ...(cfg.rootGlobals ?? []), ...(raw.rootGlobals ?? [])].map((g) => '^' + patternSource(g));
  const bar = { ...DEFAULTS.entryBar, ...(cfg.entryBar ?? {}), ...(raw.entryBar ?? {}) };
  return {
    name,
    dir,
    srcPrefix: src ? src + '/' : '',
    global: new RegExp(`(${[...laneGlobals, ...rootGlobals].join('|')})`),
    bar,
    lockfile: raw.lockfile ?? null,
    replayExclude: (raw.replayExclude ?? []).map((g) => new RegExp('^' + (dir ? `${dir}/` : '') + patternSource(g))),
  };
}

/** The resolved context: root, ledger, config, lanes, settings. */
export function ctx() {
  if (_ctx) return _ctx;
  // Realpath'd: V8 reports script URLs and vitest reports test paths with
  // symlinks resolved, and every repo-relative path is computed against this.
  const root = fs.realpathSync.native(path.resolve(process.env.TRACEGATE_ROOT || gitAt(process.cwd(), 'rev-parse', '--show-toplevel').trim()));
  const common = path.resolve(root, gitAt(root, 'rev-parse', '--git-common-dir').trim());
  const cfgPath = process.env.TRACEGATE_CONFIG ? path.resolve(process.env.TRACEGATE_CONFIG) : path.join(root, 'tracegate.config.json');
  let cfg = {};
  let configFound = false;
  if (fs.existsSync(cfgPath)) { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); configFound = true; }
  const lanesRaw = cfg.lanes && Object.keys(cfg.lanes).length ? cfg.lanes : { default: { dir: '.', src: 'src' } };
  const lanes = {};
  for (const [n, l] of Object.entries(lanesRaw)) lanes[n] = buildLane(n, l, cfg);
  const num = (env, key) => (process.env[env] !== undefined && process.env[env] !== '' ? Number(process.env[env]) : cfg[key] ?? DEFAULTS[key]);
  const ledger = process.env.TRACEGATE_LEDGER
    ? path.resolve(process.env.TRACEGATE_LEDGER)
    : cfg.ledger ? path.resolve(root, cfg.ledger) : path.join(common, 'tracegate');
  _ctx = {
    root,
    ledger,
    configPath: cfgPath,
    configFound,
    lanes,
    entryBar: { ...DEFAULTS.entryBar, ...(cfg.entryBar ?? {}) },
    audit: cfg.audit ?? DEFAULTS.audit,
    missSuspendDays: cfg.missSuspendDays ?? DEFAULTS.missSuspendDays,
    maxAgeHours: num('TRACEGATE_MAX_AGE_HOURS', 'maxAgeHours'),
    fullRunMaxHours: cfg.fullRunMaxHours ?? DEFAULTS.fullRunMaxHours,
    keepPerTest: cfg.keepPerTest ?? DEFAULTS.keepPerTest,
    ingestBudgetSeconds: num('TRACEGATE_INGEST_BUDGET_S', 'ingestBudgetSeconds'),
    host: (process.env.TRACEGATE_HOST || os.hostname().split('.')[0] || 'host').replace(/[^A-Za-z0-9_-]/g, '_'),
    sync: cfg.sync ?? null,
    broker: cfg.broker ?? null, // the broker reads it (src/broker/paths.mjs)
    red: { ...DEFAULTS.red, ...(cfg.red ?? {}), ...(process.env.TRACEGATE_RED_ESCALATE ? { escalate: process.env.TRACEGATE_RED_ESCALATE !== 'off' } : {}) },
    deps: { ...DEFAULTS.deps, ...(cfg.deps ?? {}), bar: { ...DEFAULTS.deps.bar, ...(cfg.deps?.bar ?? {}) }, ...(process.env.TRACEGATE_DEPS ? { mode: process.env.TRACEGATE_DEPS } : {}) },
    conductor: { ...DEFAULTS.conductor, ...(cfg.conductor ?? {}), ...(process.env.TRACEGATE_CONDUCTOR ? { mode: process.env.TRACEGATE_CONDUCTOR } : {}) },
  };
  return _ctx;
}

export const git = (...a) => gitAt(ctx().root, ...a);

/** A lane by name; with no name and exactly one lane, that lane. */
export function lane(name) {
  const { lanes } = ctx();
  const names = Object.keys(lanes);
  const n = name && name !== true ? name : names.length === 1 ? names[0] : null;
  if (!n) throw new Error(`--lane is required (${names.join('|')})`);
  const l = lanes[n];
  if (!l) throw new Error(`unknown lane ${n} (${names.join('|')})`);
  return l;
}

/** The lane's lockfile: configured, else the first that exists in the lane dir, then the root. */
export function lockfileOf(ln, exists = (p) => fs.existsSync(path.join(ctx().root, p))) {
  if (ln.lockfile) return rel(ln.lockfile);
  for (const base of ln.dir ? [ln.dir, ''] : ['']) for (const f of LOCKFILES) { const p = rel(base, f); if (exists(p)) return p; }
  return null;
}
