import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CYCLE_SCHEDULE, applyCycleStartDay, getCycleForDate, isCycleInPast, startDayOn, upcomingCycles,
} from './targetCycle.js';

describe('getCycleForDate', () => {
  it('keeps the 15th through its final IST millisecond in the preceding cycle', () => {
    const cycle = getCycleForDate(new Date('2026-08-15T18:29:59.999Z')); // 15 Aug 23:59:59.999 IST

    expect(cycle.cycleStart.toISOString()).toBe('2026-07-15T18:30:00.000Z');
    expect(cycle.cycleEnd.toISOString()).toBe('2026-08-15T18:29:59.999Z');
    expect(cycle.label).toBe('16 Jul – 15 Aug 2026');
  });

  it('starts the new cycle exactly at IST midnight on the 16th', () => {
    const cycle = getCycleForDate(new Date('2026-08-15T18:30:00.000Z')); // 16 Aug 00:00 IST

    expect(cycle.cycleStart.toISOString()).toBe('2026-08-15T18:30:00.000Z');
    expect(cycle.cycleEnd.toISOString()).toBe('2026-09-15T18:29:59.999Z');
    expect(cycle.label).toBe('16 Aug – 15 Sep 2026');
  });

  it('handles the December-to-January cycle boundary in IST', () => {
    const cycle = getCycleForDate(new Date('2026-12-16T00:00:00.000Z'));

    expect(cycle.cycleStart.toISOString()).toBe('2026-12-15T18:30:00.000Z');
    expect(cycle.cycleEnd.toISOString()).toBe('2027-01-15T18:29:59.999Z');
    expect(cycle.label).toBe('16 Dec – 15 Jan 2027');
  });

  it('locks only cycles that ended before the current cycle', () => {
    const now = new Date('2026-08-20T12:00:00.000Z');
    const previousCycle = getCycleForDate(new Date('2026-08-15T18:29:59.999Z'));
    const currentCycle = getCycleForDate(now);

    expect(isCycleInPast(previousCycle.cycleStart, now)).toBe(true);
    expect(isCycleInPast(currentCycle.cycleStart, now)).toBe(false);
  });
});
describe('changing the cycle start day (Admin → CRM Settings)', () => {
  const now = new Date('2026-10-25T06:00:00.000Z'); // 25 Oct IST, inside 16 Oct – 15 Nov

  it('leaves the current cycle alone and switches when it ends', () => {
    const schedule = applyCycleStartDay(DEFAULT_CYCLE_SCHEDULE, 1, now);
    expect(schedule).toEqual([{ from: '2000-01-01', startDay: 16 }, { from: '2026-11-16', startDay: 1 }]);
    expect(getCycleForDate(now, schedule).label).toBe('16 Oct – 15 Nov 2026');
    // One shorter bridging cycle, then calendar months.
    expect(upcomingCycles(schedule, 3, now).map((c) => c.label)).toEqual([
      '16 Oct – 15 Nov 2026', '16 Nov – 30 Nov 2026', '1 Dec – 31 Dec 2026',
    ]);
  });

  it('never moves a cycle that has already started, so saved targets keep matching', () => {
    const before = getCycleForDate(now, DEFAULT_CYCLE_SCHEDULE);
    for (const day of [1, 5, 10, 15, 20, 28]) {
      const after = getCycleForDate(now, applyCycleStartDay(DEFAULT_CYCLE_SCHEDULE, day, now));
      expect(after.cycleStart.toISOString(), `start day ${day}`).toBe(before.cycleStart.toISOString());
      expect(after.cycleEnd.toISOString(), `start day ${day}`).toBe(before.cycleEnd.toISOString());
    }
  });

  it('cycles under any schedule are back-to-back with no gaps or overlaps', () => {
    let schedule = applyCycleStartDay(DEFAULT_CYCLE_SCHEDULE, 5, now);
    schedule = applyCycleStartDay(schedule, 25, new Date('2027-02-10T06:00:00.000Z'));
    let d = new Date('2026-09-01T06:00:00.000Z');
    let prevEnd: number | null = null;
    for (let i = 0; i < 12; i++) {
      const c = getCycleForDate(d, schedule);
      if (prevEnd !== null) expect(c.cycleStart.getTime(), c.label).toBe(prevEnd + 1);
      expect(c.cycleEnd.getTime()).toBeGreaterThan(c.cycleStart.getTime());
      prevEnd = c.cycleEnd.getTime();
      d = new Date(c.cycleEnd.getTime() + 1);
    }
  });

  it('choosing again before it takes effect replaces the pending change; choosing the current day cancels it', () => {
    const pending = applyCycleStartDay(DEFAULT_CYCLE_SCHEDULE, 1, now);
    expect(applyCycleStartDay(pending, 10, now)).toEqual([{ from: '2000-01-01', startDay: 16 }, { from: '2026-11-16', startDay: 10 }]);
    expect(applyCycleStartDay(pending, 16, now)).toEqual(DEFAULT_CYCLE_SCHEDULE);
    expect(startDayOn(now, pending)).toBe(16);
    expect(startDayOn(new Date('2026-12-05T06:00:00.000Z'), pending)).toBe(1);
  });
});
