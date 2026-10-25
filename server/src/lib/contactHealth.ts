import { prisma } from './prisma.js';

export type ContactStatus = 'RECENT' | 'WARNING' | 'HIGH_RISK' | 'UNKNOWN';
export type ContactHealth = {
  status: ContactStatus;
  lastContactAt: string | null;
  daysSinceContact: number | null;
  reason: string | null;
};
type Call = { leadId: string; calledAt: Date | null; outcome: string };
type Meeting = { id: string; leadId: string };
type Completion = { leadId: string | null; createdAt: Date; meta: unknown };

const DAY = 86_400_000;
const IST = 5.5 * 60 * 60 * 1000;

/** Never infer a completed-contact date from scheduling, messages or record updates. */
export function contactHealth(
  dates: Date[], incompleteEvidence: boolean, now = new Date(),
): ContactHealth {
  const valid = dates.filter((date) => Number.isFinite(date.getTime()) && date <= now);
  const uncertain = incompleteEvidence || valid.length !== dates.length;
  const last = valid.length ? new Date(Math.max(...valid.map((date) => date.getTime()))) : null;
  const days = last ? Math.floor((now.getTime() + IST) / DAY) - Math.floor((last.getTime() + IST) / DAY) : null;
  return {
    status: uncertain || days === null ? 'UNKNOWN' : days >= 7 ? 'HIGH_RISK' : days >= 3 ? 'WARNING' : 'RECENT',
    lastContactAt: last?.toISOString() ?? null,
    daysSinceContact: days,
    reason: uncertain
      ? 'Some contact outcomes or completion dates cannot be verified. Contact health cannot be confirmed.'
      : days === null
        ? 'No dated completed contact is recorded. No inactivity starting date has been assumed.'
        : null,
  };
}

export function contactHealthByLead(
  leadIds: string[], calls: Call[], meetings: Meeting[], logs: Completion[], now = new Date(),
) {
  const dates = new Map(leadIds.map((id) => [id, [] as Date[]]));
  const incomplete = new Set<string>();
  const ambiguous = new Map<string, (Date | null)[]>();
  for (const call of calls) {
    if (!dates.has(call.leadId)) continue;
    if (call.outcome !== 'ANSWERED') {
      if (!['CALLBACK', 'MEETING_SCHEDULED'].includes(call.outcome)) continue;
      const pending = ambiguous.get(call.leadId) ?? [];
      pending.push(call.calledAt);
      ambiguous.set(call.leadId, pending);
      continue;
    }
    if (call.calledAt) dates.get(call.leadId)!.push(call.calledAt);
    else incomplete.add(call.leadId);
  }
  // Repeated completion audit rows must not move an old meeting's first
  // completion forward and make an inactive contact appear recent.
  const first = new Map<string, Date>();
  for (const log of logs) {
    const meta = log.meta as { meetingId?: unknown } | null;
    if (!log.leadId || typeof meta?.meetingId !== 'string') continue;
    const key = `${log.leadId}:${meta.meetingId}`;
    if (!first.has(key) || log.createdAt < first.get(key)!) first.set(key, log.createdAt);
  }
  for (const meeting of meetings) {
    if (!dates.has(meeting.leadId)) continue;
    const date = first.get(`${meeting.leadId}:${meeting.id}`);
    if (date) dates.get(meeting.leadId)!.push(date);
    else incomplete.add(meeting.leadId);
  }
  return new Map(leadIds.map((id) => {
    const knownDates = dates.get(id)!;
    const latest = Math.max(-Infinity, ...knownDates.filter((date) => Number.isFinite(date.getTime()) && date <= now).map((date) => date.getTime()));
    const pendingOutcome = (ambiguous.get(id) ?? []).some((date) => !date || !Number.isFinite(date.getTime()) || date.getTime() > latest);
    return [id, contactHealth(knownDates, incomplete.has(id) || pendingOutcome, now)];
  }));
}

export async function loadContactHealth(leadIds: string[], now = new Date()) {
  const ids = [...new Set(leadIds)];
  if (!ids.length) return new Map<string, ContactHealth>();
  const [calls, meetings, logs] = await Promise.all([
    prisma.call.findMany({
      where: { leadId: { in: ids }, outcome: { in: ['ANSWERED', 'CALLBACK', 'MEETING_SCHEDULED'] } },
      select: { leadId: true, calledAt: true, outcome: true },
    }),
    prisma.meeting.findMany({
      where: { leadId: { in: ids }, status: 'COMPLETED' },
      select: { id: true, leadId: true },
    }),
    prisma.activityLog.findMany({
      where: { leadId: { in: ids }, action: 'MEETING_COMPLETED' },
      select: { leadId: true, createdAt: true, meta: true },
    }),
  ]);
  return contactHealthByLead(ids, calls, meetings, logs, now);
}
