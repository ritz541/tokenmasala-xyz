import { useMemo, useRef, useState } from "react";

import { enumerateDays, formatDay, formatUsd } from "./scale";
import { ChartTooltip } from "./tooltip";

/**
 * GitHub-style activity heatmap: daily spend intensity, weeks left to
 * right, Mon/Wed/Fri row labels, 5-step scale on the day's spend.
 */

interface HeatmapProps {
  accent: string;
  /** date -> spend */
  byDate: Map<string, number>;
  first: string;
  last: string;
}

interface HoveredCell {
  day: string;
  /** Pixel position of the cell within the scroll content. */
  left: number;
  top: number;
  value: number;
}

const CELL = 11;
const GAP = 2;
const LEFT = 28;
const TOP = 16;

function Heatmap({ accent, byDate, first, last }: HeatmapProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<HoveredCell | null>(null);

  const { cells, max, monthLabels, weeks } = useMemo(() => {
    const allDays = enumerateDays(first, last);
    // Pad so the first column starts on Sunday (UTC day-of-week).
    const firstDow = new Date(`${first}T00:00:00Z`).getUTCDay();
    const padded: (string | null)[] = [...Array.from({ length: firstDow }, () => null), ...allDays];
    const weekCount = Math.ceil(padded.length / 7);
    const grid = Array.from({ length: weekCount }, (_, week) =>
      Array.from({ length: 7 }, (_, dow) => padded[week * 7 + dow] ?? null),
    );

    const labels: { label: string; week: number }[] = [];
    grid.forEach((column, week) => {
      const firstOfMonth = column.find((day) => day?.endsWith("-01"));
      if (firstOfMonth !== undefined && firstOfMonth !== null) {
        labels.push({ label: formatDay(firstOfMonth).split(" ")[1] ?? "", week });
      }
    });
    if (labels.length === 0 && allDays[0] !== undefined) {
      labels.push({ label: formatDay(allDays[0]).split(" ")[1] ?? "", week: 0 });
    }

    return {
      cells: grid,
      max: Math.max(...allDays.map((day) => byDate.get(day) ?? 0), 0),
      monthLabels: labels,
      weeks: weekCount,
    };
  }, [byDate, first, last]);

  const intensity = (value: number): number => {
    if (value <= 0 || max <= 0) {
      return 0;
    }
    const ratio = value / max;

    return ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
  };

  const opacities = [0, 0.25, 0.5, 0.75, 1] as const;
  const width = LEFT + weeks * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);

  return (
    <div className="relative">
      <div className="overflow-x-auto" ref={scrollRef}>
        <svg
          aria-label={`Daily spend heatmap from ${formatDay(first)} to ${formatDay(last)}`}
          className="block"
          onPointerLeave={() => setHovered(null)}
          role="img"
          viewBox={`0 0 ${width} ${height}`}
          width={width}
        >
          {monthLabels.map(({ label, week }) => (
            <text
              className="fill-current opacity-45"
              fontSize={9}
              key={`${label}-${week}`}
              x={LEFT + week * (CELL + GAP)}
              y={10}
            >
              {label}
            </text>
          ))}
          {(["Mon", "Wed", "Fri"] as const).map((label, index) => (
            <text
              className="fill-current opacity-45"
              fontSize={9}
              key={label}
              x={0}
              y={TOP + (index * 2 + 1) * (CELL + GAP) + CELL - 2}
            >
              {label}
            </text>
          ))}
          {cells.map((column, week) =>
            column.map((day, dow) => {
              if (day === null) {
                return null;
              }
              const value = byDate.get(day) ?? 0;
              const level = intensity(value);
              const cx = LEFT + week * (CELL + GAP);
              const cy = TOP + dow * (CELL + GAP);
              return (
                <rect
                  fill={level === 0 ? "currentColor" : accent}
                  height={CELL}
                  key={day}
                  onPointerEnter={() =>
                    setHovered({
                      day,
                      left: cx + CELL / 2 - (scrollRef.current?.scrollLeft ?? 0),
                      top: cy,
                      value,
                    })
                  }
                  opacity={level === 0 ? 0.08 : opacities[level]}
                  width={CELL}
                  x={cx}
                  y={cy}
                />
              );
            }),
          )}
        </svg>
      </div>
      {hovered !== null ? (
        <ChartTooltip
          className="w-max max-w-[12rem] -translate-x-1/2 -translate-y-full"
          style={{ left: `${hovered.left}px`, top: `${hovered.top - 4}px` }}
          subtitle={hovered.value > 0 ? `${formatUsd(hovered.value)} spent` : "No spend"}
          title={formatDay(hovered.day)}
        />
      ) : null}
    </div>
  );
}

export { Heatmap };
