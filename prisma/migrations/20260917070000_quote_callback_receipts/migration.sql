-- Historical Quote rows may legitimately share an old quoteBuilderRef in
-- production. Callback idempotency therefore lives in a dedicated receipt
-- table, whose rows only represent callbacks received after this integration.

DROP INDEX IF EXISTS "quotes_quoteBuilderRef_key";

CREATE INDEX IF NOT EXISTS "quotes_quoteBuilderRef_idx"
  ON "quotes"("quoteBuilderRef")
  WHERE "quoteBuilderRef" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "quote_callback_receipts" (
  "id" TEXT NOT NULL,
  "quoteRef" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quote_callback_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quote_callback_receipts_quoteRef_key" UNIQUE ("quoteRef"),
  CONSTRAINT "quote_callback_receipts_quoteId_key" UNIQUE ("quoteId"),
  CONSTRAINT "quote_callback_receipts_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "quote_callback_receipts_quoteId_fkey"
    FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);