import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { buildLeadRoleWhere } from '../lib/leadScope.js';
import { getCycleForDate } from '../lib/targetCycle.js';
import { calculateDesignerCredits, loadIncentiveConfig } from '../lib/incentiveCredits.js';
import { loadCompletedPitches } from '../lib/completedPitches.js';
import { CancellationReviewRequired, loadBookingCancellations } from '../lib/bookingCancellations.js';

export const dashboardRouter = Router();

const PIPELINE_STAGES = [
  'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED',
  'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS',
] as const;
const FORECAST_PP_STAGES = [
  'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING',
] as const;

type PipelineStage = typeof PIPELINE_STAGES[number];

function getForwardStageTarget(meta: unknown): PipelineStage | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const transition = meta as { to?: unknown; isBackward?: unknown };
  if (transition.isBackward === true || typeof transition.to !== 'string') return null;
  return PIPELINE_STAGES.includes(transition.to as PipelineStage)
    ? transition.to as PipelineStage
    : null;
}

function startOfDay() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d;
}
function startOfWeek() {
  const d = startOfDay();
  d.setDate(d.getDate() - d.getDay());
  return d;
}
function startOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function istCalendarDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((value) => value.type === type)?.value);
  // FollowUpTask.dueDate is a date-only UTC calendar marker, not an IST
  // timestamp, so preserve midnight UTC for the selected IST calendar date.
  return new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
}
function addCalendarDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
function endOfCalendarDay(date: Date) {
  const result = new Date(date);
  result.setUTCHours(23, 59, 59, 999);
  return result;
}
function workWeekRanges(today: Date) {
  const daysSinceMonday = (today.getUTCDay() + 6) % 7;
  const monday = addCalendarDays(today, -daysSinceMonday);
  const thisWeekStart = addCalendarDays(monday, 1);
  return {
    thisWeekStart,
    thisWeekEnd: endOfCalendarDay(addCalendarDays(monday, 6)),
    nextWeekStart: addCalendarDays(monday, 8),
    nextWeekEnd: endOfCalendarDay(addCalendarDays(monday, 13)),
  };
}

dashboardRouter.get('/', verifyToken, async (req, res) => {
  let user = req.user!;
  const { from, to } = req.query as { from?: string; to?: string };

  // BL / Branch Head can open one designer's dashboard (designerId). The
  // designer must be inside the caller's permitted set; the rest of the handler
  // then computes exactly what that designer sees.
  const viewDesignerId = typeof req.query.designerId === 'string' ? req.query.designerId : '';
  if (viewDesignerId) {
    if (user.role !== 'BL' && user.role !== 'BRANCH_HEAD') {
      res.status(403).json({ error: 'designerId is only available to BL and Branch Head' });
      return;
    }
    const designer = await prisma.user.findFirst({
      where: {
        id: viewDesignerId,
        role: 'DESIGNER',
        isActive: true,
        ...(user.role === 'BL' ? { blId: user.id } : {}),
      },
    });
    if (!designer) {
      res.status(403).json({ error: 'Designer is outside your permitted scope' });
      return;
    }
    user = { ...user, ...(designer as any) } as typeof user;
  }

  // ── Date range (default = current month) ─────────────────────────────────
  const rangeFrom = from ? new Date(from) : startOfMonth();
  const rangeTo = to ? (() => { const d = new Date(to); d.setHours(23, 59, 59, 999); return d; })() : endOfMonth();

  // ── Build lead filter based on role ─────────────────────────────────────────
  // Shared with GET /api/leads (buildLeadRoleWhere) so dashboard KPI counts
  // and their drill-through list populations never drift apart (task #113).
  const leadWhere: any = await buildLeadRoleWhere(user, prisma);
  // "Received" and funnel metrics exclude explicit test/demo records for every
  // role. Duplicate records stay visible to CRE for marketing visibility, but
  // are excluded from a designer's own received/funnel population.
  const receivedFunnelWhere: any = {
    ...leadWhere,
    isTestLead: false,
    ...(user.role === 'DESIGNER' ? { isDuplicate: false } : {}),
  };
  let teamUserIds: string[] = [user.id];

  if (user.role === 'DESIGNER' || user.role === 'CRE') {
    teamUserIds = [user.id];
  } else if (user.role === 'BL') {
    const members = await prisma.user.findMany({
      where: { blId: user.id, isActive: true },
      select: { id: true },
    });
    teamUserIds = [user.id, ...members.map((m) => m.id)];
  }
  // BRANCH_HEAD / ADMIN: no filter

  const today = startOfDay();
  const week = startOfWeek();
  const month = startOfMonth();

  // ── Parallel queries ─────────────────────────────────────────────────────────
  const [
    totalLeads,
    leadsToday,
    leadsThisWeek,
    leadsThisMonth,
    stageCounts,
    sourceCounts,
    slaBreaches,
    slaBreachTotal,
    callsToday,
    stagesMovedToday,
    tasksCompletedToday,
    activeLeads,
    onboardingLeads,
    ppMeetingsForStats,
    pipelineValueRaw,
    activeProjectsDipAgg,
    npsResponses,
    collectionsThisMonth,
    outstandingProjects,
    // Unfiltered snapshot for conversion rates: counts every lead currently
    // sitting at each stage (no createdAt window). Cumulative progression is
    // then derived from this ordered snapshot below.
    stageCountsAll,
    pipelineLeadsAll,
    stageTransitionLogs,
    // OB Progress: leads in DIP that completed an OBM meeting
    obProgressRaw,
    // Revenue Generated: total collected payments (all-time, no date-range cap)
    revenueGeneratedRaw,
  ] = await Promise.all([
    prisma.lead.count({ where: { ...receivedFunnelWhere, createdAt: { gte: rangeFrom, lte: rangeTo } } }),
    prisma.lead.count({ where: { ...receivedFunnelWhere, createdAt: { gte: today } } }),
    prisma.lead.count({ where: { ...receivedFunnelWhere, createdAt: { gte: week } } }),
    prisma.lead.count({ where: { ...receivedFunnelWhere, createdAt: { gte: month } } }),
    prisma.lead.groupBy({ by: ['stage'], where: { ...receivedFunnelWhere, createdAt: { gte: rangeFrom, lte: rangeTo } }, _count: { id: true } }),
    prisma.lead.groupBy({ by: ['source'], where: { ...receivedFunnelWhere, createdAt: { gte: rangeFrom, lte: rangeTo } }, _count: { id: true } }),
    prisma.sLABreach.findMany({
      // ONBOARDING excluded (task #14): legacy breach rules never covered
      // OB→OBM, so any flag here would be stale/carried over from an earlier
      // stage — that stage is judged solely by the new stage-SLA system.
      // NOTE: `take: 5` below is a display cap for the preview list only —
      // `slaBreachTotal` (separate .count() query) is the real number shown
      // on the KPI tile and must match what /leads?hasUnresolvedSlaBreach=true
      // returns (task #113 — this used to be `slaBreaches.length`, which
      // silently capped the displayed count at 5).
      where: { lead: { ...leadWhere, status: 'ACTIVE', stage: { notIn: ['HANDED_OVER', 'DESIGN_IN_PROGRESS', 'ONBOARDING'] } }, resolvedAt: null },
      include: { lead: { select: { id: true, leadId: true, name: true, stage: true } } },
      orderBy: { breachedAt: 'desc' },
      take: 5,
    }),
    // Distinct-lead count, not a SLABreach-record count — a lead can carry
    // more than one unresolved breach, but /leads?hasUnresolvedSlaBreach=true
    // returns each such lead once, so the KPI must count leads too or the
    // tile and its drill-through disagree (task #113 review).
    prisma.lead.count({
      where: {
        ...leadWhere,
        status: 'ACTIVE',
        stage: { notIn: ['HANDED_OVER', 'DESIGN_IN_PROGRESS', 'ONBOARDING'] },
        slaBreaches: { some: { resolvedAt: null } },
      },
    }),
    prisma.call.count({
      where: { createdAt: { gte: today }, loggedById: { in: teamUserIds } },
    }),
    prisma.activityLog.count({
      where: { action: 'STAGE_CHANGED', createdAt: { gte: today }, userId: { in: teamUserIds } },
    }),
    prisma.followUpTask.count({
      where: { completedAt: { gte: today }, assignedToId: { in: teamUserIds } },
    }),
    prisma.lead.count({
      where: { ...leadWhere, status: 'ACTIVE', stage: { notIn: ['HANDED_OVER', 'DESIGN_IN_PROGRESS'] } },
    }),
    // "Won" leads: both DESIGN_IN_PROGRESS (current funnel) and HANDED_OVER
    // (legacy) must have a completed DIP checklist to count as won.
    // The unconditional HANDED_OVER branch was a regression — legacy leads
    // that predate the DIP model and never had a checklist no longer inflate
    // the won count. Mirrors bookingAchievedAgg exactly.
    prisma.lead.count({
      where: {
        ...leadWhere,
        status: { not: 'INACTIVE' },
        OR: [
          { stage: 'DESIGN_IN_PROGRESS', dipChecklist: { completedAt: { not: null } } },
          { stage: 'HANDED_OVER',        dipChecklist: { completedAt: { not: null } } },
        ],
      },
    }),
    loadCompletedPitches(leadWhere),
    // pipelineValue: sum of estimatedValue for active pipeline leads
    prisma.lead.aggregate({
      where: {
        ...leadWhere,
        status: 'ACTIVE',
        stage: { notIn: ['HANDED_OVER', 'DESIGN_IN_PROGRESS'] },
        estimatedValue: { not: null },
      },
      _sum: { estimatedValue: true },
    }),
    // Active Projects tile: leads currently at DESIGN_IN_PROGRESS (the funnel's
    // "project" stage), count + estimated value — distinct from "In Delivery"
    // above, which spans every non-Handover/Completed *project phase* instead.
    prisma.lead.aggregate({
      where: { ...leadWhere, stage: 'DESIGN_IN_PROGRESS' },
      _count: { id: true },
      _sum: { estimatedValue: true },
    }),
    // NPS responses with scores — filtered by respondedAt so the dashboard period
    // reflects when clients actually rated (not when the survey was sent).
    prisma.nPSResponse.findMany({
      where: {
        lead: leadWhere,
        respondedAt: { not: null, gte: rangeFrom, lte: rangeTo },
        score: { not: null },
      },
      select: { stage: true, score: true },
    }),
    // Collections collected this month
    prisma.collection.aggregate({
      where: {
        status: 'COLLECTED',
        collectedAt: { gte: startOfMonth(), lte: endOfMonth() },
        project: { ...(Object.keys(leadWhere).length > 0 ? { lead: leadWhere } : {}) },
      },
      _sum: { amount: true },
    }),
    // Outstanding amount across active projects
    prisma.project.aggregate({
      where: {
        phase: { notIn: ['HANDOVER', 'COMPLETED'] },
        ...(Object.keys(leadWhere).length > 0 ? { lead: leadWhere } : {}),
      },
      _sum: { outstandingAmount: true },
    }),
    // Current-snapshot stage counts — no createdAt filter so this counts every
    // lead wherever it sits today, regardless of when it was created.
    prisma.lead.groupBy({ by: ['stage'], where: receivedFunnelWhere, _count: { id: true } }),
    // The same full-funnel population used for conversion. Its origin dates,
    // combined with first forward stage-entry logs, produce the per-stage TAT.
    prisma.lead.findMany({
      where: { ...receivedFunnelWhere, stage: { in: [...PIPELINE_STAGES] } },
      select: { id: true, leadOriginDate: true },
    }),
    prisma.activityLog.findMany({
      where: {
        action: 'STAGE_CHANGED',
        lead: { ...receivedFunnelWhere, stage: { in: [...PIPELINE_STAGES] } },
      },
      select: { leadId: true, meta: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    // OB Progress: leads currently in DIP that have an OBM meeting completed
    prisma.lead.aggregate({
      where: {
        ...leadWhere,
        stage: 'DESIGN_IN_PROGRESS',
        meetings: { some: { type: 'OBM', status: 'COMPLETED' } },
      },
      _count: { id: true },
      _sum: { estimatedValue: true },
    }),
    // Revenue Generated: total collected payments across all time (not date-range scoped)
    prisma.collection.aggregate({
      where: {
        status: 'COLLECTED',
        project: { ...(Object.keys(leadWhere).length > 0 ? { lead: leadWhere } : {}) },
      },
      _sum: { amount: true },
    }),
  ]);

  // ── Stage funnel map ──────────────────────────────────────────────────────────
  // Date-scoped map (used for the stageFunnel bars and source breakdown)
  const stageMap: Record<string, number> = {};
  for (const row of stageCounts) stageMap[row.stage] = row._count.id;

  // Unfiltered snapshot map (used for conversion rates only)
  const stageMapAll: Record<string, number> = {};
  for (const row of stageCountsAll) stageMapAll[row.stage] = row._count.id;
  const totalAllStages = PIPELINE_STAGES.reduce((sum, s) => sum + (stageMapAll[s] ?? 0), 0);

  const stageFunnel = PIPELINE_STAGES.map((s) => ({ stage: s, count: stageMap[s] ?? 0 }));

  // ── Source breakdown ──────────────────────────────────────────────────────────
  const sourceBreakdown = sourceCounts
    .filter((r) => r.source)
    .map((r) => ({ source: r.source!, count: r._count.id }))
    .sort((a, b) => b.count - a.count);

  // ── Cumulative stage progression + TAT ────────────────────────────────────────
  // A lead at a later stage has necessarily progressed through every earlier
  // funnel stage. Therefore: stage % = (leads at this stage OR any later active
  // funnel stage ÷ total leads received) × 100. MQL is the entry point (100%).
  const reachedCountAt = (stage: PipelineStage) => {
    const index = PIPELINE_STAGES.indexOf(stage);
    return PIPELINE_STAGES
      .slice(index)
      .reduce((sum, laterStage) => sum + (stageMapAll[laterStage] ?? 0), 0);
  };
  const rateAt = (stage: PipelineStage) => {
    const reached = reachedCountAt(stage);
    return totalAllStages > 0 ? Math.min(100, Math.round((reached / totalAllStages) * 100)) : 0;
  };
  const conversionRates = {
    mqlToDql: rateAt('DQL'),
    dqlToPr: rateAt('PROPOSAL_READY'),
    prToPp: rateAt('PROPOSAL_PRESENTED'),
    ppToPd: rateAt('PROPOSAL_DISCUSSION'),
    pdToOb: rateAt('ONBOARDING'),
    obToObm: rateAt('ONBOARDING_MEETING'),
    obmToDip: rateAt('DESIGN_IN_PROGRESS'),
  };

  // Record the first actual forward arrival at each stage. A skipped stage still
  // counts for cumulative progression but has no entry timestamp, so it is
  // intentionally excluded from that stage's TAT sample.
  const firstEntryByLead = new Map<string, Map<PipelineStage, Date>>();
  for (const log of stageTransitionLogs) {
    if (!log.leadId) continue;
    const stage = getForwardStageTarget(log.meta);
    if (!stage) continue;
    const entries = firstEntryByLead.get(log.leadId) ?? new Map<PipelineStage, Date>();
    if (!entries.has(stage)) entries.set(stage, log.createdAt);
    firstEntryByLead.set(log.leadId, entries);
  }

  const tatDaysByStage = new Map<PipelineStage, number[]>(
    PIPELINE_STAGES.map((stage) => [stage, []]),
  );
  for (const lead of pipelineLeadsAll) {
    // MQL receipt is the baseline, so its TAT is zero for every funnel lead.
    tatDaysByStage.get('MQL')!.push(0);
    const entries = firstEntryByLead.get(lead.id);
    if (!entries) continue;
    for (const [stage, enteredAt] of entries) {
      // MQL's stage date is always the lead's receipt/origin date. A legacy
      // re-qualification transition into MQL must not replace that zero-day
      // baseline with a later timestamp.
      if (stage === 'MQL') continue;
      const elapsedDays = (enteredAt.getTime() - lead.leadOriginDate.getTime()) / 86400000;
      if (elapsedDays >= 0) tatDaysByStage.get(stage)!.push(elapsedDays);
    }
  }

  // Per-stage count + cumulative percentage + TAT for the dashboard panel.
  const stageConversion = PIPELINE_STAGES.map((s) => ({
    stage: s,
    count: stageMapAll[s] ?? 0,
    reachedCount: reachedCountAt(s),
    pct: rateAt(s),
    tatSampleSize: tatDaysByStage.get(s)!.length,
    avgTatDays: tatDaysByStage.get(s)!.length > 0
      ? +(
        tatDaysByStage.get(s)!.reduce((sum, days) => sum + days, 0)
        / tatDaysByStage.get(s)!.length
      ).toFixed(1)
      : null,
  }));
  const totalLeadsReceived = totalAllStages;

  // ── avgNPS: average of per-stage averages ────────────────────────────────────
  const npsGrouped: Record<string, number[]> = {};
  for (const r of npsResponses) {
    if (r.score !== null) {
      if (!npsGrouped[r.stage]) npsGrouped[r.stage] = [];
      npsGrouped[r.stage].push(r.score);
    }
  }
  const stageAverages = Object.values(npsGrouped).map(
    (scores) => scores.reduce((a, b) => a + b, 0) / scores.length,
  );
  const avgNPS = stageAverages.length > 0
    ? +(stageAverages.reduce((a, b) => a + b, 0) / stageAverages.length).toFixed(1)
    : null;

  const stageNpsAvg = (stage: string) => {
    const scores = npsGrouped[stage];
    if (!scores || scores.length === 0) return null;
    return +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
  };
  const salesNps = stageNpsAvg('SALE');
  const obNps = stageNpsAvg('ONBOARDING');
  const designFreezeNps = stageNpsAvg('DESIGN_FREEZE');
  const signOffNps = stageNpsAvg('SIGN_OFF');

  // ── Pipeline value ────────────────────────────────────────────────────────────
  const pipelineValue = pipelineValueRaw._sum.estimatedValue
    ? Number(pipelineValueRaw._sum.estimatedValue)
    : 0;

  // ── Financial ────────────────────────────────────────────────────────────────
  const collectedThisMonth = collectionsThisMonth._sum.amount ?? 0;
  const outstanding = outstandingProjects._sum.outstandingAmount ?? 0;

  // ── Active Leads value (same population as `activeLeads` count above) ────────
  const activeLeadsValue = pipelineValue; // pipelineValueRaw already sums estimatedValue over the identical active/non-DIP/non-Handover population

  // ── Active Projects (DIP) ─────────────────────────────────────────────────────
  const activeProjectsDip = {
    count: activeProjectsDipAgg._count.id,
    value: activeProjectsDipAgg._sum.estimatedValue ? Number(activeProjectsDipAgg._sum.estimatedValue) : 0,
  };

  // ── OB Progress + Revenue Generated ──────────────────────────────────────────
  const obProgress = {
    count: obProgressRaw._count.id,
    value: obProgressRaw._sum.estimatedValue ? Number(obProgressRaw._sum.estimatedValue) : 0,
  };
  const revenueGenerated = revenueGeneratedRaw._sum.amount ? Number(revenueGeneratedRaw._sum.amount) : 0;

  // ── Projects delivery widgets ─────────────────────────────────────────────────
  let deliveryWidgets: any = null;
  if (user.role !== 'CRE') {
    const projectWhere: any = Object.keys(leadWhere).length > 0 ? { lead: leadWhere } : {};

    const attentionWhere = { ...projectWhere, attentionFlags: { some: { resolvedAt: null } } };

    const [inDeliveryAgg, phaseGroups, attentionProjects, attentionTotal, collectionsDue] = await Promise.all([
      prisma.project.aggregate({
        where: { ...projectWhere, phase: { notIn: ['HANDOVER', 'COMPLETED'] } },
        _count: { id: true },
        _sum: { contractValue: true },
      }),
      prisma.project.groupBy({
        by: ['phase'],
        where: projectWhere,
        _count: { id: true },
        _sum: { contractValue: true },
      }),
      prisma.project.findMany({
        where: attentionWhere,
        include: {
          lead: { select: { id: true, leadId: true, name: true } },
          attentionFlags: {
            where: { resolvedAt: null },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
        // `take: 20` here is a display cap for the preview list only —
        // `attentionTotal` (separate .count() below) is the real number
        // shown on the KPI tile so it matches /projects?hasAttention=true's
        // total exactly (task #113 — this used to be attentionProjects.length,
        // which silently capped the displayed count at 20).
        take: 20,
      }),
      prisma.project.count({ where: attentionWhere }),
      prisma.collection.findMany({
        where: {
          status: { not: 'COLLECTED' },
          project: projectWhere,
        },
        include: {
          project: {
            include: { lead: { select: { id: true, leadId: true, name: true } } },
          },
        },
        orderBy: { dueDate: 'asc' },
        take: 20,
      }),
    ]);

    const now = Date.now();

    deliveryWidgets = {
      inDelivery: {
        count: inDeliveryAgg._count.id,
        contractValueSum: inDeliveryAgg._sum.contractValue ?? 0,
      },
      phaseLoad: phaseGroups.map((g) => ({
        phase: g.phase,
        count: g._count.id,
        valueSum: g._sum.contractValue ?? 0,
      })),
      needsAttention: attentionProjects.map((p) => ({
        projectId: p.id,
        projectCode: p.projectCode,
        clientName: p.lead.name,
        leadId: p.lead.leadId,
        category: p.attentionFlags[0]?.category ?? '',
        description: p.attentionFlags[0]?.description ?? '',
        daysOverdue: p.attentionFlags[0]
          ? Math.floor((now - p.attentionFlags[0].createdAt.getTime()) / 86400000)
          : 0,
      })),
      // Real total, not capped by the `take: 20` preview list above — this is
      // what the "Needs Attention" KPI tile displays and must match
      // /projects?dashboardScope=true&hasAttention=true's total exactly.
      needsAttentionTotal: attentionTotal,
      collectionsDue: collectionsDue.map((c) => ({
        collectionId: c.id,
        projectId: c.projectId,
        projectCode: c.project.projectCode,
        clientName: c.project.lead.name,
        leadId: c.project.lead.leadId,
        milestone: c.milestone,
        amount: c.amount,
        status: c.status,
        dueDate: c.dueDate,
        daysWaiting: c.dueDate
          ? Math.floor((now - c.dueDate.getTime()) / 86400000)
          : null,
      })),
    };
  }

  // ── Personal / BL stats ──────────────────────────────────────────────────────
  // PP Done counts each LEAD once (Annie, definitions row 10 / Q3), however
  // many completed PP meetings it has.
  const ppLeadsDone = ppMeetingsForStats.all.pitches;
  const ppMeetingsDone = ppLeadsDone.length;
  const ppTotalValue = ppLeadsDone.reduce(
    (sum, lead) => sum + Number(lead.estimatedValue ?? 0),
    0,
  );
  const ppAverageValue = ppMeetingsDone > 0 ? ppTotalValue / ppMeetingsDone : 0;

  const personalStats = {
    activeLeads,
    ppDone: ppMeetingsDone,
    ppTotalValue,
    ppAverageValue,
    onboardings: onboardingLeads,
    targetVsAchieved: { target: null, achieved: onboardingLeads },
  };

  const blStats = user.role === 'BL' ? {
    leadsManaged: totalLeads,
    onboardingCount: onboardingLeads,
    ppCount: ppMeetingsDone,
    teamSize: teamUserIds.length - 1,
  } : null;

  // ── Designer-specific extras ──────────────────────────────────────────────────
  let designerDash: any = null;
  if (user.role === 'DESIGNER' || user.role === 'CRE') {
    const now = new Date();
    const todayStart = istCalendarDate(now);
    const todayEnd = endOfCalendarDay(todayStart);
    const tomorrowStart = addCalendarDays(todayStart, 1);
    const tomorrowEnd = endOfCalendarDay(tomorrowStart);
    const { thisWeekStart, thisWeekEnd, nextWeekStart, nextWeekEnd } = workWeekRanges(todayStart);
    // Tomorrow keeps its own card, so This Week starts after tomorrow even
    // when tomorrow itself is a working day.
    const thisWeekDeadlineStart = new Date(Math.max(
      thisWeekStart.getTime(),
      addCalendarDays(tomorrowStart, 1).getTime(),
    ));

    // Last month range for NPS delta
    const lastMonthStart = new Date(rangeFrom.getFullYear(), rangeFrom.getMonth() - 1, 1);
    const lastMonthEnd = new Date(rangeFrom.getFullYear(), rangeFrom.getMonth(), 0, 23, 59, 59, 999);

    // 6 months ago for trend chart
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    // Booking/PO targets run on a 16th–15th cycle (task #45), not the
    // calendar month used for the rest of this endpoint's date filters —
    // so achieved-vs-target must be computed over the cycle window.
    const targetCycle = getCycleForDate(now);
    const bookingCancellations = await loadBookingCancellations({ ...leadWhere, isTestLead: false }, targetCycle);
    const designerTarget = await prisma.designerTarget.findUnique({
      where: { designerId_cycleStart: { designerId: user.id, cycleStart: targetCycle.cycleStart } },
    });
    // Keep this population identical to GET /api/projects/pipeline: a project
    // remains active until its own delivery phase is COMPLETED, and approved
    // project-team members see it alongside projects they directly own.
    const approvedTeamProjects = await prisma.projectTeamMember.findMany({
      where: { userId: user.id, status: 'APPROVED' },
      select: { projectId: true },
    });
    const approvedTeamProjectIds = approvedTeamProjects.map((membership) => membership.projectId);
    const activeProjectWhere: Prisma.ProjectWhereInput = {
      ...(approvedTeamProjectIds.length > 0
        ? { OR: [{ designerId: user.id }, { id: { in: approvedTeamProjectIds } }] }
        : { designerId: user.id }),
      phase: { notIn: ['COMPLETED'] },
    };

    // Fetch designer's performance record + find peers via blId
    const designerRecord = await prisma.user.findUnique({
      where: { id: user.id },
      select: { blId: true, conversionRate: true, performanceTier: true, avgProjectValue: true },
    });

    const peerUsers: { id: string; name: string }[] = designerRecord?.blId
      ? await prisma.user.findMany({
          where: { blId: designerRecord.blId, isActive: true, role: { in: ['DESIGNER', 'CRE'] } },
          select: { id: true, name: true },
        })
      : [];

    if (!peerUsers.find((p) => p.id === user.id)) {
      peerUsers.push({ id: user.id, name: user.name });
    }
    const peerIds = peerUsers.map((p) => p.id);
    const peerBookingCancellations = await loadBookingCancellations({
      assignedDesignerId: { in: peerIds },
    }, targetCycle);

    const [
      projectHealthGroups,
      activeProjectsList,
      preProjectHealthLeads,
      bookingAchievedAgg,
      leadsReceivedInCycle,
      poAchievedAgg,
      deadlinesToday,
      deadlinesTomorrow,
      deadlinesThisWeek,
      deadlinesNextWeek,
      npsLastMonthRaw,
      npsTrendRaw,
      recentNotifications,
      peerBookingGroups,
      peerNpsRaw,
      stageFunnelValueGroups,
      highIntentForecastAgg,
      mediumIntentForecastAgg,
      lowIntentForecastAgg,
    ] = await Promise.all([
      // Same active-project population displayed in the Design Pipeline.
      prisma.project.groupBy({
        by: ['health'],
        where: activeProjectWhere,
        _count: { id: true },
      }),

      // Active projects list with health + attention flags (full detail for CRE/DESIGNER panel)
      prisma.project.findMany({
        where: activeProjectWhere,
        include: {
          lead: { select: { id: true, leadId: true, name: true } },
          attentionFlags: {
            where: { resolvedAt: null },
            select: { id: true, category: true, description: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      // Client Health starts at MQL and continues through onboarding. Once a
      // lead reaches Design In Progress, its Project record is shown instead.
      prisma.lead.findMany({
        where: {
          ...leadWhere,
          status: 'ACTIVE',
          stage: {
            in: [
              'MQL',
              'DQL',
              'PROPOSAL_READY',
              'PROPOSAL_PRESENTED',
              'PROPOSAL_DISCUSSION',
              'ONBOARDING',
              'ONBOARDING_MEETING',
            ],
          },
        },
        select: {
          id: true,
          leadId: true,
          name: true,
          stage: true,
          slaBreaches: { where: { resolvedAt: null }, select: { id: true } },
          attentionFlags: { where: { resolvedAt: null }, select: { id: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 30,
      }),

      // Booking achieved: sum estimatedValue for leads whose first
      // DESIGN_IN_PROGRESS stage transition (per ActivityLog) falls within the
      // selected date range — DIP is the funnel's terminal/incentive stage, so
      // this matches the peer leaderboard and performanceRecalc definition.
      // This avoids the false re-count caused by using lead.updatedAt.
      // Date window is the 16th–15th target cycle (task #45), not the
      // calendar-month rangeFrom/rangeTo used elsewhere on this endpoint —
      // this figure is paired against designerTarget.bookingTargetValue.
      prisma.lead.aggregate({
        where: {
          ...leadWhere,
          id: { notIn: bookingCancellations.excludedLeadIds },
          activityLogs: {
            some: {
              action: 'STAGE_CHANGED',
              createdAt: { gte: targetCycle.cycleStart, lte: targetCycle.cycleEnd },
              meta: { path: ['to'], equals: 'DESIGN_IN_PROGRESS' },
            },
          },
          estimatedValue: { not: null },
          // Defense-in-depth (task #89): the ONBOARDING_MEETING->DESIGN_IN_PROGRESS
          // stage-gate (config/stageRequirements.ts) already refuses the
          // transition until the DIP checklist is completed, so a lead cannot
          // reach DIP without it. This filter makes that requirement explicit
          // at the incentive query itself, rather than only relying on the
          // gate having run correctly earlier.
          dipChecklist: { completedAt: { not: null } },
        },
        _sum: { estimatedValue: true },
        _count: { id: true },
      }),
      // Conversion actual is the number of bookings achieved in this target
      // cycle divided by leads received in the same target cycle.
      prisma.lead.count({
        where: {
          ...leadWhere,
          leadOriginDate: { gte: targetCycle.cycleStart, lte: targetCycle.cycleEnd },
        },
      }),

      // PO achieved: collections collected within the same 16th–15th target
      // cycle for this designer's projects — paired against poTargetValue.
      prisma.collection.aggregate({
        where: {
          status: 'COLLECTED',
          collectedAt: { gte: targetCycle.cycleStart, lte: targetCycle.cycleEnd },
          project: { designerId: user.id },
        },
        _sum: { amount: true },
      }),

      // Upcoming deadlines — today (includes overdue). status: 'PENDING'
      // excludes RESCHEDULED/NOT_DONE archive rows, which keep
      // isCompleted:false on their original (now-stale) due date.
      prisma.followUpTask.count({
        where: { assignedToId: user.id, isCompleted: false, status: 'PENDING', dueDate: { lte: todayEnd } },
      }),

      // Deadlines tomorrow
      prisma.followUpTask.count({
        where: { assignedToId: user.id, isCompleted: false, status: 'PENDING', dueDate: { gte: tomorrowStart, lte: tomorrowEnd } },
      }),

      // Deadlines in the remaining Tuesday–Sunday work week (excluding
      // tomorrow, which has its own count, and Monday, which is a day off).
      prisma.followUpTask.count({
        where: { assignedToId: user.id, isCompleted: false, status: 'PENDING', dueDate: { gte: thisWeekDeadlineStart, lte: thisWeekEnd } },
      }),

      // Deadlines in the following Tuesday–Sunday work week. Monday is
      // deliberately excluded from the range.
      prisma.followUpTask.count({
        where: { assignedToId: user.id, isCompleted: false, status: 'PENDING', dueDate: { gte: nextWeekStart, lte: nextWeekEnd } },
      }),

      // NPS last month for delta comparison
      prisma.nPSResponse.findMany({
        where: {
          lead: leadWhere,
          respondedAt: { not: null, gte: lastMonthStart, lte: lastMonthEnd },
          score: { not: null },
        },
        select: { stage: true, score: true },
      }),

      // NPS trend — last 6 months (for chart)
      prisma.nPSResponse.findMany({
        where: {
          lead: leadWhere,
          respondedAt: { not: null, gte: sixMonthsAgo },
          score: { not: null },
        },
        select: { stage: true, score: true, respondedAt: true },
        orderBy: { respondedAt: 'asc' },
      }),

      // Recent notifications for this designer
      prisma.notificationLog.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { lead: { select: { id: true, leadId: true, name: true } } },
      }),

      // Peer booking values grouped by designer (for leaderboard) — mirrors the
      // incentive-trigger stage used in performanceRecalc and bookingAchievedAgg.
      // Date anchor: DIP leads use their STAGE_CHANGED→DIP activity-log timestamp
      // (same anchor as bookingAchievedAgg) so a lead updated after the period
      // doesn't bleed into the wrong cycle. HANDED_OVER legacy leads use
      // updatedAt as the best available proxy, and also require a completed DIP
      // checklist — unconditional HANDED_OVER was a regression that inflated
      // leaderboard values for legacy leads with no checklist record.
      prisma.lead.groupBy({
        by: ['assignedDesignerId'],
        where: {
          assignedDesignerId: { in: peerIds },
          id: { notIn: peerBookingCancellations.excludedLeadIds },
          OR: [
            {
              stage: 'DESIGN_IN_PROGRESS',
              dipChecklist: { completedAt: { not: null } },
              activityLogs: {
                some: {
                  action: 'STAGE_CHANGED',
                createdAt: { gte: targetCycle.cycleStart, lte: targetCycle.cycleEnd },
                  meta: { path: ['to'], equals: 'DESIGN_IN_PROGRESS' },
                },
              },
            },
            {
              stage: 'HANDED_OVER',
              dipChecklist: { completedAt: { not: null } },
              updatedAt: { gte: targetCycle.cycleStart, lte: targetCycle.cycleEnd },
            },
          ],
          estimatedValue: { not: null },
        },
        _sum: { estimatedValue: true },
      }),

      // Peer NPS data (raw, to compute per-peer avg in JS)
      prisma.nPSResponse.findMany({
        where: {
          lead: { assignedDesignerId: { in: peerIds } },
          respondedAt: { not: null, gte: rangeFrom, lte: rangeTo },
          score: { not: null },
        },
        select: { score: true, lead: { select: { assignedDesignerId: true } } },
      }),

      // Stage funnel value sums (current active leads, not date-filtered)
      prisma.lead.groupBy({
        by: ['stage'],
        where: { ...leadWhere, status: 'ACTIVE', estimatedValue: { not: null } },
        _sum: { estimatedValue: true },
      }),

      // Pipeline-potential and booking-forecast cohorts: active PP-or-later
      // leads that have not booked yet and whose entered Expected OB Date falls
      // inside the current 16th–15th target cycle. Booking Forecast uses the
      // high-intent cohort; Pipeline Potential displays all three intent tiers.
      prisma.lead.aggregate({
        where: { ...leadWhere, status: 'ACTIVE', stage: { in: [...FORECAST_PP_STAGES] }, expectedObDate: { gte: targetCycle.cycleStart, lte: targetCycle.cycleEnd }, estimatedValue: { not: null }, intentRating: { gte: 4, lte: 5 } },
        _sum: { estimatedValue: true }, _count: { id: true },
      }),
      prisma.lead.aggregate({
        where: { ...leadWhere, status: 'ACTIVE', stage: { in: [...FORECAST_PP_STAGES] }, expectedObDate: { gte: targetCycle.cycleStart, lte: targetCycle.cycleEnd }, estimatedValue: { not: null }, intentRating: 3 },
        _sum: { estimatedValue: true }, _count: { id: true },
      }),
      prisma.lead.aggregate({
        where: { ...leadWhere, status: 'ACTIVE', stage: { in: [...FORECAST_PP_STAGES] }, expectedObDate: { gte: targetCycle.cycleStart, lte: targetCycle.cycleEnd }, estimatedValue: { not: null }, intentRating: { gte: 1, lte: 2 } },
        _sum: { estimatedValue: true }, _count: { id: true },
      }),
    ]);

    // ── Compute derived values ────────────────────────────────────────────────

    // Active project counts
    const healthMap: Record<string, number> = {};
    for (const g of projectHealthGroups) healthMap[g.health] = g._count.id;
    const activeProjectsTotal = Object.values(healthMap).reduce((a, b) => a + b, 0);

    // Stage funnel values map
    const stageFunnelValues: Record<string, number> = {};
    for (const g of stageFunnelValueGroups) {
      stageFunnelValues[g.stage] = g._sum.estimatedValue ? Number(g._sum.estimatedValue) : 0;
    }

    // NPS last month per stage helper
    const npsLastMonthGrouped: Record<string, number[]> = {};
    for (const r of npsLastMonthRaw) {
      if (r.score !== null) {
        if (!npsLastMonthGrouped[r.stage]) npsLastMonthGrouped[r.stage] = [];
        npsLastMonthGrouped[r.stage].push(r.score);
      }
    }
    const npsLastMonthAvg = (stage: string) => {
      const scores = npsLastMonthGrouped[stage];
      if (!scores?.length) return null;
      return +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
    };

    // NPS trend — group by year-month
    const trendMap: Record<string, Record<string, number[]>> = {};
    for (const r of npsTrendRaw) {
      if (!r.respondedAt || r.score === null) continue;
      const ym = `${r.respondedAt.getFullYear()}-${String(r.respondedAt.getMonth() + 1).padStart(2, '0')}`;
      if (!trendMap[ym]) trendMap[ym] = {};
      if (!trendMap[ym][r.stage]) trendMap[ym][r.stage] = [];
      trendMap[ym][r.stage].push(r.score);
    }
    // Build 6-month series (last 6 months including current)
    const trendMonths: string[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      trendMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const monthLabel = (ym: string) => {
      const [y, m] = ym.split('-');
      return new Date(Number(y), Number(m) - 1, 1).toLocaleString('en-IN', { month: 'short', year: '2-digit' });
    };
    const avgArr = (arr: number[] | undefined) => arr?.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;
    const npsTrend = trendMonths.map((ym) => ({
      month: monthLabel(ym),
      SALE: avgArr(trendMap[ym]?.['SALE']),
      DESIGN_FREEZE: avgArr(trendMap[ym]?.['DESIGN_FREEZE']),
      SIGN_OFF: avgArr(trendMap[ym]?.['SIGN_OFF']),
    }));

    // Design progress — project phase groups from active projects list
    const DESIGN_PHASE_LABELS: Record<string, string> = {
      DESIGN: 'Design Development',
      TECHNICAL: 'Technical',
      PRODUCTION: 'Production',
      SITE_EXECUTION: 'Site Execution',
      HANDOVER: 'Handover',
      COMPLETED: 'Completed',
    };
    const phaseCountMap: Record<string, number> = {};
    for (const p of activeProjectsList) {
      phaseCountMap[p.phase] = (phaseCountMap[p.phase] ?? 0) + 1;
    }
    const designProgress = Object.entries(DESIGN_PHASE_LABELS).map(([phase, label]) => ({
      phase, label, count: phaseCountMap[phase] ?? 0,
    }));

    // Keep sales/onboarding lead health separate from project health so both
    // populations remain visible in the dashboard rather than competing for
    // the same limited list of cards.
    const clientHealth = {
      leads: preProjectHealthLeads.map((lead) => ({
        id: lead.id,
        clientName: lead.name,
        leadId: lead.leadId,
        leadDbId: lead.id,
        stage: lead.stage,
        health: lead.slaBreaches.length > 0 || lead.attentionFlags.length > 0 ? 'AT_RISK' : 'ON_TRACK',
        attentionCount: lead.slaBreaches.length + lead.attentionFlags.length,
      })),
      projects: activeProjectsList.map((project) => ({
        id: project.id,
        projectCode: project.projectCode,
        clientName: project.lead.name,
        leadId: project.lead.leadId,
        leadDbId: project.lead.id,
        health: project.health,
        attentionCount: project.attentionFlags.length,
      })),
    };

    // Leaderboard — compute per peer
    const peerBookingMap: Record<string, number> = {};
    for (const g of peerBookingGroups) {
      if (g.assignedDesignerId) peerBookingMap[g.assignedDesignerId] = Number(g._sum.estimatedValue ?? 0);
    }
    const peerNpsMap: Record<string, number[]> = {};
    for (const r of peerNpsRaw) {
      const did = r.lead?.assignedDesignerId;
      if (did && r.score !== null) {
        if (!peerNpsMap[did]) peerNpsMap[did] = [];
        peerNpsMap[did].push(r.score);
      }
    }
    const leaderboard = peerUsers
      .map((peer) => ({
        userId: peer.id,
        name: peer.name,
        bookingValue: peerBookingMap[peer.id] ?? 0,
        npsAvg: avgArr(peerNpsMap[peer.id]),
        isCurrentUser: peer.id === user.id,
      }))
      .sort((a, b) => b.bookingValue - a.bookingValue)
      .map((peer, idx) => ({ ...peer, rank: idx + 1 }));

    // Forecast — linear projection from elapsed days in the active 16th–15th
    // target cycle, not from the calendar month.
    const cycleDurationDays = Math.ceil(
      (targetCycle.cycleEnd.getTime() - targetCycle.cycleStart.getTime() + 1) / 86400000,
    );
    const cycleDaysElapsed = Math.min(
      cycleDurationDays,
      Math.max(1, Math.floor((now.getTime() - targetCycle.cycleStart.getTime()) / 86400000) + 1),
    );
    const projFactor = cycleDurationDays / cycleDaysElapsed;
    const bookingAchieved = bookingAchievedAgg._sum.estimatedValue ? Number(bookingAchievedAgg._sum.estimatedValue) : 0;
    const poAchieved = Number(poAchievedAgg._sum.amount ?? 0);

    // Incentive estimate (placeholder — no incentive model in schema; derived from tier)
    const tierRates: Record<string, number> = { BASIC: 0.01, STANDARD: 0.015, PREMIUM: 0.02 };
    const tierRate = tierRates[designerRecord?.performanceTier ?? 'BASIC'] ?? 0.01;
    const coreCreditsEarned = Math.floor(bookingAchieved / 100000);
    const nextMilestoneCredits = (Math.floor(coreCreditsEarned / 5) + 1) * 5;
    const nextMilestoneBooking = nextMilestoneCredits * 100000;
    const incentiveEarned = Math.round(bookingAchieved * tierRate);
    const incentiveForecast = Math.round(incentiveEarned * projFactor);

    // Credits shown to designers come from the credit calculator (current 16th–15th cycle), not the tier placeholder above.
    let creditUnavailableReason = 'Credits could not be calculated. No estimated credits are substituted.';
    const realCredits = user.role === 'DESIGNER'
      ? await calculateDesignerCredits(user.id, getCycleForDate(new Date()), (await loadIncentiveConfig()).config).catch((error) => {
        if (error instanceof CancellationReviewRequired) creditUnavailableReason = error.message;
        return null;
      })
      : null;

    const forecastTier = (aggregate: { _sum: { estimatedValue: any }; _count: { id: number } }) => ({
      count: aggregate._count.id,
      value: Number(aggregate._sum.estimatedValue ?? 0),
    });

    // Sales Performance Score: three equal, capped components. NPS and TAT are
    // supporting metrics only and never affect this calculation.
    const bookingCount = bookingAchievedAgg._count.id;
    const conversionActualPct = leadsReceivedInCycle > 0
      ? (bookingCount / leadsReceivedInCycle) * 100
      : null;
    const averageBookingValue = bookingCount > 0 ? bookingAchieved / bookingCount : null;
    const cappedTargetScore = (actual: number | null, target: number | null) =>
      actual != null && target != null && target > 0 ? Math.min(100, (actual / target) * 100) : null;
    const conversionComponent = cappedTargetScore(
      conversionActualPct,
      designerTarget?.conversionTargetPct == null ? null : Number(designerTarget.conversionTargetPct),
    );
    const targetAchievementComponent = cappedTargetScore(
      bookingAchieved,
      designerTarget ? Number(designerTarget.bookingTargetValue) : null,
    );
    const averageBookingValueComponent = cappedTargetScore(
      averageBookingValue,
      designerTarget?.averageBookingValueTarget == null ? null : Number(designerTarget.averageBookingValueTarget),
    );
    const scoreComponents = [conversionComponent, targetAchievementComponent, averageBookingValueComponent];
    const overallScore = scoreComponents.every((score): score is number => score != null)
      ? +(scoreComponents.reduce((sum, score) => sum + score, 0) / 3).toFixed(1)
      : null;
    const allTatDays = [...tatDaysByStage.entries()]
      .filter(([stage]) => stage !== 'MQL')
      .flatMap(([, days]) => days);
    const averageTatDays = allTatDays.length
      ? +(allTatDays.reduce((sum, days) => sum + days, 0) / allTatDays.length).toFixed(1)
      : null;
    const overallScoreDetail = {
      overall: overallScore,
      components: [
        { name: 'Conversion %', actual: conversionActualPct, target: designerTarget?.conversionTargetPct == null ? null : Number(designerTarget.conversionTargetPct), score: conversionComponent },
        { name: 'Target Achievement %', actual: bookingAchieved, target: designerTarget ? Number(designerTarget.bookingTargetValue) : null, score: targetAchievementComponent },
        { name: 'Average Booking Value', actual: averageBookingValue, target: designerTarget?.averageBookingValueTarget == null ? null : Number(designerTarget.averageBookingValueTarget), score: averageBookingValueComponent },
      ],
      averageTatDays,
      averageNps: avgNPS,
    };

    // Design Score remains a separate future-facing placeholder.
    const tierScoreBase: Record<string, number> = { BASIC: 45, STANDARD: 65, PREMIUM: 82 };
    const perfBase = tierScoreBase[designerRecord?.performanceTier ?? 'BASIC'] ?? 45;
    const designCategories = [
      { name: 'Design Performance', score: Math.min(Math.round(perfBase - 3), 95), weight: 50 },
      { name: 'Timeline Adherence', score: Math.min(Math.round(perfBase + 2), 95), weight: 50 },
    ];
    const designScore = {
      overall: Math.round((designCategories[0].score + designCategories[1].score) / 2),
      tier: designerRecord?.performanceTier ?? 'BASIC',
      categories: designCategories,
    };

    designerDash = {
      activeProjects: {
        total: activeProjectsTotal,
        onTrack: healthMap['ON_TRACK'] ?? 0,
        atRisk: healthMap['AT_RISK'] ?? 0,
        delayed: healthMap['DELAYED'] ?? 0,
      },
      bookingAchieved,
      bookingTarget: designerTarget ? Number(designerTarget.bookingTargetValue) : null,
      poAchieved,
      poTarget: designerTarget ? Number(designerTarget.poTargetValue) : null,
      targetCycle: { cycleStart: targetCycle.cycleStart, cycleEnd: targetCycle.cycleEnd, label: targetCycle.label },
      incentive: {
        walletBalance: incentiveEarned,
        projectedEarnings: incentiveForecast,
        coreCreditsEarned: realCredits?.core.total ?? null,
        calculationAvailable: realCredits !== null,
        unavailableReason: realCredits ? null : creditUnavailableReason,
        coreCreditsTotal: nextMilestoneCredits,
        boosterCredits: realCredits?.booster.total ?? null,
        totalCredits: realCredits?.totalCredits ?? null,
        tier: designerRecord?.performanceTier ?? 'BASIC',
        nextMilestoneCredits: nextMilestoneCredits - coreCreditsEarned,
        nextMilestoneBooking: Math.max(0, nextMilestoneBooking - bookingAchieved),
        furnitureIncentive: Math.round(bookingAchieved * 0.002),
        portfolioIncentive: coreCreditsEarned >= 5 ? 5000 : 0,
        potentialEarnings: incentiveForecast + Math.round(bookingAchieved * 0.002),
      },
      npsThisMonth: {
        SALE: salesNps,
        ONBOARDING: obNps,
        DESIGN_FREEZE: designFreezeNps,
        SIGN_OFF: signOffNps,
      },
      npsLastMonth: {
        SALE: npsLastMonthAvg('SALE'),
        ONBOARDING: npsLastMonthAvg('ONBOARDING'),
        DESIGN_FREEZE: npsLastMonthAvg('DESIGN_FREEZE'),
        SIGN_OFF: npsLastMonthAvg('SIGN_OFF'),
      },
      npsTrend,
      designProgress,
      deadlines: { today: deadlinesToday, tomorrow: deadlinesTomorrow, thisWeek: deadlinesThisWeek, nextWeek: deadlinesNextWeek },
      leaderboard,
      clientHealth,
      // CRE users don't receive deliveryWidgets.needsAttention (that block is
      // skipped for CRE). We derive the equivalent list here so both DESIGNER
      // and CRE roles see real attention data on their dashboard.
      attentionItems: activeProjectsList
        .filter((p) => p.attentionFlags.length > 0)
        .slice(0, 20)
        .map((p) => ({
          projectId: p.id,
          projectCode: p.projectCode,
          clientName: p.lead.name,
          leadId: p.lead.leadId,
          category: p.attentionFlags[0]?.category ?? '',
          description: p.attentionFlags[0]?.description ?? '',
          daysOverdue: p.attentionFlags[0]?.createdAt
            ? Math.floor((Date.now() - p.attentionFlags[0].createdAt.getTime()) / 86400000)
            : 0,
        })),
      forecast: {
        from: targetCycle.cycleStart,
        to: targetCycle.cycleEnd,
        highIntent: forecastTier(highIntentForecastAgg),
        mediumIntent: forecastTier(mediumIntentForecastAgg),
        lowIntent: forecastTier(lowIntentForecastAgg),
      },
      recentNotifications: recentNotifications.map((n) => ({
        id: n.id,
        type: n.type,
        message: n.message,
        leadId: n.leadId,
        isRead: n.isRead,
        createdAt: n.createdAt.toISOString(),
        lead: n.lead ? { id: n.lead.id, leadId: n.lead.leadId, name: n.lead.name } : null,
      })),
      stageFunnelValues,
      overallScore: overallScoreDetail,
      designScore,
    };
  }

  // ── Monthly threshold medals ───────────────────────────────────────────────
  // Medals are calculated live for the same IST 16th–15th cycle as targets.
  // This is deliberately a threshold system, never a peer-ranking system.
  let medal: any = null;
  if (user.role === 'DESIGNER' || user.role === 'BL' || user.role === 'DESIGN_MANAGER') {
    const medalCycle = getCycleForDate(new Date());
    const medalMembers = user.role === 'DESIGNER'
      ? [{ id: user.id, name: user.name }]
      : await prisma.user.findMany({
          where: user.role === 'BL'
            ? { blId: user.id, role: 'DESIGNER', isActive: true }
            : { designManagerId: user.id, role: 'DESIGNER', isActive: true },
          select: { id: true, name: true },
        });
    const memberIds = medalMembers.map((member) => member.id);

    if (memberIds.length) {
      const [targets, dipGroups, poCollections] = await Promise.all([
        prisma.designerTarget.findMany({
          where: { designerId: { in: memberIds }, cycleStart: medalCycle.cycleStart },
        }),
        prisma.lead.groupBy({
          by: ['assignedDesignerId'],
          where: {
            assignedDesignerId: { in: memberIds },
            status: { not: 'INACTIVE' },
            activityLogs: {
              some: {
                action: 'STAGE_CHANGED',
                createdAt: { gte: medalCycle.cycleStart, lte: medalCycle.cycleEnd },
                meta: { path: ['to'], equals: 'DESIGN_IN_PROGRESS' },
              },
            },
            dipChecklist: { completedAt: { not: null } },
          },
          _sum: { estimatedValue: true },
          _count: { id: true },
        }),
        prisma.collection.findMany({
          where: {
            status: 'COLLECTED',
            collectedAt: { gte: medalCycle.cycleStart, lte: medalCycle.cycleEnd },
            project: { designerId: { in: memberIds } },
          },
          select: { amount: true, project: { select: { designerId: true } } },
        }),
      ]);

      const targetByMember = new Map(targets.map((target) => [target.designerId, target]));
      const dipByMember = new Map(dipGroups.map((group) => [group.assignedDesignerId, {
        bookingActual: Number(group._sum.estimatedValue ?? 0),
        dipActual: group._count.id,
      }]));
      const poByMember = new Map<string, number>();
      for (const collection of poCollections) {
        const designerId = collection.project.designerId;
        if (designerId) poByMember.set(designerId, (poByMember.get(designerId) ?? 0) + collection.amount);
      }

      const percent = (actual: number, target: number | null) =>
        target != null && target > 0 ? +((actual / target) * 100).toFixed(1) : null;
      const medalFor = (score: number | null) =>
        score == null ? null : score >= 100 ? 'GOLD' : score >= 90 ? 'SILVER' : score >= 80 ? 'BRONZE' : null;
      const memberMetrics = medalMembers.map((member) => {
        const target = targetByMember.get(member.id);
        const actual = dipByMember.get(member.id) ?? { bookingActual: 0, dipActual: 0 };
        const bookingTarget = target ? Number(target.bookingTargetValue) : null;
        const poTarget = target ? Number(target.poTargetValue) : null;
        const dipTarget = target?.dipTargetCount ?? null;
        const bookingPct = percent(actual.bookingActual, bookingTarget);
        const poPct = percent(poByMember.get(member.id) ?? 0, poTarget);
        const salesPct = bookingPct != null && poPct != null ? +((bookingPct + poPct) / 2).toFixed(1) : null;
        const designDipPct = percent(actual.dipActual, dipTarget);
        return { ...member, bookingActual: actual.bookingActual, bookingTarget, poActual: poByMember.get(member.id) ?? 0, poTarget, dipActual: actual.dipActual, dipTarget, salesPct, designDipPct };
      });

      if (user.role === 'DESIGNER') {
        const own = memberMetrics[0];
        const score = own.salesPct != null && own.designDipPct != null
          ? +((own.salesPct + own.designDipPct) / 2).toFixed(1)
          : null;
        medal = { role: 'DESIGNER', cycle: medalCycle, score, medal: medalFor(score), salesPct: own.salesPct, designDipPct: own.designDipPct, bookingActual: own.bookingActual, bookingTarget: own.bookingTarget, poActual: own.poActual, poTarget: own.poTarget, dipActual: own.dipActual, dipTarget: own.dipTarget };
      } else if (user.role === 'BL' && memberMetrics.every((member) => member.salesPct != null)) {
          const score = +((memberMetrics.reduce((sum, member) => sum + member.salesPct!, 0) / memberMetrics.length)).toFixed(1);
          medal = { role: 'BL', cycle: medalCycle, score, medal: medalFor(score), salesPct: score, teamSize: memberMetrics.length };
      } else if (user.role === 'DESIGN_MANAGER' && memberMetrics.every((member) => member.dipTarget != null && member.dipTarget > 0)) {
          const dipActual = memberMetrics.reduce((sum, member) => sum + member.dipActual, 0);
          const dipTarget = memberMetrics.reduce((sum, member) => sum + member.dipTarget!, 0);
          const score = percent(dipActual, dipTarget);
          medal = { role: 'DESIGN_MANAGER', cycle: medalCycle, score, medal: medalFor(score), designDipPct: score, dipActual, dipTarget, teamSize: memberMetrics.length };
      }
    }
  }

  res.json({
    totalLeads,
    // Always-current count of active leads (status ACTIVE, excluding the
    // terminal DESIGN_IN_PROGRESS/HANDED_OVER stages) — unlike totalLeads,
    // this is NOT scoped to the createdAt date range, so it reflects the
    // real current pipeline even when no new leads were created this period.
    activeLeads,
    activeLeadsValue,
    activeProjectsDip,
    obProgress,
    revenueGenerated,
    leadsToday,
    leadsThisWeek,
    leadsThisMonth,
    pipelineValue,
    avgNPS,
    npsBreakdown: { salesNps, obNps, designFreezeNps, signOffNps },
    collectedThisMonth,
    outstanding,
    stageFunnel,
    sourceBreakdown,
    conversionRates,
    stageConversion,
    totalLeadsReceived,
    slaBreaches: {
      activeCount: slaBreachTotal,
      list: slaBreaches,
    },
    teamActivity: {
      callsToday,
      stagesMovedToday,
      tasksCompletedToday,
    },
    personalStats,
    blStats,
    ...(deliveryWidgets && {
      phaseLoad: deliveryWidgets.phaseLoad,
      needsAttention: deliveryWidgets.needsAttention,
      needsAttentionTotal: deliveryWidgets.needsAttentionTotal,
      collectionsDue: deliveryWidgets.collectionsDue,
      inDelivery: deliveryWidgets.inDelivery,
    }),
    ...(designerDash && { designerDash }),
    medal,
    dateRange: { from: rangeFrom.toISOString(), to: rangeTo.toISOString() },
  });
});

// ── GET /api/dashboard/work-items ─────────────────────────────────────────────
// Unified upcoming-work feed for the Designer Dashboard's "Today's Focus" panel.
// Returns open tasks (next 14 days + overdue), upcoming meetings, and SLA-breached
// leads for the requesting user as a flat typed array sorted by dueAt.
// The client groups items into Overdue / Today / Tomorrow / This Week / Later buckets.
dashboardRouter.get('/work-items', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const now = new Date();
    const twoWeeksOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    // Scope meetings and SLA-breach leads to the requesting user's assignments.
    // Tasks are always scoped by assignedToId = user.id regardless of role.
    let meetingLeadWhere: any = {};
    let slaLeadWhere: any = {};
    if (user.role === 'DESIGNER' || user.role === 'CRE') {
      meetingLeadWhere = { assignedDesignerId: user.id };
      slaLeadWhere    = { assignedDesignerId: user.id };
    } else if (user.role === 'BL') {
      const members = await prisma.user.findMany({
        where: { blId: user.id },
        select: { id: true },
      });
      const teamIds = [user.id, ...members.map((m: any) => m.id)];
      meetingLeadWhere = { OR: [{ assignedBLId: user.id }, { assignedDesignerId: { in: teamIds } }] };
      slaLeadWhere    = meetingLeadWhere;
    }
    // BRANCH_HEAD: no lead filter → sees everything

    const [tasks, meetings, slaLeads] = await Promise.all([
      prisma.followUpTask.findMany({
        where: {
          assignedToId: user.id,
          isCompleted: false,
          status: 'PENDING',
          dueDate: { lte: twoWeeksOut },
        },
        select: {
          id: true, agenda: true, dueDate: true, dueTime: true, isOverdue: true,
          lead: { select: { id: true, leadId: true, name: true } },
        },
        orderBy: { dueDate: 'asc' },
        take: 50,
      }),
      prisma.meeting.findMany({
        where: {
          status: 'SCHEDULED',
          scheduledAt: { gte: now, lte: twoWeeksOut },
          lead: { ...meetingLeadWhere, status: 'ACTIVE' },
        },
        select: {
          id: true, type: true, scheduledAt: true, mode: true,
          lead: { select: { id: true, leadId: true, name: true } },
        },
        orderBy: { scheduledAt: 'asc' },
        take: 30,
      }),
      prisma.lead.findMany({
        where: {
          ...slaLeadWhere,
          status: 'ACTIVE',
          stage: { notIn: ['HANDED_OVER', 'DESIGN_IN_PROGRESS', 'ONBOARDING'] },
          slaBreaches: { some: { resolvedAt: null } },
        },
        select: { id: true, leadId: true, name: true, stage: true },
        take: 20,
      }),
    ]);

    type WorkItem = {
      id: string; type: 'TASK' | 'MEETING' | 'SLA_BREACH'; dueAt: string;
      title: string; subtitle?: string; leadId: string; leadDisplayId: string; leadName: string;
    };

    const items: WorkItem[] = [];

    for (const t of tasks) {
      const iso = (t.dueDate instanceof Date ? t.dueDate : new Date(t.dueDate)).toISOString();
      const dueAt = iso.slice(0, 10) + (t.dueTime ? `T${t.dueTime}:00.000Z` : 'T00:00:00.000Z');
      items.push({
        id: t.id, type: 'TASK', dueAt,
        title: t.agenda ?? 'Follow-up task',
        subtitle: t.dueTime ?? undefined,
        leadId: t.lead?.id ?? '', leadDisplayId: t.lead?.leadId ?? '', leadName: t.lead?.name ?? '',
      });
    }

    for (const m of meetings) {
      items.push({
        id: m.id, type: 'MEETING', dueAt: m.scheduledAt.toISOString(),
        title: m.type.replace(/_/g, ' '),
        subtitle: m.mode ?? undefined,
        leadId: m.lead.id, leadDisplayId: m.lead.leadId, leadName: m.lead.name,
      });
    }

    for (const l of slaLeads) {
      // Use epoch as sentinel so SLA-breach cards always sort to the top (Overdue bucket).
      items.push({
        id: l.id, type: 'SLA_BREACH', dueAt: new Date(0).toISOString(),
        title: `SLA breach — ${l.stage.replace(/_/g, ' ')}`,
        leadId: l.id, leadDisplayId: l.leadId, leadName: l.name,
      });
    }

    items.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
    res.json({ items });
  } catch (err: any) {
    console.error('[dashboard/work-items]', err.message);
    res.status(500).json({ error: err.message });
  }
});
