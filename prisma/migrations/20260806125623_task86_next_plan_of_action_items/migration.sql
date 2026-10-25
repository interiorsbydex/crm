-- Task #86: structured "next plan of action" (Call/Meeting/Task multi-select)

ALTER TABLE "calls"
  ADD COLUMN IF NOT EXISTS "nextPlanOfActionItems" JSONB;

ALTER TABLE "meetings"
  ADD COLUMN IF NOT EXISTS "nextPlanOfActionItems" JSONB;
