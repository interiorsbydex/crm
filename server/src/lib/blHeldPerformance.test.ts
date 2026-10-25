import { describe, expect, it, vi } from 'vitest';
vi.mock('./prisma.js', () => ({ prisma: {} }));
import { summarizeBlHeldLeads } from './blHeldPerformance.js';
import { getCycleForDate } from './targetCycle.js';

const october = getCycleForDate(new Date('2026-10-20T12:00:00Z'));
const november = getCycleForDate(new Date('2026-11-20T12:00:00Z'));
const lead = (overrides: Record<string, any> = {}) => ({
  id: 'held', leadId: 'TEST-HELD', name: 'Synthetic BL-held',
  stage: 'MQL', status: 'ACTIVE',
  leadOriginDate: new Date('2026-10-20T12:00:00Z'),
  dipChecklist: null,
  activityLogs: [],
  ...overrides,
});
const booked = (overrides: Record<string, any> = {}) => lead({
  stage: 'DESIGN_IN_PROGRESS',
  dipChecklist: { completedAt: new Date('2026-10-21T12:00:00Z') },
  activityLogs: [{ createdAt: new Date('2026-10-21T12:00:00Z'), meta: { to: 'DESIGN_IN_PROGRESS' } }],
  ...overrides,
});

describe('BL-held current inventory without guessed historical achievement', () => {
  it('separates current inventory statuses and cycle received counts', () => {
    const data = summarizeBlHeldLeads([
      lead(), lead({ id: 'hold', status: 'ON_HOLD' }),
      lead({ id: 'inactive', status: 'INACTIVE', leadOriginDate: new Date('2026-09-01') }),
    ], [october]);
    expect(data.statusCounts).toEqual({ total: 3, active: 1, onHold: 1, inactive: 1 });
    expect(data.cycles[0]).toMatchObject({ leadsReceived: 2, bookingValue: 0, bookingReview: [] });
  });
  it('does not call a currently held historic booking attributable achievement', () => {
    const data = summarizeBlHeldLeads([booked()], [october]);
    expect(data.cycles[0].bookingValue).toBeNull();
    expect(data.cycles[0].bookingReview).toHaveLength(1);
    expect(data.cycles[0].bookingReview[0].reason).toContain('Ownership at booking cannot be verified');
  });
  it('uses the first forward DIP entry once, not every repeated/backward log', () => {
    const data = summarizeBlHeldLeads([booked({ activityLogs: [
      { createdAt: new Date('2026-11-20'), meta: { to: 'DESIGN_IN_PROGRESS' } },
      { createdAt: new Date('2026-10-21'), meta: { to: 'DESIGN_IN_PROGRESS' } },
      { createdAt: new Date('2026-09-21'), meta: { to: 'DESIGN_IN_PROGRESS', isBackward: true } },
    ] })], [october, november]);
    expect(data.cycles.map((cycle) => cycle.bookingReview.length)).toEqual([1, 0]);
  });
  it('shows undated bookings as unavailable rather than inventing their cycle', () => {
    const data = summarizeBlHeldLeads([booked({ activityLogs: [] })], [october, november]);
    expect(data.cycles.every((cycle) => cycle.bookingValue === null)).toBe(true);
    expect(data.cycles[0].bookingReview[0].reason).toContain('booking date is missing');
  });
  it('does not treat incomplete checklists as booked', () => {
    const data = summarizeBlHeldLeads([booked({ dipChecklist: { completedAt: null } })], [october]);
    expect(data.cycles[0].bookingValue).toBe(0);
    expect(data.cycles[0].bookingReview).toHaveLength(0);
  });
  it('does not create a cancellation reversal or award from an inactive current lead', () => {
    const data = summarizeBlHeldLeads([booked({ status: 'INACTIVE' })], [october]);
    expect(data.cycles[0].bookingValue).toBeNull();
    expect(data.statusCounts.inactive).toBe(1);
  });
  it('keeps an undated completed booking unavailable even if its current stage is inactive', () => {
    const data = summarizeBlHeldLeads([booked({ stage: 'INACTIVE', status: 'INACTIVE', activityLogs: [] })], [october]);
    expect(data.cycles[0].bookingValue).toBeNull();
    expect(data.cycles[0].bookingReview[0].reason).toContain('booking date is missing');
  });
  it('includes both exact cycle boundaries in lead receipt counts', () => {
    const data = summarizeBlHeldLeads([
      lead({ leadOriginDate: october.cycleStart }),
      lead({ id: 'last', leadOriginDate: october.cycleEnd }),
      lead({ id: 'after', leadOriginDate: new Date(october.cycleEnd.getTime() + 1) }),
    ], [october]);
    expect(data.cycles[0].leadsReceived).toBe(2);
  });
});
