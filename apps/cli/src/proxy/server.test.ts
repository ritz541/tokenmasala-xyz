import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProxyServer, type UsageEventInput } from "./server";

const OPENAI_MODELS_PATH = "/v1/chat/completions";
const ANTHROPIC_MESSAGES_PATH = "/v1/messages";

interface MockUpstream {
  readonly server: Server;
  readonly url: string;
  readonly requests: Array<{ body: unknown; headers: Record<string, string | undefined> }>;
}

function startMockUpstream(respond: (req: { method?: string; body: unknown }) => {
  status: number;
  contentType: string;
  body: string;
}): MockUpstream {
  const requests: MockUpstream["requests"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key] = Array.isArray(value) ? value.join(",") : value;
      }
      requests.push({ body, headers });
      const { status, contentType, body: payload } = respond({ method: req.method, body });
      res.statusCode = status;
      res.setHeader("content-type", contentType);
      res.end(payload);
    });
  });
  server.listen(0);
  const address = server.address() as AddressInfo;

  return {
    requests,
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function openaiNonStreamResponse(model: string) {
  return {
    body: JSON.stringify({
      choices: [{ message: { content: "hello" } }],
      model,
      usage: { completion_tokens: 10, prompt_tokens: 20, total_tokens: 30 },
    }),
    contentType: "application/json",
    status: 200,
  };
}

function anthropicNonStreamResponse(model: string) {
  return {
    body: JSON.stringify({
      content: [{ text: "hello", type: "text" }],
      model,
      usage: { input_tokens: 40, output_tokens: 50 },
    }),
    contentType: "application/json",
    status: 200,
  };
}

function openaiStreamResponse(model: string) {
  const payload = [
    "data: " + JSON.stringify({ choices: [{ delta: { content: "h" } }] }),
    "data: " + JSON.stringify({ choices: [{ delta: { content: "i" } }] }),
    "data: " +
      JSON.stringify({
        choices: [{ delta: {} }],
        usage: { completion_tokens: 3, prompt_tokens: 4, total_tokens: 7 },
      }),
    "data: [DONE]",
  ].join("\n\n");
  return { body: payload, contentType: "text/event-stream", status: 200 };
}

describe("proxy server", () => {
  let upstream: MockUpstream;
  let captured: UsageEventInput[];
  let proxyPromise: Promise<{ port: number; stop: () => Promise<void> }>;

  afterEach(async () => {
    const proxy = await proxyPromise;
    await proxy?.stop().catch(() => {});
    await new Promise<void>((resolve) => upstream?.server.close(() => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  });

  function startProxy(label?: string) {
    captured = [];
    proxyPromise = createProxyServer(
      0,
      {
        label,
        upload: async (events) => {
          captured.push(...events);
        },
      },
      { OPENAI_BASE_URL: upstream.url, ANTHROPIC_BASE_URL: upstream.url },
    );
    return proxyPromise;
  }

  async function post(path: string, body: unknown) {
    const proxy = await proxyPromise;
    const res = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await res.text();
    return { status: res.status, text };
  }

  it("forwards an OpenAI request and captures usage", async () => {
    upstream = startMockUpstream(() => openaiNonStreamResponse("gpt-4o"));
    startProxy();

    const { status } = await post(OPENAI_MODELS_PATH, { messages: [], model: "gpt-4o" });
    expect(status).toBe(200);

    // Wait for the async capture + upload to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(captured.length).toBe(1);
    expect(captured[0]!.source).toBe("openai");
    expect(captured[0]!.model).toBe("gpt-4o");
    expect(captured[0]!.inputTokens).toBe(20);
    expect(captured[0]!.outputTokens).toBe(10);
    expect(captured[0]!.totalTokens).toBe(30);
    expect(captured[0]!.costUsd).toBeGreaterThan(0);
  });

  it("prefers the explicit --label over the inferred family", async () => {
    upstream = startMockUpstream(() => openaiNonStreamResponse("gpt-4o"));
    startProxy("my-vscode-ext");

    await post(OPENAI_MODELS_PATH, { messages: [], model: "gpt-4o" });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(captured.length).toBe(1);
    expect(captured[0]!.source).toBe("my-vscode-ext");
  });

  it("infers anthropic family from /v1/messages", async () => {
    upstream = startMockUpstream(() => anthropicNonStreamResponse("claude-3-5-sonnet-20241022"));
    startProxy();

    const { status } = await post(ANTHROPIC_MESSAGES_PATH, {
      max_tokens: 100,
      messages: [],
      model: "claude-3-5-sonnet-20241022",
    });
    expect(status).toBe(200);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(captured.length).toBe(1);
    expect(captured[0]!.source).toBe("anthropic");
    expect(captured[0]!.model).toBe("claude-3-5-sonnet-20241022");
    expect(captured[0]!.inputTokens).toBe(40);
    expect(captured[0]!.outputTokens).toBe(50);
  });

  it("captures usage from a streaming (SSE) response", async () => {
    upstream = startMockUpstream(() => openaiStreamResponse("gpt-4o-mini"));
    const proxy = await startProxy();

    const res = await fetch(`http://127.0.0.1:${proxy.port}${OPENAI_MODELS_PATH}`, {
      body: JSON.stringify({ messages: [], model: "gpt-4o-mini", stream: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await res.text();
    expect(text).toContain("data: [DONE]");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(captured.length).toBe(1);
    expect(captured[0]!.inputTokens).toBe(4);
    expect(captured[0]!.outputTokens).toBe(3);
    expect(captured[0]!.totalTokens).toBe(7);
  });

  it("captures nothing for a request with no usage", async () => {
    upstream = startMockUpstream(() => ({
      body: JSON.stringify({ ok: true }),
      contentType: "application/json",
      status: 200,
    }));
    await startProxy();

    await post("/v1/embeddings", { input: "hi", model: "text-embedding-3-small" });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(captured.length).toBe(0);
  });

  it("honors an explicit X-TM-Upstream override header", async () => {
    upstream = startMockUpstream(() => openaiNonStreamResponse("gpt-4o"));
    const proxy = await startProxy();

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      body: JSON.stringify({ messages: [], model: "gpt-4o" }),
      headers: { "content-type": "application/json", "x-tm-upstream": upstream.url },
      method: "POST",
    });
    await res.text();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(captured.length).toBe(1);
    expect(upstream.requests.length).toBe(1);
  });
});
