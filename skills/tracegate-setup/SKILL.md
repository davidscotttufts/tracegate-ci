---
name: tracegate-setup
description: Set up Tracegate CI in a Vitest + TypeScript repository, or check that an existing setup works. Use when asked to install, configure, or troubleshoot Tracegate.
---

# Setting up Tracegate

1. **Install:** `npm install --save-dev tracegate-ci`. It needs Node 22 or later, Vitest
   4.1 to 5.x, and `typescript` installed in the repository.
2. **Propose lanes:** `npx tracegate init` prints one lane per Vitest project, with its
   setup directories as global inputs. Read the proposal with the user. A setup file
   every test loads must be a global.
3. **Apply:** `npx tracegate init --write --mcp` does three things:
   - writes `tracegate.config.json`;
   - adds the recorder FIRST to each Vitest config's `setupFiles`, only when the
     recorder is enabled;
   - registers the MCP server in `.mcp.json`.

   If it says a config must be edited by hand, add
   `...(process.env.TRACEGATE_RECORD ? ['tracegate-ci/vitest-setup'] : [])` as the first
   entry of `test.setupFiles`.
4. **Check:** `npx tracegate doctor --canary` checks Node, Vitest, typescript, the
   recorder and the ledger. It then records one test file to confirm that coverage still
   maps to source. Every line should be ✓.
5. **First run:** `npx tracegate run`. Lanes start in **shadow**: everything runs, and
   Tracegate logs what it would have skipped. Skipping starts only when the lane meets
   its entry bar (by default 20 observations over 14 days with no miss).
   `npx tracegate status` shows the countdown.
6. **Commit** `tracegate.config.json`, the Vitest config change and `.mcp.json`. The
   ledger lives in `.git/tracegate/` and is never committed.

Don't lower the entry bar or the audit rate to get speed sooner unless the user asks for
it. Those settings are how Tracegate proves its skips are safe.
