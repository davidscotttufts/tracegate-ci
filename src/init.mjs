// `tracegate init` and `tracegate doctor`: onboarding.
//
// init     finds the Vitest projects in the repository and proposes one lane per
//          project, with the setup-file directories the project loads as globals
//          (setup files run before every test, so a change to one runs the lane).
//          It prints the plan; `--write` writes tracegate.config.json, adds the
//          recorder to each Vitest config it can patch safely, and `--mcp` adds
//          the MCP server to .mcp.json. It never overwrites an existing config.
// doctor   checks what a recorded run needs (Node, Vitest in the tested range,
//          typescript, the recorder wired, a writable ledger) and, with
//          `--canary`, records ONE test file and checks that the recorder's
//          seam still maps the modules it loaded. It changes nothing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { ctx, git, isTestFile, lane, rel, vitestTested, vitestVersion, VITEST_TESTED } from './config.mjs';
import { seamShare } from './predictor.mjs';
import { vitestBin } from './run.mjs';

const CONFIG_RE = /^(.*\/)?(vitest|vite)\.config\.(ts|mts|cts|js|mjs|cjs)$/;
const RECORDER_LINE = "...(process.env.TRACEGATE_RECORD ? ['tracegate-ci/vitest-setup'] : [])";
const MCP_ENTRY = { command: 'npx', args: ['--no-install', 'tracegate', 'mcp'] };

/** Vitest configs tracked in the repository, one per directory (vitest.config wins over vite.config). */
export function findVitestConfigs(files) {
  const byDir = new Map();
  for (const f of files) {
    const m = CONFIG_RE.exec(f);
    if (!m || f.split('/').includes('node_modules')) continue;
    const dir = (m[1] ?? '').replace(/\/$/, '');
    const prev = byDir.get(dir);
    if (!prev || (m[2] === 'vitest' && !/(^|\/)vitest\./.test(prev))) byDir.set(dir, f);
  }
  return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dir, file]) => ({ dir, file }));
}

/** The setup files a config names (string literals in `setupFiles`), minus the recorder. */
export function setupFilesOf(text) {
  const m = /setupFiles\s*:\s*/.exec(text);
  if (!m) return [];
  const i = m.index + m[0].length; let body;
  if (text[i] === '[') { // to the matching bracket: the recorder's own entry nests one
    let depth = 0, j = i;
    for (; j < text.length; j++) { if (text[j] === '[') depth++; else if (text[j] === ']' && --depth === 0) break; }
    body = text.slice(i, j + 1);
  } else body = /^('[^']*'|"[^"]*")/.exec(text.slice(i))?.[1] ?? '';
  return [...body.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).filter((s) => !s.includes('tracegate-ci'));
}

/** Globals for a lane: the directory of each setup file inside it (trailing `/`), or the file itself. */
export function globalsFor(setupFiles) {
  const out = new Set();
  for (const s of setupFiles) {
    const p = rel(s);
    if (!p || p.startsWith('..') || path.isAbsolute(s)) continue;
    const d = path.posix.dirname(p);
    out.add(d === '.' || d === '' ? p : d + '/');
  }
  return [...out].sort();
}

/** The config text with the recorder added FIRST to setupFiles, or null when that is not safe to do textually. */
export function patchConfig(text) {
  if (text.includes('tracegate-ci/vitest-setup')) return text;
  if ((text.match(/setupFiles\s*:/g) ?? []).length > 1) return null;
  if (/setupFiles\s*:\s*\[/.test(text)) return text.replace(/setupFiles\s*:\s*\[/, (s) => `${s}${RECORDER_LINE}, `);
  if (/setupFiles\s*:/.test(text)) return null; // a string or an expression: leave it to a person
  const tests = text.match(/\btest\s*:\s*\{/g) ?? [];
  if (tests.length !== 1) return null;
  return text.replace(/\btest\s*:\s*\{/, (s) => `${s}\n    setupFiles: [${RECORDER_LINE}],`);
}

/** The lanes init would write, from the repository's tracked files. */
export function proposeLanes(root, files) {
  const lanes = {};
  for (const { dir, file } of findVitestConfigs(files)) {
    let text = ''; try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    if (file.includes('/vite.config.') || /^vite\.config\./.test(file)) { if (!/\btest\s*:/.test(text)) continue; } // a vite config with no test block is not a Vitest project
    const name = dir ? dir.split('/').pop().replace(/[^A-Za-z0-9_-]/g, '_') : 'default';
    let n = name; for (let i = 2; lanes[n]; i++) n = `${name}${i}`;
    const src = fs.existsSync(path.join(root, dir, 'src')) ? 'src' : '.';
    const globals = globalsFor(setupFilesOf(text));
    lanes[n] = { dir: dir || '.', src, ...(globals.length ? { globals } : {}), _config: file };
  }
  return lanes;
}

export function init(o) {
  const root = ctx().root;
  const files = git('ls-files').split('\n').filter(Boolean);
  const cfgPath = path.join(root, 'tracegate.config.json');
  const exists = fs.existsSync(cfgPath);
  const lanes = proposeLanes(root, files);
  const names = Object.keys(lanes);
  if (!names.length) {
    console.log('tracegate init: no Vitest config (vitest.config.* or a vite.config.* with a `test` block) is tracked in this repository.');
    return 1;
  }
  const write = o.write === true;
  console.log(`tracegate init: ${names.length} Vitest project(s) in ${root}${write ? '' : ' (dry run: --write to apply)'}`);
  const config = { lanes: Object.fromEntries(names.map((n) => { const { _config, ...l } = lanes[n]; return [n, l]; })) };
  for (const n of names) console.log(`  lane ${n}: dir ${lanes[n].dir}, src ${lanes[n].src}${lanes[n].globals ? `, globals ${lanes[n].globals.join(' ')}` : ''}  (${lanes[n]._config})`);

  if (exists) console.log(`  tracegate.config.json exists — left as it is.`);
  else if (write) { fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n'); console.log('  wrote tracegate.config.json'); }
  else console.log(`  would write tracegate.config.json:\n${JSON.stringify(config, null, 2).replace(/^/gm, '    ')}`);

  let manual = 0;
  for (const n of names) {
    const f = path.join(root, lanes[n]._config);
    const text = fs.readFileSync(f, 'utf8');
    const patched = patchConfig(text);
    if (patched === text) console.log(`  ${lanes[n]._config}: recorder already wired`);
    else if (patched === null) { manual++; console.log(`  ${lanes[n]._config}: add the recorder FIRST in test.setupFiles by hand:\n      setupFiles: [${RECORDER_LINE}, /* yours */],`); }
    else if (write) { fs.writeFileSync(f, patched); console.log(`  ${lanes[n]._config}: recorder added to setupFiles`); }
    else console.log(`  ${lanes[n]._config}: would add the recorder to setupFiles`);
  }

  if (o.mcp) {
    const mp = path.join(root, '.mcp.json');
    let mcp = {}; try { mcp = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch { /* none yet */ }
    if (mcp.mcpServers?.tracegate) console.log('  .mcp.json: tracegate already registered');
    else if (write) { mcp.mcpServers = { ...(mcp.mcpServers ?? {}), tracegate: MCP_ENTRY }; fs.writeFileSync(mp, JSON.stringify(mcp, null, 2) + '\n'); console.log('  .mcp.json: tracegate MCP server added (read-only tools; add "--allow-write" to its args for the write tools)'); }
    else console.log('  .mcp.json: would add the tracegate MCP server');
  }
  console.log(`\nnext: ${write ? '' : 'tracegate init --write, then '}tracegate doctor --canary, then tracegate run (shadow until the entry bar is met; tracegate status shows the countdown).`);
  return manual ? 3 : 0;
}

// ── doctor ───────────────────────────────────────────────────────────────────

const OK = '✓', BAD = '✗', WARN = '!';

export function doctor(o) {
  let failed = 0, warned = 0;
  const say = (mark, msg) => { if (mark === BAD) failed++; if (mark === WARN) warned++; console.log(`  ${mark} ${msg}`); };
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  say(nodeMajor >= 22 ? OK : BAD, `node ${process.versions.node}${nodeMajor >= 22 ? '' : ' — Tracegate needs Node ≥ 22'}`);
  const c = ctx();
  say(c.configFound ? OK : WARN, c.configFound ? `config ${c.configPath}` : 'no tracegate.config.json — one lane "default" at the root (tracegate init proposes lanes)');
  try { fs.mkdirSync(c.ledger, { recursive: true }); fs.accessSync(c.ledger, fs.constants.W_OK); say(OK, `ledger ${c.ledger}`); } catch (e) { say(BAD, `ledger ${c.ledger} is not writable (${e.code ?? e.message})`); }
  const range = `${VITEST_TESTED.min.join('.')} ≤ vitest < ${VITEST_TESTED.belowMajor}`;
  const lanes = o.lane && o.lane !== true ? [lane(o.lane)] : Object.values(c.lanes);
  for (const ln of lanes) {
    console.log(`lane ${ln.name} (${ln.dir || '.'}):`);
    const v = vitestVersion(ln);
    if (!v) say(BAD, 'vitest does not resolve from the lane directory (npm install?)');
    else say(vitestTested(v) ? OK : WARN, `vitest ${v}${vitestTested(v) ? '' : ` — outside the tested range (${range}); run --canary`}`);
    try { createRequire(path.join(c.root, ln.dir, 'package.json')).resolve('typescript'); say(OK, 'typescript resolves'); } catch { say(BAD, 'typescript does not resolve from the lane (the predictor parses sources with it)'); }
    const configs = findVitestConfigs(fs.readdirSync(path.join(c.root, ln.dir)).map((f) => rel(ln.dir, f)));
    const wired = configs.some(({ file }) => { try { return fs.readFileSync(path.join(c.root, file), 'utf8').includes('tracegate-ci/vitest-setup'); } catch { return false; } });
    say(wired ? OK : BAD, wired ? 'recorder wired in the Vitest config' : `the Vitest config does not load tracegate-ci/vitest-setup (tracegate init --write)`);
    if (o.canary && v && wired) canary(ln, say);
  }
  console.log(failed ? `doctor: ${failed} problem(s)` : `doctor: ready${warned ? ` (${warned} warning(s))` : ''}${o.canary ? '' : ' — `--canary` also records one test file to check the recorder end to end'}`);
  return failed ? 1 : 0;
}

/** Record ONE test file and check that the modules it loaded map to source. */
function canary(ln, say) {
  const c = ctx();
  const laneAbs = path.join(c.root, ln.dir);
  const tests = git('ls-files', '--', ln.dir || '.').split('\n').filter((f) => f && isTestFile(f) && !f.split('/').includes('node_modules'));
  if (!tests.length) { say(WARN, 'canary: no tracked test file in the lane'); return; }
  const file = tests[0];
  const run = fs.mkdtempSync(path.join(os.tmpdir(), `tracegate-canary-`));
  try {
    const r = spawnSync(process.execPath, [vitestBin(laneAbs), 'run', path.join(c.root, file)], {
      cwd: laneAbs, encoding: 'utf8', env: { ...process.env, TRACEGATE_RECORD: run, TRACEGATE_ROOT: c.root, TRACEGATE_LANE: ln.name },
    });
    const { mapped, unmapped } = seamShare(run);
    if (!mapped && !unmapped) { say(BAD, `canary ${file}: nothing recorded (vitest exit ${r.status})${r.status ? `\n${(r.stderr || r.stdout).split('\n').slice(-8).join('\n')}` : ''}`); return; }
    const share = (100 * unmapped / (mapped + unmapped)).toFixed(1);
    say(unmapped ? WARN : OK, `canary ${file}: ${mapped} module(s) mapped, ${unmapped} unmapped (${share}%)${unmapped ? ' — the seam may have moved; predictions stay safe but coarse' : ''}${r.status ? ` (the test itself exited ${r.status})` : ''}`);
  } finally { fs.rmSync(run, { recursive: true, force: true }); }
}
