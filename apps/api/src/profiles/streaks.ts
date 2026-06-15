interface UsageStreaks {
  currentStreakDays: number;
  longestStreakDays: number;
}

function usageStreaks(dates: readonly string[]): UsageStreaks {
  const sortedDates = [...new Set(dates)].sort();
  let current = 0;
  let longest = 0;
  let previous: string | null = null;

  for (const date of sortedDates) {
    current = previous !== null && date === nextDateKey(previous) ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = date;
  }

  return {
    currentStreakDays: current,
    longestStreakDays: longest,
  };
}

function nextDateKey(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1));

  return next.toISOString().slice(0, 10);
}

export { usageStreaks };

export type { UsageStreaks };
