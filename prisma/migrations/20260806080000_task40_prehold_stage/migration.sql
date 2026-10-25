-- Task #40: track the stage a lead was in before moving to ON_HOLD/INACTIVE,
-- so the reactivation flow can restore it.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "preHoldStage" "LeadStage";
