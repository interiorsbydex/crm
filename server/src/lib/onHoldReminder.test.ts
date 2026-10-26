import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import { sendOnHoldReminders } from './onHoldReminder.js';
import { saveCrmSettings, CRM_SETTINGS_KEY, DEFAULT_CRM_SETTINGS, CrmSettingsError } from './crmSettings.js';
import { istDayBounds } from './istTime.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!safeDb)('On Hold reminder', () => {
  const tag = `ohr${Date.now()}`;
  let designer = '', bl = '';
  const now = new Date();
  const todayStart = istDayBounds(now).start;
  const leadIds: string[] = [];

  async function onHold(suffix: string, revival: Date) {
    const l = await prisma.lead.create({
      data: { leadId: `${tag}${suffix}`.slice(0, 20), name: `Hold ${suffix}`, phone: `+9100${Date.now() % 1e8}${suffix}`, status: 'ON_HOLD', onHoldRevivalDate: revival, assignedDesignerId: designer, assignedBLId: bl },
    });
    leadIds.push(l.id);
    return l;
  }
  async function setDays(n: number) {
    const row = await prisma.assignmentConfig.findUnique({ where: { key: CRM_SETTINGS_KEY } });
    const rev = (row?.value as any)?.revision ?? 0;
    await saveCrmSettings({ ...DEFAULT_CRM_SETTINGS, onHoldReminderDaysBefore: n }, rev, designer);
  }

  beforeAll(async () => {
    designer = (await prisma.user.create({ data: { name: 'OHR Designer', email: `${tag}d@x.test`, supabaseId: `${tag}d`, role: 'DESIGNER' } })).id;
    bl = (await prisma.user.create({ data: { name: 'OHR BL', email: `${tag}b@x.test`, supabaseId: `${tag}b`, role: 'BL' } })).id;
  });
  beforeEach(async () => {
    await prisma.notificationLog.deleteMany({ where: { userId: { in: [designer, bl] } } });
    await prisma.lead.deleteMany({ where: { id: { in: leadIds.splice(0) } } });
    await prisma.assignmentConfig.deleteMany({ where: { key: CRM_SETTINGS_KEY } });
  });
  afterAll(async () => {
    await prisma.notificationLog.deleteMany({ where: { userId: { in: [designer, bl] } } });
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
    await prisma.activityLog.deleteMany({ where: { userId: designer } });
    await prisma.assignmentConfig.deleteMany({ where: { key: CRM_SETTINGS_KEY } });
    await prisma.user.deleteMany({ where: { id: { in: [designer, bl] } } });
    await prisma.$disconnect();
  });

  it('by default reminds the designer and BL one day before, and only once', async () => {
    await onHold('1', new Date(todayStart.getTime() + DAY));
    expect((await sendOnHoldReminders(now)).reminded).toBe(2);
    expect(await prisma.notificationLog.count({ where: { userId: designer, type: 'ON_HOLD_REOPEN' } })).toBe(1);
    expect(await prisma.notificationLog.count({ where: { userId: bl, type: 'ON_HOLD_REOPEN' } })).toBe(1);
    expect((await sendOnHoldReminders(now)).reminded).toBe(0);
  });
  it('does not remind yet when the date is further away than the setting', async () => {
    await onHold('2', new Date(todayStart.getTime() + 4 * DAY));
    expect((await sendOnHoldReminders(now)).reminded).toBe(0);
    await setDays(5);
    expect((await sendOnHoldReminders(now)).reminded).toBe(2);
  });
  it('0 switches the reminder off', async () => {
    await setDays(0);
    await onHold('3', new Date(todayStart.getTime() + DAY));
    expect((await sendOnHoldReminders(now)).reminded).toBe(0);
  });
  it('a new revival date earns a new reminder, but active leads and past dates never do', async () => {
    const l = await onHold('4', new Date(todayStart.getTime() + DAY));
    await sendOnHoldReminders(now);
    await prisma.lead.update({ where: { id: l.id }, data: { onHoldRevivalDate: new Date(todayStart.getTime() + DAY + 3600_000) } });
    expect((await sendOnHoldReminders(now)).reminded).toBe(2);
    await prisma.lead.update({ where: { id: l.id }, data: { status: 'ACTIVE' } });
    await onHold('5', new Date(todayStart.getTime() - DAY));
    await prisma.notificationLog.deleteMany({ where: { userId: { in: [designer, bl] } } });
    expect((await sendOnHoldReminders(now)).reminded).toBe(0);
  });
  it('refuses a negative, fractional or huge number of days in plain English', async () => {
    for (const bad of [-1, 1.5, 31]) {
      await expect(saveCrmSettings({ ...DEFAULT_CRM_SETTINGS, onHoldReminderDaysBefore: bad }, 0, designer)).rejects.toBeInstanceOf(CrmSettingsError);
    }
  });
});
