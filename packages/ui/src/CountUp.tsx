import type { ReactNode } from "react";
import { useAnimatedValues } from "./motion.js";

export function CountUp({ value, format = (number) => number.toLocaleString("en"), children }: {
  value: number; format?: (value: number) => ReactNode; children?: ReactNode;
}) {
  const [animated = value] = useAnimatedValues([value], ["value"], true);
  const final = children ?? format(value);
  return <span className="fp-count-up">
    <span aria-hidden="true">{animated === value ? final : format(Math.round(animated))}</span>
    <span className="fp-sr-only">{final}</span>
  </span>;
}
