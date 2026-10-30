import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import "./DatePicker.css";

/**
 * Branded replacement for `<input type="date">` and `<input type="datetime-local">`.
 * It speaks the same value strings as those inputs (`YYYY-MM-DD` and
 * `YYYY-MM-DDTHH:mm`, empty when unset), so callers and format.ts keep working
 * unchanged.
 */
export interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
  /** "datetime" adds hour and minute selection. */
  mode?: "date" | "datetime";
  /** Earliest selectable day, `YYYY-MM-DD`. */
  min?: string;
  required?: boolean;
  placeholder?: string;
}

const POP_WIDTH = 320;
/** Tall enough for the grid plus the time row, used to decide whether to open upward. */
const POP_HEIGHT = 440;
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const HOURS = Array.from({ length: 24 }, (_, h) => pad(h));
const MINUTE_STEPS = Array.from({ length: 12 }, (_, i) => pad(i * 5));

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today in the browser's local calendar as `YYYY-MM-DD`, the shape `min` takes. */
export function todayKey(): string {
  return toKey(new Date());
}

function fromKey(key: string): Date {
  const [y = 0, m = 1, d = 1] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(key: string, n: number): string {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

/** Moves by whole months, clamping the day so 31 Jan + 1 month lands on 28/29 Feb, not in March. */
function addMonths(key: string, n: number): string {
  const d = fromKey(key);
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return toKey(target);
}

function isValidKey(key: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && !Number.isNaN(fromKey(key).getTime());
}

const longDay = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const shortDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const monthTitle = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });

function CalendarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="1" />
      <path d="M3 10h18M7 2v6M17 2v6" />
    </svg>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={dir === "left" ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"} />
    </svg>
  );
}

export function DatePicker({ value, onChange, mode = "date", min, required, placeholder }: DatePickerProps) {
  const id = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; up: boolean }>({ top: 0, left: 0, up: false });
  const focusDayRef = useRef(false);
  const [open, setOpen] = useState(false);

  const datePart = value.slice(0, 10);
  const timePart = mode === "datetime" ? value.slice(11, 16) : "";
  const selected = isValidKey(datePart) ? datePart : "";
  const today = toKey(new Date());
  const [active, setActive] = useState(selected || today);

  const isDisabled = (key: string) => Boolean(min && key < min);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  // The popover is portalled to <body> so no transformed ancestor or clipped
  // card can trap it, which means it is placed from the trigger's own box.
  function placePopover() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const up = window.innerHeight - rect.bottom < POP_HEIGHT && rect.top > window.innerHeight - rect.bottom;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - POP_WIDTH - 8)) + window.scrollX;
    setPlace({ top: (up ? rect.top - 6 : rect.bottom + 6) + window.scrollY, left, up });
  }

  function openPicker() {
    const start = selected || (min && today < min ? min : today);
    setActive(start);
    placePopover();
    focusDayRef.current = true;
    setOpen(true);
  }

  // The active day takes focus on open and on keyboard moves only, so picking
  // an hour in a select never yanks focus back into the grid.
  useEffect(() => {
    if (!open || !focusDayRef.current) return;
    focusDayRef.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${active}"]`)?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !popRef.current?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", placePopover);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", placePopover);
    };
  }, [open]);

  function defaultTime(day: string): string {
    if (timePart) return timePart;
    // Expiry defaults to the next full hour today so a quick pick is already in the future.
    if (day === today) return `${pad(Math.min(new Date().getHours() + 1, 23))}:00`;
    return "12:00";
  }

  function pickDay(key: string) {
    if (isDisabled(key)) return;
    if (mode === "date") {
      onChange(key);
      close(true);
      return;
    }
    setActive(key);
    onChange(`${key}T${defaultTime(key)}`);
  }

  function setTime(hour: string, minute: string) {
    const day = selected || active;
    onChange(`${day}T${hour}:${minute}`);
  }

  function moveActive(next: string) {
    focusDayRef.current = true;
    setActive(next);
  }

  function onGridKey(e: KeyboardEvent<HTMLDivElement>) {
    const dow = fromKey(active).getDay();
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(active, -1),
      ArrowRight: () => addDays(active, 1),
      ArrowUp: () => addDays(active, -7),
      ArrowDown: () => addDays(active, 7),
      Home: () => addDays(active, -dow),
      End: () => addDays(active, 6 - dow),
      PageUp: () => addMonths(active, -1),
      PageDown: () => addMonths(active, 1),
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    moveActive(move());
  }

  function onPopoverKey(e: KeyboardEvent<HTMLElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  }

  // The picker sits inside the form's <label>; a click on the popover's empty
  // space would otherwise be forwarded to the trigger and toggle it shut.
  function swallowLabelClick(e: MouseEvent<HTMLSpanElement>) {
    if (!(e.target as Element).closest("button, select, input")) e.preventDefault();
  }

  const viewFirst = fromKey(active);
  viewFirst.setDate(1);
  const gridStart = toKey(new Date(viewFirst.getFullYear(), viewFirst.getMonth(), 1 - viewFirst.getDay()));
  const viewMonth = viewFirst.getMonth();
  const prevMonthEnd = toKey(new Date(viewFirst.getFullYear(), viewMonth, 0));
  const prevDisabled = Boolean(min && prevMonthEnd < min);
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(gridStart, w * 7 + d)));

  const [hour = "12", minute = "00"] = (timePart || "12:00").split(":");
  const minuteOptions = MINUTE_STEPS.includes(minute) ? MINUTE_STEPS : [...MINUTE_STEPS, minute].sort();

  let display = "";
  if (selected) display = shortDay.format(fromKey(selected)) + (timePart ? `, ${timePart}` : "");
  const titleId = `${id}-title`;

  return (
    <span className="fp-dp" ref={rootRef} onClick={swallowLabelClick}>
      <button
        ref={triggerRef}
        type="button"
        className="fp-dp-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-open={open || undefined}
        onClick={() => (open ? close(false) : openPicker())}
      >
        <span className={display ? "fp-dp-value" : "fp-dp-value fp-dp-placeholder"}>
          {display || placeholder || (mode === "datetime" ? "Pick date and time" : "Pick a date")}
        </span>
        <CalendarIcon />
      </button>
      {/* Carries `required` into native form validation, since a button cannot. */}
      {required && (
        <input className="fp-dp-proxy" type="text" tabIndex={-1} aria-hidden="true" required value={value} onChange={() => undefined} onFocus={() => triggerRef.current?.focus()} />
      )}
      {open && createPortal(
        <>
          <span className="fp-dp-scrim" aria-hidden="true" onClick={() => close(true)} />
          <span className="fp-dp-pop" ref={popRef} data-up={place.up || undefined} style={{ top: place.top, left: place.left } as CSSProperties} role="dialog" aria-modal="false" aria-labelledby={titleId} onKeyDown={onPopoverKey}>
            <span className="fp-dp-head">
              <button type="button" className="fp-dp-nav" aria-label="Previous month" disabled={prevDisabled} onClick={() => setActive(addMonths(active, -1))}>
                <Chevron dir="left" />
              </button>
              <span className="fp-dp-title" id={titleId} aria-live="polite">{monthTitle.format(viewFirst)}</span>
              <button type="button" className="fp-dp-nav" aria-label="Next month" onClick={() => setActive(addMonths(active, 1))}>
                <Chevron dir="right" />
              </button>
            </span>
            <div className="fp-dp-grid" role="grid" aria-labelledby={titleId} ref={gridRef} onKeyDown={onGridKey}>
              <div className="fp-dp-row" role="row">
                {WEEKDAYS.map((d) => (
                  <span key={d} className="fp-dp-dow" role="columnheader">{d}</span>
                ))}
              </div>
              {weeks.map((week) => (
                <div className="fp-dp-row" role="row" key={week[0]}>
                  {week.map((key) => {
                    const date = fromKey(key);
                    const disabled = isDisabled(key);
                    return (
                      <span key={key} role="gridcell" aria-selected={key === selected}>
                        <button
                          type="button"
                          className="fp-dp-day"
                          data-day={key}
                          data-outside={date.getMonth() !== viewMonth || undefined}
                          data-today={key === today || undefined}
                          aria-current={key === today ? "date" : undefined}
                          aria-label={longDay.format(date)}
                          tabIndex={key === active ? 0 : -1}
                          disabled={disabled}
                          onClick={() => pickDay(key)}
                        >
                          {date.getDate()}
                        </button>
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
            {mode === "datetime" && (
              <span className="fp-dp-time">
                <span className="fp-dp-eyebrow">Time</span>
                <span className="fp-dp-time-fields">
                  <select aria-label="Hour" value={hour} disabled={!selected} onChange={(e) => setTime(e.target.value, minute)}>
                    {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <span className="fp-dp-colon" aria-hidden="true">:</span>
                  <select aria-label="Minute" value={minute} disabled={!selected} onChange={(e) => setTime(hour, e.target.value)}>
                    {minuteOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </span>
              </span>
            )}
            <span className="fp-dp-foot">
              {!required && value ? (
                <button type="button" className="dash-button-ghost" onClick={() => { onChange(""); close(true); }}>Clear</button>
              ) : <span />}
              {mode === "datetime" ? (
                <button type="button" className="dash-button dash-button-primary" onClick={() => close(true)}>Done</button>
              ) : (
                <button type="button" className="dash-button" disabled={isDisabled(today)} onClick={() => pickDay(today)}>Today</button>
              )}
            </span>
          </span>
        </>,
        document.body,
      )}
    </span>
  );
}
