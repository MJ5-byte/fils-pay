import { useCallback, useEffect, useState } from "react";
import { formatBhd, toFils } from "@filspay/money";
import {
  getAdjustmentImportRows,
  listAdjustmentImports,
  uploadAdjustmentImport,
} from "../../api/adjustmentImports.js";
import { describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { appendImports } from "./appendImports.js";
import type {
  AdjustmentImportRowDetail,
  AdjustmentImportSummary,
} from "../../types.js";

// FH: another copy of bhd() in admin, claude says extract it
function bhd(fils: number): string {
  return `${formatBhd(toFils(fils, { allowNegative: true }))} BHD`;
}

const CSV_PLACEHOLDER = `merchantId,amount,reason
00000000-0000-0000-0000-000000000000,4.750,statement correction`;

/**
 * "Import adjustments" — paste a CSV of manual balance corrections and apply
 * them. There is no preview step: the paste box submits directly, because an
 * adjustment CSV is assembled and checked in the spreadsheet it came from.
 *
 * The history table below drills into per-row detail, which shows the raw
 * CSV text next to the integer that was actually posted.
 */
export function AdjustmentImportPage() {
  const [csvContent, setCsvContent] = useState("");
  const [filename, setFilename] = useState("");
  const [repeatable, setRepeatable] = useState<{ csvContent: string; filename?: string } | null>(null);
  // The id names one deliberate repeat and is reused on every retry until a response confirms it, so a lost response cannot post the money again.
  const [pendingRepeat, setPendingRepeat] = useState<{ csvContent: string; repeatUploadId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [imports, setImports] = useState<AdjustmentImportSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [openImportId, setOpenImportId] = useState<string | null>(null);
  const [rows, setRows] = useState<AdjustmentImportRowDetail[]>([]);
  const [rowsError, setRowsError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setListError(null);
    try {
      const page = await listAdjustmentImports({ limit: 25 });
      setImports(page.items);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setListError(describeError(err));
    }
  }, []);

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setListError(null);
    try {
      const page = await listAdjustmentImports({ limit: 25, cursor: nextCursor });
      setImports((current) => appendImports(current, page.items));
      setNextCursor(page.nextCursor);
    } catch (err) {
      setListError(describeError(err));
    }
  }

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  /** Amounts are BD with three decimals and are parsed server-side with parseBhdToFils. */
  async function submitImport(content: string, name: string | undefined, repeatUploadId?: string): Promise<void> {
    setRepeatable(null);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await uploadAdjustmentImport(content, name, repeatUploadId);
      if (repeatUploadId !== undefined) {
        setPendingRepeat(null);
        setNotice(
          result.alreadyApplied
            ? "Your earlier repeat of this file had already posted, so nothing new was posted."
            : `Applied ${result.rowCount} row(s), posting ${bhd(result.totalPostedFils)} in total.`,
        );
      } else {
        setNotice(
          result.alreadyApplied
            ? "This file was already applied, so nothing new was posted. Is this a new month's correction that should be posted again?"
            : `Applied ${result.rowCount} row(s), posting ${bhd(result.totalPostedFils)} in total.`,
        );
        if (result.alreadyApplied) {
          setRepeatable({ csvContent: content, filename: name });
        }
      }
      setCsvContent("");
      setFilename("");
      await loadHistory();
    } catch (err) {
      setError(describeError(err));
      if (repeatUploadId !== undefined) setRepeatable({ csvContent: content, filename: name });
    } finally {
      setBusy(false);
    }
  }

  function postAgain(content: string, name: string | undefined): void {
    const repeatUploadId = pendingRepeat?.csvContent === content ? pendingRepeat.repeatUploadId : crypto.randomUUID();
    setPendingRepeat({ csvContent: content, repeatUploadId });
    void submitImport(content, name, repeatUploadId);
  }

  async function handleApply(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    await submitImport(csvContent, filename.trim() ? filename.trim() : undefined);
  }

  async function handleOpenRows(importId: string): Promise<void> {
    if (openImportId === importId) {
      setOpenImportId(null);
      setRows([]);
      return;
    }
    setRowsError(null);
    try {
      setRows(await getAdjustmentImportRows(importId));
      setOpenImportId(importId);
    } catch (err) {
      setRowsError(describeError(err));
    }
  }

  return (
    <section>
      <h1>Import adjustments</h1>
      <p className="admin-muted">
        Applies a CSV of manual balance corrections immediately — one balanced ledger posting per
        row. Uploading is gated server-side to the <code>finance</code> and{" "}
        <code>super_admin</code> roles.
      </p>

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            Your role is read-only here. The import history below is still available.
          </p>
        }
      >
        <form className="admin-form" onSubmit={(e) => void handleApply(e)}>
          <label>
            File name (optional)
            <input
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="march-corrections.csv"
            />
          </label>
          <label>
            CSV (columns: merchantId, amount, reason; amount in BHD, e.g. 4.750, not fils)
            <textarea
              value={csvContent}
              onChange={(e) => setCsvContent(e.target.value)}
              rows={8}
              placeholder={CSV_PLACEHOLDER}
              required
            />
          </label>
          <button type="submit" disabled={busy || !csvContent.trim()}>
            {busy ? "Applying…" : "Apply"}
          </button>
        </form>
      </RequireRole>

      {error ? <p className="admin-error">{error}</p> : null}
      {notice ? <p>{notice}</p> : null}
      {repeatable ? (
        <RequireRole allow={["finance", "super_admin"]}>
          <button type="button" disabled={busy} onClick={() => postAgain(repeatable.csvContent, repeatable.filename)}>
            Post again
          </button>
        </RequireRole>
      ) : null}

      <h2>Past imports</h2>
      {listError ? <p className="admin-error">{listError}</p> : null}
      {imports.length === 0 ? (
        <p className="admin-muted">No imports yet.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Applied</th>
              <th>File</th>
              <th>Rows</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {imports.map((item) => (
              <tr key={item.id}>
                <td>{new Date(item.appliedAt).toLocaleString()}</td>
                <td>{item.originalFilename}</td>
                <td>{item.rowCount}</td>
                <td>
                  <button type="button" onClick={() => void handleOpenRows(item.id)}>
                    {openImportId === item.id ? "Hide rows" : "View rows"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {nextCursor ? (
        <p>
          <button type="button" onClick={() => void loadMore()}>
            Load more
          </button>
        </p>
      ) : null}

      {rowsError ? <p className="admin-error">{rowsError}</p> : null}

      {openImportId ? (
        <div>
          <h3>Rows</h3>
          <table className="admin-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Merchant</th>
                <th>CSV amount</th>
                <th>Posted</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.rowNumber}>
                  <td>{row.rowNumber}</td>
                  <td>{row.merchantId}</td>
                  <td>
                    <code>{row.rawAmountText}</code>
                  </td>
                  <td>{bhd(row.parsedAmountFils)}</td>
                  <td>{row.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
