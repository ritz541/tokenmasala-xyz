/**
 * Compact model pricing used by the local proxy to estimate `costUsd` for
 * each forwarded request. Rates are USD per 1,000,000 tokens and are a
 * best-effort snapshot — the server's authoritative cost (if it later
 * recomputes) wins for the leaderboard; this is good enough for the live
 * meter and the per-event estimate.
 *
 * Keys are matched by prefix against the model id sent by the harness, so
 * e.g. "claude-3-5-sonnet-20241022" matches the "claude-3-5-sonnet" entry.
 */

interface ModelPrice {
  readonly cacheCreationUsd: number;
  readonly cacheReadUsd: number;
  readonly inputUsd: number;
  readonly outputUsd: number;
  readonly prefix: string;
}

const PRICES: readonly ModelPrice[] = [
  // Anthropic Claude 4 family
  { prefix: "claude-opus-4", inputUsd: 15, outputUsd: 75, cacheReadUsd: 1.5, cacheCreationUsd: 18.75 },
  { prefix: "claude-sonnet-4", inputUsd: 3, outputUsd: 15, cacheReadUsd: 0.3, cacheCreationUsd: 3.75 },
  { prefix: "claude-haiku-4", inputUsd: 0.8, outputUsd: 4, cacheReadUsd: 0.08, cacheCreationUsd: 1 },
  // Anthropic Claude 3.5 / 3 family
  { prefix: "claude-3-5-sonnet", inputUsd: 3, outputUsd: 15, cacheReadUsd: 0.3, cacheCreationUsd: 3.75 },
  { prefix: "claude-3-5-haiku", inputUsd: 0.8, outputUsd: 4, cacheReadUsd: 0.08, cacheCreationUsd: 1 },
  { prefix: "claude-3-opus", inputUsd: 15, outputUsd: 75, cacheReadUsd: 1.5, cacheCreationUsd: 18.75 },
  { prefix: "claude-3-sonnet", inputUsd: 3, outputUsd: 15, cacheReadUsd: 0.3, cacheCreationUsd: 3.75 },
  { prefix: "claude-3-haiku", inputUsd: 0.25, outputUsd: 1.25, cacheReadUsd: 0.03, cacheCreationUsd: 0.3 },
  // OpenAI GPT-4o / o-series
  { prefix: "gpt-4o", inputUsd: 2.5, outputUsd: 10, cacheReadUsd: 1.25, cacheCreationUsd: 2.5 },
  { prefix: "gpt-4.1", inputUsd: 2, outputUsd: 8, cacheReadUsd: 0.5, cacheCreationUsd: 2 },
  { prefix: "o1", inputUsd: 15, outputUsd: 60, cacheReadUsd: 7.5, cacheCreationUsd: 15 },
  { prefix: "o3", inputUsd: 10, outputUsd: 40, cacheReadUsd: 2.5, cacheCreationUsd: 10 },
  { prefix: "o4", inputUsd: 10, outputUsd: 40, cacheReadUsd: 2.5, cacheCreationUsd: 10 },
  // OpenAI mini / nano
  { prefix: "gpt-4o-mini", inputUsd: 0.15, outputUsd: 0.6, cacheReadUsd: 0.075, cacheCreationUsd: 0.15 },
  { prefix: "gpt-4.1-mini", inputUsd: 0.4, outputUsd: 1.6, cacheReadUsd: 0.1, cacheCreationUsd: 0.4 },
  { prefix: "gpt-4.1-nano", inputUsd: 0.1, outputUsd: 0.4, cacheReadUsd: 0.025, cacheCreationUsd: 0.1 },
  // Google Gemini
  { prefix: "gemini-2.5-pro", inputUsd: 1.25, outputUsd: 10, cacheReadUsd: 0.31, cacheCreationUsd: 1.25 },
  { prefix: "gemini-2.5-flash", inputUsd: 0.3, outputUsd: 2.5, cacheReadUsd: 0.075, cacheCreationUsd: 0.3 },
  { prefix: "gemini-2.0-flash", inputUsd: 0.1, outputUsd: 0.4, cacheReadUsd: 0.025, cacheCreationUsd: 0.1 },
  // xAI Grok
  { prefix: "grok-4", inputUsd: 5, outputUsd: 15, cacheReadUsd: 1.25, cacheCreationUsd: 5 },
  { prefix: "grok-3", inputUsd: 3, outputUsd: 15, cacheReadUsd: 0.75, cacheCreationUsd: 3 },
  // DeepSeek
  { prefix: "deepseek-chat", inputUsd: 0.27, outputUsd: 1.1, cacheReadUsd: 0.07, cacheCreationUsd: 0.27 },
  { prefix: "deepseek-reasoner", inputUsd: 0.55, outputUsd: 2.19, cacheReadUsd: 0.14, cacheCreationUsd: 0.55 },
  // Mistral
  { prefix: "mistral-large", inputUsd: 2, outputUsd: 6, cacheReadUsd: 0.5, cacheCreationUsd: 2 },
  { prefix: "ministral", inputUsd: 0.1, outputUsd: 0.3, cacheReadUsd: 0.025, cacheCreationUsd: 0.1 },
  // Default fallback (cheap generic)
  { prefix: "", inputUsd: 1, outputUsd: 2, cacheReadUsd: 0.1, cacheCreationUsd: 1 },
];

interface ResolvedPrice {
  readonly cacheCreationUsd: number;
  readonly cacheReadUsd: number;
  readonly inputUsd: number;
  readonly outputUsd: number;
}

function priceForModel(model: string): ResolvedPrice {
  const normalized = model.toLowerCase();
  let best: ResolvedPrice | undefined;
  let bestPrefixLength = -1;
  for (const entry of PRICES) {
    if (entry.prefix === "") {
      // Default fallback — only used if nothing else matches.
      if (best === undefined) {
        best = entry;
      }
      continue;
    }
    if (normalized.startsWith(entry.prefix) && entry.prefix.length > bestPrefixLength) {
      best = entry;
      bestPrefixLength = entry.prefix.length;
    }
  }

  return best ?? PRICES[PRICES.length - 1]!;
}

interface UsageTokens {
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

function estimateCostUsd(model: string, usage: UsageTokens): number {
  const price = priceForModel(model);
  const cost =
    (usage.inputTokens / 1_000_000) * price.inputUsd +
    (usage.outputTokens / 1_000_000) * price.outputUsd +
    (usage.cacheReadTokens / 1_000_000) * price.cacheReadUsd +
    (usage.cacheCreationTokens / 1_000_000) * price.cacheCreationUsd;

  return Math.round(cost * 1_000_000) / 1_000_000;
}

export { estimateCostUsd, priceForModel };
export type { ModelPrice, ResolvedPrice, UsageTokens };
