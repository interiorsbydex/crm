import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { buildLeadWhere } from './reports.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');

describe.skipIf(!safeDb)('report filters', () => {
  const tag = `rf${Date.now() % 1e8}`;
  let d1 = '', d2 = '', bl = '';
  const ids: string[] = [];
  const mkU = async (s: string, role: 'DESIGNER' | 'BL', blId?: string) =>
    (await prisma.user.create({ data: { name: `RF ${s}`, email: `${tag}${s}@x.test`, supabaseId: `${tag}${s}`, role, blId } })).id;
  beforeAll(async () => {
    bl = await mkU('bl', 'BL'); d1 = await mkU('d1', 'DESIGNER', bl); d2 = await mkU('d2', 'DESIGNER');
    const mk = async (n: string, o: Record<string, unknown>) => ids.push((await prisma.lead.create({ data: { leadId: `${tag}${n}`, name: n, phone: `+9196${tag.slice(2)}${n}`, ...o } as any })).id);
    await mk('1', { assignedDesignerId: d1, assignedBLId: bl, projectType: '2BHK', location: 'Adyar, Chennai', source: 'META_ADS', stage: 'MQL' });
    await mk('2', { assignedDesignerId: d2, projectType: '3BHK', location: 'Madurai', source: 'REFERRAL', stage: 'DQL' });
  });
  afterAll(async () => {
    await prisma.lead.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: [d1, d2, bl] } } });
    await prisma.$disconnect();
  });
  const found = async (q: Record<string, string>) =>
    (await prisma.lead.findMany({ where: { AND: [await buildLeadWhere(q), { leadId: { startsWith: tag } }] }, select: { name: true } })).map((l) => l.name).sort().join('');

  it('filters by designer, BL, stage and source', async () => {
    expect(await found({ designerId: d1 })).toBe('1');
    expect(await found({ blId: bl })).toBe('1');
    expect(await found({ stage: 'DQL' })).toBe('2');
    expect(await found({ source: 'META_ADS' })).toBe('1');
  });
  it('project type ignores capitals; a city finds the areas inside it', async () => {
    expect(await found({ projectType: '2bhk' })).toBe('1');
    expect(await found({ location: 'chennai' })).toBe('1');
    expect(await found({ location: 'Madurai' })).toBe('2');
  });
  it('filters combine, and nothing outside the lists is widened', async () => {
    expect(await found({ designerId: d1, stage: 'DQL' })).toBe('');
    expect(await found({})).toBe('12');
  });
  it('a Business Lead cannot widen their view with a designer from another team', async () => {
    const w = await buildLeadWhere({ designerId: d2 }, 'BL', bl);
    const rows = await prisma.lead.findMany({ where: { AND: [w, { leadId: { startsWith: tag } }] } });
    expect(rows).toEqual([]);
  });
});
