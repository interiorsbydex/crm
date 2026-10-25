-- Task #88 — separate lead status (ACTIVE/ON_HOLD/INACTIVE) from stage
-- Applied narrowly via raw SQL against the live DB and recorded here with
-- `prisma migrate resolve --applied` (see .agents/memory/prisma-schema-drift.md
-- for why a plain `prisma db push`/`migrate dev` is unsafe in this environment).

DO $$ BEGIN
  CREATE TYPE "LeadStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "status" "LeadStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "inactiveNotes" TEXT;

-- Backfill: leads whose `stage` was ON_HOLD/INACTIVE (the old, conflated
-- representation) get the matching `status` and have `stage` restored to
-- the real funnel stage they were parked at (falling back to MQL for older
-- rows that predate preHoldStage tracking) — mirrors the existing manual
-- reactivation fallback logic.
UPDATE "leads" SET "status" = 'ON_HOLD', "stage" = COALESCE("preHoldStage", 'MQL')
  WHERE "stage" = 'ON_HOLD';

UPDATE "leads" SET "status" = 'INACTIVE', "stage" = COALESCE("preHoldStage", 'MQL')
  WHERE "stage" = 'INACTIVE';

-- preHoldStage's value has now been consumed to restore `stage` above — clear
-- it so the legacy field doesn't linger with stale data implying a lead is
-- still parked (status/onHoldReason/onHoldRevivalDate are now the only
-- source of truth for on-hold/inactive state).
UPDATE "leads" SET "preHoldStage" = NULL
  WHERE "status" IN ('ON_HOLD', 'INACTIVE') AND "preHoldStage" IS NOT NULL;
