import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  call: { findMany: vi.fn() }, meeting: { findMany: vi.fn() }, activityLog: { findMany: vi.fn() },
}));
vi.mock('./prisma.js', () => ({ prisma: db }));
import { contactHealth, contactHealthByLead, loadContactHealth } from './contactHealth.js';

const now = new Date('2026-10-23T12:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
const answered = (date: Date | null) => ({ leadId: 'a', outcome: 'ANSWERED', calledAt: date });
beforeEach(() => {
  vi.clearAllMocks();
  db.call.findMany.mockResolvedValue([]);
  db.meeting.findMany.mockResolvedValue([]);
  db.activityLog.findMany.mockResolvedValue([]);
});

describe('Annie answer 8 — verified contact health', () => {
  it.each([[0, 'RECENT'], [2, 'RECENT'], [3, 'WARNING'], [6, 'WARNING'], [7, 'HIGH_RISK'], [30, 'HIGH_RISK']])(
    'rates %i IST calendar days as %s', (days, status) => {
      expect(contactHealth([ago(Number(days))], false, now)).toMatchObject({ status, daysSinceContact: days });
    },
  );
  it('uses IST calendar midnight rather than elapsed 24-hour intervals', () => {
    const data = contactHealth([new Date('2026-10-22T18:29:00Z')], false, new Date('2026-10-22T18:31:00Z'));
    expect(data.daysSinceContact).toBe(1);
  });
  it('does not invent a baseline or healthy status when no completed contact exists', () => {
    expect(contactHealth([], false, now)).toMatchObject({ status: 'UNKNOWN', lastContactAt: null, daysSinceContact: null });
  });
  it('uses the latest verified answered call or completed meeting', () => {
    const data = contactHealthByLead(['a'], [answered(ago(10))], [{ id: 'm', leadId: 'a' }],
      [{ leadId: 'a', createdAt: ago(3), meta: { meetingId: 'm' } }], now);
    expect(data.get('a')).toMatchObject({ status: 'WARNING', lastContactAt: ago(3).toISOString(), daysSinceContact: 3 });
  });
  it('does not let a duplicate meeting audit reset the first completion date', () => {
    const data = contactHealthByLead(['a'], [], [{ id: 'm', leadId: 'a' }], [
      { leadId: 'a', createdAt: ago(0), meta: { meetingId: 'm' } },
      { leadId: 'a', createdAt: ago(7), meta: { meetingId: 'm' } },
    ], now);
    expect(data.get('a')).toMatchObject({ status: 'HIGH_RISK', daysSinceContact: 7 });
  });
  it('does not count scheduled/non-completed meetings or unrelated audit rows', () => {
    const data = contactHealthByLead(['a'], [answered(ago(7))], [], [
      { leadId: 'a', createdAt: ago(0), meta: { meetingId: 'scheduled' } },
    ], now);
    expect(data.get('a')?.status).toBe('HIGH_RISK');
  });
  it('does not reset or weaken inactivity for unanswered calls', () => {
    const data = contactHealthByLead(['a'], [
      answered(ago(7)), { leadId: 'a', outcome: 'RNR_1', calledAt: ago(0) },
    ], [], [], now);
    expect(data.get('a')).toMatchObject({ status: 'HIGH_RISK', daysSinceContact: 7 });
  });
  it.each(['CALLBACK', 'MEETING_SCHEDULED'])('does not guess whether a newer %s call completed contact', (outcome) => {
    const data = contactHealthByLead(['a'], [answered(ago(7)), { leadId: 'a', outcome, calledAt: ago(0) }], [], [], now);
    expect(data.get('a')).toMatchObject({ status: 'UNKNOWN', lastContactAt: ago(7).toISOString() });
  });
  it('does not let older ambiguous call outcomes hide a newer verified contact', () => {
    const data = contactHealthByLead(['a'], [answered(ago(0)), { leadId: 'a', outcome: 'CALLBACK', calledAt: ago(10) }], [], [], now);
    expect(data.get('a')?.status).toBe('RECENT');
  });
  it('does not substitute createdAt or scheduledAt for a missing completion date', () => {
    const data = contactHealthByLead(['a', 'b'], [answered(null)], [{ id: 'm', leadId: 'b' }], [], now);
    expect(data.get('a')?.status).toBe('UNKNOWN');
    expect(data.get('b')?.status).toBe('UNKNOWN');
  });
  it('does not match one lead to another lead’s meeting completion', () => {
    const data = contactHealthByLead(['a'], [], [{ id: 'm', leadId: 'a' }],
      [{ leadId: 'foreign', createdAt: ago(0), meta: { meetingId: 'm' } }], now);
    expect(data.get('a')?.lastContactAt).toBeNull();
  });
  it('does not classify future or invalid dates as healthy contact', () => {
    expect(contactHealth([new Date(now.getTime() + 1000)], false, now).status).toBe('UNKNOWN');
    expect(contactHealth([new Date('invalid')], false, now).status).toBe('UNKNOWN');
  });
  it('queries only the scoped lead IDs and evidence types, without record-time fallbacks', async () => {
    await loadContactHealth(['a', 'a']);
    expect(db.call.findMany).toHaveBeenCalledWith({
      where: { leadId: { in: ['a'] }, outcome: { in: ['ANSWERED', 'CALLBACK', 'MEETING_SCHEDULED'] } },
      select: { leadId: true, calledAt: true, outcome: true },
    });
    expect(db.meeting.findMany.mock.calls[0][0].where).toEqual({ leadId: { in: ['a'] }, status: 'COMPLETED' });
    expect(db.activityLog.findMany.mock.calls[0][0].where).toEqual({ leadId: { in: ['a'] }, action: 'MEETING_COMPLETED' });
  });
  it('does not scan contacts at all when there are no permitted clients', async () => {
    expect((await loadContactHealth([])).size).toBe(0);
    expect(db.call.findMany).not.toHaveBeenCalled();
  });
});
