import { prisma } from './prisma.js';

function daysBetween(a: Date, b: Date) {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * The day the lead actually moved to Onboarding: its first STAGE_CHANGED entry to ONBOARDING.
 * Leads with no such entry (for example imported straight into a later stage) have no date.
 */
export function onboardingMovedAt(stageChanges: { createdAt: Date; meta: unknown }[]): Date | null {
  let first: Date | null = null;
  for (const c of stageChanges) {
    if ((c.meta as { to?: unknown } | null)?.to !== 'ONBOARDING') continue;
    if (!first || c.createdAt < first) first = c.createdAt;
  }
  return first;
}

/** Whole days from the PP meeting to the move to Onboarding (never negative). */
export function ppToOnboardingDays(ppMeetingAt: Date, movedToOnboardingAt: Date): number {
  return Math.max(0, daysBetween(ppMeetingAt, movedToOnboardingAt));
}

export async function recalculateMilestones(leadId: string) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      meetings: { where: { status: 'COMPLETED' }, orderBy: { scheduledAt: 'asc' } },
      activityLogs: { where: { action: 'STAGE_CHANGED' }, select: { createdAt: true, meta: true } },
    },
  });
  if (!lead) return;

  const dqlMeeting = lead.meetings.find((m) => m.type === 'DQL');
  const ppMeeting = lead.meetings.find((m) => m.type === 'PP');

  const daysLeadToDQL = dqlMeeting
    ? daysBetween(lead.createdAt, dqlMeeting.scheduledAt)
    : null;

  const daysDQLToPP =
    dqlMeeting && ppMeeting
      ? daysBetween(dqlMeeting.scheduledAt, ppMeeting.scheduledAt)
      : null;

  // Reports still read daysPPToOnboarding as the PP -> Onboarding sales-cycle
  // metric, so it must keep being recorded once a lead reaches Onboarding —
  // not just while it's still sitting there. Otherwise leads that progress
  // on to ONBOARDING_MEETING/DESIGN_IN_PROGRESS/HANDED_OVER would silently
  // lose this timing metric (see .agents/memory/funnel-restructure.md).
  const REACHED_ONBOARDING_OR_LATER = new Set([
    'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER',
  ]);
  // Measured to the day the lead actually moved to Onboarding (from its stage history),
  // not to lead.updatedAt, which changes whenever anything on the lead is edited.
  let daysPPToOnboarding: number | null = null;
  const movedAt = onboardingMovedAt(lead.activityLogs);
  if (ppMeeting && movedAt && REACHED_ONBOARDING_OR_LATER.has(lead.stage)) {
    daysPPToOnboarding = ppToOnboardingDays(ppMeeting.scheduledAt, movedAt);
  }

  const next = {
    daysLeadToDQL: daysLeadToDQL ?? undefined,
    daysDQLToPP: daysDQLToPP ?? undefined,
    daysPPToOnboarding: daysPPToOnboarding ?? undefined,
  };
  // Only write when something changed, so a recalculation never touches the lead's "updated" time for nothing.
  if (next.daysLeadToDQL === lead.daysLeadToDQL || next.daysLeadToDQL === undefined) delete next.daysLeadToDQL;
  if (next.daysDQLToPP === lead.daysDQLToPP || next.daysDQLToPP === undefined) delete next.daysDQLToPP;
  if (next.daysPPToOnboarding === lead.daysPPToOnboarding || next.daysPPToOnboarding === undefined) delete next.daysPPToOnboarding;
  if (Object.keys(next).length === 0) return;
  await prisma.lead.update({ where: { id: leadId }, data: next });
}

/**
 * One-off safe recalculation of PP → Onboarding days for existing leads (run by
 * scripts/recalculate-pp-onboarding-days.ts). Only that one number is touched, and only for leads that
 * have both a completed PP meeting and a recorded move to Onboarding. With apply = false nothing is written.
 */
export async function recalculatePpOnboardingForAll(apply: boolean) {
  const leads = await prisma.lead.findMany({
    where: { stage: { in: ['ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER'] } },
    select: {
      id: true, leadId: true, daysPPToOnboarding: true,
      meetings: { where: { status: 'COMPLETED', type: 'PP' }, orderBy: { scheduledAt: 'asc' }, take: 1, select: { scheduledAt: true } },
      activityLogs: { where: { action: 'STAGE_CHANGED' }, select: { createdAt: true, meta: true } },
    },
  });
  const changes: { leadId: string; from: number | null; to: number }[] = [];
  let skipped = 0;
  for (const l of leads) {
    const pp = l.meetings[0];
    const movedAt = onboardingMovedAt(l.activityLogs);
    if (!pp || !movedAt) { skipped++; continue; }
    const days = ppToOnboardingDays(pp.scheduledAt, movedAt);
    if (days === l.daysPPToOnboarding) continue;
    changes.push({ leadId: l.leadId, from: l.daysPPToOnboarding, to: days });
    if (apply) {
      // updateMany leaves the lead's "updated" time alone only if nothing else changed; use a raw update to avoid touching it.
      await prisma.$executeRaw`UPDATE leads SET "daysPPToOnboarding" = ${days} WHERE id = ${l.id}`;
    }
  }
  return { checked: leads.length, skipped, changes, applied: apply };
}
