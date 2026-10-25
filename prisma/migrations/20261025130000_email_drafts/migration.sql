-- Email drafts move from server memory into the database (new table; nothing existing changes).
CREATE TABLE IF NOT EXISTS "email_drafts" (
    "key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "meta" JSONB,
    "attachments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "email_drafts_pkey" PRIMARY KEY ("key")
);
