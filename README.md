# Tracegate CI

Local CI for TypeScript that runs only the tests a change can affect, and has to earn the
right to skip the rest.

Tracegate records what each test file touches when it runs: the functions it executes, the
modules it loads, and the files it reads. When you change code, a test whose recorded
inputs didn't change can reuse its last green result. The rest run.

It doesn't skip anything until that has been shown to be safe:

- **Shadow first.** Every test still runs, and Tracegate logs what it would have skipped.
- **Entry bar.** A lane starts skipping only after 20 runs over 14 days, with no untriaged
  miss in the last 14 days.
- **Random audits.** 5% of the skippable tests run anyway.
- **A miss suspends it.** If a test predicted safe to skip fails anyway, the lane runs
  everything for 14 days, unless someone triages the miss as a flaky test.

It can't turn a red into a green. A failing test's record is dropped, and no record older
than 72 hours is reused.

Tracegate came out of a private TypeScript monorepo with about 3,700 test files, where it
gates every merge. Its measured miss rate there is published in
[docs/evidence/](docs/evidence/).

## Install

```sh
npm install --save-dev tracegate-ci
npx tracegate init --write --mcp   # writes tracegate.config.json and wires the recorder
npx tracegate doctor --canary      # checks the setup by recording one test file
npx tracegate run                  # runs the lane; in shadow, everything still runs
npx tracegate savings              # what skipping would have saved so far
```

To try it for two weeks and share what it measured, see [docs/trial.md](docs/trial.md).

`init` without `--write` only prints what it would do. It never overwrites an existing
config, and it tells you which Vitest configs to edit by hand.

**Requirements:** Node 22+, git, Vitest 4.1–5.x or Jest 30, and TypeScript 5 or 6 in your
repository. On TypeScript 7, also install 6 under an alias Tracegate looks for:
`npm i -D tracegate-typescript@npm:typescript@6`.

## Claude Code plugin

```
/plugin marketplace add davidscotttufts/tracegate-ci
/plugin install tracegate@tracegate
```

The plugin adds an MCP server, two subagents (`red-reader`, `deps-oracle`), two skills,
and a hook. In a Tracegate repository, the hook stops agents from running a bare `vitest`
or `npm test` outside the queue, and from triaging misses or approving skipped tests
themselves. `TRACEGATE_HOOK=off` turns it off.

What the plugin runs and touches (also in [PRIVACY.md](PRIVACY.md)):

- **Runs:** `node` on its own files (the MCP server over stdio, and the hook), `git`, your
  test runner, the commands you give `tracegate lease`, and `ssh-keygen` or `gpg` when you
  run `attest`.
- **Reads:** your repository and its history, test coverage, and this machine's load and
  memory (`ps`, `vm_stat`, `sysctl` and `pmset` on macOS; `/proc` on Linux).
- **Writes:** its ledger in `.git/tracegate/`, temporary files and a socket in the OS temp
  directory, git notes under `refs/notes/tracegate` when you run `attest`, and the files
  `init --write` lists.
- **Sends:** nothing by default: no telemetry and no network calls. Two features you turn
  on yourself use the network through your own login: `attest --status` posts a GitHub
  commit status with `gh`, and the [release bus](docs/guide.md#release-bus) reads and
  writes a GCS bucket you name, with `gcloud`.
- **Installs:** nothing. The package has no runtime dependencies.

## How it decides

A test reuses its last green result when nothing it depends on has changed since. That
means no change to:

- a function it executed, a constant it uses, or a module it loaded;
- a file it read;
- the test file itself;
- a global input, such as `package.json`, a lockfile or the Vitest config;
- the repository's history, for a test that runs `git` on it.

Uncommitted edits count. Edits inside functions the test never ran don't.

What a recording can't see is the clock, environment variables, the network, and other
processes. The 72-hour limit, the random audit, and a full run at least once a day cover
those. The full rules are in [How a decision is made](docs/guide.md#how-a-decision-is-made).

## Commands

| Command | What it does |
|---|---|
| `tracegate run` | Select, run the tests, record, and learn from the result. |
| `tracegate status` | Each lane's mode and progress toward the entry bar. |
| `tracegate savings` | What skipping would have saved so far. |
| `tracegate report-card` | Miss rates with 95% confidence intervals. `--redact` for a private repo. |
| `tracegate triage` | Mark a miss as a flaky test or a recorder bug. |
| `tracegate lease` | Run a command when the machine has room for it. |
| `tracegate train` | Gate a queue of branches and land the green ones. |
| `tracegate daemon` | Run full lanes at night and pre-test queued branches. |
| `tracegate bus` | See what another machine is gating or deploying. |
| `tracegate attest` / `verify` | Sign, and check, what was tested on a commit. |
| `tracegate mcp` | The MCP server for agents. |

`tracegate --help` lists every command and flag.

## Configuration

`tracegate init --write` creates `tracegate.config.json`. A lane is one test project:

```json
{
  "lanes": {
    "api": { "dir": "packages/api", "src": "src", "globals": ["test/setup/"] },
    "web": { "dir": "packages/web", "src": "src" }
  }
}
```

List your test setup directory under `globals`: every test loads it, so a change there
runs the whole lane. All settings are in the [guide](docs/guide.md#configuration).

## What else is in the box

| Feature | What it's for |
|---|---|
| [Broker](docs/guide.md#broker) | One queue for the machine. Gates, background jobs and every agent's test runs share the CPU and memory instead of fighting over them. |
| [Merge train](docs/guide.md#merge-train) | Gates a batch of branches as their real merge commit, bisects a red batch, and lands only exactly what passed. |
| [Red Reader](docs/guide.md#red-reader) | An agent reads each failed run and can mark a "flaky" failure as a real bug. It can never do the reverse. |
| [Silence guard](docs/guide.md#silence-guard) | Fails a change that skips, focuses or deletes tests, until a person approves it. |
| [Conductor](docs/guide.md#conductor) | Runs the tests most likely to fail first, and advises which branches to gate alone. |
| [Dependency changes](docs/guide.md#dependency-changes) | A lockfile change re-runs only the tests that loaded a changed package. |
| [Keyed inputs](docs/guide.md#keyed-inputs) | An edit to one string in a translation file re-runs only the tests that used it. |
| [Daemon](docs/guide.md#daemon) | Uses idle hours for full runs and for pre-testing queued branches. |
| [Release bus](docs/guide.md#release-bus) | Lets two machines see each other's trains and deploys. |
| [Attestation](docs/guide.md#attestation) | A signed record of what ran on a commit's exact tree. |

**Why not Vitest's `recordDependencies`?** [The comparison](docs/compare/vitest-record-dependencies.md)
runs both on the same commits. Tracegate selects per function, sees files read at run
time, and audits its own skips.

## More

- [Guide](docs/guide.md): the full reference.
- [Roadmap](ROADMAP.md) and [changelog](CHANGELOG.md).
- [Background](docs/background.md): the research and measurements behind the design.
- [Recipes](docs/recipes/): with claude-code-merge-queue, edit-level guards, worktrees, and
  a `bin/ci` script.

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
