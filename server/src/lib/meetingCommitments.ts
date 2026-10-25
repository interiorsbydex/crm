type Lead = { id: string; leadId: string; name: string };
export type CommitmentMeeting = {
  id: string; leadId: string; type: string; status: string; scheduledAt: Date;
  rescheduledReason: string | null; lead: Lead;
};
export type MeetingCompletionEvidence = { leadId: string | null; createdAt: Date; meta: unknown };

/** Read-only reporting: archived rows are real commitments, not extra completions.
 * Never infer completion from a scheduled date, updatedAt, or copied history. */
export function meetingCommitments(
  records: CommitmentMeeting[],
  evidence: MeetingCompletionEvidence[],
  period: { from: Date; to: Date },
) {
  const meetings = [...new Map(records.map((m) => [m.id, m])).values()];
  const completionDates = new Map<string, Date>();
  for (const event of evidence) {
    if (!event.leadId || !Number.isFinite(event.createdAt.getTime()) ||
        !event.meta || typeof event.meta !== 'object' || Array.isArray(event.meta)) continue;
    const id = (event.meta as { meetingId?: unknown }).meetingId;
    if (typeof id !== 'string' || !id) continue;
    const key = `${event.leadId}:${id}`;
    const previous = completionDates.get(key);
    if (!previous || event.createdAt < previous) completionDates.set(key, event.createdAt);
  }
  const inPeriod = (date: Date) => date >= period.from && date <= period.to;
  const completionDate = (m: CommitmentMeeting) => completionDates.get(`${m.leadId}:${m.id}`) ?? null;
  const drillRow = (m: CommitmentMeeting) => ({
    ...m.lead, meetingId: m.id, status: m.status, scheduledAt: m.scheduledAt,
    completedAt: m.status === 'COMPLETED' ? completionDate(m) : null,
    rescheduledReason: m.rescheduledReason,
  });
  return (['DQL', 'PP'] as const).map((type) => {
    const relevant = meetings.filter((m) => m.type === type);
    // Each stored original/replacement is one commitment. Do not expand the
    // copied rescheduleHistory arrays: that would count the original repeatedly.
    const planned = relevant.filter((m) => inPeriod(m.scheduledAt));
    const completed = relevant.filter((m) => m.status === 'COMPLETED');
    const undated = completed.filter((m) => !completionDate(m));
    const actual = completed.filter((m) => {
      const at = completionDate(m);
      return at !== null && inPeriod(at);
    });
    // An undated completion could belong to any requested cycle. Show known
    // records in the drill but do not present an incomplete total as definitive.
    const actualTotal = undated.length ? null : actual.length;
    return {
      key: type, label: `${type} Meeting`, planned: planned.length, actual: actualTotal,
      knownActual: actual.length, missingCompletionDates: undated.length,
      achievementPct: actualTotal !== null && planned.length
        ? Math.round(actualTotal / planned.length * 1000) / 10 : null,
      verificationNote: undated.length
        ? `${undated.length} completed ${type} meeting(s) in this scope have no recorded completion date. Actual and achievement are unavailable; ${actual.length} dated completion(s) are verified in this cycle.`
        : null,
      drilldown: { planned: planned.map(drillRow), actual: actual.map(drillRow), undated: undated.map(drillRow) },
    };
  });
}
