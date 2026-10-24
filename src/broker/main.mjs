#!/usr/bin/env node
// The broker's own entry point: `serve | observe | queue | machine | observed | stop`.
// It imports only src/config.mjs and src/broker/*, so a project can vendor the
// broker (those files) without the rest of Tracegate, and the client's autostart
// never loads the predictor. `tracegate <cmd>` (src/cli.mjs) offers the same commands.
const [cmd, ...argv] = process.argv.slice(2);
const o = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); o[k] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i]; }
try {
  if (cmd === 'serve') await (await import('./server.mjs')).serve();
  else if (cmd === 'observe') process.exitCode = await (await import('./client.mjs')).observe(o);
  else if (cmd === 'observed') (await import('./observed.mjs')).observed(o);
  else if (cmd === 'queue' || cmd === 'machine') { const r = await (await import('./client.mjs')).call({ op: cmd === 'queue' ? 'status' : 'machine' }); delete r.ref; delete r.type; console.log(JSON.stringify(r, null, 2)); }
  else if (cmd === 'stop') {
    const s = await (await import('./client.mjs')).call({ op: 'status' }, { autostart: false }).catch(() => null);
    if (s) { process.kill(s.pid, 'SIGTERM'); console.log(`tracegate broker: stopped pid ${s.pid}`); } else console.log('tracegate broker: not running');
  } else { console.error('usage: main.mjs serve | observe --class c --watch-pid P [--tokens n] [--label l] | queue | machine | observed [--json] [--hours h] | stop'); process.exitCode = 2; }
} catch (e) { console.error(`tracegate broker ${cmd}: ${e.message}`); process.exitCode = cmd === 'observe' ? 0 : 2; }
