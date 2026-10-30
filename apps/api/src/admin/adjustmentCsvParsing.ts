import { parseBhdToFils, type Fils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";

/** Parses one CSV row's amount column into fils. */
export function parseAdjustmentAmountFils(raw: string): Fils {
  try {
    return parseBhdToFils(raw);
  } catch {
    throw new BadRequestError("invalid_amount", `could not parse amount "${raw}"`);
  }
}

export interface ParsedAdjustmentCsvRow {
  merchantId: string;
  amount: string;
  reason?: string;
}

/** Splits one line on commas outside double quotes; `""` inside quotes is a literal quote. */
function splitCsvLine(line: string): string[] | null {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (line[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  if (quoted) return null;
  cells.push(cell);
  return cells;
}

/**
 * Splits the uploaded CSV text into rows. One row per line, comma
 * separated (commas inside double quotes do not split), with a required
 * `merchantId,amount,reason` header — a hand-rolled splitter rather than a
 * dependency, since this format has no embedded newlines. A row with more
 * columns than the header is rejected: an unquoted thousands separator
 * ("1,250.500") would otherwise shift the amount into the reason column.
 */
export function parseAdjustmentCsv(csvContent: string): ParsedAdjustmentCsvRow[] {
  const lines = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  const header = (splitCsvLine(lines[0] as string) ?? []).map((cell) => cell.trim().toLowerCase());
  if (header[0] !== "merchantid" || header[1] !== "amount") {
    throw new BadRequestError("invalid_csv_header", "the CSV header must be merchantId,amount,reason");
  }

  const rows: ParsedAdjustmentCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i] as string)?.map((cell) => cell.trim());
    if (cells === undefined) {
      throw new BadRequestError("invalid_csv_row", `row ${i} has an unterminated quote`);
    }
    if (cells.length > header.length) {
      throw new BadRequestError(
        "invalid_csv_row",
        `row ${i} has ${cells.length} columns but the header has ${header.length}; quote values that contain commas`,
      );
    }
    const merchantId = cells[0] ?? "";
    const amount = cells[1] ?? "";
    if (merchantId === "" || amount === "") {
      throw new BadRequestError("invalid_csv_row", `row ${i} is missing a merchantId or an amount`);
    }
    const reason = cells[2];
    rows.push(reason === undefined || reason === "" ? { merchantId, amount } : { merchantId, amount, reason });
  }

  if (rows.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  return rows;
}
