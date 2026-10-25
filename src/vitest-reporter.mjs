// A vitest reporter that records which installed packages the vitest MAIN process
// loaded: the config, its plugins, the transform pipeline, global setup (Phase 3).
// A change to one of these can change every test while showing up in no worker's
// footprint, so the dependency rule treats them as global inputs.
//
// `tracegate run` adds it with --reporter when it records. It prints nothing. It
// lists the main process's scripts once, at the end of the run, through the
// inspector (`Debugger.enable` reports every script already parsed), and writes
// `<TRACEGATE_RECORD>/runner-pkgs.json`: a sorted list, or null when a
// node_modules outside the repository was seen (then nothing is known).
import { Session } from 'node:inspector/promises';
import fs from 'node:fs';
import path from 'node:path';
import { pkgOf } from './pkg.mjs';

export default class TracegateReporter {
  constructor() { this.done = false; }
  async write() {
    if (this.done) return;
    this.done = true;
    const out = process.env.TRACEGATE_RECORD; const root = process.env.TRACEGATE_ROOT;
    if (!out || !root) return;
    let list = null;
    try {
      let realRoot = root; try { realRoot = fs.realpathSync.native(root); } catch { /* as given */ }
      const pkgs = new Set(); let known = true;
      const s = new Session(); s.connect();
      s.on('Debugger.scriptParsed', ({ params }) => {
        const u = params.url;
        if (!u?.startsWith('file://') || !u.includes('/node_modules/')) return;
        const k = pkgOf(decodeURIComponent(u.slice(7)).split('?')[0], realRoot);
        if (k) pkgs.add(k); else known = false;
      });
      await s.post('Debugger.enable');
      await s.post('Debugger.disable');
      s.disconnect();
      list = known ? [...pkgs].sort() : null;
    } catch { list = null; }
    try { fs.writeFileSync(path.join(out, 'runner-pkgs.json'), JSON.stringify(list)); } catch { /* never fail a run */ }
  }
  onTestRunEnd() { return this.write(); }
  onFinished() { return this.write(); }
}
