# Changelog

## 0.10.0 (2026-11-02): two machines, keyed inputs, the daemon

- **`tracegate sync` carries every evidence log.** It still synced only the five logs it
  was written with, so escalations, approved skips (`silence-allow-`), green rows for
  `attest`, Red Reader and dependency opinions, conductor scores and red and dependency
  packets stayed on the machine that wrote them. An escalation on one machine never
  suspended the lane on another. Every log is now listed as shared or machine-local
  (the train queue and the daemon log are local), and the self-test fails on a log in
  neither list.
- **The release bus** (`"bus": "gs://…"` or a directory; `tracegate bus`): leases and
  events that show what other machines are gating, training, deploying or releasing.
  `train run` warns about another machine's live lease and holds its own. Advisory
  only: nothing waits, refuses or freezes. Stale leases never warn, writes are
  compare-and-swap with no lock, and an unreachable bus never fails the caller. Also
  `bus note`, the `bus_status` MCP tool, and `sync --remote gs://…`.
- **Keyed inputs:** `recordKeyRead(file, key)` from `tracegate-ci/recorder`. A plugin
  that serves a table by key (an i18n catalog, a flag file) reports the keys a test
  read, and a change to that table re-runs only tests that read a changed key. JSON is
  compared directly; a table written as code goes through the lane's `keyedExtract`
  command, and only edits to its data are narrowed. `*` is a whole-table read.
- **The pre-select hook:** `lanes.<l>.preSelect`, a command that may add files to an
  enforce selection, never remove one. A hook that fails runs the lane whole.
- **`tracegate daemon`:** the nightly full lane and pre-gating the train queue, in
  throwaway worktrees under a preemptible broker lease; `install` writes a launchd
  agent or a systemd user timer.
- **Releases publish directly.** A pushed tag runs the tests and the sabotage run, then
  `npm publish --provenance` through Trusted Publishing. Before, it staged the release
  and waited for a maintainer to approve it on npmjs.com.

## 0.9.2 (2026-11-02): plugin directory readiness and the first report card

- **The first published report card:** `docs/evidence/openwop-app-2026-10.md`, from the
  ledger of the project Tracegate was built in (610 runs over three weeks). One private test
  path and one commit prefix are redacted.
- **Report card: the observation window is in time order.** It showed the first and last
  row read, and a ledger holds one log per host, read file by file, so a two-host ledger
  printed a window that started days late (the first card said 2026-10-17 for a lane
  observed since 2026-10-13). Counts and rates were not affected.
- **README: what the plugin runs, reads, writes and sends**, for the plugin directory's
  security scan; `plugin.json` gains `displayName`, `documentationUrl` and `supportUrl`.
- **A plugin icon** (`assets/icon.svg`, rendered to `assets/icon.png`), named by `icon` in
  `plugin.json` for the plugin directory listing.
- **A sabotage witness that depended on timing.** `red-unique-ids` compared two packets
  written dozens of lines apart, so it only tested "same second" when the test ran fast;
  on a slow macOS runner it passed with the rule broken (main CI, 2026-11-01). The check
  now writes two packets under a frozen clock.

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
