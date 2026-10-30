import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ComponentType, CSSProperties, KeyboardEvent, ReactNode, SVGProps } from "react";
import { createPortal } from "react-dom";
import { IconFilter } from "./icons.js";

const GAP = 6;
const HIDDEN: CSSProperties = { top: 0, left: 0, opacity: 0 };
const EDGE = 8;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A column header whose title opens a filter popover, so a table's filters sit
 * on the column they restrict instead of in a row above the table. The dot on
 * the funnel shows the filter is currently narrowing the rows.
 *
 * The popover is portalled to the body because `.dash-table-wrap` scrolls
 * sideways and would clip it. Outside clicks are judged on the React tree, not
 * the DOM, so a DatePicker inside (which portals its own calendar) counts as
 * inside.
 */
export function ColumnFilter({ icon: Icon, label, active, children, align = "left" }: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  active: boolean;
  children: ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pressedInside = useRef(false);
  const popId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPlace(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const pop = popRef.current;
    if (!trigger || !pop) return;
    const t = trigger.getBoundingClientRect();
    const width = pop.offsetWidth;
    const preferred = align === "right" ? t.right - width : t.left;
    const left = Math.max(EDGE, Math.min(preferred, window.innerWidth - width - EDGE));
    const below = t.bottom + GAP;
    const height = pop.offsetHeight;
    // Flip above the trigger when the popover would run off the bottom and there is more room above.
    const flip = below + height > window.innerHeight - EDGE && t.top - GAP - height >= EDGE;
    const top = flip ? t.top - GAP - height : Math.max(EDGE, Math.min(below, window.innerHeight - height - EDGE));
    setPlace({ top, left });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    popRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(): void {
      if (pressedInside.current) {
        pressedInside.current = false;
        return;
      }
      const focusInside = popRef.current?.contains(document.activeElement) ?? false;
      close(focusInside);
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, close, reposition]);

  function onPopKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== "Tab" || !popRef.current) return;
    const items = Array.from(popRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const at = items.findIndex((item) => item === document.activeElement);
    if (at === -1) return;
    if ((e.shiftKey && at === 0) || (!e.shiftKey && at === items.length - 1)) {
      e.preventDefault();
      close(true);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`fp-column-head fp-column-head-${align} fp-column-filter`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={`${label}, filter${active ? " (active)" : ""}`}
        onPointerDown={() => { if (open) pressedInside.current = true; }}
        onClick={() => (open ? close(true) : setOpen(true))}
        onKeyDown={(e) => { if (e.key === "Escape" && open) close(true); }}
      >
        <Icon width={16} height={16} />
        {label}
        <span className="fp-column-filter-funnel" data-active={active || undefined} aria-hidden="true">
          <IconFilter width={14} height={14} />
        </span>
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          id={popId}
          className="fp-column-filter-pop"
          role="dialog"
          aria-label={`Filter by ${label}`}
          style={place ? { top: place.top, left: place.left } : HIDDEN}
          onPointerDown={() => { pressedInside.current = true; }}
          onKeyDown={onPopKey}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

export interface FilterOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** The checkbox list inside a status filter popover: multi-select, one row per option. */
export function FilterOptionList<T extends string>({ options, selected, onToggle }: {
  options: FilterOption<T>[];
  selected: readonly T[];
  onToggle: (value: T) => void;
}) {
  return (
    <div className="fp-filter-options">
      {options.map((option) => (
        <label key={option.value} className="fp-filter-option">
          <input type="checkbox" checked={selected.includes(option.value)} onChange={() => onToggle(option.value)} />
          {option.label}
        </label>
      ))}
    </div>
  );
}
