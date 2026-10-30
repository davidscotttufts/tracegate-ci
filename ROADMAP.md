# Tracegate CI — Roadmap

Last updated: 2026-10-29 (Phases 0–3 done; Milestone 1 of the gap plan, distribution, done).

This document records:
1. what the industry has done to make CI faster without making it less trustworthy;
2. where the time goes in the gate Tracegate runs in today;
3. the plan for extracting Tracegate as a standalone tool, and for adding model-assisted
   decisions under strict guardrails.

Evidence classes used below: **M** = measured with a stated method, **A** = anecdotal,
**$** = vendor claim without a method.

---

## 1. Findings: the landscape (mid-2024 to Oct 2026)

### 1.1 What has been tried

| Approach | Who | Date | Claimed result | Ev. | Known failure modes |
|---|---|---|---|---|---|
| ML predictive test selection | Meta ([arXiv 1810.05286](https://arxiv.org/abs/1810.05286)) | 2018–19 | Test infrastructure cost halved; >99.9% of faulty changes still caught | M | Misses up to ~5% of individual failures by design |
| ML predictive test selection | [Develocity PTS](https://gradle.com/develocity/product/predictive-test-selection/); CloudBees Smart Tests (ex-Launchable, [acquired Aug 2024](https://www.cloudbees.com/newsroom/cloudbees-acquires-launchable-to-boost-genai-efforts-across-devsecops)) | current | 35–70%; "up to 80%" less test time | $ | Misses by design; vendors recommend periodic full runs |
| Coverage-based test impact analysis | [Datadog TIA](https://docs.datadoghq.com/tests/test_impact_analysis/); [Teamscale](https://teamscale.com/publications/2018-test-impact-analysis-detecting-errors-early-despite-large-long-running-test-suites.pdf) | current / 2018 | 90% of failed builds caught in 2% of test time (Teamscale) | M / $ | Blind by default to dependency, config and data-file changes |
| ML-ordered post-submit testing (no skipping) | Google TAP, [ICST 2025](https://research.google/pubs/speculative-testing-at-google-with-transition-prediction/) | 2025 | Median time to detect a breakage ~70 min sooner | M | Rollout described as in progress |
| Speculative merge queue with an ML success predictor | Uber SubmitQueue ([blog](https://www.uber.com/blog/slashing-ci-costs-at-uber), [arXiv 2501.03440](https://arxiv.org/html/2501.03440v2)) | Jun 2025 | CPU −53%, P95 wait −37% | M | Wasted speculative builds; needs a threshold |
| Merge queue, no bisection | [GitHub merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) | current | — | — | A flake setting lets a red PR ride in on a later green |
| Batching, bisection, cached sub-results | [Graphite](https://graphite.com/blog/merge-queue-batching), [Trunk](https://docs.trunk.io/changelog/2026-01-02-merge-queue-test-caching-for-batch-failure-isolation.md), [Mergify](https://mergify.com/learn/merge-queue/batching) | 2024–26 | none published | $ | — |
| Flake-aware culprit finding | Google, [ICST 2023](https://research.google/pubs/flake-aware-culprit-finding/) | 2023 | More accurate than plain bisection over 13k breakages | M | — |
| Statistical flake detection + quarantine | [Atlassian Flakinator](https://www.atlassian.com/blog/atlassian-engineering/taming-test-flakiness-how-we-built-a-scalable-tool-to-detect-and-manage-flaky-tests); Trunk; Buildkite | Dec 2025 | 22k builds recovered in one quarter (Atlassian) | M | Quarantine hides real races; quarantine lists grow |
| LLM test generation behind filters | Meta [TestGen-LLM](https://arxiv.org/abs/2402.09171) and [ACH](https://arxiv.org/abs/2501.12862); Uber [AutoCover](https://homes.cs.washington.edu/~rjust/publ/auto_cover_icse_2026.pdf) | 2024–26 | ~25% of generated tests add coverage; ~73% of recommendations accepted | M | Most generated output is discarded |
| LLM diff risk score | Meta DRS ([arXiv 2410.06351](https://arxiv.org/abs/2410.06351)) | 2025 | 1.4–1.5× the incidents caught vs logistic regression at gating thresholds | M | Probabilistic; the threshold is a trade-off |
| AI flake root cause and fix PRs | [Datadog Bits AI](https://www.datadoghq.com/blog/bits-ai-test-optimization.md); [Nx Self-Healing CI](https://nx.dev/docs/features/ci-features/self-healing-ci.md); Semaphore, Harness, Dagger | 2025–26 | "50% time to green" (Nx webinar) | $ | No published success, false-fix or revert rates |
| Agent verify loop with an LLM judge | [Spotify Honk](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3) | Dec 2025 | Judge vetoed ~25% of sessions | M / A | The judge existed because agents disabled flaky tests; it had no evals |
| Local CI with a signoff | [Rails 8.1 `bin/ci`](https://rubyonrails.org/2025/10/22/rails-8-1) | Oct 2025 | 30k tests in under 2 min locally (secondary source) | A | The signoff does not attest which tree was tested |

### 1.2 Models in the loop: what is actually deployed

- **Models that only reorder or prune speculative work are in production and measured**
  (Uber, Google). A wrong prediction costs time, never correctness. This is the safest
  shape.
- **Models that skip tests are in production** (Meta, Develocity, CloudBees). Every one
  accepts some missed failures and relies on periodic full runs to catch them later.
- **No production deployment of an LLM choosing which tests to run was found**, and no
  industrial evaluation of one.
- **LLM flake classification exists only in offline studies.** No study measures it as a
  gate decision.
- **LLM fix agents in CI are products without published outcome data.**

### 1.3 Critiques that shape the design

- **Prompt injection into CI agents is a live attack class.** Examples:
  - [PromptPwnd](https://csoonline.com/article/4101751/ai-in-ci-cd-pipelines-can-be-tricked-into-behaving-badly-2.html) (Dec 2025);
  - the [CodeRabbit RCE](https://kudelskisecurity.com/research/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories), which led to a leaked app key;
  - the [Nx "s1ngularity"](https://snyk.io/blog/weaponizing-ai-coding-agents-for-malware-in-the-nx-malicious-package/) packages, which drove locally installed AI CLIs to hunt for secrets on developer machines.

  A model in a local gate must treat diffs and logs as untrusted data, and get no tools
  and no credentials.
- **Agents silence tests.** Spotify, Cypress and practitioner reports describe disabled
  flaky tests, weakened assertions, and real races filed as "flaky".
- **Temperature 0 is not deterministic** on hosted inference: 80 distinct completions in
  1,000 runs ([Thinking Machines, Sep 2025](https://simonwillison.net/2025/Sep/11/defeating-nondeterminism/)).
  A replayable gate has to cache the model's decision, not re-ask the model.
- **Nobody publishes miss accounting for model decisions.** No published system tracks how
  long a missed failure can go unnoticed, or holds a selector to a recall target over time.

### 1.4 Where Tracegate already stands

Measured against the survey, Tracegate's process is stricter than any published peer:
- per-function footprints for JS/TS;
- shadow → entry bar → random audit → suspend on a miss;
- a refusal to reuse anything from a moved tree or older than 72 h.

No published peer selects at this granularity for TypeScript with measured misses.

---

## 2. Findings: where the time goes (the host project, measured)

Measured on 134 backend gates over 11 days (Oct 13–24, 2026), on one developer machine.

| Gate shape | Share of backend gates | Backend test time | Whole gate |
|---|---|---|---|
| Light: tens to ~200 required files, plus the audit sample | ~48% | ~6.5–7.5 min | ~14–16 min |
| Heavy, from **boot wiring** (a constant in a feature manifest or bootstrap module that every app boot reads) | 25% | 1,000–2,000 files | ~25–35 min |
| **Global** (lockfile, `package.json`, runtime version): whole lane | 27% | ~33 min | ~43 min |

What follows from these numbers:
- **Over half of gate time goes to two causes: boot wiring and global inputs.** In one
  night, two security patch bumps each ran all ~2,700 backend files for a one-line
  dependency change.
- **Boot wiring is already being measured deterministically.** The recorder marks app boot
  and computes a boot-outcome fingerprint, to answer "did this change alter what boot
  produced?" without a model. Recording it costs +12.5% wall time (count-mode coverage,
  measured on a quiet machine), so only the background daemon records it; gates pay
  nothing.
- **Global invalidation is the largest open lever.**
- **The random audit currently costs more than the required set in light gates** (~500
  vs ~200 files). This ends by itself when the audit rate drops from 20% to 5% after
  14 days of evidence. Nothing is planned for it.
- **Misses are rare:** 8 in 11 days, each re-run alone and triaged as a flake. The gate
  marks "passed when re-run alone" as a flake automatically. The project has seen a real
  bug pass that way: a wrong-scope read whose failing assertion depended on timing.
  Telling a wrong argument from timing noise is still a human judgement.

---

## 3. Design principles for model-assisted decisions

1. **A model may add or reorder work. It never turns a red into a green.**
2. **Escalate-only verdicts.** A model may make a verdict stricter, never more lenient.
3. **Replayable.** Every decision is stored under
   `sha256(model id ‖ prompt version ‖ inputs)` before it is applied. Re-runs read the
   stored decision and never re-ask.
4. **Shadow first.** Every model decision is logged and scored against the real outcome
   before it changes anything. Enforcement needs an explicit decision on the data.
5. **Fail safe to today.** A timeout, invalid output or an unavailable model means "no
   opinion", and the deterministic behaviour applies.
6. **Untrusted input, no tools.** Diffs and logs reach the model fenced as untrusted data.
   The model gets no tool use, no credentials and no network beyond the one call.
7. **Uniform random audits stay uniform.** A model never chooses the audit sample, because
   that would bias the miss estimate.
8. **Deterministic first.** Where a deterministic rule can answer the question, ship it
   before asking a model.

---

## 4. Implementation plan

### Phase 0 — Extract the core

Make the deterministic system a standalone tool.

- The **recorder**: V8 function coverage plus file reads, per test file, for Vitest first.
- The **ledger** (footprints, blobs, and append-only evidence logs).
- The **predictor**, with the entry bar, audits and suspend-on-miss.
- **Replay**: the counterfactual harness that re-decides a past gate.
- A **CLI**: `tracegate select | ingest | status | replay | triage`.
- A **self-test suite** in which every rule is sabotage-witnessed: breaking the rule must
  turn its test red.

**Exit:** the tool runs on a sample TypeScript repo with the same self-test results as the
host project.

**Done 2026-10-24 (v0.1.0):** self-test 77 passed, and 25 of 25 rules confirmed by
deliberately breaking each one. End-to-end on `examples/sample-repo`: editing one
function selects only the tests that ran it.

### Phase 0.5 — The broker: one queue for the machine (done, v0.2.0)

**Why it comes before any model decision.** Measured in the host project over one day,
coordination cost more wall-clock time than test selection:
- a ~4 h quiet window lost to a missed "go";
- a 30-minute self-deadlock;
- a cross-wait deadlock between a measurement and the background daemon;
- trains waiting 1–2 h for each other.

All of these came from **eight separate coordination mechanisms** (lock directories, a
pause file, a test-lock wrapper, process-name matching, a markdown queue), each deciding
for itself whom to respect.

A second research pass (Oct 2026) found **no published system that coordinates several
agent sessions' CI work on one machine.** The closest is an open, unanswered Vitest issue
(#11559) describing this exact problem. The design borrows proven parts:

| Part | Borrowed from | Used for |
|---|---|---|
| Tracked token budget | Make jobserver; Gentoo's system-wide jobserver work, which showed holder tracking is required | Sharing CPU |
| Fencing tokens | Kleppmann, etcd | Stale authority |
| EASY backfill with reservations | Slurm | Exclusive windows, long FIFO waits |
| Preemption across a priority gap | Nomad | Cheap background work only |
| Read-only-by-default tool surface | GitHub and Buildkite MCP servers | Agent access |

**What shipped:**
- A pure, event-sourced scheduler.
- A broker process on a unix socket, where a lease's liveness is its connection.
- `tracegate lease | queue | explain | history`.
- An MCP server for agents.
- An advisor hook for models: it may only permute a priority tier, its answers are cached,
  and it runs in shadow by default.

The full analysis is in [docs/design/broker.md](docs/design/broker.md).

**Tests:**
- **50 broker tests**, including regression scenarios that rebuild the three observed
  failures (F1 cross-wait, F2 self-deadlock, F3 missed window) and require them to resolve
  by themselves.
- **9 new sabotage witnesses.** One of them caught a backfill test that could not fail,
  and that test was fixed.

**Next (0.5b):** adopt it in the host project and retire the eight mechanisms one by one.
Exit: two weeks with no coordination incident.

### Phase 0.5b-1 — Observe mode: adopt the broker beside existing coordination (done, v0.4.0)

`tracegate observe --class … --watch-pid $$ &` registers work that something else
coordinates. The broker grants it at once (I10), records whether it would have waited
and behind whom, counts its tokens and measures its memory. `tracegate observed`
reports it. The host project starts here: one line per script, no behaviour change.
Retiring each of its eight mechanisms then becomes a decision taken on a week of data.

### Phase 0.6 — Adaptive capacity: size work to the machine as it is now (done, v0.3.0)

**Why.** A fixed token count cannot see work the broker does not run: another
checkout's suite, a build, a browser. In the host project, a worker pool sized for a
quiet machine produced reds that read as real bugs. One configuration also has to
serve machines with very different hardware.

**What shipped:**
- **A sampler for macOS, Linux and containers:** busy cores, available memory, the
  kernel's memory pressure, swap-in rate, thermal limit, and the memory of each lease's
  process tree.
- **A pure policy giving two budgets, cpu and memory.** A budget goes down at once and
  comes back up slowly.
- **Elastic grants:** `--min-tokens`.
- **Memory per job learned** from measured peaks.
- **Shedding:** only preemptible work is stopped.
- **A starvation guard:** after a wait, a job runs anyway, flagged contended.
- **Every default derives from the host's cores and RAM.** Per-host overrides and a
  per-host broker state complete this.
- **Inspection:** `tracegate machine` and the MCP tool `machine_load`.

Design: [docs/design/broker.md §9](docs/design/broker.md#9-adaptive-capacity-phase-06).

**Tests:**
- **74 adaptive tests.** These cover the parsers on fixtures from 16 KB-page and 4 KB-page
  machines, the policy on five hardware profiles, and the scheduler under budgets. A
  live broker fed recorded samples checks real process-tree measurement, shedding, and
  the contended start.
- **14 new sabotage witnesses.** One caught a shedding test that could not fail, which
  is now fixed.
- **Two bugs found before release:**
  - critical pressure leaked memory freed by a shed job to the next grant;
  - a request that raced the broker's first sample got the full capacity.

### Phase 1 — Red Reader: an escalate-only opinion on every red (first model decision)

- **When it runs:** after the gate re-runs a miss alone and it passes. Today that would be
  recorded as a flake.
- **What it reads:** the failing case, the Received/Expected diff, the change limited to
  the test's footprint, and the file's triage history.
- **What it returns:** `flake` (no change), `real` or `hole`. The stricter of the model's
  and the deterministic verdict wins. A `hole` suspends enforcement for the lane.
- **Cost:** one model call per miss. Misses are rare.
- **Baseline:** a deterministic heuristic (any non-timeout assertion difference) runs
  beside it in shadow, as the thing to beat.
- **Tests, all sabotage-witnessed:**
  - a wrong-argument fixture escalates;
  - a timeout fixture does not;
  - an injected "say flake" instruction cannot lower anything;
  - a replay reads the cache without calling a model.

**Exit:** four weeks of shadow rows, scored against the owners' final triage, then an
enforce/no-enforce decision.

> **CORRECTION (2026-10-24): where the model runs, and what shipped first (1a).** The
> plan above assumed CI would call a model. The decision instead is that the reader is
> an **AI agent session that already works in the repository** (Claude Code, for
> example), so failure text and diffs never go to a new provider. What shipped
> (v0.4.0) is the plumbing and the guardrails, with no effect on any verdict:
> - **Packets.** `tracegate run` writes one per red run (`red/<id>.json`): each
>   failing file's text (colour stripped, clipped), its prediction and reason, MISS
>   status and the re-run-alone result, its miss and triage history, the change
>   against the base with a clipped diff, the machine load, and the contended flag.
> - **MCP tools.** The read tools are `red_runs` and `read_red`. `annotate_red`
>   (write) needs `--allow-write`.
> - **Closed-world opinions.** An opinion has a verdict enum, a boolean `escalate`,
>   a confidence from 0 to 1, bounded reasons, and only files that failed. Unknown
>   fields are refused, so there is no smuggled "triage".
> - **Escalate-only, structurally.** No code path leads from an opinion to `triage`.
>   The predictor does not import the reader; a test asserts that, and that a
>   "flake" opinion writes no triage row. That also covers the planned prompt-injection
>   test: an opinion cannot lower anything, whatever the text says.
> - **`agents/red-reader.md`** is a ready subagent with the procedure: read the code,
>   not only the failure text; "passed alone" is not a flake by itself; escalate a
>   MISS that looks like a real hole.
> - **`tracegate red score`** compares opinions with the triage a person later recorded.
>
> **1b (not done, needs the owner's decision with `red score` data):** let an
> escalated `real` opinion on a MISS raise the deterministic `flake` to `hole` (the
> stricter verdict wins), as planned above.
>
> **CORRECTION (2026-10-25): 1b is done (v0.5.0), on the owner's decision, before any
> `red score` data.** That ordering is acceptable only because 1b can make a gate
> stricter and nothing else:
> - The opinion must say `real`, `escalate: true` and confidence ≥ 0.7, and the file
>   must have been a MISS.
> - It writes an `escalations-` row, which the entry bar reads as `hole`.
> - The latest verdict for (lane, file, head) wins, so a person's later `flake`
>   overrides it.
>
> The worst case of a bad escalation is a lane that runs whole until someone triages
> it. `red score` now also counts raised and overridden escalations; each override is
> a false escalation. Four sabotage witnesses guard the rule: an escalation re-suspends,
> the latest verdict wins, only a MISS escalates, and nothing escalates below the
> confidence floor.

### Phase 2 — Conductor: fail-first ordering and risk-aware train composition

- **Ordering.** Run the required set, audits included, in the order the model ranks most
  likely to fail given the diff. The set itself never changes. This is the Google TAP
  shape.
- **Train composition.** Advise batching low-risk PRs together and training high-risk PRs
  alone. Each red batch costs a bisection, and each half of a bisection is a full gate.
  This is the Uber SubmitQueue shape.
- **Ownership.** Ordering is automatic. Composition is advice that the person or agent
  running the queue accepts or overrides, and it is logged.
- **Where it plugs in:** the broker's advisor hook (Phase 0.5) already enforces the
  guardrails. It can only permute a priority tier; answers are cached by input hash; it
  runs in shadow by default. Conductor is an advisor command, not new scheduler code.
- **Later:** footprint-partitioned trains. PRs whose Tracegate footprints are disjoint go
  into independent sub-queues. This is novel: hosted queues partition by build targets,
  none by per-test footprints. It ships only after its false-independence rate is
  measured.

**Scoring in shadow:** the rank of the first failing test versus a random order, and the
bisections a risk-based split would have avoided.

**Exit:** a measured time-to-red improvement with no change to the set that runs.

> **CORRECTION (2026-10-25): what shipped (v0.5.0), and the one change of plan.** As in
> Phase 1, the model is an agent session, not a CI call. CI cannot wait for a session,
> so the live ranker is deterministic:
> - Inputs: the predictor's own reason for each file, recent failures from Red Reader
>   packets, and duration.
> - Output: `order.txt` in every run. On a red run, the rank of the first failure is
>   scored against a random order's expectation (`conductor-<host>.tsv`).
> - The set never changes, and a test asserts the predictor does not read the
>   Conductor.
>
> Shadow is the default. `conductor.mode: order` hands the order to Vitest through
> `tracegate-ci/sequencer`. Train advice is `tracegate conductor train`: PRs touching a
> global input, or reaching far more of the lane than the others, go alone, and
> disjoint pairs are listed. `conductor outcome` and `score` measure saved bisections
> and the **false-independence rate**. Partitioned trains stay unbuilt until that rate
> is known. An agent-ranked order through the broker's advisor hook remains possible
> and is not wired.

### Phase 3 — Dependency changes: a deterministic rule first, then a dependency oracle

1. **Deterministic rule.** Footprints record which packages each test loaded. On a lockfile
   change, re-run only the files that loaded a changed package, behind the same entry bar
   and audits.
2. **Dependency oracle, in shadow only.** For packages nearly every test loads (the web
   framework, the schema library), a model reads the changed versions, the changelog and
   the semver class, and predicts which tests the bump can affect.
   - Lockfile gates run the whole lane today, so every prediction can be scored against
     the full run for free.
   - This is the only proposal that **skips** work, so it comes last.
   - It would only ever enforce behind the entry bar, with audits, and after the
     deterministic rule's remaining gap is known.

**Exit:** the deterministic rule enforced; the oracle's shadow precision and recall
published, whatever they show.

> **CORRECTION (2026-10-25): what shipped (v0.5.0).**
> - **The rule** (`src/deps.mjs`, `depsVerdict` in the predictor):
>   - Footprints record the packages a worker loaded. A reporter records the packages
>     the Vitest main process loaded; those are global, because a plugin or transform
>     changes every test without appearing in any worker.
>   - The rule applies only to npm v2/v3 lockfiles, with both lists known and every
>     `node_modules` inside the repository.
>   - Native packages (install script, os/cpu) are global.
>   - Nested copies also change the package that resolves them.
>   - A dependency-only `package.json` edit is covered; nothing else about either
>     file is waived for a test that read it.
>   - It enforces only after its own bar (3 lockfile runs over 1 day with no failure
>     among the files it would have reused). Before that, those files run, and the run
>     logs how they went.
> - **The oracle** is the agent-session pattern again: a dependency packet per lockfile
>   run, `annotate_deps` over MCP (closed world), and `deps score` with recall and
>   share. It is shadow only and skips nothing.
> - **Known gaps:** a package a test only spawns as a process, and a native addon
>   loaded with dlopen, are invisible to V8 coverage. The audit, the full-run backstop
>   and the rule's own bar are what would catch them.

### Milestone 1: Ship it (v0.6.0, done 2026-10-29)

**Why.** A competitive survey (Oct 2026) found no tool that combines what Tracegate does.
It also found three gaps, all about distribution rather than mechanism:
- no install path;
- no Claude Code integration beyond a hand-registered MCP server;
- an untested coupling to one Vitest minor version.

**What shipped:**
- **`tracegate init`:**
  - proposes one lane per Vitest project, with its setup directories as globals;
  - `--write` writes the config and adds the recorder FIRST to each `setupFiles` it can
    patch textually. It never overwrites a config, and names the ones a person must edit;
  - `--mcp` registers the server.
- **`tracegate doctor`:**
  - checks Node, the Vitest version against the tested range, typescript, the recorder
    wiring and the ledger;
  - `--canary` records one test file and counts mapped against unmapped modules, the same
    count ingest uses.
- **Vitest 4.1 to 5.x, measured.** `examples/vitest-matrix.sh` runs the end-to-end once per
  version with `STRICT_SEAM=1` (0.0% unmapped). Vitest 5.0.5 keeps the seam.
  - Ingest now reports a moved seam as `DEGRADED TO SAFE` and names the Vitest version.
  - `peerDependencies.vitest` is `>=4.1.0 <6`.
- **A Claude Code plugin** (`.claude-plugin/`), with the repository as its own marketplace:
  - the MCP server (read-only);
  - both subagents, whose tool lists also name the plugin-namespaced tools;
  - two skills;
  - a `PreToolUse` hook (`hooks/lease-guard.mjs`). In a Tracegate repository it blocks a
    bare `vitest` or `npm test` outside a broker lease, so agents' runs queue with the
    gates. Any error in the hook lets the command run.
- **Release plumbing:**
  - GitHub Actions CI (Node 22 and 24, ubuntu and macOS, sabotage, e2e, the Vitest matrix);
  - a tag-triggered `npm publish --provenance`;
  - an MCP Registry `server.json`.

**Tests:** 27 onboarding tests and 7 new sabotage witnesses. One witness found a real bug
before release: `setupFiles` parsing stopped at the recorder's own nested `]`, so setup
files after it were missed.

**Left to the owner:**
- the npm release (add `NPM_TOKEN`, then push tag `v0.6.0`);
- `mcp-publisher publish`;
- a plugin icon, before the first marketplace submission.

**Next:** Milestone 2 (prove it): `tracegate savings`, a comparison with Vitest
`recordDependencies`, `tracegate report-card`.

### Milestone 2: Prove it (v0.7.0, done 2026-10-29)

**Why.** Value arrived only after the 14-day entry bar, the obvious objection ("why not
Vitest's own `recordDependencies`?") had no answer, and the miss accounting that sets
Tracegate apart was never published as numbers.

**What shipped:**
- **`tracegate savings`**, from the shadow log, so a lane shows what it would save from its
  first recorded run. The shadow row gains `total_s` and `reusable_s`. A MISS is never
  counted as a saving, and the projection keeps the audit sample. `appendTsv` widens an
  older log's header in place when the new header extends it, so old rows are kept.
- **`tracegate report-card`** (`src/evidence.mjs`). A verdict counts as *checked* when shadow
  ran it or enforce audited it; a verdict enforce reused unaudited is not evidence either
  way. The miss rate is reported per checked verdict and per run, each with a 95% Wilson
  interval.
  - **§5's open question on hole latency, answered by publishing a bound:** *exposure*,
    the time from the lane's last complete full run to the miss. A full run checks every
    verdict, so a hole cannot go undetected longer than that.
- **`examples/compare-vitest.sh`**, against Vitest 5.0.5, on five one-commit changes:
  - a function edit selects 1 file against Vitest's 4;
  - an edit to a function no test runs selects 0 against 3;
  - an edit to a data file read with `fs` is caught by Tracegate and missed by Vitest;
  - a lockfile bump re-runs every test that loaded the package, where Vitest runs none;
  - a script a test runs as a **child process is missed by both**. That is published as
    it is, with the `globals` remedy and the audit that turns it into a logged MISS.

**Claims re-checked (2026-10-29):**
- Vitest #11559 exists, open, `pending triage`, no comments (opened 2026-10-12), and
  describes competing Vitest instances across worktrees. The broker docs' citation holds.
- CloudBees Smart Tests (ex-Launchable) documents an **observation mode**
  (`--observation` on `subset` or `record session`): every test runs and the subset is
  scored, about 20 runs recommended. It is the nearest analogue to Tracegate's shadow mode,
  without an audit after it starts skipping.
- Datadog Test Optimization, which includes Test Impact Analysis: $20 per committer per month
  billed annually, $29 on demand, 1M test spans per committer (Datadog pricing page). A
  $24 monthly figure seen in a third-party comparison is not on Datadog's page.

**Tests:** 21 evidence tests, 6 sabotage witnesses, and savings and report-card assertions
in the end-to-end.

**Next:** Milestone 3 (differentiate): the local merge train, the silence guard, partner
recipes.

### Milestone 3: Differentiate (v0.8.0, done 2026-10-29)

**Why.** The merge gate that batches and bisects lived only in the private host project,
and this package offered only advice (`conductor train`). Guards against an agent
silencing tests worked at the edit level only; none checked the verdict.

**What shipped:**
- **`tracegate train`** (`src/train.mjs`), built fresh on the broker and the Conductor:
  - the queue is an append-only `trainq-<host>.tsv`, each PR pinned to its commit;
  - each batch is a `--no-ff` merge commit in a throwaway worktree, gated under a `train`
    lease;
  - a red batch is bisected by halves, the second half on top of what landed;
  - a green batch lands by `update-ref <new> <old>`, or by `merge --ff-only` where the
    target is checked out, and only if that checkout is clean;
  - the outcome is fed to `conductor outcome`;
  - one train runs per ledger at a time (a pid lock).
  - Run for real on the sample repository: a batch of two went red, the good PR landed as
    its gated merge commit, the red one was rejected, and all three gates ran as broker
    leases of class `train`. The worktrees shared the ledger, so each re-gate found 5 of
    6 verdicts reusable.
- **The silence guard** (`src/silence.mjs`):
  - it counts net additions only, so a pre-existing skip is never a finding;
  - its base is the merge base with `main`, so a skip in an earlier commit of the branch
    counts;
  - it runs in shadow by default; `enforce` makes the run red.
  - Lifting it is a person's act: `silence allow --by`, pinned to the file's blob. The
    Claude Code hook now blocks agents from running `silence allow` and `triage`. A Red
    Reader opinion cannot lift it.
- **`docs/recipes/`**: claude-code-merge-queue (as its `checkCommand`, or replaced by the
  train), edit-level guards, worktrees and containers (the broker socket), and `bin/ci`.

**Tests:** 20 train tests and 19 silence tests, each invariant with a sabotage witness
(12 new witnesses). Among them: a red PR never lands; the target points only at a
gated-green tree; a moved target lands nothing; a pre-existing skip is not a finding; an
allow is pinned to the file.

**Not done here:** posting the drafted outward posts (the owner posts them).

**Next:** Milestone 4: a runner-adapter boundary, then Jest; `tracegate attest`.

### Milestone 4: Expand (v0.9.0, done 2026-10-29)

**What shipped:**
- **Runner adapters** (`src/runners/vitest.mjs`, `jest.mjs`). An adapter has six parts:
  list, spawn, record arguments, file arguments, the worker flag, and result parsing.
  The recorder, the predictor and the ledger do not know which runner produced a
  footprint. The refactor came first and changed no test.
- **Jest 30.** The spike found two things.
  1. **The seam.** Jest 30 compiles each module with `vm.compileFunction`, looked up on
     `node:vm` at call time, so the recorder's existing patch extends to it. A setup file
     cannot load the recorder, because Jest intercepts `require` and `node:module`. A test
     environment can, because Jest loads it in the worker's own realm, one per test file,
     with `setup()` / `teardown()` around it.
  2. **A hole in binary coverage, MEASURED.** V8 reuses a compiled script for identical
     source, and Jest recompiles every module per test file. In binary mode a reused
     function is reported once and never again: a function run in test file 1 and again
     in file 3 was absent from file 3's footprint. That would have been a real miss (an
     edit to `add()` skipping a later file that calls it). Under Jest the recorder asks for
     call counts, which reset on every take.
  - The recorder now also refuses to map a module compiled with more than one text in a
    worker. This closes a gap under Vitest too: before, two texts of the same length
    passed the length check.
  - **Exit criterion met.** The seam maps 100% of modules on the sample, and the
    end-to-end asserts the same selections as Vitest's with `STRICT_SEAM=1`.
- **`tracegate attest` / `verify`** (`src/attest.mjs`): a signed git note of what green
  runs tested on the commit's exact tree, one green run per lane required. `verify`
  rejects a tampered statement, one copied to another commit, and an unsigned one unless
  told otherwise.

**Tests:** 12 attestation tests and 9 Jest recorder tests, with 10 new sabotage witnesses.
A stale witness anchor (`hook-lets-leases-through`, broken by the Milestone 3 hook change)
was found by an anchor check and fixed.

### Release 0.9.1: first contact (done 2026-10-30)

**Why.** 0.9.0 was published to npm and then installed the way a new user would: a fresh
Vitest project, `npm i -D tracegate-ci`, `init`, `doctor --canary`, `run`. Three problems
surfaced that no test had covered, because the samples pin TypeScript 5.9 and the tests
always ran on committed trees.

**Corrections:**
- **Uncommitted changes were invisible to selection.** `select` diffed footprints against
  HEAD, so in enforce an uncommitted edit to `add()` ran 0 of 2 files and passed. That is
  the ordinary case for an agent iterating before it commits. `select` now predicts
  against a `git stash create` snapshot of the working tree.
- **A run on uncommitted changes counted as evidence about HEAD:** a full-run row (which
  sets the 24 h full-run clock and bounds exposure in the report card) and a green row
  `attest` could sign. Both now need a run of exactly HEAD's tree: clean at the start and
  the end, HEAD unmoved.
- **TypeScript 7 broke parsing.** `typescript@latest` is the native compiler, whose package
  has no `createSourceFile`. `run` crashed after the tests, recording nothing, and
  `doctor` passed it. Tracegate now parses with 5 or 6 only, looks for 6 under the alias
  `tracegate-typescript` first, and `doctor` fails a lane it cannot parse for. Porting the
  parser to TypeScript 7's `typescript/unstable/*` API waits for that API to be stable.
- `server.json`'s description was 119 characters; the MCP Registry allows 100.

**Release path:** npm Trusted Publishing with `npm stage publish`; a maintainer approves
each version with 2FA. The `NPM_TOKEN` secret in Milestone 1's notes is retired.

**Tests:** 3 self-test and 8 onboarding checks, 4 sabotage witnesses, the e2e's
uncommitted-change scenario, and a CI job on TypeScript 7 with the alias. The dirty-tree
rule in `run.mjs` (no full run, no green row) is asserted by the e2e only: `runLane` has
no unit harness, so it has no sabotage witness.

### v1.0 criteria (status 2026-10-30)

- [x] CLI and MCP surface documented (README, `tracegate --help`, MCP tool descriptions).
- [ ] Report-card data from the host project published (`docs/evidence/`): the owner
      runs `tracegate report-card` there and decides what to publish.
- [ ] At least two external repositories using it: on npm since 0.9.0 (2026-10-30).
- [x] §5 open questions answered where this work could answer them: Jest is supported;
      the published metric is both the per-verdict miss rate with its interval and the hole
      exposure bound (Milestone 2).

### Out of scope, deliberately

| Out of scope | Why |
|---|---|
| A model that fixes code during a gate | A gate that edits code is not a gate |
| A model that lowers a verdict | That is the industry's documented failure mode |
| Model-chosen audit samples | They would bias the miss estimate |

---

## 5. Open questions

- [ ] Which model provider, and is sending failure output and diffs off the machine
      acceptable for a given project? An on-device model is an option for Phase 1.
- [x] Should Phase 0 support Jest and Node's test runner, or only Vitest? **Jest 30: yes
      (Milestone 4). `node:test`: not yet; its runner evaluates modules through Node's own
      loader, not a `vm` seam.**
- [ ] Does the frontend lane (DOM timing, i18n) need a different Red Reader prompt?
- [x] What is the right published metric for a selector: miss rate per gate, or the
      longest time a real failure went undetected? **Both, from `tracegate report-card`
      (Milestone 2): misses per checked verdict and per run with 95% Wilson intervals, and
      each hole's exposure (an upper bound on how long it went undetected).**
