import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

type Handler = (request: Request) => Promise<Response>;

/** Adapts a fetch-style handler to node:http. */
export function toNodeListener(handler: Handler) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      else if (value !== undefined) headers.set(name, value);
    }
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method: req.method ?? "GET",
      headers,
      ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
    });
    const response = await handler(request);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

/** Starts a node:http server for a handler. Port 0 picks a free port. */
export async function serve(
  handler: Handler,
  options: { port?: number; host?: string } = {},
): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createServer(toNodeListener(handler));
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    server,
    url: `http://${options.host ?? "127.0.0.1"}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
