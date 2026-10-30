# A `bin/ci` for TypeScript

Rails 8.1 ships `bin/ci`: one local command that runs a project's CI steps, with an optional `gh signoff` that marks the commit green on GitHub. The JavaScript ecosystem has no standard equivalent. This is one, built on Tracegate.

```sh
#!/usr/bin/env bash
# bin/ci — local CI. Every step queues through the machine's broker.
set -euo pipefail
lease() { npx tracegate lease --class gate --quiet "$@"; }

lease --tokens 1 -- npx tsc --noEmit
lease --tokens 1 -- npx eslint .
npx tracegate run                     # selection, recording, misses, the silence guard (add --lane per lane if there are several)
npx tracegate status | tail -n +5     # mode and entry bar per lane

# Optional, once the tree is green: say so on GitHub.
# gh signoff
```

How this differs from a plain script:
- **Skips are earned, not assumed.** `tracegate run` runs everything until the lane's entry bar is met. After that, a random 5% of skipped files still run, and a miss suspends skipping.
- **The machine is shared.** Agents, gates and this script queue in one place.
- **The evidence stays.** `npx tracegate report-card` publishes the miss rate behind the skips. A `gh signoff` alone declares a commit green without recording what was run.
