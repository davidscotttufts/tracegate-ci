# claude-code-merge-queue

[claude-code-merge-queue](https://github.com/funador/claude-code-merge-queue) lands agent lanes one at a time, first in first out. Each landing waits for one `checkCommand`. Its README calls that command "what actually gates a landing".

## Option 1: Tracegate as the check command

Point the check at Tracegate instead of the full suite:

```json
{ "checkCommand": "npx tracegate run" }
```

- Each landing runs only the tests its change can reach, once the lane has earned enforcement. Until then it runs everything, in shadow, and `npx tracegate savings` shows what selection would have saved.
- Every check queues through the broker, so landings don't compete for cores with other agents' runs.
- A red check leaves a packet that the Red Reader can explain (`npx tracegate red list`).

The queue still lands one PR at a time.

## Option 2: Tracegate's train instead of the FIFO

```sh
npx tracegate train add --pr lane-a=lane/a
npx tracegate train add --pr lane-b=lane/b
npx tracegate train run --lane app      # one gate for both; a red batch is bisected
```

- A batch is gated as its exact merge commit. Two green PRs cost one gate.
- A red batch is split into halves until the red PR is isolated. Each half reuses the verdicts the split did not change.
- The target branch moves only by compare-and-swap, onto a commit whose tree was gated green. A target that moved meanwhile lands nothing.
- Pushing is opt-in (`--push`).

Choose option 1 to keep the existing queue's lanes, ports and promote step. Choose option 2 when gate time per landing is the bottleneck.
