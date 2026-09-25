import type { ProtocolEvent } from "./types.ts";

/** Receives published events. Events are facts; they never authorize anything. */
export interface EventSink {
  publish(event: ProtocolEvent): void | Promise<void>;
}

/** Keeps events in memory, in publication order. */
export class InMemoryEventLog implements EventSink {
  readonly events: ProtocolEvent[] = [];

  publish(event: ProtocolEvent): void {
    this.events.push(structuredClone(event));
  }

  ofType(type: string): ProtocolEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}
