# Design: roles, a cross-machine lease with fencing

Status: implemented, in `src/role/`. Usage is in the [README](../../README.md#roles).

## The problem

Deploys run from one machine at a time. Until now, which machine that was lived in people's
heads and in chat notes. On 2026-11-27 the deploy machine's sign-in expired, and two deploys
waited for hours: no other machine could take over cleanly, and nothing would have stopped
two machines from deploying at once if one had tried. The user's rule: **any machine can take
over as the deployer, at any time.**

That needs three things the broker and the release bus don't give:
- **One answer every machine agrees on.** The broker sees one machine. The bus is advisory by
  design, and it warns rather than decides.
- **Safe takeover from a live holder.** The old holder may be mid-deploy and unreachable.
- **A way for a deploy to notice that it lost the role** before its irreversible step.

## Decision

A **role** is a record in a store that every machine can reach, changed only by
compare-and-swap:

```
{ role, epoch, holder: {host, user, session} | null, since, until, renewedAt,
  offer: {to, by, at} | null, history: [ {epoch, action, host, user, at, reason, previous, preflight} ] }
```

| Rule | Why |
|---|---|
| Every write is a CAS on the store's generation. A writer that loses re-reads and decides again | Two claimers: exactly one wins, and the loser sees the winner and exits 3 |
| The **epoch** rises on every change of holder (claim, accepted handover, take, release), and a renew keeps it | It is the fencing token: authority is "holds epoch N", never "thinks it is the deployer" |
| `role check --epoch N` passes only while N is current, this host holds it, and the lease hasn't expired | A deploy calls it right before the traffic shift |
| `take` works against a live holder and needs `--reason` | "At any time" is the requirement. The reason and the previous holder go in the audit trail |
| **A takeover never kills the old holder's deploy** | Tracegate can't reach the other machine, and a deploy stopped half way is worse than one that stops at its check. The old holder can't start a new deploy (`lease --role` refuses), and its next `role check` fails |
| A lease has a TTL (default 30 min). `claim --hold` and `lease --role` renew it every third of the TTL | A closed laptop lid loses the role by expiry, with no cleanup step |
| Preflight runs on the machine that wants the role, before it writes anything | A machine whose sign-ins have expired never becomes the deployer |
| Holding a role is never an approval | Tracegate decides which machine runs a deploy, never whether it may run |

### Stores

| URL | CAS | Notes |
|---|---|---|
| `file:///dir` or a path | `link(2)` creates generation N+1 and fails if it exists | No lock file, so nothing goes stale. Shared disks and tests |
| `gs://bucket/prefix` | `gcloud storage cp --if-generation-match=<gen>` (0 = create only); reads are pinned to `#<gen>` | Object `<prefix>/roles/<role>.json`. A 412 is a lost race; any other failure is an error |
| `git+<remote>#<ref prefix>` | `git push --force-with-lease=<ref>:<sha>` (empty = must not exist) | One ref per role, default `refs/tracegate/roles/<role>`, a commit holding `role.json` whose parent is the previous state. Needs no cloud account, and the ref's history is a second audit trail |

## Changes from the brief

- **`handover` is an offer, not a move.** The brief had the holder move the role to
  `--to <host>`, with the preflight running "on the claiming machine". The holder can't run a
  preflight on another machine. So `handover --to B` records an offer, the holder keeps the
  role, and the move happens when B runs `claim`: B's own preflight runs there, and the epoch
  rises then. If B never accepts, nothing moves, so a planned handover can't leave the role
  with nobody. Only the named host can accept.
- **The file store uses `link(2)` instead of a lock and a rename,** as the release bus does. A
  lock needs stale-lock recovery, and that recovery is how two writers both win (F7 in the
  broker design). `link(2)` refuses an existing name atomically.
- **Expiry fails `role check`.** "The epoch is still current" alone would let a machine whose
  lease expired, but which nobody has claimed yet, ship. A long deploy renews through
  `lease --role` or `claim --hold`.
- **The audit trail lives in the record,** in its last 200 changes. That makes it atomic with
  the change it records. The git store also keeps every state as a commit.

## Names

`deployer` is global, and `deployer:<repo>` is one repo's. For an unqualified name in repo R,
the first of these that applies:
1. a qualified name (`deployer:R`) is used as given;
2. `deployer:R`, if the config declares `"roles": {"deployer:R": {…}}`;
3. `deployer:R`, if the store has a record for it, even a released one (so releasing a
   per-repo role does not silently hand that repo back to the global deployer);
4. `deployer`.

R is `roles.repo`, or else the name of the clone's directory.

## Exit codes

0 ok · 2 usage · 3 held by another machine, or lost a race · 4 fenced (not the holder, a stale
epoch, or expired) · 5 preflight failed · 6 store unreachable.

## Open

- [ ] A recurring deploy window (the broker's "night windows" phase) would read the role to
      decide where it runs.
- [ ] The store's clock: expiry compares each machine's own clock with `until`. A machine whose
      clock is minutes fast could claim a lease early. NTP makes that unlikely; a store-side
      time (GCS metadata, the git commit time) could replace it.
