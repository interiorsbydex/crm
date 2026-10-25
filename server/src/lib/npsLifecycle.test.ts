import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  response: { id: 'survey', formToken: 'synthetic-only-token', sentAt: null as Date | null, respondedAt: null as Date | null },
  loggedAt: null as Date | null,
  checklistUpdates: [] as any[],
  send: vi.fn(),
  missingEmail: false,
}));
vi.mock('./prisma.js', () => ({
  prisma: {
    nPSResponse: {
      upsert: async () => ({ ...state.response }),
      findUnique: async () => ({ ...state.response }),
      update: async ({ data }: any) => Object.assign(state.response, data),
    },
    emailLog: {
      findFirst: async () => state.loggedAt ? { sentAt: state.loggedAt } : null,
      create: async () => { state.loggedAt = new Date(); return {}; },
    },
    oBOBMChecklist: {
      updateMany: async (query: any) => { state.checklistUpdates.push(query); return { count: 1 }; },
    },
    lead: {
      findUnique: async () => ({ name: 'Synthetic QA', email: state.missingEmail ? null : 'synthetic@resend.dev' }),
    },
    // Admin settings (e.g. Automations): nothing saved, so defaults apply.
    assignmentConfig: { findUnique: async () => null },
    // Drafts are stored in the EmailDraft table; an in-memory stand-in here.
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
const drafts = new Map<string, any>();
vi.mock('./email.js', () => ({ sendEmail: state.send }));
vi.mock('./mailTemplates.js', () => ({
  renderMailTemplate: async (_code: string, vars: any) => ({ subject: 'Synthetic NPS', html: `<p>${vars.ratingUrl}</p>` }),
}));
vi.mock('./baseUrl.js', () => ({ resolveBaseUrl: () => 'https://synthetic.invalid' }));

import { createAndSendNps, getNpsSendState } from './npsHelper.js';
import { getDraft, registerOnSentHandler, saveDraft, sendDraft } from './emailService.js';

beforeEach(() => {
  state.response.sentAt = null;
  state.response.respondedAt = null;
  state.loggedAt = null;
  state.checklistUpdates = [];
  state.missingEmail = false;
  state.send.mockReset();
  state.send.mockResolvedValue(undefined);
});

describe('NPS drafting, sending and deduplication', () => {
  it('prepares an editable draft without marking the survey/checklist sent', async () => {
    const pending = await createAndSendNps('lead', 'ONBOARDING');
    expect(pending?.draftKey).toBe('lead::NPS_ONBOARDING');
    expect(state.response.sentAt).toBeNull();
    expect(state.checklistUpdates).toHaveLength(0);
    expect(state.send).not.toHaveBeenCalled();
    // Annie #8: a prepared draft is reported as a draft, never as sent.
    expect(await getNpsSendState('lead', 'ONBOARDING')).toMatchObject({ status: 'NOT_SENT', draftPrepared: true });
  });

  it('keeps the original survey token when reopening an unsent draft', async () => {
    const first = await createAndSendNps('lead', 'ONBOARDING');
    const second = await createAndSendNps('lead', 'ONBOARDING');
    expect(second?.html).toBe(first?.html);
    expect(second?.html).toContain('synthetic-only-token');
    expect(state.send).not.toHaveBeenCalled();
  });

  it('retains the post-send callback after the generic edit then send path', async () => {
    await createAndSendNps('lead', 'ONBOARDING');
    saveDraft('lead::NPS_ONBOARDING', 'Edited subject', '<p>Edited message</p>', { leadId: 'lead', type: 'NPS_ONBOARDING' });
    await sendDraft('lead::NPS_ONBOARDING', 'synthetic@resend.dev', 'designer');
    expect(state.send).toHaveBeenCalledOnce();
    expect(state.response.sentAt).toBeInstanceOf(Date);
    expect(state.checklistUpdates[0].data.npsTriggered).toBe(true);
    expect((await getNpsSendState('lead', 'ONBOARDING')).status).toBe('SENT');
    expect(await createAndSendNps('lead', 'ONBOARDING')).toBeNull();
  });

  it('recognises a historical successful send even if its callback did not set sentAt', async () => {
    state.loggedAt = new Date('2026-10-24T04:00:00Z');
    expect(await createAndSendNps('lead', 'ONBOARDING')).toBeNull();
    expect((await getNpsSendState('lead', 'ONBOARDING')).sentAt).toEqual(state.loggedAt);
    expect(state.response.sentAt).toBeNull();
    expect(state.checklistUpdates).toHaveLength(0);
  });

  it('does not request an already-answered survey or invent a send timestamp', async () => {
    state.response.respondedAt = new Date('2026-10-24T04:00:00Z');
    expect(await createAndSendNps('lead', 'ONBOARDING')).toBeNull();
    expect(await getNpsSendState('lead', 'ONBOARDING')).toMatchObject({ status: 'RESPONDED', sentAt: null });
  });

  it('leaves a failed send retryable, with no successful status or checklist update', async () => {
    await createAndSendNps('lead', 'ONBOARDING');
    state.send.mockRejectedValueOnce(new Error('Synthetic provider failure'));
    await expect(sendDraft('lead::NPS_ONBOARDING', 'synthetic@resend.dev', 'designer')).rejects.toThrow('Synthetic provider failure');
    expect(getDraft('lead::NPS_ONBOARDING')).not.toBeNull();
    expect(state.response.sentAt).toBeNull();
    expect(state.loggedAt).toBeNull();
    expect(state.checklistUpdates).toHaveLength(0);
    await sendDraft('lead::NPS_ONBOARDING', 'synthetic@resend.dev', 'designer');
    expect((await getNpsSendState('lead', 'ONBOARDING')).status).toBe('SENT');
  });

  it('does not report a missing-email draft as sent', async () => {
    state.missingEmail = true;
    expect(await createAndSendNps('lead', 'ONBOARDING')).toBeNull();
    expect((await getNpsSendState('lead', 'ONBOARDING')).status).toBe('NOT_SENT');
  });
});

describe('Shared draft metadata protection', () => {
  it('preserves welcome-mail callbacks and attachments across partial metadata edits', async () => {
    const handler = vi.fn(async () => {});
    registerOnSentHandler('FIXTURE_WELCOME', handler);
    const attachments: any[] = [{ filename: 'synthetic.pdf', content: Buffer.from('Synthetic QA only') }];
    await saveDraft('welcome', 'Original', '<p>Original</p>', { leadId: 'lead', type: 'WELCOME', onSentAction: 'FIXTURE_WELCOME' }, attachments);
    await saveDraft('welcome', 'Edited', '<p>Edited</p>', { leadId: 'lead', type: 'WELCOME' });
    await sendDraft('welcome', 'synthetic@resend.dev', 'designer');
    expect(handler).toHaveBeenCalledWith('lead', 'designer');
    expect(state.send.mock.calls[0][0].attachments).toEqual(attachments);
  });

  it('does not inherit another lead/type callback when identity differs', async () => {
    await saveDraft('identity', 'One', '<p>One</p>', { leadId: 'one', type: 'FIRST', onSentAction: 'FIRST_ACTION' });
    await saveDraft('identity', 'Two', '<p>Two</p>', { leadId: 'two', type: 'SECOND' });
    expect((await getDraft('identity'))?.meta).toEqual({ leadId: 'two', type: 'SECOND' });
  });
});
