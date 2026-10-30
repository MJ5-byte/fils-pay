import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { formatBhd, toFils } from "@filspay/money";
import { useAnimatedValues } from "./motion.js";
import { Money, bhd } from "./Money.js";
import { EmptyState } from "./EmptyState.js";
import { IconTrend } from "./icons.js";
import { StatusBadge } from "./StatusBadge.js";
import { statusAppearance } from "./StatusBadge.js";

export interface ChartSegment {
  readonly name: string;
  readonly value: number;
  readonly color: string;
}

export interface ChartColumn {
  readonly key: string;
  readonly label: string;
  readonly tooltipLabel?: string;
  readonly segments: readonly ChartSegment[];
}

const HEIGHT = 240;
const TOP = 32;
const BOTTOM = 208;
const LEFT = 48;
const RIGHT = 24;
const TICKS = 4;

function columnTotal(column: ChartColumn): number {
  return column.segments.reduce((sum, segment) => sum + segment.value, 0);
}

/** Compact only the formatted text. Amounts stay integer fils throughout. */
function tick(value: number): string {
  const formatted = formatBhd(toFils(value, { allowNegative: true }));
  const [whole = "0", fraction = ""] = formatted.split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = whole.replace(/[^0-9]/g, "");
  const places = digits.length > 9 ? 9 : digits.length > 6 ? 6 : digits.length > 3 ? 3 : 0;
  if (places > 0) {
    const head = digits.slice(0, -places);
    const decimal = digits.slice(-places, -places + 1).replace(/0$/, "");
    return `${sign}${head}${decimal ? `.${decimal}` : ""}${places === 9 ? "B" : places === 6 ? "M" : "K"}`;
  }
  const decimal = fraction.replace(/0+$/, "");
  return `${sign}${digits}${decimal ? `.${decimal}` : ""}`;
}

/** Axis bounds and ticks are integer fils; only screen geometry uses ratios. */
function axisMax(columns: readonly ChartColumn[]): number {
  const raw = Math.max(4, ...columns.map(columnTotal));
  const magnitude = 10n ** BigInt(String(raw).length - 1);
  for (const step of [1n, 2n, 4n, 5n, 8n, 10n]) {
    const candidate = ((step * magnitude + 3n) / 4n) * 4n;
    if (candidate >= BigInt(raw)) return Number(candidate);
  }
  return raw;
}

function useChartWidth() {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(160, Math.round(element.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function useChartInteraction(count: number) {
  const [pointerIndex, setPointerIndex] = useState<number | null>(null);
  const [keyboardIndex, setKeyboardIndex] = useState<number | null>(null);
  const [heldIndex, setHeldIndex] = useState<number | null>(null);
  const activeIndex = Math.min(pointerIndex ?? keyboardIndex ?? heldIndex ?? count - 1, count - 1);
  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (count === 0) return;
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown": next = Math.max(0, activeIndex - 1); break;
      case "ArrowRight":
      case "ArrowUp": next = Math.min(count - 1, activeIndex + 1); break;
      case "Home": next = 0; break;
      case "End": next = count - 1; break;
      default: return;
    }
    event.preventDefault();
    setPointerIndex(null);
    setKeyboardIndex(next);
  }
  return {
    activeIndex,
    interacting: pointerIndex !== null || keyboardIndex !== null,
    setPointerIndex,
    setHeldIndex,
    events: {
      onKeyDown,
      onFocus: () => setKeyboardIndex(count - 1),
      onBlur: () => setKeyboardIndex(null),
      onPointerLeave: () => setPointerIndex(null),
      onPointerCancel: () => setPointerIndex(null),
    },
  };
}

function pointerX(event: PointerEvent<SVGSVGElement>, width: number): number {
  const box = event.currentTarget.getBoundingClientRect();
  return box.width > 0 ? ((event.clientX - box.left) / box.width) * width : LEFT;
}

function YAxis({ max, width }: { max: number; width: number }) {
  return <g aria-hidden="true">
    {Array.from({ length: TICKS + 1 }, (_, index) => {
      const value = Number((BigInt(max) * BigInt(TICKS - index)) / BigInt(TICKS));
      const y = TOP + ((BOTTOM - TOP) / TICKS) * index;
      return <g key={index}>
        <line className="dash-chart-grid" x1={LEFT} y1={y} x2={width - RIGHT} y2={y} />
        <text className="dash-chart-axis" x={LEFT - 8} y={y + 4} textAnchor="end">{tick(value)}</text>
      </g>;
    })}
  </g>;
}

function Readout({ column, id }: { column: ChartColumn | undefined; id: string }) {
  return <div id={id} className="dash-chart-readout" aria-live="polite" aria-atomic="true">
    {column ? <>
      <strong><Money fils={columnTotal(column)} size="kpi" /></strong>
      <span className="dash-chart-readout-label">{column.tooltipLabel ?? column.label}</span>
      {column.segments.length > 1 ? column.segments.map(segment => <span className="dash-chart-readout-segment" key={segment.name}>
        {segment.name} <Money fils={segment.value} />
      </span>) : null}
    </> : <span className="dash-chart-empty">No data in this window.</span>}
  </div>;
}

function XLabels({ columns, width, x }: { columns: readonly ChartColumn[]; width: number; x: (index: number) => number }) {
  const capacity = Math.max(2, Math.floor((width - LEFT - RIGHT) / 88));
  const every = Math.max(1, Math.ceil((columns.length - 1) / (capacity - 1)));
  return <g aria-hidden="true">
    {columns.map((column, index) => {
      const last = columns.length - 1;
      if (index !== last && (index % every !== 0 || (index > 0 && last - index < every))) return null;
      return <text key={column.key} className="dash-chart-axis dash-chart-x-label" x={x(index)} y={HEIGHT - 8}
        textAnchor={index === 0 ? "start" : index === last ? "end" : "middle"}>{column.label}</text>;
    })}
  </g>;
}

function Crosshair({ x }: { x: number | undefined }) {
  return x === undefined ? null : <line className="dash-chart-cross" x1={x} x2={x} y1={TOP} y2={BOTTOM} aria-hidden="true" />;
}

/** Monotone cubic Hermite interpolation keeps the curve inside its data bounds. */
function monotonePath(points: readonly { x: number; y: number }[]) {
  if (!points.length) return "";
  const slopes = points.slice(1).map((point, index) => (point.y - points[index]!.y) / (point.x - points[index]!.x));
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0] ?? 0;
    if (index === points.length - 1) return slopes[index - 1] ?? 0;
    const before = slopes[index - 1] ?? 0;
    const after = slopes[index] ?? 0;
    return before * after <= 0 ? 0 : 2 * before * after / (before + after);
  });
  return points.reduce((path, point, index) => {
    if (!index) return `M ${point.x} ${point.y}`;
    const previous = points[index - 1]!;
    const third = (point.x - previous.x) / 3;
    return `${path} C ${previous.x + third} ${previous.y + third * tangents[index - 1]!}, ${point.x - third} ${point.y - third * tangents[index]!}, ${point.x} ${point.y}`;
  }, "");
}

function useTouchChart(select: (clientX: number) => number, preview: (index: number | null) => void, retain: (index: number) => void, enabled: boolean) {
  const svgRef = useRef<SVGSVGElement>(null);
  const callbacks = useRef({ select, preview, retain });
  callbacks.current = { select, preview, retain };
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    let timer = 0;
    let armed = false;
    let origin = { x: 0, y: 0 };
    let index = 0;
    const start = (event: TouchEvent) => {
      clearTimeout(timer);
      const touch = event.touches[0];
      if (!touch || event.touches.length !== 1) return;
      armed = false;
      origin = { x: touch.clientX, y: touch.clientY };
      timer = window.setTimeout(() => {
        armed = true;
        index = callbacks.current.select(origin.x);
        callbacks.current.preview(index);
      }, 250);
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      if (!armed) {
        if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > 8) clearTimeout(timer);
        return;
      }
      event.preventDefault();
      index = callbacks.current.select(touch.clientX);
      callbacks.current.preview(index);
    };
    const end = () => {
      clearTimeout(timer);
      if (armed) callbacks.current.retain(index);
      armed = false;
      callbacks.current.preview(null);
    };
    svg.addEventListener("touchstart", start, { passive: true });
    svg.addEventListener("touchmove", move, { passive: false });
    svg.addEventListener("touchend", end);
    svg.addEventListener("touchcancel", end);
    return () => {
      clearTimeout(timer);
      svg.removeEventListener("touchstart", start);
      svg.removeEventListener("touchmove", move);
      svg.removeEventListener("touchend", end);
      svg.removeEventListener("touchcancel", end);
    };
  }, [enabled]);
  return svgRef;
}

function ChartTooltip({ column, x, width }: { column: ChartColumn; x: number; width: number }) {
  return <div className="dash-chart-tooltip" style={{ left: Math.max(8, Math.min(width - 212, x - 102)) }} aria-hidden="true">
    <span className="dash-chart-tooltip-label">{column.tooltipLabel ?? (/^\d{4}-\d{2}-\d{2}/.test(column.key) ? column.key.slice(0, 10) : column.label)}</span>
    <strong><Money fils={columnTotal(column)} /></strong>
    {column.segments.length > 1 ? column.segments.map(segment => <div className="dash-chart-tooltip-row" key={segment.name}><span>{segment.name}</span><Money fils={segment.value} /></div>) : null}
  </div>;
}

export function AreaChart({ columns, caption, color = "var(--fp-brand)" }: {
  columns: readonly ChartColumn[];
  caption?: string;
  color?: string;
}) {
  const { ref, width } = useChartWidth();
  const readoutId = useId();
  const gradientId = useId();
  const interaction = useChartInteraction(columns.length);
  const max = axisMax(columns);
  const values = useAnimatedValues(columns.map(column => columnTotal(column) / max), columns.map(column => column.key));
  const plotWidth = width - LEFT - RIGHT;
  const x = (index: number) => columns.length > 1 ? LEFT + (index / (columns.length - 1)) * plotWidth : LEFT + plotWidth / 2;
  const points = columns.map((_, index) => ({ x: x(index), y: BOTTOM - (values[index]!) * (BOTTOM - TOP) }));
  const line = points.length === 1 ? `M ${points[0]!.x - 24} ${points[0]!.y} H ${points[0]!.x + 24}` : monotonePath(points);
  const first = points[0];
  const last = points[points.length - 1];
  const area = points.length > 1 && first && last ? `${line} L ${last.x} ${BOTTOM} L ${first.x} ${BOTTOM} Z` : "";
  const active = columns[interaction.activeIndex];
  const activePoint = points[interaction.activeIndex];
  const indexAt = (px: number) => Math.max(0, Math.min(columns.length - 1, columns.length > 1 ? Math.round(((px - LEFT) / plotWidth) * (columns.length - 1)) : 0));
  const svgRef = useTouchChart(clientX => {
    const box = svgRef.current?.getBoundingClientRect();
    return indexAt(box?.width ? (clientX - box.left) / box.width * width : LEFT);
  }, interaction.setPointerIndex, interaction.setHeldIndex, columns.length > 0);
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== "touch") interaction.setPointerIndex(indexAt(pointerX(event, width)));
  };
  return <figure className="dash-chart-figure" ref={ref}>
    {columns.length === 0 ? <div className="dash-chart-empty-state"><EmptyState icon={IconTrend}>No data in this window.</EmptyState></div> : <>
      <Readout id={readoutId} column={active} />
      {interaction.interacting && active && activePoint ? <ChartTooltip column={active} x={activePoint.x} width={width} /> : null}
      <svg ref={svgRef} className="dash-chart dash-chart-area" width="100%" height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`}
        role={columns.length ? "slider" : "img"} tabIndex={columns.length ? 0 : undefined}
        aria-label={caption ?? "Payout trend"} aria-describedby={readoutId}
        aria-valuemin={columns.length ? 1 : undefined} aria-valuemax={columns.length || undefined}
        aria-valuenow={columns.length ? interaction.activeIndex + 1 : undefined}
        aria-valuetext={active ? `${active.tooltipLabel ?? active.label}: ${bhd(columnTotal(active))}` : undefined}
        {...interaction.events} onPointerMove={onPointerMove} onPointerDown={onPointerMove}>
        <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop stopColor={color} stopOpacity=".12" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
        <YAxis max={max} width={width} />
        {area ? <path className="dash-chart-fill" d={area} fill={`url(#${gradientId})`} /> : null}
        {line ? <path className="dash-chart-line" d={line} fill="none" stroke={color} strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round" pathLength={1} /> : null}
        {interaction.interacting && activePoint ? <g aria-hidden="true"><Crosshair x={activePoint.x} /><circle cx={activePoint.x} cy={activePoint.y} r={4} fill="var(--fp-ink)" stroke="var(--fp-surface)" strokeWidth={2} /></g>
          : last ? <circle aria-hidden="true" cx={last.x} cy={last.y} r={3} fill={color} stroke="var(--fp-surface)" strokeWidth={2} /> : null}
        <XLabels columns={columns} width={width} x={x} />
      </svg>
    </>}
  </figure>;
}

function columnPath(x: number, y: number, width: number, height: number): string {
  return `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
}

export function ColumnChart({ columns, caption }: { columns: readonly ChartColumn[]; caption?: string }) {
  const { ref, width } = useChartWidth();
  const readoutId = useId();
  const interaction = useChartInteraction(columns.length);
  const max = axisMax(columns);
  const values = useAnimatedValues(columns.map(column => columnTotal(column) / max), columns.map(column => column.key));
  const slot = (width - LEFT - RIGHT) / Math.max(1, columns.length);
  const barWidth = Math.max(0, Math.min(32, slot * .6));
  const x = (index: number) => LEFT + slot * (index + 0.5);
  const active = columns[interaction.activeIndex];
  const indexAt = (px: number) => Math.max(0, Math.min(columns.length - 1, Math.floor((px - LEFT) / slot)));
  const svgRef = useTouchChart(clientX => {
    const box = svgRef.current?.getBoundingClientRect();
    return indexAt(box?.width ? (clientX - box.left) / box.width * width : LEFT);
  }, interaction.setPointerIndex, interaction.setHeldIndex, columns.length > 0);
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== "touch") interaction.setPointerIndex(indexAt(pointerX(event, width)));
  };
  return <figure className="dash-chart-figure" ref={ref}>
    {columns.length === 0 ? <div className="dash-chart-empty-state"><EmptyState icon={IconTrend}>No data in this window.</EmptyState></div> : <>
      <Readout id={readoutId} column={active} />
      {interaction.interacting && active ? <ChartTooltip column={active} x={x(interaction.activeIndex)} width={width} /> : null}
      <svg ref={svgRef} className="dash-chart dash-chart-columns" width="100%" height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`}
        role={columns.length ? "slider" : "img"} tabIndex={columns.length ? 0 : undefined}
        aria-label={caption ?? "Captured volume by day"} aria-describedby={readoutId}
        aria-valuemin={columns.length ? 1 : undefined} aria-valuemax={columns.length || undefined}
        aria-valuenow={columns.length ? interaction.activeIndex + 1 : undefined}
        aria-valuetext={active ? `${active.tooltipLabel ?? active.label}: ${bhd(columnTotal(active))}` : undefined}
        {...interaction.events} onPointerMove={onPointerMove} onPointerDown={onPointerMove}>
        <YAxis max={max} width={width} />
        {columns.map((column, index) => {
          const latest = index === columns.length - 1;
          const height = Math.max(0, (values[index]!) * (BOTTOM - TOP));
          const y = BOTTOM - height;
          const held = interaction.interacting && index === interaction.activeIndex;
          return <path key={column.key} aria-hidden="true" className="dash-chart-bar" d={columnPath(x(index) - barWidth / 2, y, barWidth, height)}
            fill={held || latest ? "var(--fp-brand)" : "var(--fp-chart-bar)"}
            style={{ animationDelay: `${index * 35}ms`, transformOrigin: `${x(index)}px ${BOTTOM}px` }} />;
        })}
        {interaction.interacting && active ? <Crosshair x={x(interaction.activeIndex)} /> : null}
        <XLabels columns={columns} width={width} x={x} />
      </svg>
    </>}
  </figure>;
}

export function RankedBar({ value, max }: { value: number; max: number }) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return <span className="dash-ranked-track" aria-hidden="true">
    <span className="dash-ranked-bar" style={{ width: `${percent}%` }} />
  </span>;
}

export function StatusMixBar({ items, caption = "Transactions by status" }: {
  items: readonly { readonly status: string; readonly count: number }[];
  caption?: string;
}) {
  const order = { positive: 0, neutral: 1, pending: 2, negative: 3, muted: 4 };
  const segments = items.map(item => ({ ...item, appearance: statusAppearance(item.status) }))
    .sort((a, b) => order[a.appearance.tone] - order[b.appearance.tone]);
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  return <figure className="dash-status-mix" style={{ margin: 0 }} aria-label={caption}>
    <div className="dash-status-mix-track" aria-hidden="true">
      {segments.filter(segment => segment.count > 0).map(segment => <span key={segment.status}
        className={`dash-status-mix-segment dash-tone-${segment.appearance.tone}`}
        style={{ flexGrow: segment.count, flexBasis: 0 } as CSSProperties} />)}
    </div>
    {total === 0 ? <EmptyState icon={IconTrend}>No data in this window.</EmptyState> : null}
    <figcaption className="dash-status-mix-legend">
      {segments.map(segment => {
        return <span key={segment.status} className={`dash-status-mix-item dash-tone-${segment.appearance.tone}`}>
          <StatusBadge status={segment.status} />
          <strong>{segment.count.toLocaleString("en")}</strong>
        </span>;
      })}
    </figcaption>
  </figure>;
}
