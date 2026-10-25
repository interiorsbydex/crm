-- Task #28: Discount approval threshold update
-- Add approverRole and isSpecialCase to DiscountRequest.
-- Columns are added with IF NOT EXISTS so this is safe to run against databases
-- that already have the columns (applied via raw SQL during development).

ALTER TABLE "discount_requests" ADD COLUMN IF NOT EXISTS "approver_role" TEXT;
ALTER TABLE "discount_requests" ADD COLUMN IF NOT EXISTS "is_special_case" BOOLEAN NOT NULL DEFAULT false;

-- ── Step 1: Back-fill approverRole + isSpecialCase for all un-routed rows ──────
-- Priority (matches computeApprovalRouting in discounts.ts):
--   woodwork_value_ex_gst present AND post-discount woodwork < ₹5L → BRANCH_HEAD (special)
--   discount_pct > 20                                               → BRANCH_HEAD (special)
--   discount_pct > 15                                               → BRANCH_HEAD (direct, not special)
--   discount_pct > 10                                               → BL
--   discount_pct ≤ 10                                               → SELF (auto-approve tier)
UPDATE "discount_requests"
SET
  "approver_role" = CASE
    WHEN "discount_pct" IS NULL THEN NULL
    WHEN "woodwork_value_ex_gst" IS NOT NULL
         AND ("woodwork_value_ex_gst" * (1 - "discount_pct" / 100.0)) < 500000
                                                             THEN 'BRANCH_HEAD'
    WHEN "discount_pct" > 20                                THEN 'BRANCH_HEAD'
    WHEN "discount_pct" > 15                                THEN 'BRANCH_HEAD'
    WHEN "discount_pct" > 10                                THEN 'BL'
    ELSE                                                         'SELF'
  END,
  "is_special_case" = CASE
    WHEN "discount_pct" > 20 THEN true
    WHEN "woodwork_value_ex_gst" IS NOT NULL
         AND ("woodwork_value_ex_gst" * (1 - "discount_pct" / 100.0)) < 500000 THEN true
    ELSE false
  END
WHERE "approver_role" IS NULL;

-- ── Step 2: Auto-approve any PENDING rows that are within the self-approve tier ─
-- Under the new rules ≤10% requests are auto-approved at submission time.
-- Any pre-existing PENDING rows in this tier were raised before the new rules;
-- transitioning them to APPROVED is the correct resolution — they would have been
-- auto-approved had the rules been in force when they were created. Leaving them
-- as PENDING with approverRole=SELF would make them permanently unresolvable since
-- neither BL nor BH can act on SELF-routed requests.
UPDATE "discount_requests"
SET
  "status"           = 'APPROVED',
  "reviewer_comment" = 'Auto-approved on migration: discount ≤ 10% (below self-approve ceiling per updated policy)',
  "reviewed_at"      = NOW()
WHERE "status"       = 'PENDING'
  AND "approver_role" = 'SELF';
