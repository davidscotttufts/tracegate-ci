// A vitest sequencer that starts test files in the Conductor's fail-first order
// (Phase 2, conductor.mode `order`). `tracegate run` writes the order to the file
// named by TRACEGATE_ORDER. Without it, or for files it does not list, the
// original order is kept. It never adds or drops a file: it only sorts.
//
//   // vitest.config.ts
//   import TracegateSequencer from 'tracegate-ci/sequencer';
//   export default defineConfig({ test: { sequence: { sequencer: TracegateSequencer } } });
import fs from 'node:fs';

const fileOf = (spec) => (Array.isArray(spec) ? spec[1] : spec?.moduleId ?? spec?.filepath ?? String(spec));

export default class TracegateSequencer {
  constructor(ctx) { this.ctx = ctx; }
  // Sharding stays vitest's own (--shard), so a sharded run still splits the same way.
  async shard(files) {
    try { const { BaseSequencer } = await import('vitest/node'); return await new BaseSequencer(this.ctx).shard(files); } catch { return files; }
  }
  async sort(files) {
    let order = [];
    try { order = fs.readFileSync(process.env.TRACEGATE_ORDER ?? '', 'utf8').split('\n').filter(Boolean); } catch { return files; }
    const pos = new Map(order.map((f, i) => [f, i]));
    return files.map((s, i) => ({ s, i, p: pos.get(fileOf(s)) ?? Infinity })).sort((a, b) => (a.p - b.p) || (a.i - b.i)).map((x) => x.s);
  }
}
