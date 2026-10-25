import { prisma } from './prisma.js';

function daysBetween(a: Date, b: Date) {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

export async function recalculateMilestones(leadId: string) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { meetings: { where: { status: 'COMPLETED' }, orderBy: { scheduledAt: 'asc' } } },
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
  let daysPPToOnboarding: number | null = null;
  if (ppMeeting && REACHED_ONBOARDING_OR_LATER.has(lead.stage)) {
    daysPPToOnboarding = daysBetween(ppMeeting.scheduledAt, lead.updatedAt);
  }

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      daysLeadToDQL: daysLeadToDQL ?? undefined,
      daysDQLToPP: daysDQLToPP ?? undefined,
      daysPPToOnboarding: daysPPToOnboarding ?? undefined,
    },
  });
}
