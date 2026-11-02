# Changelog

## 0.10.0 (2026-11-02)

Added:
- **Release bus** (`tracegate bus`, `"bus"` in the config): see what another machine is
  gating or deploying, through a GCS bucket or a shared directory. It only warns; it never
  makes anything wait.
- **Keyed inputs** (`recordKeyRead` from `tracegate-ci/recorder`): an edit to one key of a
  table re-runs only the tests that read that key. JSON works directly; tables written as
  code need a lane's `keyedExtract` command.
- **Pre-select hook** (`lanes.<l>.preSelect`): a command that can add tests to a
  selection, never remove them.
- **`tracegate daemon`:** full lanes at night and pre-testing of queued train branches,
  under a preemptible lease. `install` sets up launchd or systemd.
- `sync --remote gs://…`, `bus note`, and the `bus_status` MCP tool.

Fixed:
- `tracegate sync` copied only the five logs it started with, so escalations, approved
  skips, green runs, opinions and packets never reached the other machine. It now copies
  every shared log, and a test fails on any new log that isn't classified.

Changed:
- A pushed tag publishes to npm directly, instead of staging for approval.

## 0.9.2 (2026-11-02)

Added:
- The first published report card, from the project Tracegate came from
  (`docs/evidence/`).
- A plugin icon, and listing fields in `plugin.json` for Anthropic's plugin directory.

Fixed:
- The report card printed the wrong observation window for a ledger shared by two
  machines. Counts and rates were right.
- A sabotage check that only worked when the test ran fast.

## 0.9.1 (2026-10-30)

Fixes found by installing 0.9.0 as a new user:
- An uncommitted edit was invisible to selection, so its tests could be skipped. Selection
  now runs against the working tree.
- A run on uncommitted changes was recorded as evidence about HEAD. It no longer is.
- TypeScript 7 has no JS parser API, and `run` crashed on it while `doctor` passed. Tracegate
  now parses with TypeScript 5 or 6, found under the alias `tracegate-typescript` first,
  and `doctor` fails a lane it can't parse.
- `server.json`'s description was too long for the MCP Registry.

Added: `tracegate --version`.

## 0.9.0 (2026-10-30)

First release on npm.

- **Jest 30** as a second runner (`"runner": "jest"`, and
  `testEnvironment: 'tracegate-ci/jest-environment'`).
- **`tracegate attest` / `verify`:** a signed git note of what ran on a commit's exact tree.
- The recorder refuses to map a module compiled with more than one text in a worker.

## 0.8.0 (unreleased)

- **Merge train** (`tracegate train`): gates each batch as its real merge commit, bisects a
  red batch, and lands only what passed. MCP tools `train_status` and `train_add`.
- **Silence guard:** catches added skips, `.only`, removed tests and deleted test files.
  Only a person can approve one.
- The Claude Code hook blocks agents from running `triage` and `silence allow`.
- Recipes in `docs/recipes/`.

## 0.7.0 (unreleased)

- `tracegate savings` and `tracegate report-card`, and their MCP tools.
- The comparison with Vitest's `recordDependencies`, checked in CI.

## 0.6.0 (unreleased)

- `tracegate init` and `tracegate doctor`.
- Vitest 4.1 to 5.x, each tested in CI.
- The Claude Code plugin, and MCP Registry metadata.
- CI on GitHub Actions, and publishing from a tag.

## 0.5.0

- Red Reader escalation: an agent's `real` opinion on a miss suspends the lane.
- The Conductor: fail-first order and merge-train advice, in shadow.
- The dependency rule for lockfile changes, and the dependency oracle in shadow.
- `lease --jobserver`.

## 0.4.0

- `tracegate observe` / `observed`.
- Red Reader packets, MCP tools and opinions.

## 0.3.0

- Adaptive capacity: the broker sizes work to CPU, memory, swap and heat.

## 0.2.0

- The broker and its MCP server.

## 0.1.0

- Recorder, ledger, predictor and replay, extracted from the host project.
