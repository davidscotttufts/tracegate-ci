// Reading the machine: CPU load, memory, swap and thermal state, and the memory
// each lease's process tree is using.
//
// Everything that touches the OS lives here; every parser is a pure function of
// the command's text so it can be tested with fixtures. The broker calls
// `sample()` every few seconds, asynchronously, so a slow `ps` never stalls a
// grant. A reading that fails is left out (null), never guessed: the policy in
// adapt.mjs treats a missing signal as "no evidence of pressure" for that signal
// only, and says so in its `why`.
//
// TRACEGATE_BROKER_SAMPLE_FILE=<json> replaces the OS readings with a file (tests,
// and rehearsing a policy against a recorded sample). Its fields are those of
// the object `sample()` returns; `trees` maps a pid to its tree's RSS in MB.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const run = (cmd, args, timeout = 3000) => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 16 << 20 }, (err, out) => resolve(err ? null : out));
});
const MB = 1024 * 1024;

/** `vm_stat` (macOS) → { pageBytes, availMB, compressorMB, swapins }. Pure. */
export function parseVmStat(text) {
  if (!text) return null;
  const pageBytes = Number(/page size of (\d+) bytes/.exec(text)?.[1]) || 4096;
  const pages = (name) => {
    const m = new RegExp(`^"?${name}"?:\\s+(\\d+)\\.?$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const free = pages('Pages free');
  if (free === null) return null;
  // What a new process can get without paging anything out: free pages, plus
  // clean pages the kernel drops on demand (inactive, speculative, purgeable).
  const avail = free + (pages('Pages inactive') ?? 0) + (pages('Pages speculative') ?? 0) + (pages('Pages purgeable') ?? 0);
  const comp = pages('Pages occupied by compressor');
  return { pageBytes, availMB: Math.round((avail * pageBytes) / MB), compressorMB: comp === null ? null : Math.round((comp * pageBytes) / MB), swapins: pages('Swapins') };
}

/** `/proc/meminfo` (Linux) → { availMB, totalMB }. Pure. */
export function parseMeminfo(text) {
  if (!text) return null;
  const kb = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(text); return m ? Number(m[1]) : null; };
  const avail = kb('MemAvailable');
  return avail === null ? null : { availMB: Math.round(avail / 1024), totalMB: Math.round((kb('MemTotal') ?? 0) / 1024) };
}

/** `/proc/pressure/memory` (Linux PSI) → the `some avg10` share, 0–100. Pure. */
export function parsePsi(text) {
  const m = /^some avg10=([\d.]+)/m.exec(text ?? '');
  return m ? Number(m[1]) : null;
}

/** cgroup v2 `memory.max` + `memory.current` → MB left under the limit, or null when unlimited. Pure. */
export function parseCgroupMem(max, current) {
  const m = String(max ?? '').trim();
  const c = Number(String(current ?? '').trim());
  if (!m || m === 'max' || !Number.isFinite(Number(m)) || !Number.isFinite(c)) return null;
  return { limitMB: Math.round(Number(m) / MB), availMB: Math.max(0, Math.round((Number(m) - c) / MB)) };
}

/** cgroup v2 `cpu.max` ("<quota> <period>" or "max <period>") → cores, or null. Pure. */
export function parseCgroupCpu(text) {
  const m = /^(\d+)\s+(\d+)/.exec(String(text ?? '').trim());
  return m && Number(m[2]) > 0 ? Math.max(1, Math.ceil(Number(m[1]) / Number(m[2]))) : null;
}

/** `/proc/vmstat` (Linux) → cumulative swap-ins. Pure. */
export function parseVmstatLinux(text) {
  const m = /^pswpin (\d+)$/m.exec(text ?? '');
  return m ? Number(m[1]) : null;
}

/** `pmset -g therm` (macOS) → CPU speed limit 0–100, or null when none is recorded. Pure. */
export function parseTherm(text) {
  const m = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(text ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Busy cores between two `os.cpus()` readings: the busy share of all ticks, times
 * the number of cores. Pure. This, not the load average, is the CPU signal: on
 * macOS the load average counts threads waiting to run, and MEASURED it read 10.3
 * on 8 cores while the processes used 5.6 cores between them.
 */
export function busyCores(prev, cur) {
  if (!Array.isArray(prev) || !Array.isArray(cur) || prev.length !== cur.length || !cur.length) return null;
  let busy = 0; let total = 0;
  for (let i = 0; i < cur.length; i++) {
    const a = prev[i].times; const b = cur[i].times;
    const d = (k) => Math.max(0, (b[k] ?? 0) - (a[k] ?? 0));
    const work = d('user') + d('nice') + d('sys') + d('irq');
    busy += work; total += work + d('idle');
  }
  return total > 0 ? (busy / total) * cur.length : null;
}

/** `ps -A -o pid=,ppid=,rss=` → Map pid → { ppid, rssKB }. Pure. */
export function parsePs(text) {
  const procs = new Map();
  for (const line of (text ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), rssKB: Number(m[3]) });
  }
  return procs;
}

/** RSS of each root's whole process tree, in MB. Pure. */
export function treeRss(procs, roots) {
  const kids = new Map();
  for (const [pid, p] of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(pid); }
  const out = {};
  for (const root of roots) {
    if (!procs.has(root)) continue;
    let kb = 0; const seen = new Set(); const stack = [root];
    while (stack.length) {
      const p = stack.pop();
      if (seen.has(p)) continue; seen.add(p);
      kb += procs.get(p)?.rssKB ?? 0;
      for (const c of kids.get(p) ?? []) stack.push(c);
    }
    out[root] = Math.round(kb / 1024);
  }
  return out;
}

const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const sysctlNum = async (k) => { const v = Number(await run('sysctl', ['-n', k])); return Number.isFinite(v) && v > 0 ? v : null; };

let hwCache = null;
/**
 * What this machine is: cores (honouring a container's CPU quota), performance
 * cores where the CPU has two kinds, RAM (honouring a container's memory limit),
 * page size. Read once per broker. Every resource default derives from it, so one
 * config serves a 4-core laptop and a 64-core runner alike.
 */
export async function hardware() {
  if (hwCache) return hwCache;
  const logical = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const hw = { platform: process.platform, arch: process.arch, cores: logical, perfCores: null, totalMB: Math.round(os.totalmem() / MB), pageBytes: 4096, cgroup: null };
  if (process.platform === 'darwin') {
    hw.perfCores = await sysctlNum('hw.perflevel0.logicalcpu');
    hw.pageBytes = (await sysctlNum('hw.pagesize')) ?? 4096;
  } else if (process.platform === 'linux') {
    const quota = parseCgroupCpu(readText('/sys/fs/cgroup/cpu.max'));
    const mem = parseCgroupMem(readText('/sys/fs/cgroup/memory.max'), readText('/sys/fs/cgroup/memory.current'));
    if (quota !== null || mem) hw.cgroup = { cpus: quota, memMB: mem?.limitMB ?? null };
    if (quota !== null) hw.cores = Math.min(hw.cores, quota);
    if (mem) hw.totalMB = Math.min(hw.totalMB, mem.limitMB);
    hw.pageBytes = Number(await run('getconf', ['PAGESIZE'])) || 4096;
  }
  hwCache = hw;
  return hw;
}

let lastCpus = null; // the previous os.cpus(), for busy cores
let lastSwap = null; // { at, swapins }: swap-ins per second need two readings

/**
 * One reading of the machine, plus the tree RSS of each pid in `roots`.
 * Returns { at, cores, load1, busyCores, totalMB, availMB, pressure, swapMBps, compressorMB,
 *           cpuSpeedLimit, trees, source, errors }. Never throws. Swap is in MB/s,
 * not pages, because page sizes differ (16 KB on Apple silicon, 4 KB on most x86).
 */
export async function sample(roots = []) {
  const at = Date.now();
  const file = process.env.TRACEGATE_BROKER_SAMPLE_FILE;
  if (file) {
    // The machine's readings come from the file; process trees are still
    // measured for real unless the file gives them.
    let f;
    try { f = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { at, cores: null, trees: {}, errors: [`sample file: ${e.message}`], source: 'file' }; }
    const trees = f.trees ?? (roots.length ? treeRss(parsePs(await run('ps', ['-A', '-o', 'pid=,ppid=,rss='])), roots) : {});
    return { at, errors: [], ...f, trees, source: 'file' };
  }
  const errors = [];
  const hw = await hardware();
  const s = {
    at, cores: hw.cores, load1: os.loadavg()[0], busyCores: null, totalMB: hw.totalMB, availMB: null, pressure: null,
    swapMBps: null, compressorMB: null, cpuSpeedLimit: null, trees: {}, source: process.platform, errors,
  };
  let swapins = null; // cumulative MB swapped in
  // The first reading has nothing to compare with: take a short one, so a
  // broker's first budget does not fall back to the (overstating) load average.
  if (!lastCpus) { lastCpus = os.cpus(); await new Promise((r) => setTimeout(r, 250)); }
  const cpus = os.cpus();
  s.busyCores = busyCores(lastCpus, cpus);
  lastCpus = cpus;
  // Inside a container the host's cores are not all ours: scale to the quota.
  if (s.busyCores !== null && hw.cgroup?.cpus && cpus.length > hw.cores) s.busyCores = Math.min(hw.cores, s.busyCores);
  const [psOut] = await Promise.all([
    roots.length ? run('ps', ['-A', '-o', 'pid=,ppid=,rss=']) : Promise.resolve(''),
    (async () => {
      if (process.platform === 'darwin') {
        const [vm, lvl, therm] = await Promise.all([run('vm_stat', []), run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']), run('pmset', ['-g', 'therm'])]);
        const v = parseVmStat(vm);
        if (v) { s.availMB = v.availMB; s.compressorMB = v.compressorMB; swapins = v.swapins === null ? null : (v.swapins * v.pageBytes) / MB; } else errors.push('vm_stat unreadable');
        // 1 normal, 2 warn, 4 critical (the kernel's own judgement).
        const n = Number(lvl);
        s.pressure = n >= 4 ? 'critical' : n >= 2 ? 'warn' : n === 1 ? 'normal' : null;
        if (s.pressure === null) errors.push('memory pressure level unreadable');
        s.cpuSpeedLimit = parseTherm(therm);
      } else if (process.platform === 'linux') {
        const mi = parseMeminfo(readText('/proc/meminfo'));
        if (mi) s.availMB = mi.availMB; else errors.push('/proc/meminfo unreadable');
        // Inside a container the host's free memory is not ours to take: the
        // cgroup limit is, and its own pressure file is the one that matters.
        const cg = parseCgroupMem(readText('/sys/fs/cgroup/memory.max'), readText('/sys/fs/cgroup/memory.current'));
        if (cg) s.availMB = s.availMB === null ? cg.availMB : Math.min(s.availMB, cg.availMB);
        const psi = parsePsi(readText('/sys/fs/cgroup/memory.pressure') ?? readText('/proc/pressure/memory'));
        // PSI `some avg10`: share of the last 10 s some task stalled on memory.
        s.pressure = psi === null ? null : psi >= 20 ? 'critical' : psi >= 5 ? 'warn' : 'normal';
        const pages = parseVmstatLinux(readText('/proc/vmstat'));
        swapins = pages === null ? null : (pages * hw.pageBytes) / MB;
      } else {
        s.availMB = Math.round(os.freemem() / MB);
      }
    })(),
  ]);
  if (swapins !== null) {
    if (lastSwap && at > lastSwap.at) s.swapMBps = Math.max(0, (swapins - lastSwap.swapins) / ((at - lastSwap.at) / 1000));
    lastSwap = { at, swapins };
  }
  if (roots.length) {
    if (psOut) s.trees = treeRss(parsePs(psOut), roots); else errors.push('ps unreadable');
  }
  if (s.availMB === null && !errors.length) errors.push('available memory unreadable');
  return s;
}
