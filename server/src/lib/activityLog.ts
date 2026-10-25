import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

export async function logActivity(
  userId: string,
  action: string,
  leadId?: string,
  meta?: Record<string, unknown>,
) {
  // Record a stable assignee ID at the event, not a name that may later change.
  // Existing historical records are deliberately not inferred or backfilled.
  if (leadId && (action === 'LEAD_CREATED' || action === 'DESIGNER_ASSIGNED')
    && !Object.prototype.hasOwnProperty.call(meta ?? {}, 'assignedDesignerId')) {
    const assigned = await prisma.lead.findUnique({
      where: { id: leadId }, select: { assignedDesignerId: true },
    });
    meta = { ...meta, assignedDesignerId: assigned?.assignedDesignerId ?? null };
  }
  return prisma.activityLog.create({
    data: { userId, action, leadId, meta: meta as Prisma.InputJsonValue | undefined },
  });
}
