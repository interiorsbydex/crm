import { prisma } from './prisma.js';

type ProjectForAuth = {
  id: string;
  designerId: string | null;
  lead: { assignedDesignerId: string | null; assignedBLId: string | null };
};

/**
 * Returns true if the acting user may view/act on the given project.
 *
 * Project-level scope intentionally does NOT delegate to `isAuthorizedForLead`
 * as-is: by the time a project exists the lead has typically reached
 * HANDED_OVER/DESIGN_IN_PROGRESS, and `assignedDesignerId`/`assignedBLId` on
 * the *lead* are sometimes cleared at that point while `project.designerId`
 * remains the authoritative owner. So DESIGNER scope checks `project.designerId`
 * (falling back to the lead field), and an APPROVED team member is also in
 * scope — they are legitimately working the project once approved.
 */
export async function isAuthorizedForProject(
  project: ProjectForAuth,
  user: { id: string; role: string },
): Promise<boolean> {
  if (['ADMIN', 'BRANCH_HEAD'].includes(user.role)) return true;

  if (user.role === 'DESIGNER' || user.role === 'CRE') {
    if (project.designerId === user.id) return true;
    if (project.lead.assignedDesignerId === user.id) return true;
    const approvedMember = await prisma.projectTeamMember.findFirst({
      where: { projectId: project.id, userId: user.id, status: 'APPROVED' },
    });
    return !!approvedMember;
  }

  if (user.role === 'BL') {
    return isBLForProject(project, user);
  }

  return false;
}

/**
 * Returns true if the acting user is the BL responsible for this project —
 * i.e. the only role permitted to approve/reject a pending team-member
 * request (task #87 spec: "only BL can approve").
 */
export async function isBLForProject(
  project: ProjectForAuth,
  user: { id: string; role: string },
): Promise<boolean> {
  if (user.role !== 'BL') return false;
  if (project.lead.assignedBLId === user.id) return true;

  const designerIds = new Set<string>();
  if (project.designerId) designerIds.add(project.designerId);
  if (project.lead.assignedDesignerId) designerIds.add(project.lead.assignedDesignerId);
  if (designerIds.size > 0) {
    const member = await prisma.user.findFirst({ where: { id: { in: [...designerIds] }, blId: user.id } });
    if (member) return true;
  }
  return false;
}
