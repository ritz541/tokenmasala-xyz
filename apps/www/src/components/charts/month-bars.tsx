import { useMemo, useState } from "react";

import { formatMonth, formatMonthLong, formatUsd, linearScale, niceMax } from "./scale";
import { anchorLeft, ChartTooltip } from "./tooltip";

/** Spend per calendar month with value labels above each bar. */

interface MonthPoint {
  /** YYYY-MM */
  month: string;
  segments: { color: string; family: string; value: number }[];
  value: number;
}

const WIDTH = 940;
const HEIGHT = 220;
const TICKS = 4;
const AXIS = 44;

function MonthBars({ months }: { months: MonthPoint[] }) {
  const [hovered, setHovered] = useState<number | null>(null);

  const max = useMemo(() => niceMax(Math.max(...months.map((point) => point.value), 0)), [months]);
  const y = linearScale(max, HEIGHT - 26);
  const slot = (WIDTH - AXIS) / Math.max(months.length, 1);
  const barWidth = Math.min(slot * 0.55, 44);

  const active = hovered === null ? null : months[hovered];
  const activeTooltip =
    hovered === null
      ? null
      : (() => {
          const x = AXIS + slot * hovered + (slot - barWidth) / 2;
          return {
            left: anchorLeft((x + barWidth / 2) / WIDTH, 11),
            top: HEIGHT - y(months[hovered]?.value ?? 0) - 12,
          };
        })();

  return (
    <div className="relative">
      <svg
        aria-label={`Monthly spend across ${months.length} months`}
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
                {formatUsd(value)}
              </text>
            </g>
          );
        })}
        {months.map((point, index) => {
          const hasValue = point.value > 0;
          const totalHeight = y(point.value);
          const x = AXIS + slot * index + (slot - barWidth) / 2;
          let cursor = HEIGHT;
          return (
            <g key={point.month} onPointerEnter={() => setHovered(index)}>
              {/* Invisible hover target spanning the full column height. */}
              <rect fill="transparent" height={HEIGHT} width={slot} x={AXIS + slot * index} y={0} />
              {hasValue ? (
                <>
                  {point.segments.map((segment) => {
                    const height = y(segment.value);
                    cursor -= height;
                    return (
                      <rect
                        fill={segment.color}
                        height={Math.max(height, 0)}
                        key={segment.family}
                        opacity={hovered === null || hovered === index ? 1 : 0.45}
                        width={barWidth}
                        x={x}
                        y={cursor}
                      />
                    );
                  })}
                  <text
                    className="fill-current text-muted-foreground"
                    fontSize={10}
                    fontWeight={500}
                    textAnchor="middle"
                    x={x + barWidth / 2}
                    y={HEIGHT - totalHeight - 6}
                  >
                    {formatUsd(point.value)}
                  </text>
                </>
              ) : null}
              <text
                className="fill-current opacity-45"
                fontSize={10}
                textAnchor="middle"
                x={x + barWidth / 2}
                y={HEIGHT + 16}
              >
                {formatMonth(point.month)}
              </text>
            </g>
          );
        })}
      </svg>
      {active !== null && active !== undefined && activeTooltip !== null ? (
        <ChartTooltip
          className="w-56 -translate-y-full"
          rows={active.segments
            .filter((segment) => segment.value > 0)
            .sort((a, b) => b.value - a.value)
            .map((segment) => ({
              color: segment.color,
              label: segment.family,
              value: formatUsd(segment.value),
            }))}
          style={{ left: activeTooltip.left, top: `${activeTooltip.top}px` }}
          subtitle={`${formatUsd(active.value)} total`}
          title={formatMonthLong(active.month)}
        />
      ) : null}
    </div>
  );
}

export { MonthBars };

export type { MonthPoint };
