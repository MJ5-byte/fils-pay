import {
  IconChevronDown,
} from "@filspay/ui";
/**
 * The shared "Load more" control for every keyset-paginated list page
 * (transactions, payment links, webhook deliveries, settlement batches).
 *
 * `nextCursor` is an opaque server-issued token, passed straight back on the
 * next request and never inspected here, the encoding (and its precision
 * against a microsecond `timestamptz`) is entirely the API's business.
 * Renders nothing at all once the server says there is no next page.
 */
// YA: cursor based, no page numbers on purpose
export function Pagination({
  nextCursor,
  onLoadMore,
  loading,
}: {
  nextCursor: string | null;
  onLoadMore: () => void;
  loading: boolean;
}) {
  if (!nextCursor) return null;
  return (
    <button type="button" className="dash-button" onClick={onLoadMore} disabled={loading}>
      <IconChevronDown />{loading ? "Loading..." : "Load more"}
    </button>
  );
}
