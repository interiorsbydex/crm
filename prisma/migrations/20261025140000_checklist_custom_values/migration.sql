-- Admin-defined checklist items (Admin → Checklists). Nullable, so existing rows are untouched.
ALTER TABLE "pd_ob_checklists" ADD COLUMN IF NOT EXISTS "customValues" JSONB;
ALTER TABLE "ob_obm_checklists" ADD COLUMN IF NOT EXISTS "customValues" JSONB;
ALTER TABLE "dip_checklists" ADD COLUMN IF NOT EXISTS "customValues" JSONB;
