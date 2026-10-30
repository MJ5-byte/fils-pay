import type { ComponentType, ReactNode, SVGProps } from "react";
import { CountUp } from "./CountUp.js";
import { Sparkline } from "./Sparkline.js";
import { Skeleton } from "./Skeleton.js";
import { IconArrowDownRight, IconArrowUpRight } from "./icons.js";

export function KpiTile({ label, icon: Icon, children, foot, value, format, series, seriesLabel, delta, loading = false, tone = "surface" }: {
  label: string; icon: ComponentType<SVGProps<SVGSVGElement>>; children?: ReactNode; foot?: ReactNode;
  value?: number; format?: (value: number) => ReactNode; series?: readonly number[]; seriesLabel?: string;
  delta?: { direction: "up" | "down"; label: string }; loading?: boolean; tone?: "surface" | "ink";
}) {
  const DeltaIcon = delta?.direction === "down" ? IconArrowDownRight : IconArrowUpRight;
  return <div className={`dash-metric${tone === "ink" ? " dash-card--ink" : ""}`} aria-busy={loading}>
    <div className="dash-metric-label"><Icon />{label}</div>
    <div className="dash-metric-value">{loading ? <Skeleton width="75%" height={32} /> : value !== undefined
      ? <CountUp value={value} format={format}>{children}</CountUp> : children}</div>
    {delta ? <div className={`fp-kpi-delta fp-kpi-delta-${delta.direction}`}><DeltaIcon />{delta.label}</div> : null}
    {foot ? <div className="dash-metric-sub">{foot}</div> : null}
    {series && series.length > 1 ? <Sparkline values={series} label={seriesLabel ?? `${label} across the selected window`} /> : null}
  </div>;
}
