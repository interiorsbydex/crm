import { prisma } from './prisma.js';
import { isLenientLaunch } from './lenientMode.js';

/**
 * Returns true if the acting user may assign a follow-up task to
 * `assigneeId`. Mirrors `isAuthorizedForLead`'s reporting-scope rules so a
 * user cannot use task assignment as a side channel to notify/email a
 * client via an arbitrary target user, or spam a user outside their team:
 *  - ADMIN / BRANCH_HEAD : any existing user
 *  - DESIGNER / CRE      : self only
 *  - BL                  : self, or a designer/CRE on their team (blId === user.id)
 */
export async function isAuthorizedToAssignTask(
  assigneeId: string,
  user: { id: string; role: string },
): Promise<boolean> {
  if (assigneeId === user.id) {
    return !!(await prisma.user.findUnique({ where: { id: assigneeId }, select: { id: true } }));
  }

  if (['ADMIN', 'BRANCH_HEAD'].includes(user.role)) {
    return !!(await prisma.user.findUnique({ where: { id: assigneeId }, select: { id: true } }));
  }

  if (user.role === 'BL') {
    const member = await prisma.user.findFirst({ where: { id: assigneeId, blId: user.id } });
    return !!member;
  }

  // DESIGNER / CRE (and any other role) may only assign to themselves.
  return false;
}

/**
 * Returns true if the authenticated user is permitted to access or mutate the
 * given lead.  Call this after finding the lead but before doing any DB writes.
 *
 * Scope rules (mirror the GET /api/leads list filter):
 *  - ADMIN / BRANCH_HEAD : any lead
 *  - DESIGNER / CRE      : only leads where assignedDesignerId === user.id
 *  - BL                  : leads where assignedBLId === user.id, OR where
 *                          assignedDesignerId belongs to one of their team members
 */
export async function isAuthorizedForLead(
  lead: { id?: string; assignedDesignerId: string | null; assignedBLId: string | null; assignedCREId?: string | null },
  user: { id: string; role: string },
): Promise<boolean> {
  if (['ADMIN', 'BRANCH_HEAD'].includes(user.role)) return true;

  if (user.role === 'DESIGNER' || user.role === 'CRE') {
    if (lead.assignedDesignerId === user.id) return true;
    // Lenient launch: a CRE keeps access to the leads they own after the lead is handed to a BL/designer.
    if (user.role === 'CRE' && isLenientLaunch()) {
      if (lead.assignedCREId !== undefined) return lead.assignedCREId === user.id;
      if (lead.id) {
        const row = await prisma.lead.findUnique({ where: { id: lead.id }, select: { assignedCREId: true } });
        return row?.assignedCREId === user.id;
      }
    }
    return false;
  }

  if (user.role === 'BL') {
    if (lead.assignedBLId === user.id) return true;
    if (lead.assignedDesignerId) {
      const member = await prisma.user.findFirst({
        where: { id: lead.assignedDesignerId, blId: user.id },
      });
      return !!member;
    }
    return false;
  }

  return false;
}
