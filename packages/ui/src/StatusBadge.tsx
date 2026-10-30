import type { ComponentType, ReactNode, SVGProps } from "react";
import { IconAlert, IconBan, IconCheck, IconCircleDashed, IconCirclePause, IconClock, IconCross, IconInfo, IconRotateCcw } from "./icons.js";

type Glyph = ComponentType<SVGProps<SVGSVGElement>>;
export type StatusTone = "positive" | "neutral" | "pending" | "negative" | "muted";
const statuses: Record<string, { icon: Glyph; tone: StatusTone }> = {};
function register(values: string, tone: StatusTone, icon: Glyph) {
  for (const value of values.split(" ")) statuses[value] = { tone, icon };
}
register("captured settled succeeded paid active approved posted capture authorization_succeeded capture_succeeded reconciled live", "positive", IconCheck);
register("authorized pending reserved open submitted under_review pending_approval awaiting_approval", "pending", IconClock);
register("processing replaying", "pending", IconCircleDashed);
register("partially_captured", "neutral", IconCirclePause);
register("partially_refunded refund", "neutral", IconRotateCcw);
register("refunded refund refund_succeeded", "neutral", IconRotateCcw);
register("void voided expired", "negative", IconBan);
register("canceled cancelled disabled", "muted", IconBan);
register("closed", "muted", IconCross);
register("failed declined rejected gap", "negative", IconCross);
register("chargeback exhausted suspended", "negative", IconAlert);

export function statusAppearance(status: string): { icon: Glyph; label: string; tone: StatusTone } {
  const key = status.toLowerCase().replace(/[ -]+/g, "_");
  const label = key.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return { ...(statuses[key] ?? { icon: IconInfo, tone: "neutral" }), label };
}

export function StatusBadge({ status, children }: { status: string; children?: ReactNode }) {
  const { icon: Icon, label, tone } = statusAppearance(status);
  return <span className={`dash-status fp-tone-${tone}`}><Icon width={16} height={16} />{children ?? label}</span>;
}
