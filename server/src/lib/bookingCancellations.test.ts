import { describe, expect, it, vi } from 'vitest';
vi.mock('./prisma.js', () => ({ prisma: { lead: { findMany: vi.fn(async () => []) } } }));
import { prisma } from './prisma.js';
import { cancellationContext, loadBookingCancellations } from './bookingCancellations.js';

const cycle = {
  cycleStart: new Date('2026-10-15T18:30:00.000Z'),
  cycleEnd: new Date('2026-11-15T18:29:59.999Z'), label: 'October cycle',
};
const nextCycle = {
  cycleStart: new Date('2026-11-15T18:30:00.000Z'),
  cycleEnd: new Date('2026-12-15T18:29:59.999Z'), label: 'November cycle',
};
const now = new Date('2026-11-20T00:00:00Z');
const booked = { action: 'STAGE_CHANGED', createdAt: new Date('2026-10-17'), meta: { to: 'DESIGN_IN_PROGRESS' } };
const cancelled = (date: string, extra = {}) => ({
  action: 'STATUS_CHANGED', createdAt: new Date(date), meta: { from: 'ACTIVE', to: 'INACTIVE', ...extra },
});
const booking = (
  activityLogs: { action: string; createdAt: Date; meta: Record<string, unknown> }[] = [booked, cancelled('2026-10-20')],
  status = 'INACTIVE',
) => ({
  id: 'own-booking', leadId: 'SYNTHETIC', name: 'Synthetic booking',
  stage: 'DESIGN_IN_PROGRESS', status, activityLogs,
});

describe('booking cancellations preserve cycle history and withhold unverifiable awards', () => {
  it('excludes only the cancelled peer while keeping an active peer in the leaderboard population', () => {
    const activePeer = { ...booking([booked], 'ACTIVE'), id: 'other-active-peer' };
    const result = cancellationContext([booking(), activePeer], cycle, new Date('2026-10-21'));
    expect(result.excludedLeadIds).toEqual(['own-booking']);
    expect(result.pendingReview).toEqual([]);
  });
  it('keeps the caller peer scope AND-ed with the cancellation evidence condition', async () => {
    const base = { assignedDesignerId: { in: ['owned-d1', 'owned-d2'] } };
    await loadBookingCancellations(base, cycle);
    expect(prisma.lead.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { AND: [base, expect.any(Object), expect.any(Object)] },
    }));
  });
  it('excludes a same-cycle cancelled booking without estimating historical deductions', () => {
    expect(cancellationContext([booking()], cycle, new Date('2026-10-21'))).toEqual({
      excludedLeadIds: ['own-booking'], pendingReview: [],
    });
  });
  it('does not restore a cancelled booking when the calendar rolls over', () => {
    expect(cancellationContext([booking()], cycle, now).excludedLeadIds).toEqual(['own-booking']);
  });
  it('preserves the original cycle when cancellation happens in the following cycle', () => {
    const result = cancellationContext([booking([booked, cancelled('2026-11-17')])], cycle, now);
    expect(result).toEqual({ excludedLeadIds: [], pendingReview: [] });
  });
  it('requires review in the cancellation cycle for a previous-cycle award', () => {
    const result = cancellationContext([booking([booked, cancelled('2026-11-17')])], nextCycle, now);
    expect(result.excludedLeadIds).toEqual(['own-booking']);
    expect(result.pendingReview.map((lead) => lead.id)).toEqual(['own-booking']);
  });
  it('keeps a dated cancellation out of unrelated later-cycle reviews', () => {
    expect(cancellationContext([booking()], nextCycle, now).pendingReview).toEqual([]);
  });
  it('restores a same-cycle booking after a real reactivation event', () => {
    const events = [booked, cancelled('2026-10-20'), {
      action: 'LEAD_REACTIVATED', createdAt: new Date('2026-10-22'), meta: { from: 'INACTIVE' },
    }];
    expect(cancellationContext([booking(events, 'ACTIVE')], cycle, now)).toEqual({
      excludedLeadIds: [], pendingReview: [],
    });
  });
  it('does not let a later reactivation rewrite the closed cancellation cycle', () => {
    const events = [booked, cancelled('2026-10-20'), {
      action: 'LEAD_REACTIVATED', createdAt: new Date('2026-11-18'), meta: { from: 'INACTIVE' },
    }];
    expect(cancellationContext([booking(events, 'ACTIVE')], cycle, now).excludedLeadIds).toEqual(['own-booking']);
  });
  it('preserves historical booking evidence with undated legacy cancellation but requires review', () => {
    const result = cancellationContext([booking([booked])], cycle, now);
    expect(result.excludedLeadIds).toEqual([]);
    expect(result.pendingReview).toHaveLength(1);
  });
  it('excludes an undated inactive booking from the live cycle and requires review', () => {
    const result = cancellationContext([booking([booked])], cycle, new Date('2026-10-21'));
    expect(result.excludedLeadIds).toEqual(['own-booking']);
    expect(result.pendingReview).toHaveLength(1);
  });
  it('does not fabricate a future booking or review before the first DIP date', () => {
    const result = cancellationContext([booking([{
      ...booked, createdAt: new Date('2026-11-17'),
    }, cancelled('2026-11-18')])], cycle, now);
    expect(result).toEqual({ excludedLeadIds: [], pendingReview: [] });
  });
  it('deduplicates review evidence when cancellation appears more than once', () => {
    const result = cancellationContext([booking([
      booked, cancelled('2026-11-17'), cancelled('2026-11-18', { from: 'INACTIVE' }),
    ])], nextCycle, now);
    expect(result.pendingReview).toHaveLength(1);
  });
  it('does not erase old evidence when a later status event lacks its previous status', () => {
    const result = cancellationContext([booking([
      booked, { action: 'STATUS_CHANGED', createdAt: new Date('2026-11-17'), meta: { to: 'INACTIVE' } },
    ])], cycle, now);
    expect(result.excludedLeadIds).toEqual([]);
    expect(result.pendingReview).toHaveLength(1);
  });
});
