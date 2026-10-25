import { describe, expect, it } from 'vitest';
import { getCycleForDate, isCycleInPast } from './targetCycle.js';

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