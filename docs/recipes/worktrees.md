# Parallel agents in worktrees

Conductor, claude-squad, vibe-kanban and similar tools give each agent session its own git worktree, and container-use gives each its own container. They isolate the sessions. They do not share the machine's cores between them: N worktrees each running `vitest` with every core starve each other. [Vitest #11559](https://github.com/vitest-dev/vitest/issues/11559) describes the same problem.

## Worktrees on one machine

Nothing to configure. Tracegate's ledger and broker live in the clone's **git common directory**, so every worktree of a clone shares:
- one queue (`npx tracegate queue` shows every session's runs);
- one footprint ledger, so a verdict recorded in one worktree is reusable in another at the same tree;
- one entry bar and one miss log per lane.

Give the agents the plugin (`/plugin install tracegate@tracegate`): its hook routes a bare `vitest` or `npm test` through `tracegate lease`, and the MCP server shows `queue_status` and `machine_load`.

## Containers (container-use, devcontainers)

A container has its own temp directory, so it cannot see the host's broker socket. Either:
- run one broker per container (the default) and size it with `broker.capacity`, a number or a share such as `"25%"`, so the containers together fit the machine; or
- mount the host's socket and set `TRACEGATE_BROKER_SOCKET` to it inside the container, so every container queues in one place. The ledger must then be the same path inside and outside the container.

A cgroup CPU quota is honoured automatically: the broker's capacity never exceeds the container's cores.
