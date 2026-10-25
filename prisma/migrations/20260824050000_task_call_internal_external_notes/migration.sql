-- Adds client-facing "External Notes" (+ single attachment) to Call, separate
-- from the existing `notes` column which is now "Internal Notes" (staff-only,
-- never emailed to the client).
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "externalNotes" TEXT;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "externalNotesAttachment" JSONB;
