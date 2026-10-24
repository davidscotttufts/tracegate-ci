# Tracegate CI

Local CI that runs only what a change can affect, and earns the right to skip the rest.

Tracegate records what each test actually touches: the functions it executed, the modules
it loaded and the repo files it read. It writes that per-file **footprint** into a ledger.
A test whose footprint nothing has changed since its last green run can reuse that
verdict. It only gets that right after a measured evidence period:

- **Shadow first.** It runs everything and logs what it *could* have skipped.
- **Entry bar.** A lane starts skipping only after enough observations with no miss.
- **Random audits.** A share of the reusable verdicts is re-run anyway, at random.
- **Suspended by a miss.** A test predicted reusable that fails is a recorder bug. The
  lane goes back to running whole until it re-earns the bar.

It cannot turn a red into a green: a failing file's footprint is dropped, a moved tree is
refused, and footprints older than 72 hours are never reused.

## Status

Tracegate was built and runs in production inside a private TypeScript monorepo of about
2,700 backend and 1,000 frontend test files. It sits in a local merge gate that batches
pull requests into merge trains and bisects a red train automatically.

**Phase 0 is done ([ROADMAP.md](ROADMAP.md) §4):** the deterministic core is extracted
here as a standalone tool for **Vitest + TypeScript**.

**Phase 0.5 is done: the broker.** One queue for all of a machine's CI work: gates,
merge trains, background pre-gating, measurements, deploy builds, and every AI agent
session's test runs. Agents reach it over MCP. See [Broker](#broker) and
[docs/design/broker.md](docs/design/broker.md).

**Phase 0.6 is done: adaptive capacity.** The broker samples CPU, memory, memory
pressure, swap and heat, and grants each job only the workers and memory the machine can
take right now. Every default derives from the host, so one config serves a laptop and a
64-core runner. See [Adaptive capacity](#adaptive-capacity).

The model-assisted phases (1–3) are not started. Version 0.3.0, not yet published to npm.

## The idea in one paragraph

Most AI-in-CI products try to *fix* or *skip*. They publish no failure rates and have a
documented habit of silencing tests. Tracegate CI goes the other way. The first model in
the gate may only make it **stricter**: it reads every red the gate wants to write off as
a flake and may escalate it to a real bug, never the reverse. Model decisions are cached
by input hash, so a gate is replayable. They run in shadow before they decide anything,
and the model gets no tools and no credentials.

## Requirements

- Node.js ≥ 22, git.
- Vitest 4.1 (the recorder hooks the `vm.runInThisContext` seam Vitest 4.1 uses to
  evaluate modules; a Vitest that moves it degrades to *safe*, see below).
- `typescript` installed in the target repository (used to parse source files).

## Usage

### 1. Install and wire the recorder

```sh
npm install --save-dev tracegate-ci   # or: npm install --save-dev /path/to/tracegate-ci
```

Add the recorder as the **first** setup file, only when a run asks for it:

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    setupFiles: [...(process.env.TRACEGATE_RECORD ? ['tracegate-ci/vitest-setup'] : []), /* yours */],
  },
});
```

Unset, nothing is loaded and nothing changes.

### 2. Describe the lanes

A **lane** is one Vitest project. `tracegate.config.json` at the repository root:

```json
{
  "lanes": {
    "api": { "dir": "packages/api", "src": "src", "globals": ["test/setup/"] },
    "web": { "dir": "packages/web", "src": "src", "entryBar": { "days": 1, "earlyAudit": 0.2 } }
  },
  "entryBar": { "days": 14, "observations": 20 },
  "audit": 0.05
}
```

| Key | Default | Meaning |
|---|---|---|
| `lanes.<l>.dir` | `.` | The Vitest project directory, relative to the repo root. |
| `lanes.<l>.src` | `src` | Source directory inside `dir`. Only modules here are tracked per function; any other loaded module is tracked whole. |
| `lanes.<l>.globals` | see below | Extra inputs (relative to `dir`) whose change runs the whole lane. `*` matches within a path segment; a trailing `/` matches a directory. |
| `lanes.<l>.rootGlobals`, `rootGlobals` | see below | The same, relative to the repo root. |
| `lanes.<l>.entryBar` | — | Per-lane override of the bar. A shorter `days` is an **early entry**; `earlyAudit` is the audit rate until the default bar's `days` would have been met. |
| `lanes.<l>.lockfile` | auto | The lockfile hashed into every footprint (default: the first of `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock` in `dir`, then at the root). |
| `lanes.<l>.replayExclude` | `[]` | Test-file patterns `replay` must not list (e.g. an e2e folder Vitest does not run). |
| `entryBar` | `{ "days": 14, "observations": 20 }` | Enforce only after this many observations over this many days, with no un-triaged miss. |
| `audit` | `0.05` | Share of reusable verdicts re-run anyway, uniformly at random. |
| `missSuspendDays` | `14` | How long a miss suspends enforcement. |
| `maxAgeHours` | `72` | Footprints older than this are never reused (`TRACEGATE_MAX_AGE_HOURS`). |
| `fullRunMaxHours` | `24` | A lane whose last complete green full run is older runs whole. `0` disables. |
| `keepPerTest` | `6` | Footprints kept per test file. |
| `ingestBudgetSeconds` | `300` | Ingest stops recording after this long (`TRACEGATE_INGEST_BUDGET_S`). |
| `ledger` | `<git common dir>/tracegate` | Ledger directory, relative to the root (`TRACEGATE_LEDGER`). |
| `sync` | — | Default `--remote` for `tracegate sync`. |

Global inputs that are always included: in each lane dir `package.json`, lockfiles,
`vitest.config.*`, `vitest.workspace.*`, `vitest.setup.*`, `vite.config.*`,
`tsconfig*.json`; at the root `package.json`, lockfiles, `.nvmrc`, `.node-version`,
`.tool-versions`, `tracegate.config.json`. Configured globals add to these. **Add your
setup-file directory** (as `test/setup/` above): setup files are loaded by every test.

Without a config file there is one lane, `default`, at the root with `src/`.

### 3. Run

The one-command form records, reports and ingests:

```sh
npx tracegate run --lane api -- --maxWorkers=2     # args after -- go to `vitest run`
```

It does, in order: pick the mode (`TRACEGATE` / `TRACEGATE_<LANE>`, default `auto`) →
`select` → `vitest run` with the recorder, the selection (under enforce) and a JSON
reporter → `report` → re-run each MISS alone (a pass is triaged `flake`) → `ingest`
(only if HEAD did not move) → record a complete full run if the whole lane ran green.
The exit code is Vitest's. If selection fails, the lane runs whole and records nothing.

The same as three steps, for a CI script of your own:

```sh
RUN=$(mktemp -d)
npx tracegate select --lane api --run "$RUN"                 # writes $RUN/selected.txt, predict.json
HEAD0=$(git rev-parse HEAD)
( cd packages/api && TRACEGATE_RECORD="$RUN" TRACEGATE_LANE=api npx vitest run \
    --reporter=default --reporter=json --outputFile.json="$RUN/results.json" \
    $( [ "$(npx tracegate mode --lane api)" = enforce ] && cat "$RUN/selected.txt" ) )
npx tracegate report --lane api --run "$RUN"                 # logs misses to the ledger
npx tracegate ingest --lane api --run "$RUN" --expect-head "$HEAD0"
```

(Under enforce with an empty `selected.txt`, skip Vitest: it would otherwise run everything.)

### Other commands

```sh
npx tracegate status                                         # ledger, entry bar and mode per lane
npx tracegate mode --lane api                                # off | shadow | enforce
npx tracegate triage --lane api --file packages/api/test/x.test.ts --verdict flake|hole [--head <sha12>]
npx tracegate replay --lane api --head <commit> --at <iso time> [--drop <regex>] [--ignore-lock] [--out r.json]
npx tracegate full-done --lane api                           # record a complete, green whole-lane run
npx tracegate sync --remote user@host:/abs/path/.git/tracegate
```

- **triage**: `hole` = a real footprint gap (fix the recorder); `flake` = the test fails on
  its own. Only `flake` lifts the suspension. Passing when re-run alone is not proof of a
  flake: read the failure. A wrong argument whose assertion depends on timing passes alone.
- **replay** re-decides a past run offline, as of its clock and with only the footprints
  recorded before it, optionally with causes removed. It answers "what would this run have
  executed if this change had not been in it?". It is read-only on the ledger.

### The ledger

`$(git rev-parse --git-common-dir)/tracegate/`, shared by every worktree of the clone:
`fp/` and `blobs/` are a cache (deleting them is always safe and only costs predictions);
`shadow-*.tsv`, `misses-*.tsv`, `triage-*.tsv`, `reasons-*.tsv`, `full-*.tsv` are
append-only evidence, one file per host. **Never delete the logs**: the entry bar reads them.

## Broker

When several things share one machine (gates, a background daemon, measurements, deploy
builds, and AI coding agents each running tests), let one process hand out capacity:

```sh
# A gate: 4 of the machine's tokens, about 15 minutes.
tracegate lease --class gate --tokens 4 --est 900 --label "gate api" -- npm run ci

# A measurement that needs the machine to itself. It reserves the next window and
# starts by itself; nobody has to say "go".
tracegate lease --class measure --exclusive -- ./bench.sh

# Background work that yields when anything important needs the room (exits 75).
tracegate lease --class daemon --tokens 2 --requeue -- tracegate run --lane api

tracegate queue          # who holds what, who waits, and the reservation
tracegate explain j42    # why j42 waits, and when it is reserved to start
```

- **The first `lease` starts the broker** in the background. It stops after 30 idle
  minutes.
- **What the command gets:** `TRACEGATE_TOKENS` and `VITEST_MAX_WORKERS`, set to its
  grant, and `TRACEGATE_CONTENDED=1` when it was started on a busy machine.
  `tracegate run` sizes Vitest to the grant.
- **Nested leases run inside their parent.** A lease taken inside another lease runs at
  once within the parent's tokens, so a job can never queue behind itself.
- **Liveness is the connection.** A lease ends when its holder's process ends, SIGKILL
  included, so there are no stale locks to clean up.

| Class | Priority | Preemptible |
|---|---|---|
| `deploy` | 70 | no |
| `gate`, `train`, `measure` | 50 | no |
| `adhoc` | 30 | no |
| `daemon` | 10 | yes |

Configure in `tracegate.config.json`:

```json
{ "broker": { "capacity": 8, "idleMinutes": 30,
              "classes": { "adhoc": { "priority": 35 } },
              "advisor": { "command": "node ./advisor.mjs", "mode": "shadow" } } }
```

### Adaptive capacity

The broker sizes work to the machine as it is now, not as it was configured:

```sh
# Ask for up to 8 workers and accept as few as 2. On a busy machine it starts narrower
# instead of waiting; on a quiet one it gets all 8.
tracegate lease --class gate --tokens 8 --min-tokens 2 -- tracegate run --lane api

tracegate machine        # hardware, the latest reading, the budgets and why
```

- **Two budgets, every 5 s.**
  - **cpu:** the configured capacity minus busy cores that are not ours. A thermal limit
    scales it, and memory pressure caps it.
  - **memory:** available memory minus a headroom, minus growth our running jobs have
    reserved but not yet used.
- **A budget goes down at once and comes back up slowly** (30 s hold, one token per
  step), because contention makes reds that look like bugs.
- **Memory per job is learned** from the measured peak of each job's process tree.
  `--mem-per-token MB` declares it up front.
- **Under memory pressure, preemptible work (the daemon) is shed.** A gate is never
  stopped for load.
- **A job held back only by someone else's load** runs anyway after 5 minutes, flagged
  `TRACEGATE_CONTENDED=1` ("a red here is not evidence").
- **Different machines:**
  - The defaults derive from each host's cores and RAM, and a container's CPU quota and
    memory limit count.
  - The broker's state is kept per host.
  - Override one machine with `"hosts"`.
  - Try a policy first with `"mode": "shadow"`: it logs what it would do and changes
    nothing.

```json
{ "broker": { "capacity": "75%",
              "adaptive": { "mode": "on", "upHoldS": 30, "starvationS": 300 },
              "hosts": { "ci-runner-1": { "capacity": 32, "adaptive": { "headroomMB": 4096 } } } } }
```

Details and the per-platform signals: [docs/design/broker.md §9](docs/design/broker.md#9-adaptive-capacity-phase-06).

### For AI agents (MCP)

`tracegate mcp` is a Model Context Protocol server over stdio.

- **Read-only tools:** `queue_status`, `explain_job`, `history`, `machine_load` and `lane_mode`.
- **With `--allow-write`:** `cancel_queued` (queued jobs only).

Register it with Claude Code:

```sh
claude mcp add tracegate -- npx tracegate mcp
```

An agent checks `queue_status` before heavy work, and runs the work with
`tracegate lease … -- <command>` in its shell.

### Advisor hook (models in the loop, behind guardrails)

`broker.advisor.command` receives `{tier, jobs: [{id, class, label, est}]}` on stdin. It
may answer `{order: [ids…], reasons}` to reorder jobs that wait in **the same priority
tier**.

- Anything that is not an exact permutation of that tier is rejected and logged.
- Answers are stored by input hash.
- **The default mode is `shadow`:** the advice is logged as an event and not applied.
- A timeout (10 s) or invalid output leaves FIFO order.

The advisor can never grant, preempt, add or remove a job.

## How a decision is made

A footprint recorded at commit C is valid on tree H only if: same footprint format, same
Node version, same lockfile, younger than 72 h, C still exists, and no change between C and
H touches a global input, the test file, a non-source module it loaded, an executed
function, a constant its code names, a top-level statement of a module it loaded, a
module that could not be mapped, or a path it read or listed.

Changes are attributed **per character** to their owner: the innermost function, or the
kind of top-level statement (import/type → ignored; plain-data `const X` → a constant;
anything else → top level). Anonymous callbacks are keyed by callee and first string
argument, so one route handler is one key.

**What a footprint does not see**: environment variables, the wall clock (hence the 72 h
limit), the network and other processes. The random audit and the periodic full run are
the backstops. A miss from any of them suspends the lane.

**If the recorder's Vitest seam moves** (a Vitest upgrade), modules come back *unmapped*.
Any change to an unmapped module means "run", so predictions stay safe but get coarse;
`ingest` prints the unmapped share and warns above 5%.

## Testing

```sh
npm install                 # typescript, for parsing
npm test                    # the self-test (77 checks), the broker (50) and adaptive capacity (74)
node test/sabotage.mjs      # breaks each rule in a temp copy; each must turn the self-test red
bash examples/e2e.sh        # end-to-end on examples/sample-repo (needs network for npm install)
```

The self-test asserts both directions on purpose: a predictor that always says "run" fails
the SKIP rows and one that always says "skip" fails the RUN rows.

`examples/e2e.sh` copies `examples/sample-repo` (two source modules, five Vitest files) to
a temp dir, installs it, runs the whole lane recorded in shadow, then asserts these
selections under enforce, each from the recorded commit:

| Change | Selected |
|---|---|
| `multiply()` body | `multiply.test.ts` |
| `whisper()` body (no test runs it) | nothing |
| `add()` body | `add.test.ts`, `report.test.ts` (`formatTotal` calls `add`) |
| `data/rates.json` (read at run time by one test) | `rates.test.ts` |

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
