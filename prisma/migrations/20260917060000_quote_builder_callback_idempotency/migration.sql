-- Dynamic Quote Builder callbacks use projects.id (an immutable UUID) as
-- quoteBuilderRef. Retain one canonical link per existing external reference,
-- preferring the newest row so related quote attachments remain with it.
-- Older historical rows remain available as legacy quotes without an external
-- project link.
WITH ranked_quotes AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "quoteBuilderRef"
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS row_number
  FROM "quotes"
  WHERE "quoteBuilderRef" IS NOT NULL
)
UPDATE "quotes" AS quote
SET "quoteBuilderRef" = NULL
FROM ranked_quotes
WHERE quote."id" = ranked_quotes."id"
  AND ranked_quotes.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "quotes_quoteBuilderRef_key"
  ON "quotes"("quoteBuilderRef")
  WHERE "quoteBuilderRef" IS NOT NULL;