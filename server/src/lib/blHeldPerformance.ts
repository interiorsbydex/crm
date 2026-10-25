import { prisma } from './prisma.js';
import type { TargetCycle } from './targetCycle.js';

type HeldLead = {
  id: string; leadId: string; name: string; stage: string; status: string;
  leadOriginDate: Date;
  dipChecklist: { completedAt: Date | null } | null;
  activityLogs: { createdAt: Date; meta: unknown }[];
};

const REVIEW_REASON = 'Ownership at booking cannot be verified from the available history. Not included in eligible BL booking achievement or Designer totals.';
const NO_DATE_REASON = 'The first Design-in-Progress booking date is missing; its cycle and ownership cannot be verified.';

/** Current ownership is inventory evidence, not proof of historical credit ownership. */
export function summarizeBlHeldLeads(leads: HeldLead[], cycles: TargetCycle[]) {
  const dated = leads.map((lead) => {
    const dates = lead.activityLogs.filter(({ meta }) => {
      const m = meta as { to?: string; isBackward?: boolean } | null;
      return m?.to === 'DESIGN_IN_PROGRESS' && m.isBackward !== true;
    }).map((event) => event.createdAt);
    const bookedAt = dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null;
    return { lead, bookedAt };
  });
  const brief = (lead: HeldLead) => ({
    id: lead.id, leadId: lead.leadId, name: lead.name, stage: lead.stage, status: lead.status,
  });
  return {
    note: 'Current leads assigned directly to this BL with no assigned Designer. These are separate from team Designer performance and targets. Current ownership is not evidence of ownership at an earlier booking.',
    currentLeads: leads.map(brief),
    statusCounts: {
      total: leads.length,
      active: leads.filter((lead) => lead.status === 'ACTIVE').length,
      onHold: leads.filter((lead) => lead.status === 'ON_HOLD').length,
      inactive: leads.filter((lead) => lead.status === 'INACTIVE').length,
    },
    cycles: cycles.map((cycle) => {
      const review = dated.filter(({ lead, bookedAt }) => {
        if (!lead.dipChecklist?.completedAt) return false;
        return bookedAt
          ? bookedAt >= cycle.cycleStart && bookedAt <= cycle.cycleEnd
          : true;
      }).map(({ lead, bookedAt }) => ({
        ...brief(lead), reason: bookedAt ? REVIEW_REASON : NO_DATE_REASON,
      }));
      return {
        cycleStart: cycle.cycleStart.toISOString(),
        leadsReceived: leads.filter((lead) =>
          lead.leadOriginDate >= cycle.cycleStart && lead.leadOriginDate <= cycle.cycleEnd).length,
        // Do not invent a credit attribution, target or cancellation reversal.
        bookingValue: review.length ? null : 0,
        bookingReview: review,
      };
    }),
  };
}

export async function loadBlHeldPerformance(
  blId: string, cycles: TargetCycle[], leadFilter?: Record<string, unknown>,
) {
  const leads = await prisma.lead.findMany({
    where: {
      assignedBLId: blId, assignedDesignerId: null, isTestLead: false,
      ...(leadFilter ? { AND: [leadFilter] } : {}),
    },
    select: {
      id: true, leadId: true, name: true, stage: true, status: true,
      leadOriginDate: true,
      dipChecklist: { select: { completedAt: true } },
      activityLogs: {
        where: { action: 'STAGE_CHANGED' },
        select: { createdAt: true, meta: true },
      },
    },
    orderBy: [{ leadOriginDate: 'desc' }, { id: 'asc' }],
  });
  return summarizeBlHeldLeads(leads, cycles);
}
