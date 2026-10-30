import type { ComponentType, ReactNode, SVGProps } from "react";
import { IconReceipt } from "./icons.js";

export function EmptyState({ icon: Icon = IconReceipt, children, description, action }: {
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  children: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return <div className="dash-empty">
    <span className="dash-empty-figure"><Icon /></span>
    <p>{children}</p>
    {description ? <p className="dash-muted">{description}</p> : null}
    {action ? <div className="fp-empty-action">{action}</div> : null}
  </div>;
}
