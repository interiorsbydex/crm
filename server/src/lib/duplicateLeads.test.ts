import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import { phoneKey, findDuplicateLead, recordDuplicateEnquiry } from './duplicateLeads.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');

describe('phoneKey', () => {
  it('compares on the last 10 digits', () => {
    expect(phoneKey('+91 98765 43210')).toBe('9876543210');
    expect(phoneKey('098765-43210')).toBe('9876543210');
    expect(phoneKey(null)).toBe('');
  });
});

describe.skipIf(!safeDb)('duplicate lead matching', () => {
  const tag = `dup${Date.now()}`;
  let uid = '';
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: 'Dup Tester', email: `${tag}@x.test`, supabaseId: tag, role: 'DESIGNER' } });
    uid = u.id;
    await prisma.lead.create({ data: { leadId: `D${tag}`.slice(0, 20), name: 'Dup Lead', phone: '+91 91234 56789', email: 'Dup.Person@Example.com', assignedDesignerId: uid } });
  });
  afterAll(async () => {
    await prisma.notificationLog.deleteMany({ where: { userId: uid } });
    await prisma.activityLog.deleteMany({ where: { OR: [{ userId: uid }, { lead: { assignedDesignerId: uid } }] } });
    await prisma.lead.deleteMany({ where: { assignedDesignerId: uid } });
    await prisma.user.delete({ where: { id: uid } });
    await prisma.$disconnect();
  });

  it('matches a phone with or without the country code and spacing', async () => {
    expect((await findDuplicateLead({ phone: '9123456789' }))?.matchedOn).toBe('phone');
    expect((await findDuplicateLead({ phone: '+919123456789' }))?.name).toBe('Dup Lead');
  });
  it('matches an email ignoring case', async () => {
    const m = await findDuplicateLead({ phone: '9000000000', email: 'dup.person@example.COM' });
    expect(m?.matchedOn).toBe('email');
  });
  it('returns null for someone new', async () => {
    expect(await findDuplicateLead({ phone: '9000000001', email: 'new@example.com' })).toBeNull();
  });
  it('records the repeat enquiry on the existing lead and alerts its designer', async () => {
    const m = (await findDuplicateLead({ phone: '9123456789' }))!;
    await recordDuplicateEnquiry(m, uid, { source: 'META_ADS', name: 'Dup Lead', phone: '9123456789' });
    expect(await prisma.activityLog.count({ where: { leadId: m.id, action: 'DUPLICATE_ENQUIRY' } })).toBe(1);
    expect(await prisma.notificationLog.count({ where: { userId: uid, type: 'DUPLICATE_ENQUIRY' } })).toBe(1);
  });
});
