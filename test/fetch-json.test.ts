import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  createRuntime,
  defineProvider,
  fetchJson,
  GrantAuthority,
  ProviderFailure,
  ProviderUnreachableError,
} from "../src/index.ts";

/** A local API whose answer is chosen by the request path. */
async function api(): Promise<{
  url: string;
  server: Server;
  seen: Array<{ method?: string; url?: string; body: string; type?: string }>;
}> {
  const seen: Array<{ method?: string; url?: string; body: string; type?: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body, type: req.headers["content-type"] });
      const path = req.url?.split("?")[0];
      const json = (status: number, value: unknown) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (path === "/ok") return json(200, { id: 7 });
      if (path === "/empty") return res.writeHead(204).end();
      if (path === "/html")
        return res.writeHead(200, { "content-type": "text/html" }).end("<html>");
      if (path === "/unauthorized")
        return json(401, { message: "Bad credentials for key canary-key-9f1e" });
      if (path === "/missing") return json(404, { error: { message: "Not Found" } });
      if (path === "/limited") return json(429, { error: "rate_limited" });
      if (path === "/broken") return json(502, { message: "upstream" });
      if (path === "/slow") return void setTimeout(() => json(200, {}), 500);
      json(500, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, seen };
}

test("fetchJson returns JSON and sends JSON bodies and queries", async () => {
  const { url, server, seen } = await api();
  try {
    assert.deepEqual((await fetchJson(`${url}/ok`, { query: { page: 2, skip: undefined } })).body, {
      id: 7,
    });
    assert.equal(seen[0]?.url, "/ok?page=2");
    await fetchJson(`${url}/ok`, { body: { title: "x" } });
    assert.equal(seen[1]?.method, "POST");
    assert.equal(seen[1]?.type, "application/json");
    assert.equal(seen[1]?.body, '{"title":"x"}');
    assert.equal((await fetchJson(`${url}/empty`, { method: "DELETE" })).body, null);
    // Statuses the caller interprets itself come back with their body.
    const conflict = await fetchJson(`${url}/missing`, { accept: [404] });
    assert.equal(conflict.status, 404);
    assert.deepEqual(conflict.body, { error: { message: "Not Found" } });
  } finally {
    server.close();
  }
});

test("fetchJson classifies failures by what they prove about effects", async () => {
  const { url, server } = await api();
  const failure = async (path: string) => {
    try {
      await fetchJson(`${url}${path}`, { api: "the example API", redact: ["canary-key-9f1e"] });
    } catch (error) {
      return error;
    }
    assert.fail(`${path} did not fail`);
  };
  try {
    const unauthorized = await failure("/unauthorized");
    assert.ok(unauthorized instanceof ProviderFailure);
    assert.equal(unauthorized.code, "credential_unavailable");
    assert.equal(
      unauthorized.message,
      "the example API answered HTTP 401: Bad credentials for key [REDACTED]",
    );
    const missing = await failure("/missing");
    assert.ok(missing instanceof ProviderFailure && missing.code === "execution_failed");
    assert.match(missing.message, /HTTP 404: Not Found$/);
    const limited = await failure("/limited");
    assert.ok(
      limited instanceof ProviderFailure &&
        limited.code === "provider_unavailable" &&
        limited.retryable,
    );
    // Server errors and unreadable answers prove nothing: the outcome is unknown.
    for (const path of ["/broken", "/html"]) {
      const error = await failure(path);
      assert.ok(error instanceof Error && !(error instanceof ProviderFailure), path);
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      fetchJson(`${url}/slow`, { signal: controller.signal }),
      (error: unknown) => !(error instanceof ProviderFailure) && /interrupted/.test(String(error)),
    );
  } finally {
    server.close();
  }
  // Nothing listens on the port: the request was never sent.
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as { port: number };
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  await assert.rejects(fetchJson(`http://127.0.0.1:${port}/ok`), ProviderUnreachableError);
});

test("a provider whose vendor API cannot be reached fails with provider_unavailable", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as { port: number };
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  let calls = 0;
  const provider = defineProvider({
    id: "vendor-kb",
    capabilities: ["knowledge.search", "resource.delete"],
    reconcile: { "resource.delete": () => ({ status: "inconclusive", reason: "unknown" }) },
    handlers: {
      "knowledge.search": async (_input, ctx) => {
        calls++;
        await fetchJson(`http://127.0.0.1:${port}/search`, { signal: ctx.signal });
        return { output: { results: [] } };
      },
      "resource.delete": async (_input, ctx) => {
        calls++;
        await fetchJson(`http://127.0.0.1:${port}/delete`, {
          method: "DELETE",
          signal: ctx.signal,
        });
        return { output: {} };
      },
    },
  });
  const runtime = createRuntime({
    providers: [provider],
    authority: new GrantAuthority([
      {
        id: "agent",
        authority: "authority://company/operations",
        subjects: ["identity://agent/a"],
        capabilities: ["knowledge.search", "resource.delete"],
      },
    ]),
  });
  const search = await runtime.execute({
    capability: "knowledge.search",
    actor: "identity://agent/a",
    input: { query: "x" },
  });
  assert.equal(search.execution.state, "failed");
  assert.equal(search.error?.code, "provider_unavailable");
  // Even a mutating capability fails outright: the request never left.
  const deletion = await runtime.execute({
    capability: "resource.delete",
    actor: "identity://agent/a",
    resource: "resource://records/1",
    input: { resource: "resource://records/1" },
  });
  assert.equal(deletion.execution.state, "failed");
  assert.equal(deletion.error?.code, "provider_unavailable");
  assert.equal(calls, 2);
});
