-- Task #20: Lead Key Facts overhaul — add new nullable columns to the leads table.
-- All columns are nullable so existing rows are unaffected.

-- AlterTable
ALTER TABLE "leads" ADD COLUMN "builder"            TEXT;
ALTER TABLE "leads" ADD COLUMN "offer1"             TEXT;
ALTER TABLE "leads" ADD COLUMN "offer2"             TEXT;
ALTER TABLE "leads" ADD COLUMN "offer3"             TEXT;
ALTER TABLE "leads" ADD COLUMN "expectedMoveIn"     TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN "email2"             TEXT;
ALTER TABLE "leads" ADD COLUMN "pan"                TEXT;
ALTER TABLE "leads" ADD COLUMN "gst"                TEXT;
ALTER TABLE "leads" ADD COLUMN "notes"              TEXT;
ALTER TABLE "leads" ADD COLUMN "intentRatingSource" TEXT;
