// Single source of truth for role-based lead scoping. Used by both the
// leads list endpoint and the dashboard so their populations can never
// drift apart (task #113 review: dashboard/list scope mismatches broke
// KPI drill-through exactness for BL users).
import { defaultLeadRouting, getLeadRouting, type LeadVisibility } from './leadRouting.js';

/** Admin → Lead Routing & Access. Falls back to the narrowest (original) access if settings can't be read. */
export async function leadVisibility(): Promise<LeadVisibility> {
  return (await getLeadRouting().catch(() => defaultLeadRouting())).visibility;
}

export interface ScopeUser {
  id: string;
  role: string;
}

export async function buildLeadRoleWhere(
  user: ScopeUser,
  prisma: { user: { findMany: (args: any) => Promise<{ id: string }[]> } },
  /**
   * `access: true` — which leads this person may OPEN (Leads list, export,
   * WhatsApp inbox), widened by Admin → Lead Routing & Access.
   * Default — whose leads these ARE (dashboards, reports, targets, credits):
   * always the original ownership scope, whatever the visibility setting.
   */
  opts: { access?: boolean } = {},
): Promise<any> {
  const vis = opts.access && ['DESIGNER', 'CRE', 'BL'].includes(user.role)
    ? await leadVisibility()
    : { DESIGNER: 'own', CRE: 'own', BL: 'team' } as const;
  if (user.role === 'DESIGNER') {
    if (vis!.DESIGNER === 'all') return {};
    if (vis!.DESIGNER === 'team') {
      // The designer's team: everyone under the same BL, plus leads held by that BL.
      const me = await (prisma.user as any).findUnique?.({ where: { id: user.id }, select: { blId: true } });
      if (me?.blId) {
        const team = await prisma.user.findMany({ where: { blId: me.blId, isActive: true }, select: { id: true } });
        return { OR: [{ assignedDesignerId: { in: [user.id, ...team.map((m) => m.id)] } }, { assignedBLId: me.blId }] };
      }
    }
    return { assignedDesignerId: user.id };
  }
  if (user.role === 'CRE') {
    if (vis!.CRE === 'all') return {};
    // assignedCREId is the permanent qualification-owner field (Stage 1 of CRE
    // module). assignedDesignerId is kept in the OR for backward compat with
    // leads created before the migration (where CRE was stored there).
    return { OR: [{ assignedCREId: user.id }, { assignedDesignerId: user.id }, { createdById: user.id }] };
  }
  if (user.role === 'BL') {
    if (vis!.BL === 'all') return {};
    const members = await prisma.user.findMany({
      where: { blId: user.id, isActive: true },
      select: { id: true },
    });
    // A BL sees leads assigned to their team OR directly assigned to them.
    return {
      OR: [
        { assignedDesignerId: { in: [user.id, ...members.map((m) => m.id)] } },
        { assignedBLId: user.id },
      ],
    };
  }
  // BRANCH_HEAD / ADMIN — no filter.
  return {};
}

/**
 * Single-lead access check for Designer / CRE (the list endpoint already scopes
 * them; GET/PATCH /leads/:id did not). Other roles keep their existing access.
 * A designer may also open the lead of a project they own or are an approved
 * team member of (lead.assignedDesignerId goes empty after handover).
 */
export async function userCanAccessLead(
  user: ScopeUser,
  leadId: string,
  db: any,
): Promise<boolean> {
  if (user.role !== 'DESIGNER' && user.role !== 'CRE') return true;
  const roleWhere = await buildLeadRoleWhere(user, db, { access: true });
  if ((await db.lead.count({ where: { AND: [{ id: leadId }, roleWhere] } })) > 0) return true;
  if (user.role === 'DESIGNER') {
    const project = await db.project.findFirst({
      where: {
        leadId,
        OR: [
          { designerId: user.id },
          { teamMembers: { some: { userId: user.id, status: 'APPROVED' } } },
        ],
      },
      select: { id: true },
    });
    return !!project;
  }
  return false;
}
