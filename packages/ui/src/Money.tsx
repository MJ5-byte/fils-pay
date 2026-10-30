import { formatBhd, toFils } from "@filspay/money";

export function bhd(amountFils: number): string {
  return `${formatBhd(toFils(amountFils, { allowNegative: true }))} BHD`;
}

export function Money({ fils, size = "row", signed = false }: {
  fils: number;
  size?: "row" | "kpi" | "hero";
  signed?: boolean;
}) {
  const figure = formatBhd(toFils(fils, { allowNegative: true }));
  const cut = figure.lastIndexOf(".");
  const dinars = (cut < 0 ? figure : figure.slice(0, cut)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = cut < 0 ? "" : figure.slice(cut);
  const sign = signed && fils > 0 ? "+" : "";
  return (
    <span className={`dash-amount fp-money-${size}`} role="img" aria-label={`${sign}${dinars}${fraction} BHD`}>
      <span aria-hidden="true"><span className="fp-money-dinars">{sign}{dinars}</span><span className="fp-money-fils">{fraction}</span>{" "}<span className="dash-ccy">BHD</span></span>
    </span>
  );
}
