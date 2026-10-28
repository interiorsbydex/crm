import { prisma } from './prisma.js';

/**
 * The few additive database changes this version needs (prisma/migrations
 * 20261025120000 … 20261025150000). Each statement only adds something and is
 * safe to run again, so the server applies them itself when it starts: a
 * database that already has them is left alone, one that lacks them gets them,
 * and nothing existing is changed or removed. Set ENSURE_SCHEMA=off to skip.
 */
export const ADDITIVE_STATEMENTS = [
  `ALTER TABLE "lead_files" ADD COLUMN IF NOT EXISTS "customType" TEXT`,
  `CREATE TABLE IF NOT EXISTS "email_drafts" (
    "key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "meta" JSONB,
    "attachments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "email_drafts_pkey" PRIMARY KEY ("key")
  )`,
  `ALTER TABLE "pd_ob_checklists" ADD COLUMN IF NOT EXISTS "customValues" JSONB`,
  `ALTER TABLE "ob_obm_checklists" ADD COLUMN IF NOT EXISTS "customValues" JSONB`,
  `ALTER TABLE "dip_checklists" ADD COLUMN IF NOT EXISTS "customValues" JSONB`,
  `ALTER TABLE "notification_logs" ADD COLUMN IF NOT EXISTS "muted" BOOLEAN NOT NULL DEFAULT false`,
];

export async function ensureAdditiveSchema(): Promise<{ applied: number; failed: number }> {
  if (process.env.ENSURE_SCHEMA === 'off') return { applied: 0, failed: 0 };
  let applied = 0;
  let failed = 0;
  for (const sql of ADDITIVE_STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
      applied++;
    } catch (e: any) {
      failed++;
      console.warn(`[schema] could not apply "${sql.slice(0, 70).replace(/\s+/g, ' ')}…": ${e?.message ?? e}`);
    }
  }
  console.log(`[schema] additive changes checked: ${applied} ok${failed ? `, ${failed} failed (see warnings above)` : ''}`);
  return { applied, failed };
}
