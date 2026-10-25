import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import type { TargetCycle } from './targetCycle.js';

type Event = { action: string; createdAt: Date; meta: unknown };
type Booking = {
  id: string; leadId: string; name: string; status: string; stage: string;
  activityLogs: Event[];
};
export type CancellationReview = { id: string; leadId: string; name: string; reason: string };

const meta = (event: Event): Record<string, unknown> =>
  event.meta && typeof event.meta === 'object' && !Array.isArray(event.meta)
    ? event.meta as Record<string, unknown> : {};
const isCancellation = (event: Event) =>
  ['STATUS_CHANGED', 'STAGE_CHANGED'].includes(event.action) && meta(event).to === 'INACTIVE';

// Read-only: preserve the original events. Reverse later status transitions to
// reconstruct the booking's status at a historical cycle end, not today's status.
export function cancellationContext(bookings: Booking[], cycle: TargetCycle, now = new Date()) {
  const excludedLeadIds: string[] = [];
  const pendingReview: CancellationReview[] = [];
  const cutoff = new Date(Math.min(cycle.cycleEnd.getTime(), now.getTime()));
  for (const booking of bookings) {
    const events = [...booking.activityLogs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const bookedAt = events.find((event) =>
      event.action === 'STAGE_CHANGED' && meta(event).to === 'DESIGN_IN_PROGRESS' && meta(event).isBackward !== true
    )?.createdAt;
    if (bookedAt && bookedAt > cutoff) continue;
    const cancellations = events.filter(isCancellation);
    let inactive = booking.status === 'INACTIVE' || booking.stage === 'INACTIVE';
    let incompleteHistory = false;
    for (const event of [...events].reverse()) {
      if (event.createdAt <= cutoff) continue;
      const data = meta(event);
      if (event.action === 'STATUS_CHANGED' || event.action === 'LEAD_REACTIVATED' || isCancellation(event)) {
        if (typeof data.from === 'string') inactive = data.from === 'INACTIVE';
        else incompleteHistory = true;
      }
    }
    // An inactive legacy record without dated cancellation evidence cannot
    // establish which historical cycle to amend. Preserve that historical
    // booking population and explicitly withhold its uncertain credit totals.
    const undated = (inactive && cancellations.length === 0) || incompleteHistory;
    if (inactive && !(undated && cycle.cycleEnd < now)) excludedLeadIds.push(booking.id);
    const historicalCancellation = cancellations.some((event) =>
      event.createdAt >= cycle.cycleStart && event.createdAt <= cutoff &&
      (!bookedAt || bookedAt < cycle.cycleStart)
    );
    if (historicalCancellation || undated) {
      pendingReview.push({
        id: booking.id, leadId: booking.leadId, name: booking.name,
        reason: undated
          ? 'Cancellation date/original credit award cannot be verified.'
          : 'Earlier-cycle booking cancelled in this cycle; original credit award requires review.',
      });
    }
  }
  return { excludedLeadIds, pendingReview };
}

export async function loadBookingCancellations(base: Prisma.LeadWhereInput, cycle: TargetCycle) {
  const bookings = await prisma.lead.findMany({
    where: {
      AND: [
        base, { dipChecklist: { completedAt: { not: null } } },
        { OR: [
          { status: 'INACTIVE' }, { stage: 'INACTIVE' },
          { activityLogs: { some: {
            action: { in: ['STATUS_CHANGED', 'STAGE_CHANGED'] },
            meta: { path: ['to'], equals: 'INACTIVE' },
          } } },
        ] },
      ],
    },
    select: {
      id: true, leadId: true, name: true, status: true, stage: true,
      activityLogs: {
        where: { action: { in: ['STAGE_CHANGED', 'STATUS_CHANGED', 'LEAD_REACTIVATED'] } },
        select: { action: true, createdAt: true, meta: true },
      },
    },
  });
  return cancellationContext(bookings, cycle);
}

export class CancellationReviewRequired extends Error {
  constructor(public leads: CancellationReview[], public cycle: TargetCycle) {
    super('Unavailable pending review: historical cancellation credit awards cannot be verified. No estimated deductions or totals are shown.');
    this.name = 'CancellationReviewRequired';
  }
}
