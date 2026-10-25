-- Admin-defined document types (Admin → Document Types). Nullable, so existing rows are untouched.
ALTER TABLE "lead_files" ADD COLUMN IF NOT EXISTS "customType" TEXT;
