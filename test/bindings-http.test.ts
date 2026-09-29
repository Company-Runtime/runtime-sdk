import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRuntime,
  InMemoryCredentialBroker,
  SequentialIds,
  verifyReceipt,
} from "../src/index.ts";
import { createServer } from "node:net";
import {
  connectRemoteProvider,
  createHttpHandler,
  createProviderHttpHandler,
  remoteProvider,
  RuntimeHttpClient,
  serve,
} from "../src/bindings/http/index.ts";
import { createReferenceProvider } from "../src/reference/index.ts";
import { grants, ORG_KEY, ORG_KEY_REF, setup, smokeRequest, SUPPORT_AGENT } from "./helpers.ts";

test("http/0.1 runtime API: execute, read, receipt, evidence and discovery over HTTP", async () => {
  const { runtime } = setup();
  const handler = createHttpHandler(runtime, {
    authenticate: (req) =>
      req.headers.get("authorization") === "Bearer agent-token"
        ? { ref: SUPPORT_AGENT }
        : undefined,
  });
  const server = await serve(handler);
  try {
    const client = new RuntimeHttpClient({
      baseUrl: server.url,
      headers: { authorization: "Bearer agent-token" },
    });
    const outcome = await client.execute(smokeRequest);
    assert.equal(outcome.execution.state, "completed");
    assert.ok(outcome.receipt && verifyReceipt(outcome.receipt));
    const read = await client.getOutcome(outcome.execution.execution_id);
    assert.equal(read.execution.state, "completed");
    const receipt = await client.getReceipt(outcome.execution.execution_id);
    assert.equal(receipt?.receipt.execution_id, outcome.execution.execution_id);
    const evidence = await client.getEvidence(outcome.execution.evidence[0]!);
    assert.equal(evidence?.execution_id, outcome.execution.execution_id);
    const discovery = await client.discovery();
    assert.equal(discovery.bindings[0]?.endpoint, `${server.url}/`);

    // Actor binding: a caller cannot act as someone else, and anonymous callers are refused.
    const other = await fetch(`${server.url}/executions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
      body: JSON.stringify({
        ...smokeRequest,
        request_id: "req_x",
        actor: { ref: "identity://user/founder" },
      }),
    });
    assert.equal(other.status, 403);
    const anonymous = await fetch(`${server.url}/executions/${outcome.execution.execution_id}`);
    assert.equal(anonymous.status, 403);
    const wrongProtocol = await fetch(`${server.url}/executions`, {
      method: "POST",
      headers: { "runtime-protocol": "runtime/9.9" },
      body: "{}",
    });
    assert.equal(wrongProtocol.status, 400);
    const denied = await fetch(`${server.url}/executions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
      body: JSON.stringify({
        ...smokeRequest,
        request_id: "req_denied",
        authority: { ref: "authority://company/founder" },
      }),
    });
    assert.equal(denied.status, 403);
    assert.equal(
      ((await denied.json()) as { execution: { state: string } }).execution.state,
      "rejected",
    );
  } finally {
    await server.close();
  }
});

test("http/0.1 provider API: a remote provider materializes its own credential", async () => {
  const reference = createReferenceProvider({ id: "remote-reference" });
  const providerServer = await serve(
    createProviderHttpHandler(reference, {
      credentials: new InMemoryCredentialBroker({ [ORG_KEY_REF]: ORG_KEY }),
      authenticate: (req) => req.headers.get("authorization") === "Bearer runtime-token",
    }),
  );
  try {
    const remote = await connectRemoteProvider({
      url: providerServer.url,
      headers: { authorization: "Bearer runtime-token" },
    });
    // The runtime side only holds the reference; the provider side holds the secret.
    const runtime = createRuntime({
      providers: [remote],
      authority: grants,
      credentials: {
        bindings: [{ provider: "remote-reference", ref: ORG_KEY_REF }],
        broker: {
          has: () => true,
          materialize: () => {
            throw new Error("never on this side");
          },
        },
      },
      ids: new SequentialIds(),
    });
    const outcome = await runtime.execute(smokeRequest);
    assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
    assert.equal(reference.outbox.length, 1);
    assert.ok(!JSON.stringify(outcome).includes(ORG_KEY));
  } finally {
    await providerServer.close();
  }
});

test("http/0.1 provider API: public discovery routes and a per-request credential broker", async () => {
  const reference = createReferenceProvider({ id: "remote-reference" });
  const authenticate = (req: Request) =>
    req.headers.get("authorization") === "Bearer runtime-token";
  const brokers: string[] = [];
  const providerServer = await serve(
    createProviderHttpHandler(reference, {
      authenticate,
      publicRoutes: ["manifest", "health"],
      // The broker sees the request, so it can use the caller's transport credentials.
      credentials: (req) => {
        brokers.push(req.headers.get("authorization") ?? "");
        return new InMemoryCredentialBroker({ [ORG_KEY_REF]: ORG_KEY });
      },
    }),
  );
  const closedServer = await serve(createProviderHttpHandler(reference, { authenticate }));
  try {
    assert.equal((await fetch(`${providerServer.url}/.well-known/runtime-provider`)).status, 200);
    assert.equal((await fetch(`${providerServer.url}/health`)).status, 200);
    const anonymous = await fetch(`${providerServer.url}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(anonymous.status, 401);
    // Without publicRoutes, every route still authenticates.
    const closed = await fetch(`${closedServer.url}/.well-known/runtime-provider`);
    assert.equal(closed.status, 401);
    assert.equal((await fetch(`${closedServer.url}/health`)).status, 401);

    const remote = await connectRemoteProvider({
      url: providerServer.url,
      headers: { authorization: "Bearer runtime-token" },
    });
    const runtime = createRuntime({
      providers: [remote],
      authority: grants,
      credentials: {
        bindings: [{ provider: "remote-reference", ref: ORG_KEY_REF }],
        broker: {
          has: () => true,
          materialize: () => {
            throw new Error("never on this side");
          },
        },
      },
      ids: new SequentialIds(),
    });
    const outcome = await runtime.execute(smokeRequest);
    assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
    assert.equal(reference.outbox.length, 1);
    // Discovery and health never built a broker; the invocation built one from its request.
    assert.deepEqual(brokers, ["Bearer runtime-token"]);
  } finally {
    await providerServer.close();
    await closedServer.close();
  }
});

test("an unreachable remote provider fails without effects", async () => {
  const reference = createReferenceProvider({
    id: "gone",
    credentials: { required: false, accepts: [] },
  });
  const port = await closedPort();
  const runtime = createRuntime({
    providers: [remoteProvider({ url: `http://127.0.0.1:${port}`, manifest: reference.manifest })],
    authority: grants,
  });
  const outcome = await runtime.execute({
    capability: "knowledge.search",
    input: { query: "x" },
    actor: SUPPORT_AGENT,
  });
  assert.equal(outcome.execution.state, "failed");
  assert.equal(outcome.error?.code, "provider_unavailable");
});

/** A local port that nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
