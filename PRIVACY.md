# Privacy

Tracegate CI runs on your machine. It has no service, collects no telemetry and sends
nothing anywhere by default. This covers the npm package and the Claude Code plugin.

## What it reads

- Your repository and its git history.
- The test coverage your test runner reports while Tracegate records a run.
- This machine's load and memory figures (`ps`, `vm_stat`, `sysctl` and `pmset` on macOS;
  `/proc` on Linux), to size test runs.

## What it writes

- Its ledger, in your repository's git directory (`.git/tracegate/`): test footprints and
  logs of test results.
- Temporary files, and the broker's socket, in your operating system's temp directory.
- Git notes under `refs/notes/tracegate`, when you run `tracegate attest`.
- The files `tracegate init --write` lists before it writes them.

Nothing is pushed or uploaded.

## What it sends

Nothing, unless you turn on one of these, and each uses your own login:

- **`tracegate attest --status`** posts a commit status to GitHub through the `gh` CLI.
- **The release bus** (`"bus"` in `tracegate.config.json`) reads and writes a Google Cloud
  Storage bucket you name, through the `gcloud` CLI.
- **`tracegate sync --remote`** copies the ledger to a machine or bucket you name.

## Personal data

Tracegate doesn't collect personal data. Its ledger holds file paths, commit IDs, test
names and timings from your repository. A release-bus note you write is stored in your own
bucket; Tracegate refuses to send one that looks like it contains a credential.

## Questions

Open an issue at https://github.com/davidscotttufts/tracegate-ci/issues.
