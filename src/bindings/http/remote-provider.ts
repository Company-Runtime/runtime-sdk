import { PROTOCOL } from "../../constants.ts";
import { ProviderUnreachableError, type Provider } from "../../provider.ts";
import { isUnreachable } from "../../transport.ts";
import type {
  Health,
  Invocation,
  ProviderManifest,
  ProviderResult,
  Reconciliation,
} from "../../types.ts";
import { PROTOCOL_HEADER } from "./status.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface RemoteProviderOptions {
  url: string;
  /** The provider manifest; fetched from /.well-known/runtime-provider by `connectRemoteProvider`. */
  manifest: ProviderManifest;
  fetch?: typeof fetch;
  /** Transport credentials of the runtime towards the provider (never provider API keys). */
  headers?: Record<string, string>;
  /**
   * Largest response body accepted from the provider, in bytes (1 MiB by default). A
   * larger answer to an invocation is refused unread, so its outcome is `unknown`.
   */
  maxResponseBytes?: number;
}

/** Reads a JSON body of at most `limit` bytes; a larger body is refused without buffering it. */
async function readJson(response: Response, limit: number): Promise<unknown> {
  const tooLarge = () => new Error("provider response exceeds the size limit");
  if (Number(response.headers.get("content-length") ?? "0") > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider response is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** A provider reached through the provider API of the http/0.1 binding. */
export function remoteProvider(options: RemoteProviderOptions): Provider {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const limit = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const post = async (path: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [PROTOCOL_HEADER]: PROTOCOL,
          ...options.headers,
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // Connection-level failures happen before the provider receives anything.
      if (isUnreachable(error)) throw new ProviderUnreachableError();
      throw error;
    }
    if (response.status !== 200) throw new Error(`provider answered HTTP ${response.status}`);
    return readJson(response, limit);
  };
  return {
    manifest: options.manifest,
    execute: async (invocation: Invocation, context) =>
      (await post("/invocations", invocation, context.signal)) as ProviderResult,
    reconcile: async (invocation: Invocation, context) =>
      (await post(
        `/invocations/${encodeURIComponent(invocation.invocation_id)}/reconcile`,
        invocation,
        context.signal,
      )) as Reconciliation,
    health: async () => {
      const response = await doFetch(`${base}/health`, {
        headers: { [PROTOCOL_HEADER]: PROTOCOL, ...options.headers },
      });
      return (await readJson(response, limit)) as Health;
    },
  };
}

/** Fetches a remote provider's manifest and returns the provider. */
export async function connectRemoteProvider(
  options: Omit<RemoteProviderOptions, "manifest">,
): Promise<Provider> {
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(
    `${options.url.replace(/\/+$/, "")}/.well-known/runtime-provider`,
    {
      headers: { [PROTOCOL_HEADER]: PROTOCOL, ...options.headers },
    },
  );
  if (response.status !== 200)
    throw new Error(`provider manifest unavailable (HTTP ${response.status})`);
  const manifest = await readJson(response, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
  return remoteProvider({ ...options, manifest: manifest as ProviderManifest });
}
