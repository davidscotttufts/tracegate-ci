# Design: the Tracegate broker — one allocator for a machine's CI work

Status: Proposed, Phase 0.5. Implemented in `src/broker/`.

## 1. The problem

On one developer machine, many things compete for the same CPU:
- merge gates (15–45 min test runs);
- merge trains that batch PRs and bisect on red;
- a background daemon that pre-gates PR heads and runs a nightly full lane;
- measurements that need a quiet machine;
- the local build phase of deploys;
- several AI coding-agent sessions, each running targeted tests.

The project Tracegate came from coordinated this with **eight separate mechanisms**,
each deciding for itself which of the others it respects:

| Mechanism | Waits on | Makes others wait | Liveness |
|---|---|---|---|
| Gate "claim" directory (mkdir + pid + start time) | competing test processes, load | the daemon, full test runs | pid + start-time check |
| Train lock file | another train | nobody else | pid |
| Remote "freeze" ruleset | — | every merge | manual TTL (banned in practice) |
| Daemon lock (mkdir) | the claim dir; two process names; load | nobody | pid |
| A PAUSE file | — | one test-lock wrapper | manual |
| A test-runner lock wrapper | the claim dir, the PAUSE file, a process name | other wrapped runs | pid |
| Process-name matching (`pgrep`) | — | the daemon, the wrapper | process table |
| An advisory markdown queue (1,900+ lines) | humans and agents reading it | — | none |

Deploys held no lock at all. Every failure observed in one day of operation came from
the mismatches between these:

| # | Failure | Root cause | What it cost |
|---|---|---|---|
| F1 | **Cross-wait deadlock.** A measurement waited for "no competing suite"; the daemon's batch was a competing suite; the daemon yields only to an existing claim | Two waiters, each waiting on a signal only the other could produce | No measurement possible while the daemon ran |
| F2 | **Self-deadlock.** A measurement held the claim; its own test runs went through the wrapper, which waits while *any* claim exists | No notion of "this request belongs to that holder" | 30 min of a reserved quiet window |
| F3 | **Missed window.** The machine was quiet, and the coordinator forgot to send "GO" | A reservation was a message, not state | A ~4 h window; the measurement slipped a day |
| F4 | **Invisible pause.** A test run queued behind a PAUSE file nobody could see from the outside | State in an unadvertised file | A blind wait and a cross-session question |
| F5 | **Invisible deploys.** Deploys' local build phases took no lock | No resource model | Guards had to pattern-match process names |
| F6 | **Brittle matching.** Guards matched argv strings (`grep -v 'zsh -c'`), and the gate re-exec'd itself so a *waiting* gate's argv would not look like a *running* one | Liveness and identity inferred from the process table | A class of bugs that are hard to test |
| F7 | **Stale-claim races.** Recovering a dead holder's claim let two waiters both proceed (measured under load 87) | mkdir locks need cleanup, and two cleaners race | A historical double-grant |
| F8 | **Trains waiting 1–2 h for each other** | Strict FIFO, no backfill, no estimates | The largest wall-clock cost after the tests themselves |

## 2. What the evidence says (research, 2026-10-24)

The full citations are in the research notes behind ROADMAP §1. In short:

- **Nobody coordinates several agent sessions' CI work on one machine through a shared
  server.** The closest are a Vitest issue (#11559, open, untriaged, Oct 2026) describing
  exactly this problem with shell workarounds, and agent-team task lists that use file
  locks for task claims, not CPU.
- **Token budgets work, but plain jobservers lose tokens and are unfair.** GNU make's
  jobserver (adopted by Ninja 1.13, Cargo, GCC LTO and LLVM) loses tokens on SIGKILL, and
  has no owner tracking or fairness. Gentoo's system-wide jobserver work concluded that a
  server which tracks holders is required. No test runner honours a jobserver today.
- **Liveness should come from the kernel, authority from a counter.** Kleppmann's fencing
  tokens and etcd's revision counter give the authority half. For liveness, a lock or
  connection that the kernel releases on process death avoids the stale-lock cleanup races
  of mkdir locks (F7).
- **Reservations with EASY backfill solve "exclusive windows" and long FIFO waits.**
  Slurm's documented rule: a lower-priority job may start only if it does not delay the
  reserved start of the blocked head job. It needs duration estimates, and Tracegate
  already records durations.
- **Preempt only cheap work, with a priority gap.** Nomad preempts only across a gap of
  at least 10, lowest first. Buildkite and Kubernetes priorities affect *start*, never a
  running job.
- **Merge queues partition by impacted targets** (Trunk parallel queues, Mergify
  partitions, Uber's conflict analyser). Nobody partitions by *per-test footprints*, which
  Tracegate already has. That is novel, and left for a later phase (§7).
- **CI MCP servers are read-only by default** (GitHub `--read-only`, a Buildkite
  `read_`-scoped endpoint), with opt-in toolsets for writes.

## 3. Alternatives weighed

| Option | For | Against | Verdict |
|---|---|---|---|
| A. Keep the scripts, fix each bug | No new component | F1–F8 are emergent. Each new job type adds another pairwise rule; the bug class stays | Rejected |
| B. A shared lock library (flock-based) | Small; kernel liveness | No priorities, reservations, backfill, ETA or explanation. Node has no flock in its standard library | Rejected as the whole answer |
| C. A make-compatible jobserver FIFO | Industry standard; Ninja and Cargo speak it | Test runners don't; lost tokens; no reservations; no fairness | **Later**, as an export from the broker |
| D. **A local broker: one allocator process over a unix socket, event-sourced** | One ordered queue, so waits form no cycle. Kernel-released connections give liveness. Priorities, reservations, backfill, preemption, ETA and explanations. Agents and models plug into one surface | A process to keep alive; a socket protocol | **Chosen** |
| E. A full agent "release manager" inside the repo | Already does judgement work | Mostly project policy (deploys, certification); judgement belongs in an advisor, not a lock holder | Advisor hook only (§5.4) |
| F. A hosted merge queue (GitHub, Trunk, Mergify) | Mature | Hosted runners; the point here is the local machine; none is footprint-aware | Out of scope |

## 4. Decision

A single **broker** process per ledger (one per clone, shared by every worktree),
reached through a unix socket. It owns the machine's capacity as **N tokens**. Every
heavy job asks the broker for a lease, in any language, through a one-line wrapper:

```
tracegate lease --class gate --tokens 4 --est 900 --label "gate main@abc123" -- npm run ci
```

**Invariants**, each with a test:

| | Invariant | Fixes |
|---|---|---|
| I1 | **One queue, no cycles.** Waiters wait only on the broker, never on each other's signals | F1, F4, F6 |
| I2 | **Nested requests run inside their parent.** A request carrying `TRACEGATE_LEASE` (set by the wrapper for every child) runs within the parent's tokens immediately. A holder can never queue behind itself | F2 |
| I3 | **Liveness is the connection.** A lease lives exactly as long as its holder's socket; the kernel closes it on any death, SIGKILL included. No stale-lock cleanup exists to race | F7 |
| I4 | **Reservations are state, not messages.** A blocked head job gets a computed start time; it starts by itself when capacity frees. A deadline expires it with a logged reason | F3 |
| I5 | **EASY backfill.** A later job may jump ahead only if it fits now and, by its duration estimate, ends before the head job's reservation. Preemptible jobs may always backfill, since they can be evicted | F8 |
| I6 | **Preempt only preemptible work, across a priority gap of ≥ 10.** Lowest priority first; a running gate is never preempted | F1 (the daemon yields by rule, not by `pgrep`) |
| I7 | **Fencing.** Every grant carries a strictly increasing fence token (`TRACEGATE_FENCE`), so a writer can refuse stale authority | F7, and future ledger writes |
| I8 | **Event-sourced and deterministic.** All state is a pure function of an append-only JSONL event log. The scheduler is a pure function of (state, now). Replaying the log reproduces every decision | Audit, debugging, the "never delete evidence" rule |

**Job classes** (defaults; the config can override them):

| Class | Priority | Preemptible | Note |
|---|---|---|---|
| `deploy` | 70 | no | short local build phases |
| `gate`, `train` | 50 | no | |
| `measure` | 50 | no | normally `--exclusive` |
| `adhoc` | 30 | no | an agent's targeted run |
| `daemon` | 10 | **yes** | pre-gating, nightly |

## 5. Interfaces

### 5.1 Wrapper (any language, any tool)

`tracegate lease` runs a command under a lease and forwards its exit code. The child
gets these environment variables:
- `TRACEGATE_LEASE` and `TRACEGATE_FENCE`;
- `TRACEGATE_TOKENS`;
- `VITEST_MAX_WORKERS`, set to the tokens granted, so Vitest sizes itself to the grant.

`tracegate run` also honours `TRACEGATE_TOKENS`. On preemption the wrapper sends SIGTERM
to the child's process group and exits 75 (`EX_TEMPFAIL`). `--requeue` asks again.

### 5.2 Socket protocol

Newline-delimited JSON over a unix socket. Requests:
- `hello`, `request`, `release`, `cancel`, `status`, `explain`, `history`.

Pushes from the broker:
- `granted`, `queued`, `preempt`, `expired`.

### 5.3 MCP server (agents)

`tracegate mcp` speaks the Model Context Protocol over stdio.

**Read-only by default:**
- `queue_status`: capacity, running jobs, the queue with positions and ETAs;
- `explain_job`: why a job waits, what blocks it, and its reservation;
- `history`: recent events;
- `lane_mode`: Tracegate's effective mode per lane.

**`--allow-write` adds only:**
- `cancel_queued`: a queued job, never a running one.

Agents do their actual work with `tracegate lease -- …` in their own shell, so a lease
stays bound to the process that does the work. They coordinate by asking the broker
instead of messaging each other.

### 5.4 Advisor hook (models)

`broker.advisor` in the config names a command. When two or more jobs wait in the
**same priority tier**, the broker may ask it to order them (for example, risky PRs
first, or a fail-first order). The guardrails:
- It **may only permute jobs within a tier.** It never adds, removes, grants, preempts or
  touches a running job. Anything else in its answer is rejected and logged.
- **Cached** under `sha256(advisor ‖ input)`, so a replay never re-asks.
- **`shadow` by default:** the advice is logged as an `advice` event and not applied.
- **A timeout (10 s) or invalid output means no opinion**, and FIFO order stands.

## 6. Scheduling algorithm (pure, `src/broker/core.mjs`)

```
free   = capacity − Σ tokens of running top-level jobs
queue  = queued jobs by (priority desc, advisor rank, enqueue seq)
for job in queue:
  need = job.exclusive ? capacity : min(job.tokens, capacity)
  if fits(need, free) and (job.exclusive ⇒ nothing running) and not blockedByReservation(job):
      grant(job); free −= need
  elif no reservation yet:
      if preemptible victims with priority ≤ job.priority − 10 would free enough:
          preempt(victims, lowest first)          # they release; the job is granted next pass
      reservation = earliest time enough tokens free, from running jobs' est end times
blockedByReservation(j) = reservation exists and j is not preemptible
                          and (j.est unknown or now + j.est > reservation.at)
```

Duration estimates come from the client's `--est`, else from the p90 of past runs of
the same `(class, label)` in the event log.

Since Phase 0.6, `capacity` above is the **current cpu budget** and every fit also checks
the **memory budget** (§9). `need` is clamped to both, and an elastic job (`minTokens`)
is granted the widest width in `[minTokens, need]` that fits.

## 7. Phases

| Phase | Work | Exit |
|---|---|---|
| 0.5a | Core scheduler, broker server, `lease`, `queue`, `explain`, MCP read tools, advisor hook (shadow) | Tests for I1–I8, including regression tests that reproduce F1, F2 and F3 and pass; rules sabotage-witnessed |
| 0.5b | Adopt in the source project: gate, train, daemon, measurements and deploys all wrap in `tracegate lease`; the eight mechanisms retire one by one | Two weeks with no coordination incident |
| 0.6 | Adaptive capacity (§9): cpu and memory budgets from live machine samples, elastic grants, learned memory per job, shedding of preemptible work, a starvation guard; hardware-relative defaults | Tests for I9 and the parsers on fixtures from two page sizes; rules sabotage-witnessed (done, v0.3.0) |
| 0.5c | A make-compatible jobserver FIFO exported per lease, for Ninja, Cargo and GCC children | Measured under a mixed workload |
| 2 | Conductor (ROADMAP Phase 2) as an advisor: fail-first and risk-aware composition | Shadow-scored |
| 3+ | **Footprint-partitioned trains:** PRs with disjoint Tracegate footprints go into independent sub-queues, with a Zuul-style adaptive window and Trunk-style optimistic merging for flakes | False-independence rate measured before anything relies on it |

## 8. Open questions

- [x] **Capacity:** cores, or measured? **Both (Phase 0.6, §9):** the configured
      capacity is the ceiling, and the broker narrows grants below it from measured
      load and memory. Work the broker cannot see is exactly what the samples measure.
- [ ] **Remote runners:** the protocol should not preclude a second machine's broker
      (sync of the event log), but nothing here depends on it.
- [ ] **Broker restart:** jobs from a previous broker instance are released with reason
      `broker-restart`, and wrappers see their socket close. Should a wrapper re-attach
      instead of failing its job? Today it keeps running its child and warns.

## 9. Adaptive capacity (Phase 0.6)

**The question.** Can the broker size work to the machine as it is right now: how many
workers, and how much memory, given everything else that is running? And can one
configuration serve machines with very different hardware?

**What it does.** Every `sampleSeconds` (default 5) the broker samples the machine
(`src/broker/sampler.mjs`), asks a pure policy (`src/broker/adapt.mjs`) for two budgets,
and logs a `capacity` event when they change. The scheduler (§6) grants only what fits
both budgets.

| Budget | Computed from |
|---|---|
| **cpu** (tokens ≈ workers) | Configured capacity, minus busy cores that are not ours (measured busy cores minus the tokens we have granted). A thermal CPU speed limit scales it. Memory pressure `warn` caps it at half; `critical` caps it at the minimum. |
| **memory** (MB) | What our leases have reserved, plus available memory (the minimum over the hold window), minus a headroom, minus growth our running leases have reserved but not yet used. Under `critical` pressure, no new memory is granted. |

**The signals, per platform.**

| Signal | macOS | Linux | Elsewhere |
|---|---|---|---|
| Busy cores | `os.cpus()` tick deltas | same | same |
| Available memory | `vm_stat`: free + inactive + speculative + purgeable, times the page size it reports | `MemAvailable`, then the cgroup v2 limit minus usage if lower | `os.freemem()` |
| Pressure | `kern.memorystatus_vm_pressure_level` (the kernel's own verdict) | PSI `some avg10` (cgroup's file first): ≥ 5% warn, ≥ 20% critical | none |
| Swap-in rate | `vm_stat` Swapins × page size, in MB/s | `pswpin` × `getconf PAGESIZE` | none |
| Thermal | `pmset -g therm` CPU_Speed_Limit | none | none |
| Per-lease memory | `ps` process-tree RSS of the lease holder's pid | same | none |

A signal that cannot be read is ignored for itself alone. It is never guessed as
pressure or as headroom, and the decision's `why` names it.

**Why busy cores, not the load average.** MEASURED on the host project's Mac: the load
average read 10.3 on 8 cores while the processes used 5.6 cores between them. The macOS
load average counts threads waiting to run, so it would have granted 1 worker where 2
fit. The load average is only a fallback when there is no second reading.

**Different machines.** One committed config serves them all:
- **Every default is derived from the host.**
  - The capacity defaults to the host's cores; a Linux container's CPU quota counts.
  - The memory per token defaults to half of RAM per core, within 256–2048 MB.
  - The headroom defaults to 10% of RAM, within 1–8 GB.
  - Swap thresholds are in MB/s, so 16 KB and 4 KB pages read alike.
- **`"capacity"` may be a share** such as `"75%"`.
- **`"hosts": { "<host>": {…} }`** overrides any of it for one machine.
- **The broker's state is per host** (`<ledger>/broker/<host>/`), because what it learns
  (durations, memory per token) is a property of one machine, and a ledger may sit on
  storage several machines share.
- **The broker logs the hardware profile** (cores, performance cores, RAM, arch,
  container limits) in its start-up `capacity` event.

**I9 rules (each sabotage-witnessed).**
1. **A request is clamped to the current budgets,** exactly as it was always clamped to
   the configured capacity. It waits only for room, never for a width the machine
   cannot give.
2. **An elastic request is granted the most workers that fit.** `--min-tokens m`
   accepts any width from m to `--tokens`. This is the only way a worker count adapts:
   Vitest fixes its pool when it starts, and killing workers mid-run makes the false
   reds this project exists to avoid.
3. **Down at once, up slowly.** A lower budget applies on the next sample. A higher one
   must hold for `upHoldS` (default 30 s) and then rises one token per step. Memory is
   the minimum over that window, so a one-sample cache flush opens nothing.
4. **Shedding is for preemptible work only.** When the budget falls below what is
   running, or pressure is critical, preemptible leases (the daemon) are asked to
   yield, cheapest first. A gate is never stopped for load.
5. **Nothing new starts under critical memory pressure.** Found by the live test:
   without this rule, memory freed by a shed daemon was handed straight to the next
   grant.
6. **Starvation guard.** A job held back only by the budgets, with none of our work
   running (so nothing of ours will free room), runs anyway after `starvationS`
   (default 300 s). It runs at its narrowest and is flagged `contended`, which
   `tracegate run` prints as "a red here is not evidence". A busy machine therefore
   cannot hold a gate forever.
7. **Memory is learned.** Each release records the peak RSS of the job's process tree.
   The next run of that `(class, label)` reserves the p90 of past peaks per granted
   token, else its `--mem-per-token`, else the machine's default.
8. **The first budget is decided before the socket opens.** Found by the smoke test: a
   request that raced the first sample was granted the full configured capacity.
9. **Replayable.** `capacity` events (including the start-up reset) and `peakMB` on
   releases are in the event log. Replaying it reproduces every budget and grant
   without the samples (I8).

**Modes.** `"adaptive": {"mode": "on" | "shadow" | "off"}`, or
`TRACEGATE_BROKER_ADAPTIVE`. In `shadow` the budgets are computed and logged with
`applied: false` and change no grant, which is the way to measure a policy on a machine
before trusting it.

**Inspecting it.**
- `tracegate machine` prints this host's hardware, the latest reading, the budgets, the
  derived defaults, and each lease's measured memory.
- The MCP tool `machine_load` returns the same.
- `tracegate queue` and `explain` say when the machine, not another job, is what holds a
  job back.

**Not done (open).**
- [ ] **Performance vs efficiency cores.** `perfCores` is reported, but tokens count
      all cores alike. Measure whether a Vitest worker on an efficiency core
      lengthens the critical path enough to matter.
- [ ] **A jobserver for tools that fork** (0.5c), so the granted width also reaches
      compilers that do not read `VITEST_MAX_WORKERS`.
- [ ] **Batch re-sizing.** A lane split into batches could be re-leased between batches
      and so follow the budget during a run, not just at its start.
