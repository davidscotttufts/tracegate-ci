# Tracegate report card

Generated 2026-10-31T14:37:33.527Z on `MacBook-Pro-48` from the ledger's append-only logs.

Source: openwop-app, a private repository, lanes `backend` and `frontend`. One test path and one commit prefix are redacted; every number is as generated.

## Lane `backend`

| | |
|---|---|
| Observed runs | 343 (343 shadow, 0 enforce), 2026-10-17 to 2026-10-30 |
| Mean share of files that had to run | 40.20% |
| Mean share of test time that had to run | 52.2% |
| Reused verdicts checked | 558870 |
| Misses | 117 — 0.02% per checked verdict (95% CI 0.02% – 0.03%) |
| Runs with a miss | 17 of 343 — 4.96% (95% CI 3.12% – 7.79%) |
| Triage of misses | 1 hole, 64 flake, 52 untriaged |
| Longest hole exposure | 1 h ([redacted] at [redacted]) |
| Audit cost | 0 audited files over 0 that had to run (—) |

## Lane `frontend`

| | |
|---|---|
| Observed runs | 238 (219 shadow, 19 enforce), 2026-10-17 to 2026-10-30 |
| Mean share of files that had to run | 14.30% |
| Mean share of test time that had to run | 16.3% |
| Reused verdicts checked | 201657 |
| Misses | 10 — 0.00% per checked verdict (95% CI 0.00% – 0.01%) |
| Runs with a miss | 7 of 238 — 2.94% (95% CI 1.43% – 5.95%) |
| Triage of misses | 0 hole, 9 flake, 1 untriaged |
| Longest hole exposure | — |
| Audit cost | 964 audited files over 1870 that had to run (51.55%) |

## Red Reader

1 opinion(s), 1 scored against a person's triage, 1 agreed. 1 escalation(s) raised a miss to a hole; a person overrode 0.

## Conductor

No scored red runs yet.
No train outcomes yet.

"Exposure" is the time since the lane's last complete full run before the miss: an upper bound on how long the hole could have gone undetected.
