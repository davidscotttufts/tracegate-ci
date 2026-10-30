# Changelog

## 0.6.0 (unreleased): ready to install

- `tracegate init [--write] [--mcp]`: proposes lanes from the repository's Vitest projects
  and wires the recorder. It never overwrites an existing config.
- `tracegate doctor [--canary]`: checks the setup; the canary records one test file to
  confirm the recorder's seam still maps.
- Supported Vitest is now 4.1 to 5.x, tested per version in CI
  (`npm run test:vitest-matrix`).
- Ingest names the Vitest version when the seam degrades to safe.
- Claude Code plugin with marketplace (`.claude-plugin/`). It bundles:
  - the MCP server;
  - the `red-reader` and `deps-oracle` subagents;
  - the `tracegate-gate` and `tracegate-setup` skills;
  - a `PreToolUse` hook that queues agents' test runs through the broker.
- MCP Registry metadata (`server.json`, `mcpName`). The MCP server reports the package
  version.
- GitHub Actions: CI matrix and a tag-triggered npm publish with provenance.

## 0.5.0

- Phase 1b: an escalated `real` Red Reader opinion on a MISS raises `flake` to `hole`.
- Phase 2: the Conductor (fail-first order, merge-train advice), in shadow.
- Phase 3: the dependency rule for lockfile changes, plus the dependency oracle in shadow.
- Phase 0.5c: `lease --jobserver`.

## 0.4.0

- Phase 0.5b-1: `tracegate observe` / `observed`.
- Phase 1a: Red Reader packets, MCP tools and closed-world opinions.

## 0.3.0

- Phase 0.6: adaptive capacity (CPU, memory, pressure, swap, thermal).

## 0.2.0

- Phase 0.5: the broker (leases, priorities, backfill, preemption) and its MCP server.

## 0.1.0

- Phase 0: recorder, ledger, predictor (shadow, entry bar, audits, suspend on miss),
  replay and CLI, extracted from the host project.
