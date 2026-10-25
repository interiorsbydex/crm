import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the prisma singleton before importing the module under test, since
// stageSla.ts talks to the DB for admin overrides + stage-change history.
const findUnique = vi.fn();
const findMany = vi.fn();
vi.mock('./prisma.js', () => ({
  prisma: {
    assignmentConfig: { findUnique: (...args: any[]) => findUnique(...args) },
    activityLog: { findMany: (...args: any[]) => findMany(...args) },
  },
}));

const { getEffectiveStageSla, computeSlaInfoForLeads, computeSlaInfoForLead } = await import('./stageSla.js');
const { SALES_STAGE_SLA } = await import('../config/slaConfig.js');

describe('getEffectiveStageSla', () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it('falls back to the hardcoded defaults when no admin override row exists', async () => {
    findUnique.mockResolvedValue(null);
    const effective = await getEffectiveStageSla();
    expect(effective.MQL).toEqual(SALES_STAGE_SLA.MQL);
    expect(effective.ONBOARDING).toEqual(SALES_STAGE_SLA.ONBOARDING);
  });

  it('layers a partial admin override on top of the defaults without dropping the label', async () => {
    findUnique.mockResolvedValue({ value: { MQL: { warningDays: 5, breachDays: 10 } } });
    const effective = await getEffectiveStageSla();
    expect(effective.MQL).toEqual({ warningDays: 5, breachDays: 10, label: SALES_STAGE_SLA.MQL.label });
    // Untouched stages keep their exact defaults.
    expect(effective.DQL).toEqual(SALES_STAGE_SLA.DQL);
  });
});

describe('computeSlaInfoForLeads / computeSlaInfoForLead', () => {
  const now = new Date('2026-03-01T00:00:00Z');

  beforeEach(() => {
    findUnique.mockReset();
    findMany.mockReset();
    findUnique.mockResolvedValue(null); // no overrides by default
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  it('returns an empty map for an empty lead list without querying the DB', async () => {
    const result = await computeSlaInfoForLeads([]);
    expect(result).toEqual({});
    expect(findMany).not.toHaveBeenCalled();
  });

  it('uses the lead createdAt as the stage-entry date when there is no stage-change history yet', async () => {
    findMany.mockResolvedValue([]);
    const lead = { id: 'l1', stage: 'MQL', createdAt: new Date('2026-02-20T00:00:00Z') };
    const result = await computeSlaInfoForLeads([lead]);
    expect(result.l1.daysInCurrentStage).toBe(9); // Feb 20 -> Mar 1
    expect(result.l1.slaStatus).toBe('warning'); // MQL warning at 7d
  });

  it('walks multiple stage-change log entries to find the most recent transition into the current stage', async () => {
    findMany.mockResolvedValue([
      { leadId: 'l1', createdAt: new Date('2026-02-10T00:00:00Z'), meta: { from: 'EFFECTIVE_LEAD', to: 'MQL' } },
      { leadId: 'l1', createdAt: new Date('2026-02-26T00:00:00Z'), meta: { from: 'MQL', to: 'DQL' } },
    ]);
    const lead = { id: 'l1', stage: 'DQL', createdAt: new Date('2026-02-01T00:00:00Z') };
    const result = await computeSlaInfoForLeads([lead]);
    // Entered DQL on Feb 26, not the lead's original createdAt or the MQL entry.
    expect(result.l1.daysInCurrentStage).toBe(3); // Feb 26 -> Mar 1
    expect(result.l1.slaStatus).toBe('breach'); // DQL is a flat 2d/2d threshold
  });

  it('returns "ok" for a stage with no defined SLA threshold regardless of how long it has sat there', async () => {
    findMany.mockResolvedValue([]);
    const lead = { id: 'l1', stage: 'EFFECTIVE_LEAD', createdAt: new Date('2025-01-01T00:00:00Z') };
    const result = await computeSlaInfoForLeads([lead]);
    expect(result.l1.slaStatus).toBe('ok');
  });

  it('does not breach a lead freshly transitioned into ONBOARDING even if a stale legacy flag exists elsewhere', async () => {
    // Task #14 gave ONBOARDING a real 3d/3d threshold; a lead 1 day in must
    // read "ok" here — any stale legacy isSLABreached flag is a display-layer
    // concern handled separately in the leads/dashboard routes, not in this
    // stage-SLA computation.
    findMany.mockResolvedValue([
      { leadId: 'l1', createdAt: new Date('2026-02-28T00:00:00Z'), meta: { from: 'PROPOSAL_DISCUSSION', to: 'ONBOARDING' } },
    ]);
    const lead = { id: 'l1', stage: 'ONBOARDING', createdAt: new Date('2026-01-01T00:00:00Z') };
    const result = await computeSlaInfoForLeads([lead]);
    expect(result.l1.daysInCurrentStage).toBe(1);
    expect(result.l1.slaStatus).toBe('ok');
  });

  it('respects admin-configured overrides when computing status for a batch of leads', async () => {
    findUnique.mockResolvedValue({ value: { MQL: { warningDays: 1, breachDays: 2 } } });
    findMany.mockResolvedValue([]);
    const lead = { id: 'l1', stage: 'MQL', createdAt: new Date('2026-02-27T00:00:00Z') };
    const result = await computeSlaInfoForLeads([lead]);
    expect(result.l1.daysInCurrentStage).toBe(2);
    expect(result.l1.slaStatus).toBe('breach'); // overridden breachDays=2, default would only be "ok"
  });

  it('computeSlaInfoForLead is a convenience single-lead wrapper around the batch function', async () => {
    findMany.mockResolvedValue([]);
    const lead = { id: 'l1', stage: 'MQL', createdAt: new Date('2026-02-27T00:00:00Z') };
    const info = await computeSlaInfoForLead(lead);
    expect(info.daysInCurrentStage).toBe(2);
    expect(info.slaStatus).toBe('ok');
  });
});
