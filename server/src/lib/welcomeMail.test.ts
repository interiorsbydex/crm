// Runs against the local test database (DATABASE_URL), never a shared one.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import { MAIL_TEMPLATES, getEffectiveMailTemplates } from './mailTemplates.js';
import { BUILT_IN_ITEMS, defaultChecklists, evaluateChecklist } from './checklists.js';
import { pdObWelcomeMailTemplate } from '../routes/pdObChecklist.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');
const GENERIC = 'Filled in automatically when the mail is sent.';

describe.skipIf(!safeDb)('welcome mail wording and checklist placement', () => {
  beforeEach(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: { in: ['mail_template_overrides', 'checklists_v1'] } } });
  });
  afterAll(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: { in: ['mail_template_overrides', 'checklists_v1'] } } });
    await prisma.$disconnect();
  });

  it('every blank of every mail template has plain-English help and an example', async () => {
    for (const t of await getEffectiveMailTemplates()) {
      expect(t.placeholderHelp.map((h) => h.name)).toEqual(t.placeholders);
      for (const h of t.placeholderHelp) {
        expect(h.meaning, `${t.code}.${h.name}`).not.toBe(GENERIC);
        expect(h.example, `${t.code}.${h.name}`).not.toBe('');
      }
    }
  });

  it('every {{blank}} used in a default template is one the template lists', () => {
    for (const t of MAIL_TEMPLATES) {
      const used = new Set([...(t.defaultSubject + t.defaultHtml).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
      for (const name of used) expect(t.placeholders, `${t.code} uses {{${name}}}`).toContain(name);
    }
  });

  it('the welcome mail shows the payment, project value, OB meeting date, time and place, and the notes', async () => {
    const { html } = await pdObWelcomeMailTemplate('Priya Sharma', {
      paymentValue: 150000, projectValue: 1800000,
      obMeetingScheduledAt: new Date('2026-11-14T06:00:00Z'), // 11:30 am IST
      obMeetingLocation: "Client's Site", notes: 'Keep the balcony plan ready.\nBring <ID>.', furnitureValue: 250000,
    });
    expect(html).toContain('Priya Sharma');
    expect(html).toContain('₹1,50,000');
    expect(html).toContain('₹18,00,000');
    expect(html).toMatch(/14 Nov 2026,? 11:30 am/i);
    expect(html).toContain("Client's Site");
    expect(html).toContain('Keep the balcony plan ready.<br/>Bring &lt;ID&gt;.');
    expect(html).not.toContain('{{');
    expect(html).not.toContain('be in touch shortly');
  });

  it('with no notes entered, no notes paragraph appears', async () => {
    const { html } = await pdObWelcomeMailTemplate('Priya', { paymentValue: 1, projectValue: 2, obMeetingScheduledAt: null, obMeetingLocation: null, notes: '  ' });
    expect(html).not.toContain('Notes:');
  });

  it('the approval screenshot is optional on PD→OB and asked for on OB→OBM by default', async () => {
    const d = defaultChecklists();
    expect(d.pdOb.optional).toContain('welcomeMailScreenshot');
    expect(d.obObm.optional).not.toContain('welcomeMailScreenshot');
    expect(BUILT_IN_ITEMS.obObm.some((i) => i.key === 'welcomeMailScreenshot')).toBe(true);

    const pd = await evaluateChecklist('pdOb', 'no-such-lead', {});
    expect(pd.items.find((i) => i.key === 'welcomeMailScreenshot')).toMatchObject({ required: false, met: false });
    expect(pd.missing.some((m) => /approval screenshot/i.test(m))).toBe(false);

    const ob = await evaluateChecklist('obObm', 'no-such-lead', {});
    expect(ob.items.find((i) => i.key === 'welcomeMailScreenshot')).toMatchObject({ required: true, met: false });
    expect(ob.missing.some((m) => /approval screenshot/i.test(m))).toBe(true);
  });
});
