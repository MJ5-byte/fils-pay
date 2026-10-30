import type { ComponentType, ReactNode, SVGProps } from "react";
export function ColumnHead({ icon: Icon, children, align = "left" }: {
  icon: ComponentType<SVGProps<SVGSVGElement>>; children: ReactNode; align?: "left" | "right" | "center";
}) {
  return <span className={`fp-column-head fp-column-head-${align}`}><Icon width={16} height={16} />{children}</span>;
}
