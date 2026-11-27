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
| [Roles](#roles) | Which machine deploys, as a cross-machine lease with fencing. Any machine can take over at any time. |
| [Attestation](docs/guide.md#attestation) | A signed record of what ran on a commit's exact tree. |

## Roles

A role answers "which machine does this?", usually "which machine deploys". It is a lease
that every machine can see, kept in a shared store, and any machine can take it over at
any time. The design is in [docs/design/roles.md](docs/design/roles.md).

```json
{ "roles": { "store": "gs://my-bucket/tracegate",
             "deployer": { "preflight": "bash examples/preflight-signins.sh", "ttl": "30m" } } }
```

The store is `gs://bucket/prefix` (through `gcloud`), `git+<remote>#refs/tracegate/roles`
(one ref per role on any git remote, no cloud account needed), or `file:///dir` (a shared
disk). `TRACEGATE_ROLES_STORE` overrides the config.

```sh
tracegate role status deployer
tracegate role claim deployer --ttl 30m        # if it is free or expired; --hold keeps renewing
tracegate role renew deployer                  # the heartbeat
tracegate role handover deployer --to mac-b    # an offer: mac-b accepts by running `claim`
tracegate role take deployer --reason "mac-a's sign-in expired"   # at any time, even from a live holder
tracegate role release deployer
tracegate lease --class deploy --role deployer -- ./deploy.sh      # only on the holder
tracegate role check deployer --epoch "$TRACEGATE_ROLE_EPOCH"      # right before the traffic shift
```

- **Fencing.** Every change of holder raises the role's epoch by one. `lease --role` runs
  its command only on the holder and passes the epoch in `TRACEGATE_ROLE_EPOCH`, and it
  renews the role while the command runs. `role check --epoch N` exits 0 only while N is
  still current, this machine holds it, and the lease hasn't expired.
- **A takeover never kills a deploy.** If another machine takes the role mid-deploy, the
  old holder's deploy keeps running, because stopping a deploy half way is worse. It can't
  start another, and its next `role check` fails, so it stops before its irreversible step.
  Call `role check` right before that step.
- **Races.** Every change is a compare-and-swap on the store. When two machines claim at
  once, exactly one wins, and the other exits 3.
- **Preflight.** `claim` and `take` run the role's `preflight` on the machine that wants
  the role (it also runs when a handover is accepted), and refuse the role if it fails
  (exit 5). `take --skip-preflight` exists for emergencies. It prints a loud warning and
  is recorded in the audit trail.
- **Per-repo roles.** `deployer` is global, and `deployer:<repo>` is one repo's. In a
  repo, `deployer` means `deployer:<repo>` if the config declares it or the store has a
  record of it. Otherwise it means the global role. `<repo>` is `roles.repo`, or else the
  clone's directory name.
- **Audit.** Each role keeps its last 200 changes: action, epoch, host, user, time, reason,
  previous holder, and the preflight result. `role status` shows the latest.
- **Exit codes:** 0 ok, 2 usage, 3 held by another machine (or lost a race), 4 fenced (not
  the holder, a stale epoch, or expired), 5 preflight failed, 6 store unreachable.
- **Holding a role is never an approval.** It decides which machine deploys, never whether
  something may be deployed. Approvals stay with the people and scripts that give them.

## Unattended deploy machines: sign-ins

On 2026-11-27, a deploy machine whose sign-in had expired blocked two deploys for hours.
Personal sign-ins expire; a deploy machine has to notice that before it becomes the
deployer, not halfway through a deploy.

**Check them in the preflight.**
[`examples/preflight-signins.sh`](examples/preflight-signins.sh) checks Google Cloud
(`gcloud auth print-access-token`), Firebase (`firebase projects:list`) and GitHub
(`gh auth status`). If any check fails, it exits non-zero, names the sign-in that failed,
and prints the command that renews it. `SIGNINS="gcloud gh"` limits which ones it checks,
and `SIGNINS_ADC=1` also checks application-default credentials. It never prints a token
or a key; it reads only account names. Use it as the role's `preflight`, and a machine
with an expired sign-in can't claim the role.

**Renewing without a browser on the deploy machine.** Reach the machine over SSH (Tailscale
is the usual route), and run:

| Sign-in | Command on the deploy machine | Then |
|---|---|---|
| Google Cloud | `gcloud auth login <account> --no-browser` | It prints a `gcloud auth login --remote-bootstrap=…` command. Run that on a machine with a browser, sign in, and paste its output back. For application-default credentials, run `gcloud auth application-default login --no-browser` the same way. |
| Firebase | `firebase login --reauth --no-localhost` | Open the printed link on any machine, sign in, and paste the code back. |
| GitHub | `gh auth login` | Choose the web browser option, and enter the device code at https://github.com/login/device from any machine. |

**Better: a service account per app project.** For each project the machine deploys:
- Create a service account with only the roles that deploy needs.
- Save its key on the deploy machine with mode 600 (`chmod 600 key.json`), outside any
  repository.
- Point the deploy at it with `GOOGLE_APPLICATION_CREDENTIALS`. When that file is
  readable, the preflight passes the Google and Firebase checks from it and says so.

A key doesn't expire with a person's session, and it can do only what that deploy needs.

- **Rotate** a key by creating a new one
  (`gcloud iam service-accounts keys create new.json --iam-account <sa>`), switching
  `GOOGLE_APPLICATION_CREDENTIALS` to it, checking a deploy, and then deleting the old one
  (`gcloud iam service-accounts keys delete <key-id> --iam-account <sa>`). Rotating on a
  schedule, for example every 90 days, keeps any copy you missed short-lived.
- **Revoke** at once when a machine is lost or a key may have leaked: delete the key
  (`keys delete`), or disable the whole account
  (`gcloud iam service-accounts disable <sa>`). Then `role take` the role from another
  machine. The lost machine's next `role check` fails.
- Never commit a key, and never paste one into a note, a log or a chat.

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
