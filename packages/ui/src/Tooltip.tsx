import { cloneElement, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, HTMLAttributes, ReactElement } from "react";

export function Tooltip({ label, children }: { label: string; children: ReactElement<HTMLAttributes<HTMLElement>> }) {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ below: false, shift: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const bubble = tip.current?.getBoundingClientRect();
      if (!anchor || !bubble) return;
      const left = anchor.left + (anchor.width - bubble.width) / 2;
      const shift = Math.max(8 - left, Math.min(0, window.innerWidth - 8 - left - bubble.width));
      setPlacement({ below: anchor.top < bubble.height + 16, shift });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [open, label]);
  return <span ref={trigger} className="fp-tooltip" data-open={open} data-below={placement.below}
    onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)}
    onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
    onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    {cloneElement(children, { "aria-describedby": [children.props["aria-describedby"], id].filter(Boolean).join(" ") })}
    <span ref={tip} id={id} role="tooltip" className="fp-tooltip-bubble" style={{ "--fp-tip-shift": `${placement.shift}px` } as CSSProperties}>{label}</span>
  </span>;
}
