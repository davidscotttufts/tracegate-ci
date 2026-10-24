# Tracegate CI

Local CI that runs only what a change can affect, and earns the right to skip the rest.

Tracegate records what each test actually touches: the functions it executed, the modules
it loaded and the repo files it read. It writes that per-file **footprint** into a ledger.
A test whose footprint nothing has changed since its last green run can reuse that
verdict. It only gets that right after a measured evidence period:

- **Shadow first.** It runs everything and logs what it *could* have skipped.
- **Entry bar.** A lane starts skipping only after enough observations with no miss.
- **Random audits.** A share of the reusable verdicts is re-run anyway, at random.
- **Suspended by a miss.** A test predicted reusable that fails is a recorder bug. The
  lane goes back to running whole until it re-earns the bar.

It cannot turn a red into a green: a failing file's footprint is dropped, a moved tree is
refused, and footprints older than 72 hours are never reused.

## Status

Tracegate was built and runs in production inside a private TypeScript monorepo of about
2,700 backend and 1,000 frontend test files. It sits in a local merge gate that batches
pull requests into merge trains and bisects a red train automatically.

**This repository is not the code yet.** It holds the findings and the plan for turning
Tracegate into a standalone tool and adding model-assisted decisions to it. Read
[ROADMAP.md](ROADMAP.md).

## The idea in one paragraph

Most AI-in-CI products try to *fix* or *skip*. They publish no failure rates and have a
documented habit of silencing tests. Tracegate CI goes the other way. The first model in
the gate may only make it **stricter**: it reads every red the gate wants to write off as
a flake and may escalate it to a real bug, never the reverse. Model decisions are cached
by input hash, so a gate is replayable. They run in shadow before they decide anything,
and the model gets no tools and no credentials.
