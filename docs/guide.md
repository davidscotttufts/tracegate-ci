# Tracegate guide

The [README](../README.md) gets you running. This is the reference.

- [Running a lane](#running-a-lane)
- [Configuration](#configuration)
- [How a decision is made](#how-a-decision-is-made)
- [The ledger and its commands](#the-ledger-and-its-commands)
- [Broker](#broker)
- [Agents: MCP and the Claude Code plugin](#agents-mcp-and-the-claude-code-plugin)
- [Daemon](#daemon)
- [Release bus](#release-bus)
- [Merge train](#merge-train)
- [Red Reader](#red-reader)
- [Conductor](#conductor)
- [Silence guard](#silence-guard)
- [Dependency changes](#dependency-changes)
- [Jest](#jest)
- [Attestation](#attestation)
- [Testing and releasing](#testing-and-releasing)

## Running a lane

```sh
npx tracegate run --lane api -- --maxWorkers=2    # arguments after -- go to the runner
```

`run` does the whole cycle:

1. Picks the mode: `TRACEGATE` or `TRACEGATE_<LANE>` if set, otherwise `auto`.
2. Selects the files to run.
3. Runs the tests with the recorder on.
4. Reports misses.
5. Re-runs each miss alone, and triages it `flake` if it passes.
6. Ingests the new footprints, unless HEAD moved during the run.
7. Records a full run if the whole lane ran green.

The exit code is the runner's. If selection fails, the whole lane runs and nothing is
recorded.

The modes:

| Mode | What runs |
|---|---|
| `shadow` | Everything. The log says what could have been skipped. |
| `enforce` | What must run, plus a random audit sample of the rest. |
| `off` | Everything; nothing is recorded. |
| `auto` | `shadow` until the lane meets its entry bar, then `enforce`. Back to `shadow` after a miss, or when the last full run is over a day old. |

To wire it into a CI script yourself, use the three steps `run` wraps:

```sh
RUN=$(mktemp -d); HEAD0=$(git rev-parse HEAD)
npx tracegate select --lane api --run "$RUN"        # writes selected.txt and predict.json
( cd packages/api && TRACEGATE_RECORD="$RUN" TRACEGATE_LANE=api npx vitest run \
    --reporter=default --reporter=json --outputFile.json="$RUN/results.json" \
    $( [ "$(npx tracegate mode --lane api)" = enforce ] && cat "$RUN/selected.txt" ) )
npx tracegate report --lane api --run "$RUN"
npx tracegate ingest --lane api --run "$RUN" --expect-head "$HEAD0"
```

Under enforce with an empty `selected.txt`, skip the runner: given no files, Vitest runs
them all.

### Wiring the recorder by hand

`tracegate init --write` does this for you. Make the recorder the first setup file, and
only when a run asks for it:

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    setupFiles: [...(process.env.TRACEGATE_RECORD ? ['tracegate-ci/vitest-setup'] : []), /* yours */],
  },
});
```

With `TRACEGATE_RECORD` unset, nothing is loaded.

## Configuration

`tracegate.config.json` at the repository root. A lane is one test project:

```json
{
  "lanes": {
    "api": { "dir": "packages/api", "src": "src", "globals": ["test/setup/"] },
    "web": { "dir": "packages/web", "src": "src", "entryBar": { "days": 1, "earlyAudit": 0.2 } }
  }
}
```

With no config file there is one lane, `default`, at the root with `src/`.

**Lane settings**

| Key | Default | Meaning |
|---|---|---|
| `dir` | `.` | The project directory, relative to the root. |
| `src` | `src` | Source directory inside `dir`. Modules here are tracked per function; anything else a test loads is tracked as a whole file. |
| `runner` | `vitest` | `vitest` or `jest`. |
| `globals` | — | Extra paths (relative to `dir`) whose change runs the whole lane. `*` matches within a path segment; a trailing `/` matches a directory. Add your setup-file directory here. |
| `rootGlobals` | — | The same, relative to the root. |
| `entryBar` | — | Override the bar for this lane. A shorter `days` lets it in early; `earlyAudit` is its audit rate until the default `days` would have passed. |
| `lockfile` | auto | The lockfile hashed into each footprint. Default: the first npm, pnpm or yarn lockfile in `dir`, then at the root. |
| `preSelect` | — | A command that may add files to an enforce selection. See below. |
| `keyedExtract` | — | A command that reads a table written as code. See [keyed inputs](#keyed-inputs). |
| `replayExclude` | `[]` | Test-file patterns `replay` must not list. |

Always global: in each lane `package.json`, lockfiles, `vitest.config.*`,
`vitest.workspace.*`, `vitest.setup.*`, `vite.config.*` and `tsconfig*.json`; at the root
`package.json`, lockfiles, `.nvmrc`, `.node-version`, `.tool-versions` and
`tracegate.config.json`.

**Repository settings**

| Key | Default | Meaning |
|---|---|---|
| `entryBar` | `{ "days": 14, "observations": 20 }` | Enforce after this many runs over this many days, with no untriaged miss. |
| `audit` | `0.05` | Share of reusable verdicts re-run anyway, at random. |
| `missSuspendDays` | `14` | How long a miss suspends enforcement. |
| `maxAgeHours` | `72` | Footprints older than this are never reused. |
| `fullRunMaxHours` | `24` | A lane whose last full green run is older runs whole. `0` turns this off. |
| `keepPerTest` | `6` | Footprints kept per test file. |
| `ingestBudgetSeconds` | `300` | Ingest stops after this long. |
| `ledger` | `<git common dir>/tracegate` | Where the ledger lives. |
| `sync` | — | Default remote for `tracegate sync`. |
| `bus` | — | The [release bus](#release-bus) store. |
| `daemon` | — | [Daemon](#daemon) settings. |
| `broker`, `red`, `conductor`, `silence`, `deps` | — | See each section. |

Environment overrides: `TRACEGATE_LEDGER`, `TRACEGATE_MAX_AGE_HOURS`,
`TRACEGATE_INGEST_BUDGET_S`, `TRACEGATE_CONFIG` (another config file).

### The pre-select hook

`lanes.<l>.preSelect` names a command. Under enforce it gets
`{ lane, head, tree, files, selected, reused }` as JSON on stdin and prints test files that
must run too, one repo path per line. It can only add files. A hook that fails, takes more
than 120 seconds, or names a file that isn't a test of the lane makes the whole lane run.

## How a decision is made

A footprint recorded at commit C lets a test reuse its verdict on tree H when all of these
hold:

- same footprint format, Node version and lockfile (or a lockfile change the
  [dependency rule](#dependency-changes) covers);
- the footprint is under 72 hours old, and C still exists;
- nothing changed between C and H in: a global input, the test file, a non-source module
  it loaded, a function it executed, a constant its code names, a top-level statement of a
  module it loaded, a module that couldn't be mapped, or a path it read or listed.

Changes are attributed per character to their owner: the innermost function, or the kind
of top-level statement. Type-only edits are ignored. Adding, removing or changing a value
import counts as a change. A plain-data `const` is a constant, and anything else is top
level. An anonymous callback is keyed by its callee and first
string argument, so each route handler is its own key.

**Uncommitted changes count.** If tracked files are edited, H is the working tree.
`select` snapshots it with `git stash create`, which writes no ref and no stash entry. A
run on uncommitted changes records no footprints, no full run and no attestation
evidence, because none of those could name a commit that was tested.

**A test that runs `git` on the repository** (`git log`, `git show`, a check of commit
messages) depends on its history, which no file read shows. The recorder notes when a test
runs `git` in the repository, through any `child_process` call, and such a test runs again
after every new commit. `git` run in a test's own temporary repository doesn't count.

**What a footprint can't see:** environment variables, the clock (hence the 72-hour
limit), the network, and what other processes read. The random audit and the daily full run are
the backstops, and a miss from either suspends the lane.

**If the runner moves the recorder's seam** (after a Vitest upgrade, say), modules come
back unmapped. A change to an unmapped module always means "run", so selection stays safe
but gets coarse. `ingest` prints the unmapped share and warns above 5%.

### Keyed inputs

A data file a test reads is an input as a whole: any edit runs every test that read it.
If your test helpers serve a table by key, such as an i18n catalog behind `t()`, report
the keys instead:

```js
import { recordKeyRead } from 'tracegate-ci/recorder';
const t = (key) => { recordKeyRead('src/locales/en.json', key); return messages[key]; };
```

An edit to that file then re-runs only the tests that read a key whose value changed.

- A key is looked up as a property name first (so `greet.hello` works as a flat key), then
  as a dotted path.
- Report `*` for a test that reads the whole table.
- JSON is compared directly. A table written as code (`export const messages = { … }`)
  needs the lane's `keyedExtract` command: it gets the file on stdin and prints the values
  as one JSON object. Without one, the file is a plain whole-file input.
- In a code table, only edits to the data are narrowed. An edit to its code follows the
  normal module rule. An extractor that fails counts as a change.
- A test that imports the JSON itself, or records no keys for it, keeps the whole-file
  rule.

Report only the reads your helpers make for the test. A test that reads the whole file
with `fs` can't be told apart.

## The ledger and its commands

The ledger is `$(git rev-parse --git-common-dir)/tracegate/`, shared by every worktree.

- `fp/` and `blobs/` are a cache. Deleting them is safe; it only costs predictions.
- The `*.tsv` logs are the evidence, one file per machine. Don't delete them: the entry bar
  reads them.

```sh
npx tracegate status                       # mode, entry bar and ledger per lane
npx tracegate savings [--json]             # what reuse would have saved, from the first run
npx tracegate report-card [--json] [--out file]
npx tracegate mode --lane api              # off | shadow | enforce
npx tracegate triage --lane api --file <test> --verdict flake|hole [--head <sha>]
npx tracegate replay --lane api --head <commit> --at <time> [--drop <regex>]
npx tracegate full-done --lane api
npx tracegate sync --remote user@host:/abs/path/.git/tracegate
```

- **triage.** `hole` means the footprint missed an input: a recorder bug. `flake` means the
  test fails on its own. Only `flake` lifts a suspension. A test that passes when re-run
  alone isn't proven a flake: read the failure first.
- **savings** works from the shadow log, so it has numbers from the first run. A miss is
  never counted as a saving.
- **report-card** publishes the miss rate per checked verdict and per run, with 95% Wilson
  intervals, the triage of each miss, the longest a hole could have gone unnoticed, and the
  audit cost. See [evidence/](evidence/).
- **replay** re-decides a past run offline, with only the footprints recorded before it,
  optionally with some causes removed. It changes nothing in the ledger.
- **sync** exchanges the ledger with another machine, over rsync or through a `gs://`
  prefix. Footprints and packets are merged, and each machine sends its own logs. The
  train queue and the daemon log stay on their machine.

## Broker

One process hands out the machine's capacity to everything that wants it: gates, trains,
the daemon, measurements, deploy builds, and each agent's test runs.

```sh
tracegate lease --class gate --tokens 4 --est 900 --label "gate api" -- npm run ci
tracegate lease --class measure --exclusive -- ./bench.sh       # waits for the machine to itself
tracegate lease --class daemon --tokens 2 --requeue -- tracegate run --lane api
tracegate queue            # who holds what, and who waits
tracegate explain j42      # why j42 waits, and when it starts
```

- The first `lease` starts the broker. It stops after 30 idle minutes.
- The command gets `TRACEGATE_TOKENS` and `VITEST_MAX_WORKERS` set to its grant, and
  `TRACEGATE_CONTENDED=1` if it started on a busy machine.
- A lease taken inside another lease runs at once, within the parent's tokens.
- A lease ends when its process ends, even on SIGKILL. There are no stale locks.

| Class | Priority | Preemptible |
|---|---|---|
| `deploy` | 70 | no |
| `gate`, `train`, `measure` | 50 | no |
| `adhoc` | 30 | no |
| `daemon` | 10 | yes |

```json
{ "broker": { "capacity": 8, "idleMinutes": 30, "classes": { "adhoc": { "priority": 35 } } } }
```

### Adaptive capacity

The broker sizes work to the machine as it is right now:

```sh
tracegate lease --class gate --tokens 8 --min-tokens 2 -- tracegate run --lane api
tracegate machine          # hardware, the latest reading, and the current budgets
```

- Every 5 seconds it computes a CPU budget (capacity minus cores busy with work it doesn't
  run, scaled down by heat and memory pressure) and a memory budget.
- Budgets drop at once and recover slowly, because contention produces reds that look like
  bugs.
- Memory per job is learned from each job's measured peak, or declared with
  `--mem-per-token`.
- Under memory pressure, only preemptible work is stopped. A gate never is.
- A job held back only by other people's load starts anyway after 5 minutes, marked
  contended.
- Defaults come from each machine's cores and RAM, container limits included. Override one
  machine under `"hosts"`, and try a policy first with `"mode": "shadow"`.

```json
{ "broker": { "capacity": "75%", "adaptive": { "mode": "on", "upHoldS": 30, "starvationS": 300 },
              "hosts": { "ci-runner-1": { "capacity": 32 } } } }
```

The design and the per-platform signals are in [design/broker.md](design/broker.md).

### Adopting it beside existing locks

If your scripts already coordinate some other way, let the broker watch first:

```sh
tracegate observe --class gate --tokens 7 --label "gate" --watch-pid $$ &   # never waits
tracegate observed         # who would have waited, behind whom
```

An observed job is granted at once, and the broker records whether it would have waited.
After a week of that, you can retire the old mechanisms one at a time. Register gates with
`observe --yield` and the broker also stops preemptible work while they run.

### Make jobserver

`lease --jobserver` gives a lease of N tokens a jobserver with N − 1 tokens
(`MAKEFLAGS=-jN --jobserver-auth=fifo:…`), so make, Ninja and cargo stay inside the grant.

### Advisor hook

`broker.advisor.command` gets the jobs waiting in one priority tier on stdin and may return
a new order for them. Anything other than an exact reordering of that tier is rejected. The
default mode is `shadow`, which logs the advice without applying it. The advisor can never
grant, preempt, add or remove a job.

## Agents: MCP and the Claude Code plugin

`tracegate mcp` is an MCP server over stdio.

- Read tools: `queue_status`, `explain_job`, `history`, `machine_load`, `lane_mode`,
  `red_runs`, `read_red`, `deps_runs`, `read_deps`, `savings`, `report_card`,
  `train_status`, `bus_status`.
- With `--allow-write`: `cancel_queued` (queued jobs only), `annotate_red` and
  `annotate_deps` (opinions that can only make things stricter), and `train_add`.

```sh
claude mcp add tracegate -- npx tracegate mcp
```

The Claude Code plugin (`/plugin marketplace add davidscotttufts/tracegate-ci`) bundles the
server, the `red-reader` and `deps-oracle` subagents, two skills, and a hook. In a
repository with a `tracegate.config.json`, the hook blocks a bare `vitest` or `npm test`
run outside a broker lease and names the command to use instead, so agents' test runs
queue with everything else. It also blocks agents from running `triage` and
`silence allow`. `TRACEGATE_HOOK=off` turns it off.

## Daemon

`tracegate daemon tick` is one pass of background work, run every 20 minutes:

- **At night**, it runs any lane whose last full run is older than `fullRunMaxHours`, at
  the target branch's tip. The daily full run then doesn't land on someone's gate.
- **For the merge train**, it runs each queued PR once at its pinned commit. When the train
  gates the merge later, only what the merge changed has to run.

Each piece runs in a throwaway worktree under a preemptible `daemon` lease. If a gate needs
the machine, the piece stops, is logged `yielded`, and runs on a later tick. A piece that
ran, green or red, doesn't run again at the same commit: a pre-gated PR never does, and a
full lane not within the same `fullRunMaxHours`. A piece whose lockfile differs from the
installed packages is skipped, because the worktree borrows your `node_modules`.

```sh
npx tracegate daemon status            # installed?, the next tick's plan, recent pieces
npx tracegate daemon tick --dry-run
npx tracegate daemon install           # launchd agent (macOS) or systemd user timer (Linux)
npx tracegate daemon install --print   # show the files instead of writing them
npx tracegate daemon uninstall
```

Settings: `"daemon": { "window": "1-6", "target": "main", "pregate": true, "tokens": 2,
"every": 20, "timeoutMin": 120 }`. `window` is local hours.

## Release bus

The broker sees one machine. When two machines work on the same repository, each can start
a train or a deploy while the other's is running. The bus is a small shared record both
can read:

```json
{ "bus": "gs://my-bucket/tracegate" }
```

- `tracegate train run` holds a lease while it runs and posts start and end events.
  Scripts can do the same: `tracegate bus claim --kind deploy` prints a lease id, and
  `tracegate bus release <id> --result ok` ends it.
- Before gating, a train prints a warning for each live lease another machine holds, and
  carries on. The bus never makes anything wait.
- A lease lasts about twice its kind's typical run. After that it shows as stale and is
  ignored, so a crashed run or a closed laptop leaves nothing stuck.
- Writes use compare-and-swap on the record's generation, not a lock. If the bus can't be
  reached within 10 seconds, the command prints `bus: unavailable` and continues.
- `tracegate bus note --text "…"` leaves a message for the other machine's sessions.
  Anything that looks like a credential is refused.
- `tracegate bus status` shows both machines. Agents use the `bus_status` tool.
- `tracegate sync --remote gs://my-bucket/ledger` shares the ledger the same way.

GCS goes through the `gcloud` CLI and its login. A directory path works too, for a shared
disk or for testing.

## Merge train

```sh
tracegate train add --pr 12=origin/pr-12      # pinned to that commit
tracegate train add --pr 13=origin/pr-13
tracegate train run --lane api                # gate, bisect, land; --push to push
tracegate train status
```

1. The [Conductor](#conductor) advises which PRs go alone. The rest form one batch.
2. Each batch is a real merge commit on the target's current tip, built in a throwaway
   worktree. A PR that doesn't merge cleanly is rejected.
3. The gate (default `tracegate run`, or `--gate "<cmd>"`) runs there under a `train`
   lease.
4. Green: the target moves to the gated commit, but only if it hasn't moved in the
   meantime. A checked-out target with local changes is never touched.
5. Red: the batch is split in half and each half gated, down to the PR that broke it.
   Unchanged verdicts are reused, and a train needs at most 2n − 1 gates.

The target only ever points at a commit whose exact tree passed. Nothing is pushed unless
you ask.

## Red Reader

Every red `tracegate run` writes a packet: what failed, what Tracegate predicted, whether
it was a miss, the re-run result, the file's history, the change and the machine load. An
agent reads the packet and records an opinion: `real`, `flake-suspect`, `infra` or
`unclear`, and whether to escalate.

```sh
tracegate red list         # packets, escalated first
tracegate red show <id>
tracegate red score        # opinions against the triage a person recorded later
cp node_modules/tracegate-ci/agents/red-reader.md .claude/agents/
```

An opinion can only make the gate stricter. If it says `real`, escalates, has confidence of
at least 0.7 (`red.escalateMinConfidence`), and the file was a miss, the miss counts as a
`hole` and the lane suspends. Nothing an opinion does can mark a miss a flake, lift a
suspension or turn a red green. A person's later `triage` overrides it. `red score` counts
how often that happens.

`TRACEGATE_RED=off` stops packets; `TRACEGATE_RED_ESCALATE=off` stops escalation.

## Conductor

**Fail-first order.** Files that must run are ranked: recent failures first, then those
whose test file changed, whose executed code changed, whose inputs changed, and lane-wide
reasons, with quicker files first among equals. On a red run the first failure's rank is
logged against what a random order would give. The set of files never changes.
`"conductor": { "mode": "order" }` passes the order to Vitest through the sequencer:

```ts
import TracegateSequencer from 'tracegate-ci/sequencer';
export default defineConfig({ test: { sequence: { sequencer: TracegateSequencer } } });
```

**Train advice.**

```sh
tracegate conductor train --lane api --pr 12=origin/pr-12 --pr 13=origin/pr-13 --base origin/main
tracegate conductor outcome --id <advice id> --red 12
tracegate conductor score
```

A PR goes alone if it touches a global input, or reaches more than a quarter of the lane
and twice the median of the others. Pairs whose reach doesn't overlap are listed.
`score` counts bisections saved, and how often a pair called independent failed only
together.

## Silence guard

A change that makes the suite test less shouldn't pass as green. On each `run`, the guard
compares the lane's test files with the merge base and reports net additions of `.skip`,
`.todo`, `.skipIf`, `.runIf`, `xit`, `xtest`, `xdescribe` and `.only`, `if (false)`,
removed `it(` and `test(` calls, and deleted test files. A skip that was already there is
never reported.

```json
{ "silence": { "mode": "shadow", "base": "main" } }
```

- `shadow` (default): logs findings and adds them to the red packet.
- `enforce`: the run fails until a person approves each finding with
  `tracegate silence allow --file <f> --by <name>`, for that version of the file.
- `off`: does nothing.

No agent tool can lift it. [recipes/edit-guards.md](recipes/edit-guards.md) pairs it with
edit-level guards.

## Dependency changes

A lockfile change used to run the whole lane. Now a test keeps its verdict if it didn't
load a changed package, provided:

- the lockfile is npm's `package-lock.json` (v2 or v3), and every `node_modules` is inside
  the repository;
- no changed package has an install script or an os/cpu restriction;
- the Vitest main process (config, plugins, transforms) loaded no changed package.

A changed package's nested copies, and the packages that resolve them, count as changed.
An edit to `package.json` that only touches dependency fields is covered too.

The rule has its own bar: 3 lockfile runs over 1 day (`deps.bar`). Until then, the files it
would reuse still run and are logged. `TRACEGATE_DEPS=off|shadow|auto|enforce`.

Each lockfile run also writes a dependency packet, so an agent can predict which tests a
bump affects (`annotate_deps`, or `agents/deps-oracle.md`). `tracegate deps score` measures
those predictions. They are never used to skip anything.

## Jest

```json
{ "lanes": { "app": { "runner": "jest" } } }
```

```js
// jest.config.cjs
module.exports = { testEnvironment: 'tracegate-ci/jest-environment' };
```

The environment extends `jest-environment-node` and does nothing unless a run is recording.
Everything else works the same. Two differences: recording uses V8 call counts, which costs
more than under Vitest, and the dependency rule doesn't apply to Jest lanes. `init` doesn't
write Jest configs yet; `doctor --canary` does check them.

## Attestation

A signoff says a commit is green. An attestation says what ran on which tree, signed:

```sh
npx tracegate attest                  # sign what ran at HEAD, as a git note
npx tracegate verify <commit>         # check signature, commit and tree
git push origin refs/notes/tracegate  # share the notes
```

Every lane needs a green run at that exact tree, or nothing is attested. It signs with
your git signing key (`gpg.format` ssh or openpgp). Without one it's stored unsigned, and
`verify` rejects it unless given `--allow-unsigned`. `attest --status` also sets a GitHub
commit status through your `gh` login.

## Testing and releasing

```sh
npm test                    # every unit suite
node test/sabotage.mjs      # breaks each rule in a copy; each must turn its test red
npm run test:e2e            # end to end on examples/sample-repo
npm run test:e2e-jest       # the same on the Jest sample
npm run test:vitest-matrix  # once per supported Vitest version
npm run test:compare        # against Vitest's recordDependencies
```

The self-test checks both directions on purpose: a predictor that always says "run" fails
the skip cases, and one that always says "skip" fails the run cases. `examples/e2e.sh`
asserts, for each kind of edit to the sample repository, exactly which test files run.

A pushed tag `vX.Y.Z` that matches `package.json` runs the tests and the sabotage suite,
then publishes to npm with provenance through Trusted Publishing. `mcp-publisher publish`
then updates the MCP Registry entry.
