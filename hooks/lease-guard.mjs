#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash): a test run an agent starts on its own
// competes with every other agent, gate and train on the machine for the same
// cores. In a repository that uses Tracegate (a tracegate.config.json at its
// git root), a bare `vitest` / `npm test` outside a broker lease is blocked with
// the command to use instead, so it queues with everything else.
//
// It blocks nothing else: commands that already go through `tracegate`, a run
// inside a lease (TRACEGATE_LEASE is set), repositories without Tracegate, and
// TRACEGATE_HOOK=off all pass. Any error in the hook lets the command through:
// a broken hook must not stop an agent from working.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// A test command at the start of a shell segment: vitest (bare, npx, pnpm/yarn/bun x
// or exec), or a package manager's `test` script.
const TEST_CMD = /(^|[;&|(]\s*|\benv\s+(?:\w+=\S*\s+)*|^\s*(?:\w+=\S*\s+)+)(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn(?:\s+exec)?|bun\s+x)\s+(?:--\S+\s+)*)?vitest\b|(^|[;&|(]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/;

/** The reason to block a command, or null to let it run. */
export function verdict(command, { cwd, env = process.env, hasTracegate } = {}) {
  if (env.TRACEGATE_HOOK === 'off' || env.TRACEGATE_LEASE) return null;
  if (typeof command !== 'string' || !TEST_CMD.test(command)) return null;
  if (/\btracegate\b/.test(command)) return null;
  if (!(hasTracegate ?? repoUsesTracegate)(cwd)) return null;
  return `This repository runs its tests through Tracegate, which queues every agent's test runs on this machine so they do not starve each other or the gates.
Run it as:
  npx tracegate run -- <vitest args>                     (selection + recording; the usual way)
  npx tracegate lease --class adhoc --tokens 2 -- ${command.trim()}   (this exact command, queued)
\`npx tracegate queue\` shows what is running. Set TRACEGATE_HOOK=off to bypass this check.`;
}

function repoUsesTracegate(cwd) {
  try {
    const root = execFileSync('git', ['-C', cwd || process.cwd(), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return fs.existsSync(path.join(root, 'tracegate.config.json'));
  } catch { return false; }
}

if (process.argv[1]?.endsWith('lease-guard.mjs')) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    try {
      const j = JSON.parse(input || '{}');
      const why = verdict(j.tool_input?.command, { cwd: j.cwd });
      if (why) { process.stderr.write(why + '\n'); process.exit(2); }
    } catch { /* let it run */ }
    process.exit(0);
  });
}
