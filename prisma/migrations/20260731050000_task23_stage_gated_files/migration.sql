-- Task #23: Stage-Gated File Management

-- Add LeadFileType enum
CREATE TYPE "LeadFileType" AS ENUM (
  'FLOOR_PLAN',
  'LIFESTYLE_CAPTURE',
  'PITCH_PRESENTATION',
  'QUOTATION',
  'GENERATED_QUOTE',
  'OTHER'
);

-- Create lead_files table
CREATE TABLE IF NOT EXISTS "lead_files" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "leadId"       TEXT NOT NULL,
  "stage"        "LeadStage" NOT NULL,
  "fileType"     "LeadFileType" NOT NULL,
  "fileName"     TEXT NOT NULL,
  "storagePath"  TEXT NOT NULL,
  "uploadedById" TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "lead_files_leadId_fkey"       FOREIGN KEY ("leadId")       REFERENCES "leads"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_files_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id")
);

CREATE INDEX IF NOT EXISTS "lead_files_leadId_stage_idx" ON "lead_files"("leadId", "stage");
