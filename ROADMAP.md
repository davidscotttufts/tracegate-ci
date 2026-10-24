# Tracegate CI — Roadmap

Last updated: 2026-10-24 (Phase 0 and Phase 0.5 done).

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
- [ ] Should Phase 0 support Jest and Node's test runner, or only Vitest?
- [ ] Does the frontend lane (DOM timing, i18n) need a different Red Reader prompt?
- [ ] What is the right published metric for a selector: miss rate per gate, or the
      longest time a real failure went undetected?
