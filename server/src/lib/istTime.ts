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

// ── Wording for people (emails, SMS, notifications) ─────────────────────────
// Day first, then month, then year; times on the 12-hour clock ("2:00 PM"),
// as Annie asked (29 Oct 2026) — clients find "14:00" hard to read.

/** "14:00" → "2:00 PM". Anything that isn't an HH:MM time is returned unchanged. */
export function time12(hhmm?: string | null): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
  if (!m || Number(m[1]) > 23) return hhmm ?? '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "30 Oct 2026" for a timestamp (in IST) or a "YYYY-MM-DD" day. */
export function istDateLabel(value: Date | string | null | undefined): string {
  if (value == null || value === '') return '';
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00+05:30`) : new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-GB', { timeZone: IST_TZ, day: 'numeric', month: 'short', year: 'numeric' });
}

/** "30 Oct 2026, 2:00 PM" in IST. Pass { weekday: true } for "Fri, 30 Oct 2026, 2:00 PM". */
export function istDateTimeLabel(value: Date | string, opts: { weekday?: boolean } = {}): string {
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const hhmm = d.toLocaleTimeString('en-GB', { timeZone: IST_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const day = opts.weekday ? `${d.toLocaleDateString('en-GB', { timeZone: IST_TZ, weekday: 'short' })}, ` : '';
  return `${day}${istDateLabel(d)}, ${time12(hhmm)}`;
}
