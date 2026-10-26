import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import { onboardingMovedAt, ppToOnboardingDays, recalculateMilestones, recalculatePpOnboardingForAll } from './milestones.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);

describe('PP → Onboarding days helpers', () => {
  it('uses the first move to Onboarding, ignoring other moves', () => {
    expect(onboardingMovedAt([])).toBeNull();
    expect(onboardingMovedAt([{ createdAt: day(5), meta: { to: 'DQL' } }])).toBeNull();
    expect(onboardingMovedAt([
      { createdAt: day(9), meta: { to: 'ONBOARDING' } },
      { createdAt: day(4), meta: { to: 'ONBOARDING' } },
      { createdAt: day(6), meta: { to: 'PROPOSAL_DISCUSSION' } },
    ])).toEqual(day(4));
  });
  it('counts whole days and never goes negative', () => {
    expect(ppToOnboardingDays(day(1), day(8))).toBe(7);
    expect(ppToOnboardingDays(day(8), day(1))).toBe(0);
  });
});

describe.skipIf(!safeDb)('PP → Onboarding days on a real lead', () => {
  const tag = `ppo${Date.now() % 1e8}`;
  let userId = '', leadDbId = '';
  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { name: 'PPO', email: `${tag}@x.test`, supabaseId: tag, role: 'DESIGNER' } })).id;
    const lead = await prisma.lead.create({ data: { leadId: tag, name: 'PPO lead', phone: `+9198${tag.slice(3)}`, stage: 'ONBOARDING', assignedDesignerId: userId } });
    leadDbId = lead.id;
    await prisma.meeting.create({ data: { leadId: lead.id, type: 'PP', status: 'COMPLETED', scheduledAt: new Date(Date.now() - 20 * 86_400_000), mode: 'VIRTUAL' } as any });
    await prisma.activityLog.create({ data: { userId, leadId: lead.id, action: 'STAGE_CHANGED', meta: { from: 'PROPOSAL_DISCUSSION', to: 'ONBOARDING' }, createdAt: new Date(Date.now() - 15 * 86_400_000) } });
  });
  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { leadId: leadDbId } });
    await prisma.meeting.deleteMany({ where: { leadId: leadDbId } });
    await prisma.lead.deleteMany({ where: { id: leadDbId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('is measured to the day it moved to Onboarding, not to later edits', async () => {
    await prisma.lead.update({ where: { id: leadDbId }, data: { notes: 'edited later' } }); // bumps updatedAt to now
    await recalculateMilestones(leadDbId);
    expect((await prisma.lead.findUnique({ where: { id: leadDbId } }))!.daysPPToOnboarding).toBe(5);
  });
  it('the one-off script shows changes without writing, then writes only with apply', async () => {
    await prisma.$executeRaw`UPDATE leads SET "daysPPToOnboarding" = 20 WHERE id = ${leadDbId}`;
    const dry = await recalculatePpOnboardingForAll(false);
    expect(dry.changes.find((c) => c.leadId === tag)).toMatchObject({ from: 20, to: 5 });
    expect((await prisma.lead.findUnique({ where: { id: leadDbId } }))!.daysPPToOnboarding).toBe(20);
    await recalculatePpOnboardingForAll(true);
    expect((await prisma.lead.findUnique({ where: { id: leadDbId } }))!.daysPPToOnboarding).toBe(5);
  });
});
