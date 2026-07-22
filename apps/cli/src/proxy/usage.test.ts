import { describe, expect, it } from "vitest";

import { normalizeRawUsage, usageFromJsonBody, usageFromStreamChunks } from "./usage";

describe("normalizeRawUsage", () => {
  it("handles Anthropic usage shape", () => {
    const usage = normalizeRawUsage({
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
      input_tokens: 100,
      output_tokens: 200,
    });
    expect(usage).toEqual({
      cacheCreationTokens: 10,
      cacheReadTokens: 20,
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 330,
    });
  });

  it("handles OpenAI usage shape", () => {
    const usage = normalizeRawUsage({
      completion_tokens: 5,
      prompt_tokens: 7,
      total_tokens: 12,
    });
    expect(usage).toEqual({
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      inputTokens: 7,
      outputTokens: 5,
      totalTokens: 12,
    });
  });

  it("coerces string numbers and defaults to zero", () => {
    const usage = normalizeRawUsage({
      input_tokens: "50",
      output_tokens: 0,
    });
    expect(usage.inputTokens).toBe(50);
    expect(usage.outputTokens).toBe(0);
    expect(usage.totalTokens).toBe(50);
  });

  it("returns zeros for null", () => {
    const usage = normalizeRawUsage(null);
    expect(usage).toEqual({
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });
});

describe("usageFromJsonBody", () => {
  it("reads OpenAI top-level usage", () => {
    const usage = usageFromJsonBody({
      choices: [{ message: { content: "hi" } }],
      usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
    });
    expect(usage.inputTokens).toBe(2);
    expect(usage.outputTokens).toBe(1);
    expect(usage.totalTokens).toBe(3);
  });

  it("reads Anthropic nested usage", () => {
    const usage = usageFromJsonBody({
      content: [{ text: "hi", type: "text" }],
      usage: { input_tokens: 4, output_tokens: 9 },
    });
    expect(usage.inputTokens).toBe(4);
    expect(usage.outputTokens).toBe(9);
  });

  it("returns zeros when no usage is present", () => {
    const usage = usageFromJsonBody({ ok: true });
    expect(usage.totalTokens).toBe(0);
  });
});

describe("usageFromStreamChunks", () => {
  it("takes max-seen per field across chunks (Anthropic cumulative)", () => {
    const chunks = [
      { type: "message_start", usage: { input_tokens: 100, output_tokens: 0 } },
      { type: "content_block_delta" },
      { type: "message_delta", usage: { input_tokens: 100, output_tokens: 250 } },
    ];
    const usage = usageFromStreamChunks(chunks);
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(250);
    expect(usage.totalTokens).toBe(350);
  });

  it("aggregates OpenAI streaming final usage chunk", () => {
    const chunks = [
      { choices: [{ delta: { content: "a" } }] },
      { choices: [{ delta: { content: "b" } }] },
      {
        choices: [{ delta: {} }],
        usage: { completion_tokens: 7, prompt_tokens: 3, total_tokens: 10 },
      },
    ];
    const usage = usageFromStreamChunks(chunks);
    expect(usage.inputTokens).toBe(3);
    expect(usage.outputTokens).toBe(7);
    expect(usage.totalTokens).toBe(10);
  });
});
