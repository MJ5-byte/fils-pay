# BUG-070 — Webhook Endpoint Deletion Fails With 500 When Referenced by Deliveries

## 1. Summary

The delete handler issues a hard DELETE, but delivery and archive endpoint_id columns are NOT NULL foreign keys with no ON DELETE action. No later migration changes either constraint.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Webhooks
- Affected Component: apps/api/src/webhooks/cancel.ts, db/migrations/0022_webhook_deliveries.sql
- Reachability: Reachable when merchant deletes an endpoint with historical deliveries
- Original Contributors / Sources: Blind spot investigation BUG-010

## 3. Root Cause

The delete handler issues a hard DELETE, but delivery and archive endpoint_id columns are NOT NULL foreign keys with no ON DELETE action. No later migration changes either constraint.

## 4. Affected Files and Functions

`apps/api/src/webhooks/cancel.ts:17-25`; `apps/api/src/routes/webhooks.ts:102-117`; `db/migrations/0022_webhook_deliveries.sql:4-7`; `db/migrations/0068_webhook_delivery_archives.sql:11-14`; `apps/api/src/plugins/errorHandler.ts:34-35`; `apps/web/src/pages/webhooks/WebhookEndpointListPage.tsx:65-84`.

## 5. Expected Behavior

The offered delete operation works for a used endpoint according to an explicit retention policy.

## 6. Actual Behavior

An owned endpoint with any referenced delivery or archive cannot be deleted; the foreign-key error reaches the generic HTTP 500 handler. The claimed SET NULL/CASCADE changes in comments do not exist.

## 7. Trigger Conditions

Register an endpoint, create one real delivery or retained archive, then request deletion as its authorized owner/finance user.

## 8. Technical Evidence

cancel.ts:22 executes `DELETE FROM webhook_endpoints WHERE id=$1 AND merchant_id=$2`. Migration 0022 line 6 declares `UUID NOT NULL REFERENCES webhook_endpoints(id)` and 0068 line 13 does likewise. Repository-wide migration search found no FK alteration.

### Technical Analysis
The source path and concrete input/ordering conditions above establish the result statically. Client controls are not treated as server authorization boundaries.

## 9. Runtime Evidence

Not runtime-tested in this investigation. No matching existing runtime reproduction available.

## 10. Security / Financial / Functional Impact

Used integrations cannot be removed through the documented UI/API. Disable remains an alternative, but known CODE-029 means pending deliveries are not stopped solely by disabling. This report concerns deletion failure, not duplicate dispatch.

## 11. Safe Reproduction

routes/webhooks.test.ts:168-229 tests deletion only before any delivery is generated. Delivery tests never delete the endpoint afterward. Future cases: delete after one completed delivery and after an archive, verifying the chosen retention invariant.

## 12. Related Findings

Prior source comments list this symptom but no CODE/FINDING/NEW established the schema root cause. No matching runtime artifact found. CODE-029's disabled dispatch is separate.

## 13. Documentation Contradictions

The observed implementation contradicts the expected contract or architectural guarantees.

## 14. Recommended Remediation

Choose a coherent soft-delete/retention design or change foreign-key lifecycle and retained ownership together; do not blindly cascade audit history. No fix implemented.

## 15. Remaining Questions and Limitations

Exact deployed schema may differ; analysis uses all checked-in migrations. No database query executed.

## 16. Original Reports Merged

`bug-10-used-webhook-endpoints-cannot-be-deleted.md`

## 17. Evidence References

Exact source locations above; prior source, documentation, runtime and forensic reports and bug registry searched for duplicates before allocation. Source comments are leads, not proof.
