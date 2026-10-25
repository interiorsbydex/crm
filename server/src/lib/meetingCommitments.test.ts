import { describe, expect, it } from 'vitest';
import { meetingCommitments, type CommitmentMeeting, type MeetingCompletionEvidence } from './meetingCommitments.js';

const current = { from: new Date('2026-10-15T18:30:00Z'), to: new Date('2026-11-15T18:29:59.999Z') };
const previous = { from: new Date('2026-09-15T18:30:00Z'), to: new Date('2026-10-15T18:29:59.999Z') };
const meeting = (id: string, status: string, date: string, type = 'DQL'): CommitmentMeeting => ({
  id, leadId: 'lead-a', type, status, scheduledAt: new Date(date), rescheduledReason: status === 'RESCHEDULED' ? 'Test replan' : null,
  lead: { id: 'lead-a', leadId: 'TEST-A', name: 'Synthetic meeting' },
});
const completion = (id: string, at: string, leadId = 'lead-a'): MeetingCompletionEvidence =>
  ({ leadId, createdAt: new Date(at), meta: { meetingId: id } });
const row = (meetings: CommitmentMeeting[], logs: MeetingCompletionEvidence[], period = current) =>
  meetingCommitments(meetings, logs, period)[0];

describe('meeting commitments by actual reporting cycle', () => {
  it('retains original and replacement commitments across cycles, with one completion', () => {
    const records = [
      meeting('original', 'RESCHEDULED', '2026-10-14T10:00:00Z'),
      meeting('replacement', 'COMPLETED', '2026-10-17T10:00:00Z'),
    ];
    const logs = [completion('replacement', '2026-10-18T10:00:00Z')];
    expect(row(records, logs, previous)).toMatchObject({ planned: 1, actual: 0, achievementPct: 0 });
    expect(row(records, logs)).toMatchObject({ planned: 1, actual: 1, achievementPct: 100 });
    expect(row(records, logs, previous).drilldown.planned[0].status).toBe('RESCHEDULED');
  });
  it('counts every same-cycle commitment but not archived rows as completed', () => {
    const records = [
      meeting('first', 'RESCHEDULED', '2026-10-17T10:00:00Z'),
      meeting('second', 'RESCHEDULED', '2026-10-18T10:00:00Z'),
      meeting('third', 'COMPLETED', '2026-10-19T10:00:00Z'),
    ];
    const r = row(records, [completion('third', '2026-10-19T11:00:00Z')]);
    expect(r).toMatchObject({ planned: 3, actual: 1, achievementPct: 33.3 });
    expect(r.drilldown.planned.map((m) => m.meetingId)).toEqual(['first', 'second', 'third']);
  });
  it('places completion by actual completion event even when scheduled in an earlier cycle', () => {
    const records = [meeting('late', 'COMPLETED', '2026-10-14T10:00:00Z')];
    const logs = [completion('late', '2026-10-18T10:00:00Z')];
    expect(row(records, logs, previous)).toMatchObject({ planned: 1, actual: 0 });
    expect(row(records, logs)).toMatchObject({ planned: 0, actual: 1, achievementPct: null });
    expect(row(records, logs).drilldown.actual[0].completedAt).toEqual(new Date('2026-10-18T10:00:00Z'));
  });
  it('deduplicates records/events and uses the first evidenced completion', () => {
    const m = meeting('one', 'COMPLETED', '2026-10-14T10:00:00Z');
    const logs = [
      completion('one', '2026-10-18T10:00:00Z'),
      completion('one', '2026-10-14T11:00:00Z'),
      completion('one', '2026-10-14T11:00:00Z'),
    ];
    expect(row([m, m], logs, previous)).toMatchObject({ planned: 1, actual: 1 });
    expect(row([m], logs)).toMatchObject({ actual: 0 });
  });
  it('never substitutes scheduled date for missing completion evidence', () => {
    const r = row([meeting('unknown', 'COMPLETED', '2026-10-18T10:00:00Z')], []);
    expect(r).toMatchObject({ planned: 1, actual: null, knownActual: 0, missingCompletionDates: 1, achievementPct: null });
    expect(r.verificationNote).toContain('unavailable');
    expect(r.drilldown.undated[0].completedAt).toBeNull();
  });
  it('keeps dated evidence inspectable when another completion is undated', () => {
    const r = row([
      meeting('known', 'COMPLETED', '2026-10-18T10:00:00Z'),
      meeting('unknown', 'COMPLETED', '2026-10-19T10:00:00Z'),
    ], [completion('known', '2026-10-18T11:00:00Z')]);
    expect(r).toMatchObject({ actual: null, knownActual: 1, missingCompletionDates: 1 });
    expect(r.drilldown.actual).toHaveLength(1);
  });
  it('does not count completion events for scheduled/no-show/archived records', () => {
    for (const status of ['SCHEDULED', 'NO_SHOW', 'RESCHEDULED']) {
      expect(row([meeting('one', status, '2026-10-18T10:00:00Z')],
        [completion('one', '2026-10-18T11:00:00Z')])).toMatchObject({ planned: 1, actual: 0 });
    }
  });
  it('does not join completion evidence from another lead or malformed metadata', () => {
    const logs = [
      completion('one', '2026-10-18T11:00:00Z', 'other-lead'),
      { leadId: 'lead-a', createdAt: new Date('2026-10-18'), meta: { meetingId: 123 } },
      { leadId: null, createdAt: new Date('2026-10-18'), meta: { meetingId: 'one' } },
      { leadId: 'lead-a', createdAt: new Date('invalid'), meta: { meetingId: 'one' } },
    ];
    expect(row([meeting('one', 'COMPLETED', '2026-10-18T10:00:00Z')], logs).actual).toBeNull();
  });
  it('uses inclusive IST cycle boundaries for scheduled dates and completion evidence', () => {
    const records = [
      meeting('start', 'COMPLETED', current.from.toISOString()),
      meeting('end', 'COMPLETED', current.to.toISOString()),
      meeting('before', 'SCHEDULED', new Date(+current.from - 1).toISOString()),
      meeting('after', 'SCHEDULED', new Date(+current.to + 1).toISOString()),
    ];
    expect(row(records, [
      completion('start', current.from.toISOString()), completion('end', current.to.toISOString()),
    ])).toMatchObject({ planned: 2, actual: 2, achievementPct: 100 });
  });
  it('counts meetings, not unique leads, and keeps PP separate from DQL', () => {
    const records = ['a', 'b'].map((id) => meeting(id, 'COMPLETED', '2026-10-18T10:00:00Z', 'PP'));
    const rows = meetingCommitments(records, records.map((m) => completion(m.id, '2026-10-18T11:00:00Z')), current);
    expect(rows[0]).toMatchObject({ key: 'DQL', planned: 0, actual: 0 });
    expect(rows[1]).toMatchObject({ key: 'PP', planned: 2, actual: 2 });
  });
  it('does not cap achievement when prior commitments complete in a later cycle', () => {
    const records = [
      meeting('prior', 'COMPLETED', '2026-10-14T10:00:00Z'),
      meeting('current', 'COMPLETED', '2026-10-18T10:00:00Z'),
    ];
    expect(row(records, records.map((m) => completion(m.id, '2026-10-18T11:00:00Z'))))
      .toMatchObject({ planned: 1, actual: 2, achievementPct: 200 });
  });
});
