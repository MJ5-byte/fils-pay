import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const motionQuery = "(prefers-reduced-motion: reduce)";
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(motionQuery);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
const snapshot = () => window.matchMedia(motionQuery).matches;
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}

/** Interpolate display geometry only. Callers keep their original source values. */
export function useAnimatedValues(values: readonly number[], keys: readonly string[], animateMount = false) {
  const reduced = useReducedMotion();
  const target = JSON.stringify(keys.map((key, index) => [key, values[index] ?? 0]));
  const [frame, setFrame] = useState<Record<string, number>>(() => Object.fromEntries(keys.map((key, index) => [key, animateMount && !reduced ? 0 : values[index] ?? 0])));
  const current = useRef(frame);
  useEffect(() => {
    const entries = JSON.parse(target) as [string, number][];
    const final = Object.fromEntries(entries);
    const start = current.current;
    let request = 0;
    const publish = (next: Record<string, number>) => { current.current = next; setFrame(next); };
    if (reduced) { publish(final); return; }
    const began = performance.now();
    const draw = (now: number) => {
      const elapsed = Math.min(1, (now - began) / 700);
      const ease = elapsed === 1 ? 1 : 1 - Math.pow(2, -10 * elapsed);
      publish(Object.fromEntries(entries.map(([key, value]) => {
        const old = start[key] ?? (animateMount ? 0 : value);
        return [key, elapsed === 1 ? value : old + (value - old) * ease];
      })));
      if (elapsed < 1) request = requestAnimationFrame(draw);
    };
    request = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(request);
  }, [target, reduced, animateMount]);
  return values.map((value, index) => reduced ? value : frame[keys[index] ?? ""] ?? (animateMount ? 0 : value));
}
