import { randomBytes } from "node:crypto";

export type IdPrefix = "req" | "exec" | "inv" | "ev" | "rcpt" | "evt" | "obs" | "apv";

export interface IdGenerator {
  next(prefix: IdPrefix): string;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID-style identifiers (time-ordered, 26 Crockford base-32 characters) with a type prefix. */
export class UlidGenerator implements IdGenerator {
  readonly #clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.#clock = clock;
  }

  next(prefix: IdPrefix): string {
    let time = this.#clock().getTime();
    let head = "";
    for (let i = 0; i < 10; i++) {
      head = CROCKFORD[time % 32]! + head;
      time = Math.floor(time / 32);
    }
    const bytes = randomBytes(16);
    let tail = "";
    for (let i = 0; i < 16; i++) tail += CROCKFORD[bytes[i]! % 32]!;
    return `${prefix}_${head}${tail}`;
  }
}

/** Deterministic identifiers for tests and conformance: `exec_0001`, `ev_0002`, … per prefix. */
export class SequentialIds implements IdGenerator {
  readonly #counters = new Map<IdPrefix, number>();

  next(prefix: IdPrefix): string {
    const n = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, "0")}`;
  }
}
