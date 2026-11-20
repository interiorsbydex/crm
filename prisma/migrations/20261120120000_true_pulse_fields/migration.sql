-- True Pulse (agency) leads: their lead ID and the landing page link. Safe to run twice.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "truePulseLeadId" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "landingPageUrl" TEXT;
CREATE INDEX IF NOT EXISTS "leads_truePulseLeadId_idx" ON "leads"("truePulseLeadId");
