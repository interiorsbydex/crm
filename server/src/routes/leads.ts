import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { createNotification } from '../lib/notifications.js';
import { sendEmail, stageMoveBackwardEmail, intentRatingChangedEmail } from '../lib/email.js';
import { createAndSendNps, getNpsSendState } from '../lib/npsHelper.js';
import { npsSurveyForStage } from '../lib/reportDefinitions.js';
import { designerAssignmentDates, designerAssignmentAgeDays } from '../lib/designerAssignmentAge.js';
import { logGateBypass, isStrictStage } from '../lib/lenientMode.js';
import { selectBLForLead, assignLeadToDesigner, incrementAssigned } from '../services/assignmentService.js';
import { checkStageRequirements, isStageJumpAllowed, FUNNEL_ORDER, getEffectiveStageRules, describeAllowedSkips } from '../config/stageRequirements.js';
import { computeSystemRating } from '../services/intentScoring.js';
import { isAuthorizedForLead } from '../lib/leadAuth.js';
import { isValidEmail, isValidPhone, isValidPhoneStrict } from '../lib/leadValidation.js';
import { computeSlaInfoForLeads, computeSlaInfoForLead, getEffectiveStageSla } from '../lib/stageSla.js';
import { putLeadOnHold, markLeadInactive, reactivateLead } from '../lib/leadStatusActions.js';
import { buildLeadRoleWhere, userCanAccessLead } from '../lib/leadScope.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';
import { hasAllMqlMandatoryFields, getLeadMqlMandatoryFields } from '../lib/leadMandatoryFields.js';
import { getCrmSettings, stageName } from '../lib/crmSettings.js';
import { renderMailTemplate } from '../lib/mailTemplates.js';
import { saveDraft } from '../lib/emailService.js';
import {
  buildStageTimelineHistory,
  getCommercialContextForLead,
  resolveCommercialContext,
  type CommercialContext,
} from '../lib/stageTimeline.js';
import { isAutomationOn } from '../lib/automations.js';
import { requirePermission, hasPermission } from '../lib/permissions.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/**
 * Lead-source filter. Sources are stored as codes (META_ADS) by the new-lead
 * form, webhooks and imports, but older edits saved the display name
 * ("Meta Ads"), so a filter matches either, ignoring case.
 */
async function sourceWhere(source: string) {
  const option = (await getCrmSettings()).leadSources.find((s) => s.value === source || s.label.toLowerCase() === source.toLowerCase());
  const names = Array.from(new Set([source, ...(option ? [option.value, option.label] : [])]));
  return { OR: names.map((n) => ({ source: { equals: n, mode: 'insensitive' as const } })) };
}

export const leadsRouter = Router();

// ── Auto-generate X#### lead ID ───────────────────────────────────────────────
async function generateLeadId(): Promise<string> {
  const counter = await prisma.$transaction(async (tx) => {
    return tx.leadCounter.upsert({
      where: { id: 1 },
      create: { id: 1, lastNum: 1 },
      update: { lastNum: { increment: 1 } },
    });
  });
  return `X${String(counter.lastNum).padStart(4, '0')}`;
}

const LEAD_INCLUDE = {
  assignedDesigner: { select: { id: true, name: true, role: true } },
  assignedBL: { select: { id: true, name: true } },
  currentOffer: { select: { id: true, name: true } },
  // Only count active, non-archived tasks — RESCHEDULED/NOT_DONE rows are
  // terminal history and must not inflate the sidebar "N follow-ups" counter.
  _count: { select: { calls: true, meetings: true, followUpTasks: { where: { isCompleted: false, status: 'PENDING' } } } },
  followUpTasks: {
    // status: 'PENDING' excludes RESCHEDULED/NOT_DONE archive rows — those
    // are terminal and must never surface as an "overdue" badge on the lead.
    where: { isOverdue: true, isCompleted: false, status: 'PENDING' },
    select: { id: true },
    take: 1,
  },
  attentionFlags: {
    where: { resolvedAt: null },
    orderBy: { createdAt: 'desc' as const },
  },
} as const;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Overall pipeline age starts at the lead's recorded origin date and stops at
 * the first terminal sales-pipeline transition. Existing Handed Over records
 * are included because they predate Design in Progress as the terminal stage.
 */
function calculateOverallPipelineAgeDays(
  leadOriginDate: Date,
  terminalStageAt?: Date,
  now = new Date(),
): number {
  const endAt = terminalStageAt ?? now;
  return Math.max(0, Math.floor((endAt.getTime() - leadOriginDate.getTime()) / MILLISECONDS_PER_DAY));
}

// ── GET /api/leads — list with filters + pagination ───────────────────────────
leadsRouter.get('/', verifyToken, async (req, res) => {
  try {
    const {
      stage, source, designerId, blId, allocatedToId, search,
      isSLABreached, page = '1', limit = '50',
      projectType, location, dateRange, intent, intentMin, intentMax,
      status,
      // New pipeline filters (task #27)
      originDateFrom, originDateTo,
      budgetMin, budgetMax,
      possessionDateFrom, possessionDateTo,
      projectedObFrom, projectedObTo,
      pipelineMode,
      // Task #113 — lets dashboard KPI drill-through links exactly reproduce
      // a stage-excluding count (e.g. "active leads" excludes the terminal
      // DESIGN_IN_PROGRESS/HANDED_OVER stages) without a separate endpoint.
      excludeStages,
      hasUnresolvedSlaBreach,
    } = req.query as Record<string, string>;

    const user = req.user!;
    const where: any = {};

    // Role-scope — shared with the dashboard (buildLeadRoleWhere) so the two
    // never drift apart and KPI drill-through counts stay exact.
    const roleWhere = await buildLeadRoleWhere(user, prisma);
    if (Object.keys(roleWhere).length > 0) where.AND = [roleWhere];

    // Task #88: status (ACTIVE/ON_HOLD/INACTIVE) is a real field, independent
    // of stage — both filters can be applied together.
    const selectedStages = stage?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
    if (selectedStages.length === 1) where.stage = selectedStages[0];
    if (selectedStages.length > 1) where.stage = { in: selectedStages };
    if (excludeStages) {
      const stageFilter = typeof where.stage === 'string' ? { equals: where.stage } : (where.stage ?? {});
      where.stage = { ...stageFilter, notIn: excludeStages.split(',').map((s) => s.trim()).filter(Boolean) };
    }
    const selectedStatuses = status?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
    if (selectedStatuses.length === 1) where.status = selectedStatuses[0];
    if (selectedStatuses.length > 1) where.status = { in: selectedStatuses };
    if (source) where.AND = [...(Array.isArray(where.AND) ? where.AND : []), await sourceWhere(source)];
    if (designerId) {
      // A team member may own the lead as Designer or as CRE (assignedCREId).
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        { OR: [{ assignedDesignerId: designerId }, { assignedCREId: designerId }] },
      ];
    }
    if (blId) where.assignedBLId = blId;
    if (allocatedToId) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        { OR: [{ assignedDesignerId: allocatedToId }, { assignedBLId: allocatedToId }] },
      ];
    }
    // ONBOARDING excluded (task #14) — the legacy flag is display-suppressed
    // for that stage below, so it must also be excluded from this filter to
    // avoid a lead appearing in "SLA breached" results while showing
    // isSLABreached:false on its own record.
    if (isSLABreached === 'true') {
      where.isSLABreached = true;
      if (!where.stage) where.stage = { not: 'ONBOARDING' };
    }
    // Task #113 — exact match for the dashboard's "Needs Attention" SLA count,
    // which queries unresolved SLABreach records (not the legacy isSLABreached
    // flag) on active, non-terminal, non-onboarding leads.
    if (hasUnresolvedSlaBreach === 'true') {
      where.status = 'ACTIVE';
      where.stage = { ...(where.stage ?? {}), notIn: ['HANDED_OVER', 'DESIGN_IN_PROGRESS', 'ONBOARDING'] };
      where.slaBreaches = { some: { resolvedAt: null } };
    }
    // G2: new filter params
    if (projectType) where.projectType = projectType;
    if (location) where.location = { contains: location, mode: 'insensitive' };
    if (intent) where.intentRating = parseInt(intent);
    if (intentMin || intentMax) {
      const ratingRange: { gte?: number; lte?: number } = {};
      if (intentMin && !isNaN(parseInt(intentMin))) ratingRange.gte = parseInt(intentMin);
      if (intentMax && !isNaN(parseInt(intentMax))) ratingRange.lte = parseInt(intentMax);
      if (Object.keys(ratingRange).length) where.intentRating = ratingRange;
    }
    if (dateRange) {
      const [from, to] = (dateRange as string).split(',');
      where.createdAt = { gte: new Date(from), lte: new Date(to) };
    }
    if (search) {
      // Use AND so we never overwrite an existing where.OR set by role scoping
      // (e.g. CRE has where.OR = [assignedDesignerId, createdById]).
      // Appending to AND means: (role_scope) AND (name|phone|leadId|email match).
      const searchOr = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { leadId: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { OR: searchOr }];
    }

    // ── Task #27 new pipeline filters ────────────────────────────────────────
    // pipelineMode: hide EFFECTIVE_LEAD for designer/CRE views when no explicit
    // stage filter is already applied.
    if (
      pipelineMode === '1' &&
      (user.role === 'DESIGNER' || user.role === 'CRE') &&
      !stage && !status
    ) {
      where.stage = { not: 'EFFECTIVE_LEAD' as any };
    }

    // Origin date range.
    if (originDateFrom || originDateTo) {
      const existingCat = where.createdAt ?? {};
      if (originDateFrom) (existingCat as any).gte = new Date(originDateFrom);
      if (originDateTo) {
        // include full end day
        const end = new Date(originDateTo);
        end.setHours(23, 59, 59, 999);
        (existingCat as any).lte = end;
      }
      where.createdAt = existingCat;
    }

    // Budget / estimated value range.
    if (budgetMin || budgetMax) {
      const ev: any = {};
      if (budgetMin) {
        const n = parseFloat(budgetMin);
        if (!isNaN(n)) ev.gte = n;
      }
      if (budgetMax) {
        const n = parseFloat(budgetMax);
        if (!isNaN(n)) ev.lte = n;
      }
      where.estimatedValue = ev;
    }

    // Possession / expected move-in date range.
    if (possessionDateFrom || possessionDateTo) {
      const em: any = {};
      if (possessionDateFrom) em.gte = new Date(possessionDateFrom);
      if (possessionDateTo) {
        const end = new Date(possessionDateTo);
        end.setHours(23, 59, 59, 999);
        em.lte = end;
      }
      where.expectedMoveIn = em;
    }

    // Projected OB date range — Task #83 added a dedicated expectedObDate
    // column (Founder spec item 4: PR→PP gate field, also filterable here).
    if (projectedObFrom || projectedObTo) {
      const pb: any = {};
      if (projectedObFrom) pb.gte = new Date(projectedObFrom);
      if (projectedObTo) {
        const end = new Date(projectedObTo);
        end.setHours(23, 59, 59, 999);
        pb.lte = end;
      }
      where.expectedObDate = pb;
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: LEAD_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.lead.count({ where }),
    ]);

    // Batch-fetch NPS averages and terminal pipeline transitions for this page.
    // The latter freezes Overall Pipeline Age at the first move to Design in
    // Progress (or legacy Handed Over), rather than relying on current stage.
    const leadIds = leads.map((l: any) => l.id);
    let npsAvgMap: Record<string, number | null> = {};
    const pipelineEndedAtByLead = new Map<string, Date>();
    let designerAssignedAtByLead = new Map<string, Date>();
    if (leadIds.length > 0) {
      const [npsData, stageChanges, assignmentLogs] = await Promise.all([
        prisma.nPSResponse.findMany({
          where: { leadId: { in: leadIds }, score: { not: null } },
          select: { leadId: true, score: true },
        }),
        prisma.activityLog.findMany({
          where: { leadId: { in: leadIds }, action: 'STAGE_CHANGED' },
          select: { leadId: true, createdAt: true, meta: true },
          orderBy: { createdAt: 'asc' },
        }),
        user.role === 'DESIGNER' ? prisma.activityLog.findMany({
          where: { leadId: { in: leadIds }, action: { in: ['LEAD_CREATED', 'DESIGNER_ASSIGNED'] } },
          select: { leadId: true, createdAt: true, meta: true },
          orderBy: { createdAt: 'asc' },
        }) : Promise.resolve([]),
      ]);
      designerAssignedAtByLead = designerAssignmentDates(assignmentLogs, user.id);
      const npsScores = new Map<string, number[]>();
      for (const n of npsData) {
        if (!npsScores.has(n.leadId)) npsScores.set(n.leadId, []);
        npsScores.get(n.leadId)!.push(n.score!);
      }
      for (const [lId, scores] of npsScores) {
        npsAvgMap[lId] = +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
      }
      for (const change of stageChanges) {
        if (!change.leadId) continue;
        const destination = (change.meta as { to?: unknown } | null)?.to;
        if (
          (destination === 'DESIGN_IN_PROGRESS' || destination === 'HANDED_OVER') &&
          !pipelineEndedAtByLead.has(change.leadId)
        ) {
          pipelineEndedAtByLead.set(change.leadId, change.createdAt);
        }
      }
    }

    // Augment each lead with isUnread flag — only meaningful for the assigned designer.
    // Other roles (BL, CRE, Branch Head) always receive isUnread:false so the badge
    // never appears for users who cannot clear it.
    const viewerIsDesigner = user.role === 'DESIGNER';
    // SLA breach indicators (task #56) — days stuck in current stage + status
    const slaInfoMap = await computeSlaInfoForLeads(leads);
    const leadsWithMeta = leads.map((l: any) => ({
      ...l,
      avgNps: npsAvgMap[l.id] ?? null,
      isUnread: viewerIsDesigner && l.assignedDesignerId === user.id && !l.firstOpenedAt,
      overallPipelineAgeDays: calculateOverallPipelineAgeDays(
        l.leadOriginDate,
        pipelineEndedAtByLead.get(l.id),
      ),
      designerAssignmentAgeDays: viewerIsDesigner
        && (l.assignedDesignerId === user.id || l.assignedDesignerId == null)
        ? designerAssignmentAgeDays(designerAssignedAtByLead.get(l.id), pipelineEndedAtByLead.get(l.id))
        : null,
      daysInCurrentStage: slaInfoMap[l.id]?.daysInCurrentStage ?? 0,
      slaStatus: slaInfoMap[l.id]?.slaStatus ?? 'ok',
      // Task #14: a lead in ONBOARDING is only "breached" per the new
      // stage-SLA system (slaStatus, above) — never via a legacy flag left
      // over from an earlier stage's rule.
      isSLABreached: l.stage === 'ONBOARDING' ? false : l.isSLABreached,
    }));

    res.json({ leads: leadsWithMeta, total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) });
  } catch (err: any) {
    console.error('[leads:list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/meta/status-summary — counts + value by status (task #88) ──
// Overall and per-stage breakdown, scoped by the same role rules as the list
// endpoint, so dashboards/lists can show "12 Active / 3 On Hold / 1 Inactive"
// (and per-stage) without pulling every lead down to the client to tally.
leadsRouter.get('/meta/status-summary', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const where: any = {};
    if (user.role === 'DESIGNER') {
      where.assignedDesignerId = user.id;
    } else if (user.role === 'CRE') {
      // CRE Stage 1: mirror leadScope.ts — include both new and legacy fields.
      where.OR = [{ assignedCREId: user.id }, { assignedDesignerId: user.id }, { createdById: user.id }];
    } else if (user.role === 'BL') {
      const members = await prisma.user.findMany({ where: { blId: user.id, isActive: true }, select: { id: true } });
      where.AND = [{ OR: [{ assignedDesignerId: { in: [user.id, ...members.map((m) => m.id)] } }, { assignedBLId: user.id }] }];
    }

    const groups = await prisma.lead.groupBy({
      by: ['status', 'stage'],
      where,
      _count: { id: true },
      _sum: { estimatedValue: true },
    });

    const overall: Record<string, { count: number; value: number }> = {
      ACTIVE: { count: 0, value: 0 }, ON_HOLD: { count: 0, value: 0 }, INACTIVE: { count: 0, value: 0 },
    };
    const perStage: Record<string, Record<string, { count: number; value: number }>> = {};

    for (const g of groups) {
      const count = g._count.id;
      const value = g._sum.estimatedValue ? Number(g._sum.estimatedValue) : 0;
      overall[g.status].count += count;
      overall[g.status].value += value;
      if (!perStage[g.stage]) {
        perStage[g.stage] = { ACTIVE: { count: 0, value: 0 }, ON_HOLD: { count: 0, value: 0 }, INACTIVE: { count: 0, value: 0 } };
      }
      perStage[g.stage][g.status] = { count, value };
    }

    res.json({ overall, perStage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/meta/unopened-count ───────────────────────────────────────
// A lead is "new" for the assigned designer until that designer first opens
// its detail page. Other roles cannot clear this state, so they do not receive
// a sidebar count.
leadsRouter.get('/meta/unopened-count', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    if (user.role !== 'DESIGNER') {
      res.json({ count: 0 });
      return;
    }

    const count = await prisma.lead.count({
      where: {
        assignedDesignerId: user.id,
        status: 'ACTIVE',
        firstOpenedAt: null,
      },
    });
    res.json({ count });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/leads — create lead ─────────────────────────────────────────────
leadsRouter.post('/', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const {
      name, phone, phone2, email, source, adName,
      utmCampaign, utmAdSet, utmSource,
      projectType, scope, location, possessionTimeline,
      estimatedValue, intentRating,
      assignedDesignerId, assignedBLId,
      isTestLead,
    } = req.body as Record<string, string | undefined> & { isTestLead?: boolean };

    // Name, phone and source are always required; which project details are
    // too is set in Admin → CRM Settings ("Details needed for a new lead") and
    // mirrored by Layout.tsx's New Lead modal, not just enforced in the UI.
    const detailValues: Record<string, string | undefined> = { projectType, scope, location, possessionTimeline, email, estimatedValue };
    const missingDetails = (await getLeadMqlMandatoryFields()).filter((f) => !String(detailValues[f] ?? '').trim());
    if (!name?.trim() || !phone?.trim() || !source?.trim() || missingDetails.length) {
      const missing = [!name?.trim() && 'name', !phone?.trim() && 'phone', !source?.trim() && 'source', ...missingDetails].filter(Boolean);
      res.status(400).json({ error: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required` });
      return;
    }
    if (!isValidPhoneStrict(phone)) {
      res.status(400).json({ error: phone.trim().startsWith('+') ? 'phone: invalid number for the selected country' : 'phone: must be 7–15 digits' });
      return;
    }
    if (email?.trim() && !isValidEmail(email)) {
      res.status(400).json({ error: 'email: invalid format' });
      return;
    }
    if (phone2?.trim() && !isValidPhoneStrict(phone2)) {
      res.status(400).json({ error: phone2.trim().startsWith('+') ? 'phone2: invalid number for the selected country' : 'phone2: must be 7–15 digits' });
      return;
    }
    if (typeof isTestLead !== 'undefined' && typeof isTestLead !== 'boolean') {
      res.status(400).json({ error: 'isTestLead must be a boolean' });
      return;
    }
    if (isTestLead === true && !['CRE', 'BRANCH_HEAD'].includes(user.role)) {
      res.status(403).json({ error: 'Only CRE and Branch Head users can mark a lead as a test lead' });
      return;
    }

    // Check duplicate phone
    const existing = await prisma.lead.findFirst({ where: { phone } });
    if (existing) {
      res.status(409).json({ isDuplicate: true, error: 'A lead with this phone number already exists', existingLeadId: existing.leadId });
      return;
    }

    // Check duplicate email
    if (email?.trim()) {
      const emailExisting = await prisma.lead.findFirst({ where: { email: email.trim() } });
      if (emailExisting) {
        res.status(409).json({ isDuplicate: true, error: 'A lead with this email already exists', existingLeadId: emailExisting.leadId });
        return;
      }
    }

    const leadId = await generateLeadId();

    // CRE-created leads start qualified at MQL, so allocate their BL from the
    // same active round-robin pool used on EL → MQL (not the CRE's own team).
    // Preserve explicit/team-based assignment behavior for other roles.
    let resolvedBLId = user.role === 'CRE'
      ? (await selectBLForLead())?.id
      : assignedBLId || (user.role === 'BL' ? user.id : (user.role === 'DESIGNER' ? user.blId ?? undefined : undefined));
    if (!resolvedBLId && user.role === 'DESIGNER') {
      const bl = await selectBLForLead();
      if (bl) resolvedBLId = bl.id;
    }

    const lead = await prisma.lead.create({
      data: {
        leadId,
        name: name.trim(),
        phone: phone.trim(),
        phone2: phone2?.trim() || undefined,
        email: email?.trim() || undefined,
        source: source?.trim() || undefined,
        adName: adName?.trim() || undefined,
        utmCampaign: utmCampaign?.trim() || undefined,
        utmAdSet: utmAdSet?.trim() || undefined,
        utmSource: utmSource?.trim() || undefined,
        projectType: projectType?.trim() || undefined,
        scope: scope?.trim() || undefined,
        location: location?.trim() || undefined,
        possessionTimeline: possessionTimeline?.trim() || undefined,
        estimatedValue: estimatedValue ? parseFloat(estimatedValue) : undefined,
        intentRating: intentRating ? parseInt(intentRating) : undefined,
        isTestLead: isTestLead === true,
        // Auto-assign to creator based on role
        assignedDesignerId: assignedDesignerId || (
          user.role === 'CRE' ? (resolvedBLId ? undefined : user.id) :
          user.role === 'DESIGNER' ? user.id : undefined
        ),
        ...(user.role === 'CRE' && { assignedCREId: user.id }),
        assignedBLId: resolvedBLId,
        createdById: user.id,
        stage: 'MQL',
        leadOriginDate: new Date(),
      },
      include: LEAD_INCLUDE,
    });

    await logActivity(user.id, 'LEAD_CREATED', lead.id, { leadId, source });
    if (user.role === 'CRE' && resolvedBLId) {
      await prisma.user.update({
        where: { id: resolvedBLId },
        data: { totalLeadsAssigned: { increment: 1 } },
      });
      await createNotification(resolvedBLId, 'BL_ASSIGNED', `You have been assigned as BL for lead ${leadId} — ${lead.name}`, lead.id);
      await logActivity(user.id, 'BL_ASSIGNED', lead.id, { blId: resolvedBLId });
    }

    res.status(201).json({ lead });
  } catch (err: any) {
    console.error('[leads:create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/leads/manual — create lead manually (CRE / BL / BRANCH_HEAD) ────
// projectType/scope/location are intentionally NOT required here — this route
// is for fast walk-in/referral capture where those details aren't known yet
// and get filled in later, unlike the primary `/leads` create form which
// collects them upfront. Phone/email format is still enforced below.
leadsRouter.post(
  '/manual',
  verifyToken,
  requirePermission('LEAD_CREATE_MANUAL'),
  async (req, res) => {
    try {
      const user = req.user!;
      const { name, phone, phone2, email, source, designerId, projectType, scope, location, possessionTimeline } = req.body as {
        name?: string;
        phone?: string;
        phone2?: string;
        email?: string;
        source?: string;
        designerId?: string;
        projectType?: string;
        scope?: string;
        location?: string;
        possessionTimeline?: string;
      };

      if (!name?.trim()) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      if (!phone?.trim()) {
        res.status(400).json({ error: 'phone is required' });
        return;
      }
      if (!isValidPhoneStrict(phone)) {
        res.status(400).json({ error: phone.trim().startsWith('+') ? 'phone: invalid number for the selected country' : 'phone: must be 7–15 digits' });
        return;
      }
      if (phone2?.trim() && !isValidPhoneStrict(phone2)) {
        res.status(400).json({ error: phone2.trim().startsWith('+') ? 'phone2: invalid number for the selected country' : 'phone2: must be 7–15 digits' });
        return;
      }
      if (email?.trim() && !isValidEmail(email)) {
        res.status(400).json({ error: 'email: invalid format' });
        return;
      }

      const ALLOWED_SOURCES = ['Walk-in', 'Referral', 'Manual'] as const;
      if (!source || !(ALLOWED_SOURCES as readonly string[]).includes(source)) {
        res.status(400).json({ error: `source must be one of: ${ALLOWED_SOURCES.join(' | ')}` });
        return;
      }
      if (!possessionTimeline?.trim()) {
        res.status(400).json({ error: 'possessionTimeline is required' });
        return;
      }

      // Duplicate check — phone
      const phoneMatch = await prisma.lead.findFirst({ where: { phone: phone.trim() } });
      if (phoneMatch) {
        res.status(409).json({
          isDuplicate: true,
          error: 'A lead with this phone number already exists',
          existingLeadId: phoneMatch.leadId,
          warning: `Phone ${phone.trim()} is already registered as lead ${phoneMatch.leadId}`,
        });
        return;
      }

      // Duplicate check — email (if provided)
      if (email?.trim()) {
        const emailMatch = await prisma.lead.findFirst({ where: { email: email.trim() } });
        if (emailMatch) {
          res.status(409).json({
            isDuplicate: true,
            error: 'A lead with this email already exists',
            existingLeadId: emailMatch.leadId,
            warning: `Email ${email.trim()} is already registered as lead ${emailMatch.leadId}`,
          });
          return;
        }
      }

      // This capture form can create either a qualified MQL lead or an
      // incomplete EL lead; only the qualified one should go to a BL.
      const initialStage = (await hasAllMqlMandatoryFields({ projectType, scope, location, possessionTimeline, email }))
        ? 'MQL'
        : 'EFFECTIVE_LEAD';

      // Assignment logic
      let assignedDesignerId: string | undefined;
      let assignedBLId: string | undefined;

      if (user.role === 'CRE') {
        if (initialStage === 'MQL') {
          const bl = await selectBLForLead();
          if (bl) assignedBLId = bl.id;
        }
        // While unassigned, the CRE still occupies the legacy designer slot;
        // once assigned to a BL, that slot is free for a real designer.
        if (!assignedBLId) assignedDesignerId = user.id;
      } else if (user.role === 'BL') {
        assignedBLId = user.id;
        if (designerId) {
          const designer = await prisma.user.findUnique({
            where: { id: designerId },
            select: { id: true, blId: true },
          });
          if (!designer) { res.status(404).json({ error: 'Designer not found' }); return; }
          if (designer.blId !== user.id) {
            res.status(403).json({ error: 'Designer is not on your team' });
            return;
          }
          assignedDesignerId = designerId;
        }
      } else if (user.role === 'BRANCH_HEAD' && designerId) {
        const designer = await prisma.user.findUnique({
          where: { id: designerId },
          select: { id: true, blId: true },
        });
        if (!designer) { res.status(404).json({ error: 'Designer not found' }); return; }
        assignedDesignerId = designerId;
        if (designer.blId) assignedBLId = designer.blId;
      }

      const leadId = await generateLeadId();

      // This route intentionally never required projectType/scope/location/
      // possessionTimeline (fast walk-in/referral capture — those details get
      // filled in later). Those are exactly the fields the primary `/leads`
      // create form requires before a lead is allowed into MQL, so a lead
      // still missing them here must land at EFFECTIVE_LEAD (pre-MQL)
      // instead, and only qualify into MQL once someone fills them in — this
      // reuses the same mandatory list rather than a new one (see
      // leadMandatoryFields.ts). Only qualified MQL leads get an automatic BL.
      const lead = await prisma.lead.create({
        data: {
          leadId,
          name: name.trim(),
          phone: phone.trim(),
          ...(phone2?.trim() && { phone2: phone2.trim() }),
          ...(email?.trim() && { email: email.trim() }),
          source,
          ...(projectType?.trim() && { projectType: projectType.trim() }),
          ...(scope?.trim() && { scope: scope.trim() }),
          ...(location?.trim() && { location: location.trim() }),
          ...(possessionTimeline?.trim() && { possessionTimeline: possessionTimeline.trim() }),
          stage: initialStage,
          assignmentPath: 'DIRECT',
          createdById: user.id,
          leadOriginDate: new Date(),
          ...(assignedDesignerId && { assignedDesignerId }),
          // CRE Stage 1: lock in the CRE owner permanently so post-MQL
          // designer assignment doesn't erase the CRE from the record.
          ...(user.role === 'CRE' && { assignedCREId: user.id }),
          ...(assignedBLId && { assignedBLId }),
        },
        include: LEAD_INCLUDE,
      });

      await logActivity(user.id, 'LEAD_CREATED_MANUAL', lead.id, {
        leadId,
        source,
        createdByRole: user.role,
        ...(assignedDesignerId && { assignedDesignerId }),
      });
      if (user.role === 'CRE' && assignedBLId) {
        await prisma.user.update({
          where: { id: assignedBLId },
          data: { totalLeadsAssigned: { increment: 1 } },
        });
        await createNotification(assignedBLId, 'BL_ASSIGNED', `You have been assigned as BL for lead ${leadId} — ${lead.name}`, lead.id);
        await logActivity(user.id, 'BL_ASSIGNED', lead.id, { blId: assignedBLId });
      }

      res.status(201).json({ lead });
    } catch (err: any) {
      console.error('[leads:manual]', err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// ── GET /api/leads/meta/designers — designers filterable in this user's scope ─
leadsRouter.get('/meta/designers', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    let where: any = { role: 'DESIGNER', isActive: true };
    if (user.role === 'BL') {
      where = { role: 'DESIGNER', isActive: true, blId: user.id };
    } else if (user.role === 'DESIGNER') {
      where = { role: 'DESIGNER', isActive: true, id: user.id };
    }
    const designers = await prisma.user.findMany({ where, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    res.json({ designers });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load designers' });
  }
});

// ── GET /api/leads/meta/allocated-users — active Designers and BLs ───────────
leadsRouter.get('/meta/allocated-users', verifyToken, async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { role: { in: ['DESIGNER', 'BL'] }, isActive: true },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
    res.json({ users });
  } catch {
    res.status(500).json({ error: 'Failed to load lead allocation options' });
  }
});

// ── GET /api/leads/meta/team-members — active members in the logged-in BL's cohort ─
// Kept separate from /meta/designers because that endpoint is also used by
// designer-assignment controls, where CRE users must not appear.
leadsRouter.get('/meta/team-members', verifyToken, requireRole('BL'), async (req, res) => {
  try {
    const members = await prisma.user.findMany({
      where: {
        blId: req.user!.id,
        isActive: true,
        role: { in: ['DESIGNER', 'CRE'] },
      },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
    res.json({ members });
  } catch {
    res.status(500).json({ error: 'Failed to load team members' });
  }
});

// ── GET /api/leads/meta/bls — list active BLs for the CRE allocation dropdown ─
// CRE Stage 2: populated by the "Allocate to BL" form so CRE can pick a
// specific BL after moving a lead to MQL, instead of auto round-robin.
leadsRouter.get('/meta/bls', verifyToken, async (req, res) => {
  try {
    const bls = await prisma.user.findMany({
      where: { role: 'BL', isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json({ bls });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load BL list' });
  }
});

// ── GET /api/leads/export — download filtered leads as CSV (or, with
// ?format=xlsx, Excel — task #90 made the Excel option admin-only) ───────────
leadsRouter.get('/export', verifyToken, async (req, res) => {
  try {
    const {
      stage, source, designerId, blId, allocatedToId, search,
      projectType, location, dateRange, intent,
      status, format,
      originDateFrom, originDateTo,
      budgetMin, budgetMax,
      possessionDateFrom, possessionDateTo,
      projectedObFrom, projectedObTo,
    } = req.query as Record<string, string>;

    const user = req.user!;

    // Excel export is admin-only (task #90); CSV keeps its existing scoped access.
    if (format === 'xlsx' && user.role !== 'BRANCH_HEAD') {
      res.status(403).json({ error: 'Excel export is only available to Branch Head admins' });
      return;
    }

    const where: any = {};

    // Export must use the same role scope as the paginated list, including CRE.
    const roleWhere = await buildLeadRoleWhere(user, prisma);
    if (Object.keys(roleWhere).length > 0) where.AND = [roleWhere];

    if (stage) where.stage = stage;
    if (status) where.status = status;
    if (source) where.AND = [...(Array.isArray(where.AND) ? where.AND : []), await sourceWhere(source)];
    if (designerId) {
      // A team member may own the lead as Designer or as CRE (assignedCREId).
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        { OR: [{ assignedDesignerId: designerId }, { assignedCREId: designerId }] },
      ];
    }
    if (blId) where.assignedBLId = blId;
    if (allocatedToId) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        { OR: [{ assignedDesignerId: allocatedToId }, { assignedBLId: allocatedToId }] },
      ];
    }
    if (projectType) where.projectType = projectType;
    if (location) where.location = { contains: location, mode: 'insensitive' };
    if (search) {
      // Same AND-wrap as the list handler — never overwrite role-scope OR clauses.
      const searchOr = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { email: { contains: search, mode: 'insensitive' } },
        { leadId: { contains: search, mode: 'insensitive' } },
      ];
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { OR: searchOr }];
    }
    if (intent) {
      const intentVal = parseInt(intent);
      if (!isNaN(intentVal)) where.intentRating = intentVal;
    }
    if (dateRange) {
      const now = new Date();
      if (dateRange === '7d') where.createdAt = { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
      else if (dateRange === '30d') where.createdAt = { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) };
      else if (dateRange === 'thisMonth') {
        where.createdAt = { gte: new Date(now.getFullYear(), now.getMonth(), 1) };
      }
    }
    if (originDateFrom || originDateTo) {
      const createdAt: any = {};
      if (originDateFrom) createdAt.gte = new Date(originDateFrom);
      if (originDateTo) {
        const end = new Date(originDateTo);
        end.setHours(23, 59, 59, 999);
        createdAt.lte = end;
      }
      where.createdAt = createdAt;
    }
    if (budgetMin || budgetMax) {
      const estimatedValue: any = {};
      const min = budgetMin ? parseFloat(budgetMin) : NaN;
      const max = budgetMax ? parseFloat(budgetMax) : NaN;
      if (!isNaN(min)) estimatedValue.gte = min;
      if (!isNaN(max)) estimatedValue.lte = max;
      where.estimatedValue = estimatedValue;
    }
    if (possessionDateFrom || possessionDateTo) {
      const expectedMoveIn: any = {};
      if (possessionDateFrom) expectedMoveIn.gte = new Date(possessionDateFrom);
      if (possessionDateTo) {
        const end = new Date(possessionDateTo);
        end.setHours(23, 59, 59, 999);
        expectedMoveIn.lte = end;
      }
      where.expectedMoveIn = expectedMoveIn;
    }
    if (projectedObFrom || projectedObTo) {
      const expectedObDate: any = {};
      if (projectedObFrom) expectedObDate.gte = new Date(projectedObFrom);
      if (projectedObTo) {
        const end = new Date(projectedObTo);
        end.setHours(23, 59, 59, 999);
        expectedObDate.lte = end;
      }
      where.expectedObDate = expectedObDate;
    }

    const leads = await prisma.lead.findMany({
      where,
      include: {
        assignedDesigner: { select: { name: true } },
        assignedBL: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const columns = ['Lead ID', 'Name', 'Phone', 'Email', 'Stage', 'Source', 'Estimated Value', 'Intent Rating', 'Designer', 'BL', 'Created At'];
    const dataRows = leads.map((l: any) => [
      l.leadId,
      l.name ?? '',
      l.phone ?? '',
      l.email ?? '',
      l.stage,
      l.source ?? '',
      l.estimatedValue ?? '',
      l.intentRating ?? '',
      l.assignedDesigner?.name ?? '',
      l.assignedBL?.name ?? '',
      l.createdAt.toISOString(),
    ]);

    if (format === 'xlsx') {
      const ExcelJS = (await import('exceljs')).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Leads');
      sheet.addRow(columns).font = { bold: true };
      dataRows.forEach((row) => sheet.addRow(row));
      sheet.columns.forEach((col) => { col.width = 18; });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="leads_export_${new Date().toISOString().slice(0, 10)}.xlsx"`);
      await workbook.xlsx.write(res);
      res.end();
      return;
    }

    const header = columns.join(',') + '\n';
    const csv = header + dataRows.map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="leads_export_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err: any) {
    console.error('[leads:export]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/:id — get lead detail ──────────────────────────────────────
leadsRouter.get('/:id', verifyToken, async (req, res) => {
  try {
    const viewer = req.user!;
    if (!(await userCanAccessLead(viewer, req.params.id, prisma))) {
      res.status(403).json({ error: 'You do not have access to this lead' });
      return;
    }
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: {
        ...LEAD_INCLUDE,
        contacts: true,
        currentOffer: true,
        discountRequests: {
          include: {
            requestedBy: { select: { id: true, name: true } },
            reviewedBy: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        slaBreaches: { where: { resolvedAt: null } },
        leadOffers: { include: { offer: { select: { id: true, name: true } } }, orderBy: { appliedAt: 'desc' } },
        emailLogs: { orderBy: { sentAt: 'desc' }, take: 50 },
        smsLogs: { orderBy: { createdAt: 'desc' }, take: 50 },
        project: { select: { id: true, projectCode: true } },
        // ppMeetings removed — field not in live DB schema (schema drift); client already guards with ppMeetings?.length
      },
    });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }

    // Track first open by the assigned designer (fire-and-forget)
    if (
      viewer.role === 'DESIGNER' &&
      lead.assignedDesignerId === viewer.id &&
      !lead.firstOpenedAt
    ) {
      await prisma.lead.update({ where: { id: req.params.id }, data: { firstOpenedAt: new Date() } });
    }

    // NPS + activity breakdown — run in parallel for speed.
    const leadId = req.params.id;
    const [npsRows, callGroups, meetingGroups, taskBreakdown, waBreakdown, slaInfo] = await Promise.all([
      prisma.nPSResponse.findMany({
        where: { leadId },
        select: { stage: true, score: true, sentAt: true, respondedAt: true },
        orderBy: { sentAt: 'asc' },
      }),
      prisma.call.groupBy({ by: ['outcome'], where: { leadId }, _count: { _all: true } }),
      prisma.meeting.groupBy({ by: ['status'], where: { leadId }, _count: { _all: true } }),
      Promise.all([
        // pending (not overdue)
        prisma.followUpTask.count({ where: { leadId, isCompleted: false, status: 'PENDING', isOverdue: false } }),
        // overdue
        prisma.followUpTask.count({ where: { leadId, isCompleted: false, status: 'PENDING', isOverdue: true } }),
        // completed
        prisma.followUpTask.count({ where: { leadId, isCompleted: true } }),
        // total
        prisma.followUpTask.count({ where: { leadId } }),
      ]),
      Promise.all([
        prisma.whatsAppMessage.count({ where: { leadId, direction: 'OUTBOUND' } }),
        prisma.whatsAppMessage.count({ where: { leadId, direction: 'INBOUND', isRead: false } }),
        prisma.whatsAppMessage.count({ where: { leadId } }),
      ]),
      computeSlaInfoForLead(lead),
    ]);

    // NPS aggregation
    const respondedNps = npsRows.filter((r) => r.score !== null);
    const avgNps = respondedNps.length > 0
      ? +(respondedNps.reduce((acc, r) => acc + r.score!, 0) / respondedNps.length).toFixed(1)
      : null;
    const npsPerStage = npsRows.reduce((acc, r) => ({ ...acc, [r.stage]: r }), {} as Record<string, typeof npsRows[0]>);

    // Activity breakdown
    const calls = { answered: 0, rnr: 0, callback: 0, meetingScheduled: 0, total: 0 };
    for (const g of callGroups) {
      calls.total += g._count._all;
      if (g.outcome === 'ANSWERED')           calls.answered         += g._count._all;
      else if (g.outcome === 'CALLBACK')      calls.callback         += g._count._all;
      else if (g.outcome === 'MEETING_SCHEDULED') calls.meetingScheduled += g._count._all;
      else                                    calls.rnr              += g._count._all; // all RNR_* buckets
    }
    const meetings = { scheduled: 0, completed: 0, noShow: 0, rescheduled: 0, total: 0 };
    for (const g of meetingGroups) {
      meetings.total += g._count._all;
      if (g.status === 'SCHEDULED')        meetings.scheduled  += g._count._all;
      else if (g.status === 'COMPLETED')   meetings.completed  += g._count._all;
      else if (g.status === 'NO_SHOW')     meetings.noShow     += g._count._all;
      else if (g.status === 'RESCHEDULED') meetings.rescheduled += g._count._all;
    }
    const [taskPending, taskOverdue, taskCompleted, taskTotal] = taskBreakdown;
    const [waOutbound, waInboundUnread, waTotal] = waBreakdown;
    const _breakdown = {
      calls,
      meetings,
      tasks: { pending: taskPending, overdue: taskOverdue, completed: taskCompleted, total: taskTotal },
      whatsapp: { outbound: waOutbound, inboundUnread: waInboundUnread, total: waTotal },
    };

    // Task #14: suppress the legacy breach flag in ONBOARDING
    const isSLABreached = lead.stage === 'ONBOARDING' ? false : lead.isSLABreached;

    res.json({ lead: { ...lead, _breakdown, ...slaInfo, isSLABreached }, avgNps, npsPerStage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/leads/:id — update lead ───────────────────────────────────────
leadsRouter.patch('/:id', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const {
      name, phone, phone2, email, source,
      stage, projectType, scope, location,
      estimatedValue, intentRating, possessionTimeline,
      nextMeetingDate, floorPlanUrl,
      assignedDesignerId, assignedBLId,
      customFields,
      // Task #20 — new key-facts fields
      builder, offer1, offer2, offer3, expectedMoveIn,
      email2, pan, gst, notes,
      // Task #83 — Expected OB date (PR→PP gate field, also filterable)
      expectedObDate,
      // Task #133 — clearing the "Offer proposed" selection back to "No
      // offer". Setting a real offer must go through the dedicated
      // POST /leads/:leadId/offer endpoint (keeps the LeadOffer audit trail
      // and OFFER_APPLIED activity log in sync) — this PATCH only accepts a
      // falsy value here, to explicitly clear the link.
      currentOfferId,
      // Gates the automatic sign-off NPS survey email fired when a lead
      // reaches DESIGN_IN_PROGRESS/HANDED_OVER — mandatory checkbox on the
      // stage-move form. Defaults to true for callers that predate it.
      sendNpsSurvey,
      // Emergency override (Admin → Permissions → "Push a stuck lead forward"):
      // a written reason that lets a blocked stage move go ahead anyway.
      overrideReason,
    } = req.body as Record<string, any>;

    // Batch 12c Round 3b — the automatic sign-off NPS survey (fired below on
    // DESIGN_IN_PROGRESS/HANDED_OVER) is now a draft, not an auto-send; this
    // carries the pending-mail descriptor out to the response.
    let stageNpsPendingMail: Awaited<ReturnType<typeof createAndSendNps>> = null;
    // Lenient launch: gate items that were missing when the move was allowed.
    let gateWarnings: string[] = [];
    // Set when a blocked move went ahead on an emergency override.
    let gateOverride: { reason: string; missing: string[] } | null = null;
    // Fix D — PROPOSAL_READY email draft (auto-created, no attachment).
    let stageProposalPendingMail: { draftKey: string; type: string; to: string; subject: string; html: string } | null = null;

    // ── Format validation ─────────────────────────────────────────────────────
    if (email !== undefined && email?.trim() && !isValidEmail(email)) {
      res.status(400).json({ error: 'email: invalid format' });
      return;
    }
    if (email2 !== undefined && email2?.trim() && !isValidEmail(email2)) {
      res.status(400).json({ error: 'email2: invalid format' });
      return;
    }
    if (phone !== undefined && phone?.trim() && !isValidPhoneStrict(phone)) {
      res.status(400).json({ error: phone.trim().startsWith('+') ? 'phone: invalid number for the selected country' : 'phone: must be 7–15 digits' });
      return;
    }
    if (phone2 !== undefined && phone2?.trim() && !isValidPhoneStrict(phone2)) {
      res.status(400).json({ error: phone2.trim().startsWith('+') ? 'phone2: invalid number for the selected country' : 'phone2: must be 7–15 digits' });
      return;
    }
    // If possessionTimeline is explicitly included in the request body but
    // blank, reject — the field is required when a user actively edits it.
    // Omitting it entirely (legacy leads that predate this rule) remains fine.
    if (possessionTimeline !== undefined && !possessionTimeline?.trim()) {
      res.status(400).json({ error: 'possessionTimeline cannot be blank — please enter a date or possession status' });
      return;
    }
    // Note: name/phone/projectType/scope/location are required on the primary
    // lead-edit UI (client-side, before submit) but are intentionally NOT
    // hard-blocked here on PATCH — leads created via CSV import or ad
    // webhooks may legitimately lack these fields, and PATCH is also used by
    // internal flows (stage moves, reassignment) that don't touch them. A
    // server-side block here would make those legacy/ingested leads
    // permanently uneditable via any endpoint other than the exact field
    // that's missing. Format validation above still applies to any value
    // that IS supplied.
    //
    // expectedMoveIn / possessionTimeline are the exception: the primary
    // lead-creation forms treat these as mandatory (Task #73), so clearing
    // them back to blank via this same PATCH must be blocked too — otherwise
    // the rule only holds at creation time and silently stops applying the
    // moment someone edits an existing lead.
    if (expectedMoveIn !== undefined && !expectedMoveIn) {
      res.status(400).json({ error: 'Expected Interior Handover Date cannot be cleared — it is a required field.' });
      return;
    }
    if (possessionTimeline !== undefined && !possessionTimeline?.trim()) {
      res.status(400).json({ error: 'Possession cannot be cleared — it is a required field.' });
      return;
    }

    if (!(await userCanAccessLead(user, id, prisma))) {
      res.status(403).json({ error: 'You do not have access to this lead' });
      return;
    }
    const existing = await prisma.lead.findUnique({
      where: { id },
      include: {
        project: { select: { contractValue: true } },
        pdObChecklist: { select: { projectValue: true } },
        quotes: {
          select: { amount: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }

    // Task #149 — an Inactive lead is fully locked from edits until it's
    // reactivated (POST /:id/reactivate). This never touches the reactivate
    // flow or PATCH /:id/status (which is how a lead gets marked Inactive in
    // the first place, and used elsewhere to move it back to On Hold).
    if (existing.status === 'INACTIVE') {
      res.status(423).json({ error: 'This lead is Inactive and locked from edits. Reactivate it first.' });
      return;
    }

    const prevStage = existing.stage;

    // Task #88: ON_HOLD/INACTIVE are no longer valid `stage` values — they're
    // tracked on the separate `status` field so the real funnel stage is
    // preserved while a lead is parked. Redirect stale callers.
    if (stage === 'ON_HOLD' || stage === 'INACTIVE') {
      res.status(400).json({ error: `Use PATCH /api/leads/:id/status to place a lead on hold or mark it inactive — ${stage} is not a valid stage.` });
      return;
    }

    // ── Stage-gate: every configured transition must satisfy its required
    //    fields/actions (single source of truth in config/stageRequirements). ─
    let blAutoAssignment: 'assigned' | 'no_eligible_bl' | undefined;
    if (stage && stage !== prevStage) {
      // Backward-move restriction: once a lead has reached DQL, it cannot be
      // moved backward along the funnel (off-funnel moves like ON_HOLD /
      // INACTIVE remain allowed).
      const fromIdx = FUNNEL_ORDER.indexOf(prevStage as any);
      const toIdx = FUNNEL_ORDER.indexOf(stage as any);
      const isBackwardFunnelMove = fromIdx !== -1 && toIdx !== -1 && toIdx < fromIdx;
      // Only MQL → EL backward move is permitted; all other backward funnel moves are blocked.
      const isMQLtoEL = prevStage === 'MQL' && stage === 'EFFECTIVE_LEAD';
      if (isBackwardFunnelMove && !isMQLtoEL) {
        res.status(400).json({
          error: `Backward stage moves are not permitted except MQL → Effective Lead. The lead cannot be moved backward from ${prevStage}.`,
        });
        return;
      }
      // Structural skip guard: only the stages the admin's stage rules mark as
      // skippable (by default DQL, Proposal Ready and PD) may be jumped over —
      // every other forward move must go one funnel step at a time, even if
      // the accumulated gate requirements happen to be met.
      // A stage switched off in CRM Settings can always be jumped over.
      const crmSettings = await getCrmSettings();
      const savedRules = await getEffectiveStageRules();
      const stageRules = { ...savedRules, skippableStages: Array.from(new Set([...savedRules.skippableStages, ...crmSettings.hiddenStages])) };
      if (!isBackwardFunnelMove && !isStageJumpAllowed(prevStage, stage, stageRules)) {
        res.status(400).json({
          error: `Cannot move directly from ${stageName(crmSettings, prevStage)} to ${stageName(crmSettings, stage)} — ${describeAllowedSkips(stageRules, (s) => stageName(crmSettings, s))}.`,
        });
        return;
      }
      // NOTE: intentRating is intentionally excluded from the prospective object.
      // The 1-star gate must evaluate the persisted DB value — not a value supplied
      // in this request — so callers cannot bypass the block by sending a non-1
      // rating alongside a stage change. Intent updates must go through the
      // dedicated PATCH /api/leads/:id/intent-rating endpoint which enforces the
      // full audit trail (reason required, intentRatingSource set, log written).
      const prospective = {
        ...existing,
        ...(estimatedValue !== undefined && {
          estimatedValue: estimatedValue === '' || estimatedValue === null ? null : parseFloat(estimatedValue),
        }),
        ...(nextMeetingDate !== undefined && { nextMeetingDate: nextMeetingDate ? new Date(nextMeetingDate) : null }),
        ...(floorPlanUrl !== undefined && { floorPlanUrl: floorPlanUrl || null }),
        // Key-facts fields (Task #20) — needed so gate can check them in the same request
        ...(builder !== undefined && { builder: builder?.trim() || null }),
        ...(scope !== undefined && { scope: scope?.trim() || null }),
        ...(projectType !== undefined && { projectType: projectType?.trim() || null }),
        ...(source !== undefined && { source: source || null }),
        ...(location !== undefined && { location: location?.trim() || null }),
        ...(expectedMoveIn !== undefined && { expectedMoveIn: expectedMoveIn ? new Date(expectedMoveIn) : null }),
        ...(expectedObDate !== undefined && { expectedObDate: expectedObDate ? new Date(expectedObDate) : null }),
      };
      // CRE Stage 1: possessionTimeline is mandatory before EL → MQL.
      // Webhook leads land at EFFECTIVE_LEAD without it (CRE fills it during
      // qualification); the creation-time gate only fires for manual creates,
      // so we re-check here for the PATCH transition path.
      if (prevStage === 'EFFECTIVE_LEAD' && stage === 'MQL') {
        const effectivePossession = possessionTimeline !== undefined
          ? possessionTimeline?.trim()
          : existing.possessionTimeline;
        if (!effectivePossession) {
          res.status(400).json({
            error: 'Cannot move to MQL — Possession Timeline is required. Please fill it in before qualifying this lead.',
          });
          return;
        }
      }
      const gate = await checkStageRequirements(prospective, prevStage, stage, stageRules);
      if (!gate.ok && gate.warnOnly) {
        // Lenient launch: the move proceeds; what was missing is returned to the
        // caller as a warning and recorded (see GATE_BYPASSED below).
        gateWarnings = gate.missing;
      } else if (!gate.ok && typeof overrideReason === 'string' && overrideReason.trim()) {
        // Emergency override: the move goes ahead despite missing items, with a
        // written reason that is recorded. Payment proof is never overridden
        // from Onboarding onward (client decision: it is what confirms a booking).
        const reasonText = overrideReason.trim();
        if (!(await hasPermission(user.role, 'STAGE_OVERRIDE'))) {
          res.status(403).json({ error: 'Your role can\'t push a lead past missing requirements. A Branch Head can change this in Admin → Permissions.' });
          return;
        }
        if (reasonText.length < 10) {
          res.status(400).json({ error: 'Write a reason of at least 10 characters for pushing this lead forward.', missing: gate.missing, details: gate.details });
          return;
        }
        if (isStrictStage(stage) && !(await prisma.leadFile.findFirst({ where: { leadId: id, fileType: 'PAYMENT_SCREENSHOT' }, select: { id: true } }))) {
          res.status(400).json({
            error: 'A payment screenshot is required from Onboarding onward and can\'t be overridden. Upload it on the Files tab first.',
            missing: gate.missing, details: gate.details, overrideBlocked: true,
          });
          return;
        }
        gateWarnings = gate.missing;
        gateOverride = { reason: reasonText.slice(0, 1000), missing: gate.missing };
      } else if (!gate.ok) {
        // `details` (with per-item `type`) rides along so callers like the
        // Pipeline board can offer an actionable fix — e.g. open the PD→OB
        // or OBM→DIP checklist inline — instead of just showing text.
        res.status(400).json({ error: `Cannot move to ${stage}`, missing: gate.missing, details: gate.details, overridable: true });
        return;
      }
    }

    // Stage-skip flags — persisted so downstream views/reports can tell this
    // lead bypassed a stage. Derived generically from FUNNEL_ORDER (rather
    // than a hardcoded list of (from,to) pairs) so any allowed skip
    // combination — e.g. MQL→Proposal Ready, which only skips DQL — sets the
    // right flag(s), not just the three combinations that used to be
    // hardcoded here.
    const skipFromIdx = FUNNEL_ORDER.indexOf(prevStage as any);
    const skipToIdx = FUNNEL_ORDER.indexOf(stage as any);
    const skippedStages = skipFromIdx !== -1 && skipToIdx !== -1 && skipToIdx > skipFromIdx
      ? FUNNEL_ORDER.slice(skipFromIdx + 1, skipToIdx)
      : [];
    const isDqlSkip = skippedStages.includes('DQL' as any);
    const isProposalReadySkip = skippedStages.includes('PROPOSAL_READY' as any);
    const isPpToObSkip = skippedStages.includes('PROPOSAL_DISCUSSION' as any);

    const lead = await prisma.lead.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(phone && { phone }),
        ...(phone2 !== undefined && { phone2: phone2 || null }),
        ...(email !== undefined && { email: email || null }),
        ...(source && { source }),
        ...(stage && { stage: stage as any }),
        ...(isDqlSkip && { skippedDQL: true }),
        ...(isProposalReadySkip && { skippedProposalReady: true }),
        ...(isPpToObSkip && { skippedProposalDiscussion: true }),
        ...(projectType !== undefined && { projectType: projectType?.trim() || null }),
        ...(scope !== undefined && { scope: scope?.trim() || null }),
        ...(location !== undefined && { location: location?.trim() || null }),
        ...(estimatedValue !== undefined && {
          estimatedValue: estimatedValue === '' || estimatedValue === null ? null : parseFloat(estimatedValue),
        }),
        // intentRating is intentionally excluded here — all intent updates must
        // go through PATCH /api/leads/:id/intent-rating to enforce the audit
        // trail (reason required, intentRatingSource, IntentRatingLog record).
        ...(possessionTimeline !== undefined && { possessionTimeline: possessionTimeline?.trim() || null }),
        ...(nextMeetingDate !== undefined && { nextMeetingDate: nextMeetingDate ? new Date(nextMeetingDate) : null }),
        ...(floorPlanUrl !== undefined && { floorPlanUrl: floorPlanUrl || null }),
        ...(expectedObDate !== undefined && { expectedObDate: expectedObDate ? new Date(expectedObDate) : null }),
        ...(assignedDesignerId !== undefined && {
          assignedDesignerId: assignedDesignerId || null,
          // Reset firstOpenedAt when designer changes so the new assignee starts unread.
          ...(assignedDesignerId !== existing.assignedDesignerId && { firstOpenedAt: null }),
        }),
        ...(assignedBLId !== undefined && { assignedBLId: assignedBLId || null }),
        ...(customFields && {
          customFields: { ...(existing.customFields as Record<string, unknown> ?? {}), ...customFields },
        }),
        // Task #20 — new key-facts fields
        ...(builder !== undefined && { builder: builder?.trim() || null }),
        ...(offer1 !== undefined && { offer1: offer1?.trim() || null }),
        ...(offer2 !== undefined && { offer2: offer2?.trim() || null }),
        ...(offer3 !== undefined && { offer3: offer3?.trim() || null }),
        // Only allow clearing via this route; setting a real offer must go
        // through POST /leads/:leadId/offer so the audit trail stays intact.
        ...(currentOfferId !== undefined && !currentOfferId && { currentOfferId: null }),
        ...(expectedMoveIn !== undefined && { expectedMoveIn: expectedMoveIn ? new Date(expectedMoveIn) : null }),
        ...(email2 !== undefined && { email2: email2?.trim() || null }),
        ...(pan !== undefined && { pan: pan?.trim() || null }),
        ...(gst !== undefined && { gst: gst?.trim() || null }),
        ...(notes !== undefined && { notes: notes?.trim() || null }),
        // CRE Stage 1: record days at EFFECTIVE_LEAD before first MQL.
        // Only written once (null guard) — pushback + re-qualification should
        // not overwrite the original TAT so reports reflect the first-pass time.
        ...(prevStage === 'EFFECTIVE_LEAD' && stage === 'MQL' && existing.leadAgeAtMQL == null && {
          leadAgeAtMQL: Math.round(
            (Date.now() - new Date(existing.leadOriginDate ?? existing.createdAt).getTime()) / 86_400_000,
          ),
        }),
      },
      include: LEAD_INCLUDE,
    });

    // The generic lead editor is also an assignment path. Snapshot its
    // assignee ID so ageing starts at the actual assignment, not lead origin.
    if (assignedDesignerId !== undefined && (assignedDesignerId || null) !== existing.assignedDesignerId) {
      await logActivity(user.id, 'DESIGNER_ASSIGNED', id, { assignedDesignerId: assignedDesignerId || null });
    }

    // Notify BL when assigned to a lead
    const newBLId = assignedBLId !== undefined ? (assignedBLId || null) : undefined;
    if (newBLId && newBLId !== existing.assignedBLId) {
      await createNotification(
        newBLId,
        'BL_ASSIGNED',
        `You have been assigned as BL for lead ${existing.leadId} — ${existing.name}`,
        id,
      );
      await logActivity(user.id, 'BL_ASSIGNED', id, { blId: newBLId });
    }

    if (stage && stage !== prevStage) {
      // ── MQL → EL backward move: notify designer + BL ──────────────────────
      if (prevStage === 'MQL' && stage === 'EFFECTIVE_LEAD') {
        const notifyTargets: { id: string; name: string; email: string }[] = [];
        const targetIds = [existing.assignedDesignerId, existing.assignedBLId].filter(Boolean) as string[];
        if (targetIds.length) {
          const targetUsers = await prisma.user.findMany({
            where: { id: { in: targetIds } },
            select: { id: true, name: true, email: true },
          });
          notifyTargets.push(...targetUsers);
        }
        const msg = `Lead ${existing.leadId} (${existing.name}) moved backward: MQL → Effective Lead by ${user.name}`;
        for (const t of notifyTargets) {
          await createNotification(t.id, 'STAGE_MOVED_BACKWARD', msg, id).catch(() => {});
          const emailPayload = stageMoveBackwardEmail({
            recipientName: t.name,
            leadId: existing.leadId,
            leadName: existing.name,
            fromStage: 'MQL',
            toStage: 'Effective Lead',
            movedByName: user.name,
          });
          emailPayload.to = t.email;
          if (await isAutomationOn('TEAM_STAGE_BACKWARD', 'email')) sendEmail(emailPayload).catch(() => {});
        }
      }

      // BUG-009 Part B: auto-resolve open SLA breaches when moving to a terminal
      // stage. ONBOARDING is included (task #14) because the legacy engine
      // (server/src/jobs/slaCheck.ts) has no OB→OBM rule of its own — without
      // this, a lead could carry a stale breach flag from an earlier stage
      // (e.g. MQL/PROPOSAL_READY) into OB, where only the new stage-SLA
      // system (computeStageSlaStatus, now covering ONBOARDING) should decide
      // breach status.
      if (stage === 'ONBOARDING' || stage === 'DESIGN_IN_PROGRESS' || stage === 'HANDED_OVER') {
        await prisma.sLABreach.updateMany({
          where: { leadId: id, resolvedAt: null },
          data: { resolvedAt: new Date() },
        });
        await prisma.lead.update({ where: { id }, data: { isSLABreached: false } });
      }

      // Auto-create PDOBChecklist when moving to PROPOSAL_DISCUSSION (task
      // #54) — its completion (welcome mail sent) now gates
      // PROPOSAL_DISCUSSION → ONBOARDING. Normally this transition happens
      // via the checklist's own send-welcome-mail action (see
      // routes/pdObChecklist.ts), which upserts this itself; this is a
      // safety net for leads that reach the stage some other way.
      if (stage === 'PROPOSAL_DISCUSSION') {
        await prisma.pDOBChecklist.upsert({
          where: { leadId: id },
          create: { leadId: id },
          update: {},
        });
      }

      // Auto-create OBOBMChecklist when moving to ONBOARDING (task #54) —
      // its completion (OBM mail sent) now gates ONBOARDING →
      // ONBOARDING_MEETING. Safety net; normally created by the PD→OB
      // checklist's send-welcome-mail action.
      if (stage === 'ONBOARDING') {
        await prisma.oBOBMChecklist.upsert({
          where: { leadId: id },
          create: { leadId: id },
          update: {},
        });
      }

      // Auto-create DIPChecklist when moving to ONBOARDING_MEETING (this is
      // what now gates ONBOARDING_MEETING → DESIGN_IN_PROGRESS).
      if (stage === 'ONBOARDING_MEETING') {
        await prisma.dIPChecklist.upsert({
          where: { leadId: id },
          create: { leadId: id },
          update: {},
        });
        if (existing.assignedBLId) {
          await createNotification(
            existing.assignedBLId,
            'ONBOARDING_DIP_REQUIRED',
            `Lead ${existing.leadId} reached Onboarding Meeting — complete DIP checklist to move to Design in Progress`,
            id,
          );
        }
        // NPS: onboarding survey is now owned by the OB→OBM checklist (task
        // #54) — it's a required, manually-triggered checklist item (see
        // routes/obObmChecklist.ts and POST /:id/nps-trigger) rather than an
        // automatic side effect of the stage change, so it isn't duplicated
        // here. This block still auto-creates the DIPChecklist above as a
        // safety net for any path that reaches ONBOARDING_MEETING outside
        // the checklist's own send-obm-mail transition.
      }

      // NPS: by default sent only from the Onboarding Meeting checklist (client
      // decision). Admin → Reports & NPS can make the Sales, Design Freeze or
      // Sign Off survey start when a lead reaches a stage; it is drafted for
      // review like other client mails, and at most once per lead and survey.
      const npsSurvey = await npsSurveyForStage(stage);
      if (npsSurvey && existing.email) {
        try {
          stageNpsPendingMail = await createAndSendNps(id, npsSurvey);
        } catch (e: any) {
          console.warn('[leads:nps-trigger:draft]', e.message);
        }
      }

      // Fix D — when a lead moves to PROPOSAL_READY, auto-create a plain-text
      // draft notification for the client (no attachment). The response carries
      // the pendingMail descriptor so LeadDetail's existing review-and-send flow
      // picks it up automatically.
      if (stage === 'PROPOSAL_READY' && existing.email && await isAutomationOn('PROPOSAL_READY', 'email')) {
        try {
          const { subject, html } = await renderMailTemplate('PROPOSAL_READY', {
            clientName: existing.name,
            leadRef: existing.leadId,
          });
          const draftKey = `${id}::PROPOSAL_READY::${Date.now()}`;
          await saveDraft(draftKey, subject, html, { leadId: id, type: 'PROPOSAL_READY' });
          stageProposalPendingMail = { draftKey, type: 'PROPOSAL_READY', to: existing.email, subject, html };
        } catch (e: any) {
          console.warn('[leads:proposal-ready:draft]', e.message);
        }
      }

      // G5: Allocate an active BL by round-robin when a lead qualifies into
      // MQL. Keep the past-MQL fallback for older leads that missed handoff.
      const mqlIdx = FUNNEL_ORDER.indexOf('MQL' as any);
      const stageIdx = FUNNEL_ORDER.indexOf(stage as any);
      const qualifiedPastMql = mqlIdx !== -1 && stageIdx !== -1 && stageIdx > mqlIdx;
      const creQualification = prevStage === 'EFFECTIVE_LEAD' && stage === 'MQL'
        && (user.role === 'CRE' || !!lead.assignedCREId || lead.assignedDesigner?.role === 'CRE');
      // Non-CRE EL → MQL transitions keep their prior assignment behavior.
      if ((creQualification || qualifiedPastMql || (stage === 'MQL' && prevStage !== 'EFFECTIVE_LEAD')) && !lead.assignedBLId) {
        const bl = await selectBLForLead();
        if (bl) {
          await prisma.lead.update({
            where: { id },
            data: {
              assignedBLId: bl.id,
              // The CRE is the qualifier, not the lead's post-MQL designer.
              ...(stage === 'MQL' && lead.assignedDesigner?.role === 'CRE' && {
                assignedDesignerId: null,
                assignedCREId: lead.assignedCREId ?? lead.assignedDesigner.id,
                firstOpenedAt: null,
              }),
            },
          });
          await prisma.user.update({
            where: { id: bl.id },
            data: { totalLeadsAssigned: { increment: 1 } },
          });
          blAutoAssignment = 'assigned';
          await createNotification(
            bl.id,
            'BL_ASSIGNED',
            `You have been assigned as BL for lead ${existing.leadId} — ${existing.name}`,
            id,
          );
          await logActivity(user.id, 'BL_ASSIGNED', id, { blId: bl.id });

          // Past MQL, preserve the existing recovery path that selects a
          // designer for a lead still carrying the CRE placeholder. At MQL
          // the BL chooses their designer instead.
          if (qualifiedPastMql && lead.assignedDesigner?.role === 'CRE') {
            const designer = await assignLeadToDesigner(
              lead.estimatedValue != null ? Number(lead.estimatedValue) : null,
              bl.id,
            );
            await prisma.lead.update({
              where: { id },
              data: { assignedDesignerId: designer ?? null, firstOpenedAt: null },
            });
            if (designer) {
              await incrementAssigned(designer);
              await createNotification(
                designer,
                'DESIGNER_ASSIGNED',
                `You have been assigned as designer for lead ${existing.leadId} — ${existing.name}`,
                id,
              );
            }
            await logActivity(user.id, 'DESIGNER_ASSIGNED', id, {
              designerId: designer ?? null,
              handoffFromCRE: lead.assignedDesigner.id,
            });
          }
        } else {
          blAutoAssignment = 'no_eligible_bl';
        }
      }

      // Intent rating: re-compute AND persist the visible rating on every stage
      // transition, unless the user has explicitly set a manual override.
      // Previously this block only wrote an IntentRatingLog row without ever
      // updating lead.intentRating, so the displayed star rating only changed
      // when someone edited it by hand — stage moves had no visible effect.
      // Now: if intentRatingSource !== 'manual', the stored rating is updated
      // to match the system-computed value derived from the lead's meetings.
      if (stage && stage !== prevStage) {
        try {
          const leadWithRels = await prisma.lead.findUnique({
            where: { id },
            include: {
              calls: { select: { id: true } },
              // mode + deterministic newest-first order so computeSystemRating uses the right meeting
              meetings: { select: { id: true, mode: true, status: true }, orderBy: { createdAt: 'desc' } },
            },
          });
          if (leadWithRels) {
            const systemRating = computeSystemRating(leadWithRels);
            // lead.intentRatingSource comes from the prisma.lead.update result
            // above, which returns all scalar fields, so it is current.
            const isManualOverride = lead.intentRatingSource === 'manual';
            const finalRating = isManualOverride ? (lead.intentRating ?? systemRating) : systemRating;
            const overridden = isManualOverride
              && lead.intentRating !== null && lead.intentRating !== undefined
              && lead.intentRating !== systemRating;
            await prisma.intentRatingLog.create({
              data: {
                leadId: id,
                systemRating,
                finalRating,
                overriddenById: overridden ? user.id : undefined,
                reason: overridden ? 'Manual override maintained' : undefined,
              },
            });
            // Auto-update the displayed intent rating so it reflects the
            // lead's current meeting history after every stage move.
            // Skipped only when the user has set an explicit manual override.
            if (!isManualOverride) {
              await prisma.lead.update({
                where: { id },
                data: { intentRating: systemRating, intentRatingSource: 'system' },
              });
            }
          }
        } catch (e) {
          console.warn('[leads:intentRatingLog]', (e as Error).message);
        }
      }

      // Auto-create Project when moving to DESIGN_IN_PROGRESS — this is now
      // the funnel's terminal/conversion stage (moved from the old
      // HANDED_OVER trigger; HANDED_OVER kept as a legacy trigger for old
      // data flows still using it directly).
      if (stage === 'DESIGN_IN_PROGRESS' || stage === 'HANDED_OVER') {
        try {
          const alreadyExists = await prisma.project.findUnique({ where: { leadId: id } });
          if (!alreadyExists) {
            const projCounter = await prisma.$transaction(async (tx) => {
              return tx.projectCounter.upsert({
                where: { id: 1 },
                create: { id: 1, lastNum: 1 },
                update: { lastNum: { increment: 1 } },
              });
            });
            const year = new Date().getFullYear();
            const projectCode = `P-${year}-${String(projCounter.lastNum).padStart(4, '0')}`;
            await prisma.project.create({
              data: {
                projectCode,
                leadId: id,
                designerId: lead.assignedDesignerId ?? undefined,
                contractValue: lead.estimatedValue ? Number(lead.estimatedValue) : 0,
                location: lead.location ?? undefined,
              },
            });
            await logActivity(user.id, 'PROJECT_CREATED', id, { projectCode });
          }
        } catch (e) {
          console.warn('[leads:project:create]', (e as Error).message);
        }
      }

      // Keep the commercial context attached to the transition itself. The
      // timeline must not retroactively show a later budget, intent, or
      // costing change for an earlier stage. A quote is the most specific
      // costing source, followed by the PD/OB checklist, contract value, and
      // finally the value confirmed in the stage-move form.
      const fromCommercialContext = resolveCommercialContext(existing);
      const toCommercialContext = await getCommercialContextForLead(id);

      await logActivity(user.id, 'STAGE_CHANGED', id, {
        from: prevStage,
        to: stage,
        isBackward: (() => {
          const fi = FUNNEL_ORDER.indexOf(prevStage as any);
          const ti = FUNNEL_ORDER.indexOf(stage as any);
          return fi !== -1 && ti !== -1 && ti < fi;
        })(),
        fromCommercialContext,
        toCommercialContext,
      });

      if (gateOverride) {
        await logActivity(user.id, 'GATE_OVERRIDDEN', id, { from: prevStage, to: stage, reason: gateOverride.reason, missing: gateOverride.missing });
      } else {
        await logGateBypass(user.id, id, 'STAGE_GATE', gateWarnings, { from: prevStage, to: stage });
      }
    }

    // Include the server-owned assignment in the response as well as in the
    // next GET; stage-move callers should not have to infer it from a refetch.
    const responseLead = blAutoAssignment === 'assigned'
      ? await prisma.lead.findUnique({ where: { id }, include: LEAD_INCLUDE })
      : lead;
    res.json({ lead: responseLead ?? lead, blAutoAssignment, pendingMail: stageNpsPendingMail ?? stageProposalPendingMail ?? undefined, gateWarnings: gateWarnings.length ? gateWarnings : undefined });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/leads/:id/assign-direct — BL direct designer assignment ────────
leadsRouter.patch('/:id/assign-direct', verifyToken, requirePermission('LEAD_ASSIGN_DIRECT'), async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { designerId } = req.body as { designerId?: string };

    if (!designerId) {
      res.status(400).json({ error: 'designerId is required' });
      return;
    }

    const [lead, designer] = await Promise.all([
      prisma.lead.findUnique({
        where: { id },
        select: { id: true, leadId: true, status: true, assignedDesignerId: true, assignedBLId: true },
      }),
      prisma.user.findUnique({ where: { id: designerId }, select: { id: true, name: true, blId: true, isActive: true } }),
    ]);

    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!designer) { res.status(404).json({ error: 'Designer not found' }); return; }
    if (!await isAuthorizedForLead(lead, user)) {
      res.status(403).json({ error: 'You do not have access to this lead' });
      return;
    }
    // Task #149 — Inactive leads are locked from edits, including reassignment.
    if (lead.status === 'INACTIVE') {
      res.status(423).json({ error: 'This lead is Inactive and locked from edits. Reactivate it first.' });
      return;
    }

    if (designer.isActive === false) {
      res.status(400).json({ error: 'This designer is deactivated and cannot be assigned leads' });
      return;
    }

    // Verify designer is on this BL's team
    if (designer.blId !== user.id) {
      res.status(403).json({ error: 'Designer is not on your team' });
      return;
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        assignedDesignerId: designerId,
        assignmentPath: 'DIRECT',
        firstOpenedAt: null,
      },
      include: LEAD_INCLUDE,
    });

    // Notify the assigned designer
    await createNotification(
      designerId,
      'DESIGNER_ASSIGNED',
      `You have been assigned lead ${lead.leadId} by ${user.name}`,
      id,
    );

    await logActivity(user.id, 'DIRECT_ASSIGNMENT', id, {
      designerName: designer.name,
      assignedById: user.id,
    });

    res.json({ lead: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/leads/:id/allocate-bl — manual recovery for unassigned MQL ────
// Normally the EL → MQL transition allocates a BL automatically. CRE can use
// this path for an MQL lead still awaiting a BL (e.g. none was active when it
// qualified). Clear the CRE placeholder so the BL can assign a real designer.
leadsRouter.post('/:id/allocate-bl', verifyToken, requirePermission('LEAD_ALLOCATE_BL'), async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { blId } = req.body as { blId?: string };

    if (!blId) { res.status(400).json({ error: 'blId is required' }); return; }

    const [lead, bl] = await Promise.all([
      prisma.lead.findUnique({
        where: { id },
        select: {
          id: true, leadId: true, name: true, stage: true, status: true, assignedBLId: true, assignedCREId: true,
          assignedDesigner: { select: { id: true, role: true } },
        },
      }),
      prisma.user.findUnique({ where: { id: blId }, select: { id: true, name: true, role: true, isActive: true } }),
    ]);

    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (lead.status === 'INACTIVE') {
      res.status(423).json({ error: 'Lead is Inactive and locked from edits.' }); return;
    }
    if (lead.stage !== 'MQL') {
      res.status(400).json({ error: 'BL can only be allocated when the lead is at MQL.' }); return;
    }
    if (lead.assignedBLId) {
      res.status(409).json({ error: 'A BL is already assigned. Use the reassign flow instead.' }); return;
    }
    if (!bl || bl.role !== 'BL' || !bl.isActive) {
      res.status(400).json({ error: 'Selected user is not an active BL.' }); return;
    }

    // Clear the CRE placeholder from assignedDesignerId so it's ready for
    // the BL's designer pick via PATCH /:id/assign-direct.
    const isCREInDesignerSlot = lead.assignedDesigner?.role === 'CRE';

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        assignedBLId: blId,
        ...(isCREInDesignerSlot && {
          assignedDesignerId: null,
          assignedCREId: lead.assignedCREId ?? lead.assignedDesigner!.id,
        }),
      },
      include: LEAD_INCLUDE,
    });

    await prisma.user.update({
      where: { id: blId },
      data: { totalLeadsAssigned: { increment: 1 } },
    });

    await createNotification(
      blId,
      'MQL_ALLOCATED_TO_BL',
      `Lead ${lead.leadId} (${lead.name}) allocated to you by ${user.name} — review and assign a designer`,
      id,
    );

    await logActivity(user.id, 'BL_ALLOCATED_BY_CRE', id, {
      blId, blName: bl.name, allocatedBy: user.name,
    });

    res.json({ lead: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/leads/:id/pushback-mql — BL returns an MQL lead to CRE ─────────
// CRE module Stage 2: BL rejects the lead with a mandatory reason. Lead
// reverts to EFFECTIVE_LEAD, assignedBLId is cleared, and the original CRE
// (assignedCREId) is re-parked in assignedDesignerId for legacy scope compat.
// mqlPushbackCount, mqlPushbackReason and mqlPushbackAt are updated.
leadsRouter.post('/:id/pushback-mql', verifyToken, requirePermission('LEAD_PUSHBACK_MQL'), async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { reason } = req.body as { reason?: string };

    if (!reason?.trim()) {
      res.status(400).json({ error: 'A pushback reason is required.' }); return;
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      select: {
        id: true, leadId: true, name: true, stage: true, status: true,
        assignedBLId: true, assignedCREId: true, mqlPushbackCount: true,
      },
    });

    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (lead.status === 'INACTIVE') {
      res.status(423).json({ error: 'Lead is Inactive and locked from edits.' }); return;
    }
    if (lead.stage !== 'MQL') {
      res.status(400).json({ error: 'Only MQL leads can be pushed back for re-qualification.' }); return;
    }
    if (user.role === 'BL' && lead.assignedBLId !== user.id) {
      res.status(403).json({ error: 'You are not the BL assigned to this lead.' }); return;
    }

    const fromCommercialContext = await getCommercialContextForLead(id);
    const now = new Date();
    const updated = await prisma.lead.update({
      where: { id },
      data: {
        stage: 'EFFECTIVE_LEAD' as any,
        assignedBLId: null,
        mqlPushbackReason: reason.trim(),
        mqlPushbackAt: now,
        mqlPushbackCount: { increment: 1 },
        // Re-park the original CRE in assignedDesignerId for backward-compat
        // scope — leadScope.ts already uses assignedCREId but older code paths
        // still filter by assignedDesignerId for CRE users.
        ...(lead.assignedCREId && { assignedDesignerId: lead.assignedCREId }),
      },
      include: LEAD_INCLUDE,
    });

    await logActivity(user.id, 'STAGE_CHANGED', id, {
      from: 'MQL',
      to: 'EFFECTIVE_LEAD',
      isBackward: true,
      fromCommercialContext,
      toCommercialContext: await getCommercialContextForLead(id),
    });

    if (lead.assignedCREId) {
      await createNotification(
        lead.assignedCREId,
        'MQL_PUSHED_BACK',
        `Lead ${lead.leadId} (${lead.name}) returned by ${user.name}: "${reason.trim()}" — please re-qualify before resubmitting to MQL`,
        id,
      );
    }

    await logActivity(user.id, 'MQL_PUSHED_BACK', id, {
      reason: reason.trim(),
      pushedBackBy: user.name,
      assignedCREId: lead.assignedCREId,
      pushbackCount: (lead.mqlPushbackCount ?? 0) + 1,
    });

    res.json({ lead: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/leads/:id/reactivate — reopen an ON_HOLD or INACTIVE lead ───────
// Task #40: mandatory reason (dropdown value, "Other" free-typed) + optional
// notes; always notifies the internal team, optionally emails the client.
// Auto-reactivation on the reopen date itself stays out of scope per the
// founder's direction — this is the manual flow only.
const REACTIVATION_REASONS = [
  'Client re-engaged',
  'Budget approved',
  'Timeline resumed',
  'Inactivated by Mistake',
  'Other',
];

// Admin-configurable "mandatory client notification" flags (server/src/routes/admin.ts
// GET/PUT /api/admin/notify-config), stored in the generic AssignmentConfig table.
async function isNotifyMandatory(key: 'notify_mandatory_on_hold' | 'notify_mandatory_inactive' | 'notify_mandatory_reactivate') {
  const row = await prisma.assignmentConfig.findUnique({ where: { key } });
  return row?.value === true;
}

leadsRouter.post('/:id/reactivate', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { reason, notes, notifyClient } = req.body as { reason?: string; notes?: string; notifyClient?: boolean };

    if (!reason?.trim()) {
      res.status(400).json({ error: 'A reason is required to reactivate this lead.' });
      return;
    }

    const existing = await prisma.lead.findUnique({ where: { id }, select: { email: true, phone: true } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!existing.email?.trim()) {
      res.status(400).json({ error: 'This lead has no email on file. Add a client email before reactivating.' });
      return;
    }

    // Client notification on reactivation is admin-configurable (notify_mandatory_reactivate
    // key) and falls back to the checkbox value the caller sends. Reactivate was
    // explicitly excluded from the mandatory-notify fix that hardened Mark Inactive,
    // On Hold, Book Meeting, and Meeting-from-call-log.
    const reactivateMandatory = await isNotifyMandatory('notify_mandatory_reactivate');
    const resolvedNotifyClient = reactivateMandatory ? true : !!notifyClient;

    try {
      const { lead: updated, pendingMail } = await reactivateLead({
        leadId: id,
        actorId: user.id,
        actorName: user.name,
        reason: reason.trim(),
        notes: notes?.trim(),
        notifyClient: resolvedNotifyClient,
      });
      res.json({ lead: updated, pendingMail });
    } catch (e: any) {
      if (e.message === 'Lead not found') { res.status(404).json({ error: e.message }); return; }
      res.status(400).json({ error: e.message });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/leads/:id/status — place On Hold / mark Inactive (task #88) ────
// Status is decoupled from stage: this never touches `stage`, so the lead's
// real funnel position is preserved and both show together (e.g. "DQL — On
// Hold"). Reactivation back to ACTIVE goes through POST /:id/reactivate above.
leadsRouter.patch('/:id/status', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { status, reason, notes, externalNotes, onHoldRevivalDate, notifyClient } = req.body as {
      status?: 'ON_HOLD' | 'INACTIVE'; reason?: string; notes?: string; externalNotes?: string;
      onHoldRevivalDate?: string; notifyClient?: boolean;
    };

    if (status !== 'ON_HOLD' && status !== 'INACTIVE') {
      res.status(400).json({ error: "status must be 'ON_HOLD' or 'INACTIVE'" });
      return;
    }

    const existing = await prisma.lead.findUnique({ where: { id } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (existing.status === status) {
      res.status(400).json({ error: `Lead is already ${status === 'ON_HOLD' ? 'On Hold' : 'Inactive'}.` });
      return;
    }
    // Simplification: to move a fully-inactive lead back to On Hold, reactivate
    // it first — avoids ambiguous "was it ever active again" history.
    if (existing.status === 'INACTIVE' && status === 'ON_HOLD') {
      res.status(400).json({ error: 'Reactivate this lead before placing it on hold again.' });
      return;
    }

    if (status === 'ON_HOLD') {
      if (!existing.email?.trim()) {
        res.status(400).json({ error: 'Client email is required before placing a lead on hold. Add it on the lead profile first.' });
        return;
      }
      if (!reason?.trim()) {
        res.status(400).json({ error: 'A reason is required when placing a lead on hold.' });
        return;
      }
      if (!onHoldRevivalDate) {
        res.status(400).json({ error: 'A reopen date is required when placing a lead on hold.' });
        return;
      }
      const reopenDate = new Date(onHoldRevivalDate);
      if (isNaN(reopenDate.getTime()) || reopenDate <= new Date()) {
        res.status(400).json({ error: 'The reopen date must be a future date.' });
        return;
      }
      // Client notification on hold is unconditionally mandatory —
      // no admin config flag can suppress it. (Flags checked here previously
      // were all false in production and silently allowed unnotified hold operations.)
      const { lead, pendingMail } = await putLeadOnHold({
        leadId: id, actorId: user.id, actorName: user.name, reason: reason.trim(), notes: notes?.trim(), revivalDate: reopenDate,
        externalNotes: externalNotes?.trim(),
        notifyClient: true,
      });
      res.json({ lead, pendingMail });
      return;
    }

    // status === 'INACTIVE'
    const resolvedReason = reason?.trim();
    if (!resolvedReason) {
      res.status(400).json({ error: 'A reason is required when marking a lead as inactive.' });
      return;
    }
    const inactiveMandatory = await isNotifyMandatory('notify_mandatory_inactive');
    if (inactiveMandatory && (!existing.email?.trim() || !existing.phone?.trim())) {
      res.status(400).json({ error: 'Client notifications are mandatory when marking a lead inactive, but this lead is missing an email or phone number. Add both before continuing.' });
      return;
    }
    const { lead, pendingMail } = await markLeadInactive({
      leadId: id, actorId: user.id, actorName: user.name,
      reason: resolvedReason, notes: notes?.trim(), externalNotes: externalNotes?.trim(),
      notifyClient: inactiveMandatory ? true : !!notifyClient,
    });
    res.json({ lead, pendingMail });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/:id/activity ────────────────────────────────────────────────
leadsRouter.get('/:id/activity', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, assignedDesignerId: true, assignedBLId: true },
    });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!(await isAuthorizedForLead(lead, req.user!))) {
      res.status(403).json({ error: 'Not authorised to view this lead activity' });
      return;
    }
    const activities = await prisma.activityLog.findMany({
      where: { leadId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        user: { select: { id: true, name: true, role: true } },
      },
    });
    res.json({ activities });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/leads/:id/intent-rating { rating, reason } ────────────────────
leadsRouter.patch('/:id/intent-rating', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const { rating, reason } = req.body as { rating?: number; reason?: string };

    if (!rating || rating < 1 || rating > 5) {
      res.status(400).json({ error: 'rating must be an integer from 1 to 5' });
      return;
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        calls: { select: { id: true } },
        // newest-first so computeSystemRating reliably uses the most recent meeting mode
        meetings: { select: { id: true, mode: true, status: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    // Task #149 — Inactive leads are locked from edits, including intent-rating overrides.
    if (lead.status === 'INACTIVE') {
      res.status(423).json({ error: 'This lead is Inactive and locked from edits. Reactivate it first.' });
      return;
    }

    const oldRating = lead.intentRating;
    const systemRating = computeSystemRating(lead);

    // Reason required when manually overriding the system-computed rating
    if (rating !== systemRating && !reason?.trim()) {
      res.status(400).json({ error: 'reason is required when overriding the system-computed rating' });
      return;
    }

    await prisma.lead.update({ where: { id }, data: { intentRating: rating, intentRatingSource: 'manual' } });

    const log = await prisma.intentRatingLog.create({
      data: {
        leadId: id,
        systemRating,
        finalRating: rating,
        overriddenById: rating !== systemRating ? user.id : undefined,
        reason: reason?.trim() || undefined,
      },
    });

    // Determine change direction for activity log + notifications
    const direction =
      rating > (oldRating ?? 0) ? 'increase'
      : rating < (oldRating ?? 0) ? 'decrease'
      : 'unchanged';

    await logActivity(user.id, 'INTENT_RATING_UPDATED', id, {
      rating, systemRating, reason, oldRating, direction,
    });

    // Notify designer and BL when intent rating actually changes
    if (direction !== 'unchanged') {
      const targetIds = [lead.assignedDesignerId, lead.assignedBLId].filter(Boolean) as string[];
      if (targetIds.length) {
        const targetUsers = await prisma.user.findMany({
          where: { id: { in: targetIds } },
          select: { id: true, name: true, email: true },
        });
        const notifMsg = `Lead ${lead.leadId} (${lead.name}) intent rating ${direction}d: ${oldRating ?? '—'} → ${rating} ★ (by ${user.name})`;
        for (const t of targetUsers) {
          createNotification(t.id, 'INTENT_RATING_CHANGED', notifMsg, id).catch(() => {});
          const emailPayload = intentRatingChangedEmail({
            recipientName: t.name,
            leadId: lead.leadId,
            leadName: lead.name,
            oldRating,
            newRating: rating,
            direction: direction as 'increase' | 'decrease',
            changedByName: user.name,
            reason: reason?.trim(),
          });
          emailPayload.to = t.email;
          if (await isAutomationOn('TEAM_INTENT_CHANGED', 'email')) sendEmail(emailPayload).catch(() => {});
        }
      }
    }

    res.json({ rating, systemRating, log });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/:id/stage-history — derive per-stage TAT from activity logs ─
leadsRouter.get('/:id/stage-history', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await prisma.lead.findUnique({
      where: { id },
      select: {
        id: true,
        stage: true,
        createdAt: true,
        estimatedValue: true,
        intentRating: true,
        project: { select: { contractValue: true } },
        pdObChecklist: { select: { projectValue: true } },
        quotes: {
          select: { amount: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }

    const stageLogs = await prisma.activityLog.findMany({
      where: { leadId: id, action: 'STAGE_CHANGED' },
      orderBy: { createdAt: 'asc' },
    });

    // Commercial context is captured on the transition so completed stages
    // never change when the lead's latest values are later edited.
    const currentCommercialContext: CommercialContext = resolveCommercialContext(lead);
    const history = buildStageTimelineHistory({
      leadStage: lead.stage,
      createdAt: lead.createdAt,
      stageLogs,
      currentCommercialContext,
    });

    // Task #32: attach the admin-configured SLA benchmark for every visited
    // stage so the client can colour-code TAT without duplicating thresholds.
    const thresholds = await getEffectiveStageSla();
    const historyWithBenchmark = history.map((h) => ({
      ...h,
      benchmark: thresholds[h.stage]
        ? { warningDays: thresholds[h.stage].warningDays, breachDays: thresholds[h.stage].breachDays }
        : null,
    }));

    res.json({ history: historyWithBenchmark });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/:id/intent-rating-history ──────────────────────────────────
leadsRouter.get('/:id/intent-rating-history', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const logs = await prisma.intentRatingLog.findMany({
      where: { leadId: id },
      orderBy: { createdAt: 'desc' },
      include: {
        overriddenBy: { select: { id: true, name: true, role: true } },
      },
    });
    res.json({ history: logs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/leads/:id/attention-flag — flag a lead for attention ───────────
// Mirrors projects.ts's ProjectAttentionFlag pattern, but deliberately does
// NOT apply projects.ts's `blockBLWrite` gate — BL is fully allowed here,
// using the same `isAuthorizedForLead` scope every other lead-mutation route
// already uses (ADMIN/BRANCH_HEAD any lead, DESIGNER/CRE own lead, BL own team).
leadsRouter.post('/:id/attention-flag', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { category, description } = req.body as { category?: string; description?: string };

    if (!category?.trim() || !description?.trim()) {
      res.status(400).json({ error: 'category and description are required' });
      return;
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, assignedDesignerId: true, assignedBLId: true, status: true },
    });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!(await isAuthorizedForLead(lead, user))) {
      res.status(403).json({ error: 'Not authorised to flag this lead' });
      return;
    }

    const flag = await prisma.leadAttentionFlag.create({
      data: { leadId: id, category, description },
    });

    await logActivity(user.id, 'LEAD_ATTENTION_FLAG_ADDED', id, { category, description });

    res.status(201).json({ flag });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/leads/:id/attention-flag/:flagId/resolve ──────────────────────
leadsRouter.patch('/:id/attention-flag/:flagId/resolve', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const { id, flagId } = req.params;

    const flag = await prisma.leadAttentionFlag.findUnique({ where: { id: flagId } });
    if (!flag) { res.status(404).json({ error: 'Flag not found' }); return; }
    if (flag.leadId !== id) { res.status(400).json({ error: 'Flag does not belong to this lead' }); return; }

    const lead = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, assignedDesignerId: true, assignedBLId: true, status: true },
    });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!(await isAuthorizedForLead(lead, user))) {
      res.status(403).json({ error: 'Not authorised to resolve this flag' });
      return;
    }

    const updated = await prisma.leadAttentionFlag.update({
      where: { id: flagId },
      data: { resolvedAt: new Date() },
    });

    await logActivity(user.id, 'LEAD_ATTENTION_FLAG_RESOLVED', id, { flagId });

    res.json({ flag: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/leads/:id/nps-trigger — manual NPS survey trigger (task #54) ────
// Used by the OB→OBM checklist's "Trigger NPS" button. `stage` defaults to
// 'ONBOARDING' (the milestone this checklist represents); createAndSendNps is
// idempotent per (leadId, stage) so re-clicking is harmless. Also flips the
// OB→OBM checklist's npsTriggered flag when the checklist exists.
leadsRouter.post('/:id/nps-trigger', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const { stage: npsStage } = req.body as { stage?: string };
    const resolvedStage = npsStage?.trim() || 'ONBOARDING';

    const lead = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, leadId: true, assignedDesignerId: true, assignedBLId: true, status: true },
    });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!(await isAuthorizedForLead(lead, user))) {
      res.status(403).json({ error: 'Not authorised for this lead' });
      return;
    }
    if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

    const pendingMail = await createAndSendNps(id, resolvedStage);
    const npsState = await getNpsSendState(id, resolvedStage);
    if (!pendingMail && npsState.status === 'NOT_SENT') {
      res.status(400).json({ error: 'NPS email could not be prepared. Check the client email and try again.' });
      return;
    }
    if (pendingMail) await logActivity(user.id, 'NPS_TRIGGERED', id, { stage: resolvedStage, status: 'DRAFT_PREPARED' });
    res.json({ ok: true, npsState: pendingMail ? 'DRAFT_PREPARED' : npsState.status, pendingMail: pendingMail ?? undefined });
  } catch (err: any) {
    console.error('[leads:nps-trigger]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/:id/can-advance?toStage=STAGE&fromStage=STAGE — gate pre-check ──
// `fromStage` defaults to the lead's current stage (the real, actionable transition).
// Callers (e.g. the stage-roadmap popover) may pass an explicit `fromStage` to preview
// the requirements for a *different* funnel step than the lead is currently on — it
// must be a recognised funnel stage, never arbitrary/free-text input.
leadsRouter.get('/:id/can-advance', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { toStage, fromStage } = req.query as { toStage?: string; fromStage?: string };
    if (!toStage) {
      res.status(400).json({ error: 'toStage query parameter is required' });
      return;
    }
    if (fromStage && !FUNNEL_ORDER.includes(fromStage as any)) {
      res.status(400).json({ error: 'fromStage must be a valid funnel stage' });
      return;
    }
    const lead = await prisma.lead.findUnique({ where: { id } });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    // Scope check: same policy as lead detail access
    const { isAuthorizedForLead } = await import('../lib/leadAuth.js');
    if (!(await isAuthorizedForLead(lead, req.user!))) {
      res.status(403).json({ error: 'Not authorised for this lead' });
      return;
    }
    const result = await checkStageRequirements(lead as any, fromStage ?? lead.stage, toStage);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/leads/:id/floor-plan — upload floor plan file to Supabase Storage ──
// Multer errors (LIMIT_FILE_SIZE, malformed multipart) are handled by the inner
// callback so they are always returned as JSON rather than Express's default HTML.
leadsRouter.post('/:id/floor-plan', verifyToken, (req, res, next) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (upload.single('file') as any)(req, res, (err: any) => {
    if (!err) return next();
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'File too large. Maximum size is 20 MB.'
      : (err.message ?? 'Invalid or malformed file upload.');
    res.status(status).json({ error: message });
  });
}, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    // ── Server-side MIME type allowlist ───────────────────────────────────────
    // Strategy: MIME type is the primary gate.
    //   - Standard types (PDF, images): MIME must be in the known-good set.
    //   - DWG/DXF: browsers report application/octet-stream or a few CAD-specific
    //     types for these; we accept them ONLY when the extension is also dwg/dxf
    //     so a generic binary with any other extension cannot slip through.
    //   - Anything else (text/html, application/javascript, etc.) is rejected
    //     regardless of extension, preventing disguised uploads.
    const STANDARD_MIME = new Set([
      'application/pdf',
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
    ]);
    const DWG_DXF_EXT = new Set(['dwg', 'dxf']);
    const DWG_DXF_MIME = new Set([
      'application/octet-stream',
      'image/vnd.dwg', 'image/x-dwg',
      'application/acad', 'application/x-dwg', 'application/x-autocad',
    ]);
    const ext = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    const isStandard = STANDARD_MIME.has(file.mimetype);
    const isCadFile = DWG_DXF_EXT.has(ext) && DWG_DXF_MIME.has(file.mimetype);
    if (!isStandard && !isCadFile) {
      res.status(400).json({ error: `File type not allowed. Accepted: PDF, JPG, PNG, WEBP, DWG, DXF` });
      return;
    }
    // Use only known MIME types for storage; avoid uploading supplied arbitrary MIME
    const safeMime = isStandard ? file.mimetype : 'application/octet-stream';

    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true, leadId: true, stage: true, floorPlanUrl: true, status: true } });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    // Task #149 — Inactive leads are locked from edits, including file uploads.
    if (lead.status === 'INACTIVE') {
      res.status(423).json({ error: 'This lead is Inactive and locked from edits. Reactivate it first.' });
      return;
    }

    // Files cannot be replaced once uploaded — only new files may be added.
    if (lead.floorPlanUrl) {
      res.status(405).json({ error: 'A floor plan is already attached and cannot be replaced. Use the Files tab to add a new file.' });
      return;
    }

    if (!supabaseAdmin) {
      res.status(500).json({ error: 'Floor plan storage is not configured — SUPABASE_SERVICE_ROLE_KEY is missing. Contact an admin to configure Supabase Storage.' });
      return;
    }

    const safeExt = (DWG_DXF_EXT.has(ext) || ['pdf','jpg','jpeg','png','webp'].includes(ext)) ? ext : 'pdf';
    const storagePath = `floor-plans/${lead.leadId}/${Date.now()}.${safeExt}`;

    // Ensure bucket exists (idempotent — safe to call even if it already exists
    // with the same settings; a mismatched pre-existing bucket is a one-time
    // setup problem, see scripts/setup-supabase-storage.ts).
    try {
      await supabaseAdmin.storage.createBucket('crm-files', { public: true });
    } catch {
      // Ignore "already exists" — anything else surfaces via the upload call below.
    }

    const { error: uploadError } = await supabaseAdmin.storage
      .from('crm-files')
      .upload(storagePath, file.buffer, { contentType: safeMime, upsert: true });

    if (uploadError) {
      console.error('[leads:floor-plan] Supabase Storage upload failed:', uploadError.message);
      res.status(502).json({
        error: `Could not reach floor plan storage (${uploadError.message}). Verify the "crm-files" bucket exists in Supabase Storage and try again.`,
      });
      return;
    }

    const { data: { publicUrl } } = supabaseAdmin.storage.from('crm-files').getPublicUrl(storagePath);

    // Also record it as a proper LeadFile at the lead's *current* stage so it
    // shows up in the Files tab immediately — whichever of EL/MQL/DQL the lead
    // happens to be in at upload time (task #30). `floorPlanUrl` is kept in
    // sync too for older code paths that still read it directly.
    const fileStage = (['EFFECTIVE_LEAD', 'MQL', 'DQL'] as const).includes(lead.stage as any) ? lead.stage : 'MQL';
    await prisma.$transaction([
      prisma.lead.update({ where: { id }, data: { floorPlanUrl: publicUrl } }),
      prisma.leadFile.create({
        data: {
          leadId: id,
          stage: fileStage as any,
          fileType: 'FLOOR_PLAN',
          fileName: file.originalname,
          storagePath: `crm-files:${storagePath}`,
          uploadedById: user.id,
        },
      }),
    ]);
    await logActivity(user.id, 'FLOOR_PLAN_UPLOADED', id, { url: publicUrl, fileName: file.originalname });

    res.json({ url: publicUrl });
  } catch (err: any) {
    console.error('[leads:floor-plan]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/leads/:id/notes ─────────────────────────────────────────────────
leadsRouter.post('/:id/notes', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const { note } = req.body as { note?: string };
    if (!note?.trim()) { res.status(400).json({ error: 'note is required' }); return; }
    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    // Task #149 — Inactive leads are locked from edits, including adding notes.
    if (lead.status === 'INACTIVE') {
      res.status(423).json({ error: 'This lead is Inactive and locked from edits. Reactivate it first.' });
      return;
    }
    await logActivity(user.id, 'NOTE_ADDED', id, { note: note.trim() });
    res.status(201).json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/:id/eligible-designers — active designers not already on this lead ─
// Used by TeamTab in pre-project mode (lead hasn't reached DESIGN_IN_PROGRESS yet).
leadsRouter.get('/:id/eligible-designers', verifyToken, requireRole('DESIGNER', 'BL', 'BRANCH_HEAD'), async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const lead = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, assignedDesignerId: true, assignedBLId: true, status: true },
    });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }

    // Auth: DESIGNER must be assigned to this lead; BL must own it; BH sees all
    if (user.role === 'DESIGNER' && lead.assignedDesignerId !== user.id) {
      res.status(403).json({ error: 'Not authorized for this lead' }); return;
    }
    if (user.role === 'BL' && lead.assignedBLId !== user.id) {
      res.status(403).json({ error: 'Not authorized for this lead' }); return;
    }

    // Already-excluded: the lead's own assigned designer and any project members (if project exists)
    const excludeIds = new Set<string>();
    if (lead.assignedDesignerId) excludeIds.add(lead.assignedDesignerId);

    const project = await prisma.project.findUnique({ where: { leadId: id } });
    if (project) {
      const existing = await prisma.projectTeamMember.findMany({
        where: { projectId: project.id, status: { in: ['PENDING', 'APPROVED'] } },
        select: { userId: true },
      });
      existing.forEach((m) => excludeIds.add(m.userId));
    }

    const designers = await prisma.user.findMany({
      where: { role: 'DESIGNER', isActive: true, id: { notIn: [...excludeIds] } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json({ designers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/leads/:id/request-team-member — Fix 1: lazy-create project + team request ─
// Allows a DESIGNER/BL/BH to request a team member for a lead that hasn't yet
// reached DESIGN_IN_PROGRESS (no project exists). Creates the project stub on
// demand — the DIP transition's alreadyExists guard ensures no double-creation.
leadsRouter.post('/:id/request-team-member', verifyToken, requirePermission('PROJECT_TEAM_REQUEST'), async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { userId, isPrimary } = req.body as { userId?: string; isPrimary?: boolean };

    if (!userId) { res.status(400).json({ error: 'userId is required' }); return; }

    const lead = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, leadId: true, status: true, assignedDesignerId: true, assignedBLId: true, estimatedValue: true, location: true },
    });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

    // Auth: same rules as eligible-designers
    if (user.role === 'DESIGNER' && lead.assignedDesignerId !== user.id) {
      res.status(403).json({ error: 'Not authorized for this lead' }); return;
    }
    if (user.role === 'BL' && lead.assignedBLId !== user.id) {
      res.status(403).json({ error: 'Not authorized for this lead' }); return;
    }

    // Validate target is an active DESIGNER
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, isActive: true },
    });
    if (!targetUser || !targetUser.isActive || targetUser.role !== 'DESIGNER') {
      res.status(400).json({ error: 'Target user must be an active designer' }); return;
    }
    if (targetUser.id === lead.assignedDesignerId) {
      res.status(400).json({ error: 'This user is already the assigned designer for this lead' }); return;
    }

    // Lazy-create project if it doesn't exist (same logic as DIP transition)
    let project = await prisma.project.findUnique({ where: { leadId: id } });
    if (!project) {
      const counter = await prisma.$transaction((tx) =>
        tx.projectCounter.upsert({
          where: { id: 1 },
          create: { id: 1, lastNum: 1 },
          update: { lastNum: { increment: 1 } },
        }),
      );
      const projectCode = `P-${new Date().getFullYear()}-${String(counter.lastNum).padStart(4, '0')}`;
      project = await prisma.project.create({
        data: {
          projectCode,
          leadId: id,
          designerId: lead.assignedDesignerId ?? undefined,
          contractValue: lead.estimatedValue ? Number(lead.estimatedValue) : 0,
          location: lead.location ?? undefined,
        },
      });
      await logActivity(user.id, 'PROJECT_CREATED', id, { projectCode, earlyCreate: true });
    }

    // Check for existing PENDING/APPROVED entry
    const existing = await prisma.projectTeamMember.findFirst({
      where: { projectId: project.id, userId, status: { in: ['PENDING', 'APPROVED'] } },
    });
    if (existing) {
      res.status(409).json({ error: `This user already has a ${existing.status.toLowerCase()} team-member entry on this project` });
      return;
    }

    // BL/BRANCH_HEAD additions are self-approving; DESIGNER requests stay PENDING
    const autoApprove = user.role === 'BL' || user.role === 'BRANCH_HEAD';

    const member = await prisma.$transaction(async (tx) => {
      const created = await tx.projectTeamMember.create({
        data: {
          projectId: project!.id,
          userId,
          isPrimary: !!isPrimary,
          status: autoApprove ? 'APPROVED' : 'PENDING',
          requestedById: user.id,
          ...(autoApprove ? { reviewedById: user.id, reviewedAt: new Date() } : {}),
        },
      });
      // Enforce single primary among APPROVED members (mirrors reconcilePrimary)
      if (autoApprove && isPrimary) {
        const allApproved = await tx.projectTeamMember.findMany({
          where: { projectId: project!.id, status: 'APPROVED' },
          select: { id: true, isPrimary: true },
        });
        const primaries = allApproved.filter((m) => m.isPrimary);
        if (primaries.length > 1) {
          await Promise.all(
            allApproved
              .filter((m) => m.isPrimary !== (m.id === created.id))
              .map((m) => tx.projectTeamMember.update({ where: { id: m.id }, data: { isPrimary: m.id === created.id } })),
          );
        }
      }
      return created;
    });

    await logActivity(user.id, 'PROJECT_TEAM_MEMBER_REQUESTED', id, { projectId: project.id, memberId: member.id, earlyRequest: true });
    if (autoApprove) {
      await createNotification(userId, 'TEAM_MEMBER_APPROVED', `You were added to the project team for lead ${lead.leadId}`, id);
    }

    res.status(201).json({ member: { id: member.id, status: member.status }, projectId: project.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
