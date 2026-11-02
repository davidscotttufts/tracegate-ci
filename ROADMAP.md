# Roadmap

Updated 2026-11-02, at version 0.10.0. What has shipped is in the [changelog](CHANGELOG.md);
the research behind the design is in [docs/background.md](docs/background.md).

## Where it stands

The core is done and on npm: test selection with shadow mode, an entry bar, audits and
suspension on a miss; Vitest and Jest; the broker; the merge train; the Red Reader,
Conductor and silence guard; the dependency rule; attestation; the daemon; and the release
bus. It runs in the private monorepo it came from, whose numbers are published in
[docs/evidence/](docs/evidence/).

## Before 1.0

- [x] CLI and MCP tools documented.
- [x] Miss rates from a real project published, with every backend miss triaged.
- [ ] At least two other repositories using it.

## Next

1. **Outside users.** Submit the Claude Code plugin to Anthropic's directory, and find two
   repositories willing to run it in shadow and share their report card.
2. **The host project moves onto the package.** It still runs its own copy of the
   predictor. Its ADR 1028 proposes switching lane by lane, after 20 gates where both
   predict side by side.
3. **Tests that read git history.** Triaging the host's backlog (done 2026-11-02: 51 of
   52 misses passed alone at their commit, three times each) found one real hole. A test
   that reads commit subjects through `git log` failed after a new commit, and nothing in
   its footprint had changed. The recorder should note when a test runs `git`, and treat
   history as an input for that test, so a new commit re-runs it.

## Later

- **Partitioned trains.** Gate branches whose tests don't overlap in separate queues. This
  waits until the Conductor has measured how often "independent" branches fail only
  together.
- **Agent-ranked test order** through the broker's advisor hook. The deterministic order
  ships today.
- **Red Reader escalation by default**, once `red score` shows how often people override
  it.
- **`node:test`.** Its loader doesn't go through the `vm` seam the recorder uses.
- **TypeScript 7's own parser**, once its API is stable. Until then Tracegate parses with
  5 or 6.

## Principles

1. A model may add or reorder work. It never turns a red into a green.
2. A model may make a verdict stricter, never more lenient.
3. Every model decision is stored before it's used, so a gate can be replayed.
4. Anything new runs in shadow and is scored before it changes a result.
5. A timeout or a bad answer means "no opinion", and the deterministic rule applies.
6. Diffs and logs are untrusted input. A model gets no tools and no credentials.
7. The audit sample stays uniformly random, so the miss estimate stays honest.
8. If a deterministic rule can answer the question, ship that before asking a model.

## Out of scope

| | Why |
|---|---|
| A model that fixes code during a gate | A gate that edits code isn't a gate. |
| A model that lowers a verdict | It's how other tools ended up silencing real failures. |
| A model choosing the audit sample | It would bias the miss rate. |

## Open questions

- Is it acceptable for a given project to send failure output and diffs to a hosted
  model? Today the Red Reader runs in the agent session already working in the
  repository, so nothing new leaves the machine.
- Does a frontend lane, with DOM timing and i18n, need different Red Reader guidance?
