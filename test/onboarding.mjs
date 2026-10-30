#!/usr/bin/env node
// Onboarding tests: `tracegate init`, `tracegate doctor`'s pure parts, the seam
// canary's counting, and the Claude Code lease-guard hook (hooks/lease-guard.mjs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-onboarding-test-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const r = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
for (const k of Object.keys(process.env)) if (k.startsWith('TRACEGATE')) delete process.env[k];
process.env.TRACEGATE_ROOT = repo; process.env.TRACEGATE_LEDGER = path.join(tmp, 'ledger'); process.env.TRACEGATE_HOST = 'onboard';

const ini = await import('../src/init.mjs');
const cfg = await import('../src/config.mjs');
const { seamShare } = await import('../src/predictor.mjs');
const { verdict } = await import('../hooks/lease-guard.mjs');

// ── config discovery ────────────────────────────────────────────────────────
const found = ini.findVitestConfigs(['vitest.config.ts', 'packages/api/vite.config.ts', 'packages/api/vitest.config.mts', 'packages/web/vite.config.js', 'node_modules/x/vitest.config.js', 'src/a.ts']);
check('one config per directory, vitest.config over vite.config, node_modules ignored',
  JSON.stringify(found) === JSON.stringify([{ dir: '', file: 'vitest.config.ts' }, { dir: 'packages/api', file: 'packages/api/vitest.config.mts' }, { dir: 'packages/web', file: 'packages/web/vite.config.js' }]), JSON.stringify(found));
check('setupFiles literals are read, the recorder is not one of them',
  JSON.stringify(ini.setupFilesOf(`test: { setupFiles: [...(process.env.TRACEGATE_RECORD ? ['tracegate-ci/vitest-setup'] : []), './test/setup/db.ts', "vitest.setup.ts"] }`)) === JSON.stringify(['./test/setup/db.ts', 'vitest.setup.ts']));
check('a setup file in a directory makes the directory global; one at the lane root stays a file',
  JSON.stringify(ini.globalsFor(['./test/setup/db.ts', 'vitest.setup.ts', '../outside.ts'])) === JSON.stringify(['test/setup/', 'vitest.setup.ts']));

// ── patching a Vitest config ────────────────────────────────────────────────
const withList = `export default defineConfig({ test: { setupFiles: ['./s.ts'] } });`;
const p1 = ini.patchConfig(withList);
check('the recorder goes FIRST in an existing setupFiles list', p1?.includes(`setupFiles: [...(process.env.TRACEGATE_RECORD ? ['tracegate-ci/vitest-setup'] : []), './s.ts']`), p1);
check('patching is idempotent', ini.patchConfig(p1) === p1);
const p2 = ini.patchConfig(`export default defineConfig({\n  test: {\n    include: ['t/**'],\n  },\n});`);
check('a config without setupFiles gets one inside its test block', /test: \{\n {4}setupFiles: \[\.\.\.\(process\.env\.TRACEGATE_RECORD/.test(p2 ?? ''), p2);
check('a string setupFiles is left to a person', ini.patchConfig(`test: { setupFiles: './s.ts' }`) === null);
check('two test blocks are left to a person', ini.patchConfig(`a = { test: {} }; b = { test: {} }`) === null);

// ── the tested Vitest range ─────────────────────────────────────────────────
check('Vitest 4.1, 4.2 and 5.x are in the tested range', ['4.1.0', '4.1.12', '4.2.0', '5.0.5'].every(cfg.vitestTested));
check('Vitest 4.0, 3.x and 6.x are outside it', !['4.0.9', '3.2.4', '6.0.0', 'x'].some(cfg.vitestTested));

// ── init on a repository ────────────────────────────────────────────────────
g('init', '-q', '-b', 'main');
w('packages/api/vitest.config.ts', `import { defineConfig } from 'vitest/config';\nexport default defineConfig({\n  test: {\n    setupFiles: ['./test/setup/env.ts'],\n  },\n});\n`);
w('packages/api/src/a.ts', 'export const a = 1;\n');
w('packages/web/vite.config.ts', `export default { plugins: [] };\n`); // no test block: not a Vitest project
w('vitest.config.ts', `export default { test: { setupFiles: process.env.X ? ['a'] : [] } };\n`);
g('add', '-A');
const quiet = (f) => { const log = console.log; console.log = () => {}; try { return f(); } finally { console.log = log; } };
const before = r('packages/api/vitest.config.ts');
quiet(() => ini.init({}));
check('a dry run writes nothing', !fs.existsSync(path.join(repo, 'tracegate.config.json')) && r('packages/api/vitest.config.ts') === before);
const rc = quiet(() => ini.init({ write: true, mcp: true }));
const written = JSON.parse(r('tracegate.config.json'));
check('--write proposes one lane per Vitest project, with setup dirs as globals and src when it exists',
  JSON.stringify(written) === JSON.stringify({ lanes: { default: { dir: '.', src: '.' }, api: { dir: 'packages/api', src: 'src', globals: ['test/setup/'] } } }), JSON.stringify(written));
check('--write wires the recorder into a config it can patch', r('packages/api/vitest.config.ts').includes('tracegate-ci/vitest-setup'));
check('a config it cannot patch is left alone and the exit code says so', r('vitest.config.ts').includes(`setupFiles: process.env.X`) && rc === 3, String(rc));
check('--mcp registers the server', JSON.parse(r('.mcp.json')).mcpServers?.tracegate?.args?.join(' ') === '--no-install tracegate mcp');
w('tracegate.config.json', '{"lanes":{"mine":{"dir":"."}}}\n');
quiet(() => ini.init({ write: true }));
check('an existing tracegate.config.json is never overwritten', r('tracegate.config.json') === '{"lanes":{"mine":{"dir":"."}}}\n');

// ── the seam canary's count ─────────────────────────────────────────────────
const run = path.join(tmp, 'run');
fs.mkdirSync(path.join(run, 'raw'), { recursive: true });
fs.writeFileSync(path.join(run, 'raw', 'a.json'), JSON.stringify({ testFile: 't', unmapped: ['src/u.ts'], exec: { 'src/a.ts': [1, 4], 'src/b.ts': { code: 'missing', offs: [10] } } }));
const s = seamShare(run);
check('canary: a module whose compiled text is missing counts as unmapped, a mapped one as mapped', s.mapped === 1 && s.unmapped === 2, JSON.stringify(s));

// ── the lease-guard hook ────────────────────────────────────────────────────
const yes = () => true;
const blocks = (cmd, env = {}, has = yes) => verdict(cmd, { cwd: repo, env, hasTracegate: has }) !== null;
check('hook: a bare vitest run is blocked', blocks('npx vitest run') && blocks('vitest') && blocks('pnpm exec vitest run src') && blocks('FOO=1 vitest run'));
check('hook: a package-manager test script is blocked', blocks('npm test') && blocks('cd x && pnpm run test') && blocks('yarn test --watch=false'));
check('hook: commands through tracegate pass', !blocks('npx tracegate run -- --maxWorkers=2') && !blocks('npx tracegate lease --class adhoc -- npm test'));
check('hook: a run inside a lease passes', !blocks('npx vitest run', { TRACEGATE_LEASE: 'j7' }));
check('hook: TRACEGATE_HOOK=off passes', !blocks('npx vitest run', { TRACEGATE_HOOK: 'off' }));
check('hook: a repository without Tracegate passes', !blocks('npx vitest run', {}, () => false));
check('hook: other commands pass', !blocks('echo vitest') && !blocks('git log') && !blocks('npm install vitest') && !blocks(undefined));
check('hook: the block names the queued form of the same command', verdict('npm test', { cwd: repo, env: {}, hasTracegate: yes }).includes('tracegate lease --class adhoc --tokens 2 -- npm test'));
// As Claude Code runs it: JSON on stdin, exit 2 + stderr to block.
const hook = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'hooks', 'lease-guard.mjs');
const runHook = (input, env = {}) => { try { execFileSync(process.execPath, [hook], { input, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'ignore', 'pipe'] }); return 0; } catch (e) { return e.status; } };
check('hook process: exit 2 blocks a bare run in a Tracegate repository', runHook(JSON.stringify({ tool_input: { command: 'npx vitest run' }, cwd: repo })) === 2);
check('hook process: exit 0 elsewhere, and on garbage input', runHook(JSON.stringify({ tool_input: { command: 'npx vitest run' }, cwd: tmp })) === 0 && runHook('not json') === 0);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== onboarding tests: ${fail} FAILED, ${pass} passed ==` : `\n== onboarding tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
