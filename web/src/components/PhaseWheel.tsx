/**
 * Generic SVG phase wheel (unit circle with tick ring).
 *
 * Angle convention (documented in ARCHITECTURE.md): angleCycles = 0 points at
 * 12 o'clock and increasing phase goes CLOCKWISE ("later edge"). All angles
 * are in cycles (1.0 = full turn); values are wrapped mod 1 for display.
 *
 * Colors default to CSS variables so the wheel renders correctly in both
 * themes without JS involvement.
 */

import type { ReactNode } from 'react';

export interface WheelTap {
  angleCycles: number;
  label: string;
  color?: string;
}

export interface WheelMarker {
  angleCycles: number;
  label?: string;
  color?: string;
  /** radial position of the needle tip, fraction of wheel radius (default 0.8) */
  r?: number;
}

export interface WheelArc {
  fromCycles: number;
  toCycles: number;
  color?: string;
  /** radius fraction (default 0.62) */
  r?: number;
  width?: number;
}

export interface PhaseWheelProps {
  /** fixed reference positions on the ring (e.g. the 8 injection taps) */
  taps?: WheelTap[];
  /** rotating phase markers (needles) */
  markers: WheelMarker[];
  /** highlighted angular ranges */
  arcs?: WheelArc[];
  /** rendered pixel size (square), default 260 */
  size?: number;
  /** animate marker needle rotation (CSS transition) */
  animateToMarker?: boolean;
  title?: ReactNode;
}

const VB = 240; // viewBox size
const C = VB / 2; // center
const R = 92; // ring radius

function wrap01(x: number): number {
  return x - Math.floor(x);
}

/** angle in cycles -> point at radius r (0 cycles = up, clockwise positive) */
function pt(angleCycles: number, r: number): { x: number; y: number } {
  const a = 2 * Math.PI * angleCycles;
  return { x: C + r * Math.sin(a), y: C - r * Math.cos(a) };
}

const MAJOR_LABELS = ['0', '1/8', '1/4', '3/8', '1/2', '5/8', '3/4', '7/8'];

export default function PhaseWheel({
  taps,
  markers,
  arcs,
  size = 260,
  animateToMarker = false,
  title,
}: PhaseWheelProps) {
  const showTickLabels = !taps || taps.length === 0;

  return (
    <figure className={`phase-wheel${animateToMarker ? ' wheel-animate' : ''}`}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${VB} ${VB}`}
        role="img"
        aria-label="phase wheel"
      >
        {/* outer ring */}
        <circle cx={C} cy={C} r={R} className="wheel-ring" />

        {/* minor ticks: every 1/32 cycle */}
        {Array.from({ length: 32 }, (_, i) => {
          if (i % 4 === 0) return null; // majors drawn separately
          const p1 = pt(i / 32, R - 4);
          const p2 = pt(i / 32, R);
          return (
            <line key={`mi${i}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="wheel-tick" />
          );
        })}

        {/* major ticks: every 1/8 cycle */}
        {Array.from({ length: 8 }, (_, i) => {
          const p1 = pt(i / 8, R - 9);
          const p2 = pt(i / 8, R);
          return (
            <line
              key={`ma${i}`}
              x1={p1.x}
              y1={p1.y}
              x2={p2.x}
              y2={p2.y}
              className="wheel-tick wheel-tick-major"
            />
          );
        })}

        {/* major tick labels (hidden when taps provided, to avoid clutter) */}
        {showTickLabels &&
          Array.from({ length: 8 }, (_, i) => {
            const p = pt(i / 8, R + 14);
            return (
              <text key={`tl${i}`} x={p.x} y={p.y + 3} className="wheel-tick-label">
                {MAJOR_LABELS[i]}
              </text>
            );
          })}

        {/* arcs */}
        {arcs?.map((arc, i) => {
          const rr = (arc.r ?? 0.62) * R;
          const from = wrap01(arc.fromCycles);
          const delta = wrap01(arc.toCycles - arc.fromCycles);
          const p1 = pt(from, rr);
          const p2 = pt(from + delta, rr);
          const largeArc = delta > 0.5 ? 1 : 0;
          return (
            <path
              key={`arc${i}`}
              d={`M ${p1.x} ${p1.y} A ${rr} ${rr} 0 ${largeArc} 1 ${p2.x} ${p2.y}`}
              fill="none"
              stroke={arc.color ?? 'var(--accent)'}
              strokeWidth={arc.width ?? 4}
              strokeLinecap="round"
              opacity={0.85}
            />
          );
        })}

        {/* taps: fixed dots on the ring with labels outside */}
        {taps?.map((tap, i) => {
          const p = pt(tap.angleCycles, R);
          const lp = pt(tap.angleCycles, R + 16);
          return (
            <g key={`tap${i}`}>
              <circle cx={p.x} cy={p.y} r={4} fill={tap.color ?? 'var(--fg-subtle)'} />
              <text x={lp.x} y={lp.y + 3} className="wheel-tap-label" fill={tap.color ?? undefined}>
                {tap.label}
              </text>
            </g>
          );
        })}

        {/* markers: needles from center, rotated via CSS transform so they can animate */}
        {markers.map((m, i) => {
          const rr = (m.r ?? 0.8) * R;
          const deg = 360 * wrap01(m.angleCycles);
          const color = m.color ?? 'var(--accent)';
          return (
            <g
              key={`mk${i}`}
              className="wheel-marker"
              style={{
                transform: `rotate(${deg}deg)`,
                transformOrigin: '50% 50%',
                transformBox: 'view-box',
              }}
            >
              <line x1={C} y1={C} x2={C} y2={C - rr} stroke={color} strokeWidth={2} />
              <circle cx={C} cy={C - rr} r={4.5} fill={color} />
              {m.label !== undefined && (
                <text
                  x={C}
                  y={C - rr - 9}
                  className="wheel-marker-label"
                  fill={color}
                  transform={`rotate(${-deg} ${C} ${C - rr - 9})`}
                >
                  {m.label}
                </text>
              )}
            </g>
          );
        })}

        {/* center */}
        <circle cx={C} cy={C} r={2.5} className="wheel-center" />
      </svg>
      {title !== undefined && <figcaption className="phase-wheel-title">{title}</figcaption>}
    </figure>
  );
}
