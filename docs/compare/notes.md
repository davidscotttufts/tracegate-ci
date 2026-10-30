
## What the rows show

**1–2: function granularity.** Vitest's record is per module: a test that loaded `src/math.ts` is selected on any edit to it. Tracegate keys each test on the functions it executed, so an edit to `multiply()` selects only the test that ran `multiply()`, and an edit to a function no test runs selects nothing. Both tools pick up every failure in these rows. The difference is cost.

**3: files read at run time.** `src/report.ts` reads `data/rates.json` with `fs.readFileSync`. It is not a module, so Vitest has no record of it and selects nothing, while the test fails. Tracegate records repository files a test reads, and selects it.

**4: a shared blind spot.** The test runs `scripts/greet.mjs` as a child process. Neither tool records what a child process loads or reads, so **both miss the failure**. This is the case Vitest's own docs give for `forceRerunTriggers`. The Tracegate equivalent is a lane `globals` entry (`"globals": ["scripts/"]`), which makes a change there run the whole lane. The two tools differ in what happens when nobody configured that:
- Vitest has no later check.
- Tracegate does not skip on its say-so alone. A lane runs everything in shadow until it meets its entry bar. Under enforce, a random 5% of reused verdicts still run as an audit, and the whole lane runs at least once every `fullRunMaxHours`. Either one turns this hole into a logged MISS, and that suspends skipping for the lane until a person triages it.

The miss rate that results is published per lane by `tracegate report-card`.

**5: dependencies.** The lockfile is not a module either. Vitest re-runs everything for `package.json` (a default `forceRerunTriggers` entry) but not for a lockfile-only change. Tracegate re-runs every test that loaded a changed package, here all of them, because every test loads `chai` through `expect`. It reuses a verdict across a lockfile change only once its dependency rule has earned its own bar.

## What this does not show

- Speed. The sample is six tiny files; selection overhead is not measured here.
- Vitest without `recordDependencies`. Its static module graph selects the same files as the record in rows 1–2 here, because no test imports a module it does not run.
- Configuration. `forceRerunTriggers` (Vitest) and `globals` (Tracegate) both close row 4 once someone knows to set them.
