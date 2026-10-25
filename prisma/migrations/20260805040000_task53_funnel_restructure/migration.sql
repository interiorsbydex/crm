-- Task #53: Restructure sales funnel — MQL-start, add PD/OBM/DIP stages
--
-- Adds three new LeadStage enum values, a new lead-level flag for the
-- DQL -> Proposal Presented skip path, and moves the default stage for new
-- leads from EFFECTIVE_LEAD to MQL. EFFECTIVE_LEAD and HANDED_OVER remain
-- valid enum values for legacy data but are no longer assigned to new leads
-- (see .agents/memory/funnel-restructure.md).
--
-- Statements are IF NOT EXISTS / idempotent so this is safe to run against
-- databases that already have these changes applied (they were first applied
-- directly during development per the documented db-push drift constraint —
-- see .agents/memory/prisma-schema-drift.md).

ALTER TYPE "LeadStage" ADD VALUE IF NOT EXISTS 'PROPOSAL_DISCUSSION';
ALTER TYPE "LeadStage" ADD VALUE IF NOT EXISTS 'ONBOARDING_MEETING';
ALTER TYPE "LeadStage" ADD VALUE IF NOT EXISTS 'DESIGN_IN_PROGRESS';

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "skippedProposalReady" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "leads" ALTER COLUMN "stage" SET DEFAULT 'MQL';
