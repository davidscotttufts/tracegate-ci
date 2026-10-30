---
name: tracegate-gate
description: How to run tests in a repository that uses Tracegate CI (it has a tracegate.config.json). Use whenever you are about to run the test suite, check whether a change is green, or read why a run went red.
---

# Running tests under Tracegate

This repository gates changes with Tracegate. It runs only the test files your change can
affect, but only once that has been proven safe for the lane, and it queues every agent's
test runs on this machine so they do not starve each other.

## Run tests

- `npx tracegate run -- <vitest args>` is the normal way. It selects what must run, runs
  it with the recorder, checks the prediction, and records what it learned. The exit code
  is Vitest's.
- To run a test command exactly as written, put it in the queue:
  `npx tracegate lease --class adhoc --tokens 2 -- <command>`.
- Don't start `vitest` or `npm test` outside a lease. A hook blocks it here, and on a busy
  machine it slows everyone's runs and causes false reds.
- `npx tracegate queue` (or the `queue_status` MCP tool) shows what is running. Check it
  before starting something large.

## Read the result

- `npx tracegate status` shows each lane's mode:
  - `shadow`: everything runs and Tracegate only logs what it could have skipped;
  - `enforce`: it skips proven-unaffected files and re-runs a random audit share of them.
- A **MISS** is a file Tracegate predicted safe to skip that then failed. Report it. Don't
  dismiss it.
- A red run leaves a packet: `npx tracegate red list` and `red show <id>`, or the
  `red_runs` / `read_red` MCP tools.

## What you must not do

- Don't turn a red into a green by editing tests. That includes adding `.skip`, `.only` or
  `.todo`, deleting a test, loosening an assertion, or raising a timeout. Fix the code,
  or report that you could not.
- Don't triage a failure as `flake` yourself. Only a person records triage
  (`tracegate triage`). Passing when re-run alone is not proof of a flake.
- If you have read the code and believe a red is real, say so. The `red-reader` subagent
  records an escalate-only opinion that can make the gate stricter, never more lenient.
