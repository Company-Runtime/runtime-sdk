# Changelog

All notable changes to `@runtime-protocol/sdk` are documented here. The SDK follows
Semantic Versioning; while the major version is `0`, a minor version may break.

## Unreleased — 0.1.0

Reference implementation of Runtime Protocol `runtime/0.1`, pinned to the protocol
commit in [`protocol.lock.json`](protocol.lock.json).

### Added

- Protocol bundle generated from a clean runtime-protocol checkout and pinned by
  commit and digest (`pnpm protocol:sync`, `pnpm protocol:check`).
- Deterministic validation: JSON Schemas, request validation steps 1–11, raw-secret
  detection, naming and namespace isolation, version ranges, registry overlays,
  deprecated aliases and provider manifests.
- Deny-by-default authority grants, policy sets with obligations and approval,
  credential bindings with a broker (materialization at dispatch only).
- Deterministic provider resolution with stage-ordered rejection reasons.
- Execution pipeline: the state machine, request identity, idempotency, deadlines,
  cancellation, approval, evidence-before-completion, uncertain outcomes and
  reconciliation, canonical RFC 8785 receipts and events.
- Provider SDK (`defineProvider`) with input validation, evidence helpers and typed
  failures; `fetchJson`, which classifies vendor HTTP failures by what they prove
  about effects; an in-process reference provider.
- Bindings: HTTP runtime API, client and provider API (`http/0.1`); MCP server over
  stdio, MCP tools as adapters and runtime federation over MCP (`mcp/0.1`); lossless
  CloudEvents mapping and sinks (`events/0.1`). The provider API handler can leave
  the manifest and health routes public (`publicRoutes`) and build its credential
  broker from each request.
- Conformance runner for the bundled suite (58/58 cases pass) and a provider harness
  for requirements `PC-001`–`PC-010`, with the `runtime-conformance` CLI.
