/**
 * @filspay/ui, the one shared visual language for both FilsPay dashboards.
 *
 * The merchant dashboard (apps/web) and the admin console (apps/admin) draw
 * from a single source: the token-driven stylesheet in `theme.css` and the
 * components below. A given status, a money figure, a chart or an empty face
 * looks identical wherever it appears, which is the first law of this house:
 * a new surface inherits its siblings exactly. Import the look with
 * `import "@filspay/ui/theme.css"` and the components from `@filspay/ui`.
 */
export * from "./icons.js";
export { StatusBadge } from "./StatusBadge.js";
export { EmptyState } from "./EmptyState.js";
export { Tag, type TagTone } from "./Tag.js";
export { Money, bhd } from "./Money.js";
export {
  AreaChart,
  ColumnChart,
  RankedBar,
  StatusMixBar,
  type ChartColumn,
  type ChartSegment,
} from "./charts.js";
export * from "./KpiTile.js";
export * from "./Skeleton.js";
export * from "./Tooltip.js";
export * from "./PageHeader.js";
export * from "./ColumnHead.js";
export * from "./CountUp.js";
export * from "./Sparkline.js";
export * from "./useNavigationDrawer.js";
export * from "./motion.js";
export * from "./ProgressMeter.js";
export { formatDate, formatDateTime, formatTime, formatBusinessDate } from "./dates.js";
