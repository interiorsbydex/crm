-- Task #25: Make NPSResponse.sentAt nullable + deduplicate + backfill + unique constraint.
--
-- Before this migration sentAt had @default(now()), so every row's sentAt was set at
-- insert time regardless of whether an email was actually queued. The new contract is:
--   sentAt IS NULL  → email not yet queued (record is retryable)
--   sentAt IS NOT NULL → email successfully enqueued (idempotency guard)
--
-- Step 1: drop the NOT NULL constraint and its default on sentAt.
ALTER TABLE "nps_responses"
  ALTER COLUMN "sentAt" DROP NOT NULL,
  ALTER COLUMN "sentAt" DROP DEFAULT;

-- Step 2: deduplicate legacy rows per (leadId, stage).
-- The old implementation created a new SALE NPS row for every completed DQL/PP meeting,
-- so multiple rows for the same (leadId, stage) can exist.
-- Retention priority: rows with a non-null score (responded) beat rows without;
-- among ties, keep the earliest (createdAt ASC) so we preserve the original record.
DELETE FROM "nps_responses"
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY "leadId", stage
        ORDER BY
          -- prefer responded rows (score NOT NULL) over unsent
          CASE WHEN score IS NOT NULL THEN 0 ELSE 1 END ASC,
          "createdAt" ASC
      ) AS rn
    FROM "nps_responses"
  ) ranked
  WHERE rn > 1
);

-- Step 3: backfill — reset sentAt to NULL for every row that has no corresponding
-- NPS email log. These rows' sentAt was set by the old auto-default, not by actual
-- email queueing, so they must be treated as unsent and retried.
UPDATE "nps_responses" nr
SET    "sentAt" = NULL
WHERE  NOT EXISTS (
  SELECT 1
  FROM   "email_logs" el
  WHERE  el."leadId" = nr."leadId"
    AND  el."type"   LIKE 'NPS_%'
);

-- Step 4: add a composite unique constraint so concurrent triggers cannot insert
-- duplicate (leadId, stage) rows, enforcing idempotency at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS "nps_responses_leadId_stage_key"
  ON "nps_responses" ("leadId", "stage");
