# Changelog

## 0.9.1 (2026-10-30): fixes from installing 0.9.0 as a new user

- **Uncommitted changes are selected against.** `select` compared footprints with HEAD
  only, so in enforce an uncommitted edit to a function a test ran reused that test's
  verdict and the run passed without it. It now predicts against the working tree (a
  `git stash create` snapshot: no ref, no stash entry).
- **A run on uncommitted changes is no evidence about HEAD.** It was recorded as a full
  run (resetting the 24 h full-run clock and the report card's exposure bound) and as a
  green run that `tracegate attest` could sign for HEAD's tree. Neither is recorded now.
- **TypeScript 7.** `typescript@latest` is now the native compiler, with no JS parser API,
  and 0.9.0 crashed after the tests (`reading 'Latest'`) while `doctor` passed. Tracegate
  now parses with TypeScript 5 or 6 only: it looks for `tracegate-typescript` (6 installed
  under an alias) before `typescript`, `doctor` fails a lane it cannot parse for and prints
  the fix, and the peer range is `>=5.0.0 <7`. A CI job runs the end-to-end on 7 + alias.
- `server.json` fits the MCP Registry: a description of at most 100 characters (0.9.0's
  was 119, which `mcp-publisher` rejects) and the 2025-12-11 schema. A test keeps the
  versions in `package.json`, `plugin.json` and `server.json` together.
- `tracegate --version` (also `-v`, `version`).
- Releases are staged through npm Trusted Publishing (OIDC) instead of an `NPM_TOKEN`
  secret. A pushed tag stages the version; a maintainer approves it with 2FA
  (`npm stage approve`) before it can be installed.

## 0.9.0 (2026-10-30): Jest and attestation

- Jest 30 as a second runner: `"runner": "jest"` on a lane, and
  `testEnvironment: 'tracegate-ci/jest-environment'` in the Jest config.
  - The recorder captures modules through `vm.compileFunction`, and uses V8 call counts
    under Jest.
  - `doctor` checks a Jest lane.
  - CI runs the end-to-end on `examples/sample-repo-jest`.
- Runner adapters (`src/runners/`): everything runner-specific is behind one interface.
  No behaviour change for Vitest.
- `tracegate attest` / `verify`: a signed git note (`refs/notes/tracegate`) of what green
  runs tested on a commit's exact tree. `tracegate run` logs green runs to
  `green-<host>.tsv`.
- The recorder refuses to map a module the worker compiled with more than one text.
- The silence guard compares a root commit against the empty tree instead of skipping.

## 0.8.0 (unreleased): merge train and silence guard

Includes 0.7.0, which was not published on its own.

- `tracegate train add | drop | status | run`: a local merge train.
  - Each batch is gated as its exact merge commit in a throwaway worktree, under a broker
    lease of class `train`.
  - A red batch is bisected; a green one lands by compare-and-swap.
  - A moved target lands nothing, and pushing is opt-in.
  - New MCP tools `train_status` (read) and `train_add` (write).
- The silence guard: net-added skips, `.only`, `if (false)`, removed tests and deleted
  test files, against the merge base.
  - `silence.mode` is `shadow` (the default), `enforce` or `off`.
  - `tracegate silence check | allow`. An allow is a person's, pinned to the file's
    contents.
  - Red packets carry the findings.
- The Claude Code hook also blocks agents from running `tracegate silence allow` and
  `tracegate triage`.
- `docs/recipes/`: claude-code-merge-queue, edit-level guards, worktrees and containers,
  and a `bin/ci` for TypeScript.

## 0.7.0 (unreleased): evidence

- `tracegate savings [--json]`: reusable file runs and test time per lane, from the shadow
  log, with the projection at the audit rate and a countdown to the entry bar. A shadow run
  prints it as one line. The shadow log gains `total_s` and `reusable_s`; older logs are
  widened in place and their rows kept.
- `tracegate report-card [--json] [--out f]`: misses per checked verdict and per run with
  95% Wilson intervals, triage, hole exposure, audit cost, Red Reader and Conductor scores.
- MCP read tools `savings` and `report_card`.
- `examples/compare-vitest.sh` and `docs/compare/vitest-record-dependencies.md`: Tracegate
  and Vitest 5 `recordDependencies` on the same five changes, asserted in CI.

## 0.6.0 (unreleased): ready to install

- `tracegate init [--write] [--mcp]`: proposes lanes from the repository's Vitest projects
  and wires the recorder. It never overwrites an existing config.
- `tracegate doctor [--canary]`: checks the setup; the canary records one test file to
  confirm the recorder's seam still maps.
- Supported Vitest is now 4.1 to 5.x, tested per version in CI
  (`npm run test:vitest-matrix`).
- Ingest names the Vitest version when the seam degrades to safe.
- Claude Code plugin with marketplace (`.claude-plugin/`). It bundles:
  - the MCP server;
  - the `red-reader` and `deps-oracle` subagents;
  - the `tracegate-gate` and `tracegate-setup` skills;
  - a `PreToolUse` hook that queues agents' test runs through the broker.
- MCP Registry metadata (`server.json`, `mcpName`). The MCP server reports the package
  version.
- GitHub Actions: CI matrix and a tag-triggered npm publish with provenance.

## 0.5.0

- Phase 1b: an escalated `real` Red Reader opinion on a MISS raises `flake` to `hole`.
- Phase 2: the Conductor (fail-first order, merge-train advice), in shadow.
- Phase 3: the dependency rule for lockfile changes, plus the dependency oracle in shadow.
- Phase 0.5c: `lease --jobserver`.

## 0.4.0

- Phase 0.5b-1: `tracegate observe` / `observed`.
- Phase 1a: Red Reader packets, MCP tools and closed-world opinions.

## 0.3.0

- Phase 0.6: adaptive capacity (CPU, memory, pressure, swap, thermal).

## 0.2.0

- Phase 0.5: the broker (leases, priorities, backfill, preemption) and its MCP server.

## 0.1.0

- Phase 0: recorder, ledger, predictor (shadow, entry bar, audits, suspend on miss),
  replay and CLI, extracted from the host project.
