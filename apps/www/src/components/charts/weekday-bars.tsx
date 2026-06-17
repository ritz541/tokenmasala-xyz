import { useMemo, useState } from "react";

import { formatUsd, linearScale, niceMax } from "./scale";
import { anchorLeft, ChartTooltip } from "./tooltip";

/** Spend bucketed by weekday (Monday-first) with the peak day called out. */

/** Monday-first axis tick labels, matching the screenshot (M T W T F S S). */
const WEEKDAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];
/** Monday-first short names for the peak-day heading and tooltips. */
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const WIDTH = 940;
const HEIGHT = 180;
const BAR_AREA = HEIGHT - 12;
const AXIS = 44;
const TICKS = 4;

/** `spend` is length-7, Monday-first: spend[0] = Mon … spend[6] = Sun. */
function WeekdayBars({ accent, spend }: { accent: string; spend: number[] }) {
  const [hovered, setHovered] = useState<number | null>(null);

  const { max, peakIndex } = useMemo(() => {
    let peak = 0;
    let peakValue = spend[0] ?? 0;
    for (let index = 1; index < spend.length; index += 1) {
      if ((spend[index] ?? 0) > peakValue) {
        peakValue = spend[index] ?? 0;
        peak = index;
      }
    }

    return { max: niceMax(peakValue), peakIndex: peakValue > 0 ? peak : null };
  }, [spend]);

  const y = linearScale(max, BAR_AREA);
  const slot = (WIDTH - AXIS) / WEEKDAY_LABELS.length;
  const barWidth = Math.min(slot * 0.55, 64);

  const activeTooltip =
    hovered === null
      ? null
      : (() => {
          const x = AXIS + slot * hovered + (slot - barWidth) / 2;
          return {
            left: anchorLeft((x + barWidth / 2) / WIDTH, 11),
            top: HEIGHT - y(spend[hovered] ?? 0) - 12,
          };
        })();

  return (
    <div className="relative">
      <svg
        aria-label="Spend by weekday"
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
        {WEEKDAY_LABELS.map((label, index) => {
          const value = spend[index] ?? 0;
          const height = Math.max(y(value), 2);
          const x = AXIS + slot * index + (slot - barWidth) / 2;
          const isPeak = index === peakIndex;
          return (
            <g key={`${label}-${index}`} onPointerEnter={() => setHovered(index)}>
              {/* Invisible hover target spanning the full column. */}
              <rect fill="transparent" height={HEIGHT} width={slot} x={AXIS + slot * index} y={0} />
              <rect
                fill={accent}
                height={height}
                opacity={isPeak ? 1 : 0.4}
                rx={4}
                width={barWidth}
                x={x}
                y={HEIGHT - height}
              />
              <text
                className="fill-current opacity-45"
                fontSize={10}
                textAnchor="middle"
                x={x + barWidth / 2}
                y={HEIGHT + 16}
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
      {hovered !== null && activeTooltip !== null ? (
        <ChartTooltip
          className="w-56 -translate-y-full"
          style={{ left: activeTooltip.left, top: `${activeTooltip.top}px` }}
          subtitle={`${formatUsd(spend[hovered] ?? 0)} total`}
          title={WEEKDAY_NAMES[hovered]}
        />
      ) : null}
    </div>
  );
}

export { WeekdayBars };
