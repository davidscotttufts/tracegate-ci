# Evidence

Tracegate's claim is that a skipped test is a measured risk, not a guess. This folder holds
the measurements: report cards generated from real ledgers. No number here is written by
hand.

## Cards

| Card | Project | Window | Runs |
|---|---|---|---|
| [openwop-app-2026-10](openwop-app-2026-10.md) ([JSON](openwop-app-2026-10.json)) | openwop-app (private), the project Tracegate was built in | 2026-10-13 to 2026-11-02 | 631 (591 shadow, 40 enforce) |

## Making one

```sh
npx tracegate report-card --out docs/evidence/<project>-<yyyy-mm>.md        # Markdown
npx tracegate report-card --json --out docs/evidence/<project>-<yyyy-mm>.json
```

The card is computed from the ledger's logs, and changes nothing.

## Reading a card

- **Checked verdicts.** A reused verdict counts as checked when the file still ran: in shadow every file runs, and in enforce the audit sample runs. A verdict that enforce reused without an audit is not counted, because nothing tested it.
- **Miss rate.** Misses divided by checked verdicts, with a 95% Wilson interval. A card with few checks has a wide interval, and that width is part of the result. The per-run rate is the share of runs that had at least one miss.
- **Triage.** The latest verdict on each miss decides: a person's `triage`, or a Red Reader escalation. A `hole` is a gap in a footprint; a `flake` is a test that fails on its own.
- **Exposure.** For each hole, the time between the lane's last complete full run and the miss. A full run checks every verdict, so the hole cannot have gone undetected for longer than this. It is an upper bound, not the hole's real age.
- **Audit cost.** Audited files as a share of the files enforce had to run anyway.

## Publishing

Publish a card only from a ledger whose owner agrees to it. A card names test files and commit prefixes, so review it first. A private project's card may redact test paths and commit prefixes, and says so; its numbers are never edited.
