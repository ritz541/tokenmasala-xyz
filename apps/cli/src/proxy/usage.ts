/**
 * Token-usage extraction for the proxy. Both OpenAI-compatible and Anthropic
 * messages APIs report usage in the same shape we care about
 * (input/output/cache tokens), but the JSON keys differ slightly and the
 * usage may arrive either in a single non-streaming response body or spread
 * across SSE `usage` chunks at the end of a streaming response.
 *
 * We normalize every source into the shared {@link UsageTokens} shape.
 */

interface UsageTokens {
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

interface RawUsageLike {
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  completion_tokens?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  prompt_tokens?: unknown;
  total_tokens?: unknown;
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

/** Normalize a single usage object (from either provider shape). */
function normalizeRawUsage(raw: RawUsageLike | null | undefined): UsageTokens {
  if (raw === null || raw === undefined) {
    return {
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
  }

  // Anthropic messages API shape
  const inputTokens = toNumber(raw.input_tokens);
  const outputTokens = toNumber(raw.output_tokens);
  const cacheCreationTokens = toNumber(raw.cache_creation_input_tokens);
  const cacheReadTokens = toNumber(raw.cache_read_input_tokens);

  // OpenAI chat completions shape
  const promptTokens = toNumber(raw.prompt_tokens);
  const completionTokens = toNumber(raw.completion_tokens);
  const totalTokens = toNumber(raw.total_tokens);

  const resolvedInput = inputTokens > 0 ? inputTokens : promptTokens;
  const resolvedOutput = outputTokens > 0 ? outputTokens : completionTokens;

  return {
    cacheCreationTokens,
    cacheReadTokens,
    inputTokens: resolvedInput,
    outputTokens: resolvedOutput,
    totalTokens:
      totalTokens > 0
        ? totalTokens
        : resolvedInput + resolvedOutput + cacheCreationTokens + cacheReadTokens,
  };
}

/**
 * Extract usage from a fully-buffered non-streaming response body (already
 * parsed as JSON, or a raw string). Returns zeros if no usage is present.
 */
function usageFromJsonBody(body: unknown): UsageTokens {
  if (body === null || typeof body !== "object") {
    return normalizeRawUsage(null);
  }

  const obj = body as Record<string, unknown>;

  // OpenAI wraps usage at top level; Anthropic puts it under `usage`.
  if (obj.usage !== null && typeof obj.usage === "object") {
    return normalizeRawUsage(obj.usage as RawUsageLike);
  }

  if ("prompt_tokens" in obj || "completion_tokens" in obj || "total_tokens" in obj) {
    return normalizeRawUsage(obj as unknown as RawUsageLike);
  }

  return normalizeRawUsage(null);
}

/**
 * Accumulate usage across streamed SSE chunks. Each chunk may carry a partial
 * `usage` object; the final aggregate is the last-seen values summed across
 * chunks (Anthropic's streaming `usage` is cumulative per chunk, so we take
 * the max-seen for each field to avoid double counting).
 */
function usageFromStreamChunks(chunks: readonly unknown[]): UsageTokens {
  let accumulated: UsageTokens = {
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== "object") {
      continue;
    }

    const obj = chunk as Record<string, unknown>;
    const rawUsage =
      obj.usage !== null && typeof obj.usage === "object"
        ? (obj.usage as RawUsageLike)
        : obj;
    const normalized = normalizeRawUsage(rawUsage);

    // Take the max-seen per field — streaming providers report cumulative or
    // final totals in the last chunk, so max is the correct aggregate.
    accumulated = {
      cacheCreationTokens: Math.max(accumulated.cacheCreationTokens, normalized.cacheCreationTokens),
      cacheReadTokens: Math.max(accumulated.cacheReadTokens, normalized.cacheReadTokens),
      inputTokens: Math.max(accumulated.inputTokens, normalized.inputTokens),
      outputTokens: Math.max(accumulated.outputTokens, normalized.outputTokens),
      totalTokens: Math.max(accumulated.totalTokens, normalized.totalTokens),
    };
  }

  return accumulated;
}

export { normalizeRawUsage, usageFromJsonBody, usageFromStreamChunks };
export type { UsageTokens };
