-- Task #54: PD→OB and OB→OBM transition checklists with mail triggers

-- New LeadFileType values for PD→OB uploads
ALTER TYPE "LeadFileType" ADD VALUE IF NOT EXISTS 'PAYMENT_SCREENSHOT';
ALTER TYPE "LeadFileType" ADD VALUE IF NOT EXISTS 'OB_QUOTE';

-- PD→OB checklist (gates PROPOSAL_DISCUSSION -> ONBOARDING)
CREATE TABLE IF NOT EXISTS "pd_ob_checklists" (
  "id"                   TEXT NOT NULL PRIMARY KEY,
  "leadId"               TEXT NOT NULL UNIQUE,
  "paymentValue"         DOUBLE PRECISION,
  "projectValue"         DOUBLE PRECISION,
  "obMeetingScheduledAt" TIMESTAMP(3),
  "obMeetingLocation"    TEXT,
  "notes"                TEXT,
  "welcomeMailSent"      BOOLEAN NOT NULL DEFAULT false,
  "welcomeMailSentAt"    TIMESTAMP(3),
  "completedAt"          TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pd_ob_checklists_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE
);

-- OB→OBM checklist (gates ONBOARDING -> ONBOARDING_MEETING)
CREATE TABLE IF NOT EXISTS "ob_obm_checklists" (
  "id"                      TEXT NOT NULL PRIMARY KEY,
  "leadId"                  TEXT NOT NULL UNIQUE,
  "siteDocumentationAt"     TIMESTAMP(3),
  "initialSiteDiscussionAt" TIMESTAMP(3),
  "layoutFinalisationAt"    TIMESTAMP(3),
  "designDiscussionAt"      TIMESTAMP(3),
  "preSignOffAt"            TIMESTAMP(3),
  "maskingAt"               TIMESTAMP(3),
  "signOffAt"               TIMESTAMP(3),
  "dexMaterialDone"         BOOLEAN NOT NULL DEFAULT false,
  "dexMaterialConfirmed"    BOOLEAN NOT NULL DEFAULT false,
  "creditSystemDone"        BOOLEAN NOT NULL DEFAULT false,
  "creditSystemConfirmed"   BOOLEAN NOT NULL DEFAULT false,
  "deepCleaningDone"        BOOLEAN NOT NULL DEFAULT false,
  "deepCleaningConfirmed"   BOOLEAN NOT NULL DEFAULT false,
  "paymentProcessDone"      BOOLEAN NOT NULL DEFAULT false,
  "paymentProcessConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "warrantyClaimDone"       BOOLEAN NOT NULL DEFAULT false,
  "warrantyClaimConfirmed"  BOOLEAN NOT NULL DEFAULT false,
  "continuityDone"          BOOLEAN NOT NULL DEFAULT false,
  "continuityConfirmed"     BOOLEAN NOT NULL DEFAULT false,
  "cancellationDone"        BOOLEAN NOT NULL DEFAULT false,
  "cancellationConfirmed"   BOOLEAN NOT NULL DEFAULT false,
  "npsTriggered"            BOOLEAN NOT NULL DEFAULT false,
  "npsTriggeredAt"          TIMESTAMP(3),
  "obmMailSent"             BOOLEAN NOT NULL DEFAULT false,
  "obmMailSentAt"           TIMESTAMP(3),
  "completedAt"             TIMESTAMP(3),
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ob_obm_checklists_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE
);
