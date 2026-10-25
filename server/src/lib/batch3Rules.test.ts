// Runs against the local test database (DATABASE_URL), never a shared one.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import { alertSettingsConfig, createNotification } from './notifications.js';
import { DEFAULT_CRM_SETTINGS, validateCrmSettings } from './crmSettings.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');
const KEYS = ['in_app_alerts_v1'];

async function store(key: string, value: unknown) {
  await prisma.assignmentConfig.create({ data: { key, value: { value, revision: 1, updatedAt: new Date().toISOString(), updatedById: 'x' } as any } });
}

describe.skipIf(!safeDb)('batch 3 rules', () => {
  let userId = '';
  const created: string[] = [];
  beforeEach(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: { in: KEYS } } });
    const u = await prisma.user.findFirst({ where: { role: 'DESIGNER' }, select: { id: true } });
    userId = u?.id ?? '';
  });
  afterAll(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: { in: KEYS } } });
    if (created.length) await prisma.notificationLog.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  it('an alert switched off for a role is recorded but hidden', async () => {
    if (!userId) return;
    const shown = await createNotification(userId, 'CALL_LOGGED', 'test alert shown');
    created.push(shown.id);
    expect(shown.muted).toBe(false);
    await store('in_app_alerts_v1', await alertSettingsConfig.spec.validate({ off: { CALL_LOGGED: ['DESIGNER'] } }));
    const hidden = await createNotification(userId, 'CALL_LOGGED', 'test alert hidden');
    created.push(hidden.id);
    expect(hidden.muted).toBe(true);
    expect(hidden.isRead).toBe(true);
  });

  it('call and approval settings have safe limits', () => {
    expect(DEFAULT_CRM_SETTINGS.calls.rnrEscalationAfter).toBe(5);
    expect(DEFAULT_CRM_SETTINGS.discount.requireApprovalComment).toBe(false);
    expect(DEFAULT_CRM_SETTINGS.notifyClientByDefault).toBe(true);
    expect(() => validateCrmSettings({ ...DEFAULT_CRM_SETTINGS, calls: { ...DEFAULT_CRM_SETTINGS.calls, rnrEscalationAfter: 0 } })).toThrow();
  });
});
