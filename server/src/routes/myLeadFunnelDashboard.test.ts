import { beforeEach, describe, expect, it, vi } from 'vitest';
// Runtime loading keeps the sibling client source outside the server tsc rootDir.
const formatterPath = new URL('../../../client/src/lib/leadProgression.ts', import.meta.url).pathname;
const { formatLeadProgressionTat } = await import(/* @vite-ignore */ formatterPath);

const state = vi.hoisted(() => ({
  leads: [] as any[],
  logs: [] as any[],
  queries: [] as any[],
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findMany: async () => [{ id: 'designer', name: 'Fixture Designer' }] },
    lead: {
      findMany: async (query: any) => {
        state.queries.push(query);
        return state.leads;
      },
    },
    activityLog: { findMany: async () => state.logs },
  },
}));
vi.mock('../middleware/auth.js', () => ({ verifyToken: vi.fn() }));

import { FUNNEL_STAGES, myLeadFunnel } from './designerReports.js';

const viewer = { id: 'designer', role: 'DESIGNER' };
const lead = (id: string, stage: string, status = 'ACTIVE', completed = false) => ({
  id, leadId: `TEST-${id}`, name: 'Synthetic fixture', stage, status,
  leadOriginDate: new Date('2026-10-01T00:00:00Z'),
  dipChecklist: completed ? { completedAt: new Date('2026-10-04T00:00:00Z') } : null,
});

beforeEach(() => {
  state.queries = [];
  state.leads = [
    lead('mql', 'MQL'),
    lead('pp', 'PROPOSAL_PRESENTED'),
    lead('won', 'DESIGN_IN_PROGRESS', 'ACTIVE', true),
    lead('incomplete', 'DESIGN_IN_PROGRESS', 'ON_HOLD'),
    lead('inactive', 'PROPOSAL_DISCUSSION', 'INACTIVE'),
    lead('legacy', 'EFFECTIVE_LEAD'),
  ];
  state.logs = [
    { leadId: 'pp', action: 'STAGE_CHANGED', createdAt: new Date('2026-10-03T07:12:00Z'), meta: { to: 'PROPOSAL_PRESENTED' } },
    { leadId: 'won', action: 'STAGE_CHANGED', createdAt: new Date('2026-10-04T00:00:00Z'), meta: { to: 'DESIGN_IN_PROGRESS' } },
    { leadId: 'inactive', action: 'STAGE_CHANGED', createdAt: new Date('2026-10-02T00:00:00Z'), meta: { to: 'PROPOSAL_DISCUSSION' } },
  ];
});

describe('Dashboard cumulative progression shares the report definitions', () => {
  it('preserves the existing six report rows and adds every dashboard stage', async () => {
    const result = await myLeadFunnel(viewer, {});
    expect(result.stages.map((row) => row.stage)).toEqual([
      'RECEIVED', 'MQL', 'DQL', 'PROPOSAL_PRESENTED', 'ONBOARDING', 'CONVERSION',
    ]);
    expect(result.progressionStages.map((row) => row.stage)).toEqual([
      'RECEIVED', ...FUNNEL_STAGES.map((stage) => stage === 'DESIGN_IN_PROGRESS' ? 'CONVERSION' : stage),
    ]);
    for (const original of result.stages) {
      expect(result.progressionStages.find((row) => row.stage === original.stage)).toEqual(original);
    }
  });

  it('counts cumulative progress, not the number currently sitting in each stage', async () => {
    const result = await myLeadFunnel(viewer, {});
    const totals = Object.fromEntries(result.progressionStages.map((row) => [row.stage, row.total]));
    expect(totals).toEqual({
      RECEIVED: 6, MQL: 5, DQL: 4, PROPOSAL_READY: 4, PROPOSAL_PRESENTED: 4,
      PROPOSAL_DISCUSSION: 3, ONBOARDING: 2, ONBOARDING_MEETING: 2, CONVERSION: 1,
    });
    const pp = result.progressionStages.find((row) => row.stage === 'PROPOSAL_PRESENTED')!;
    expect(pp.progressionPct).toBe(66.7);
    expect(pp.total).toBe(pp.active + pp.onHold + pp.inactive);
    expect(result.progressionStages.find((row) => row.stage === 'CONVERSION')!.drilldown.map((row) => row.id)).toEqual(['won']);
  });

  it('does not invent TAT dates for skipped stages or include inactive TAT', async () => {
    const result = await myLeadFunnel(viewer, {});
    const dql = result.progressionStages.find((row) => row.stage === 'DQL')!;
    expect(dql.total).toBe(4);
    expect(dql.avgTatDays).toBeNull();
    expect(dql.tatSampleSize).toBe(0);
    expect(result.progressionStages.find((row) => row.stage === 'PROPOSAL_PRESENTED')!.avgTatDays).toBe(2.3);
    expect(result.progressionStages.find((row) => row.stage === 'PROPOSAL_DISCUSSION')!.avgTatDays).toBeNull();
  });

  it('retains Designer-only scope and exclusion of test leads and duplicates', async () => {
    await myLeadFunnel(viewer, { designerId: 'someone-else' });
    expect(state.queries[0].where).toMatchObject({
      assignedDesignerId: { in: ['designer'] }, isTestLead: false, isDuplicate: false,
    });
  });

  it('returns zero counts and unavailable percentages for an empty cohort', async () => {
    state.leads = [];
    state.logs = [];
    const result = await myLeadFunnel(viewer, {});
    for (const row of result.progressionStages) {
      expect(row.total).toBe(0);
      expect(row.progressionPct).toBeNull();
      expect(row.avgTatDays).toBeNull();
    }
  });
});

describe('Readable TAT display does not change underlying report values', () => {
  it.each([
    [null, '—'], [Number.NaN, '—'], [Number.POSITIVE_INFINITY, '—'], [-1, '—'],
    [0, '0 days'], [0.1, 'Less than 1 day'], [1, '1 day'], [2.3, '2 days'],
    [11.3, '11 days'], [9.6, '10 days'],
  ] as [number | null, string][])('formats %s as %s', (days, expected) => {
    expect(formatLeadProgressionTat(days)).toBe(expected);
  });
});
