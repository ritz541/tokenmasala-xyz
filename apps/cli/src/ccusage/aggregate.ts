import type { UsageDayInput, UsageSessionInput } from "@tokenmaxxing/api-contract";

import type { CcusageDay, CcusageSession } from "./schema";

/**
 * Pure transform from ccusage daily reports to the sync payload: one row
 * per (date, model), tagged with the source. Handles the three per-source
 * dialects (see schema.ts):
 *
 *   - modelBreakdowns array (claude): per-model rows; missing per-model
 *     costs are filled by distributing the day cost over token weight.
 *   - models record (codex): per-model token rows, day cost distributed
 *     over token weight.
 *   - neither (opencode): one row from the day totals — attributed to the
 *     single entry of modelsUsed when unambiguous, else "unknown".
 *
 * Duplicate (date, model) pairs sum.
 */

function aggregateDays(source: string, days: readonly CcusageDay[]): UsageDayInput[] {
  const merged = new Map<string, UsageDayInput>();

  const add = (row: UsageDayInput) => {
    const key = `${row.date} ${row.model}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, row);
      return;
    }

    merged.set(key, {
      ...existing,
      cacheCreationTokens: existing.cacheCreationTokens + row.cacheCreationTokens,
      cacheReadTokens: existing.cacheReadTokens + row.cacheReadTokens,
      costUsd: existing.costUsd + row.costUsd,
      inputTokens: existing.inputTokens + row.inputTokens,
      outputTokens: existing.outputTokens + row.outputTokens,
      totalTokens: existing.totalTokens + row.totalTokens,
    });
  };

  for (const day of days) {
    const dayCost = day.totalCost ?? day.costUSD ?? 0;

    interface ModelTotals {
      cacheCreationTokens: number;
      cacheReadTokens: number;
      cost: number | undefined;
      inputTokens: number;
      model: string;
      outputTokens: number;
    }

    const entries: ModelTotals[] = [];
    if (day.modelBreakdowns !== undefined && day.modelBreakdowns.length > 0) {
      for (const breakdown of day.modelBreakdowns) {
        entries.push({
          cacheCreationTokens: breakdown.cacheCreationTokens ?? 0,
          cacheReadTokens: breakdown.cacheReadTokens ?? 0,
          cost: breakdown.cost,
          inputTokens: breakdown.inputTokens ?? 0,
          model: breakdown.modelName,
          outputTokens: breakdown.outputTokens ?? 0,
        });
      }
    } else if (day.models !== undefined && Object.keys(day.models).length > 0) {
      for (const [model, entry] of Object.entries(day.models)) {
        entries.push({
          cacheCreationTokens: entry.cacheCreationTokens ?? 0,
          cacheReadTokens: entry.cacheReadTokens ?? 0,
          cost: undefined,
          inputTokens: entry.inputTokens ?? 0,
          model,
          outputTokens: entry.outputTokens ?? 0,
        });
      }
    }

    if (entries.length === 0) {
      add({
        cacheCreationTokens: day.cacheCreationTokens ?? 0,
        cacheReadTokens: day.cacheReadTokens ?? 0,
        costUsd: dayCost,
        date: day.date,
        inputTokens: day.inputTokens ?? 0,
        model: day.modelsUsed?.length === 1 ? day.modelsUsed[0]! : "unknown",
        outputTokens: day.outputTokens ?? 0,
        source,
        totalTokens: day.totalTokens ?? 0,
      });
      continue;
    }

    // Entries without their own cost split the day's remainder by token
    // weight (exact for single-model days, the overwhelming case).
    const tokensOf = (entry: ModelTotals) =>
      entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
    const knownCost = entries.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
    const unpriced = entries.filter((entry) => entry.cost === undefined);
    const unpricedWeight = unpriced.reduce((sum, entry) => sum + tokensOf(entry), 0);
    const remainder = Math.max(dayCost - knownCost, 0);

    for (const entry of entries) {
      const cost =
        entry.cost ??
        (unpricedWeight > 0
          ? (remainder * tokensOf(entry)) / unpricedWeight
          : remainder / unpriced.length);
      add({
        cacheCreationTokens: entry.cacheCreationTokens,
        cacheReadTokens: entry.cacheReadTokens,
        costUsd: cost,
        date: day.date,
        inputTokens: entry.inputTokens,
        model: entry.model,
        outputTokens: entry.outputTokens,
        source,
        totalTokens: tokensOf(entry),
      });
    }
  }

  return [...merged.values()].sort((a, b) =>
    a.date === b.date ? a.model.localeCompare(b.model) : a.date.localeCompare(b.date),
  );
}

interface SourceSummary {
  days: number;
  models: number;
  rows: number;
  spendUsd: number;
}

function aggregateSessions(
  source: string,
  sessions: readonly CcusageSession[],
): UsageSessionInput[] {
  const today = new Date().toISOString().slice(0, 10);
  return sessions
    .map((session): UsageSessionInput | null => {
      // Real ccusage per-source session output carries `sessionId` or `session`.
      const sessionId =
        session.sessionId ?? session.session ?? session.sessionFile ?? session.projectPath;
      if (sessionId === undefined || sessionId.length === 0) {
        return null;
      }
      // Per-source reports vary in whether they carry a timestamp: claude/codex have
      // lastActivity, others carry none. When missing, attribute to today
      // — the session is deduped by id server-side, so the bucket is stable.
      const ts = session.lastActivity ?? session.firstActivity;
      const date = ts !== undefined ? ts.slice(0, 10) : today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return null;
      }
      // Note: ccusage session reports don't carry per-model token breakdowns today.
      // For single-model sessions, attribute to that model; for multi-model
      // sessions, fallback is "unknown".
      const model =
        session.models?.[0] ??
        session.modelsUsed?.[0] ??
        session.modelBreakdowns?.[0]?.modelName ??
        "unknown";
      const costUsd = session.costUSD ?? session.totalCost ?? 0;
      return {
        cacheCreationTokens: session.cacheCreationTokens ?? 0,
        cacheReadTokens: session.cacheReadTokens ?? 0,
        costUsd,
        date,
        inputTokens: session.inputTokens ?? 0,
        lastActivity: ts !== undefined ? Date.parse(ts) : Date.now(),
        model,
        outputTokens: session.outputTokens ?? 0,
        sessionId,
        source,
        totalTokens: session.totalTokens ?? 0,
      };
    })
    .filter((session): session is UsageSessionInput => session !== null)
    .sort((a, b) =>
      a.date === b.date ? a.sessionId.localeCompare(b.sessionId) : a.date.localeCompare(b.date),
    );
}

function summarize(rows: readonly UsageDayInput[]): SourceSummary {
  const days = new Set<string>();
  const models = new Set<string>();
  let spendUsd = 0;
  for (const row of rows) {
    days.add(row.date);
    models.add(row.model);
    spendUsd += row.costUsd;
  }

  return {
    days: days.size,
    models: models.size,
    rows: rows.length,
    spendUsd,
  };
}

export { aggregateDays, aggregateSessions, summarize };

export type { SourceSummary };
