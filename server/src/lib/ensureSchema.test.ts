import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import { ADDITIVE_STATEMENTS, ensureAdditiveSchema } from './ensureSchema.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');

describe.skipIf(!safeDb)('additive schema changes', () => {
  afterAll(() => prisma.$disconnect());
  it('only add things, never remove or rewrite', () => {
    for (const sql of ADDITIVE_STATEMENTS) {
      expect(sql).toMatch(/IF NOT EXISTS/);
      expect(sql).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
    }
  });
  it('can be run again on a database that already has them', async () => {
    const first = await ensureAdditiveSchema();
    const second = await ensureAdditiveSchema();
    expect(first.failed).toBe(0);
    expect(second).toEqual({ applied: ADDITIVE_STATEMENTS.length, failed: 0 });
  });
});
