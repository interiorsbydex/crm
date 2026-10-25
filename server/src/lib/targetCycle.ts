// Task #45 — Booking/PO targets and designer credits run on a monthly cycle
// that starts on a fixed day of the month (16th–15th by default), not the
// calendar month. The start day is set in Admin → CRM Settings; a change only
// takes effect when the current cycle ends (see applyCycleStartDay), so cycles
// that have started never move and targets saved against them keep matching.
//
// All boundaries are computed against the IST wall-clock date (matching the
// IST_OFFSET_MS convention used elsewhere in this codebase, e.g.
// server/src/jobs/upcomingDueReminder.ts), then converted back to real UTC
// instants for storage/querying.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TargetCycle {
  /// UTC instant corresponding to IST midnight on the cycle's first day (inclusive start).
  cycleStart: Date;
  /// UTC instant corresponding to IST 23:59:59.999 on the cycle's last day (inclusive end).
  cycleEnd: Date;
  /// Human label, e.g. "16 Aug – 15 Sep 2026".
  label: string;
}

/**
 * From the IST date `from` (YYYY-MM-DD) onward, cycles start on day
 * `startDay` (1–28) of each month. Entries are in date order; the first one
 * covers all history.
 */
export interface CycleScheduleEntry { from: string; startDay: number }

export const DEFAULT_CYCLE_SCHEDULE: CycleScheduleEntry[] = [{ from: '2000-01-01', startDay: 16 }];

// Kept in memory so getCycleForDate stays synchronous; refreshed from CRM
// Settings whenever they are read (lib/crmSettings.ts) and on a timer.
let schedule: CycleScheduleEntry[] = DEFAULT_CYCLE_SCHEDULE;
export function setCycleSchedule(next: CycleScheduleEntry[] | undefined): void {
  schedule = next && next.length ? next : DEFAULT_CYCLE_SCHEDULE;
}
export function getCycleSchedule(): CycleScheduleEntry[] {
  return schedule;
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** IST calendar dates are handled as UTC-midnight Dates (pure date arithmetic). */
function istDate(date: Date): Date {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}
function parseDay(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function formatDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);

/** The latest date ≤ `d` falling on day-of-month `startDay`. */
function lastStartOnOrBefore(d: Date, startDay: number): Date {
  const thisMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), startDay));
  return thisMonth <= d ? thisMonth : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, startDay));
}
/** The earliest date > `d` falling on day-of-month `startDay`. */
function nextStartAfter(d: Date, startDay: number): Date {
  const thisMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), startDay));
  return thisMonth > d ? thisMonth : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, startDay));
}

/** First and last IST day of the cycle containing IST day `day` under `entries`. */
function cycleDays(day: Date, entries: CycleScheduleEntry[]): { first: Date; last: Date } {
  let idx = 0;
  for (let i = 0; i < entries.length; i++) if (parseDay(entries[i].from) <= day) idx = i;
  const entry = entries[idx];
  const entryFrom = parseDay(entry.from);
  const nextEntryFrom = entries[idx + 1] ? parseDay(entries[idx + 1].from) : null;

  // A rule's first cycle may begin mid-month (on the day the change took
  // effect) and run until its first regular start day.
  const regularStart = lastStartOnOrBefore(day, entry.startDay);
  const first = regularStart < entryFrom ? entryFrom : regularStart;
  let last = addDays(nextStartAfter(first, entry.startDay), -1);
  if (nextEntryFrom && last >= nextEntryFrom) last = addDays(nextEntryFrom, -1);
  return { first, last };
}

function toCycle(first: Date, last: Date): TargetCycle {
  const cycleStart = new Date(first.getTime() - IST_OFFSET_MS);
  const cycleEnd = new Date(last.getTime() + DAY_MS - 1 - IST_OFFSET_MS);
  const label = `${first.getUTCDate()} ${MONTH_LABELS[first.getUTCMonth()]} – ${last.getUTCDate()} ${MONTH_LABELS[last.getUTCMonth()]} ${last.getUTCFullYear()}`;
  return { cycleStart, cycleEnd, label };
}

/** Returns the cycle that contains `date` (defaults to now). */
export function getCycleForDate(date: Date = new Date(), entries: CycleScheduleEntry[] = schedule): TargetCycle {
  const { first, last } = cycleDays(istDate(date), entries);
  return toCycle(first, last);
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

/** The start day in force on `date`. */
export function startDayOn(date: Date = new Date(), entries: CycleScheduleEntry[] = schedule): number {
  const day = istDate(date);
  let startDay = entries[0].startDay;
  for (const e of entries) if (parseDay(e.from) <= day) startDay = e.startDay;
  return startDay;
}

/**
 * The schedule after an admin chooses `startDay` on `now`: the current cycle
 * is left as it is and the new day applies from the day after it ends. A
 * change that hasn't taken effect yet is replaced; choosing the day already
 * in force cancels any pending change.
 */
export function applyCycleStartDay(entries: CycleScheduleEntry[], startDay: number, now: Date = new Date()): CycleScheduleEntry[] {
  const today = istDate(now);
  const inEffect = entries.filter((e) => parseDay(e.from) <= today);
  const kept = inEffect.length ? inEffect : [entries[0]];
  if (kept[kept.length - 1].startDay === startDay) return kept;
  const { last } = cycleDays(today, kept);
  return [...kept, { from: formatDay(addDays(last, 1)), startDay }];
}

/** The next `count` cycles from `date` — used to show the admin what a change means. */
export function upcomingCycles(entries: CycleScheduleEntry[], count = 3, date: Date = new Date()): TargetCycle[] {
  const out: TargetCycle[] = [];
  let d = istDate(date);
  for (let i = 0; i < count; i++) {
    const { first, last } = cycleDays(d, entries);
    out.push(toCycle(first, last));
    d = addDays(last, 1);
  }
  return out;
}
