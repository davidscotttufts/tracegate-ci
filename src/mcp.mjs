// `tracegate mcp [--allow-write]` — a Model Context Protocol server over stdio.
//
// Agents coordinate through the broker instead of messaging each other. Read
// tools are always on. The write tools need --allow-write: `cancel_queued` can only
// cancel a QUEUED job, never a running one; `annotate_red` records an escalate-only
// opinion (its one effect can only make a gate stricter, Phase 1b); `annotate_deps`
// records a shadow prediction nothing reads back; `train_add` only queues a ref for the
// merge train, which lands nothing that was not gated green. Work itself is done with
// `tracegate lease -- …` in the agent's own shell, so a lease stays bound to the
// process that does the work (its liveness is that process's connection).
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs go to stderr.
import fs from 'node:fs';
import { call } from './broker/client.mjs';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const pkg = { name: 'tracegate', version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version };

const READ_TOOLS = [
  {
    name: 'queue_status',
    description: 'The machine\'s CI capacity right now: tokens in use, running leases (class, label, tokens, fence), the queue in order, and the reserved start time of the first blocked job.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async () => { const s = await call({ op: 'status' }); delete s.ref; delete s.type; return s; },
  },
  {
    name: 'explain_job',
    description: 'Why a lease is where it is: its queue position, the jobs ahead of it, what holds the capacity, and when it is reserved to start.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'A job id such as "j42" (printed by `tracegate lease`).' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async ({ id }) => { const e = await call({ op: 'explain', id: String(id) }); delete e.ref; delete e.type; return e; },
  },
  {
    name: 'history',
    description: 'The most recent broker events (enqueue, grant, preempt, release, expire, advice), newest last. Each carries a sequence number and timestamp.',
    inputSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 1000, default: 50 } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async ({ n }) => (await call({ op: 'history', n: n ?? 50 })).events,
  },
  {
    name: 'machine_load',
    description: 'This machine\'s hardware (cores, performance cores, RAM, container limits), its latest load / available memory / memory pressure / swap / thermal reading, and the cpu and memory budgets the broker is handing out right now, with the reasons. Each running lease\'s measured memory is included. Read it before starting heavy work, and size a lease with --min-tokens so it can start narrower on a busy machine.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async () => { const m = await call({ op: 'machine' }); delete m.ref; delete m.type; return m; },
  },
  {
    name: 'red_runs',
    description: 'Recent red runs on this machine (newest first; ones an opinion escalated first), each with its packet id, lane, head, how many files failed, how many were Tracegate MISSES, and the latest opinion if any. Read a packet with read_red.',
    inputSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 200, default: 20 } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async ({ n }) => (await import('./red.mjs')).listRed(n ?? 20),
  },
  {
    name: 'read_red',
    description: 'One red-run packet: every failing file with its failure text, what Tracegate predicted for it and why, whether it was a MISS and how its re-run alone went, its past misses and triage, the files changed against the base, a clipped diff, and the machine load. Use it to form an opinion; read the code in the repository as well before you give one.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async ({ id }) => (await import('./red.mjs')).readPacket(id),
  },
  {
    name: 'deps_runs',
    description: 'Recent lockfile runs (newest first): one dependency packet each, with how many packages changed and how many files failed, and whether a prediction was recorded. Read one with read_deps.',
    inputSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 200, default: 20 } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async ({ n }) => (await import('./deps.mjs')).listDeps(n ?? 20),
  },
  {
    name: 'read_deps',
    description: 'One dependency packet: every package the lockfile change moved (name, from → to, semver class, native code, whether the vitest process loaded it), the lane size, and which files failed in the full run. Read the changelogs and the code that uses the package before predicting.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async ({ id }) => (await import('./deps.mjs')).readDepsPacket(id),
  },
  {
    name: 'lane_mode',
    description: 'Tracegate\'s test-selection mode per lane (off, shadow or enforce) and why, from the repository\'s tracegate.config.json.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async () => {
      const { ctx } = await import('./config.mjs');
      const { modeDecision, effectiveMode } = await import('./predictor.mjs');
      return Object.keys(ctx().lanes).map((l) => ({ lane: l, mode: effectiveMode(l), why: modeDecision(l).why }));
    },
  },
  {
    name: 'savings',
    description: 'Per lane, what reusing verdicts would have saved so far: file runs and test time that could have been skipped, the projection at the audit rate, misses, and how far the lane is from its entry bar. Read from the shadow log, so it has numbers before enforcement starts.',
    inputSchema: { type: 'object', properties: { lane: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async ({ lane: l }) => (await import('./predictor.mjs')).savings({ lane: l }),
  },
  {
    name: 'report_card',
    description: 'Tracegate\'s own error rates per lane: misses per checked verdict and per run with 95% Wilson intervals, the triage of each miss, the longest a hole could have gone undetected, audit cost, and the Red Reader and Conductor scores. Read from the append-only logs.',
    inputSchema: { type: 'object', properties: { lane: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async ({ lane: l }) => (await import('./evidence.mjs')).reportCard({ lane: l }),
  },
  {
    name: 'train_status',
    description: 'The local merge train: the PRs queued for each target branch (id, ref, pinned commit) and the latest landed, rejected and dropped events with their reasons.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async ({ target }) => (await import('./train.mjs')).status({ target }),
  },
];

const WRITE_TOOLS = [
  {
    name: 'annotate_red',
    description: 'Record an ESCALATE-ONLY opinion on a red-run packet. It is stored and shown to people; it never lowers a verdict, never marks anything a flake, never merges or re-runs anything. Its one effect: verdict real + escalate true + confidence ≥ 0.7 on a file that was a MISS raises the automatic flake to a hole, so the lane runs whole until a person triages it. verdict: real (the change broke it), flake-suspect (fails on its own; say why), infra (machine, network, contention), unclear. Set escalate=true when a person should look now (for example a MISS you believe is a real footprint hole, or a red you believe is real but was waved through). Give reasons that cite files and lines.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string' }, verdict: { type: 'string', enum: ['real', 'flake-suspect', 'infra', 'unclear'] }, escalate: { type: 'boolean' },
      confidence: { type: 'number', minimum: 0, maximum: 1 }, reasons: { type: 'string', minLength: 1, maxLength: 4000 },
      files: { type: 'array', items: { type: 'string' }, maxItems: 200 }, owner: { type: 'string', maxLength: 200 },
    }, required: ['id', 'verdict', 'escalate', 'confidence', 'reasons'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async (a) => (await import('./red.mjs')).annotate({ ...a, by: a.by ?? 'mcp' }),
  },
  {
    name: 'annotate_deps',
    description: 'Record a SHADOW prediction for a dependency packet: which test files the package change can affect (a list of files, or "all", or "none"). It is scored against the full run the gate already did; nothing reads it back and it never skips a test.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string' }, affected: { oneOf: [{ type: 'string', enum: ['all', 'none'] }, { type: 'array', items: { type: 'string' }, maxItems: 5000 }] },
      confidence: { type: 'number', minimum: 0, maximum: 1 }, reasons: { type: 'string', minLength: 1, maxLength: 4000 },
    }, required: ['id', 'affected', 'confidence', 'reasons'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async (a) => (await import('./deps.mjs')).annotateDeps({ ...a, by: 'mcp' }),
  },
  {
    name: 'train_add',
    description: 'Queue a branch or ref for the local merge train, pinned to its current commit. It only queues: a person or a gate runs `tracegate train run`, which lands it only if its exact merge commit is gated green.',
    inputSchema: { type: 'object', properties: { pr: { type: 'string', description: 'An id, or <id>=<ref>. A bare id is also the ref.' }, target: { type: 'string', default: 'main' } }, required: ['pr'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async ({ pr, target }) => (await import('./train.mjs')).add({ pr, target }),
  },
  {
    name: 'cancel_queued',
    description: 'Cancel a job that is still QUEUED (never a running one). The job\'s own wrapper then exits.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: async ({ id }) => {
      const e = await call({ op: 'explain', id: String(id) });
      if (e.state !== 'queued') throw new Error(`${id} is ${e.state}; only queued jobs can be cancelled here`);
      await call({ op: 'cancel', id: String(id) });
      return { cancelled: id };
    },
  },
];

export async function mcp(o) {
  const tools = [...READ_TOOLS, ...(o['allow-write'] ? WRITE_TOOLS : [])];
  const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { fail(null, -32700, 'parse error'); continue; }
      if (m.id === undefined) continue; // notifications (initialized, cancelled) need no answer
      try {
        if (m.method === 'initialize') {
          const asked = m.params?.protocolVersion;
          reply(m.id, { protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0], capabilities: { tools: {} }, serverInfo: pkg,
            instructions: 'Coordinate CI work on this machine through the Tracegate broker. Read queue_status (and machine_load for the cpu/memory budgets) before starting heavy work; run the work itself with `tracegate lease --class <c> --tokens <n> [--min-tokens <m>] -- <command>` in your shell so it waits its turn and is sized to what the machine can take.' });
        } else if (m.method === 'ping') reply(m.id, {});
        else if (m.method === 'tools/list') reply(m.id, { tools: tools.map(({ run, ...t }) => t) });
        else if (m.method === 'tools/call') {
          const t = tools.find((x) => x.name === m.params?.name);
          if (!t) { fail(m.id, -32602, `unknown tool ${m.params?.name}`); continue; }
          try {
            const r = await t.run(m.params?.arguments ?? {});
            reply(m.id, { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], structuredContent: Array.isArray(r) ? { items: r } : r });
          } catch (e) {
            reply(m.id, { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true });
          }
        } else fail(m.id, -32601, `method not found: ${m.method}`);
      } catch (e) { fail(m.id, -32603, String(e?.message ?? e)); }
    }
  });
  await new Promise((r) => process.stdin.on('end', r));
}
