// Runs against the local test database (DATABASE_URL), never a shared one.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import {
  AUTOMATION_EVENTS, automationCc, automationsConfig, defaultAutomations, eventForDraftType, isAutomationOn,
} from './automations.js';
import { ConfigError } from './versionedConfig.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');
const KEY = 'automations_v1';
const stamp = Date.now();
const ids: Record<string, string> = {};

async function problemsOf(raw: unknown): Promise<string[]> {
  try { await automationsConfig.spec.validate(raw); return []; } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}

describe('automation defaults keep today\'s behaviour', () => {
  it('every event is on with all its channels', () => {
    const d = defaultAutomations();
    for (const e of AUTOMATION_EVENTS) {
      expect(d[e.code].enabled, e.code).toBe(true);
      for (const c of e.channels) expect(d[e.code].channels[c], `${e.code} ${c}`).toBe(true);
    }
  });
  it('call emails copy the designer, BL and Branch Heads, as their review screens show', () => {
    expect(defaultAutomations().CALL_LOG_SUMMARY.cc).toEqual(['designer', 'bl', 'branchHeads']);
    expect(defaultAutomations().CALL_SCHEDULED.cc).toEqual(['designer', 'bl', 'branchHeads']);
    expect(defaultAutomations().ON_HOLD.cc).toEqual([]);
  });
  it('maps draft types to their automation', () => {
    expect(eventForDraftType('MEETING_COMPLETED')).toBe('MOM');
    expect(eventForDraftType('NPS_ONBOARDING')).toBe('NPS_SURVEY');
    expect(eventForDraftType('ON_HOLD')).toBe('ON_HOLD');
  });
});

describe.skipIf(!safeDb)('automations store (local test DB)', () => {
  beforeAll(async () => {
    const mk = (role: any, name: string) => prisma.user.create({
      data: { supabaseId: `test-auto-${name}-${stamp}`, name: `Auto ${name}`, email: `auto-${name}-${stamp}@crm.test`, role },
    });
    ids.bh = (await mk('BRANCH_HEAD', 'bh')).id;
    ids.bl = (await mk('BL', 'bl')).id;
    ids.designer = (await mk('DESIGNER', 'designer')).id;
    ids.lead = (await prisma.lead.create({
      data: { leadId: `TAU-${stamp}`, name: 'Automation test', phone: '+919800000009', isTestLead: true, assignedDesignerId: ids.designer, assignedBLId: ids.bl },
    })).id;
  });
  beforeEach(async () => { await prisma.assignmentConfig.deleteMany({ where: { key: KEY } }); });
  afterAll(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: KEY } });
    await prisma.lead.delete({ where: { id: ids.lead } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: [ids.bh, ids.bl, ids.designer] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ids.bh, ids.bl, ids.designer] } } });
    await prisma.$disconnect();
  });

  it('switching an event or one channel off is respected', async () => {
    expect(await isAutomationOn('ON_HOLD', 'sms')).toBe(true);
    const v = defaultAutomations();
    v.ON_HOLD.channels.sms = false;
    v.PROPOSAL_READY.enabled = false;
    await automationsConfig.save(v, 0, ids.bh, 'No on-hold SMS');
    expect(await isAutomationOn('ON_HOLD', 'sms')).toBe(false);
    expect(await isAutomationOn('ON_HOLD', 'email')).toBe(true);
    expect(await isAutomationOn('PROPOSAL_READY', 'email')).toBe(false);
    expect((await automationsConfig.history())[0]).toMatchObject({ revision: 1, note: 'No on-hold SMS', reset: false });
  });

  it('locked events stay on whatever is submitted', async () => {
    const v = defaultAutomations();
    v.NPS_SURVEY.enabled = false;
    v.PD_OB_WELCOME.channels.email = false;
    await automationsConfig.save(v, 0, ids.bh);
    expect(await isAutomationOn('NPS_SURVEY', 'email')).toBe(true);
    expect(await isAutomationOn('PD_OB_WELCOME', 'email')).toBe(true);
  });

  it('explains problems in plain words', async () => {
    const v: any = defaultAutomations();
    v.MOM.channels.whatsapp = true;
    v.TEAM_STATUS_CHANGE.cc = ['designer'];
    v.NOT_A_THING = { enabled: true, channels: {}, cc: [] };
    const p = (await problemsOf(v)).join('\n');
    expect(p).toMatch(/Minutes of meeting: it can't be sent by whatsapp/);
    expect(p).toMatch(/only client emails can copy people/);
    expect(p).toMatch(/Unknown automation "NOT_A_THING"/);
  });

  it('copies the chosen people on a lead\'s client email', async () => {
    const cc = await automationCc('CALL_LOG_SUMMARY', ids.lead);
    expect(cc).toEqual(expect.arrayContaining([`auto-designer-${stamp}@crm.test`, `auto-bl-${stamp}@crm.test`, `auto-bh-${stamp}@crm.test`]));
    const v = defaultAutomations();
    v.CALL_LOG_SUMMARY.cc = ['designer'];
    await automationsConfig.save(v, 0, ids.bh);
    expect(await automationCc('CALL_LOG_SUMMARY', ids.lead)).toEqual([`auto-designer-${stamp}@crm.test`]);
    expect(await automationCc('ON_HOLD', ids.lead)).toEqual([]);
  });

  it('refuses a stale save and restores the original', async () => {
    await automationsConfig.save(defaultAutomations(), 0, ids.bh);
    await expect(automationsConfig.save(defaultAutomations(), 0, ids.bh)).rejects.toMatchObject({ status: 409 });
    await automationsConfig.reset(ids.bh);
    expect(await automationsConfig.get()).toEqual(defaultAutomations());
  });
});
