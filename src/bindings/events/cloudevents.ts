import { canonicalize, isRecord } from "../../json.ts";
import type { EventSink } from "../../events.ts";
import type { ProtocolEvent } from "../../types.ts";

export type CloudEvent = Record<string, unknown> & {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
};

/** events/0.1: protocol event → CloudEvents 1.0 structured JSON (bindings/events/README.md). */
export function toCloudEvent(event: ProtocolEvent): CloudEvent {
  const out: Record<string, unknown> = {
    specversion: "1.0",
    id: event.id,
    source: event.source,
    type: event.type,
    time: event.time,
  };
  if (event.subject) {
    out["subject"] = event.subject.ref;
    if (event.subject.type !== undefined) out["subjecttype"] = event.subject.type;
    if (event.subject.version !== undefined) out["subjectversion"] = event.subject.version;
  }
  out["datacontenttype"] = "application/json";
  out["runtimeprotocol"] = event.protocol;
  const c = event.causation ?? {};
  const attributes: Array<[string, unknown]> = [
    ["executionid", c.execution_id],
    ["requestid", c.request_id],
    ["observationid", c.observation_id],
    ["causationid", c.event_id],
    ["correlationid", event.correlation_id],
  ];
  for (const [name, value] of attributes) if (value !== undefined) out[name] = value;
  if (event.extensions !== undefined) out["runtimeextensions"] = canonicalize(event.extensions);
  out["data"] = event.data;
  return out as CloudEvent;
}

/** events/0.1: CloudEvent → protocol event; the inverse of `toCloudEvent`. */
export function fromCloudEvent(cloud: Record<string, unknown>): ProtocolEvent {
  const event: Record<string, unknown> = {
    protocol: cloud["runtimeprotocol"],
    id: cloud["id"],
    type: cloud["type"],
    source: cloud["source"],
    time: cloud["time"],
  };
  if (cloud["subject"] !== undefined)
    event["subject"] = {
      ref: cloud["subject"],
      ...(cloud["subjecttype"] !== undefined ? { type: cloud["subjecttype"] } : {}),
      ...(cloud["subjectversion"] !== undefined ? { version: cloud["subjectversion"] } : {}),
    };
  const causation: Record<string, unknown> = {};
  for (const [attribute, field] of [
    ["executionid", "execution_id"],
    ["requestid", "request_id"],
    ["observationid", "observation_id"],
    ["causationid", "event_id"],
  ] as const)
    if (cloud[attribute] !== undefined) causation[field] = cloud[attribute];
  if (Object.keys(causation).length > 0) event["causation"] = causation;
  if (cloud["correlationid"] !== undefined) event["correlation_id"] = cloud["correlationid"];
  event["data"] = isRecord(cloud["data"]) ? cloud["data"] : {};
  if (typeof cloud["runtimeextensions"] === "string")
    event["extensions"] = JSON.parse(cloud["runtimeextensions"]);
  return event as unknown as ProtocolEvent;
}

/** An event sink that forwards CloudEvents to a function (a queue, a broker client, …). */
export class CloudEventSink implements EventSink {
  readonly #send: (event: CloudEvent) => void | Promise<void>;

  constructor(send: (event: CloudEvent) => void | Promise<void>) {
    this.#send = send;
  }

  publish(event: ProtocolEvent): void | Promise<void> {
    return this.#send(toCloudEvent(event));
  }
}

/** Posts CloudEvents in structured mode to an HTTP endpoint. */
export function httpCloudEventSink(
  url: string,
  options: { fetch?: typeof fetch; headers?: Record<string, string> } = {},
): CloudEventSink {
  const doFetch = options.fetch ?? fetch;
  return new CloudEventSink(async (event) => {
    const response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/cloudevents+json", ...options.headers },
      body: JSON.stringify(event),
    });
    if (!response.ok) throw new Error(`event endpoint answered HTTP ${response.status}`);
  });
}
