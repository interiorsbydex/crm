-- Task #89 — quote document attachments (replacing bare links) + supporting
-- indexes. Applied narrowly via raw SQL against the live DB and recorded here
-- with `prisma migrate resolve --applied` (see
-- .agents/memory/prisma-schema-drift.md for why a plain `prisma db
-- push`/`migrate dev` is unsafe in this environment).

CREATE TABLE IF NOT EXISTS "quote_files" (
  "id"           TEXT NOT NULL,
  "quoteId"      TEXT NOT NULL,
  "fileName"     TEXT NOT NULL,
  "storagePath"  TEXT NOT NULL,
  "uploadedById" TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quote_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "quote_files_quoteId_idx" ON "quote_files"("quoteId");

DO $$ BEGIN
  ALTER TABLE "quote_files" ADD CONSTRAINT "quote_files_quoteId_fkey"
    FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "quote_files" ADD CONSTRAINT "quote_files_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- New attachment fields on DiscountRequest, replacing the bare quoteLink for
-- new requests (quoteLink itself is left in place, read-only, for old rows).
ALTER TABLE "discount_requests" ADD COLUMN IF NOT EXISTS "quoteFileName" TEXT;
ALTER TABLE "discount_requests" ADD COLUMN IF NOT EXISTS "quoteStoragePath" TEXT;
