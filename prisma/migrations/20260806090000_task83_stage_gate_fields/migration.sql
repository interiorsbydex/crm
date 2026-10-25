-- Task #83: stage-gate rebuild — new Lead columns
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "skippedProposalDiscussion" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "expectedObDate" TIMESTAMP(3);
