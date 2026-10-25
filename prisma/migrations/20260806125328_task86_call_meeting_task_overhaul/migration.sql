-- Task #86: call/meeting/task workflow overhaul

-- New CallOutcome tiers/outcomes (additive only)
ALTER TYPE "CallOutcome" ADD VALUE IF NOT EXISTS 'RNR_6_PLUS';
ALTER TYPE "CallOutcome" ADD VALUE IF NOT EXISTS 'MEETING_SCHEDULED';

-- New MeetingType values (additive only — DESIGN_FREEZE/SIGN_OFF kept for historical rows)
ALTER TYPE "MeetingType" ADD VALUE IF NOT EXISTS 'PD';
ALTER TYPE "MeetingType" ADD VALUE IF NOT EXISTS 'OBM';

-- New enums for follow-up tasks
DO $$ BEGIN
  CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'COMPLETED', 'RESCHEDULED', 'NOT_DONE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "TaskType" AS ENUM ('INTERNAL', 'EXTERNAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- follow_up_tasks: new columns
ALTER TABLE "follow_up_tasks"
  ADD COLUMN IF NOT EXISTS "timeFrom" TEXT,
  ADD COLUMN IF NOT EXISTS "timeTo" TEXT,
  ADD COLUMN IF NOT EXISTS "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "outcome" TEXT,
  ADD COLUMN IF NOT EXISTS "taskType" "TaskType",
  ADD COLUMN IF NOT EXISTS "agenda" TEXT,
  ADD COLUMN IF NOT EXISTS "rescheduleHistory" JSONB,
  ADD COLUMN IF NOT EXISTS "originatingCallId" TEXT;

-- Backfill status from the existing isCompleted boolean so historical rows are consistent
UPDATE "follow_up_tasks" SET "status" = 'COMPLETED' WHERE "isCompleted" = true AND "status" = 'PENDING';

DO $$ BEGIN
  ALTER TABLE "follow_up_tasks"
    ADD CONSTRAINT "follow_up_tasks_originatingCallId_fkey"
    FOREIGN KEY ("originatingCallId") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- meetings: new columns
ALTER TABLE "meetings"
  ADD COLUMN IF NOT EXISTS "momAgenda" TEXT,
  ADD COLUMN IF NOT EXISTS "momAttachmentTypes" JSONB,
  ADD COLUMN IF NOT EXISTS "momAttachments" JSONB,
  ADD COLUMN IF NOT EXISTS "originatingCallId" TEXT;

DO $$ BEGIN
  ALTER TABLE "meetings"
    ADD CONSTRAINT "meetings_originatingCallId_fkey"
    FOREIGN KEY ("originatingCallId") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
