import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

const PP_OR_LATER = new Set([
  'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING',
  'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER',
]);

type Lead = {
  id: string; leadId: string; name: string; stage: string;
  estimatedValue: unknown; leadOriginDate: Date;
  activityLogs: { meta: unknown }[];
};
type Meeting = { id: string; leadId: string; lead: Lead };
type Completion = { leadId: string | null; createdAt: Date; meta: unknown };
export type CompletedPitch = Omit<Lead, 'activityLogs'> & { completedAt: Date | null };
export type PitchPeriod = { from: Date; to: Date };

function meetingId(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const id = (meta as { meetingId?: unknown }).meetingId;
  return typeof id === 'string' ? id : null;
}

/**
 * When each meeting was completed: "Mark completed" (MEETING_COMPLETED, dated when marked)
 * and "Log Meeting" (MEETING_LOGGED, dated when the meeting happened, as entered).
 */
export async function meetingCompletionLogs(leadIds: string[]): Promise<Completion[]> {
  if (!leadIds.length) return [];
  const logs = await prisma.activityLog.findMany({
    where: { leadId: { in: leadIds }, action: { in: ['MEETING_COMPLETED', 'MEETING_LOGGED'] } },
    select: { leadId: true, createdAt: true, meta: true, action: true },
  });
  return logs.map(({ action, ...log }) => {
    const held = action === 'MEETING_LOGGED' ? (log.meta as { scheduledAt?: unknown } | null)?.scheduledAt : undefined;
    const at = typeof held === 'string' ? new Date(held) : null;
    return at && !isNaN(at.getTime()) ? { ...log, createdAt: at } : log;
  });
}

/** Never use scheduledAt/updatedAt as evidence of an actual completion. */
export function completedPitches(
  meetings: Meeting[], completions: Completion[], period?: PitchPeriod,
) {
  const dates = new Map<string, Date>();
  for (const log of completions) {
    const id = meetingId(log.meta);
    if (!id || !log.leadId) continue;
    const key = `${log.leadId}:${id}`;
    const previous = dates.get(key);
    if (!previous || log.createdAt < previous) dates.set(key, log.createdAt);
  }
  const qualifying = meetings.filter(({ lead }) =>
    PP_OR_LATER.has(lead.stage) || lead.activityLogs.some(({ meta }) => {
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
      const transition = meta as { to?: unknown; isBackward?: unknown };
      return transition.isBackward !== true && typeof transition.to === 'string' && PP_OR_LATER.has(transition.to);
    }),
  );
  const missingCompletionDates = qualifying.filter((m) => !dates.has(`${m.leadId}:${m.id}`)).length;
  const leads = new Map<string, CompletedPitch>();
  for (const meeting of qualifying) {
    const completedAt = dates.get(`${meeting.leadId}:${meeting.id}`) ?? null;
    if (period && (!completedAt || completedAt < period.from || completedAt > period.to)) continue;
    const previous = leads.get(meeting.leadId);
    if (previous && (!completedAt || (previous.completedAt && previous.completedAt <= completedAt))) continue;
    const { activityLogs: _logs, ...lead } = meeting.lead;
    leads.set(meeting.leadId, { ...lead, completedAt });
  }
  return { pitches: [...leads.values()], missingCompletionDates };
}

/** Shared by dashboard, performance reports and designer pitch credits. */
export async function loadCompletedPitches(leadWhere: Prisma.LeadWhereInput) {
  const meetings = await prisma.meeting.findMany({
    where: { lead: leadWhere, type: 'PP', status: 'COMPLETED' },
    select: {
      id: true, leadId: true,
      lead: { select: {
        id: true, leadId: true, name: true, stage: true, estimatedValue: true, leadOriginDate: true,
        activityLogs: { where: { action: 'STAGE_CHANGED' }, select: { meta: true } },
      } },
    },
  });
  const leadIds = [...new Set(meetings.map((m) => m.leadId))];
  const completions = await meetingCompletionLogs(leadIds);
  return {
    all: completedPitches(meetings, completions),
    inPeriod: (period: PitchPeriod) => completedPitches(meetings, completions, period),
  };
}
