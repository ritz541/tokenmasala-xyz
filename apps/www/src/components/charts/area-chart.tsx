import { useMemo, useState } from "react";

import { formatDay, formatUsd, linearScale, niceMax } from "./scale";
import { anchorLeft, ChartTooltip } from "./tooltip";

/** Cumulative spend: a single area path with the final total labelled. */

interface AreaPoint {
  date: string;
  value: number;
}

const WIDTH = 460;
const HEIGHT = 170;
const AXIS = 44;
const TICKS = 4;

function AreaChart({ accent, points }: { accent: string; points: AreaPoint[] }) {
  const [hovered, setHovered] = useState<number | null>(null);

  const max = useMemo(() => niceMax(Math.max(...points.map((point) => point.value), 0)), [points]);
  const y = linearScale(max, HEIGHT - 18);
  const step = (WIDTH - AXIS) / Math.max(points.length - 1, 1);

  const coords = points.map((point, index) => ({
    x: AXIS + step * index,
    y: HEIGHT - y(point.value),
  }));
  const line = coords.map(({ x, y: yPos }, index) => `${index === 0 ? "M" : "L"}${x},${yPos}`);
  const area = [...line, `L${coords.at(-1)?.x ?? AXIS},${HEIGHT}`, `L${AXIS},${HEIGHT}`, "Z"];
  const last = points.at(-1);
  const lastCoord = coords.at(-1);

  const active = hovered === null ? null : points[hovered];
  const activeCoord = hovered === null ? null : coords[hovered];

  return (
    <div className="relative">
      <svg
        aria-label={`Cumulative spend reaching ${formatUsd(last?.value ?? 0)} over ${points.length} days`}
        className="block w-full"
        onPointerLeave={() => setHovered(null)}
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT + 8}`}
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
        {points.length > 1 ? (
          <>
            <path d={area.join(" ")} fill={accent} opacity={0.15} />
            <path d={line.join(" ")} fill="none" stroke={accent} strokeWidth={1.5} />
          </>
        ) : null}
        {activeCoord !== null && activeCoord !== undefined ? (
          <g>
            <line
              stroke="currentColor"
              strokeOpacity={0.25}
              x1={activeCoord.x}
              x2={activeCoord.x}
              y1={0}
              y2={HEIGHT}
            />
            <circle cx={activeCoord.x} cy={activeCoord.y} fill={accent} r={3} />
          </g>
        ) : null}
        {hovered === null && last !== undefined && lastCoord !== undefined ? (
          <text
            className="fill-current"
            fontSize={11}
            fontWeight={600}
            textAnchor="end"
            x={WIDTH - 2}
            y={Math.max(lastCoord.y - 8, 12)}
          >
            {formatUsd(last.value)}
          </text>
        ) : null}
        {/* Invisible hover columns, one per point, that drive the tooltip. */}
        {points.map((point, index) => (
          <rect
            fill="transparent"
            height={HEIGHT}
            key={point.date}
            onPointerEnter={() => setHovered(index)}
            width={Math.max(step, 1)}
            x={AXIS + step * (index - 0.5)}
            y={0}
          />
        ))}
      </svg>
      {active !== null &&
      active !== undefined &&
      activeCoord !== null &&
      activeCoord !== undefined ? (
        <ChartTooltip
          className="w-44"
          style={{ left: anchorLeft(activeCoord.x / WIDTH) }}
          subtitle={`${formatUsd(active.value)} cumulative`}
          title={formatDay(active.date)}
        />
      ) : null}
    </div>
  );
}

export { AreaChart };

export type { AreaPoint };
