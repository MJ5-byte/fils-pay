import type { ComponentType, ReactNode, SVGProps } from "react";

/**
 * A small labelled tag that always carries the glyph of its meaning, never a
 * bare coloured dot and never text alone. Where a status has a lifecycle it
 * belongs in `StatusBadge`; a `Tag` is for the flat facts that sit beside a
 * row or a record (a mode, a KYC outcome, a capability), so a reader reads the
 * icon before the word. Tone comes from the house palette, one meaning per
 * colour: `pos` for a good standing, `warn` for one that needs attention,
 * `neg` for a bad one, `brand` for an identity fact, `neutral` otherwise.
 */
export type TagTone = "neutral" | "pos" | "warn" | "neg" | "brand";

export function Tag({
  tone = "neutral",
  icon: Icon,
  children,
}: {
  tone?: TagTone;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  children: ReactNode;
}) {
  return (
    <span className={`dash-tag dash-tag-${tone}`}>
      <Icon aria-hidden="true" />
      {children}
    </span>
  );
}
