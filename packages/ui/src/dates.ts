/**
 * One date style for both dashboards, always on the Asia/Bahrain clock that
 * settlement business days are keyed on (ADR-0003), whatever the viewer's own
 * timezone or locale: "1 Sep 2026" and "1 Sep 2026, 06:20".
 */
const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bahrain", day: "numeric", month: "short", year: "numeric" });
const DAY_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bahrain", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bahrain", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** A business date (YYYY-MM-DD) is already a Bahrain calendar day, so it is read as UTC to avoid a shift. */
const BUSINESS_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

function parse(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(iso: string): string {
  const d = parse(iso);
  return d ? DAY.format(d) : iso;
}

export function formatDateTime(iso: string): string {
  const d = parse(iso);
  return d ? DAY_TIME.format(d) : iso;
}

export function formatTime(iso: string): string {
  const d = parse(iso);
  return d ? TIME.format(d) : iso;
}

export function formatBusinessDate(day: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(day) ? parse(`${day}T00:00:00Z`) : null;
  return d ? BUSINESS_DAY.format(d) : day;
}
