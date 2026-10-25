/**
 * Shared IST (India Standard Time) day-boundary helper — task #112.
 *
 * The app is India-only per current scope; "midnight" and "today" must be
 * computed against Asia/Kolkata, not the server process's local timezone
 * (which is UTC in this environment). Using server-local setHours(0,0,0,0)
 * silently computes UTC midnight — 5:30am IST — instead of actual midnight
 * IST, which is what "flag task incomplete by midnight" is supposed to mean.
 */
export const IST_TZ = 'Asia/Kolkata';

/** Start (and end, exclusive) of "today" in IST, expressed as UTC Dates. */
export function istDayBounds(now = new Date()): { start: Date; end: Date } {
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: IST_TZ }));
  const offsetMs = istNow.getTime() - now.getTime();
  const istStart = new Date(istNow);
  istStart.setHours(0, 0, 0, 0);
  const start = new Date(istStart.getTime() - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}
