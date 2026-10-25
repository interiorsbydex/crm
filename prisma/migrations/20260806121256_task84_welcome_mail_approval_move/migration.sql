-- Pre-existing schema/DB drift: WELCOME_MAIL_SCREENSHOT was already present on
-- the live DB's LeadFileType enum (added out-of-band by an earlier task) but
-- was never captured in a migration file, so a fresh database built from
-- migration history alone would be missing it. Task #84 relies on this value
-- for its relocated PD→OB upload requirement, so backfill it here,
-- idempotently, before it's needed.
ALTER TYPE "LeadFileType" ADD VALUE IF NOT EXISTS 'WELCOME_MAIL_SCREENSHOT';

ALTER TABLE "pd_ob_checklists" ADD COLUMN IF NOT EXISTS "welcomeMailApprovedByClient" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ob_obm_checklists" DROP COLUMN IF EXISTS "welcomeMailApprovedByClient";
