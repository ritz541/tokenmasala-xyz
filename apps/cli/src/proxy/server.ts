/**
 * The local proxy forwarder (P2). It binds a single TCP port, forwards every
 * HTTP request to the real upstream API, and — for chat-completion responses —
 * captures token usage and turns it into a {@link UsageEventInput} that is
 * buffered and flushed to `POST /usage/events`.
 *
 * Design notes:
 * - Plain `node:http` + global `fetch` so it runs under both the Bun CLI and
 *   the vitest Node runner used in tests.
 * - Streaming (SSE) and non-streaming responses are handled uniformly: the
 *   response body is read in chunks, each chunk is forwarded to the client as
 *   it arrives, and the full text is parsed afterwards to extract usage.
 * - The upload step is injected (`upload`) so the command can use the real
 *   API client and tests can capture events without network I/O.
 */

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { estimateCostUsd } from "./pricing";
import { incomingHeadersToWeb, resolveTarget } from "./router";
import { usageFromJsonBody, usageFromStreamChunks, type UsageTokens } from "./usage";

const PROXY_USER_AGENT = "tokenmasala-proxy/0.5";

interface UsageEventInput {
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
  readonly date: string;
  readonly id: string;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly source: string;
  readonly totalTokens: number;
  readonly ts: number;
}

interface ProxyServerOptions {
  /** Upload buffered events to the API. May be a no-op for `--no-flush`. */
  readonly upload: (events: readonly UsageEventInput[]) => Promise<void>;
  /** Default source label when `--label` is not set; may be empty. */
  readonly label?: string | undefined;
  /** Flush the buffer at least this often (ms). */
  readonly flushIntervalMs?: number | undefined;
  /** Flush as soon as this many events are buffered. */
  readonly maxBuffer?: number | undefined;
}

interface ProxyServerHandle {
  readonly port: number;
  stop: () => Promise<void>;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BUFFER = 25;

function localDateString(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

async function readBody(request: IncomingMessage): Promise<{
  readonly json: unknown;
  readonly raw: Buffer;
}> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks);

  let json: unknown = null;
  if (raw.length > 0) {
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      json = null;
    }
  }

  return { json, raw };
}

function isEventStreamResponse(contentType: string | null, statusText: unknown): boolean {
  if (contentType !== null && contentType.toLowerCase().includes("text/event-stream")) {
    return true;
  }
  return false;
}

function looksLikeSse(text: string): boolean {
  return text.includes("\ndata: ") || text.startsWith("data: ") || text.includes("\r\ndata: ");
}

/** Parse an SSE buffer into the JSON objects carried by each `data:` line. */
function parseSseDataLines(text: string): unknown[] {
  const objects: unknown[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") {
      continue;
    }
    try {
      objects.push(JSON.parse(payload));
    } catch {
      // Ignore non-JSON SSE lines (comments, keep-alive, etc).
    }
  }

  return objects;
}

function extractUsage(text: string, isStream: boolean): UsageTokens {
  if (isStream || looksLikeSse(text)) {
    return usageFromStreamChunks(parseSseDataLines(text));
  }

  try {
    return usageFromJsonBody(JSON.parse(text));
  } catch {
    return usageFromJsonBody(null);
  }
}

async function forwardAndCapture(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyServerOptions,
  env: Record<string, string | undefined>,
  buffer: UsageEventInput[],
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  const target = resolveTarget({
    env,
    headers: incomingHeadersToWeb(request.headers),
    pathname,
  });

  // Strip optional provider-prefix routing segments so the upstream receives a
  // clean path (e.g. /openai/v1/chat/completions -> /v1/chat/completions).
  let forwardPath = pathname;
  if (forwardPath.startsWith("/openai/")) {
    forwardPath = `/${forwardPath.slice("/openai/".length)}`;
  } else if (forwardPath.startsWith("/anthropic/")) {
    forwardPath = `/${forwardPath.slice("/anthropic/".length)}`;
  } else if (forwardPath.startsWith("/google/")) {
    forwardPath = `/${forwardPath.slice("/google/".length)}`;
  }

  const upstreamUrl = `${target.upstreamBaseUrl}${forwardPath}${url.search}`;

  const { json: requestJson, raw: requestRaw } = await readBody(request);

  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }
    if (key.toLowerCase() === "host" || key.toLowerCase() === "content-length") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }
  headers.set("user-agent", PROXY_USER_AGENT);

  const model =
    (requestJson !== null && typeof requestJson === "object" && "model" in requestJson
      ? (requestJson as { model?: unknown }).model
      : undefined) ?? "unknown";
  const modelString = typeof model === "string" && model !== "" ? model : "unknown";

  const source = options.label && options.label.trim() !== ""
    ? options.label.trim()
    : target.family;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      body: requestRaw.length > 0 ? requestRaw : undefined,
      headers,
      method: request.method ?? "GET",
      redirect: "follow",
    });
  } catch (cause) {
    response.statusCode = 502;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "tokenmasala proxy upstream failure", cause: String(cause) }));
    return;
  }

  // Forward status + headers to the client.
  response.statusCode = upstreamResponse.status;
  for (const [key, value] of upstreamResponse.headers.entries()) {
    if (key.toLowerCase() === "content-encoding" || key.toLowerCase() === "transfer-encoding") {
      // We re-buffer the body, so do not claim a transfer encoding we won't honor.
      continue;
    }
    response.setHeader(key, value);
  }
  response.removeHeader("content-length");

  const upstreamIsStream = isEventStreamResponse(
    upstreamResponse.headers.get("content-type"),
    undefined,
  );

  // Read the upstream body fully, forwarding each chunk to the client.
  const chunks: Buffer[] = [];
  const reader = upstreamResponse.body?.getReader();
  if (reader === undefined) {
    response.end();
    return;
  }

  try {
    for (;;) {
      const next = await reader.read();
      if (next.done === true) {
        break;
      }
      const chunk = Buffer.from(next.value);
      chunks.push(chunk);
      response.write(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const text = Buffer.concat(chunks).toString("utf8");
  response.end();

  const usage = extractUsage(text, upstreamIsStream);
  if (
    usage.totalTokens <= 0 &&
    usage.inputTokens <= 0 &&
    usage.outputTokens <= 0 &&
    usage.cacheReadTokens <= 0 &&
    usage.cacheCreationTokens <= 0
  ) {
    // No measurable usage (e.g. a non-completion request). Nothing to record.
    return;
  }

  const now = new Date();
  const costUsd = estimateCostUsd(modelString, usage);
  const event: UsageEventInput = {
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    id: crypto.randomUUID(),
    costUsd,
    date: localDateString(now),
    inputTokens: usage.inputTokens,
    model: modelString,
    outputTokens: usage.outputTokens,
    source,
    totalTokens: usage.totalTokens,
    ts: now.getTime(),
  };

  buffer.push(event);
  // Flush promptly (not just on the interval) so the buffer does not grow and
  // events reach the API quickly for the live feed. Fire-and-forget so we do
  // not delay the response to the client.
  void flushBuffer(buffer, options);
}

async function flushBuffer(buffer: UsageEventInput[], options: ProxyServerOptions): Promise<void> {
  if (buffer.length === 0) {
    return;
  }
  const batch = buffer.splice(0, buffer.length);
  try {
    await options.upload(batch);
  } catch {
    // On upload failure, re-queue the batch so it is retried on the next tick
    // rather than silently dropped. The buffer is bounded by the OS process
    // lifetime; a permanently failing endpoint will grow it, which is
    // acceptable for a local dev proxy.
    buffer.unshift(...batch);
  }
}

function createProxyServer(
  port: number,
  options: ProxyServerOptions,
  env: Record<string, string | undefined> = process.env,
): Promise<ProxyServerHandle> {
  return (async () => {
  const buffer: UsageEventInput[] = [];
  const server: Server = createServer((request, response) => {
    void forwardAndCapture(request, response, options, env, buffer).catch((cause) => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
      }
      if (!response.writableEnded) {
        response.end(JSON.stringify({ error: "tokenmasala proxy internal error", cause: String(cause) }));
      }
    });
  });

  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const timer = setInterval(() => {
    void flushBuffer(buffer, options);
  }, flushIntervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const listeningPort =
    address !== null && typeof address === "object" ? address.port : port;

  return {
    port: listeningPort,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(timer);
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  })();
}

export { createProxyServer, extractUsage, looksLikeSse, parseSseDataLines };
export type { ProxyServerHandle, UsageEventInput };
