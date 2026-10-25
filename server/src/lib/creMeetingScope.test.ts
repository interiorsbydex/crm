import { describe, expect, it } from 'vitest';
import { meetingIdsScheduledByCre } from './creMeetingScope.js';

describe('CRE-scheduled meeting IDs', () => {
  it('includes original bookings and CRE-created reschedule replacements', () => {
    const ids = meetingIdsScheduledByCre([
      { action: 'MEETING_SCHEDULED', meta: { meetingId: 'initial', scheduledByRole: 'CRE' }, user: { role: 'BL' } },
      { action: 'MEETING_RESCHEDULED', meta: { originalMeetingId: 'initial', replacementMeetingId: 'replacement', scheduledByRole: 'CRE' }, user: { role: 'BL' } },
    ]);
    expect([...ids].sort()).toEqual(['initial', 'replacement']);
  });

  it('excludes BL bookings even if the booker is now a CRE', () => {
    const ids = meetingIdsScheduledByCre([
      { action: 'MEETING_SCHEDULED', meta: { meetingId: 'bl-booking', scheduledByRole: 'BL' }, user: { role: 'CRE' } },
      { action: 'MEETING_RESCHEDULED', meta: { replacementMeetingId: 'bl-replacement', scheduledByRole: 'BL' }, user: { role: 'CRE' } },
    ]);
    expect([...ids]).toEqual([]);
  });

  it('uses the current role for legacy records and ignores unrelated or invalid IDs', () => {
    const ids = meetingIdsScheduledByCre([
      { action: 'MEETING_SCHEDULED', meta: { meetingId: 'legacy' }, user: { role: 'CRE' } },
      { action: 'MEETING_COMPLETED', meta: { meetingId: 'completed' }, user: { role: 'CRE' } },
      { action: 'MEETING_RESCHEDULED', meta: { originalMeetingId: 'original' }, user: { role: 'CRE' } },
      { action: 'MEETING_SCHEDULED', meta: null, user: { role: 'CRE' } },
      { action: 'MEETING_SCHEDULED', meta: { meetingId: 42 }, user: { role: 'CRE' } },
    ]);
    expect([...ids]).toEqual(['legacy']);
  });
});