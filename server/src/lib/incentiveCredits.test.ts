import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  leadFlags: [] as { createdAt: Date; resolvedAt: Date | null }[],
  projectFlags: [] as { createdAt: Date; resolvedAt: Date | null }[],
}));
vi.mock('./prisma.js', () => {
  const count = (rows: typeof state.leadFlags, { where }: any) =>
    rows.filter((flag) =>
      flag.createdAt >= where.createdAt.gte &&
      flag.createdAt <= where.createdAt.lte &&
      (!where.OR || where.OR.some((condition: any) =>
        condition.resolvedAt === null
          ? flag.resolvedAt === null
          : flag.resolvedAt !== null && flag.resolvedAt > condition.resolvedAt.gt
      ))
    ).length;
  return { prisma: {
    lead: { findMany: async ({ select }: any) => select.estimatedValue ? [] : [{ id: 'fixture-lead' }] },
    designerTarget: { findFirst: async () => null },
    incentiveAttendance: { findUnique: async () => null },
    user: { findUnique: async () => ({ id: 'fixture-designer', name: 'Fixture' }) },
    leadAttentionFlag: { count: async (query: any) => count(state.leadFlags, query) },
    projectAttentionFlag: { count: async (query: any) => count(state.projectFlags, query) },
  } };
});
vi.mock('../routes/designerReports.js', () => ({
  loadFirstStageEntries: async () => new Map(),
  mqlReceived: () => ({ date: new Date('2026-10-16') }),
}));
vi.mock('./completedPitches.js', () => ({
  loadCompletedPitches: async () => ({
    all: { missingCompletionDates: 0 },
    inPeriod: () => ({ pitches: [] }),
  }),
}));
vi.mock('./bookingCancellations.js', () => ({
  loadBookingCancellations: async () => ({ excludedLeadIds: [], pendingReview: [] }),
  CancellationReviewRequired: class extends Error {},
}));

import {
  calculateDesignerCredits, calcCoreCredits, calcPitchCredits,
  DEFAULT_INCENTIVE_CONFIG as cfg, eligibility,
} from './incentiveCredits.js';

const cycle = {
  cycleStart: new Date('2026-10-15T18:30:00.000Z'),
  cycleEnd: new Date('2026-11-15T18:29:59.999Z'),
  label: '16 Oct – 15 Nov 2026',
};
const raised = new Date('2026-10-20T00:00:00Z');
beforeEach(() => { state.leadFlags = []; state.projectFlags = []; });

describe('zero escalation uses resolution at cycle end for leads and projects', () => {
  for (const source of ['leadFlags', 'projectFlags'] as const) {
    it.each([
      ['unresolved', null, 0],
      ['resolved within cycle', new Date('2026-10-21T00:00:00Z'), cfg.zeroEscalationCredits],
      ['resolved exactly at cycle end', cycle.cycleEnd, cfg.zeroEscalationCredits],
      ['resolved after cycle end', new Date(cycle.cycleEnd.getTime() + 1), 0],
    ])(`${source}: %s`, async (_label, resolvedAt, credits) => {
      state[source] = [{ createdAt: raised, resolvedAt: resolvedAt as Date | null }];
      const result = await calculateDesignerCredits('fixture-designer', cycle, cfg);
      expect(result.booster.zeroEscalation.credits).toBe(credits);
      expect(result.booster.zeroEscalation.escalations).toBe(credits === 0 ? 1 : 0);
    });
  }
  it('does not count flags raised outside the cycle', async () => {
    state.leadFlags = [{ createdAt: new Date(cycle.cycleStart.getTime() - 1), resolvedAt: null }];
    state.projectFlags = [{ createdAt: new Date(cycle.cycleEnd.getTime() + 1), resolvedAt: null }];
    expect((await calculateDesignerCredits('fixture-designer', cycle, cfg)).booster.zeroEscalation.credits)
      .toBe(cfg.zeroEscalationCredits);
  });
  it('one unresolved project flag still disqualifies after a lead flag is resolved', async () => {
    state.leadFlags = [{ createdAt: raised, resolvedAt: raised }];
    state.projectFlags = [{ createdAt: raised, resolvedAt: null }];
    expect((await calculateDesignerCredits('fixture-designer', cycle, cfg)).booster.zeroEscalation.credits).toBe(0);
  });
});

describe('agreed pitch brackets and core boundaries', () => {
  it.each([[19, 0], [20, 0], [21, 5], [30, 5], [31, 8], [39, 8], [40, 10]])(
    '%i completed pitches earns %i credits', (pitches, credits) => {
      expect(calcPitchCredits(pitches, cfg)).toBe(credits);
    },
  );
  it.each([[750000, 7.5], [1000000, 10], [1250000, 15]])(
    'booking %i at a ten-lakh target earns %i core', (booking, credits) => {
      expect(calcCoreCredits(booking, 1000000, cfg).total).toBe(credits);
    },
  );
  it.each([
    [64, false, false], [65, true, false], [74, true, false], [75, true, true],
  ])('core %i eligibility', (core, boosterApplicable, coreIncentiveEligible) => {
    expect(eligibility(core, cfg)).toMatchObject({ boosterApplicable, coreIncentiveEligible });
  });
});
