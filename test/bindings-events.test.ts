import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { Registry, type ProtocolEvent } from "../src/index.ts";
import {
  CloudEventSink,
  fromCloudEvent,
  httpCloudEventSink,
  toCloudEvent,
  type CloudEvent,
} from "../src/bindings/events/index.ts";
import { setup, smokeRequest } from "./helpers.ts";

const CLOUDEVENT = "urn:runtime-protocol:bindings:events:0.1:cloudevent";
const registry = Registry.core();

test("events/0.1: every optional field survives the CloudEvents round trip", () => {
  const event: ProtocolEvent = {
    protocol: "runtime/0.1",
    id: "evt_9",
    type: "communication.sent",
    source: "runtime://support-runtime",
    time: "2026-01-01T00:00:00.000Z",
    subject: { ref: "resource://outbox/msg-1", type: "message", version: "2" },
    causation: {
      execution_id: "exec_1",
      request_id: "req_1",
      observation_id: "obs_1",
      event_id: "evt_8",
    },
    correlation_id: "case-1234",
    data: { capability: { id: "communication.send", version: "0.1.0" } },
    extensions: { "org.acme": { queue: "priority", attempt: 1 } },
  };
  const cloud = toCloudEvent(event);
  assert.deepEqual(registry.schemas.validate(CLOUDEVENT, cloud), []);
  assert.equal(cloud["subjectversion"], "2");
  assert.equal(cloud["causationid"], "evt_8");
  // Extensions travel as RFC 8785 canonical JSON text.
  assert.equal(cloud["runtimeextensions"], '{"org.acme":{"attempt":1,"queue":"priority"}}');
  assert.deepEqual(fromCloudEvent(JSON.parse(JSON.stringify(cloud))), event);
});

test("events/0.1: execution events publish as valid CloudEvents through a sink", async () => {
  const published: CloudEvent[] = [];
  const { runtime } = setup({ events: new CloudEventSink((event) => void published.push(event)) });
  const outcome = await runtime.execute(smokeRequest);
  assert.equal(outcome.execution.state, "completed");
  assert.ok(published.length > 0);
  for (const cloud of published) {
    assert.deepEqual(registry.schemas.validate(CLOUDEVENT, cloud), [], cloud.type);
    assert.equal(cloud["runtimeprotocol"], "runtime/0.1");
    assert.equal(cloud["executionid"], outcome.execution.execution_id);
  }
  const sent = published.find((e) => e.type === "communication.sent");
  assert.ok(sent, "communication.sent is published");
  assert.equal(sent["requestid"], smokeRequest.request_id);
  assert.deepEqual(
    fromCloudEvent(sent),
    outcome.events.find((e) => e.type === "communication.sent"),
  );
});

test("events/0.1: the HTTP sink posts structured-mode CloudEvents", async () => {
  const received: Array<{ contentType: string | undefined; body: CloudEvent }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      received.push({
        contentType: req.headers["content-type"],
        body: JSON.parse(body) as CloudEvent,
      });
      res.writeHead(req.url === "/reject" ? 500 : 202).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const event: ProtocolEvent = {
      protocol: "runtime/0.1",
      id: "evt_1",
      type: "knowledge.searched",
      source: "runtime://support-runtime",
      time: "2026-01-01T00:00:00.000Z",
      data: {},
    };
    await httpCloudEventSink(`http://127.0.0.1:${port}/events`).publish(event);
    assert.equal(received[0]?.contentType, "application/cloudevents+json");
    assert.deepEqual(fromCloudEvent(received[0]!.body), event);
    await assert.rejects(
      Promise.resolve(httpCloudEventSink(`http://127.0.0.1:${port}/reject`).publish(event)),
      /HTTP 500/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
