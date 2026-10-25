-- Task #24: On Hold / Inactive flow + unread tracking

ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "onHoldReason"   TEXT,
  ADD COLUMN IF NOT EXISTS "inactiveReason" TEXT,
  ADD COLUMN IF NOT EXISTS "firstOpenedAt"  TIMESTAMP(3);
