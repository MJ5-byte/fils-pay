/** A raw status or reason code (`partially_captured`) as readable text. Display only: CSS classes and filters keep the raw value. */
export function statusLabel(value: string | null | undefined): string {
  const text = (value ?? "").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
