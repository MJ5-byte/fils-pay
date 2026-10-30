import type { CSSProperties } from "react";
export function Skeleton({ width = "100%", height = 20, radius = "var(--fp-r)" }: {
  width?: CSSProperties["width"]; height?: CSSProperties["height"]; radius?: CSSProperties["borderRadius"];
}) {
  return <span className="fp-skeleton" aria-hidden="true" style={{ width, height, borderRadius: radius }} />;
}
export function SkeletonRows({ rows, columns }: { rows: number; columns: number }) {
  return <tbody aria-label="Loading rows" aria-busy="true">
    {Array.from({ length: rows }, (_, row) => <tr key={row}>
      {Array.from({ length: columns }, (_, column) => <td key={column}><Skeleton width={column === 0 ? "75%" : "60%"} /></td>)}
    </tr>)}
  </tbody>;
}
