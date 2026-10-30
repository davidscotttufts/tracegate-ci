# Recipes: Tracegate with other tools

Tracegate decides which tests a change needs, queues the machine's test runs, and lands merge trains. Each tool below does a neighbouring job, and the recipes show how to combine them. None of these tools needs to know about Tracegate.

| Recipe | The other tool does | Tracegate adds |
|---|---|---|
| [claude-code-merge-queue](claude-code-merge-queue.md) | A FIFO landing queue for agent lanes | Selection and reuse in its check command, or a batched, bisecting train in place of the FIFO |
| [Edit-level guards](edit-guards.md) (protect-tests, TDD Guard, Probity) | Stops an agent from *editing* tests in bad ways | A check on the *verdict*: a skipped, focused or deleted test cannot pass as green |
| [Parallel agents in worktrees](worktrees.md) (Conductor, claude-squad, container-use) | Isolates agent sessions | One queue and one ledger shared by every worktree |
| [A `bin/ci` for TypeScript](bin-ci.md) | Rails 8.1's local CI script, as a pattern | The same one-command local CI, with evidence behind each skip |
