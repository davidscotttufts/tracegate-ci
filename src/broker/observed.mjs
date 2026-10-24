// `tracegate observed [--json] [--hours h]` — what observe mode recorded (I10).
//
// The evidence for retiring other coordination: replays the broker's event log
// and reports how many observed jobs would have waited, behind which classes, and
// for how long the machine ran over its budget (tokens granted above the cpu
// budget in force). `summarize` is pure over the events.
import fs from 'node:fs';
import path from 'node:path';
import { brokerConfig, brokerDir } from './paths.mjs';

/** Pure: events (in log order) → summary. `sinceMs` filters by event time. */
export function summarize(events, { capacity, sinceMs = 0, now = Date.now() } = {}) {
  const jobs = new Map(); // id → { class, label, tokens, observe }
  let limit = capacity; let used = 0; let last = null; let overMs = 0; let peak = 0;
  const out = { observed: 0, wouldWait: 0, byClass: {}, waits: [], overCapacityMinutes: 0, peakTokens: 0, capacity };
  const advance = (at) => { if (last !== null && at > last && used > limit && at >= sinceMs) overMs += at - Math.max(last, sinceMs); last = at; };
  for (const e of events) {
    advance(e.at);
    if (e.type === 'capacity' && e.applied !== false) limit = Math.max(1, Math.min(capacity, e.cpu | 0 || capacity));
    else if (e.type === 'enqueue') jobs.set(e.id, { class: e.class, label: e.label, observe: !!e.observe, tokens: 0, nested: !!e.parent });
    else if (e.type === 'grant') {
      const j = jobs.get(e.id); if (!j) continue;
      j.tokens = e.nested ? 0 : e.tokens; used += j.tokens; peak = Math.max(peak, used);
      if (e.observed && e.at >= sinceMs) {
        out.observed++;
        const b = (out.byClass[j.class] ??= { observed: 0, wouldWait: 0 }); b.observed++;
        if (e.wouldWait) { out.wouldWait++; b.wouldWait++; out.waits.push({ at: new Date(e.at).toISOString(), id: e.id, class: j.class, label: j.label, behind: (e.behind ?? []).map((x) => `${x.class}${x.label ? ` ${x.label}` : ''}`) }); }
      }
    } else if (['release', 'cancel', 'expire'].includes(e.type)) {
      const j = jobs.get(e.id); if (j) { used -= j.tokens; jobs.delete(e.id); }
    }
  }
  advance(now);
  out.overCapacityMinutes = +(overMs / 60000).toFixed(1);
  out.peakTokens = peak;
  return out;
}

export function observed(o) {
  const file = path.join(brokerDir(), 'events.jsonl');
  let events = [];
  try { events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* none yet */ }
  const hours = Number(o.hours ?? 24 * 7);
  const s = summarize(events, { capacity: brokerConfig().capacity, sinceMs: Date.now() - hours * 3_600_000 });
  if (o.json) { console.log(JSON.stringify(s, null, 2)); return; }
  console.log(`last ${hours} h: ${s.observed} observed job(s), ${s.wouldWait} would have waited; peak ${s.peakTokens} token(s) of ${s.capacity}; ${s.overCapacityMinutes} min over the cpu budget`);
  for (const [k, v] of Object.entries(s.byClass)) console.log(`  ${k.padEnd(8)} ${v.observed} observed, ${v.wouldWait} would have waited`);
  for (const w of s.waits.slice(-20)) console.log(`  ${w.at}  ${w.id} ${w.class} ${w.label} — behind ${w.behind.join(', ') || '(a reservation)'}`);
}
