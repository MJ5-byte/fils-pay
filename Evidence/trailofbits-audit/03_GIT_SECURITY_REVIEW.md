# FilsPay: historical differential security review

Date: 2026-10-30. Inspected local HEAD `7aeb2831d1cfc00a741c33a31ca94c7939e1b43c`; local `origin/main` was `31b67ff0a442aef8483c9af7e53a895038c97f9f`. No fetch, checkout, branch modification or remote access. Recorded times below are Git metadata, not independently authenticated event times.

## Method and scope

Applied Trail of Bits differential-review: graph/parent baseline, risk classification, selected source origins and blame, exact diff/tree checks, test inspection, direct caller counts and adversarial consequences. Large-repository strategy: focus auth, financial calculations, tenant authorization, callbacks and webhook effects. This is not a full line-by-line review of every historical version.

Reviewed 71 reachable commits. Parent versions were read with `git show` and compared without changing checkout. Commit prose is not evidence that a fix exists; actor names/emails do not prove human identity or intent.

## Suspicious message/content comparisons

All dates in this table have recorded author and committer offset `+03:00`.

| Commit | Recorded date/time | Message claim versus actual delta | Confidence/status |
|---|---|---|---|
| `bf66bf25179d82353ac8e58fee9d6676ba9d9295` | 2026-05-14 11:20 | “callbacks are deduplicated now”; **empty**, same tree as parent | Verified Git objects; high |
| `fe24d267b6dba082a44d06472d90f47f1d7d3ee0` | 2026-04-08 22:14 | “sign the exact bytes we send”; **empty**, no signer change | Verified; high |
| `7805693e821e9c606f1275ea5379a4d896bb3098` | 2026-09-27 03:12 | “cleanup: nothing to see here”; **empty** | Verified; high |
| `3d9b2236e60f42d05b83757964a58e71886d4ddf` | 2026-10-02 08:15 | “security: rotated everything again”; **empty** | Verified tracked tree only; high |
| `800e1e62262b6bf158e23f64e89fbcd944fa6147` | 2026-04-09 08:30 | “access: revoke yousif.alansari”; **empty** | Does not prove/disprove external account action |
| `6f462e1275baf415d4ff3fe9bce1e1b36b30e4f0` | 2026-03-20 09:30 | “mark import amounts as intentional”; **empty** | No parser/test change |
| `a5bffeae7fc1e2cf40232807c2b222c4d47a1b3e` | 2026-07-08 16:30 | “fix flaky test in discount adjustment”; adds only `CHANGELOG.md`, 136 lines | No actual test modification |
| `098c2deeeeae76fcdd70935f671e5ea737dc010e` | 2026-09-28 16:45 | “minor cleanup and doc edits”; adds only `db/seed/fixtures/transactions.ts`, 476 lines | Message understates source addition |

The six empty commits listed above share their respective parent tree:

`51886804455a981173e2e6d2a73677b2402e4ebe`

**Impact:** narrative fixes cannot be relied on to close findings. In particular, callback deduplication and raw-byte signing remain unimplemented in inspected code. No claim of malicious authorship, stolen identity, exfiltration or external revocation failure is supported by these tree comparisons alone.

## Graph chronology

- `f7a7a3a` is dated **February 14, 2026**, but its parent `098c2de` is dated **September 28, 2026**.
- The 16 commits in `098c2de..8b58b0f` collectively leave the tree unchanged.
- `git diff 098c2de HEAD -- apps packages db scripts` is empty.
- Searches for modification/deletion commits under these source directories returned no entries. The inspected source histories predominantly introduce files rather than document later behavioral repairs.

These facts support unreliable narrative chronology, not a conclusion that a named person committed after losing real-world account access. Git timestamps can be supplied by a commit creator.

## Selected high-risk source origins and blast radius

| Source / origin | Security-relevant content and test coverage | Direct production caller count |
|---|---|---|
| Merchant auth, `a9b275311e2a46ca7c78f7ebcc103e759e204b43`, 2025-08-14 | Session predicate path currently lacks OTP enforcement through migration 0058. `auth/sessions.test.ts:80-119` tests promoted/unknown/revoked/expired, not pending rejection. | `lookupSession`: two auth middleware consumers |
| Admin auth, `3b4edac4aa9e5c7cd3f914a84ff1cdeeb4030bfe`, 2025-11-10 | `adminAuth/sessions.ts:120-127` retains OTP and active-user predicates; admin tests include pre-OTP/disabled-account and role separation. | Admin session lookup centralized |
| Discount helper, `69189e26b2b1f7ec4882269ea55ade32ebbdbc5d`, 2025-08-25 | Original addition already has count guard (`discountAdjustment.ts:52-62`) and repeated-call regression test (`discountAdjustment.test.ts:113-126`). Later “flaky test fix” did not alter it. Combined zero-event/replay/resource cases are not covered by that test. | `applyCaptureDiscountAdjustment`: 1, `routes/transactions.ts:111` |
| Finance parser, `43073e5e8a0e82356deaf07d056ba70bb9021228`, 2025-11-24 | `adjustmentCsvParsing.ts:8` uses default two decimals from `lib/decimal.ts:4`; import test `adjustmentImport.test.ts:61-70` expects 475 for `4.75`. | Parser: 1 import consumer; import: 1 HTTP handler |
| Outbound signer, `c2f36276f33e3652ffb444d9c62904924a4999f6`, 2025-09-18 | `sign.ts:31-37` signs canonical JSON; dispatcher sends ordinary stringify. Round-trip tests use the same canonicalizing verifier, not independent raw-byte verification. | `signPayload`: 2, dispatcher and test-send |
| Callback helper, `662d4f4aad97f39eefc21e0a01914a8cd6307204`, 2025-09-22 | `callbacks.ts:27-50` appends notes. Tests exercise insertion, unknown transaction and retries, not deduplication. No capture or ledger write in helper. | `applyAcquirerCallback`: 1 route |
| `parsePromotionalDiscountFils`, same initial payment commit | `discountAdjustment.ts:12-17` has a two-decimal conversion but no production call site found. | 0; do not count as exposed monetary exploit |

Counts exclude imports, declarations and tests and are **direct textual call counts**, not a transitive reachability metric. V08/V09 demonstrate why one call site can still affect all capture callers.

## Actual regressions versus persistent defects

No reviewed tree diff established a security fix later removed or a formerly safe auth/financial implementation weakened by a particular later patch. Current defects are supported by current code and initial-file history; they must not be mislabeled proven regressions simply because a comment claims a fix.

No external access logs, signed-commit policy, branch protection, deleted remote refs, credential backend or CI audit logs were available. Secret-rotation messages do not validate operational rotation.

## Reproducible read-only commands

```powershell
git log --all --graph --decorate --date=iso-strict --format='%h %ad %d %s' -100
git cat-file -p bf66bf2
git show -s --format='%H|%aI|%cI|tree=%T|parent=%P|%s' bf66bf2
git rev-parse 'bf66bf2^{tree}' 'bf66bf2^1^{tree}'
git diff-tree --no-commit-id --numstat -r bf66bf2
git diff a5bffea^ a5bffea -- CHANGELOG.md
git diff 098c2de^ 098c2de -- db/seed/fixtures/transactions.ts
git diff --stat 098c2de 8b58b0f
git diff --stat 098c2de HEAD -- apps packages db scripts
git log --all --format='%h %aI %s' --diff-filter=M -- apps packages db scripts
git log --all --format='%h %s' --diff-filter=D -- apps packages db scripts
git blame HEAD -L 43,70 -- apps/api/src/payments/discountAdjustment.ts
git blame HEAD -L 6,18 -- apps/api/src/admin/adjustmentCsvParsing.ts
git show 69189e2:apps/api/src/payments/discountAdjustment.test.ts
git show 43073e5:apps/api/src/lib/decimal.ts
```

Existing forensic reports were consulted for leads; object/tree comparisons above, not their storyline, support this report.
