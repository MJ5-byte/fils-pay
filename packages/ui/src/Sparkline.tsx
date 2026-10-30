import { useId } from "react";
import { useAnimatedValues } from "./motion.js";

export function Sparkline({ values, label, color = "var(--fp-spark)" }: {
  values: readonly number[]; label: string; color?: string;
}) {
  const id = useId();
  const min = Math.min(0, ...values);
  const range = Math.max(1, Math.max(...values) - min);
  const animated = useAnimatedValues(values.map(value => (value - min) / range), values.map((_, index) => String(index)));
  if (values.length < 2) return null;
  const points = animated.map((value, index) => `${2 + index / (values.length - 1) * 296},${36 - value * 32}`).join(" ");
  return <svg className="fp-sparkline" viewBox="0 0 300 40" preserveAspectRatio="none" role="img" aria-label={label}>
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop stopColor={color} stopOpacity=".12" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
    <polygon className="fp-sparkline-fill" points={`2,40 ${points} 298,40`} fill={`url(#${id})`} />
    <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" pathLength="1" />
  </svg>;
}
