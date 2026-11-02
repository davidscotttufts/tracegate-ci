# Background

The research behind Tracegate's design, as of October 2026. Evidence classes: **M**
measured with a stated method, **A** anecdotal, **$** vendor claim without a method.

## What others have tried

| Approach | Who | Result | Ev. | Known problem |
|---|---|---|---|---|
| ML test selection | Meta ([2018](https://arxiv.org/abs/1810.05286)) | Test cost halved; >99.9% of bad changes still caught | M | Misses up to ~5% of individual failures by design |
| ML test selection | [Develocity](https://gradle.com/develocity/product/predictive-test-selection/), CloudBees Smart Tests (ex-Launchable) | 35–80% less test time | $ | Misses by design; periodic full runs recommended |
| Coverage-based impact analysis | [Datadog TIA](https://docs.datadoghq.com/tests/test_impact_analysis/), [Teamscale](https://teamscale.com/publications/2018-test-impact-analysis-detecting-errors-early-despite-large-long-running-test-suites.pdf) | 90% of failed builds caught in 2% of test time (Teamscale) | M / $ | Blind to dependency, config and data-file changes by default |
| ML-ordered testing, no skipping | Google TAP ([2025](https://research.google/pubs/speculative-testing-at-google-with-transition-prediction/)) | Breakages found ~70 min sooner | M | Rollout in progress |
| Speculative merge queue | Uber SubmitQueue ([2025](https://www.uber.com/blog/slashing-ci-costs-at-uber)) | CPU −53%, P95 wait −37% | M | Wasted speculative builds |
| Merge queue without bisection | [GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) | — | — | A red PR can ride in on a later green |
| Flake detection and quarantine | [Atlassian](https://www.atlassian.com/blog/atlassian-engineering/taming-test-flakiness-how-we-built-a-scalable-tool-to-detect-and-manage-flaky-tests), Trunk, Buildkite | 22k builds recovered in a quarter (Atlassian) | M | Quarantine hides real races |
| LLM diff risk score | Meta ([2024](https://arxiv.org/abs/2410.06351)) | 1.4–1.5× incidents caught vs. logistic regression | M | A threshold trade-off |
| AI fixes for flaky tests | Datadog, Nx, Semaphore, Harness, Dagger | "50% time to green" (Nx) | $ | No published success or revert rates |
| Agent loop with an LLM judge | [Spotify](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3) | Judge vetoed ~25% of sessions | M / A | Needed because agents disabled flaky tests |
| Local CI with a signoff | [Rails 8.1 `bin/ci`](https://rubyonrails.org/2025/10/22/rails-8-1) | 30k tests in under 2 min | A | The signoff doesn't say which tree was tested |

What this adds up to:

- Models that only reorder or prune speculative work are in production and measured
  (Uber, Google). A wrong guess costs time, never correctness.
- Models that skip tests are in production too (Meta, Develocity, CloudBees). All of them
  accept some misses and rely on periodic full runs.
- No production system was found where an LLM chooses which tests run. LLM flake
  classification exists only in offline studies. LLM fix agents publish no outcome data.
- Nobody publishes miss accounting: how long a missed failure can go unnoticed, or a
  selector's recall over time.

## Risks that shaped the design

- **Prompt injection into CI agents is real.**
  [PromptPwnd](https://csoonline.com/article/4101751/ai-in-ci-cd-pipelines-can-be-tricked-into-behaving-badly-2.html),
  the [CodeRabbit RCE](https://kudelskisecurity.com/research/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories),
  and the [Nx "s1ngularity"](https://snyk.io/blog/weaponizing-ai-coding-agents-for-malware-in-the-nx-malicious-package/)
  packages all turned an AI in the pipeline against its owner. A model near a gate must
  treat diffs and logs as untrusted, and get no tools or credentials.
- **Agents silence tests.** Spotify, Cypress and others report disabled flaky tests,
  weakened assertions, and real races filed as flaky.
- **Temperature 0 isn't deterministic** on hosted models: 80 distinct answers in 1,000
  runs ([Thinking Machines, 2025](https://simonwillison.net/2025/Sep/11/defeating-nondeterminism/)).
  A replayable gate has to store the model's decision, not ask again.

## Where the time went in the host project

Tracegate was built inside a private TypeScript monorepo (about 2,700 backend and 1,000
frontend test files) that gates every merge locally. Over 134 backend gates in 11 days of
October 2026:

| Gate shape | Share | Backend tests | Whole gate |
|---|---|---|---|
| Light: up to ~200 files plus the audit | ~48% | 6.5–7.5 min | 14–16 min |
| Heavy, from boot wiring every app boot reads | 25% | 1,000–2,000 files | 25–35 min |
| Global: lockfile, `package.json`, runtime | 27% | ~33 min | ~43 min |

Over half the gate time came from boot wiring and global inputs. In one night, two
one-line security patches each ran all 2,700 backend files. That led to the
[dependency rule](guide.md#dependency-changes).

Coordination cost more than selection. In one day: a four-hour quiet window lost to a
missed "go", a 30-minute self-deadlock, a cross-wait between a measurement and the
background daemon, and trains waiting one to two hours for each other. Eight separate
mechanisms (lock directories, a pause file, a markdown queue and more) each decided for
itself whom to respect. That led to the [broker](guide.md#broker), whose parts are
borrowed:

| Part | From |
|---|---|
| Tracked token budget | make's jobserver; Gentoo's system-wide jobserver |
| Fencing tokens | Kleppmann, etcd |
| Backfill with reservations | Slurm |
| Preemption across a priority gap | Nomad |
| Read-only-by-default tools | GitHub's and Buildkite's MCP servers |

On 2026-10-12 the project's second machine merged five PRs and deployed while a gate ran
on the first. The gate went green and then had to refuse to merge. That led to the
[release bus](guide.md#release-bus).

## Measured along the way

- **Jest and V8 binary coverage.** V8 reuses compiled code for identical source, and Jest
  recompiles every module per test file. In binary mode a function reused that way is
  reported once and never again, so a later test file's footprint would miss it. The
  recorder uses call counts under Jest for this reason.
- **Uncommitted edits.** Installing 0.9.0 as a new user showed that an uncommitted edit
  was invisible to selection: an agent iterating before it commits would have skipped
  the tests it was breaking. Selection now runs against the working tree.
- **Child processes.** A script a test runs as a separate process is invisible to both
  Tracegate and Vitest's `recordDependencies`
  ([comparison](compare/vitest-record-dependencies.md)). The remedy is `globals`; the
  audit turns anything missed into a logged miss.
