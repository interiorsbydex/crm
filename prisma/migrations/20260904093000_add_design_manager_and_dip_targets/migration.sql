-- Design Managers are distinct from Designers/DTLs. Designers and DTLs may
-- belong to one DM team; the relationship is optional to preserve existing users.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'DESIGN_MANAGER';

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "designManagerId" TEXT;
CREATE INDEX IF NOT EXISTS "users_designManagerId_idx" ON "users" ("designManagerId");

DO $$ BEGIN
  ALTER TABLE "users"
    ADD CONSTRAINT "users_designManagerId_fkey"
    FOREIGN KEY ("designManagerId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "designer_targets" ADD COLUMN IF NOT EXISTS "dipTargetCount" INTEGER;