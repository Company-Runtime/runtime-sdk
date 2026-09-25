import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonRpcRequest, McpServer } from "./server.ts";

/** Serves an MCP server over the stdio transport: newline-delimited JSON-RPC messages. */
export function serveStdio(
  server: McpServer,
  io: { input?: Readable; output?: Writable } = {},
): Promise<void> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending: Promise<void>[] = [];
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      output.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      return;
    }
    pending.push(
      server.handle(message).then((response) => {
        if (response) output.write(`${JSON.stringify(response)}\n`);
      }),
    );
  });
  return new Promise((resolve) =>
    lines.on("close", () => void Promise.all(pending).then(() => resolve())),
  );
}
