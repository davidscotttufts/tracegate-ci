# Changelog

## 0.10.6 (2026-11-23)

Fixed (a test that runs another process could be reused after a change it depends on):
- The recorder only noticed `git`. A test that ran any other process (`node
  scripts/check-x.mjs`, a forked helper) recorded nothing of what that process read or ran.
  So its verdict could be reused after `check-x.mjs` changed: a miss waiting to happen.
  Found by comparing the package with a fork that treats such tests as opaque.
- Now any `child_process` call made from repository code (the test, the code under test, or
  a library they call such as `execa`) marks the footprint `subprocess`. Such a test is
  reused only at the commit it was recorded on and runs after any change, with the reason
  "runs a subprocess (its inputs are not recorded)". A spawn made only by tooling under
  `node_modules`, such as a transform service, doesn't count. `fork` is covered too.

Upgrading:
- Footprints recorded before 0.10.6 have no `subprocess` answer and are treated as opaque,
  so the first gate after upgrading runs the whole lane. Record once (a full run) to get
  reuse back. Tests that spawn processes now always run after a change, so expect a
  slightly wider selection than before. That is the price of not reusing what can't be seen.

## 0.10.5 (2026-11-22)

Added (a moved seam is visible where agents look):
- Every ingest records the lane's unmapped share in `seam-<host>.tsv`, which `tracegate
  sync` carries between machines.
- `tracegate status` shows `seam: ok (N% unmapped)` or `seam: DEGRADED (N% unmapped at
  <head>, vitest X)` on each lane's line, and the MCP `lane_mode` tool returns the same
  reading as `seam`.
- A degraded run (over 5% unmapped) no longer counts as an entry-bar observation, and
  status says how many it set aside. Before, a Vitest upgrade that moved the seam could
  quietly carry a lane toward enforce on predictions that were only coarse. Selection
  itself was always safe: an unmapped module means "run".

## 0.10.4 (2026-11-18)

Fixed (the dependency rule, for releases):
- A lockfile change that changes no installed package, such as a release bumping only
  the root package's own version, is no longer a dependency change. Footprints now
  survive it without needing their package lists and without the dependency rule's bar.
  Before, every footprint read "lockfile changed" after every release, so the whole lane
  ran. Measured in a host repo's trial: 44 compared gates in which every file was
  selected.
- A `package.json` edit that only changes its own `version` is waived from the global
  rule, the same way a dependency-only edit is. A test that reads `package.json` itself
  still runs.
- A footprint recorded without package lists now says so in its reason
  ("lockfile changed (this footprint has no package lists)").

Fixed (Vitest 5.1.1):
- Vitest 5.1.1 inlines a module's source map only when an inspector is open, so every
  module recorded as unmapped and Tracegate degraded to SAFE: no wrong skips, but no
  savings either. The recorder now writes the module runner's own source map beside
  the module's text, and ingest reads it when the text carries none. The text is left
  byte-identical, so V8's offsets still match it.

## 0.10.3 (2026-11-11)

Fixed (the daemon, for a second config or ledger on one machine):
- A `TRACEGATE_CONFIG` inside the repository was dropped in the worktree, so a piece ran
  with the default config and wrote to the default ledger. It now reads the worktree's
  copy at the piece's commit; a config outside the repository is passed on as given.
- `daemon install` now carries `TRACEGATE_CONFIG`, `TRACEGATE_LEDGER` and the broker's
  location into the launchd or systemd unit. Each config gets a unit of its own; with no
  `TRACEGATE_CONFIG`, the unit's name doesn't change.
- `daemon.target` can be a remote-tracking branch (`"origin/main"`) when no local branch
  has that name.

## 0.10.2 (2026-11-04)

Added:
- `tracegate report-card --redact` replaces test paths, commit prefixes and the host with
  `[redacted]`, so a private project can share its card. No number changes.
- [docs/trial.md](docs/trial.md): a two-week shadow trial, and how to share the card.

## 0.10.1 (2026-11-02)

Fixed:
- A test that runs `git` on the repository (to read commit messages, say) could reuse its
  verdict after a new commit, because history is no file the test reads. Found triaging
  the host project's misses: a check of ADR statuses against commit subjects went red
  after a commit, with nothing in its footprint changed. The recorder now notes any `git`
  run in the repository, through any `child_process` call, and such a test runs again
  after every new commit. `git` in a test's own temporary repository doesn't count.

Added:
- `PRIVACY.md`, linked from `plugin.json` (`privacyPolicyUrl`) and shipped in the package:
  what Tracegate reads, writes and sends (nothing by default).
- The published report card now has every backend miss in the host project triaged.

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
