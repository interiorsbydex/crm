type SchedulingActivity = { action: string; meta: unknown; user: { role: string } };

/**
 * Scheduling activity stores the booked meeting ID. A reschedule archives the
 * old row and creates a replacement, whose ID is recorded separately. Only
 * New activities snapshot the scheduler's role. For older records without a
 * snapshot, use the actor's current role as the best available evidence.
 */
export function meetingIdsScheduledByCre(activities: SchedulingActivity[]): Set<string> {
  const ids = new Set<string>();
  for (const { action, meta, user } of activities) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const details = meta as Record<string, unknown>;
    if ((details.scheduledByRole ?? user.role) !== 'CRE') continue;
    const id = action === 'MEETING_SCHEDULED' ? details.meetingId
      : action === 'MEETING_RESCHEDULED' ? details.replacementMeetingId
      : undefined;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return ids;
}