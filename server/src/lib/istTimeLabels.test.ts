import { describe, it, expect } from 'vitest';
import { time12, istDateLabel, istDateTimeLabel } from './istTime.js';
import { NOTIFICATION_TYPES } from './notifications.js';

// Annie (29 Oct 2026): day, month, year — and "2:00 PM", not "14:00".
describe('Dates and times in client messages', () => {
  it('turns 24-hour times into AM/PM', () => {
    expect(time12('14:00')).toBe('2:00 PM');
    expect(time12('00:30')).toBe('12:30 AM');
    expect(time12('12:05')).toBe('12:05 PM');
    expect(time12('9:15')).toBe('9:15 AM');
    expect(time12('the scheduled time')).toBe('the scheduled time');
  });
  it('writes the day first, in India time', () => {
    expect(istDateLabel('2026-10-30')).toBe('30 Oct 2026');
    expect(istDateLabel(new Date('2026-10-30T20:00:00Z'))).toBe('31 Oct 2026');
    expect(istDateTimeLabel('2026-10-30T08:30:00Z')).toBe('30 Oct 2026, 2:00 PM');
    expect(istDateTimeLabel('2026-10-30T08:30:00Z', { weekday: true })).toBe('Fri, 30 Oct 2026, 2:00 PM');
    expect(istDateLabel(undefined)).toBe('');
  });
});

describe('Inactive-lead feedback alert', () => {
  it('can be switched off in Admin → In-app Alerts like the others', () => {
    expect(NOTIFICATION_TYPES.some((t) => t.type === 'INACTIVE_FEEDBACK_RECEIVED')).toBe(true);
  });
});
