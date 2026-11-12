import { describe, it, expect } from 'vitest';
import { wasActiveAt, funnelRows, intentTier, monthWindows, blBoardRulesConfig, defaultBlBoardRules } from './blBoard.js';

// Annie's BL dashboard mockup (12 Nov 2026).
const d = (s: string) => new Date(s);

describe('BL dashboard counting', () => {
  it('works out whether a lead was active a month ago from its later changes', () => {
    const lead = { createdAt: d('2026-09-01'), status: 'INACTIVE', stage: 'DQL', changes: [
      { action: 'STATUS_CHANGED', createdAt: d('2026-10-20'), meta: { from: 'ACTIVE', to: 'INACTIVE' } },
    ] };
    expect(wasActiveAt(lead, d('2026-10-10'))).toBe(true);   // made inactive later
    expect(wasActiveAt(lead, d('2026-10-25'))).toBe(false);  // already inactive
    expect(wasActiveAt({ ...lead, createdAt: d('2026-10-15') }, d('2026-10-10'))).toBe(false); // not yet in the CRM
    const booked = { createdAt: d('2026-09-01'), status: 'ACTIVE', stage: 'DESIGN_IN_PROGRESS', changes: [
      { action: 'STAGE_CHANGED', createdAt: d('2026-10-20'), meta: { from: 'ONBOARDING_MEETING', to: 'DESIGN_IN_PROGRESS' } },
    ] };
    expect(wasActiveAt(booked, d('2026-10-10'))).toBe(true);  // still in the pipeline then
    expect(wasActiveAt(booked, d('2026-10-25'))).toBe(false); // booked since
  });
  it('funnel: count at each stage, and the share at that stage or further on', () => {
    const rows = funnelRows(['MQL', 'MQL', 'DQL', 'PROPOSAL_PRESENTED']);
    expect(rows.find((r) => r.stage === 'MQL')).toEqual({ stage: 'MQL', count: 2, pctAtOrBeyond: 100 });
    expect(rows.find((r) => r.stage === 'DQL')).toEqual({ stage: 'DQL', count: 1, pctAtOrBeyond: 50 });
    expect(rows.find((r) => r.stage === 'PROPOSAL_PRESENTED')!.pctAtOrBeyond).toBe(25);
  });
  it('intent tiers follow Admin → Formulas; no rating counts as low', () => {
    const t = { highFrom: 4, mediumFrom: 3 };
    expect([5, 4, 3, 2, null].map((r) => intentTier(r, t))).toEqual(['high', 'high', 'medium', 'low', 'low']);
  });
  it('NPS months are calendar months in India time, oldest first', () => {
    const m = monthWindows(d('2026-11-12T10:00:00Z'), 3);
    expect(m.map((x) => x.label)).toEqual(['Sep', 'Oct', 'Nov']);
    expect(m[2].from.toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });
  it('Annie can change the rules, within sensible limits', async () => {
    const ok = await blBoardRulesConfig.spec.validate({ ...defaultBlBoardRules(), inactiveDqlDays: 10, highValueFrom: 3000000 });
    expect(ok.inactiveDqlDays).toBe(10);
    await expect(Promise.resolve().then(() => blBoardRulesConfig.spec.validate({ ...defaultBlBoardRules(), inactiveDqlDays: 0 }))).rejects.toThrow(/could not be saved/);
  });
});
