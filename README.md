# Runtime SDK

Reference TypeScript implementation of the [Runtime Protocol](https://github.com/Company-Runtime/runtime-protocol)
`runtime/0.1`: validation, authority, policy, provider resolution, the execution
pipeline, evidence and receipts, the HTTP, MCP and events bindings, and the
conformance runner.

> **Status: experimental.** It tracks the unreleased `runtime/0.1` protocol and passes
> the whole conformance suite at the protocol commit pinned in
> [`protocol.lock.json`](protocol.lock.json).

The protocol repository is the source of truth. This SDK never defines vocabulary: the
registry, schemas and conformance cases are generated from a pinned protocol commit
into [`src/protocol/bundle.generated.ts`](src/protocol/bundle.generated.ts).

## Packages

One package, `@runtime-protocol/sdk`, with subpath exports:

| Import                              | Contents                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `@runtime-protocol/sdk`             | Types, registry, validation, authority, policy, credentials, resolver, runtime, provider SDK      |
| `@runtime-protocol/sdk/http`        | `http/0.1`: runtime API handler and client, provider API, remote providers                        |
| `@runtime-protocol/sdk/mcp`         | `mcp/0.1`: runtime as MCP server (stdio), MCP tools as adapters, runtime federation               |
| `@runtime-protocol/sdk/events`      | `events/0.1`: lossless CloudEvents mapping and sinks                                              |
| `@runtime-protocol/sdk/reference`   | An in-process reference provider (`communication.send`, `knowledge.search`, `reasoning.classify`) |
| `@runtime-protocol/sdk/conformance` | Conformance runner, scripted providers and the provider harness                                   |

## Install

Until the package is published, install it from Git at a commit:

```bash
pnpm add github:Company-Runtime/runtime-sdk#<commit>
```

The package builds itself on install (`prepare`). With pnpm 10, allow that build in
the consuming project's `package.json`:

```json
{ "pnpm": { "onlyBuiltDependencies": ["@runtime-protocol/sdk"] } }
```

Node.js 22.18 or later is required.

## Quick start

```ts
import {
  createRuntime,
  EnvCredentialBroker,
  GrantAuthority,
  verifyReceipt,
} from "@runtime-protocol/sdk";
import { createReferenceProvider } from "@runtime-protocol/sdk/reference";

const runtime = createRuntime({
  providers: [createReferenceProvider()],
  // Deny by default: only granted capabilities can be requested.
  authority: new GrantAuthority([
    {
      id: "support",
      authority: "authority://company/support-manager",
      subjects: ["identity://agent/support-agent"],
      capabilities: ["communication.send"],
    },
  ]),
  // A binding is a reference. The key itself stays in the environment
  // (RUNTIME_SECRET_ORGANIZATION_PROVIDERS_REFERENCE) and is materialized only at dispatch.
  credentials: {
    bindings: [{ provider: "reference", ref: "secret://organization/providers/reference" }],
    broker: new EnvCredentialBroker(),
  },
});

const outcome = await runtime.execute({
  capability: "communication.send",
  profile: "email",
  traits: { required: ["delivery_receipt"] },
  actor: "identity://agent/support-agent",
  input: {
    recipients: ["identity://customer/981"],
    subject: "Account update",
    content: "Your account has been updated.",
  },
  evidence: { require: ["execution", "delivery"] },
});

outcome.execution.state; // "completed" — only because execution and delivery were proven
verifyReceipt(outcome.receipt!); // true: RFC 8785 canonical JSON, SHA-256
```

The caller names an intent, never a provider, a transport or a key. The runtime
validates the request, evaluates authority and policy before any provider is
involved, resolves an eligible provider deterministically, dispatches, and completes
the execution only when the required evidence exists.

## Writing a provider

```ts
import { defineProvider, ProviderFailure } from "@runtime-protocol/sdk";

export const provider = defineProvider({
  id: "acme-mail",
  capabilities: [
    {
      capability: "communication.send",
      profiles: ["email"],
      traits: ["delivery_receipt", "idempotency"],
    },
  ],
  credentials: { required: true, accepts: ["organization"] },
  handlers: {
    "communication.send": async (input, ctx) => {
      const key = await ctx.credential(); // materialized at dispatch; never log or return it
      const receipt = await sendThroughYourSystem(input, key, ctx.idempotencyKey, ctx.signal);
      if (receipt.rejected) throw new ProviderFailure("the recipient was rejected before sending");
      return {
        output: {
          message: { ref: `resource://acme-mail/messages/${receipt.id}` },
          accepted_recipients: input.recipients,
        },
        evidence: [
          ctx.evidence.providerReceipt(["execution", "delivery"], { message_id: receipt.id }),
        ],
      };
    },
  },
});
```

`defineProvider` validates the input against the capability schema before the handler
runs, reports `ProviderFailure` as `failed` (proof that nothing happened) and any other
error as `unknown`. `fetchJson` calls vendor HTTP APIs with the same discipline: a
request that never left is `provider_unavailable`, a 4xx answer is a failure, and a
5xx answer or an interruption after sending is `unknown`. Verify a provider against requirements `PC-001`–`PC-010`:

```bash
runtime-conformance provider ./dist/provider.js --export provider --samples samples.yaml
```

## Bindings

- **HTTP** — `createHttpHandler(runtime, { authenticate })` serves the runtime API
  (`serve()` for Node.js); `RuntimeHttpClient` calls it. `createProviderHttpHandler`
  and `connectRemoteProvider` run providers behind the provider API; a provider that
  cannot be reached fails with `provider_unavailable` and no effect. `publicRoutes`
  leaves the manifest and health routes unauthenticated, and `credentials` may be a
  function of the request, for a broker that needs the caller's transport credentials.
- **MCP** — `createMcpServer(runtime, { actor })` exposes resolvable capabilities as
  tools (`communication__send`), over stdio with `serveStdio`. The actor comes from the
  session, never from tool arguments. `mcpToolProvider` implements a capability with a
  downstream MCP tool; `mcpRuntimeProvider` delegates to another runtime and reconciles
  its uncertain outcomes without repeating effects.
- **Events** — `toCloudEvent` / `fromCloudEvent` are lossless; `CloudEventSink` and
  `httpCloudEventSink` publish execution events.

## Guarantees

- Authority is deny-by-default and evaluated, with policy, before any provider.
- `completed` requires the evidence for every required claim; a mutating execution
  without it is `unknown`, never `completed`.
- `unknown` is reconciled, never blindly retried; idempotency keys are always
  forwarded for mutating capabilities.
- Secrets are never transported: requests, manifests, results, evidence, receipts,
  events and errors are checked, and error messages are redacted.
- Receipts are canonical and integrity-protected; they record the credential owner,
  never the credential.

## Conformance

```bash
pnpm conformance
```

runs the bundled `runtime/0.1` conformance suite against this runtime (58/58 cases
pass). The claim is "runtime/0.1 conformance suite 0.1.0, runtime level, passed" at the
commit in `protocol.lock.json`.

## Development

```bash
pnpm install
pnpm run ci            # format, types, build, tests
pnpm conformance
pnpm protocol:sync --from ../runtime-protocol   # regenerate from a clean protocol checkout
pnpm protocol:check --from ../runtime-protocol  # verify the bundle against the lock
```

Sources are TypeScript run natively by Node.js (type stripping); `pnpm build` emits
JavaScript and declarations to `dist/`.

Not in scope for this SDK: persistent stores (implement `ExecutionStore`), a policy
language beyond policy sets, provider marketplaces, billing, and product UI.

## License

[Apache License 2.0](LICENSE).
