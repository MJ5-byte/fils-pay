import {
  ColumnHead,
  EmptyState,
  IconActivity,
  IconCalendar,
  IconCoins,
  IconDoc,
  IconHash,
  IconStore,
  Money,
  PageHeader,
  SkeletonRows,
  formatDateTime,
} from "@filspay/ui";
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
 * "Import adjustments", paste a CSV of manual balance corrections and apply
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

  const [loading, setLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const page = await listAdjustmentImports({ limit: 25 });
      setImports(page.items);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setListError(describeError(err));
    } finally {
      setLoading(false);
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
    <section className="fp-page fp-stagger">
      <PageHeader title="Import adjustments" lede="Apply a CSV of balance corrections, one ledger posting per row." />

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="dash-muted">
            Your role is read-only here. The import history below is still available.
          </p>
        }
      >
        <form className="dash-form fp-form-card" onSubmit={(e) => void handleApply(e)}>
          <label>
            File name (optional)
            <input
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="march-corrections.csv"
            />
          </label>
          <label>
            CSV rows (amount in BHD, e.g. 4.750, not fils)
            <textarea
              value={csvContent}
              onChange={(e) => setCsvContent(e.target.value)}
              rows={8}
              placeholder={CSV_PLACEHOLDER}
              required
            />
          </label>
          <button className="dash-button dash-button-primary" type="submit" disabled={busy || !csvContent.trim()}>
            {busy ? "Applying…" : "Apply"}
          </button>
        </form>
      </RequireRole>

      {error ? <p className="dash-error">{error}</p> : null}
      {notice ? <p className="dash-notice">{notice}</p> : null}
      {repeatable ? (
        <RequireRole allow={["finance", "super_admin"]}>
          <button type="button" className="dash-button" disabled={busy} onClick={() => postAgain(repeatable.csvContent, repeatable.filename)}>
            Post again
          </button>
        </RequireRole>
      ) : null}

      <section className="fp-list-card">
        <div className="dash-card-head"><h2 className="dash-card-title">Past imports</h2></div>
        {listError ? <p className="dash-error">{listError}</p> : null}
        {loading ? <div className="dash-table-wrap"><table className="dash-table"><SkeletonRows rows={5} columns={4} /></table></div> : imports.length === 0 ? (
          <div className="dash-table-wrap">
            <table className="dash-table">
              <tbody>
                <tr>
                  <td className="dash-empty-cell" colSpan={4}>
                    <EmptyState icon={IconDoc}>No imports yet.</EmptyState>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th><ColumnHead icon={IconCalendar}>Applied</ColumnHead></th>
                  <th><ColumnHead icon={IconDoc}>File</ColumnHead></th>
                  <th className="dash-num"><ColumnHead icon={IconHash} align="right">Rows</ColumnHead></th>
                  <th><ColumnHead icon={IconActivity}>Actions</ColumnHead></th>
                </tr>
              </thead>
              <tbody>
                {imports.map((item) => (
                  <tr key={item.id}>
                    <td>{formatDateTime(item.appliedAt)}</td>
                    <td>{item.originalFilename}</td>
                    <td className="dash-num">{item.rowCount}</td>
                    <td>
                      <button className="dash-button dash-button-ghost" type="button" onClick={() => void handleOpenRows(item.id)}>
                        {openImportId === item.id ? "Hide rows" : "View rows"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="dash-pagination"><span>{imports.length} imports shown</span>
          {nextCursor ? (
            <div>
              <button className="dash-button dash-button-ghost" type="button" onClick={() => void loadMore()}>
                Load more
              </button>
            </div>
          ) : null}</div>

      </section>
      {rowsError ? <p className="dash-error">{rowsError}</p> : null}

      {openImportId ? (
        <div className="fp-list-card">
          <div className="dash-card-head"><h3 className="dash-card-title">Rows</h3></div>
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th className="dash-num"><ColumnHead icon={IconHash} align="right">Row</ColumnHead></th>
                  <th><ColumnHead icon={IconStore}>Merchant</ColumnHead></th>
                  <th className="dash-num"><ColumnHead icon={IconCoins} align="right">CSV Amount</ColumnHead></th>
                  <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Posted</ColumnHead></th>
                  <th><ColumnHead icon={IconDoc}>Reason</ColumnHead></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <td className="dash-num">{row.rowNumber}</td>
                    <td>{row.merchantId}</td>
                    <td className="dash-num">
                      <code>{row.rawAmountText}</code>
                    </td>
                    <td className="dash-num">
                      <Money fils={row.parsedAmountFils} />
                    </td>
                    <td>{row.reason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
