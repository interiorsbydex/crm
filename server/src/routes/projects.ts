import { Router, type Request, type Response, type NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { computeDesignPipelineTimeline } from '../config/slaConfig.js';
import { getCrmSettings } from '../lib/crmSettings.js';
import { isAuthorizedForProject, isBLForProject } from '../lib/projectAuth.js';
import { createNotification } from '../lib/notifications.js';
import { buildLeadRoleWhere } from '../lib/leadScope.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';

export const projectsRouter = Router();

const TEAM_MEMBER_INCLUDE = {
  user: { select: { id: true, name: true, role: true, isActive: true } },
  requestedBy: { select: { id: true, name: true, role: true } },
  reviewedBy: { select: { id: true, name: true } },
} as const;

async function findProjectForAuth(projectId: string) {
  return prisma.project.findUnique({
    where: { id: projectId },
    include: { lead: { select: { id: true, leadId: true, assignedDesignerId: true, assignedBLId: true, status: true } } },
  });
}

/**
 * Enforces "at most one APPROVED team member is flagged primary" (task #87).
 *
 * The original `Project.designerId` is always implicitly the project's
 * primary designer (shown as "Project Designer" in the UI) unless a BL/
 * BRANCH_HEAD explicitly designates a specific additional team member as
 * primary instead. So this deliberately does NOT auto-pick a fallback
 * "primary" the moment a team member is approved — an approved member with
 * no explicit primary request stays `isPrimary=false`, leaving the original
 * designer as the (implicit) primary. It only steps in to (a) apply an
 * explicit `preferredPrimaryId` request, or (b) collapse an invalid state
 * where more than one approved member ended up flagged primary.
 */
async function reconcilePrimary(
  tx: any,
  projectId: string,
  preferredPrimaryId?: string,
) {
  const approved = await tx.projectTeamMember.findMany({
    where: { projectId, status: 'APPROVED' },
    orderBy: { createdAt: 'asc' },
  });
  if (approved.length === 0) return;

  const currentPrimaries = approved.filter((m: any) => m.isPrimary);
  let keepId: string | undefined;
  if (preferredPrimaryId && approved.some((m: any) => m.id === preferredPrimaryId)) {
    keepId = preferredPrimaryId;
  } else if (currentPrimaries.length === 1) {
    keepId = currentPrimaries[0].id; // already valid — no change needed
  } else if (currentPrimaries.length > 1) {
    // Invalid state (shouldn't happen via normal flow) — collapse to the
    // earliest-requested of the conflicting primaries.
    keepId = currentPrimaries[0].id;
  }
  // else: zero current primaries and no explicit request — leave everyone
  // false; the original project designer remains the implicit primary.

  await Promise.all(
    approved
      .filter((m: any) => m.isPrimary !== (m.id === keepId))
      .map((m: any) => tx.projectTeamMember.update({ where: { id: m.id }, data: { isPrimary: m.id === keepId } })),
  );
}

// ── BL is view-only on projects ───────────────────────────────────────────────
// BL can see everything a project exposes (list, pipeline, detail, files) but
// cannot mutate project data — that stays with the assigned Designer/CRE and
// Branch Head. Lead mutations are unaffected (see leads.ts) — this guard is
// scoped to project-mutating routes only.
function blockBLWrite(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role === 'BL') {
    res.status(403).json({ error: 'BL role has view-only access to projects' });
    return;
  }
  next();
}

// ── Build designer-scope where clause ─────────────────────────────────────────
// Task #87: an APPROVED ProjectTeamMember has real working access to a
// project, not just the original `designerId` owner — include those project
// IDs in scope alongside the existing designerId-based rules.
async function approvedTeamProjectIds(userId: string): Promise<string[]> {
  const rows = await prisma.projectTeamMember.findMany({
    where: { userId, status: 'APPROVED' },
    select: { projectId: true },
  });
  return rows.map((r) => r.projectId);
}

async function buildProjectWhere(user: { id: string; role: string; blId?: string | null }) {
  if (user.role === 'DESIGNER' || user.role === 'CRE') {
    const teamProjectIds = await approvedTeamProjectIds(user.id);
    return teamProjectIds.length > 0
      ? { OR: [{ designerId: user.id }, { id: { in: teamProjectIds } }] }
      : { designerId: user.id };
  }
  if (user.role === 'BL') {
    const members = await prisma.user.findMany({
      where: { blId: user.id, isActive: true },
      select: { id: true },
    });
    const memberIds = [user.id, ...members.map((m) => m.id)];
    const teamProjectIds = (
      await Promise.all(memberIds.map((id) => approvedTeamProjectIds(id)))
    ).flat();
    return teamProjectIds.length > 0
      ? { OR: [{ designerId: { in: memberIds } }, { id: { in: teamProjectIds } }] }
      : { designerId: { in: memberIds } };
  }
  return {}; // BRANCH_HEAD — all projects
}

// ── GET /api/projects — role-scoped list ─────────────────────────────────────
// Default scope is the established designer/approved-team-membership rule
// (buildProjectWhere) — unchanged for normal project listing so approved
// ProjectTeamMembers keep seeing their working projects.
//
// The BRANCH_HEAD/BL dashboard's project-based KPIs (In Delivery, Outstanding,
// Needs Attention) are computed via a different, lead-based predicate
// (buildLeadRoleWhere). Passing `dashboardScope=true` swaps in that exact
// predicate so KPI drill-through links reproduce the dashboard's counts
// precisely — but this is ONLY honored for BRANCH_HEAD/BL. For BRANCH_HEAD
// both predicates are already "all records" (no widening). For BL,
// buildLeadRoleWhere is a superset that includes leads directly assigned to
// the BL (a scope BL is independently entitled to via /api/leads); for any
// other role (DESIGNER/CRE/ADMIN-as-non-BH) the flag is ignored and the
// established designer/team-membership authorization always applies, so a
// caller can never widen their own access by supplying the query param
// (task #113 review — this used to trust the flag for every role, which let
// CRE/DESIGNER read projects outside their normal authorization via their
// lead-assignment/creation relationships).
projectsRouter.get('/', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    if (user.role === 'CRE') {
      res.status(403).json({ error: 'Projects are not available in the CRE portal' });
      return;
    }
    const { phase, health, excludePhases, hasAttention, hasOutstanding, dashboardScope, leadStage } = req.query as {
      phase?: string; health?: string; excludePhases?: string; hasAttention?: string; hasOutstanding?: string; dashboardScope?: string; leadStage?: string;
    };

    let where: any;
    if (dashboardScope === 'true' && (user.role === 'BRANCH_HEAD' || user.role === 'BL')) {
      const leadRoleWhere = await buildLeadRoleWhere(user, prisma);
      where = Object.keys(leadRoleWhere).length > 0 ? { lead: leadRoleWhere } : {};
    } else {
      where = await buildProjectWhere(user);
    }
    if (phase) where.phase = phase;
    if (excludePhases) where.phase = { notIn: excludePhases.split(',').map((s) => s.trim()).filter(Boolean) };
    if (health) where.health = health;
    // Task #113 — dashboard "Needs Attention"/"Outstanding" KPI tiles drill
    // through here with the exact same predicates used to compute those counts.
    if (hasAttention === 'true') where.attentionFlags = { some: { resolvedAt: null } };
    if (hasOutstanding === 'true') where.outstandingAmount = { gt: 0 };
    // Dashboard "Active Projects" tile drill-through — projects whose lead is
    // currently at a given funnel stage (e.g. DESIGN_IN_PROGRESS), distinct
    // from `phase` which filters on the project's own delivery phase.
    if (leadStage) where.lead = { ...(where.lead ?? {}), stage: leadStage };

    const projects = await prisma.project.findMany({
      where,
      include: {
        lead: { select: { id: true, leadId: true, name: true, phone: true } },
        designer: { select: { id: true, name: true } },
        _count: { select: { collections: true, attentionFlags: true } },
        attentionFlags: {
          where: { resolvedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 3,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ projects, total: projects.length });
  } catch (err: any) {
    console.error('[projects:list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/projects/pipeline — designer's active project pipeline ──────────
// Must be placed BEFORE /:id to avoid the param matcher swallowing "pipeline".
projectsRouter.get('/pipeline', verifyToken, async (req, res) => {
  try {
    const user = req.user!;

    // Only DESIGNER and CRE have a Design Pipeline view.
    // BL/BRANCH_HEAD can call /api/projects directly for team project lists.
    if (user.role !== 'DESIGNER') {
      res.status(403).json({ error: 'Design Pipeline is only available to the DESIGNER role' });
      return;
    }

    const teamProjectIds = await approvedTeamProjectIds(user.id);

    const projects = await prisma.project.findMany({
      where: {
        ...(teamProjectIds.length > 0
          ? { OR: [{ designerId: user.id }, { id: { in: teamProjectIds } }] }
          : { designerId: user.id }),
        phase: { not: 'COMPLETED' },
      },
      include: {
        lead: {
          select: {
            id: true,
            leadId: true,
            name: true,
            phone: true,
            status: true,
            expectedMoveIn: true,
            estimatedValue: true,
            obObmChecklist: {
              select: {
                siteDocumentationAt: true,
                initialSiteDiscussionAt: true,
                layoutFinalisationAt: true,
                designDiscussionAt: true,
                preSignOffAt: true,
                maskingAt: true,
                signOffAt: true,
              },
            },
          },
        },
        attentionFlags: {
          where: { resolvedAt: null },
          select: { id: true, category: true, description: true },
        },
        _count: { select: { collections: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const now = Date.now();
    const crm = await getCrmSettings();
    const designBudget = { phaseDays: crm.designPhaseDays, overallDays: crm.designOverallDays };
    const result = projects.map((p) => ({
      id: p.id,
      projectCode: p.projectCode,
      phase: p.phase,
      health: p.health,
      progressPercent: p.progressPercent,
      contractValue: p.contractValue != null ? Number(p.contractValue) : null,
      outstandingAmount: p.outstandingAmount != null ? Number(p.outstandingAmount) : null,
      handoverTargetDate: p.handoverTargetDate?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      totalActiveDays: Math.floor((now - p.createdAt.getTime()) / 86_400_000),
      collectionsCount: p._count.collections,
      attentionFlags: p.attentionFlags,
      // Design Pipeline 8-stage timeline (task #56) — derived from the OB→OBM
      // checklist's manual timeline dates, with the overall SLA from CRM Settings (default 45 days).
      designTimeline: computeDesignPipelineTimeline(p.lead.obObmChecklist, p.createdAt, undefined, designBudget),
      lead: {
        id: p.lead.id,
        leadId: p.lead.leadId,
        name: p.lead.name,
        phone: p.lead.phone,
        status: p.lead.status,
        expectedMoveIn: p.lead.expectedMoveIn?.toISOString() ?? null,
        estimatedValue: p.lead.estimatedValue != null ? Number(p.lead.estimatedValue) : null,
      },
    }));

    res.json({ projects: result, total: result.length });
  } catch (err: any) {
    console.error('[projects:pipeline]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/projects/:id — project detail ───────────────────────────────────
projectsRouter.get('/:id', verifyToken, async (req, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        lead: { select: { id: true, leadId: true, name: true, phone: true, email: true, assignedDesignerId: true, assignedBLId: true } },
        designer: { select: { id: true, name: true } },
        pd: { select: { id: true, name: true } },
        dtl: { select: { id: true, name: true } },
        collections: { orderBy: { dueDate: 'asc' } },
        attentionFlags: { orderBy: { createdAt: 'desc' } },
        npsResponses: { orderBy: { createdAt: 'desc' } },
        teamMembers: { include: TEAM_MEMBER_INCLUDE, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    // Task #87 added team-member/PD/DTL data here — scope this route now that
    // it carries more than the previously-unscoped collections/NPS summary.
    if (!(await isAuthorizedForProject(project, req.user!))) {
      res.status(403).json({ error: 'Not authorised to view this project' });
      return;
    }
    res.json({ project });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/projects/:id/eligible-team-members — active designers not yet on the team ─
// Available to DESIGNER/BL/BRANCH_HEAD (task #87: all three may initiate a
// team-member request), scoped to project-authorized users only.
projectsRouter.get('/:id/eligible-team-members', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const project = await findProjectForAuth(req.params.id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (!(await isAuthorizedForProject(project, user))) {
      res.status(403).json({ error: 'Not authorised to view this project' });
      return;
    }

    const existingIds = new Set(
      (
        await prisma.projectTeamMember.findMany({
          where: { projectId: project.id, status: { in: ['PENDING', 'APPROVED'] } },
          select: { userId: true },
        })
      ).map((m) => m.userId),
    );
    if (project.designerId) existingIds.add(project.designerId);

    const designers = await prisma.user.findMany({
      where: { role: 'DESIGNER', isActive: true, id: { notIn: [...existingIds] } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    res.json({ designers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/projects/:id/team-members — request/add a team member ──────────
// DESIGNER requests require BL approval (created PENDING); BL/BRANCH_HEAD
// additions take effect immediately (created APPROVED).
projectsRouter.post(
  '/:id/team-members',
  verifyToken,
  requireRole('DESIGNER', 'BL', 'BRANCH_HEAD'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { userId, isPrimary } = req.body as { userId?: string; isPrimary?: boolean };

      if (!userId?.trim()) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const project = await findProjectForAuth(req.params.id);
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
      if (!(await isAuthorizedForProject(project, user))) {
        res.status(403).json({ error: 'Not authorised to modify this project' });
        return;
      }
      if (isLeadLocked(project.lead.status)) { sendLeadLockedError(res); return; }

      const candidate = await prisma.user.findUnique({ where: { id: userId } });
      if (!candidate || !candidate.isActive || candidate.role !== 'DESIGNER') {
        res.status(400).json({ error: 'userId must be an active DESIGNER user' });
        return;
      }
      if (project.designerId === userId) {
        res.status(400).json({ error: 'This user is already the project designer' });
        return;
      }

      const existing = await prisma.projectTeamMember.findFirst({
        where: { projectId: project.id, userId, status: { in: ['PENDING', 'APPROVED'] } },
      });
      if (existing) {
        res.status(409).json({ error: `This user already has a ${existing.status.toLowerCase()} team-member entry on this project` });
        return;
      }

      // BL/BRANCH_HEAD additions are self-approving — a BL approving their
      // own addition would be a no-op step, and BRANCH_HEAD outranks the
      // approval gate entirely. Only a DESIGNER-initiated request needs a
      // BL's sign-off.
      const autoApprove = user.role === 'BL' || user.role === 'BRANCH_HEAD';

      const member = await prisma.$transaction(async (tx) => {
        const created = await tx.projectTeamMember.create({
          data: {
            projectId: project.id,
            userId,
            isPrimary: !!isPrimary,
            status: autoApprove ? 'APPROVED' : 'PENDING',
            requestedById: user.id,
            ...(autoApprove && { reviewedById: user.id, reviewedAt: new Date() }),
          },
          include: TEAM_MEMBER_INCLUDE,
        });
        if (autoApprove) {
          await reconcilePrimary(tx, project.id, isPrimary ? created.id : undefined);
        }
        return tx.projectTeamMember.findUnique({ where: { id: created.id }, include: TEAM_MEMBER_INCLUDE });
      });

      await logActivity(user.id, autoApprove ? 'PROJECT_TEAM_MEMBER_ADDED' : 'PROJECT_TEAM_MEMBER_REQUESTED', project.lead.id, {
        projectId: project.id, memberUserId: userId, autoApprove,
      });

      if (autoApprove) {
        await createNotification(userId, 'TEAM_MEMBER_APPROVED', `You were added to the project team for lead ${project.lead.leadId}`, project.lead.id);
      } else {
        // Notify the project's BL(s) that a request needs approval.
        const blIds = new Set<string>();
        if (project.lead.assignedBLId) blIds.add(project.lead.assignedBLId);
        if (project.designerId) {
          const designer = await prisma.user.findUnique({ where: { id: project.designerId }, select: { blId: true } });
          if (designer?.blId) blIds.add(designer.blId);
        }
        await Promise.all(
          [...blIds].map((blId) =>
            createNotification(blId, 'TEAM_MEMBER_REQUESTED', `${user.name} requested to add a team member to project for lead ${project.lead.leadId}`, project.lead.id),
          ),
        );
      }

      res.status(201).json({ member });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ── PATCH /api/projects/:id/team-members/:memberId/approve — BL or BRANCH_HEAD ─
projectsRouter.patch(
  '/:id/team-members/:memberId/approve',
  verifyToken,
  requireRole('BL', 'BRANCH_HEAD'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { id, memberId } = req.params;
      const { isPrimary } = req.body as { isPrimary?: boolean };

      const project = await findProjectForAuth(id);
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
      if (user.role !== 'BRANCH_HEAD' && !(await isBLForProject(project, user))) {
        res.status(403).json({ error: 'Only the project\'s BL or a Branch Head can approve team-member requests' });
        return;
      }
      if (isLeadLocked(project.lead.status)) { sendLeadLockedError(res); return; }

      const member = await prisma.projectTeamMember.findUnique({ where: { id: memberId } });
      if (!member || member.projectId !== id) { res.status(404).json({ error: 'Team member request not found' }); return; }
      if (member.status !== 'PENDING') {
        res.status(400).json({ error: `Cannot approve a request that is already ${member.status}` });
        return;
      }

      const resolvedPrimary = isPrimary !== undefined ? isPrimary : member.isPrimary;

      const updated = await prisma.$transaction(async (tx) => {
        const approved = await tx.projectTeamMember.update({
          where: { id: memberId },
          data: { status: 'APPROVED', reviewedById: user.id, reviewedAt: new Date(), isPrimary: resolvedPrimary },
          include: TEAM_MEMBER_INCLUDE,
        });
        await reconcilePrimary(tx, id, resolvedPrimary ? approved.id : undefined);
        return tx.projectTeamMember.findUnique({ where: { id: memberId }, include: TEAM_MEMBER_INCLUDE });
      });

      await logActivity(user.id, 'PROJECT_TEAM_MEMBER_APPROVED', project.lead.id, { projectId: id, memberId });
      await createNotification(member.userId, 'TEAM_MEMBER_APPROVED', `You were approved as a team member for lead ${project.lead.leadId}`, project.lead.id);
      await createNotification(member.requestedById, 'TEAM_MEMBER_APPROVED', `Your team-member request for lead ${project.lead.leadId} was approved`, project.lead.id);

      res.json({ member: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ── PATCH /api/projects/:id/team-members/:memberId/reject — BL or BRANCH_HEAD ─
projectsRouter.patch(
  '/:id/team-members/:memberId/reject',
  verifyToken,
  requireRole('BL', 'BRANCH_HEAD'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { id, memberId } = req.params;
      const { reason } = req.body as { reason?: string };

      if (!reason?.trim()) {
        res.status(400).json({ error: 'A reason is required to reject a team-member request' });
        return;
      }

      const project = await findProjectForAuth(id);
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
      if (user.role !== 'BRANCH_HEAD' && !(await isBLForProject(project, user))) {
        res.status(403).json({ error: 'Only the project\'s BL or a Branch Head can reject team-member requests' });
        return;
      }
      if (isLeadLocked(project.lead.status)) { sendLeadLockedError(res); return; }

      const member = await prisma.projectTeamMember.findUnique({ where: { id: memberId } });
      if (!member || member.projectId !== id) { res.status(404).json({ error: 'Team member request not found' }); return; }
      if (member.status !== 'PENDING') {
        res.status(400).json({ error: `Cannot reject a request that is already ${member.status}` });
        return;
      }

      const updated = await prisma.projectTeamMember.update({
        where: { id: memberId },
        data: { status: 'REJECTED', reviewedById: user.id, reviewedAt: new Date(), rejectionReason: reason.trim() },
        include: TEAM_MEMBER_INCLUDE,
      });

      await logActivity(user.id, 'PROJECT_TEAM_MEMBER_REJECTED', project.lead.id, { projectId: id, memberId, reason: reason.trim() });
      await createNotification(member.requestedById, 'TEAM_MEMBER_REJECTED', `Your team-member request for lead ${project.lead.leadId} was rejected: ${reason.trim()}`, project.lead.id);

      res.json({ member: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ── PATCH /api/projects/:id/team-members/:memberId/primary — switch primary ──
// Lets a BL/BRANCH_HEAD re-designate which already-APPROVED member is
// primary after the fact, without re-running the approval flow.
projectsRouter.patch(
  '/:id/team-members/:memberId/primary',
  verifyToken,
  requireRole('BL', 'BRANCH_HEAD'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { id, memberId } = req.params;

      const project = await findProjectForAuth(id);
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
      if (user.role === 'BL' && !(await isBLForProject(project, user))) {
        res.status(403).json({ error: 'Not authorised to manage this project\'s team' });
        return;
      }
      if (isLeadLocked(project.lead.status)) { sendLeadLockedError(res); return; }

      const member = await prisma.projectTeamMember.findUnique({ where: { id: memberId } });
      if (!member || member.projectId !== id) { res.status(404).json({ error: 'Team member not found' }); return; }
      if (member.status !== 'APPROVED') {
        res.status(400).json({ error: 'Only an approved team member can be marked primary' });
        return;
      }

      await prisma.$transaction((tx) => reconcilePrimary(tx, id, memberId));
      const updated = await prisma.projectTeamMember.findMany({
        where: { projectId: id, status: 'APPROVED' },
        include: TEAM_MEMBER_INCLUDE,
        orderBy: { createdAt: 'asc' },
      });

      await logActivity(user.id, 'PROJECT_TEAM_MEMBER_PRIMARY_CHANGED', project.lead.id, { projectId: id, memberId });

      res.json({ members: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ── PATCH /api/projects/:id — update phase, health, progress, dates ───────────
projectsRouter.patch('/:id', verifyToken, blockBLWrite, async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { phase, health, progressPercent, handoverTargetDate, outstandingAmount } = req.body as {
      phase?: string; health?: string; progressPercent?: number;
      handoverTargetDate?: string; outstandingAmount?: number;
    };

    const existing = await findProjectForAuth(id);
    if (!existing) { res.status(404).json({ error: 'Project not found' }); return; }
    if (!(await isAuthorizedForProject(existing, user))) {
      res.status(403).json({ error: 'Not authorised to modify this project' });
      return;
    }
    if (isLeadLocked(existing.lead.status)) { sendLeadLockedError(res); return; }

    const project = await prisma.project.update({
      where: { id },
      data: {
        ...(phase && { phase: phase as any }),
        ...(health && { health: health as any }),
        ...(progressPercent !== undefined && { progressPercent }),
        ...(handoverTargetDate && { handoverTargetDate: new Date(handoverTargetDate) }),
        ...(outstandingAmount !== undefined && { outstandingAmount }),
      },
      include: {
        lead: { select: { id: true, leadId: true, name: true } },
        designer: { select: { id: true, name: true } },
      },
    });

    await logActivity(user.id, 'PROJECT_UPDATED', project.lead.id, {
      projectId: id,
      changes: { phase, health, progressPercent },
    });

    res.json({ project });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/projects/:id/attention-flag — flag an issue ────────────────────
projectsRouter.post('/:id/attention-flag', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { category, description } = req.body as { category?: string; description?: string };

    if (!category?.trim() || !description?.trim()) {
      res.status(400).json({ error: 'category and description are required' });
      return;
    }

    const project = await findProjectForAuth(id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (!(await isAuthorizedForProject(project, user))) {
      res.status(403).json({ error: 'Not authorised to modify this project' });
      return;
    }
    if (isLeadLocked(project.lead.status)) { sendLeadLockedError(res); return; }

    const flag = await prisma.projectAttentionFlag.create({
      data: { projectId: id, category, description },
    });

    await logActivity(user.id, 'ATTENTION_FLAG_ADDED', project.lead.id, {
      projectId: id, category, description,
    });

    res.status(201).json({ flag });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/projects/:id/attention-flag/:flagId/resolve ───────────────────
projectsRouter.patch('/:id/attention-flag/:flagId/resolve', verifyToken, blockBLWrite, async (req, res) => {
  try {
    const user = req.user!;
    const { id, flagId } = req.params;

    const flag = await prisma.projectAttentionFlag.findUnique({ where: { id: flagId } });
    if (!flag) { res.status(404).json({ error: 'Flag not found' }); return; }
    if (flag.projectId !== id) { res.status(400).json({ error: 'Flag does not belong to this project' }); return; }

    const project = await findProjectForAuth(id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (!(await isAuthorizedForProject(project, user))) {
      res.status(403).json({ error: 'Not authorised to modify this project' });
      return;
    }
    if (isLeadLocked(project.lead.status)) { sendLeadLockedError(res); return; }

    const resolved = await prisma.projectAttentionFlag.update({
      where: { id: flagId },
      data: { resolvedAt: new Date() },
    });

    await logActivity(user.id, 'ATTENTION_FLAG_RESOLVED', project.lead.id, { flagId });

    res.json({ flag: resolved });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
