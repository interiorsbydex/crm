import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ send: vi.fn() }));
const drafts = new Map<string, any>();
vi.mock('./prisma.js', () => ({
  prisma: {
    assignmentConfig: { findUnique: async () => null },
    lead: { findUnique: async () => ({ name: 'Synthetic', email: 'synthetic@resend.dev' }) },
    user: { findMany: async () => [] },
    emailLog: { findFirst: async () => null, create: async () => ({}) },
    emailDraft: {
      findUnique: async ({ where }: any) => drafts.get(where.key) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const row = drafts.has(where.key) ? { ...drafts.get(where.key), ...update } : { ...create };
        drafts.set(where.key, row);
        return row;
      },
      deleteMany: async ({ where }: any) => ({ count: drafts.delete(where.key) ? 1 : 0 }),
    },
  },
}));
vi.mock('./email.js', () => ({ sendEmail: state.send }));

import { addExtra, clearExtras, listExtras, removeExtra } from './draftExtras.js';
import { saveDraft, sendDraft } from './emailService.js';

const pdf = (name: string, extra = ''): any => { const buffer = Buffer.from(`%PDF-1.4 ${extra}`); return { originalname: name, size: buffer.length, buffer }; };

beforeEach(() => { drafts.clear(); state.send.mockReset(); state.send.mockResolvedValue(undefined); });

describe('files added on a mail\'s review screen', () => {
  it('can be added, listed and removed, one list per lead and person', async () => {
    await addExtra('lead1', 'u1', pdf('Plan.pdf'));
    await addExtra('lead1', 'u1', pdf('Quote.pdf'));
    await addExtra('lead1', 'u2', pdf('Other.pdf'));
    expect((await listExtras('lead1', 'u1')).map((f) => f.filename)).toEqual(['Plan.pdf', 'Quote.pdf']);
    expect((await listExtras('lead1', 'u2')).map((f) => f.filename)).toEqual(['Other.pdf']);
    expect((await removeExtra('lead1', 'u1', 'Plan.pdf')).map((f) => f.filename)).toEqual(['Quote.pdf']);
    await clearExtras('lead1', 'u1');
    expect(await listExtras('lead1', 'u1')).toEqual([]);
  });
  it('refuses the same name twice, an eleventh file, and files that are not real documents', async () => {
    await addExtra('lead1', 'u1', pdf('Plan.pdf'));
    await expect(addExtra('lead1', 'u1', pdf('Plan.pdf'))).rejects.toThrow(/already attached/);
    for (let i = 0; i < 9; i++) await addExtra('lead1', 'u1', pdf(`f${i}.pdf`));
    await expect(addExtra('lead1', 'u1', pdf('one-too-many.pdf'))).rejects.toThrow(/at most 10/);
    await expect(addExtra('lead1', 'u3', { originalname: 'x.pdf', size: 5, buffer: Buffer.from('hello') } as any)).rejects.toThrow(/valid PDF/);
  });
  it('go out with the next mail that person sends for the lead, together with the mail\'s own documents, then are cleared', async () => {
    await saveDraft('lead1::MEETING_CONFIRMATION::m1', 'Hi', '<p>Hi</p>', { leadId: 'lead1', type: 'MEETING_CONFIRMATION' },
      [{ filename: 'Standard.pdf', content: 'AAAA' }]);
    await addExtra('lead1', 'u1', pdf('Plan.pdf'));
    await addExtra('lead1', 'u2', pdf('NotMine.pdf'));
    await sendDraft('lead1::MEETING_CONFIRMATION::m1', 'client@resend.dev', 'u1');
    const sent = state.send.mock.calls[0][0];
    expect(sent.attachments.map((a: any) => a.filename)).toEqual(['Standard.pdf', 'Plan.pdf']);
    expect(await listExtras('lead1', 'u1')).toEqual([]);
    expect((await listExtras('lead1', 'u2')).map((f) => f.filename)).toEqual(['NotMine.pdf']);
  });
  it('a mail sent with no added files is unchanged', async () => {
    await saveDraft('lead1::CALL_LOG_SUMMARY::c1', 'Hi', '<p>Hi</p>', { leadId: 'lead1', type: 'CALL_LOG_SUMMARY' });
    await sendDraft('lead1::CALL_LOG_SUMMARY::c1', 'client@resend.dev', 'u1');
    expect(state.send.mock.calls[0][0].attachments).toBeUndefined();
  });
});
