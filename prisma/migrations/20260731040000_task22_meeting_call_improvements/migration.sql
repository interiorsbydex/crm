-- Task #22: Meeting & Call Log Improvements

-- Add ONBOARDING to MeetingType enum
ALTER TYPE "MeetingType" ADD VALUE IF NOT EXISTS 'ONBOARDING';

-- Add location, rescheduleHistory, and noShowReason to meetings
-- (noShowReason was added to schema before this migration but never in a migration file)
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "noShowReason" TEXT;
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "location" TEXT;
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "rescheduleHistory" JSONB;

-- Add new fields to calls
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "location" TEXT;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "attachments" JSONB;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "nextPlanOfAction" TEXT;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "agenda" TEXT;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "calledAt" TIMESTAMP(3);
