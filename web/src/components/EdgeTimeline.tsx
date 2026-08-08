/**
 * SVG timeline of edges (rows of vertical tick marks over a shared time
 * axis), for reference / feedback / injection edge visualization.
 * Hovering an edge shows a readout line under the plot.
 *
 * `t`, `tMax`, `tMin` are in whatever unit the caller chooses; `unitLabel`
 * (e.g. 'ps', 'T_ref') is display-only.
 */

import { useEffect, useRef, useState } from 'react';
import { trimNumber } from '../lib/format';

export interface TimelineEdge {
  t: number;
  color?: string;
  tag?: string;
}

export interface TimelineRow {
  label: string;
  edges: TimelineEdge[];
}

export interface EdgeTimelineProps {
  rows: TimelineRow[];
  tMax: number;
  unitLabel: string;
  tMin?: number;
  /** row height in px, default 34 */
  rowHeight?: number;
}

const LABEL_W = 116;
const AXIS_H = 26;
const PAD_R = 12;
const HOVER_RADIUS = 14;

export default function EdgeTimeline({
  rows,
  tMax,
  unitLabel,
  tMin = 0,
  rowHeight = 34,
}: EdgeTimelineProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<{ row: number; edge: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(Math.max(320, Math.floor(entry.contentRect.width)));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotL = LABEL_W + 8;
  const plotR = width - PAD_R;
  const span = tMax - tMin || 1;
  const x = (t: number) => plotL + ((t - tMin) / span) * (plotR - plotL);
  const height = rows.length * rowHeight + AXIS_H;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const rowIdx = Math.min(rows.length - 1, Math.max(0, Math.floor(my / rowHeight)));
    const row = rows[rowIdx];
    let best: { edge: number; dist: number } | null = null;
    row.edges.forEach((edge, i) => {
      const d = Math.abs(x(edge.t) - mx);
      if (d <= HOVER_RADIUS && (!best || d < best.dist)) best = { edge: i, dist: d };
    });
    setHover(best ? { row: rowIdx, edge: (best as { edge: number }).edge } : null);
  };

  const hovered = hover ? rows[hover.row]?.edges[hover.edge] : undefined;

  // axis ticks
  const N_TICKS = 5;
  const ticks = Array.from({ length: N_TICKS + 1 }, (_, i) => tMin + (i * span) / N_TICKS);

  return (
    <div className="edge-timeline" ref={wrapRef}>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="edge timeline"
      >
        {rows.map((row, ri) => {
          const top = ri * rowHeight;
          return (
            <g key={ri}>
              {/* row baseline */}
              <line
                x1={plotL}
                y1={top + rowHeight / 2}
                x2={plotR}
                y2={top + rowHeight / 2}
                className="timeline-baseline"
              />
              <text x={4} y={top + rowHeight / 2 + 4} className="timeline-row-label">
                {row.label}
              </text>
              {row.edges.map((edge, ei) => {
                const ex = x(edge.t);
                if (ex < plotL - 1 || ex > plotR + 1) return null;
                const isHover = hover !== null && hover.row === ri && hover.edge === ei;
                return (
                  <g key={ei}>
                    <line
                      x1={ex}
                      y1={top + 7}
                      x2={ex}
                      y2={top + rowHeight - 7}
                      stroke={edge.color ?? 'var(--accent)'}
                      strokeWidth={isHover ? 3 : 1.8}
                    />
                    {edge.tag && (
                      <text x={ex + 3} y={top + 12} className="timeline-edge-tag">
                        {edge.tag}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* axis */}
        <g>
          <line
            x1={plotL}
            y1={rows.length * rowHeight + 4}
            x2={plotR}
            y2={rows.length * rowHeight + 4}
            className="timeline-axis"
          />
          {ticks.map((t, i) => (
            <g key={i}>
              <line
                x1={x(t)}
                y1={rows.length * rowHeight + 4}
                x2={x(t)}
                y2={rows.length * rowHeight + 9}
                className="timeline-axis"
              />
              <text x={x(t)} y={rows.length * rowHeight + 21} className="timeline-axis-label">
                {trimNumber(t, 4)}
              </text>
            </g>
          ))}
          <text x={plotR} y={rows.length * rowHeight + 21} className="timeline-axis-unit">
            {unitLabel}
          </text>
        </g>
      </svg>
      <div className="timeline-readout">
        {hovered && hover
          ? `${rows[hover.row].label} · t = ${trimNumber(hovered.t, 6)} ${unitLabel}${
              hovered.tag ? ` · ${hovered.tag}` : ''
            }`
          : '將滑鼠移到 edge 上查看數值'}
      </div>
    </div>
  );
}
