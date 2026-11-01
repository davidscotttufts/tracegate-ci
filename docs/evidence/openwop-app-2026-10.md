# Tracegate report card

Generated 2026-11-01T03:25:14.257Z on `MacBook-Pro-48` from the ledger's append-only logs.

Source: openwop-app, a private repository, lanes `backend` and `frontend`. One test path and one commit prefix are redacted; every number is as generated.

## Lane `backend`

| | |
|---|---|
| Observed runs | 358 (358 shadow, 0 enforce), 2026-10-13 to 2026-11-01 |
| Mean share of files that had to run | 41.00% |
| Mean share of test time that had to run | 53.2% |
| Reused verdicts checked | 577830 |
| Misses | 117 — 0.02% per checked verdict (95% CI 0.02% – 0.02%) |
| Runs with a miss | 17 of 358 — 4.75% (95% CI 2.99% – 7.47%) |
| Triage of misses | 1 hole, 64 flake, 52 untriaged |
| Longest hole exposure | 1 h ([redacted] at [redacted]) |
| Audit cost | 0 audited files over 0 that had to run (—) |

## Lane `frontend`

| | |
|---|---|
| Observed runs | 252 (221 shadow, 31 enforce), 2026-10-13 to 2026-11-01 |
| Mean share of files that had to run | 14.10% |
| Mean share of test time that had to run | 16.3% |
| Reused verdicts checked | 204502 |
| Misses | 10 — 0.00% per checked verdict (95% CI 0.00% – 0.01%) |
| Runs with a miss | 7 of 252 — 2.78% (95% CI 1.35% – 5.62%) |
| Triage of misses | 0 hole, 9 flake, 1 untriaged |
| Longest hole exposure | — |
| Audit cost | 1545 audited files over 3614 that had to run (42.75%) |

## Red Reader

1 opinion(s), 1 scored against a person's triage, 1 agreed. 1 escalation(s) raised a miss to a hole; a person overrode 0.

## Conductor

No scored red runs yet.
No train outcomes yet.

"Exposure" is the time since the lane's last complete full run before the miss: an upper bound on how long the hole could have gone undetected.
