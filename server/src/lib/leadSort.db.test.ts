import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import { leadOrderBy } from './leadSort.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');

describe.skipIf(!safeDb)('lead sorting against the database', () => {
  const tag = `srt${Date.now() % 1e8}`;
  beforeAll(async () => {
    const mk = (n: string, value: number | null, stage: any) => prisma.lead.create({
      data: { leadId: `${tag}${n}`, name: `${tag} ${n}`, phone: `+9199${tag.slice(3)}${n}`, estimatedValue: value, stage },
    });
    await mk('b', 500, 'ONBOARDING'); await mk('a', null, 'MQL'); await mk('c', 900, 'DQL');
  });
  afterAll(async () => { await prisma.lead.deleteMany({ where: { leadId: { startsWith: tag } } }); await prisma.$disconnect(); });
  const names = async (sort: string, dir: string) =>
    (await prisma.lead.findMany({ where: { leadId: { startsWith: tag } }, orderBy: leadOrderBy(sort, dir) })).map((l) => l.leadId.slice(-1)).join('');

  it('sorts by name both ways', async () => { expect(await names('name', 'asc')).toBe('abc'); expect(await names('name', 'desc')).toBe('cba'); });
  it('sorts by value with empty values last both ways', async () => { expect(await names('value', 'desc')).toBe('cba'); expect(await names('value', 'asc')).toBe('bca'); });
  it('sorts stages in pipeline order, not alphabetically', async () => { expect(await names('stage', 'asc')).toBe('acb'); });
});
