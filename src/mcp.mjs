// `tracegate mcp [--allow-write]` — a Model Context Protocol server over stdio.
//
// Agents coordinate through the broker instead of messaging each other. Read
// tools are always on. The only write tool, `cancel_queued`, needs --allow-write
// and can only cancel a QUEUED job, never a running one. Work itself is done with
// `tracegate lease -- …` in the agent's own shell, so a lease stays bound to the
// process that does the work (its liveness is that process's connection).
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs go to stderr.
import { call } from './broker/client.mjs';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const pkg = { name: 'tracegate', version: '0.2.0' };

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
];

const WRITE_TOOLS = [
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
            instructions: 'Coordinate CI work on this machine through the Tracegate broker. Read queue_status before starting heavy work; run the work itself with `tracegate lease --class <c> --tokens <n> -- <command>` in your shell so it waits its turn.' });
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
