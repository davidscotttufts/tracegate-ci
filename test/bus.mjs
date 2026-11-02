#!/usr/bin/env node
// Release-bus tests (src/bus.mjs): a shared record of what other machines are running.
// Both stores are tested: a directory, and Google Cloud Storage through a fake
// `gcloud` that keeps generations and refuses a write whose precondition fails (412),
// as GCS does. Nothing here touches a real bucket.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bus-test-')));
const repo = path.join(tmp, 'repo'); const ledger = path.join(tmp, 'ledger'); const busDir = path.join(tmp, 'bus');
fs.mkdirSync(repo);
for (const k of Object.keys(process.env)) if (k.startsWith('TRACEGATE')) delete process.env[k];
Object.assign(process.env, { TRACEGATE_ROOT: repo, TRACEGATE_LEDGER: ledger, TRACEGATE_HOST: 'here', TRACEGATE_BUS: busDir });
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
g('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'tracegate.config.json'), JSON.stringify({ lanes: { app: { dir: '.', src: 'src' } } }));
fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'a\n');
g('add', '-A'); g('commit', '-qm', 'base');

const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const B = await import('../src/bus.mjs');
const cli = (args, env = {}) => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(PKG, 'src', 'cli.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; } };
const writeState = (leases) => { fs.mkdirSync(path.join(busDir, 'state'), { recursive: true }); const n = (fs.readdirSync(path.join(busDir, 'state')).map((f) => parseInt(f, 10)).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? 0) + 1; fs.writeFileSync(path.join(busDir, 'state', `${n}.json`), JSON.stringify({ version: 1, leases })); };
const iso = (ms) => new Date(Date.now() + ms).toISOString();

// ── a lease: claim, see it, release it ──────────────────────────────────────
{
  const c = B.claim({ kind: 'gate', lane: 'app', prs: ['#1', '#2'] });
  const s = B.busStatus();
  const mine = s.leases?.find((l) => l.id === c.id);
  check('claim: a live lease appears with host, kind and PRs, and a start event is written', c.ok && mine && !mine.stale && mine.mine && mine.host === 'here' && mine.prs.join() === '#1,#2' && s.events.some((e) => e.kind === 'start' && e.lease === c.id), JSON.stringify({ c, s }));
  check('...and this machine\'s own lease is never a warning to itself', B.warnings().length === 0, JSON.stringify(B.warnings()));
  const r = B.release(c.id, { result: 'GREEN', tree: 'abc' });
  const s2 = B.busStatus();
  check('release: the lease is gone and an end event carries the result and tree', r.ok && r.released && !s2.leases.some((l) => l.id === c.id) && s2.events.some((e) => e.kind === 'end' && e.lease === c.id && e.result === 'GREEN' && e.tree === 'abc'), JSON.stringify(s2));
  check('releasing a lease that is already gone is fine', B.release(c.id).ok);
}

// ── another machine: live warns, stale never does ───────────────────────────
{
  writeState([
    { id: 'there-live', host: 'there', kind: 'deploy', startedAt: iso(-60_000), leaseUntil: iso(30 * 60_000) },
    { id: 'there-stale', host: 'there', kind: 'gate', startedAt: iso(-3 * 3600_000), leaseUntil: iso(-60_000) },
    { id: 'there-ancient', host: 'there', kind: 'gate', startedAt: iso(-3 * 86_400_000), leaseUntil: iso(-2 * 86_400_000) },
  ]);
  const w = B.warnings();
  check('another machine\'s LIVE lease is a warning that names the host and kind', w.length === 1 && /there is running a deploy/.test(w[0]), JSON.stringify(w));
  const s = B.busStatus();
  check('an expired lease reads STALE and is never a warning', s.leases.find((l) => l.id === 'there-stale')?.stale === true && !w.some((x) => /gate/.test(x)), JSON.stringify(s.leases));
  check('a lease a day past its expiry is dropped', !s.leases.some((l) => l.id === 'there-ancient'));
  const st = cli(['bus', 'status']);
  check('`tracegate bus status` shows both machines, live and stale', st.code === 0 && /live\s+deploy\s+there/.test(st.out) && /STALE gate\s+there/.test(st.out), st.out);
  writeState([]);
}

// ── no lock: a writer that loses the race re-reads and re-applies ───────────
// Deterministic: the store's first write fails because "another machine" wrote in
// between our read and our write. A race between real processes (below) only proves
// this when they happen to collide, which fast Linux runners rarely did.
{
  let state = { gen: 0, data: { version: 1, leases: [] } }; let writes = 0;
  const store = {
    read: () => ({ gen: state.gen, data: JSON.parse(JSON.stringify(state.data)) }),
    write: (gen, data) => {
      writes++;
      if (writes === 1) { state = { gen: state.gen + 1, data: { version: 1, leases: [{ id: 'theirs', host: 'there', leaseUntil: iso(60_000) }] } }; return false; }
      if (gen !== state.gen) return false;
      state = { gen: gen + 1, data }; return true;
    },
  };
  B.update({ store, deadline: Date.now() + 5000 }, (s) => ({ ...s, leases: [...s.leases, { id: 'ours', host: 'here', leaseUntil: iso(60_000) }] }));
  const ids = state.data.leases.map((l) => l.id).sort().join();
  check('a write that lost the race is re-read and re-applied: both leases land', ids === 'ours,theirs' && writes === 2, JSON.stringify({ ids, writes }));
}

// ── no lock: writers racing on one record all land ──────────────────────────
const race = async (n, env) => {
  const kids = Array.from({ length: n }, (_, i) => new Promise((res) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(path.join(PKG, 'src', 'bus.mjs'))}); const r = m.claim({ kind: 'gate' }); process.exit(r.ok ? 0 : 1);`],
      { env: { ...process.env, TRACEGATE_HOST: `racer${i}`, ...env }, stdio: 'ignore' });
    p.on('exit', (code) => res(code));
  }));
  return Promise.all(kids);
};
{
  const codes = await race(8, {});
  const s = B.busStatus();
  check('eight machines claiming at once: every lease lands (the loser re-reads and re-applies)', codes.every((c) => c === 0) && s.leases.filter((l) => l.host.startsWith('racer')).length === 8, JSON.stringify({ codes, n: s.leases.length }));
  writeState([]);
}

// ── never fail the caller ───────────────────────────────────────────────────
{
  process.env.TRACEGATE_BUS = 'off';
  check('off: every call is { ok: false, why: off } and warnings are silent', B.claim().why === 'off' && B.busStatus().why === 'off' && B.warnings().length === 0);
  process.env.TRACEGATE_BUS = 'gs://nowhere';
  process.env.TRACEGATE_GCLOUD = path.join(tmp, 'no-such-gcloud');
  let r; try { r = B.claim({ kind: 'gate' }); } catch (e) { r = { threw: e.message }; }
  check('no gcloud: { ok: false } with the reason, never a throw', r.ok === false && /not found/.test(r.why), JSON.stringify(r));
  check('...and the warning says the bus is unavailable', /^bus: unavailable/.test(B.warnings()[0] ?? ''), JSON.stringify(B.warnings()));
  const hang = path.join(tmp, 'hang-gcloud');
  fs.writeFileSync(hang, '#!/bin/sh\nsleep 30\n'); fs.chmodSync(hang, 0o755);
  process.env.TRACEGATE_GCLOUD = hang; process.env.TRACEGATE_BUS_TIMEOUT_MS = '700';
  const t0 = Date.now(); const h = B.busStatus(); const dt = Date.now() - t0;
  check('a hung gcloud is cut off at the deadline', h.ok === false && /timed out/.test(h.why) && dt < 5000, JSON.stringify({ h, dt }));
  const st = cli(['bus', 'status']);
  check('`tracegate bus status` exits 0 when the bus is unavailable', st.code === 0 && /unavailable/.test(st.out), st.out);
  delete process.env.TRACEGATE_BUS_TIMEOUT_MS;
  process.env.TRACEGATE_BUS = busDir; delete process.env.TRACEGATE_GCLOUD;
}

// ── GCS, through a fake gcloud that keeps generations ───────────────────────
{
  const gcs = path.join(tmp, 'gcs'); fs.mkdirSync(gcs);
  const fake = path.join(tmp, 'fake-gcloud');
  fs.writeFileSync(fake, `#!/usr/bin/env node
// storage objects describe|cat|cp|ls over a directory: <key>.<generation>. A write is
// conditional on --if-generation-match and is made with link(2), so it is atomic.
const fs = require('fs'), path = require('path');
const D = ${JSON.stringify(gcs)};
const a = process.argv.slice(2);
const key = (u) => u.replace(/^gs:\\/\\//, '').replace(/#\\d+$/, '').replace(/\\//g, '__');
const gens = (k) => fs.readdirSync(D).filter((f) => f.startsWith(k + '.')).map((f) => Number(f.slice(k.length + 1))).filter(Number.isFinite);
const cur = (k) => { const g = gens(k); return g.length ? Math.max(...g) : 0; };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
if (a[0] !== 'storage') die('unsupported');
if (a[1] === 'objects' && a[2] === 'describe') { const g = cur(key(a[3])); if (!g) die('ERROR: NotFound: 404 No such object'); console.log(g); }
else if (a[1] === 'cat') { const k = key(a[2]); const m = /#(\\d+)$/.exec(a[2]); const g = m ? Number(m[1]) : cur(k); const f = path.join(D, k + '.' + g); if (!g || !fs.existsSync(f)) die('ERROR: NotFound: 404'); process.stdout.write(fs.readFileSync(f)); }
else if (a[1] === 'cp' && a[2] === '-') {
  const k = key(a[3]); const want = Number((a.find((x) => x.startsWith('--if-generation-match=')) || '').split('=')[1]);
  const body = fs.readFileSync(0); const g = cur(k);
  if (Number.isFinite(want) && want !== g) die('ERROR: HTTPError 412: At least one of the pre-conditions you specified did not hold.');
  const tmp = path.join(D, '.t' + process.pid + Math.random()); fs.writeFileSync(tmp, body);
  try { fs.linkSync(tmp, path.join(D, k + '.' + (g + 1))); } catch { fs.rmSync(tmp); die('ERROR: HTTPError 412: race'); }
  fs.rmSync(tmp);
}
else if (a[1] === 'ls') { const p = key(a[2]); const names = [...new Set(fs.readdirSync(D).filter((f) => f.startsWith(p)).map((f) => f.replace(/\\.\\d+$/, '')))]; if (!names.length) die('ERROR: One or more URLs matched no objects.'); for (const n of names) console.log('gs://' + n.replace(/__/g, '/')); }
else die('unsupported');
`);
  fs.chmodSync(fake, 0o755);
  const env = { TRACEGATE_BUS: 'gs://tg-test/bus', TRACEGATE_GCLOUD: fake };
  Object.assign(process.env, env);
  const c = B.claim({ kind: 'deploy', note: 'backend' });
  const s = B.busStatus();
  check('gcs: claim and status through gcloud, with the state written by generation', c.ok && s.ok && s.leases.some((l) => l.id === c.id && l.kind === 'deploy') && fs.readdirSync(gcs).some((f) => f.startsWith('tg-test__bus__state.json.')), JSON.stringify({ c, s }));
  check('gcs: events are listed back in order', s.events.at(-1)?.kind === 'start');
  const codes = await race(6, env);
  const s2 = B.busStatus();
  check('gcs: six machines claiming at once all land through 412 retries', codes.every((x) => x === 0) && s2.leases.filter((l) => l.host.startsWith('racer')).length === 6, JSON.stringify({ codes, n: s2.leases?.length }));
  process.env.TRACEGATE_BUS = busDir; delete process.env.TRACEGATE_GCLOUD;
}

// ── sync through the bus's store: no SSH between the machines ───────────────
{
  const root = path.join(tmp, 'gcs-files'); fs.mkdirSync(root);
  const fake = path.join(tmp, 'fake-gcloud-files');
  fs.writeFileSync(fake, `#!/usr/bin/env node
// storage rsync|cp|ls with gs://… mapped onto plain files under one directory.
const fs = require('fs'), path = require('path');
const R = ${JSON.stringify(root)};
const a = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const flags = process.argv.slice(2).filter((x) => x.startsWith('--'));
const loc = (u) => u.startsWith('gs://') ? path.join(R, u.slice(5)) : u;
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)).map((f) => path.join(e.name, f)) : [e.name]) : [];
if (a[1] === 'rsync') {
  const [src, dst] = [loc(a[2]), loc(a[3])];
  if (!fs.existsSync(src)) die('ERROR: One or more URLs matched no objects.');
  for (const f of walk(src)) { const t = path.join(dst, f); if (flags.includes('--no-clobber') && fs.existsSync(t)) continue; fs.mkdirSync(path.dirname(t), { recursive: true }); fs.copyFileSync(path.join(src, f), t); }
} else if (a[1] === 'cp') {
  const dst = loc(a.at(-1)); fs.mkdirSync(dst, { recursive: true });
  for (const s of a.slice(2, -1)) fs.copyFileSync(loc(s), path.join(dst, path.basename(s)));
} else if (a[1] === 'ls') {
  const d = loc(a[2]); if (!fs.existsSync(d)) die('ERROR: One or more URLs matched no objects.');
  for (const e of fs.readdirSync(d, { withFileTypes: true })) console.log(a[2].replace(/\\/?$/, '/') + e.name + (e.isDirectory() ? '/' : ''));
} else die('unsupported');
`);
  fs.chmodSync(fake, 0o755);
  // The other machine already pushed: a blob, its shadow log, an escalation, and its train queue.
  const far = path.join(root, 'tg-test', 'ledger');
  fs.mkdirSync(path.join(far, 'blobs'), { recursive: true }); fs.writeFileSync(path.join(far, 'blobs', 'cafe.json.gz'), 'x');
  fs.writeFileSync(path.join(far, 'shadow-there.tsv'), 'at\tlane\n'); fs.writeFileSync(path.join(far, 'escalations-there.tsv'), 'at\n'); fs.writeFileSync(path.join(far, 'trainq-there.tsv'), 'at\n');
  fs.mkdirSync(path.join(ledger, 'fp', 'app'), { recursive: true }); fs.writeFileSync(path.join(ledger, 'fp', 'app', 'f.json'), '{}');
  fs.writeFileSync(path.join(ledger, 'shadow-here.tsv'), 'at\tlane\n');
  fs.mkdirSync(path.join(ledger, 'blobs'), { recursive: true }); fs.writeFileSync(path.join(ledger, 'blobs', 'cafe.json.gz'), 'ours, same content address');
  const { sync } = await import('../src/sync.mjs');
  process.env.TRACEGATE_GCLOUD = fake;
  const log = console.log; console.log = () => {};
  let ok; try { ok = sync({ remote: 'gs://tg-test/ledger' }); } finally { console.log = log; delete process.env.TRACEGATE_GCLOUD; }
  check('sync gs://: the other machine\'s blobs and shared logs arrive; ours go up', ok && fs.existsSync(path.join(ledger, 'shadow-there.tsv')) && fs.existsSync(path.join(ledger, 'escalations-there.tsv')) && fs.existsSync(path.join(far, 'shadow-here.tsv')) && fs.existsSync(path.join(far, 'fp', 'app', 'f.json')));
  check('sync gs://: the other machine\'s train queue stays there', !fs.existsSync(path.join(ledger, 'trainq-there.tsv')));
  check('sync gs://: an existing blob is never overwritten (content-addressed)', fs.readFileSync(path.join(ledger, 'blobs', 'cafe.json.gz'), 'utf8') === 'ours, same content address' && fs.readFileSync(path.join(far, 'blobs', 'cafe.json.gz'), 'utf8') === 'x');
}

// ── notes ───────────────────────────────────────────────────────────────────
{
  const n = B.note({ text: 'deploying backend after the train', to: 'peer' });
  check('a note is an event addressed to a session, host or *', n.ok && n.event.kind === 'note' && n.event.to === 'peer');
  // Built at run time: a credential-shaped literal in a shipped file is flagged by secret
  // scanners (the plugin directory blocks it), even when it is a fake one for this test.
  const fakeKey = (prefix, n) => prefix + '_' + 'x'.repeat(n);
  const bad = B.note({ text: `token ${fakeKey('ghp', 36)}` });
  check('a note that looks like it holds a credential is refused, not sent', bad.ok === false && /credential/.test(bad.why) && !B.busStatus({ n: 50 }).events.some((e) => /ghp_/.test(e.text ?? '')));
  const cl = cli(['bus', 'note', '--text', fakeKey('npm', 32)]);
  check('`tracegate bus note` exits 2 on a refused note', cl.code === 2, cl.out);
}

// ── MCP: agents can see the other machine ───────────────────────────────────
{
  writeState([{ id: 'there-gate', host: 'there', kind: 'gate', startedAt: iso(-60_000), leaseUntil: iso(30 * 60_000) }]);
  const m = spawn(process.execPath, [path.join(PKG, 'src', 'cli.mjs'), 'mcp'], { env: { ...process.env, TRACEGATE_BROKER_DIR: path.join(tmp, 'b'), TRACEGATE_BROKER_SOCKET: path.join(tmp, 's.sock') }, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = ''; const answers = [];
  m.stdout.on('data', (x) => { buf += x; let i; while ((i = buf.indexOf('\n')) >= 0) { answers.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const rpc = (id, method, params) => m.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  rpc(2, 'tools/list', {}); rpc(3, 'tools/call', { name: 'bus_status', arguments: {} });
  for (let i = 0; i < 50 && answers.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
  m.stdin.end(); m.kill();
  const tool = answers.find((a) => a.id === 2)?.result?.tools?.find((t) => t.name === 'bus_status');
  const got = JSON.parse(answers.find((a) => a.id === 3)?.result?.content?.[0]?.text ?? '{}');
  check('MCP: bus_status is a read tool and shows the other machine\'s live gate', tool?.annotations?.readOnlyHint === true && got.ok && got.leases?.some((l) => l.host === 'there' && !l.stale && !l.mine), JSON.stringify(got).slice(0, 300));
  writeState([]);
}

// ── the train holds a lease and reports its result ──────────────────────────
{
  const T = await import('../src/train.mjs');
  g('checkout', '-q', '-b', 'pr1', 'main'); fs.writeFileSync(path.join(repo, 'src', 'b.txt'), 'b\n'); g('add', '-A'); g('commit', '-qm', 'pr1'); g('checkout', '-q', 'main');
  writeState([{ id: 'there-deploy', host: 'there', kind: 'deploy', startedAt: iso(-60_000), leaseUntil: iso(30 * 60_000) }]);
  const said = []; const log = console.log; console.log = (m) => said.push(String(m));
  let r; try { T.add({ pr: 'pr1' }); r = T.run({ gate: 'true', 'no-lease': true }); } finally { console.log = log; }
  check('train: warns that another machine is deploying, and lands anyway (advisory)', said.some((m) => /WARN bus: there is running a deploy/.test(m)) && r.landed.join() === 'pr1', said.join('\n'));
  const s = B.busStatus({ n: 50 });
  const start = s.events.find((e) => e.kind === 'start' && e.work === 'train');
  const end = s.events.find((e) => e.kind === 'end' && e.lease === start?.lease);
  check('train: a start event names the PRs; the end event the result and the landed tree', start?.prs?.join() === 'pr1' && end?.result === '1 landed, 0 rejected' && end?.tree === g('rev-parse', 'main^{tree}') && end?.landed?.join() === 'pr1', JSON.stringify({ start, end }));
  check('train: its lease is released when it ends', !s.leases.some((l) => l.host === 'here'));
  process.env.TRACEGATE_BUS = 'gs://nowhere'; process.env.TRACEGATE_GCLOUD = path.join(tmp, 'no-such-gcloud');
  g('checkout', '-q', '-b', 'pr2', 'main'); fs.writeFileSync(path.join(repo, 'src', 'c.txt'), 'c\n'); g('add', '-A'); g('commit', '-qm', 'pr2'); g('checkout', '-q', 'main');
  console.log = () => {}; let r2; try { T.add({ pr: 'pr2' }); r2 = T.run({ gate: 'true', 'no-lease': true }); } finally { console.log = log; }
  check('train: an unreachable bus changes nothing about the train', r2.landed.join() === 'pr2' && !r2.invalidated, JSON.stringify(r2));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== bus tests: ${fail} FAILED, ${pass} passed ==` : `\n== bus tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
