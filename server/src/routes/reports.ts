import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { buildLeadRoleWhere } from '../lib/leadScope.js';

export const reportsRouter = Router();

type ReportUser = { id: string; role: string };
type Handler = (q: Record<string, string>, user: ReportUser) => Promise<unknown>;

// Active funnel only (EFFECTIVE_LEAD/HANDED_OVER are legacy-only and excluded
// from funnel-shaped reports — see .agents/memory/funnel-restructure.md).
const PIPELINE_STAGES = ['MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS'];
// "Won"/converted stages for conversion-rate and incentive-adjacent reports —
// DESIGN_IN_PROGRESS is now the trigger stage; HANDED_OVER kept for legacy leads.
const WON_STAGES = ['DESIGN_IN_PROGRESS', 'HANDED_OVER'];

// ── CSV helper ────────────────────────────────────────────────────────────────
function toCSV(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((r) =>
      headers.map((h) => {
        const v = r[h] ?? '';
        const s = String(v).replace(/"/g, '""');
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
      }).join(','),
    ),
  ];
  return lines.join('\n');
}

/** endDate as the last instant of that day in IST. A bare YYYY-MM-DD (what the Reports page sends) used to be read as
 *  00:00 UTC, which dropped almost the whole end day. Full ISO timestamps are left exactly as given. */
function endOfDayIST(v: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T23:59:59.999+05:30`) : new Date(v);
}

// ── Build date + filter where clause from query params ────────────────────────
async function buildLeadWhere(q: Record<string, string>, userRole?: string, userId?: string) {
  const where: any = { isTestLead: false };
  if (q.startDate) where.createdAt = { ...where.createdAt, gte: new Date(q.startDate) };
  if (q.endDate) where.createdAt = { ...where.createdAt, lte: endOfDayIST(q.endDate) };
  if (q.designerId) where.assignedDesignerId = q.designerId;
  if (q.blId) where.assignedBLId = q.blId;
  if (q.source) where.source = q.source;
  if (q.stage) where.stage = q.stage;
  if (q.projectType) where.projectType = q.projectType;
  if (q.location) where.location = q.location;
  // Role scope is AND-ed (own key `AND`), so no query parameter above can widen it.
  // DESIGN_MANAGER (and any other role) is intentionally left unscoped — unresolved.
  const scope = await leadScope(userRole, userId);
  if (scope) where.AND = [scope];
  return where;
}

async function leadScope(role?: string, id?: string): Promise<Record<string, unknown> | null> {
  if (role === 'DESIGNER') return { assignedDesignerId: id! };
  // BL: same scope as the dashboard (team designers OR assignedBLId) — single shared definition.
  if (role === 'BL') return buildLeadRoleWhere({ id: id!, role: 'BL' }, prisma);
  if (role === 'CRE') return { assignedCREId: id! };
  return null;
}

/** Per-person list scope for designer_performance / meeting_performance (users listed). */
function designerListWhere(user: ReportUser): Record<string, unknown> {
  const base = { role: { in: ['DESIGNER', 'CRE'] as any }, isActive: true };
  if (user.role === 'DESIGNER' || user.role === 'CRE') return { ...base, id: user.id };
  if (user.role === 'BL') return { ...base, blId: user.id };
  return base; // BRANCH_HEAD sees all; other roles unresolved (unchanged)
}

/** Per-person list scope for bl_performance. */
function blListWhere(user: ReportUser): Record<string, unknown> {
  const base = { role: 'BL' as any, isActive: true };
  if (user.role === 'BL') return { ...base, id: user.id };
  if (user.role === 'DESIGNER' || user.role === 'CRE') return { ...base, id: user.id }; // self only; they are not BLs, so the list is empty
  return base;
}

// ── Report handlers ───────────────────────────────────────────────────────────

async function leadSummary(q: Record<string, string>, user: ReportUser) {
  const where = await buildLeadWhere(q, user.role, user.id);
  const rows = await prisma.lead.groupBy({
    by: ['source'],
    where,
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  });
  return rows.map((r) => ({ source: r.source ?? 'Unknown', count: r._count.id }));
}

async function pipeline(q: Record<string, string>, user: ReportUser) {
  const where = await buildLeadWhere(q, user.role, user.id);
  const rows = await prisma.lead.groupBy({
    by: ['stage'],
    where,
    _count: { id: true },
    _avg: { daysLeadToDQL: true, daysDQLToPP: true, daysPPToOnboarding: true },
  });
  return PIPELINE_STAGES.map((s) => {
    const r = rows.find((x) => x.stage === s);
    return {
      stage: s,
      count: r?._count.id ?? 0,
      avgDaysLeadToDQL: r?._avg.daysLeadToDQL?.toFixed(1) ?? null,
      avgDaysDQLToPP: r?._avg.daysDQLToPP?.toFixed(1) ?? null,
      avgDaysPPToOnboarding: r?._avg.daysPPToOnboarding?.toFixed(1) ?? null,
    };
  });
}

async function conversion(q: Record<string, string>, user: ReportUser) {
  const where = await buildLeadWhere(q, user.role, user.id);
  const stageCounts = await prisma.lead.groupBy({ by: ['stage'], where, _count: { id: true } });
  const stageMap: Record<string, number> = {};
  for (const r of stageCounts) stageMap[r.stage] = r._count.id;
  // Total Leads Received = all leads across every pipeline stage in this filter.
  const total = PIPELINE_STAGES.reduce((a, s) => a + (stageMap[s] ?? 0), 0);
  const result = [];
  for (let i = 0; i < PIPELINE_STAGES.length - 1; i++) {
    const from = PIPELINE_STAGES[i];
    const to = PIPELINE_STAGES[i + 1];
    const fromCount = stageMap[from] ?? 0;
    const toCount = stageMap[to] ?? 0;
    // Formula: Stage % = (leads currently in destination stage ÷ Total Leads Received) × 100.
    // This matches the Dashboard's rateAt() formula so both pages show the same
    // number for the same stage and the same date filter.
    const rate = total > 0 ? +(toCount / total * 100).toFixed(1) : 0;
    result.push({ from, to, fromCount, toCount, rate });
  }
  return result;
}

async function timelinePerformance(q: Record<string, string>, user: ReportUser) {
  const where = await buildLeadWhere(q, user.role, user.id);
  const agg = await prisma.lead.aggregate({
    where,
    _avg: { daysLeadToDQL: true, daysDQLToPP: true, daysPPToOnboarding: true },
    _min: { daysLeadToDQL: true, daysDQLToPP: true, daysPPToOnboarding: true },
    _max: { daysLeadToDQL: true, daysDQLToPP: true, daysPPToOnboarding: true },
    _count: { id: true },
  });
  return [{
    metric: 'Lead → DQL',
    avg: agg._avg.daysLeadToDQL?.toFixed(1) ?? null,
    min: agg._min.daysLeadToDQL,
    max: agg._max.daysLeadToDQL,
  }, {
    metric: 'DQL → PP',
    avg: agg._avg.daysDQLToPP?.toFixed(1) ?? null,
    min: agg._min.daysDQLToPP,
    max: agg._max.daysDQLToPP,
  }, {
    metric: 'PP → Onboarding',
    avg: agg._avg.daysPPToOnboarding?.toFixed(1) ?? null,
    min: agg._min.daysPPToOnboarding,
    max: agg._max.daysPPToOnboarding,
  }];
}

async function designerPerformance(q: Record<string, string>, user: ReportUser) {
  const where = await buildLeadWhere(q, user.role, user.id);
  const designers = await prisma.user.findMany({
    where: designerListWhere(user) as any,
    select: { id: true, name: true },
  });
  return Promise.all(designers.map(async (d) => {
    const dWhere = { ...where, assignedDesignerId: d.id };
    const [leads, dqls, pps, onboardings, slaBreaches] = await Promise.all([
      prisma.lead.count({ where: dWhere }),
      prisma.meeting.count({ where: { lead: dWhere, type: 'DQL', status: 'COMPLETED' } }),
      prisma.meeting.count({ where: { lead: dWhere, type: 'PP', status: { in: ['COMPLETED', 'NO_SHOW'] } } }),
      // DIP checklist guard: mirrors performanceRecalc — only leads with a
      // completed DIP checklist count as converted (HANDED_OVER legacy exempt).
      prisma.lead.count({
        where: {
          ...dWhere,
          OR: [
            { stage: 'DESIGN_IN_PROGRESS', dipChecklist: { completedAt: { not: null } } },
            { stage: 'HANDED_OVER' },
          ],
        },
      }),
      prisma.lead.count({ where: { ...dWhere, isSLABreached: true } }),
    ]);
    return {
      designer: d.name,
      leads,
      dqlsDone: dqls,
      ppsDone: pps,
      onboardings,
      conversionPct: leads > 0 ? +(onboardings / leads * 100).toFixed(1) : 0,
      slaBreaches,
      slaCompliancePct: leads > 0 ? +((leads - slaBreaches) / leads * 100).toFixed(1) : 100,
    };
  }));
}

async function blPerformance(q: Record<string, string>, user: ReportUser) {
  const where = await buildLeadWhere(q, user.role, user.id);
  const bls = await prisma.user.findMany({
    where: blListWhere(user) as any,
    select: { id: true, name: true },
  });
  return Promise.all(bls.map(async (bl) => {
    // BL role: the scope already is "team designers OR assignedBLId = BL" (leadScope.ts), so don't narrow it back to assignedBLId only.
    const bWhere = user.role === 'BL' ? where : { ...where, assignedBLId: bl.id };
    const [leads, closed, discountReqs] = await Promise.all([
      prisma.lead.count({ where: bWhere }),
      // DIP checklist guard: mirrors designerPerformance and performanceRecalc.
      prisma.lead.count({
        where: {
          ...bWhere,
          OR: [
            { stage: 'DESIGN_IN_PROGRESS', dipChecklist: { completedAt: { not: null } } },
            { stage: 'HANDED_OVER' },
          ],
        },
      }),
      prisma.discountRequest.findMany({
        where: { lead: bWhere },
        select: { status: true, discountPct: true, originalAmount: true, amount: true },
      }),
    ]);
    const approved = discountReqs.filter((r) => r.status === 'APPROVED');
    const rejected = discountReqs.filter((r) => r.status === 'REJECTED');
    const avgDiscount = approved.length
      ? +(approved.reduce((a, r) => a + Number(r.discountPct), 0) / approved.length).toFixed(1)
      : 0;
    return {
      bl: bl.name,
      leadsManaged: leads,
      closed,
      discountRequested: discountReqs.length,
      discountApproved: approved.length,
      discountRejected: rejected.length,
      avgApprovedDiscountPct: avgDiscount,
    };
  }));
}

async function sourcePerformance(q: Record<string, string>, user: ReportUser) {
  const where = await buildLeadWhere(q, user.role, user.id);
  const rows = await prisma.lead.groupBy({
    by: ['source', 'stage'],
    where,
    _count: { id: true },
  });
  const sourceMap: Record<string, { total: number; onboarding: number }> = {};
  for (const r of rows) {
    const src = r.source ?? 'Unknown';
    if (!sourceMap[src]) sourceMap[src] = { total: 0, onboarding: 0 };
    sourceMap[src].total += r._count.id;
    if (WON_STAGES.includes(r.stage)) sourceMap[src].onboarding += r._count.id;
  }
  return Object.entries(sourceMap)
    .map(([source, { total, onboarding }]) => ({
      source, total, onboarding,
      conversionPct: total > 0 ? +(onboarding / total * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

async function campaignPerformance(q: Record<string, string>, user: ReportUser) {
  const where = await buildLeadWhere(q, user.role, user.id);
  const rows = await prisma.lead.groupBy({
    by: ['utmCampaign', 'stage'],
    where: { ...where, utmCampaign: { not: null } },
    _count: { id: true },
  });
  const map: Record<string, { total: number; onboarding: number }> = {};
  for (const r of rows) {
    const c = r.utmCampaign ?? 'Unknown';
    if (!map[c]) map[c] = { total: 0, onboarding: 0 };
    map[c].total += r._count.id;
    if (WON_STAGES.includes(r.stage)) map[c].onboarding += r._count.id;
  }
  return Object.entries(map)
    .map(([campaign, { total, onboarding }]) => ({
      campaign, total, onboarding,
      conversionPct: total > 0 ? +(onboarding / total * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

async function inactiveLeads(q: Record<string, string>, user: ReportUser) {
  const where = { ...(await buildLeadWhere(q, user.role, user.id)), status: 'INACTIVE' as const };
  const leads = await prisma.lead.findMany({
    where,
    include: {
      inactivationFeedback: {
        select: {
          reason: true,
          feedbackFormSentAt: true,
          clientResponse: true,
          respondedAt: true,
        },
      },
      assignedDesigner: { select: { name: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });

  const rows = leads.map((l) => ({
    leadId: l.leadId,
    name: l.name,
    designer: l.assignedDesigner?.name ?? 'Unassigned',
    source: l.source,
    reason: l.inactivationFeedback?.reason ?? '',
    feedbackFormSentAt: l.inactivationFeedback?.feedbackFormSentAt?.toISOString() ?? null,
    clientResponded: !!(l.inactivationFeedback?.respondedAt),
    feedbackResponse: l.inactivationFeedback?.clientResponse ?? null,
    feedbackRespondedAt: l.inactivationFeedback?.respondedAt?.toISOString() ?? null,
    inactivatedAt: l.updatedAt.toISOString().split('T')[0],
  }));

  // Aggregate summary
  const totalInactivated = rows.length;
  const formSentCount = rows.filter((r) => r.feedbackFormSentAt).length;
  const responseCount = rows.filter((r) => r.clientResponded).length;
  const responseRate = formSentCount > 0 ? +((responseCount / formSentCount) * 100).toFixed(1) : 0;

  // Top feedback reasons (frequency count)
  const reasonMap: Record<string, number> = {};
  for (const r of rows) {
    if (r.feedbackResponse) {
      reasonMap[r.feedbackResponse] = (reasonMap[r.feedbackResponse] ?? 0) + 1;
    }
  }
  const topReasons = Object.entries(reasonMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([response, count]) => ({ response, count }));

  return {
    summary: { totalInactivated, formSentCount, responseCount, responseRate, topReasons },
    rows,
  };
}

async function meetingPerformance(q: Record<string, string>, user: ReportUser) {
  const where = await buildLeadWhere(q, user.role, user.id);
  const designers = await prisma.user.findMany({
    where: designerListWhere(user) as any,
    select: { id: true, name: true },
  });
  return Promise.all(designers.map(async (d) => {
    const dWhere = { lead: { assignedDesignerId: d.id, ...where } };
    const [scheduled, completed, noShow, rescheduled] = await Promise.all([
      prisma.meeting.count({ where: { ...dWhere, status: 'SCHEDULED' } }),
      prisma.meeting.count({ where: { ...dWhere, status: 'COMPLETED' } }),
      prisma.meeting.count({ where: { ...dWhere, status: 'NO_SHOW' } }),
      prisma.meeting.count({ where: { ...dWhere, status: 'RESCHEDULED' } }),
    ]);
    const total = scheduled + completed + noShow + rescheduled;
    return {
      designer: d.name,
      scheduled, completed, noShow, rescheduled, total,
      completionPct: total > 0 ? +(completed / total * 100).toFixed(1) : 0,
      noShowPct: total > 0 ? +(noShow / total * 100).toFixed(1) : 0,
    };
  }));
}

async function salesCycle(q: Record<string, string>, user: ReportUser) {
  const where = { ...(await buildLeadWhere(q, user.role, user.id)), stage: { in: WON_STAGES } };
  const agg = await prisma.lead.aggregate({
    where,
    _avg: { daysLeadToDQL: true, daysDQLToPP: true, daysPPToOnboarding: true },
    _min: { daysLeadToDQL: true, daysDQLToPP: true, daysPPToOnboarding: true },
    _max: { daysLeadToDQL: true, daysDQLToPP: true, daysPPToOnboarding: true },
    _count: { id: true },
  });
  const avgTotal = (agg._avg.daysLeadToDQL ?? 0) + (agg._avg.daysDQLToPP ?? 0) + (agg._avg.daysPPToOnboarding ?? 0);
  const minTotal = (agg._min.daysLeadToDQL ?? 0) + (agg._min.daysDQLToPP ?? 0) + (agg._min.daysPPToOnboarding ?? 0);
  const maxTotal = (agg._max.daysLeadToDQL ?? 0) + (agg._max.daysDQLToPP ?? 0) + (agg._max.daysPPToOnboarding ?? 0);
  return [{
    metric: 'Lead → Onboarding',
    onboardedLeads: agg._count.id,
    avgDays: avgTotal.toFixed(1),
    fastestDays: minTotal,
    slowestDays: maxTotal,
    avgLeadToDQL: agg._avg.daysLeadToDQL?.toFixed(1) ?? null,
    avgDQLToPP: agg._avg.daysDQLToPP?.toFixed(1) ?? null,
    avgPPToOnboarding: agg._avg.daysPPToOnboarding?.toFixed(1) ?? null,
  }];
}

async function leadAging(q: Record<string, string>, user: ReportUser) {
  const SLA_THRESHOLDS: Record<string, number> = {
    EFFECTIVE_LEAD: 1, MQL: 5, DQL: 5, PROPOSAL_READY: 2,
  };
  const where = await buildLeadWhere(q, user.role, user.id);
  const leads = await prisma.lead.findMany({
    where: { ...where, status: 'ACTIVE', stage: { notIn: WON_STAGES } },
    select: {
      leadId: true, name: true, stage: true, updatedAt: true, isSLABreached: true,
      assignedDesigner: { select: { name: true } },
    },
  });
  const now = Date.now();
  return leads
    .map((l) => {
      const daysInStage = Math.floor((now - l.updatedAt.getTime()) / (1000 * 60 * 60 * 24));
      const threshold = SLA_THRESHOLDS[l.stage] ?? 99;
      return {
        leadId: l.leadId, name: l.name, stage: l.stage,
        designer: l.assignedDesigner?.name ?? 'Unassigned',
        daysInStage, slaThreshold: threshold,
        overdueDays: Math.max(0, daysInStage - threshold),
        isSLABreached: l.isSLABreached,
      };
    })
    .filter((l) => l.daysInStage >= l.slaThreshold)
    .sort((a, b) => b.overdueDays - a.overdueDays);
}

async function monthlyTrend(q: Record<string, string>, user: ReportUser) {
  const where = await buildLeadWhere(q, user.role, user.id);
  const startDate = q.startDate ? new Date(q.startDate) : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const endDate = q.endDate ? endOfDayIST(q.endDate) : new Date();

  const leads = await prisma.lead.findMany({
    where: { ...where, createdAt: { gte: startDate, lte: endDate } },
    select: { createdAt: true, stage: true },
  });

  // Group by month
  const monthMap: Record<string, { month: string; leads: number; onboardings: number }> = {};
  for (const l of leads) {
    const key = l.createdAt.toISOString().slice(0, 7); // YYYY-MM
    if (!monthMap[key]) monthMap[key] = { month: key, leads: 0, onboardings: 0 };
    monthMap[key].leads++;
    if (WON_STAGES.includes(l.stage)) monthMap[key].onboardings++;
  }

  const rows = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));
  const bestByLeads = rows.length ? rows.reduce((a, b) => a.leads > b.leads ? a : b) : null;
  const worstByLeads = rows.length ? rows.reduce((a, b) => a.leads < b.leads ? a : b) : null;

  return { monthly: rows, bestMonth: bestByLeads?.month ?? null, worstMonth: worstByLeads?.month ?? null };
}

async function offerPerformance(q: Record<string, string>, user: ReportUser) {
  const where = await buildLeadWhere(q, user.role, user.id);
  const offers = await prisma.offer.findMany({ select: { id: true, name: true } });
  return Promise.all(offers.map(async (o) => {
    // A lead counts for this offer if it was EVER applied (LeadOffer history),
    // not just if it is the lead's current offer.
    const oWhere = { ...where, leadOffers: { some: { offerId: o.id } } };
    const [total, current, onboarded] = await Promise.all([
      prisma.lead.count({ where: oWhere }),
      prisma.lead.count({ where: { ...where, currentOfferId: o.id } }),
      prisma.lead.count({ where: { ...oWhere, stage: { in: WON_STAGES } } }),
    ]);
    return {
      offer: o.name, total, current, onboarded,
      conversionPct: total > 0 ? +(onboarded / total * 100).toFixed(1) : 0,
    };
  }));
}

// ── Report dispatcher ─────────────────────────────────────────────────────────
const HANDLERS: Record<string, Handler> = {
  lead_summary: leadSummary,
  pipeline,
  conversion,
  timeline_performance: timelinePerformance,
  designer_performance: designerPerformance,
  bl_performance: blPerformance,
  source_performance: sourcePerformance,
  campaign_performance: campaignPerformance,
  inactive_leads: inactiveLeads,
  meeting_performance: meetingPerformance,
  sales_cycle: salesCycle,
  lead_aging: leadAging,
  monthly_trend: monthlyTrend,
  offer_performance: offerPerformance,
};

// ── GET /api/reports/:type ────────────────────────────────────────────────────
reportsRouter.get('/:type', verifyToken, async (req, res) => {
  const { type } = req.params;
  const handler = HANDLERS[type];
  if (!handler) {
    res.status(400).json({ error: `Unknown report type: ${type}`, available: Object.keys(HANDLERS) });
    return;
  }
  try {
    const data = await handler(req.query as Record<string, string>, req.user!);
    res.json({ type, data });
  } catch (err: any) {
    console.error(`[reports:${type}]`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/:type/export — CSV download ──────────────────────────────
reportsRouter.get('/:type/export', verifyToken, async (req, res) => {
  const { type } = req.params;
  const handler = HANDLERS[type];
  if (!handler) { res.status(400).json({ error: `Unknown report type: ${type}` }); return; }
  try {
    const data = await handler(req.query as Record<string, string>, req.user!);
    const rows = Array.isArray(data) ? data as Record<string, unknown>[]
      : (data as any).monthly ?? [data];
    const csv = toCSV(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${type}_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
