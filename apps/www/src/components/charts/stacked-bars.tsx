import { useMemo, useState } from "react";

import { formatDay, linearScale, niceMax } from "./scale";
import { anchorBesideBar, ChartTooltip } from "./tooltip";

/**
 * Daily metric, one bar per day stacked by model family. Hover reveals the
 * per-family breakdown.
 */

interface StackedDay {
  date: string;
  /** family -> metric value, families pre-sorted by overall rank. */
  segments: { color: string; family: string; value: number }[];
  total: number;
}

type ValueFormatter = (value: number) => string;

const WIDTH = 940;
const HEIGHT = 220;
const AXIS = 44;
const TICKS = 4;

function StackedBars({
  ariaLabel,
  days,
  highlight = null,
  valueFormatter,
}: {
  ariaLabel: string;
  days: StackedDay[];
  highlight?: string | null;
  valueFormatter: ValueFormatter;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const max = useMemo(() => niceMax(Math.max(...days.map((day) => day.total), 0)), [days]);
  const y = linearScale(max, HEIGHT);
  const slot = (WIDTH - AXIS) / Math.max(days.length, 1);
  const barWidth = Math.max(Math.min(slot * 0.72, 16), 1.25);

  const monthStarts = useMemo(
    () =>
      days.flatMap((day, index) =>
        day.date.endsWith("-01") || index === 0 ? [{ date: day.date, index }] : [],
      ),
    [days],
  );

  const active = hovered === null ? null : days[hovered];
  const activePosition =
    hovered === null
      ? null
      : (() => {
          const x = AXIS + slot * hovered + (slot - barWidth) / 2;
          const center = x + barWidth / 2;
          return {
            center: center / WIDTH,
            edge: (center < WIDTH / 2 ? x + barWidth : x) / WIDTH,
          };
        })();

  return (
    <div className="relative">
      <svg
        aria-label={ariaLabel}
        className="block w-full select-none"
        onPointerLeave={() => setHovered(null)}
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT + 24}`}
      >
        {Array.from({ length: TICKS + 1 }, (_, tick) => {
          const value = (max / TICKS) * tick;
          const yPos = HEIGHT - y(value);
          return (
            <g key={tick}>
              <line
                stroke="currentColor"
                strokeOpacity={tick === 0 ? 0.28 : 0.09}
                x1={AXIS}
                x2={WIDTH}
                y1={yPos}
                y2={yPos}
              />
              <text
                className="fill-current opacity-45"
                fontSize={10}
                textAnchor="end"
                x={AXIS - 6}
                y={yPos + 3}
              >
                {valueFormatter(value)}
              </text>
            </g>
          );
        })}

        {days.map((day, index) => {
          const x = AXIS + slot * index + (slot - barWidth) / 2;
          let cursor = HEIGHT;
          return (
            <g key={day.date} onPointerEnter={() => setHovered(index)}>
              {/* Invisible hover target spanning the full column height. */}
              <rect fill="transparent" height={HEIGHT} width={slot} x={AXIS + slot * index} y={0} />
              {day.segments.map((segment) => {
                const height = y(segment.value);
                cursor -= height;
                const dimmedByFamily = highlight !== null && segment.family !== highlight;
                const dimmedByDay = hovered !== null && hovered !== index;
                return (
                  <rect
                    fill={segment.color}
                    height={Math.max(height, 0)}
                    key={segment.family}
                    opacity={dimmedByFamily ? 0.12 : dimmedByDay ? 0.45 : 1}
                    width={barWidth}
                    x={x}
                    y={cursor}
                  />
                );
              })}
            </g>
          );
        })}

        {monthStarts.map(({ date, index }) => (
          <text
            className="fill-current opacity-45"
            fontSize={10}
            key={date}
            textAnchor="middle"
            x={AXIS + slot * index + slot / 2}
            y={HEIGHT + 16}
          >
            {formatDay(date).split(" ")[1]}
          </text>
        ))}
      </svg>

      {active !== null && active !== undefined && activePosition !== null ? (
        <ChartTooltip
          className="w-56 -translate-y-1/2"
          rows={active.segments
            .filter((segment) => segment.value > 0)
            .sort((a, b) => b.value - a.value)
            .map((segment) => ({
              color: segment.color,
              label: segment.family,
              value: valueFormatter(segment.value),
            }))}
          style={{ left: anchorBesideBar(activePosition.center, activePosition.edge), top: "50%" }}
          subtitle={`${valueFormatter(active.total)} total`}
          title={formatDay(active.date)}
        />
      ) : null}
    </div>
  );
}

interface LegendEntry {
  color: string;
  family: string;
  /** Share of charted metric, 0–100. */
  percent: number;
}

/** Ranked, vertical legend that sits beside the chart: rank · dot · family · share. */
function Legend({
  entries,
  onHover,
}: {
  entries: LegendEntry[];
  onHover?: (family: string | null) => void;
}) {
  return (
    <ol
      className="flex w-full select-none flex-col gap-1 lg:w-56 lg:shrink-0"
      onPointerLeave={() => onHover?.(null)}
    >
      {entries.map((entry, index) => (
        <li
          className="flex items-center gap-3 rounded px-2 py-1 text-sm hover:bg-muted"
          key={entry.family}
          onPointerEnter={() => onHover?.(entry.family)}
        >
          <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">
            {index + 1}
          </span>
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: entry.color }} />
          <span className="flex-1 truncate">{entry.family}</span>
          <span className="tabular-nums text-muted-foreground">{entry.percent.toFixed(1)}%</span>
        </li>
      ))}
    </ol>
  );
}

export { Legend, StackedBars };

export type { LegendEntry, StackedDay, ValueFormatter };
