# Edit-level guards and the silence guard

Hook-based guards such as protect-tests, [TDD Guard](https://github.com/nizos/tdd-guard) and [Probity](https://github.com/nizos/probity) look at what an agent *writes*: they block or question an edit to a test before it lands on disk. Tracegate's silence guard looks at the *verdict*: on every `tracegate run`, it checks whether the change since the merge base makes the suite test less.

They catch different things, so use both:

| | Edit guard | Silence guard |
|---|---|---|
| When | Before the edit is written | At the test run, over the whole branch |
| Sees | One agent's edits through the hooks | Every commit, whoever made it, including edits made outside the agent |
| Finds | Whatever its rules or model judge | Net-added `.skip` / `.todo` / `.only` / `xit`, `if (false)`, removed `it(` blocks, deleted test files |
| Lifting it | Depends on the guard | Only `tracegate silence allow --by <name>`, pinned to that file's contents. The Claude Code hook blocks agents from running it. |

## Turning it on

The guard runs in shadow by default: findings are printed, logged to `silenced-<host>.tsv` and put in the red packet. To make the run red until a person allows each finding:

```json
{ "silence": { "mode": "enforce", "base": "main" } }
```

```sh
npx tracegate silence check                       # what the branch silences, against the merge base
npx tracegate silence allow --file test/a.test.ts --by dana
```

An agent can still say a red looks like a flake, as an escalate-only opinion (`tracegate red annotate … --verdict flake-suspect`). That opinion never lifts the guard.

The hook is a guard, not a sandbox: an agent that can run arbitrary scripts can get around it. What it does ensure is that lifting the guard is an explicit act, recorded in the ledger with a name.
