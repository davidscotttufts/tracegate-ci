# Tracegate report card

Generated 2026-11-03T00:09:55.767Z on `MacBook-Pro-48` from the ledger's append-only logs.

Source: openwop-app, a private repository, lanes `backend` and `frontend`. Test paths and commit prefixes are redacted; every number is as generated. On 2026-11-02 the backend's 52 untriaged misses were triaged by re-running each file alone, three times, at the commit where it missed: 51 passed every time (flake) and 1 failed every time (a hole: a test whose result depends on git history, which the recorder can't see). The frontend's last untriaged miss was re-run the same way and passed every time (flake).

## Lane `backend`

| | |
|---|---|
| Observed runs | 379 (379 shadow, 0 enforce), 2026-10-13 to 2026-11-02 |
| Mean share of files that had to run | 41.70% |
| Mean share of test time that had to run | 54.1% |
| Reused verdicts checked | 606146 |
| Misses | 118 — 0.02% per checked verdict (95% CI 0.02% – 0.02%) |
| Runs with a miss | 18 of 379 — 4.75% (95% CI 3.02% – 7.38%) |
| Triage of misses | 2 hole, 116 flake, 0 untriaged |
| Longest hole exposure | 1 h ([redacted] at [redacted]) |
| Audit cost | 0 audited files over 0 that had to run (—) |

## Lane `frontend`

| | |
|---|---|
| Observed runs | 270 (223 shadow, 47 enforce), 2026-10-13 to 2026-11-02 |
| Mean share of files that had to run | 14.40% |
| Mean share of test time that had to run | 16.8% |
| Reused verdicts checked | 207553 |
| Misses | 10 — 0.00% per checked verdict (95% CI 0.00% – 0.01%) |
| Runs with a miss | 7 of 270 — 2.59% (95% CI 1.26% – 5.25%) |
| Triage of misses | 0 hole, 10 flake, 0 untriaged |
| Longest hole exposure | — |
| Audit cost | 2285 audited files over 7735 that had to run (29.54%) |

## Red Reader

1 opinion(s), 1 scored against a person's triage, 1 agreed. 1 escalation(s) raised a miss to a hole; a person overrode 0.

## Conductor

No scored red runs yet.
No train outcomes yet.

"Exposure" is the time since the lane's last complete full run before the miss: an upper bound on how long the hole could have gone undetected.
