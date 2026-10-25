// Task #45 — Booking/PO targets run on a 16th-to-15th cycle, not the
// calendar month. All boundaries are computed against the IST wall-clock
// date (matching the IST_OFFSET_MS convention used elsewhere in this
// codebase, e.g. server/src/jobs/upcomingDueReminder.ts), then converted
// back to real UTC instants for storage/querying.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface TargetCycle {
  /// UTC instant corresponding to IST midnight on the 16th (inclusive start).
  cycleStart: Date;
  /// UTC instant corresponding to IST 23:59:59.999 on the 15th of the following month (inclusive end).
  cycleEnd: Date;
  /// Human label, e.g. "16 Aug – 15 Sep 2026".
  label: string;
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Convert a real Date into its IST wall-clock Y/M/D (month is 0-indexed). */
function toISTParts(date: Date): { year: number; month: number; day: number } {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return { year: ist.getUTCFullYear(), month: ist.getUTCMonth(), day: ist.getUTCDate() };
}

/** Build the UTC instant for IST midnight (00:00:00.000) on the given IST calendar date. */
function istMidnightUTC(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - IST_OFFSET_MS);
}

/** Build the UTC instant for IST end-of-day (23:59:59.999) on the given IST calendar date. */
function istEndOfDayUTC(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - IST_OFFSET_MS);
}

/**
 * Returns the 16th–15th cycle that contains `date` (defaults to now).
 * If the IST day-of-month is >= 16, the cycle is [16th of this month, 15th
 * of next month]; otherwise it's [16th of last month, 15th of this month].
 */
export function getCycleForDate(date: Date = new Date()): TargetCycle {
  const { year, month, day } = toISTParts(date);
  let startYear = year;
  let startMonth = month;
  if (day < 16) {
    startMonth -= 1;
    if (startMonth < 0) { startMonth = 11; startYear -= 1; }
  }
  const cycleStart = istMidnightUTC(startYear, startMonth, 16);
  let endYear = startYear;
  let endMonth = startMonth + 1;
  if (endMonth > 11) { endMonth = 0; endYear += 1; }
  const cycleEnd = istEndOfDayUTC(endYear, endMonth, 15);
  const label = `16 ${MONTH_LABELS[startMonth]} – 15 ${MONTH_LABELS[endMonth]} ${endYear}`;
  return { cycleStart, cycleEnd, label };
}

/** True if `cycleStart` identifies a cycle that has already fully elapsed relative to now — locked from edits. */
export function isCycleInPast(cycleStart: Date, now: Date = new Date()): boolean {
  const currentCycle = getCycleForDate(now);
  return cycleStart.getTime() < currentCycle.cycleStart.getTime();
}

/** Convenience: the current (editable) cycle's boundaries + label. */
export function getCurrentCycle(): TargetCycle {
  return getCycleForDate(new Date());
}
