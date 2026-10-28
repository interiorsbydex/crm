import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import { emailSlaBreach } from './slaBreachEmail.js';
import { automationsConfig, defaultAutomations } from './automations.js';
import { slaBreachEmail } from './email.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');

describe.skipIf(!safeDb)('SLA breach email', () => {
  const tag = `slae${Date.now() % 1e8}`;
  let bl = '', bh = '', lead = '';
  const mk = async (s: string, role: 'BL' | 'BRANCH_HEAD') =>
    (await prisma.user.create({ data: { name: `SLA ${s}`, email: `${tag}${s}@x.test`, supabaseId: `${tag}${s}`, role } })).id;

  beforeAll(async () => {
    bl = await mk('bl', 'BL'); bh = await mk('bh', 'BRANCH_HEAD');
    lead = (await prisma.lead.create({ data: { leadId: tag, name: 'SLA lead', phone: `+9197${tag.slice(4)}`, assignedBLId: bl } })).id;
  });
  beforeEach(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: 'automations_v1' } });
    await prisma.emailLog.deleteMany({ where: { leadId: lead } });
  });
  afterAll(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: 'automations_v1' } });
    await prisma.emailLog.deleteMany({ where: { leadId: lead } });
    await prisma.lead.deleteMany({ where: { id: lead } });
    await prisma.user.deleteMany({ where: { id: { in: [bl, bh] } } });
    await prisma.$disconnect();
  });

  it('is on by default and emails the lead\'s BL and the Branch Heads once each', async () => {
    const sent = await emailSlaBreach({ id: lead, leadId: tag, assignedBLId: bl }, 'First call within 24 hours');
    expect(sent).toContain(`${tag}bl@x.test`);
    expect(sent).toContain(`${tag}bh@x.test`);
    expect(new Set(sent).size).toBe(sent.length);
    const logs = await prisma.emailLog.findMany({ where: { leadId: lead, type: 'SLA_BREACH' } });
    expect(logs.length).toBe(sent.length);
  });
  it('links to the lead when the app address is known, and still reads fine without it', () => {
    const base = { recipientName: 'A', leadId: 'X1', leadName: 'Lead', ruleLabel: 'Rule' };
    expect(slaBreachEmail({ ...base, link: 'https://crm.example/leads/abc' }).html).toContain('<a href="https://crm.example/leads/abc">Open lead X1</a>');
    expect(slaBreachEmail(base).html).not.toContain('<a href');
  });
  it('sends nothing when switched off in Admin → Automations', async () => {
    const value = { ...defaultAutomations(), TEAM_SLA_BREACH: { enabled: false, channels: { email: true }, cc: [] } };
    await prisma.assignmentConfig.create({ data: { key: 'automations_v1', value: { value: await automationsConfig.spec.validate(value), revision: 1, updatedAt: new Date().toISOString(), updatedById: bh } as any } });
    expect(await emailSlaBreach({ id: lead, leadId: tag, assignedBLId: bl }, 'x')).toEqual([]);
    expect(await prisma.emailLog.count({ where: { leadId: lead } })).toBe(0);
  });
});
