// Single source of truth for role-based lead scoping. Used by both the
// leads list endpoint and the dashboard so their populations can never
// drift apart (task #113 review: dashboard/list scope mismatches broke
// KPI drill-through exactness for BL users).
export interface ScopeUser {
  id: string;
  role: string;
}

export async function buildLeadRoleWhere(
  user: ScopeUser,
  prisma: { user: { findMany: (args: any) => Promise<{ id: string }[]> } },
): Promise<any> {
  if (user.role === 'DESIGNER') {
    return { assignedDesignerId: user.id };
  }
  if (user.role === 'CRE') {
    // assignedCREId is the permanent qualification-owner field (Stage 1 of CRE
    // module). assignedDesignerId is kept in the OR for backward compat with
    // leads created before the migration (where CRE was stored there).
    return { OR: [{ assignedCREId: user.id }, { assignedDesignerId: user.id }, { createdById: user.id }] };
  }
  if (user.role === 'BL') {
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
  const roleWhere = await buildLeadRoleWhere(user, db);
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
