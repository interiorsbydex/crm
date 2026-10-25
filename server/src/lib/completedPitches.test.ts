import { describe, expect, it } from 'vitest';
import { completedPitches } from './completedPitches.js';

const period = { from: new Date('2026-10-15T18:30:00Z'), to: new Date('2026-11-15T18:29:59.999Z') };
const lead = (id = 'a', stage = 'PROPOSAL_PRESENTED', history: unknown[] = []) => ({
  id, leadId: id, name: id, stage, estimatedValue: 100000, leadOriginDate: period.from,
  activityLogs: history.map((meta) => ({ meta })),
});
const meeting = (id: string, l = lead()) => ({ id, leadId: l.id, lead: l });
const completion = (id: string, date = '2026-10-20T12:00:00Z', leadId = 'a') =>
  ({ leadId, meta: { meetingId: id }, createdAt: new Date(date) });

describe('completed pitch accounting', () => {
  it('counts one lead per cycle even when several PP meetings completed', () => {
    const r = completedPitches([meeting('one'), meeting('two')], [completion('one'), completion('two')], period);
    expect(r.pitches.map((p) => p.id)).toEqual(['a']);
  });
  it('uses the actual completion event and does not replace it with a later edit', () => {
    const r = completedPitches([meeting('one')], [
      completion('one', '2026-10-14T12:00:00Z'), completion('one'),
    ], period);
    expect(r.pitches).toEqual([]);
  });
  it('allows the same lead to qualify in separate cycles with separate completed meetings', () => {
    expect(completedPitches([meeting('old'), meeting('new')], [
      completion('old', '2026-09-20T12:00:00Z'), completion('new'),
    ], period).pitches).toHaveLength(1);
  });
  it('keeps undated completions in all-time counts but flags and excludes them from dated counts', () => {
    expect(completedPitches([meeting('old')], []).pitches).toHaveLength(1);
    expect(completedPitches([meeting('old')], [], period)).toEqual({ pitches: [], missingCompletionDates: 1 });
  });
  it('requires the lead to have reached PP, retaining evidence after a backward move', () => {
    expect(completedPitches([meeting('one', lead('a', 'MQL'))], [completion('one')]).pitches).toEqual([]);
    expect(completedPitches([meeting('one', lead('a', 'MQL', [{ to: 'PROPOSAL_PRESENTED' }]))],
      [completion('one')], period).pitches).toHaveLength(1);
  });
  it('does not accept an event belonging to a different lead', () => {
    expect(completedPitches([meeting('one')], [completion('one', undefined, 'other')], period).pitches).toEqual([]);
  });
  it('uses inclusive IST cycle boundaries', () => {
    const events = [completion('one', period.from.toISOString()), completion('two', period.to.toISOString(), 'b')];
    expect(completedPitches([meeting('one'), meeting('two', lead('b'))], events, period).pitches).toHaveLength(2);
  });
});
