// The Tracegate recorder: per test file, what the file actually touched.
//
// A vitest setup file (src/vitest-setup.mjs) calls `installRecorder(...)` when
// `TRACEGATE_RECORD=<dir>` is set. For each test file it writes one raw
// footprint to `<dir>/raw/`:
//   exec   — per source module, the V8 start offsets of every EXECUTED function,
//            plus the hash of the compiled text they index into;
//   loaded — every repo module the file evaluated;
//   reads  — every repo path the worker read, listed or stat'ed (symlinks resolved);
//   pkgs   — every installed package (`<dir>/node_modules/<name>`) the worker had
//            loaded or read so far, or null when a node_modules lies outside the
//            repository (then nothing about packages is known; Phase 3).
// `tracegate ingest` turns these into ledger entries after the run.
//
// It never changes what a test sees: no mocks, no return values, no timing it
// can avoid. Plain JS with node builtins only.
//
// HOW COVERAGE IS MAPPED WITHOUT A DEBUGGER. V8 reports function offsets into the
// script it compiled. Vitest compiles each module with
//     vm.runInThisContext(`'use strict';async (<args>)=>{{<code>\n}}`, { filename })
// through its DEFAULT `vm` import, so a property patch on `vm.runInThisContext`
// sees that exact text at call time. The recorder writes each distinct text
// once (by hash), and ingest maps each executed function's offset back to a
// source line through the text's inline source map (the wrapper shifts line 0
// only). Alternatives that were measured and rejected: `Debugger.enable` +
// `getScriptSource` roughly doubled wall time; capturing the transform cache's
// `readFileSync` saw nothing, because vitest binds `readFileSync` before any
// setup file runs; mapping inside the worker cost most of a second per file.
//
// Nothing is assumed: a module with no captured text, or whose text length does
// not match V8's script, is reported as `unmapped`, and the predictor treats any
// change to an unmapped module the test loaded as "run". A vitest upgrade that
// moves this seam degrades to SAFE, and ingest prints the unmapped share so it
// is noticed.
import { Session } from 'node:inspector/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import vm from 'node:vm';
import { pkgOf } from './pkg.mjs';

const WRAP_HEAD = "'use strict';async (";
const FS_SYNC = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'openSync', 'accessSync', 'opendirSync', 'createReadStream'];
const FS_CB = ['readFile', 'readdir', 'stat', 'lstat', 'access', 'open', 'opendir'];
const FSP = ['readFile', 'readdir', 'stat', 'lstat', 'access', 'open', 'opendir'];

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = new Int8Array(128).fill(-1); for (let i = 0; i < 64; i++) B64I[B64.charCodeAt(i)] = i;

/** Decode one generated line of a v3 `mappings` string into [genCol, srcIdx, srcLine][] (absolute). */
function decodeLine(seg, state) {
  const out = [];
  let col = 0;
  for (const s of seg.split(',')) {
    if (!s) continue;
    const vals = []; let v = 0, shift = 0;
    for (let i = 0; i < s.length; i++) {
      const d = B64I[s.charCodeAt(i)];
      v += (d & 31) << shift;
      if (d & 32) { shift += 5; continue; }
      vals.push(v & 1 ? -(v >>> 1) : v >>> 1); v = 0; shift = 0;
    }
    col += vals[0];
    if (vals.length >= 4) { state.src += vals[1]; state.line += vals[2]; out.push([col, state.src, state.line]); }
  }
  return out;
}

/** A compiled module's text: its line table and inline source map. */
export class ModuleMap {
  constructor(code) {
    this.len = code.length;
    // vitest's wrapper is prepended to line 0; the source map describes <code>.
    this.prefix = code.startsWith(WRAP_HEAD) ? code.indexOf(')=>{{') + 5 : 0;
    const ls = [0];
    for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) ls.push(i + 1);
    this.lineStarts = Uint32Array.from(ls);
    this.lines = null; // decoded lazily: index → [genCol, srcIdx, srcLine][]
    const at = code.lastIndexOf('//# sourceMappingURL=data:application/json');
    const m = at >= 0 ? /^\/\/# sourceMappingURL=data:application\/json[^,]*,([A-Za-z0-9+/=]+)/.exec(code.slice(at)) : null;
    let map = null;
    if (m) { try { map = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); } catch { map = null; } }
    this.mappings = map?.mappings?.split(';') ?? null;
  }
  /** Original 1-based source line for a 0-based offset into the code, or null. */
  originalLine(offset) {
    if (!this.mappings) return null;
    if (!this.lines) {
      // Decoding is stateful across lines, so decode all once.
      const st = { src: 0, line: 0 };
      this.lines = this.mappings.map((seg) => decodeLine(seg, st));
    }
    let lo = 0, hi = this.lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    const col = offset - this.lineStarts[lo] - (lo === 0 ? this.prefix : 0);
    const segs = this.lines[lo] ?? [];
    let best = null;
    for (const s of segs) { if (s[0] <= col) best = s; else break; }
    if (!best && segs.length) best = segs[0];
    return best ? best[2] + 1 : null;
  }
}

/**
 * Install the recorder for the current test file. A no-op unless
 * `TRACEGATE_RECORD` is set.
 * @param {{ afterAll: Function, expect: { getState(): { testPath?: string } }, repoRoot: string, srcPrefix: string }} o
 *   srcPrefix is the repo-relative source directory with a trailing `/` (e.g. `packages/api/src/`).
 */
export async function installRecorder({ afterAll, expect, repoRoot, srcPrefix }) {
  const outDir = process.env.TRACEGATE_RECORD;
  if (!outDir) return;
  const g = globalThis;
  if (!g.__tracegate) g.__tracegate = await init(outDir, repoRoot, srcPrefix);
  const st = g.__tracegate;
  // Module evaluation for this test file happens AFTER the setup files load, so
  // from here on, reads and executed functions belong to this file.
  // Coverage is NOT reset here: the previous file's afterAll take already reset
  // it, and whatever ran in between (its teardown, these setup files) is then
  // counted for this file. That can only ADD functions to a footprint, i.e. cause
  // extra runs, never hide one; and it saves one coverage take per file.
  st.reads.clear();

  afterAll(async () => {
    const testPath = expect.getState().testPath ?? '';
    const { result } = await st.session.post('Profiler.takePreciseCoverage');
    const filePrefix = 'file://' + st.repoRoot + '/';
    const loaded = [];
    const exec = {};
    const unmapped = [];
    // Packages: every script in the result, not only those that ran in this file.
    // A module is evaluated once per worker, so this is everything the worker has
    // loaded: a superset, which can only cause runs.
    const pkgs = new Set(st.pkgReads); let pkgsKnown = st.pkgsKnown;
    for (const s of result) {
      if (!s.url.startsWith('file://') || !s.url.includes('/node_modules/')) continue;
      const abs = decodeURIComponent(s.url.slice(7)).split('?')[0];
      const k = pkgOf(abs, st.repoRoot);
      if (k) pkgs.add(k); else pkgsKnown = false; // a node_modules outside the repo
    }
    for (const s of result) {
      if (!s.url.startsWith(filePrefix) || s.url.includes('/node_modules/')) continue;
      const file = decodeURIComponent(s.url.slice(filePrefix.length)).split('?')[0];
      loaded.push(file);
      if (!file.startsWith(st.srcPrefix) || /\.(test|spec)\.tsx?$/.test(file)) continue; // test-side modules are tracked whole
      const mm = st.modules.get(path.join(st.repoRoot, file));
      const scriptLen = s.functions[0]?.ranges[0]?.endOffset ?? 0;
      if (!mm || mm.len !== scriptLen) { unmapped.push(file); continue; }
      const offs = [];
      for (let i = 1; i < s.functions.length; i++) {
        const r0 = s.functions[i].ranges[0];
        if (r0 && r0.count > 0) offs.push(r0.startOffset);
      }
      exec[file] = { code: mm.sha, offs };
    }
    const testFile = testPath.startsWith(st.repoRoot + '/') ? testPath.slice(st.repoRoot.length + 1) : testPath;
    const out = { v: 2, testFile, node: process.version, loaded: [...new Set(loaded)].sort(), exec, unmapped, reads: [...st.reads].sort(), pkgs: pkgsKnown ? [...pkgs].sort() : null };
    const name = createHash('sha256').update(testFile).digest('hex').slice(0, 24) + '.json';
    st.write(path.join(st.outDir, 'raw', name), JSON.stringify(out));
  });
}

async function init(outDir, repoRoot, srcPrefix) {
  // The root as V8 reports it in script URLs: symlinks resolved (macOS /tmp is one).
  try { repoRoot = fs.realpathSync.native(repoRoot); } catch { /* keep as given */ }
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  // callCount:false + detailed:false is V8's cheapest coverage mode: function
  // granularity, executed or not — exactly what a footprint needs. In this
  // ("binary") mode a function is reported as executed only in the first take
  // after it ran; that is why there is exactly one take per test file.
  await session.post('Profiler.startPreciseCoverage', { callCount: false, detailed: false });

  const reads = new Set();
  const pkgReads = new Set(); // packages read as files (data, package.json), per worker
  const st0 = { pkgsKnown: true };
  const modules = new Map(); // absolute source path → { len, sha }
  const realCache = new Map();
  const realpath = fs.realpathSync.native;
  const write = fs.writeFileSync; // captured before wrapping, so our own writes are not reads
  const prefixRoot = repoRoot + '/';
  const rec = (p) => {
    try {
      if (typeof p !== 'string' && !(p instanceof URL)) return;
      const abs = path.resolve(p instanceof URL ? p.pathname : p);
      let r = realCache.get(abs);
      if (r === undefined) {
        try { r = realpath(abs); } catch { r = abs; } // a probe of a missing path is still an input
        realCache.set(abs, r);
      }
      if (r.startsWith(prefixRoot) && !r.includes('/node_modules/')) reads.add(r.slice(prefixRoot.length));
      // A package read as a file is an input of the package's. A read in a dot
      // directory (`.vite` caches) is not a package; one outside the repo is unknown.
      else if (r.includes('/node_modules/')) { const k = pkgOf(r, repoRoot); if (k) pkgReads.add(k); else if (!r.startsWith(prefixRoot)) st0.pkgsKnown = false; }
    } catch { /* tracing must never change behaviour */ }
  };
  const codesDir = path.join(outDir, 'codes');
  fs.mkdirSync(codesDir, { recursive: true });
  for (const fnName of ['runInThisContext', 'runInContext']) {
    const orig = vm[fnName];
    vm[fnName] = function (code, ...rest) {
      try {
        const opts = fnName === 'runInThisContext' ? rest[0] : rest[1];
        let file = typeof opts === 'object' && opts ? opts.filename : typeof opts === 'string' ? opts : null;
        if (typeof file === 'string' && file.startsWith('file://')) file = decodeURIComponent(file.slice(7));
        // Isolation re-evaluates every module for every test file, with the SAME
        // text (the tree must not change mid-run), so each module's text is
        // hashed and written once per worker and only its id is kept after that.
        if (typeof code === 'string' && typeof file === 'string' && file.startsWith(prefixRoot) && modules.get(file)?.len !== code.length) {
          const sha = createHash('sha1').update(code).digest('hex');
          const p = path.join(codesDir, sha + '.js');
          if (!fs.existsSync(p)) { const tmp = `${p}.${process.pid}`; write(tmp, code); fs.renameSync(tmp, p); }
          modules.set(file, { len: code.length, sha });
        }
      } catch { /* recording must never change behaviour */ }
      return orig.call(this, code, ...rest);
    };
  }
  const wrap = (obj, names) => {
    for (const n of names) {
      const orig = obj[n];
      if (typeof orig !== 'function') continue;
      obj[n] = function (p, ...rest) {
        rec(p);
        return orig.call(this, p, ...rest);
      };
    }
  };
  wrap(fs, FS_SYNC);
  wrap(fs, FS_CB);
  wrap(fsp, FSP);
  // Named imports of builtins (`import { readFileSync } from 'node:fs'`) bind the
  // ORIGINAL function unless this runs after patching. Without it a trace can
  // report zero repo reads where a real app test reads hundreds of files.
  syncBuiltinESMExports();

  fs.mkdirSync(path.join(outDir, 'raw'), { recursive: true });
  return { session, reads, modules, repoRoot, srcPrefix, outDir, write, pkgReads, get pkgsKnown() { return st0.pkgsKnown; } };
}
