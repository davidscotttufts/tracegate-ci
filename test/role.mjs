#!/usr/bin/env node
// Role tests (src/role/): a cross-machine lease with fencing.
//
// "Machines" are TRACEGATE_HOST values, each running the real CLI against one shared
// store: a directory (file://), a local bare git repository (git+), and Google Cloud
// Storage through a fake client that enforces generation preconditions as GCS does.
// Nothing here touches the network. The sign-in preflight runs against fake
// gcloud/firebase/gh binaries on PATH.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'src', 'cli.mjs');
let fail = 0; let pass = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-role-')));
const repo = path.join(tmp, 'webapp'); fs.mkdirSync(repo);
spawnSync('git', ['init', '-q', repo]);
const storeDir = path.join(tmp, 'roles');
const writeConfig = (roles) => fs.writeFileSync(path.join(repo, 'tracegate.config.json'), JSON.stringify({ roles: { store: `file://${storeDir}`, ...roles } }));
writeConfig({ pf: { preflight: 'echo checking >&2; exit 7' } });
const baseEnv = { ...process.env };
for (const k of Object.keys(baseEnv)) if (k.startsWith('TRACEGATE')) delete baseEnv[k];
Object.assign(baseEnv, { TRACEGATE_BROKER_DIR: path.join(tmp, 'broker'), TRACEGATE_BROKER_SOCKET: path.join(tmp, 'b.sock'), TRACEGATE_BROKER_CAPACITY: '2', TRACEGATE_BROKER_ADAPTIVE: 'off' });
const role = (host, args, extra = {}) => spawnSync(process.execPath, [CLI, 'role', ...args], { cwd: repo, env: { ...baseEnv, TRACEGATE_HOST: host, ...extra }, encoding: 'utf8', timeout: 30000 });
const roleAsync = (host, args, extra = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, 'role', ...args], { cwd: repo, env: { ...baseEnv, TRACEGATE_HOST: host, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  const r = { stdout: '', stderr: '' }; p.stdout.on('data', (d) => { r.stdout += d; }); p.stderr.on('data', (d) => { r.stderr += d; });
  p.on('exit', (status) => resolve({ ...r, status }));
});
const rec = (name) => JSON.parse(role('mac-a', ['status', name, '--json']).stdout || '{}').record;
const stopBroker = () => { try { process.kill(Number(fs.readFileSync(path.join(tmp, 'broker', 'broker.pid'), 'utf8')), 'SIGTERM'); } catch { /* none */ } };
process.on('exit', stopBroker);

// ── claim, renew, expiry ─────────────────────────────────────────────────────
{
  const a = role('mac-a', ['claim', 'cr', '--ttl', '1s']);
  check('claim: a free role is taken at epoch 1', a.status === 0 && rec('cr')?.epoch === 1 && rec('cr')?.holder?.host === 'mac-a', a.stdout + a.stderr);
  const b = role('mac-b', ['claim', 'cr']);
  check('claim: a live holder\'s role is refused with exit 3, naming the holder', b.status === 3 && /held by mac-a/.test(b.stderr), `${b.status} ${b.stderr}`);
  const r = role('mac-a', ['renew', 'cr', '--ttl', '1s']);
  check('renew: the holder extends its lease and keeps the epoch', r.status === 0 && rec('cr').epoch === 1, r.stderr);
  const okCheck = role('mac-a', ['check', 'cr', '--epoch', '1']);
  check('check: exit 0 while the epoch is current', okCheck.status === 0, okCheck.stderr);
  await sleep(1300);
  const exp = role('mac-a', ['check', 'cr', '--epoch', '1']);
  check('check: an expired lease fails check (exit 4)', exp.status === 4 && /expired/.test(exp.stderr), `${exp.status} ${exp.stderr}`);
  const b2 = role('mac-b', ['claim', 'cr']);
  const r2 = rec('cr');
  check('expiry: another machine may claim an expired role, and the epoch moves to 2', b2.status === 0 && r2.epoch === 2 && r2.holder.host === 'mac-b' && r2.history.at(-1).previous?.host === 'mac-a', b2.stdout + b2.stderr);
  const late = role('mac-a', ['renew', 'cr']);
  check('expiry: the old holder can no longer renew (exit 4)', late.status === 4, `${late.status} ${late.stderr}`);
  const rel = role('mac-b', ['release', 'cr']);
  check('release: frees the role and bumps the epoch', rel.status === 0 && rec('cr').holder === null && rec('cr').epoch === 3);
}

// ── two machines race for one role ───────────────────────────────────────────
{
  const delay = { TRACEGATE_ROLE_TEST_DELAY_MS: '400' }; // both read before either writes
  const [x, y] = await Promise.all([roleAsync('mac-a', ['claim', 'race'], delay), roleAsync('mac-b', ['claim', 'race'], delay)]);
  const codes = [x.status, y.status].sort().join(',');
  const loser = x.status === 3 ? x : y;
  check('race: of two simultaneous claims exactly one wins (exit 0) and the other gets exit 3', codes === '0,3', `${x.status} ${x.stderr} | ${y.status} ${y.stderr}`);
  check('race: ...the loser is told it lost the race', /lost the race/.test(loser.stderr), loser.stderr);
  check('race: ...and the record has one claim at epoch 1', rec('race')?.epoch === 1 && rec('race').history.length === 1);
}

// ── handover: an offer the next host accepts with its own preflight ───────────
{
  role('mac-a', ['claim', 'ho']);
  const h = role('mac-a', ['handover', 'ho', '--to', 'mac-b']);
  check('handover: the holder offers the role and keeps it until it is accepted', h.status === 0 && rec('ho').holder.host === 'mac-a' && rec('ho').offer?.to === 'mac-b' && role('mac-a', ['check', 'ho', '--epoch', '1']).status === 0, h.stdout + h.stderr);
  const c = role('mac-c', ['claim', 'ho']);
  check('handover: a third machine cannot use an offer made to another (exit 3)', c.status === 3, `${c.status} ${c.stderr}`);
  const b = role('mac-b', ['claim', 'ho']);
  const r = rec('ho');
  check('handover: the named host accepts by claiming: epoch 2, recorded as a handover from mac-a', b.status === 0 && r.epoch === 2 && r.holder.host === 'mac-b' && r.history.at(-1).action === 'handover' && r.history.at(-1).previous.host === 'mac-a' && !r.offer, JSON.stringify(r.history.at(-1)));
  check('handover: ...after which the old holder\'s check fails', role('mac-a', ['check', 'ho', '--epoch', '1']).status === 4);
}

// ── take: at any time, even from a live holder ───────────────────────────────
{
  role('mac-a', ['claim', 'tk']);
  const noReason = role('mac-b', ['take', 'tk']);
  check('take: needs a reason (exit 2)', noReason.status === 2 && /--reason/.test(noReason.stderr));
  const t = role('mac-b', ['take', 'tk', '--reason', 'mac-a sign-in expired']);
  const r = rec('tk');
  check('take: takes the role from a live holder, at a new epoch, with the reason and previous holder audited', t.status === 0 && r.epoch === 2 && r.holder.host === 'mac-b' && r.history.at(-1).action === 'take' && r.history.at(-1).reason === 'mac-a sign-in expired' && r.history.at(-1).previous?.host === 'mac-a' && r.history.at(-1).previous.live === true, JSON.stringify(r));
  const old = role('mac-a', ['check', 'tk', '--epoch', '1']);
  check('take: the old holder\'s `role check` now fails (exit 4)', old.status === 4 && /no longer current/.test(old.stderr), `${old.status} ${old.stderr}`);
}

// ── preflight ────────────────────────────────────────────────────────────────
{
  const mark = path.join(tmp, 'pf-ran');
  writeConfig({ pf: { preflight: 'echo checking >&2; exit 7' }, held: { preflight: `touch ${JSON.stringify(mark)}` } });
  role('mac-a', ['claim', 'held']); fs.rmSync(mark, { force: true });
  const h = role('mac-b', ['claim', 'held']);
  check('preflight: a claim that a live holder refuses runs no preflight', h.status === 3 && !fs.existsSync(mark), `${h.status} ${fs.existsSync(mark)}`);
  const p = role('mac-a', ['claim', 'pf']);
  check('preflight: a failing preflight blocks the claim (exit 5) and writes nothing', p.status === 5 && /preflight failed/.test(p.stderr) && !rec('pf'), `${p.status} ${p.stderr}`);
  const t = role('mac-a', ['take', 'pf', '--reason', 'r']);
  check('preflight: ...and blocks a take', t.status === 5 && !rec('pf'));
  const s = role('mac-a', ['take', 'pf', '--reason', 'emergency', '--skip-preflight']);
  check('preflight: take --skip-preflight works, loudly, and is recorded in the audit', s.status === 0 && /PREFLIGHT SKIPPED/.test(s.stderr) && rec('pf')?.history.at(-1).preflight === 'skipped', `${s.status} ${s.stderr}`);
}

// ── deploys: lease --role ────────────────────────────────────────────────────
const lease = (host, args) => spawnSync(process.execPath, [CLI, 'lease', '--quiet', ...args], { cwd: repo, env: { ...baseEnv, TRACEGATE_HOST: host }, encoding: 'utf8', timeout: 30000 });
{
  role('mac-a', ['claim', 'deployer']);
  const refused = lease('mac-b', ['--class', 'deploy', '--role', 'deployer', '--', process.execPath, '-e', 'console.log("SHIPPED")']);
  check('lease --role: refused (exit 4) on a host that does not hold the role, before it queues; the command does not run', refused.status === 4 && !refused.stdout.includes('SHIPPED') && /^tracegate lease: refused: .*not held by mac-b/m.test(refused.stderr), `${refused.status} ${refused.stdout} ${refused.stderr}`);
  const ok = lease('mac-a', ['--class', 'deploy', '--role', 'deployer', '--', process.execPath, '-e',
    `const r=require('child_process').spawnSync(process.execPath,[${JSON.stringify(CLI)},'role','check',process.env.TRACEGATE_ROLE,'--epoch',process.env.TRACEGATE_ROLE_EPOCH],{encoding:'utf8'}); console.log('EPOCH='+process.env.TRACEGATE_ROLE_EPOCH+' ROLE='+process.env.TRACEGATE_ROLE+' CHECK='+r.status)`]);
  check('lease --role: the holder\'s command runs with TRACEGATE_ROLE_EPOCH, and `role check` with it passes', ok.status === 0 && ok.stdout.includes(`EPOCH=${rec('deployer').epoch} ROLE=deployer CHECK=0`), `${ok.status} ${ok.stdout} ${ok.stderr}`);
}
{
  // A takeover mid-deploy: the running command is not killed; its check before the traffic shift fails.
  const gate = path.join(tmp, 'go');
  const p = spawn(process.execPath, [CLI, 'lease', '--quiet', '--class', 'deploy', '--role', 'deployer', '--', process.execPath, '-e',
    `const fs=require('fs'); const t=setInterval(()=>{ if(!fs.existsSync(${JSON.stringify(gate)})) return; clearInterval(t);
     const r=require('child_process').spawnSync(process.execPath,[${JSON.stringify(CLI)},'role','check','deployer','--epoch',process.env.TRACEGATE_ROLE_EPOCH],{encoding:'utf8'});
     if(r.status!==0){ console.log('STOPPED BEFORE SHIFT'); process.exit(r.status); } console.log('TRAFFIC SHIFTED'); },100);`],
  { cwd: repo, env: { ...baseEnv, TRACEGATE_HOST: 'mac-a' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  await sleep(1500);
  const t = role('mac-b', ['take', 'deployer', '--reason', 'mac-a is mid-deploy but unreachable']);
  fs.writeFileSync(gate, '');
  const code = await Promise.race([new Promise((r) => p.on('exit', r)), sleep(20000).then(() => 'timeout')]);
  check('take mid-deploy: the old holder\'s running deploy is not killed, and stops at its check before the traffic shift', t.status === 0 && code === 4 && out.includes('STOPPED BEFORE SHIFT') && !out.includes('TRAFFIC SHIFTED'), `${t.status} ${code} ${out}`);
}

// ── a requested deploy that needs the role: --on-demand AND --role ───────────
{
  role('mac-a', ['claim', 'shipper']);
  const events = () => fs.readFileSync(path.join(tmp, 'broker', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const waitFor = async (pred) => { for (let i = 0; i < 100; i++) { try { if (events().some(pred)) return true; } catch { /* no log yet */ } await sleep(100); } return false; };
  const bg = (host, args) => { const p = spawn(process.execPath, [CLI, 'lease', '--quiet', ...args], { cwd: repo, env: { ...baseEnv, TRACEGATE_HOST: host }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); return { p, out: () => out, code: new Promise((r) => p.on('exit', r)) }; };
  const done = path.join(tmp, 'hog-done');
  const hog = bg('mac-a', ['--class', 'gate', '--tokens', '2', '--label', 'od-hog', '--', process.execPath, '-e', `const fs=require('fs'); setInterval(()=>{ if(fs.existsSync(${JSON.stringify(done)})) process.exit(0); },100)`]);
  await waitFor((e) => e.type === 'grant' && events().some((x) => x.type === 'enqueue' && x.id === e.id && x.label === 'od-hog'));
  const queued = bg('mac-a', ['--class', 'gate', '--tokens', '2', '--label', 'od-queued-gate', '--', process.execPath, '-e', 'console.log("GATE")']);
  await waitFor((e) => e.type === 'enqueue' && e.label === 'od-queued-gate');
  const refused = spawnSync(process.execPath, [CLI, 'lease', '--quiet', '--class', 'deploy', '--tokens', '2', '--on-demand', '--role', 'shipper', '--label', 'od-refused', '--', process.execPath, '-e', 'console.log("SHIPPED")'], { cwd: repo, env: { ...baseEnv, TRACEGATE_HOST: 'mac-b' }, encoding: 'utf8', timeout: 30000 });
  check('on-demand + role: a requested deploy on a host without the role is refused (exit 4) and never queues', refused.status === 4 && !refused.stdout.includes('SHIPPED') && !events().some((e) => e.type === 'enqueue' && e.label === 'od-refused'), `${refused.status} ${refused.stdout} ${refused.stderr}`);
  const od = bg('mac-a', ['--class', 'deploy', '--tokens', '2', '--on-demand', '--role', 'shipper', '--label', 'od-deploy', '--', process.execPath, '-e', 'console.log("DEPLOY epoch=" + process.env.TRACEGATE_ROLE_EPOCH)']);
  await waitFor((e) => e.type === 'enqueue' && e.label === 'od-deploy');
  fs.writeFileSync(done, '');
  const [c1, c2] = await Promise.race([Promise.all([od.code, queued.code]), sleep(20000).then(() => ['timeout', 'timeout'])]);
  await hog.code;
  const ev = events(); const idOf = (label) => ev.find((e) => e.type === 'enqueue' && e.label === label)?.id;
  const seqOf = (label) => ev.find((e) => e.type === 'grant' && e.id === idOf(label))?.seq ?? Infinity;
  check('on-demand + role: the holder\'s requested deploy goes ahead of a gate queued before it, with the role\'s epoch', c1 === 0 && c2 === 0 && seqOf('od-deploy') < seqOf('od-queued-gate') && od.out().includes(`DEPLOY epoch=${rec('shipper').epoch}`) && ev.find((e) => e.type === 'enqueue' && e.label === 'od-deploy')?.onDemand === true,
    `${c1} ${c2} deploy@${seqOf('od-deploy')} gate@${seqOf('od-queued-gate')} ${od.out()}`);
}

// ── per-repo roles override the global one ───────────────────────────────────
{
  // The repo is "webapp" (its directory). mac-b holds the global deployer now.
  const g = JSON.parse(role('mac-a', ['status', 'deployer', '--json']).stdout);
  check('names: with no per-repo record, `deployer` resolves to the global role', g.role === 'deployer' && g.scope === 'global', JSON.stringify(g));
  role('mac-c', ['claim', 'deployer:webapp']);
  const r = JSON.parse(role('mac-a', ['status', 'deployer', '--json']).stdout);
  check('names: once deployer:webapp exists, `deployer` in this repo means it', r.role === 'deployer:webapp' && r.record.holder.host === 'mac-c', JSON.stringify(r));
  const l = lease('mac-b', ['--class', 'deploy', '--role', 'deployer', '--', process.execPath, '-e', 'console.log("SHIPPED")']);
  check('names: so the global holder cannot deploy this repo', l.status === 4 && !l.stdout.includes('SHIPPED'), `${l.status} ${l.stderr}`);
}

// ── the git store: one ref per role, push --force-with-lease ─────────────────
{
  const bare = path.join(tmp, 'roles.git'); spawnSync('git', ['init', '-q', '--bare', bare]);
  const { gitStore } = await import('../src/role/stores.mjs');
  const s1 = gitStore(`file://${bare}`); const s2 = gitStore(`file://${bare}`);
  const a = s1.read('deployer'); const b = s2.read('deployer');
  const w1 = s1.write('deployer', a.gen, { epoch: 1, who: 'one' }); const w2 = s2.write('deployer', b.gen, { epoch: 1, who: 'two' });
  check('git store: two writers at the same (absent) ref: exactly one push lands', w1 === true && w2 === false && s2.read('deployer').data.who === 'one', `${w1} ${w2}`);
  const c = s2.read('deployer'); const d = s1.read('deployer');
  const w3 = s2.write('deployer', c.gen, { epoch: 2, who: 'two' }); const w4 = s1.write('deployer', d.gen, { epoch: 2, who: 'one' });
  check('git store: ...and again at an existing ref (the sha is the generation)', w3 === true && w4 === false && s1.read('deployer').data.who === 'two', `${w3} ${w4}`);
  const ls = spawnSync('git', ['-C', bare, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout.trim();
  check('git store: the role is one ref under refs/tracegate/roles', ls === 'refs/tracegate/roles/deployer', ls);
  const url = { TRACEGATE_ROLES_STORE: `git+file://${bare}#refs/tracegate/roles` };
  const x = role('mac-a', ['take', 'deployer', '--reason', 'git store test'], url);
  const y = role('mac-b', ['claim', 'deployer'], url);
  check('git store: through the CLI, a claim against a live holder is refused (exit 3)', x.status === 0 && y.status === 3, `${x.status} ${x.stderr} ${y.status} ${y.stderr}`);
}

// ── the GCS store: generation preconditions, with a fake client ──────────────
{
  const { gcsStore } = await import('../src/role/stores.mjs');
  // A fake bucket: objects with generations; cp honours --if-generation-match like GCS (412).
  const objects = new Map(); let nextGen = 1000; const calls = [];
  const fake = (args, input) => {
    calls.push(args);
    const [, verb, ...rest] = args;
    if (verb === 'objects' && rest[0] === 'describe') { const o = objects.get(rest[1]); return o ? { status: 0, stdout: `${o.gen}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'ERROR: (gcloud.storage.objects.describe) 404 No URLs matched' }; }
    if (verb === 'cat') { const [u, g] = rest[0].split('#'); const o = objects.get(u); return o && String(o.gen) === g ? { status: 0, stdout: o.body, stderr: '' } : { status: 1, stdout: '', stderr: '404 not found' }; }
    if (verb === 'cp') {
      const dst = rest[1]; const pre = rest.find((a) => a.startsWith('--if-generation-match='));
      const cur = objects.get(dst)?.gen ?? 0;
      if (pre && Number(pre.split('=')[1]) !== cur) return { status: 1, stdout: '', stderr: 'ERROR: HTTPError 412: At least one of the pre-conditions you specified did not hold.' };
      objects.set(dst, { gen: ++nextGen, body: input }); return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 2, stdout: '', stderr: `fake gcloud: ${args.join(' ')}` };
  };
  const s1 = gcsStore('gs://bucket/tg', fake); const s2 = gcsStore('gs://bucket/tg', fake);
  const a = s1.read('deployer'); const b = s2.read('deployer');
  check('gcs store: an absent role reads as generation 0', a.gen === 0 && a.data === null);
  const w1 = s1.write('deployer', a.gen, { epoch: 1 }); const w2 = s2.write('deployer', b.gen, { epoch: 1, late: true });
  check('gcs store: two create-only writes at generation 0: exactly one lands, the other is a lost race (412 → false)', w1 === true && w2 === false && !s1.read('deployer').data.late, `${w1} ${w2}`);
  const c = s1.read('deployer'); const d = s2.read('deployer');
  const w3 = s2.write('deployer', d.gen, { epoch: 2 }); const w4 = s1.write('deployer', c.gen, { epoch: 2, late: true });
  check('gcs store: ...and two updates at the same generation', w3 === true && w4 === false, `${w3} ${w4}`);
  check('gcs store: every write carries --if-generation-match, and reads are pinned to a generation', calls.filter((x) => x[1] === 'cp').every((x) => x.some((y) => /^--if-generation-match=\d+$/.test(y))) && calls.filter((x) => x[1] === 'cat').every((x) => /#\d+$/.test(x[2])));
  check('gcs store: the object is <prefix>/roles/<role>.json', objects.has('gs://bucket/tg/roles/deployer.json'), JSON.stringify([...objects.keys()]));
  const bad = gcsStore('gs://bucket/tg', () => ({ status: 1, stdout: '', stderr: 'ERROR: 403 Permission denied' }));
  let threw = ''; try { bad.write('deployer', 0, {}); } catch (e) { threw = e.message; }
  check('gcs store: any other failure is an error, never a silent lost race', /403/.test(threw), threw);
}

// ── the sign-in preflight example ────────────────────────────────────────────
{
  const bin = path.join(tmp, 'fakebin'); fs.mkdirSync(bin);
  const TOKEN = 'ya29.FAKE-TOKEN-must-not-print'; const GHTOKEN = 'gho_FAKEGHTOKENmustnotprint'; const KEY = 'FAKE-PRIVATE-KEY-must-not-print';
  const fakeBin = (name, body) => { const f = path.join(bin, name); fs.writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(f, 0o755); };
  fakeBin('gcloud', `case "$*" in
  "config get-value account") echo dev@example.com;;
  "auth print-access-token") [ "\${FAKE_GCLOUD:-ok}" = ok ] && { echo ${TOKEN}; exit 0; }; echo "ERROR: Reauthentication required. token ${TOKEN}" >&2; exit 1;;
  "auth application-default print-access-token") echo ${TOKEN}; exit 0;;
  *) exit 2;; esac`);
  fakeBin('firebase', `[ "\${FAKE_FIREBASE:-ok}" = ok ] && { echo "project-a ${TOKEN}"; exit 0; }; echo "Error: Failed to authenticate, have you run firebase login?" >&2; exit 1`);
  fakeBin('gh', `[ "\${FAKE_GH:-ok}" = ok ] && { printf 'github.com\\n  ✓ Logged in to github.com account octocat (keyring)\\n  - Token: ${GHTOKEN}\\n' >&2; exit 0; }; echo "You are not logged into any GitHub hosts." >&2; exit 1`);
  const script = path.join(PKG, 'examples', 'preflight-signins.sh');
  const run = (extra = {}) => { const r = spawnSync('bash', [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GOOGLE_APPLICATION_CREDENTIALS: '', ...extra }, encoding: 'utf8', timeout: 20000 }); r.all = r.stdout + r.stderr; return r; };
  const secret = (s) => s.includes(TOKEN) || s.includes(GHTOKEN) || s.includes(KEY) || /ya29\.|gho_/.test(s);
  const ok = run();
  check('signins: all three signed in → exit 0, with the account names', ok.status === 0 && /Google Cloud: dev@example\.com/.test(ok.all) && /GitHub: octocat/.test(ok.all) && /ok +Firebase/.test(ok.all), ok.all);
  check('signins: ...and no token is printed', !secret(ok.all), ok.all);
  const g = run({ FAKE_GCLOUD: 'expired' });
  check('signins: an expired gcloud sign-in → non-zero, naming it and its headless renewal command', g.status !== 0 && /FAILED +Google Cloud: dev@example\.com/.test(g.all) && g.all.includes('gcloud auth login dev@example.com --no-browser') && /remote-bootstrap/.test(g.all), g.all);
  check('signins: ...without echoing the token in the error output', !secret(g.all), g.all);
  const f = run({ FAKE_FIREBASE: 'expired' });
  check('signins: an expired Firebase sign-in names `firebase login --reauth --no-localhost`', f.status !== 0 && f.all.includes('firebase login --reauth --no-localhost') && !secret(f.all), f.all);
  const h = run({ FAKE_GH: 'expired' });
  check('signins: an expired GitHub sign-in names `gh auth login` and the device page', h.status !== 0 && h.all.includes('gh auth login') && h.all.includes('github.com/login/device') && !secret(h.all), h.all);
  const keyFile = path.join(tmp, 'sa.json'); fs.writeFileSync(keyFile, JSON.stringify({ type: 'service_account', client_email: 'deployer@proj.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${KEY}\n-----END PRIVATE KEY-----\n` }), { mode: 0o600 });
  const sa = run({ FAKE_GCLOUD: 'expired', FAKE_FIREBASE: 'expired', GOOGLE_APPLICATION_CREDENTIALS: keyFile });
  check('signins: a readable GOOGLE_APPLICATION_CREDENTIALS key passes Google and Firebase from the service account, and says so', sa.status === 0 && /from the service account deployer@proj\.iam\.gserviceaccount\.com/.test(sa.all), sa.all);
  check('signins: ...reading only its client_email, never the key', !secret(sa.all) && !sa.all.includes('PRIVATE KEY'), sa.all);
  const missing = run({ GOOGLE_APPLICATION_CREDENTIALS: path.join(tmp, 'nope.json') });
  check('signins: a GOOGLE_APPLICATION_CREDENTIALS that is not readable fails', missing.status !== 0 && /not a readable file/.test(missing.all), missing.all);
}

stopBroker();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n== role tests: ${fail} FAILED, ${pass} passed ==` : `\n== role tests: ${pass} passed ==`);
process.exit(fail ? 1 : 0);
