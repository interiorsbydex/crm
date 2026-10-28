import { describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => [] as any[]);
vi.mock('./prisma.js', () => ({ prisma: {} }));
vi.mock('./activityLog.js', () => ({ logActivity: async (...args: any[]) => { logged.push(args); } }));
vi.mock('../routes/designerReports.js', () => ({ loadFirstStageEntries: async () => new Map(), mqlReceived: () => ({ date: new Date() }) }));

import {
  DEFAULT_BL_CREDIT_CONFIG as CFG, bookingDates, calcBlCore, calcBlCredits, calcBlPitchBooster, parseBlCreditConfig,
  type BlBooking, type BlPitch,
} from './blCredits.js';
import { blAt, membershipShare, recordTeamChange, teamIntervals, type TeamChange } from './blTeamHistory.js';

const LAKH = 100_000;
const CR = 100 * LAKH;
// 16 Oct – 15 Nov 2026 IST
const cycle = { cycleStart: new Date('2026-10-15T18:30:00Z'), cycleEnd: new Date('2026-11-15T18:29:59.999Z') };
const after = new Date('2026-12-01T00:00:00Z');
const at = (iso: string) => new Date(iso);

const booking = (over: Partial<BlBooking>): BlBooking => ({
  id: over.leadId ?? 'b', leadId: 'L-1', name: 'Lead', value: 10 * LAKH,
  bookedAt: at('2026-10-20T06:00:00Z'), mqlAt: at('2026-10-01T06:00:00Z'),
  cancelledAt: null, undatedCancellation: false, designerId: 'd1', designerName: 'Designer 1', ...over,
});
const pitch = (over: Partial<BlPitch>): BlPitch => ({
  id: over.leadId ?? 'p', leadId: 'P-1', name: 'Lead', completedAt: at('2026-10-20T06:00:00Z'),
  mqlAt: at('2026-10-01T06:00:00Z'), designerId: 'd1', ...over,
});
const run = (input: Partial<Parameters<typeof calcBlCredits>[0]>, cfg = CFG) => calcBlCredits({
  bookings: [], pitches: [], team: [], targetValue: 1.2 * CR, cycle, pitchApproval: null, now: after, ...input,
}, cfg);

describe('Rule 1 — core credits', () => {
  it('standard = achieved ÷ target × 100, not capped; overachievement = 2 per ₹1 lakh above target', () => {
    const c = calcBlCore(1.3 * CR, 1.2 * CR, CFG);
    expect(c.standard).toBe(108.33);
    expect(c.overachievement).toBe(20);
    expect(c.total).toBe(128.33);
  });

  it('Annie\'s worked example (100 + 20 = 120) when Admin sets standard credits to stop at 100', () => {
    const c = calcBlCore(1.3 * CR, 1.2 * CR, { ...CFG, standardAboveTarget: 'stop_at_100' });
    expect(c).toMatchObject({ standard: 100, overachievement: 20, total: 120 });
  });

  it('below target: proportional standard credits, no overachievement', () => {
    expect(calcBlCore(0.9 * CR, 1.2 * CR, CFG)).toMatchObject({ standard: 75, overachievement: 0, total: 75 });
  });

  it('overachievement is proportional, no rounding to whole lakhs', () => {
    expect(calcBlCore(1.2 * CR + 50_000, 1.2 * CR, CFG).overachievement).toBe(1);
  });

  it('no target set: core credits unavailable', () => {
    expect(calcBlCore(1 * CR, null, CFG)).toMatchObject({ targetMissing: true, total: 0 });
  });
});

describe('Rule 2 — team pitch booster', () => {
  it('slabs scale with team size: 4 designers → above 80 / 100 / 120 pitches', () => {
    expect(calcBlPitchBooster(80, 4, CFG).credits).toBe(0);
    expect(calcBlPitchBooster(81, 4, CFG).credits).toBe(3);
    expect(calcBlPitchBooster(100, 4, CFG).credits).toBe(3);
    expect(calcBlPitchBooster(101, 4, CFG).credits).toBe(5);
    expect(calcBlPitchBooster(121, 4, CFG).credits).toBe(8);
    expect(calcBlPitchBooster(200, 4, CFG).credits).toBe(8);
  });

  it('team size follows days in the team: 1 designer for half the cycle counts as 0.5', () => {
    const r = calcBlPitchBooster(52, 2.5, CFG);
    expect(r.slabs.map((s) => s.abovePitches)).toEqual([50, 62.5, 75]);
    expect(r.credits).toBe(3);
  });

  it('only counts once Admin approves; shows the calculated figure meanwhile', () => {
    const team = [{ id: 'd1', name: 'D1', share: 1, pitches: 21 }];
    const pitches = Array.from({ length: 21 }, (_, i) => pitch({ leadId: `P-${i}`, id: `p${i}` }));
    const waiting = run({ team, pitches });
    expect(waiting.booster.pitch).toMatchObject({ teamPitches: 21, teamSize: 1, calculatedCredits: 3, credits: 0 });
    expect(waiting.booster.pitch.approval.status).toBe('AWAITING');
    const approved = run({ team, pitches, pitchApproval: { approved: true, byId: 'bh', at: '' } });
    expect(approved.booster.pitch.credits).toBe(3);
  });

  it('BL-held pitches are not part of the designer team count', () => {
    const r = run({ team: [{ id: 'd1', name: 'D1', share: 1, pitches: 0 }], pitches: [pitch({ designerId: null })] });
    expect(r.booster.pitch.teamPitches).toBe(0);
  });
});

describe('Rule 3 — same-day pitch and booking', () => {
  it('+1 per lead pitched the day it arrived, +2 per lead booked the day it arrived, each once per lead', () => {
    const sameDay = at('2026-10-20T03:00:00Z');
    const r = run({
      pitches: [
        pitch({ id: 'a', leadId: 'A', mqlAt: sameDay }),
        pitch({ id: 'a', leadId: 'A', mqlAt: sameDay }), // duplicate event for the same lead
        pitch({ id: 'b', leadId: 'B', mqlAt: sameDay }),
        pitch({ id: 'c', leadId: 'C' }), // pitched another day
      ],
      bookings: [booking({ id: 'x', leadId: 'X', mqlAt: sameDay }), booking({ id: 'y', leadId: 'Y' })],
    });
    expect(r.booster.sameDayPitch.credits).toBe(2);
    expect(r.booster.sameDayBooking.credits).toBe(2);
  });

  it('same day is judged on the India calendar date', () => {
    // 11:00 pm IST on 19 Oct vs 1:00 am IST on 20 Oct: different days.
    const r = run({ pitches: [pitch({ mqlAt: at('2026-10-19T17:30:00Z'), completedAt: at('2026-10-19T19:30:00Z') })] });
    expect(r.booster.sameDayPitch.credits).toBe(0);
  });
});

describe('Rule 4 — booking value is the CRM total project value', () => {
  it('sums the recorded value as-is (furniture is not deducted)', () => {
    const r = run({ bookings: [booking({ value: 10 * LAKH })], targetValue: 10 * LAKH });
    expect(r.core.eligibleValue).toBe(10 * LAKH);
    expect(r.core.standard).toBe(100);
  });
});

describe('Rule 6 — cancellations', () => {
  it('booked and cancelled in the same cycle earns nothing', () => {
    const r = run({ bookings: [booking({ cancelledAt: at('2026-10-25T06:00:00Z') })] });
    expect(r.core.bookingValue).toBe(0);
    expect(r.core.cancelledInCycle).toHaveLength(1);
  });

  it('an earlier cycle\'s booking cancelled this cycle is reversed this cycle, once', () => {
    const old = booking({ bookedAt: at('2026-09-20T06:00:00Z'), mqlAt: at('2026-09-20T03:00:00Z'), cancelledAt: at('2026-10-25T06:00:00Z'), value: 20 * LAKH });
    const now = run({ bookings: [old, booking({ id: 'n', leadId: 'N', value: 50 * LAKH })], targetValue: 1 * CR });
    expect(now.core).toMatchObject({ bookingValue: 50 * LAKH, reversedValue: 20 * LAKH, eligibleValue: 30 * LAKH, standard: 30 });
    expect(now.booster.sameDayBooking.credits).toBe(-2); // its same-day booking credit is reversed too
    // The earlier cycle keeps its original award.
    const sep = { cycleStart: new Date('2026-09-15T18:30:00Z'), cycleEnd: new Date('2026-10-15T18:29:59.999Z') };
    expect(run({ bookings: [old], cycle: sep, targetValue: 1 * CR }).core.bookingValue).toBe(20 * LAKH);
    // And the next cycle does not reverse it again.
    const nov = { cycleStart: new Date('2026-11-15T18:30:00Z'), cycleEnd: new Date('2026-12-15T18:29:59.999Z') };
    expect(run({ bookings: [old], cycle: nov, now: at('2026-12-20T00:00:00Z') }).core.reversedValue).toBe(0);
  });

  it('cancellation date missing: running cycle excludes it, closed cycle keeps it and flags it (no guessing)', () => {
    const b = booking({ undatedCancellation: true });
    const running = run({ bookings: [b], now: at('2026-10-30T00:00:00Z') });
    expect(running.core.bookingValue).toBe(0);
    const closed = run({ bookings: [b] });
    expect(closed.core.bookingValue).toBe(10 * LAKH);
    expect(closed.core.undatedCancellations).toHaveLength(1);
  });

  it('reads booking and cancellation dates from the lead history', () => {
    const d = bookingDates([
      { action: 'STAGE_CHANGED', createdAt: at('2026-10-20T06:00:00Z'), meta: { to: 'DESIGN_IN_PROGRESS' } },
      { action: 'STATUS_CHANGED', createdAt: at('2026-10-25T06:00:00Z'), meta: { from: 'ACTIVE', to: 'INACTIVE' } },
    ], 'INACTIVE', 'DESIGN_IN_PROGRESS');
    expect(d).toEqual({ bookedAt: at('2026-10-20T06:00:00Z'), cancelledAt: at('2026-10-25T06:00:00Z'), undatedCancellation: false });
    expect(bookingDates([
      { action: 'STAGE_CHANGED', createdAt: at('2026-10-20T06:00:00Z'), meta: { to: 'DESIGN_IN_PROGRESS' } },
    ], 'INACTIVE', 'DESIGN_IN_PROGRESS').undatedCancellation).toBe(true);
  });
});

describe('Rule 7 — team history', () => {
  const designer = { id: 'd1', blId: 'blB', isActive: true };
  const moved: TeamChange[] = [{ designerId: 'd1', fromBlId: 'blA', toBlId: 'blB', at: at('2026-10-31T06:00:00Z') }];

  it('work before a team move stays with the old BL; after, it goes to the new BL', () => {
    const iv = teamIntervals(designer, moved);
    expect(blAt(iv, at('2026-10-20T00:00:00Z'))).toBe('blA');
    expect(blAt(iv, at('2026-11-05T00:00:00Z'))).toBe('blB');
  });

  it('with no recorded move, the designer belongs to their current BL', () => {
    expect(blAt(teamIntervals(designer, []), at('2020-01-01T00:00:00Z'))).toBe('blB');
  });

  it('a mid-cycle move splits team size between the two BLs by days', () => {
    const iv = teamIntervals(designer, moved);
    // Move at ~11:30 am IST on 31 Oct: 15 of 31 days with A, 16 with B.
    expect(membershipShare(designer, iv, 'blA', cycle)).toBeCloseTo(15 / 31);
    expect(membershipShare(designer, iv, 'blB', cycle)).toBeCloseTo(16 / 31);
  });

  it('a switched-off designer stops counting from the switch-off date', () => {
    const off = { ...designer, blId: 'blA', isActive: false };
    const iv = teamIntervals(off, [{ designerId: 'd1', fromBlId: 'blA', toBlId: null, at: at('2026-10-31T06:00:00Z') }]);
    expect(membershipShare(off, iv, 'blA', cycle)).toBeCloseTo(15 / 31);
    expect(blAt(iv, at('2026-11-05T00:00:00Z'))).toBeNull();
  });

  it('records a designer\'s team change (and switch-off) in the activity log, nothing else', async () => {
    logged.length = 0;
    const d = { id: 'd1', role: 'DESIGNER', blId: 'blA', isActive: true };
    await recordTeamChange('bh', d, { ...d, blId: 'blB' });
    await recordTeamChange('bh', d, { ...d, isActive: false });
    await recordTeamChange('bh', d, { ...d, blId: 'blA' }); // no change
    await recordTeamChange('bh', { ...d, role: 'CRE' }, { ...d, role: 'CRE', blId: 'blB' }); // not a designer
    expect(logged.map((l) => l[3])).toEqual([
      { designerId: 'd1', fromBlId: 'blA', toBlId: 'blB' },
      { designerId: 'd1', fromBlId: 'blA', toBlId: null },
    ]);
  });

  it('BL-held bookings (no designer) count for the BL', () => {
    const r = run({ bookings: [booking({ designerId: null, designerName: null })], targetValue: 10 * LAKH });
    expect(r.core.bookingValue).toBe(10 * LAKH);
    expect(r.core.bookings[0].heldBy).toBe('BL-held (no designer)');
  });
});

describe('Admin settings', () => {
  it('missing values use Annie\'s defaults; bad values are rejected', () => {
    expect(parseBlCreditConfig({})).toEqual(CFG);
    expect(parseBlCreditConfig({ sameDayPitchCredits: 4 }).sameDayPitchCredits).toBe(4);
    expect(() => parseBlCreditConfig({ overachievementCreditsPerLakh: -1 })).toThrow();
    expect(() => parseBlCreditConfig({ sameDayBookingCredits: '' })).toThrow();
  });
});
