# A two-week trial

Tracegate starts in shadow: every test still runs, and it only records which ones it
would have skipped. Two weeks of that tells you what skipping would save in your
repository, and how often it would have been wrong. Nothing about your CI changes.

## Start

```sh
npm install --save-dev tracegate-ci
npx tracegate init --write          # config + recorder; prints anything to edit by hand
npx tracegate doctor --canary       # records one test file to check the wiring
```

Then run your tests through Tracegate wherever you run them now, locally or by an agent:

```sh
npx tracegate run                   # shadow: everything runs, decisions are logged
```

In Claude Code, `/plugin marketplace add davidscotttufts/tracegate-ci` adds the gate skill
and a hook that steers agents to `tracegate run`.

## While it runs

- `npx tracegate savings` shows the files and minutes skipping would have saved so far.
- A *miss* is a test it would have skipped that failed anyway. `tracegate run` prints
  each one when it happens, and `report-card` counts those still untriaged. Give each a
  verdict: `flake` if it fails on its own, `hole` if Tracegate missed an input.

  ```sh
  npx tracegate triage --lane <lane> --file <test file> --head <commit> --verdict flake
  ```

  Re-running the file alone a few times at that commit usually settles it.

## After two weeks

```sh
npx tracegate report-card --redact --out tracegate-card.md   # private repo
npx tracegate report-card --out tracegate-card.md            # public repo
```

`--redact` replaces test paths, commit prefixes and the host with `[redacted]`. No number
changes. Read the card before you share it.

## Share it

Open a [report card issue](https://github.com/davidscotttufts/tracegate-ci/issues/new?template=report-card.yml)
and attach the card, or open a pull request that adds it to [docs/evidence/](evidence/).
A card from a repository that isn't Tracegate's own is the most useful thing you can
send. A bad card is as welcome as a good one.

## Stop

`npm uninstall tracegate-ci`, then remove `tracegate.config.json` and the `setupFiles`
line `init` added. The ledger lives in your git directory (`.git/tracegate/`); delete it
too.
