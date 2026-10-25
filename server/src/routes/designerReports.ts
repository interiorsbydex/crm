// Designer-role reports (My Performance, Lead Funnel, ...). Handlers here do
// their own role scoping and never trust designerId/blId query parameters to
// widen scope. Existing /api/reports handlers are intentionally untouched.
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { getCycleForDate, type TargetCycle } from '../lib/targetCycle.js';
import { loadCompletedPitches } from '../lib/completedPitches.js';
import { loadBookingCancellations } from '../lib/bookingCancellations.js';
import { meetingCommitments } from '../lib/meetingCommitments.js';
import { loadBlHeldPerformance } from '../lib/blHeldPerformance.js';

export const designerReportsRouter = Router();

export const DAY_MS = 86_400_000;

// ── Scope ─────────────────────────────────────────────────────────────────────
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Scope = { designerIds: string[]; designers: { id: string; name: string }[] };

/**
 * DESIGNER: self only. BL: designers with users.blId = BL id. BRANCH_HEAD: all
 * active designers. `designerId` may only narrow within that permitted set.
 */
async function resolveScope(
  user: { id: string; role: string },
  designerIdParam: unknown,
): Promise<Scope> {
  let designers: { id: string; name: string }[];
  if (user.role === 'DESIGNER') {
    designers = await prisma.user.findMany({ where: { id: user.id }, select: { id: true, name: true } });
  } else if (user.role === 'BL') {
    designers = await prisma.user.findMany({
      where: { blId: user.id, role: 'DESIGNER', isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  } else if (user.role === 'BRANCH_HEAD') {
    designers = await prisma.user.findMany({
      where: { role: 'DESIGNER', isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  } else {
    throw new HttpError(403, 'Designer reports are available to DESIGNER, BL and BRANCH_HEAD only');
  }
  if (user.role !== 'DESIGNER' && typeof designerIdParam === 'string' && designerIdParam) {
    const picked = designers.find((d) => d.id === designerIdParam);
    if (!picked) throw new HttpError(403, 'Designer is outside your permitted scope');
    return { designerIds: [picked.id], designers };
  }
  return { designerIds: designers.map((d) => d.id), designers };
}

// ── Cycles ────────────────────────────────────────────────────────────────────
function parseDate(value: unknown, field: string): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `Invalid ${field}`);
  return d;
}

/** Default: cycle containing today. `from`/`to` spanning cycles => one block per cycle. */
function resolveCycles(q: Record<string, unknown>): TargetCycle[] {
  const from = parseDate(q.from, 'from');
  const to = parseDate(q.to, 'to');
  if (!from && !to) return [getCycleForDate(new Date())];
  const start = from ?? to!;
  const end = to ?? from!;
  if (end.getTime() < start.getTime()) throw new HttpError(400, '`to` is before `from`');
  const cycles: TargetCycle[] = [];
  let c = getCycleForDate(start);
  while (c.cycleStart.getTime() <= end.getTime()) {
    cycles.push(c);
    if (cycles.length > 24) throw new HttpError(400, 'Range spans more than 24 cycles');
    c = getCycleForDate(new Date(c.cycleEnd.getTime() + 1));
  }
  return cycles;
}

const inCycle = (d: Date, c: TargetCycle) => d >= c.cycleStart && d <= c.cycleEnd;

// ── Stage-log helpers ─────────────────────────────────────────────────────────
export type FirstEntries = Map<string, Map<string, Date>>; // leadId -> stage -> first createdAt

/** First STAGE_CHANGED log per (lead, meta.to). */
export async function loadFirstStageEntries(leadIds: string[]): Promise<FirstEntries> {
  const map: FirstEntries = new Map();
  if (!leadIds.length) return map;
  const logs = await prisma.activityLog.findMany({
    where: { leadId: { in: leadIds }, action: 'STAGE_CHANGED' },
    select: { leadId: true, createdAt: true, meta: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const log of logs) {
    const to = (log.meta as { to?: string } | null)?.to;
    if (!log.leadId || !to) continue;
    let perLead = map.get(log.leadId);
    if (!perLead) { perLead = new Map(); map.set(log.leadId, perLead); }
    if (!perLead.has(to)) perLead.set(to, log.createdAt);
  }
  return map;
}

/** MQL Received Date: first log with meta.to = 'MQL', else leadOriginDate. */
export function mqlReceived(
  entries: FirstEntries, lead: { id: string; leadOriginDate: Date },
): { date: Date; fallback: boolean } {
  const logged = entries.get(lead.id)?.get('MQL');
  return logged ? { date: logged, fallback: false } : { date: lead.leadOriginDate, fallback: true };
}

export const round1 = (n: number) => +n.toFixed(1);

// ── Report 1: My Performance ──────────────────────────────────────────────────
// Dashboard "won" condition (dashboard.ts:194-202).
export const DASHBOARD_ONBOARDING_OR = [
  { stage: 'DESIGN_IN_PROGRESS', dipChecklist: { completedAt: { not: null } } },
  { stage: 'HANDED_OVER', dipChecklist: { completedAt: { not: null } } },
] as const;

// `leadFilter` is optional (used by BL/Admin reports): an extra lead-level condition AND-ed onto the
// scoped base. Omitted => `base` is exactly what it was before.
export async function myPerformance(user: { id: string; role: string }, q: Record<string, unknown>, leadFilter?: Record<string, unknown>) {
  const scope = await resolveScope(user, q.designerId);
  const cycles = resolveCycles(q);
  const base: any = { assignedDesignerId: { in: scope.designerIds }, isTestLead: false, ...(leadFilter ? { AND: [leadFilter] } : {}) };

  // Onboarding candidates: dashboard condition (dashboard.ts:194-202) + not test.
  const candidates = await prisma.lead.findMany({
    where: { ...base, OR: DASHBOARD_ONBOARDING_OR as any },
    select: { id: true, leadId: true, name: true, leadOriginDate: true, estimatedValue: true },
  });
  const allScopeLeads = await prisma.lead.findMany({
    where: base,
    select: { id: true, leadOriginDate: true },
  });
  const entries = await loadFirstStageEntries(allScopeLeads.map((l) => l.id));
  const completedPp = await loadCompletedPitches(base);
  const noDipLog = candidates.filter((l) => !entries.get(l.id)?.has('DESIGN_IN_PROGRESS'));
  // Leads that reached Design in Progress but whose DIP checklist is not completed. They are NOT counted
  // as onboarded / booked here (dashboard definition) although the Lead Funnel counts them as converted.
  const dipChecklistPending = await prisma.lead.findMany({
    where: { ...base, stage: { in: ['DESIGN_IN_PROGRESS', 'HANDED_OVER'] }, NOT: { dipChecklist: { completedAt: { not: null } } } },
    select: { id: true, leadId: true, name: true },
  });

  // Dashboard snapshot reference (dashboard.ts:194-202): no period, test leads
  // NOT excluded, same scope.
  const snapshot = await prisma.lead.count({
    where: { assignedDesignerId: { in: scope.designerIds }, status: { not: 'INACTIVE' }, OR: DASHBOARD_ONBOARDING_OR as any },
  });

  let fallbackCount = 0;
  const blocks = [];
  for (const cycle of cycles) {
    const cancellations = await loadBookingCancellations(base, cycle);
    // Booking Value — dashboard.ts:696-717 verbatim, plus isTestLead=false via `base`.
    const bookingWhere: any = {
      ...base,
      id: { notIn: cancellations.excludedLeadIds },
      activityLogs: {
        some: {
          action: 'STAGE_CHANGED',
          createdAt: { gte: cycle.cycleStart, lte: cycle.cycleEnd },
          meta: { path: ['to'], equals: 'DESIGN_IN_PROGRESS' },
        },
      },
      estimatedValue: { not: null },
      dipChecklist: { completedAt: { not: null } },
    };
    const [bookingAgg, bookingLeads, leadsReceived, targets] = await Promise.all([
      prisma.lead.aggregate({ where: bookingWhere, _sum: { estimatedValue: true }, _count: { id: true } }),
      prisma.lead.findMany({
        where: bookingWhere,
        select: { id: true, leadId: true, name: true, estimatedValue: true },
      }),
      // Conversion denominator — dashboard.ts:720-725.
      prisma.lead.findMany({
        where: { ...base, leadOriginDate: { gte: cycle.cycleStart, lte: cycle.cycleEnd } },
        select: { id: true, leadId: true, name: true },
      }),
      prisma.designerTarget.findMany({
        where: { designerId: { in: scope.designerIds }, cycleStart: cycle.cycleStart },
        select: { designerId: true, bookingTargetValue: true },
      }),
    ]);
    const bookingValue = Number(bookingAgg._sum.estimatedValue ?? 0);
    const bookingCount = bookingAgg._count.id;
    const conversionPct = leadsReceived.length > 0 ? round1((bookingCount / leadsReceived.length) * 100) : null;

    // Onboardings: dashboard condition AND first DIP log inside this cycle.
    const onboardings = candidates
      .map((l) => ({ l, dip: entries.get(l.id)?.get('DESIGN_IN_PROGRESS') }))
      .filter((x): x is { l: typeof candidates[number]; dip: Date } =>
        !!x.dip && inCycle(x.dip, cycle) && !cancellations.excludedLeadIds.includes(x.l.id));
    const tatRows = onboardings.map(({ l, dip }) => {
      const mql = mqlReceived(entries, l);
      if (mql.fallback) fallbackCount += 1;
      const days = (dip.getTime() - mql.date.getTime()) / DAY_MS;
      return { id: l.id, leadId: l.leadId, name: l.name, mqlDate: mql.date, onboardingDate: dip, mqlFallback: mql.fallback, days: round1(days) };
    });
    const withinSeven = tatRows.filter((r) => r.days <= 7).length;

    const proposalDetail = completedPp.inPeriod({ from: cycle.cycleStart, to: cycle.cycleEnd }).pitches
      .map(({ id, leadId, name }) => ({ id, leadId, name }));

    const nps = await prisma.nPSResponse.findMany({
      where: {
        score: { not: null },
        respondedAt: { gte: cycle.cycleStart, lte: cycle.cycleEnd },
        lead: base,
      },
      select: { score: true },
    });
    const avgNps = nps.length ? round1(nps.reduce((a, r) => a + (r.score ?? 0), 0) / nps.length) : null;

    const monthlyTarget = targets.length
      ? targets.reduce((a, t) => a + Number(t.bookingTargetValue), 0)
      : null;

    blocks.push({
      cycle: { label: cycle.label, cycleStart: cycle.cycleStart, cycleEnd: cycle.cycleEnd },
      cancellationReview: cancellations.pendingReview,
      effort: {
        proposalPresentedCount: proposalDetail.length,
        pitchCompletionDatesMissing: completedPp.all.missingCompletionDates,
        leadToOnboardingTatAvgDays: tatRows.length ? round1(tatRows.reduce((a, r) => a + r.days, 0) / tatRows.length) : null,
        onboardingWithin7DaysPct: tatRows.length ? round1((withinSeven / tatRows.length) * 100) : null,
        onboardingWithin7DaysNumerator: withinSeven,
        averageNps: avgNps,
        npsResponsesCounted: nps.length,
      },
      result: {
        onboardingCount: onboardings.length,
        onboardingsUsedInTat: tatRows.length,
        onboardingsExcludedNoDipLog: noDipLog.length,
        bookingValue,
        bookingCount,
        leadsReceived: leadsReceived.length,
        conversionPct,
      },
      target: {
        monthlyTarget,
        cumulativeAchievement: bookingValue,
        remainingTarget: monthlyTarget == null ? null : monthlyTarget - bookingValue,
        note: monthlyTarget == null ? 'No designer_targets row for this cycle' : null,
      },
      drilldown: {
        onboardings: tatRows,
        bookings: bookingLeads.map((l) => ({ ...l, estimatedValue: Number(l.estimatedValue) })),
        leadsReceived,
        proposalPresented: proposalDetail,
      },
    });
  }

  return {
    scope: { designers: scope.designers, selectedDesignerIds: scope.designerIds },
    ...(user.role === 'BL' && !(typeof q.designerId === 'string' && q.designerId)
      ? { blHeld: await loadBlHeldPerformance(user.id, cycles, leadFilter) }
      : {}),
    dipChecklistPending,
    dashboardSnapshot: {
      label: 'Dashboard snapshot (all-time, current stage) — no period, test leads included',
      onboardingCount: snapshot,
    },
    mqlFallbackLeadsUsedInTat: fallbackCount,
    blocks,
  };
}

// ── Date range (reports 2-6) ──────────────────────────────────────────────────
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** `from`/`to` are YYYY-MM-DD IST calendar days; absent => unbounded on that side. */
export function resolveRange(q: Record<string, unknown>): { gte?: Date; lte?: Date } {
  const parse = (v: unknown, field: string) => {
    if (typeof v !== 'string' || !v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `Invalid ${field} (expected YYYY-MM-DD)`);
    return new Date(`${v}T00:00:00.000Z`);
  };
  const from = parse(q.from, 'from');
  const to = parse(q.to, 'to');
  if (from && to && to < from) throw new HttpError(400, '`to` is before `from`');
  const range: { gte?: Date; lte?: Date } = {};
  if (from) range.gte = new Date(from.getTime() - IST_OFFSET_MS);
  if (to) range.lte = new Date(to.getTime() + DAY_MS - 1 - IST_OFFSET_MS);
  return range;
}

// ── Report 2: My Lead Funnel ──────────────────────────────────────────────────
// Stage order = LeadStage enum order in prisma/schema.prisma, active funnel only
// (EFFECTIVE_LEAD, HANDED_OVER, INACTIVE, ON_HOLD are legacy/off-funnel). Same
// list as dashboard.ts PIPELINE_STAGES.
export const FUNNEL_STAGES = [
  'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION',
  'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS',
] as const;

export async function myLeadFunnel(user: { id: string; role: string }, q: Record<string, unknown>) {
  const scope = await resolveScope(user, q.designerId);
  const range = resolveRange(q);
  // Optional "as of" date (YYYY-MM-DD, IST): rebuild the pipeline as it stood at the end of that day
  // from the stage / status history logs. Leads created after that day are left out.
  let asOfEnd: Date | null = null;
  if (typeof q.asOf === 'string' && q.asOf) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.asOf)) throw new HttpError(400, '`asOf` must be YYYY-MM-DD');
    asOfEnd = new Date(Date.parse(`${q.asOf}T23:59:59.999Z`) - IST_OFFSET_MS);
  }
  // Cohort rule: non-test leads in scope, lead received (leadOriginDate) in the
  // range, currently on an active funnel stage. Mirrors dashboard
  // receivedFunnelWhere (dashboard.ts:91-95 / 262): isDuplicate excluded when the
  // viewer is a DESIGNER.
  const cohortWhere: any = {
    assignedDesignerId: { in: scope.designerIds },
    isTestLead: false,
    ...(user.role === 'DESIGNER' ? { isDuplicate: false } : {}),
    ...(!asOfEnd && (range.gte || range.lte) ? { leadOriginDate: range } : {}),
    ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
  };
  // Annie's "My Lead Funnel": every lead received (any status, incl. On Hold / Inactive
  // and legacy stages), counted by how far it got; split by current status.
  const cohort = await prisma.lead.findMany({
    where: cohortWhere,
    select: { id: true, leadId: true, name: true, stage: true, status: true, leadOriginDate: true, dipChecklist: { select: { completedAt: true } } },
  });
  const offFunnelCount = 0;
  const logs = cohort.length
    ? await prisma.activityLog.findMany({
      where: {
        leadId: { in: cohort.map((l) => l.id) },
        action: asOfEnd ? { in: ['STAGE_CHANGED', 'STATUS_CHANGED', 'LEAD_REACTIVATED'] } : 'STAGE_CHANGED',
        ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
      },
      select: { leadId: true, createdAt: true, meta: true, action: true },
      orderBy: { createdAt: 'asc' },
    })
    : [];
  // First forward arrival per stage (dashboard.ts getForwardStageTarget: skips isBackward).
  const first = new Map<string, Map<string, Date>>();
  const hasHistory = new Set<string>();
  const stageAt = new Map<string, string>();   // as-of mode: stage after the last stage log <= asOf
  const statusAt = new Map<string, string>();  // as-of mode: status after the last status log <= asOf
  const firstMqlLog = new Map<string, Date>(); // any direction, per the MQL Received Date rule
  for (const log of logs) {
    if (!log.leadId) continue;
    const meta = log.meta as { to?: string; isBackward?: boolean } | null;
    if (log.action === 'STATUS_CHANGED') { if (meta?.to) statusAt.set(log.leadId, meta.to); continue; }
    if (log.action === 'LEAD_REACTIVATED') { statusAt.set(log.leadId, 'ACTIVE'); continue; }
    hasHistory.add(log.leadId);
    if (meta?.to) stageAt.set(log.leadId, meta.to);
    if (meta?.to === 'MQL' && !firstMqlLog.has(log.leadId)) firstMqlLog.set(log.leadId, log.createdAt);
    if (!meta?.to || meta.isBackward === true || !(FUNNEL_STAGES as readonly string[]).includes(meta.to)) continue;
    const m = first.get(log.leadId) ?? new Map<string, Date>();
    if (!m.has(meta.to)) m.set(meta.to, log.createdAt);
    first.set(log.leadId, m);
  }
  // MQL Received Date per lead (first MQL log, else leadOriginDate).
  const mqlLookup: FirstEntries = new Map();
  for (const l of cohort) {
    const t = firstMqlLog.get(l.id);
    if (t) mqlLookup.set(l.id, new Map([['MQL', t]]));
  }
  const mql = new Map(cohort.map((l) => [l.id, mqlReceived(mqlLookup, l)]));
  const fallbackLeads = cohort.filter((l) => mql.get(l.id)!.fallback).length;

  if (asOfEnd) {
    for (const l of cohort) {
      l.stage = (stageAt.get(l.id) ?? 'MQL') as any;
      l.status = (statusAt.get(l.id) ?? 'ACTIVE') as any;
    }
  }
  const total = cohort.length;
  // Funnel position of a lead's stage; legacy HANDED_OVER sits at/after DIP, EFFECTIVE_LEAD is before MQL.
  const rank = (stage: string) => (stage === 'HANDED_OVER' ? FUNNEL_STAGES.length - 1 : FUNNEL_STAGES.indexOf(stage as any));
  // Rows in Annie's sheet. `stage` is the stage the lead must have reached (or passed).
  const FUNNEL_ROWS: { key: string; label: string; stage: string | null }[] = [
    { key: 'RECEIVED', label: 'Total Leads Received', stage: null },
    { key: 'MQL', label: 'MQL', stage: 'MQL' },
    { key: 'DQL', label: 'DQL', stage: 'DQL' },
    { key: 'PROPOSAL_PRESENTED', label: 'Proposal Presented', stage: 'PROPOSAL_PRESENTED' },
    { key: 'ONBOARDING', label: 'Onboarded (OB + OBM)', stage: 'ONBOARDING' },
    { key: 'CONVERSION', label: 'Conversion (DIP checklist completed)', stage: 'DESIGN_IN_PROGRESS' },
  ];
  const buildRows = (definitions: typeof FUNNEL_ROWS) => definitions.map((row) => {
    const minRank = row.stage ? FUNNEL_STAGES.indexOf(row.stage as any) : -Infinity;
    // Conversion counts only leads whose Design In Progress checklist is complete (Annie, definitions row 5).
    const reached = row.stage
      ? cohort.filter((l) => rank(l.stage) >= minRank && (row.key !== 'CONVERSION' || l.dipChecklist?.completedAt != null))
      : cohort;
    const by = (st: string) => reached.filter((l) => l.status === st).length;
    const tatDays: number[] = [];
    const rows = reached.map((l) => {
      const at = row.stage === 'MQL' ? mql.get(l.id)!.date : row.stage ? first.get(l.id)?.get(row.stage) : undefined;
      let tat: number | null = null;
      if (row.stage === 'MQL') tat = 0;
      else if (at) {
        const d = (at.getTime() - mql.get(l.id)!.date.getTime()) / DAY_MS;
        if (d >= 0) { tat = round1(d); }
      }
      // Avg TAT counts ACTIVE leads only (Annie's rule).
      if (tat != null && l.status === 'ACTIVE' && row.stage) tatDays.push(tat);
      return { id: l.id, leadId: l.leadId, name: l.name, currentStage: l.stage, status: l.status, reachedAt: row.stage === 'MQL' ? null : at ?? null, tatDays: tat };
    });
    return {
      stage: row.key,
      label: row.label,
      total: reached.length,
      active: by('ACTIVE'),
      onHold: by('ON_HOLD'),
      inactive: by('INACTIVE'),
      progressionPct: total > 0 ? round1((reached.length / total) * 100) : null,
      avgTatDays: row.stage && tatDays.length ? round1(tatDays.reduce((x, y) => x + y, 0) / tatDays.length) : null,
      tatSampleSize: tatDays.length,
      drilldown: rows,
    };
  });

  // Keep the existing six-row report contract. The dashboard's eight-stage
  // progression uses the same cohort, eligibility, percentages and TAT logic,
  // rather than mixing these cumulative rows with current-stage snapshot counts.
  const stages = buildRows(FUNNEL_ROWS);
  const progressionStages = buildRows([
    FUNNEL_ROWS[0],
    ...FUNNEL_STAGES.map((stage) => ({
      key: stage === 'DESIGN_IN_PROGRESS' ? 'CONVERSION' : stage,
      label: FUNNEL_ROWS.find((row) => row.stage === stage)?.label
        ?? (stage === 'PROPOSAL_READY' ? 'Proposal Ready'
          : stage === 'PROPOSAL_DISCUSSION' ? 'Proposal Discussion'
          : 'Onboarding Meeting'),
      stage,
    })),
  ]);

  return {
    scope: { designers: scope.designers, selectedDesignerIds: scope.designerIds },
    stageOrder: [...FUNNEL_STAGES],
    cohortRule: 'Non-test leads assigned to the selected designer(s) (all statuses), with Lead Received Date in the selected range (no range = whole current pipeline)'
      + (user.role === 'DESIGNER' ? ', excluding duplicates' : '')
      + (asOfEnd ? `. Pipeline rebuilt as of ${q.asOf} (end of day IST) from stage/status history; leads created after that day are excluded; leads with no history before that date are treated as MQL / Active` : '')
      + '. A lead counts in a stage row if it has reached that stage or any later one. Total = Active + On Hold + Inactive. Avg TAT = days from MQL Received Date to first reaching the stage, active leads only.',
    asOf: typeof q.asOf === 'string' && q.asOf ? q.asOf : null,
    cohortSize: total,
    leadsWithoutStageHistory: cohort.filter((l) => !hasHistory.has(l.id)).length,
    leadsOnLegacyOrOffFunnelStageExcluded: offFunnelCount,
    mqlFallbackLeads: fallbackLeads,
    stages,
    progressionStages,
  };
}

// ── Report 3: Meeting Performance ─────────────────────────────────────────────
const MEETING_STATUSES = ['SCHEDULED', 'COMPLETED', 'NO_SHOW', 'RESCHEDULED'] as const;

export async function meetingPerformanceByType(user: { id: string; role: string }, q: Record<string, unknown>, leadFilter?: Record<string, unknown>) {
  const scope = await resolveScope(user, q.designerId);
  const range = resolveRange(q);
  // Filtered by meetings.scheduledAt (not the lead's createdAt).
  const meetings = await prisma.meeting.findMany({
    where: {
      lead: { assignedDesignerId: { in: scope.designerIds }, isTestLead: false, ...(leadFilter ? { AND: [leadFilter] } : {}) },
      ...(range.gte || range.lte ? { scheduledAt: range } : {}),
    },
    select: {
      id: true, type: true, status: true, scheduledAt: true, ppNumber: true,
      lead: { select: { id: true, leadId: true, name: true } },
    },
    orderBy: { scheduledAt: 'asc' },
  });
  const types = [...new Set(meetings.map((m) => m.type as string))].sort();
  const rows = types.map((type) => {
    const ofType = meetings.filter((m) => m.type === type);
    const count = (st: string) => ofType.filter((m) => m.status === st).length;
    const upcoming = count('SCHEDULED');
    const completed = count('COMPLETED');
    const noShow = count('NO_SHOW');
    const rescheduled = count('RESCHEDULED');
    // Same total as reports.ts:321 (meetingPerformance): scheduled+completed+noShow+rescheduled.
    const total = upcoming + completed + noShow + rescheduled;
    return {
      type, totalScheduled: total, upcoming, completed, noShow, rescheduled, total,
      noShowPct: total > 0 ? round1((noShow / total) * 100) : null,
      drilldown: ofType.map((m) => ({
        id: m.lead.id, leadId: m.lead.leadId, name: m.lead.name,
        meetingId: m.id, status: m.status, scheduledAt: m.scheduledAt, ppNumber: m.ppNumber,
      })),
    };
  });
  const sum = (k: 'upcoming' | 'completed' | 'noShow' | 'rescheduled' | 'total') => rows.reduce((a, r) => a + r[k], 0);
  const totals = {
    totalScheduled: sum('total'), upcoming: sum('upcoming'), completed: sum('completed'), noShow: sum('noShow'),
    rescheduled: sum('rescheduled'), total: sum('total'),
    noShowPct: sum('total') > 0 ? round1((sum('noShow') / sum('total')) * 100) : null,
  };
  return {
    scope: { designers: scope.designers, selectedDesignerIds: scope.designerIds },
    statusesCounted: {
      totalScheduled: 'SCHEDULED + COMPLETED + NO_SHOW + RESCHEDULED',
      upcoming: 'SCHEDULED',
      completed: 'COMPLETED',
      noShow: 'NO_SHOW',
      rescheduled: 'RESCHEDULED',
    },
    noShowPctFormula: 'NO_SHOW / Total Scheduled x 100, Total Scheduled = SCHEDULED + COMPLETED + NO_SHOW + RESCHEDULED',
    rows, totals,
  };
}

// ── Report 4: Sales Cycle ─────────────────────────────────────────────────────
// Onboardings = dashboard won condition (dashboard.ts:194-202), non-test, whose
// first DESIGN_IN_PROGRESS log falls inside the selected range. Leads.pid does
// not exist in schema.prisma (searched case-insensitively for "pid"), so PID is
// always N/A; no other field is substituted.
async function salesCycle(user: { id: string; role: string }, q: Record<string, unknown>) {
  const scope = await resolveScope(user, q.designerId);
  const range = resolveRange(q);
  const base: any = { assignedDesignerId: { in: scope.designerIds }, isTestLead: false };
  const candidates = await prisma.lead.findMany({
    where: { ...base, OR: DASHBOARD_ONBOARDING_OR as any },
    select: { id: true, leadId: true, name: true, leadOriginDate: true },
  });
  const entries = await loadFirstStageEntries(candidates.map((l) => l.id));
  const noDipLog = candidates.filter((l) => !entries.get(l.id)?.has('DESIGN_IN_PROGRESS')).length;
  let fallback = 0;
  const rows = [] as { id: string; leadId: string; name: string; pid: string; mqlDate: Date; onboardingDate: Date; mqlFallback: boolean; days: number }[];
  for (const l of candidates) {
    const dip = entries.get(l.id)?.get('DESIGN_IN_PROGRESS');
    if (!dip) continue;
    if (range.gte && dip < range.gte) continue;
    if (range.lte && dip > range.lte) continue;
    const mql = mqlReceived(entries, l);
    if (mql.fallback) fallback += 1;
    rows.push({
      id: l.id, leadId: l.leadId, name: l.name, pid: l.leadId,
      mqlDate: mql.date, onboardingDate: dip, mqlFallback: mql.fallback,
      days: round1((dip.getTime() - mql.date.getTime()) / DAY_MS),
    });
  }
  rows.sort((a, b) => a.onboardingDate.getTime() - b.onboardingDate.getTime());
  const days = rows.map((r) => r.days);
  return {
    scope: { designers: scope.designers, selectedDesignerIds: scope.designerIds },
    summary: {
      onboardingsInRange: rows.length,
      averageDays: days.length ? round1(days.reduce((a, b) => a + b, 0) / days.length) : null,
      fastestDays: days.length ? Math.min(...days) : null,
      slowestDays: days.length ? Math.max(...days) : null,
    },
    pidStatus: 'PID and Lead ID are the same thing (confirmed by the client), so PID shows Lead.leadId.',
    onboardingsExcludedNoDipLog: noDipLog,
    mqlFallbackLeads: fallback,
    rows,
  };
}

// ── Report 5: My Trends — Sales ───────────────────────────────────────────────
/** Last N target cycles (16th–15th) ending with the current one, or the cycles spanning a custom from/to. */
function resolveTrendCycles(q: Record<string, unknown>): TargetCycle[] {
  if (q.from || q.to) return resolveCycles(q);
  const n = Number(q.months ?? 6);
  if (![3, 6, 12].includes(n)) throw new HttpError(400, '`months` must be 3, 6 or 12');
  const out: TargetCycle[] = [];
  let c = getCycleForDate(new Date());
  for (let i = 0; i < n; i++) {
    out.unshift(c);
    c = getCycleForDate(new Date(c.cycleStart.getTime() - 1));
  }
  return out;
}

// Rows follow the client's "My Trends — Sales" sheet. Every row is a target cycle (16th–15th) so Booking
// Value % lines up with the stored targets. Stage % are COHORT based: take the MQLs received in the
// cycle and count how many of those same leads have reached each stage (or any later stage), divided by
// total MQLs received in that cycle.
async function myTrendsSales(user: { id: string; role: string }, q: Record<string, unknown>) {
  const scope = await resolveScope(user, q.designerId);
  const cycles = resolveTrendCycles(q);
  const base: any = { assignedDesignerId: { in: scope.designerIds }, isTestLead: false };
  const leads = await prisma.lead.findMany({
    where: base,
    select: { id: true, leadId: true, name: true, leadOriginDate: true, stage: true, estimatedValue: true },
  });
  const entries = await loadFirstStageEntries(leads.map((l) => l.id));
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const brief = (id: string, extra: Record<string, unknown> = {}) => {
    const l = leadById.get(id)!;
    return { id: l.id, leadId: l.leadId, name: l.name, ...extra };
  };

  // MQL Received Date per lead (first MQL log, else leadOriginDate).
  const mqlDate = new Map<string, { date: Date; fallback: boolean }>();
  for (const l of leads) mqlDate.set(l.id, mqlReceived(entries, l));
  const mqlFallbackLeads = [...mqlDate.values()].filter((v) => v.fallback).length;

  // Onboarding candidates = dashboard condition (dashboard.ts:194-202), non-test.
  const onboardingIds = new Set((await prisma.lead.findMany({
    where: { ...base, OR: DASHBOARD_ONBOARDING_OR as any },
    select: { id: true },
  })).map((l) => l.id));

  // A lead has "reached" a stage if its current stage is at/after it (HANDED_OVER = after DIP) or it has a log entry for it.
  const reached = (l: { id: string; stage: string }, stage: string) => {
    const idx = FUNNEL_STAGES.indexOf(stage as any);
    const cur = l.stage === 'HANDED_OVER' ? FUNNEL_STAGES.length - 1 : FUNNEL_STAGES.indexOf(l.stage as any);
    return cur >= idx || !!entries.get(l.id)?.has(stage);
  };
  const dateOf = (id: string, stage: string) => entries.get(id)?.get(stage) ?? null;

  const targets = await prisma.designerTarget.findMany({
    where: { designerId: { in: scope.designerIds }, cycleStart: { in: cycles.map((c) => c.cycleStart) } },
    select: { cycleStart: true, bookingTargetValue: true },
  });

  const rows = [];
  for (const cy of cycles) {
    const inCy = (d?: Date | null) => !!d && d >= cy.cycleStart && d <= cy.cycleEnd;
    const mqlLeads = leads.filter((l) => inCy(mqlDate.get(l.id)!.date));
    const pctOf = (n: number) => (mqlLeads.length ? round1((n / mqlLeads.length) * 100) : null);
    const dqlLeads = mqlLeads.filter((l) => reached(l, 'DQL'));
    const ppLeads = mqlLeads.filter((l) => reached(l, 'PROPOSAL_PRESENTED'));
    const obLeads = mqlLeads.filter((l) => reached(l, 'ONBOARDING'));

    // Booking Value — dashboard.ts:696-717 with the cycle as window (DIP + completed DIP checklist + value).
    const bookingWhere: any = {
      ...base,
      activityLogs: {
        some: {
          action: 'STAGE_CHANGED',
          createdAt: { gte: cy.cycleStart, lte: cy.cycleEnd },
          meta: { path: ['to'], equals: 'DESIGN_IN_PROGRESS' },
        },
      },
      estimatedValue: { not: null },
      dipChecklist: { completedAt: { not: null } },
    };
    const [bookingAgg, bookingLeads] = await Promise.all([
      prisma.lead.aggregate({ where: bookingWhere, _sum: { estimatedValue: true }, _count: { id: true } }),
      prisma.lead.findMany({ where: bookingWhere, select: { id: true, leadId: true, name: true, estimatedValue: true } }),
    ]);
    const bookingValue = Number(bookingAgg._sum.estimatedValue ?? 0);
    const cycleTargets = targets.filter((t) => t.cycleStart.getTime() === cy.cycleStart.getTime());
    const bookingTarget = cycleTargets.length ? cycleTargets.reduce((a, t) => a + Number(t.bookingTargetValue), 0) : null;

    // TAT: onboardings (dashboard condition) whose first DIP log is in this cycle.
    const onboardTat = leads
      .filter((l) => onboardingIds.has(l.id) && inCy(dateOf(l.id, 'DESIGN_IN_PROGRESS')))
      .map((l) => {
        const dip = dateOf(l.id, 'DESIGN_IN_PROGRESS')!;
        return { l, dip, days: round1((dip.getTime() - mqlDate.get(l.id)!.date.getTime()) / DAY_MS) };
      });

    rows.push({
      month: cy.label,
      label: cy.label,
      mql: mqlLeads.length,
      dql: dqlLeads.length,
      proposalPresented: ppLeads.length,
      obm: obLeads.length,
      dqlPct: pctOf(dqlLeads.length),
      proposalPresentedPct: pctOf(ppLeads.length),
      obmPct: pctOf(obLeads.length),
      bookingValue,
      bookingCount: bookingAgg._count.id,
      bookingTarget,
      bookingValuePct: bookingTarget ? round1((bookingValue / bookingTarget) * 100) : null,
      leadToOnboardingTatAvgDays: onboardTat.length ? round1(onboardTat.reduce((a, r) => a + r.days, 0) / onboardTat.length) : null,
      onboardingsInTat: onboardTat.length,
      drilldown: {
        mql: mqlLeads.map((l) => brief(l.id, { date: mqlDate.get(l.id)!.date, mqlFallback: mqlDate.get(l.id)!.fallback })),
        dql: dqlLeads.map((l) => brief(l.id, { date: dateOf(l.id, 'DQL') })),
        proposalPresented: ppLeads.map((l) => brief(l.id, { date: dateOf(l.id, 'PROPOSAL_PRESENTED') })),
        obm: obLeads.map((l) => brief(l.id, { date: dateOf(l.id, 'ONBOARDING') })),
        bookings: bookingLeads.map((l) => ({ id: l.id, leadId: l.leadId, name: l.name, estimatedValue: Number(l.estimatedValue) })),
        onboardings: onboardTat.map((r) => brief(r.l.id, { mqlDate: mqlDate.get(r.l.id)!.date, onboardingDate: r.dip, days: r.days })),
      },
    });
  }
  return {
    scope: { designers: scope.designers, selectedDesignerIds: scope.designerIds },
    mqlFallbackLeads,
    months: cycles.map((c) => c.label),
    rows,
  };
}

// ── Report: My Commitment ─────────────────────────────────────────────────────
// Planned/Committed vs Actual for a 16th–15th cycle (client definition):
//   Meetings planned = each original/revised commitment scheduled in the cycle.
//   Meetings actual = distinct meetings completed in the cycle, by audit date.
//   Expected Booking planned = 4★/5★ leads whose expected OB date is in the cycle; actual = those onboarded
//   Expected OB Value planned = sum of project value of those leads; actual = sum for the onboarded ones
// "Onboarded" = Design in Progress (or later) with the DIP checklist complete, as in My Performance.
// RESCHEDULED archives retain commitments; they never count as completions.
async function myCommitment(user: { id: string; role: string }, q: Record<string, unknown>) {
  const scope = await resolveScope(user, q.designerId);
  const cycles = resolveCycles(q);
  const nonTest = { isTestLead: false };
  const scheduledRange = { gte: cycles[0].cycleStart, lte: cycles[cycles.length - 1].cycleEnd };
  const meetings = await prisma.meeting.findMany({
    where: {
      lead: { assignedDesignerId: { in: scope.designerIds }, ...nonTest },
      type: { in: ['DQL', 'PP'] },
      // A completed meeting scheduled outside these cycles may have completed
      // inside them. Unknown completion dates must remain explicitly unknown.
      OR: [{ scheduledAt: scheduledRange }, { status: 'COMPLETED' }],
    },
    select: {
      id: true, leadId: true, type: true, status: true, scheduledAt: true, rescheduledReason: true,
      lead: { select: { id: true, leadId: true, name: true } },
    },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
  });
  const completedLeadIds = [...new Set(meetings.filter((m) => m.status === 'COMPLETED').map((m) => m.leadId))];
  const completions = completedLeadIds.length ? await prisma.activityLog.findMany({
    where: { leadId: { in: completedLeadIds }, action: 'MEETING_COMPLETED' },
    select: { leadId: true, createdAt: true, meta: true },
  }) : [];
  const blocks = [];
  for (const cy of cycles) {
    const range = { gte: cy.cycleStart, lte: cy.cycleEnd };
    const commitLeads = await prisma.lead.findMany({
        where: { assignedDesignerId: { in: scope.designerIds }, ...nonTest, intentRating: { gte: 4 }, expectedObDate: range },
        select: {
          id: true, leadId: true, name: true, intentRating: true, expectedObDate: true, estimatedValue: true, stage: true,
          dipChecklist: { select: { completedAt: true } },
        },
      });
    const isOnboarded = (l: typeof commitLeads[number]) =>
      ['DESIGN_IN_PROGRESS', 'HANDED_OVER'].includes(l.stage) && !!l.dipChecklist?.completedAt;
    const lRow = (l: typeof commitLeads[number]) => ({
      id: l.id, leadId: l.leadId, name: l.name, intentRating: l.intentRating, expectedObDate: l.expectedObDate,
      estimatedValue: l.estimatedValue == null ? null : Number(l.estimatedValue), stage: l.stage,
    });
    const onboarded = commitLeads.filter(isOnboarded);
    const sum = (ls: typeof commitLeads) => ls.reduce((a, l) => a + Number(l.estimatedValue ?? 0), 0);
    const plannedValue = sum(commitLeads);
    const actualValue = sum(onboarded);
    blocks.push({
      cycle: { label: cy.label, cycleStart: cy.cycleStart, cycleEnd: cy.cycleEnd },
      rows: [
        ...meetingCommitments(meetings, completions, { from: cy.cycleStart, to: cy.cycleEnd }),
        {
          key: 'EXPECTED_BOOKING', label: 'Expected Booking (4★/5★ leads)', planned: commitLeads.length, actual: onboarded.length,
          achievementPct: commitLeads.length ? round1((onboarded.length / commitLeads.length) * 100) : null,
          drilldown: { planned: commitLeads.map(lRow), actual: onboarded.map(lRow) },
        },
        {
          key: 'EXPECTED_OB_VALUE', label: 'Expected OB Value (INR)', planned: plannedValue, actual: actualValue, isMoney: true,
          achievementPct: plannedValue ? round1((actualValue / plannedValue) * 100) : null,
          drilldown: { planned: commitLeads.map(lRow), actual: onboarded.map(lRow) },
        },
      ],
      missingValueLeads: commitLeads.filter((l) => l.estimatedValue == null).length,
      missingExpectedObDateNote: 'Only 4★/5★ leads that have an Expected OB date inside this cycle are counted. Leads without an Expected OB date cannot be placed in a cycle.',
    });
  }
  return { scope: { designers: scope.designers, selectedDesignerIds: scope.designerIds }, blocks };
}

// ── Report 6: Task / Call Activity ────────────────────────────────────────────
// Status values counted (printed in the response as `definitions`):
//   Follow-ups Due       = follow_up_tasks.status IN (PENDING, COMPLETED, NOT_DONE), dueDate in range
//                          (RESCHEDULED rows are superseded archive rows and excluded)
//   Follow-ups Completed = status = COMPLETED, dueDate in range
//   Pending              = status = PENDING and isCompleted = false, dueDate in range
//   Overdue              = status = PENDING and isCompleted = false, due instant earlier than now
//                          (dueDate + dueTime/timeFrom as IST; end of IST day when no time) — all dates, not range-limited
const DUE_STATUSES = ['PENDING', 'COMPLETED', 'NOT_DONE'] as const;

function followUpDueInstant(t: { dueDate: Date; dueTime: string | null; timeFrom: string | null }): Date {
  const time = t.dueTime ?? t.timeFrom;
  const y = t.dueDate.getUTCFullYear(); const m = t.dueDate.getUTCMonth(); const d = t.dueDate.getUTCDate();
  const match = time ? /^(\d{1,2}):(\d{2})$/.exec(time) : null;
  if (match) return new Date(Date.UTC(y, m, d, Number(match[1]), Number(match[2])) - IST_OFFSET_MS);
  return new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - IST_OFFSET_MS);
}

async function taskCallActivity(user: { id: string; role: string }, q: Record<string, unknown>) {
  const scope = await resolveScope(user, q.designerId);
  const range = resolveRange(q);
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * DAY_MS);
  // follow_up_tasks.dueDate is a UTC-midnight calendar marker, so its range is
  // the raw from/to days rather than the IST instants used for timestamps.
  const dueRange: { gte?: Date; lte?: Date } = {};
  if (typeof q.from === 'string' && q.from) dueRange.gte = new Date(`${q.from}T00:00:00.000Z`);
  if (typeof q.to === 'string' && q.to) dueRange.lte = new Date(`${q.to}T23:59:59.999Z`);
  const hasRange = !!(range.gte || range.lte);
  const nonTest = { isTestLead: false };

  const STAGE_ROWS: { key: string; label: string }[] = [
    { key: 'MQL', label: 'MQL' }, { key: 'DQL', label: 'DQL' }, { key: 'PROPOSAL_READY', label: 'PR' },
    { key: 'PROPOSAL_PRESENTED', label: 'PP' }, { key: 'PROPOSAL_DISCUSSION', label: 'PD' },
    { key: 'ONBOARDING', label: 'OB' }, { key: 'ONBOARDING_MEETING', label: 'OBM' },
    { key: 'DESIGN_IN_PROGRESS', label: 'Design in Progress' },
  ];
  const mk = () => ({ leads: 0, meetingsScheduled: 0, meetingsCompleted: 0, noShow: 0, callsMade: 0, followUpsDue: 0, followUpsCompleted: 0, pending: 0, overdue: 0, noActivity: 0, plannedActivities: 0, completedActivities: 0 });
  const stageAcc = new Map<string, ReturnType<typeof mk>>(STAGE_ROWS.map((r) => [r.key, mk()]));
  const stageDrill = new Map<string, Record<string, Record<string, unknown>[]>>(STAGE_ROWS.map((r) => [r.key, {}]));
  const bump = (stage: string, k: keyof ReturnType<typeof mk>, row: Record<string, unknown>) => {
    const a = stageAcc.get(stage); const d = stageDrill.get(stage);
    if (!a || !d) return; // legacy/off-funnel stages (e.g. Effective Lead, Handed Over) are not part of the table
    a[k] += 1; (d[k] ??= []).push(row);
  };
  const rows = [];
  for (const designer of scope.designers.filter((d) => scope.designerIds.includes(d.id))) {
    const [leads, projects, meetings, calls, tasks, activeLeads] = await Promise.all([
      prisma.lead.findMany({ where: { assignedDesignerId: designer.id, ...nonTest }, select: { id: true, leadId: true, name: true, stage: true } }),
      prisma.project.findMany({
        where: { designerId: designer.id, lead: nonTest },
        select: { id: true, projectCode: true, lead: { select: { id: true, leadId: true, name: true } } },
      }),
      prisma.meeting.findMany({
        where: { lead: { assignedDesignerId: designer.id, ...nonTest }, ...(hasRange ? { scheduledAt: range } : {}) },
        select: { id: true, type: true, status: true, scheduledAt: true, lead: { select: { id: true, leadId: true, name: true, stage: true } } },
      }),
      prisma.call.findMany({
        where: {
          loggedById: designer.id,
          lead: nonTest,
          ...(hasRange ? { OR: [{ calledAt: range }, { calledAt: null, createdAt: range }] } : {}),
        },
        select: { id: true, calledAt: true, createdAt: true, outcome: true, lead: { select: { id: true, leadId: true, name: true, stage: true } } },
      }),
      prisma.followUpTask.findMany({
        where: { assignedToId: designer.id, lead: nonTest },
        select: {
          id: true, status: true, isCompleted: true, dueDate: true, dueTime: true, timeFrom: true,
          lead: { select: { id: true, leadId: true, name: true, stage: true } },
        },
      }),
      prisma.lead.findMany({
        where: { assignedDesignerId: designer.id, status: 'ACTIVE', ...nonTest },
        select: { id: true, leadId: true, name: true, stage: true, createdAt: true },
      }),
    ]);

    // Stage history so each activity is counted under the stage the lead was in WHEN it happened.
    const stageLogs = leads.length
      ? await prisma.activityLog.findMany({
        where: { leadId: { in: leads.map((l) => l.id) }, action: 'STAGE_CHANGED' },
        select: { leadId: true, createdAt: true, meta: true },
        orderBy: { createdAt: 'asc' },
      })
      : [];
    const stageHist = new Map<string, { at: Date; from?: string; to?: string }[]>();
    for (const lg of stageLogs) {
      if (!lg.leadId) continue;
      const m = lg.meta as { from?: string; to?: string } | null;
      const arr = stageHist.get(lg.leadId) ?? [];
      arr.push({ at: lg.createdAt, from: m?.from, to: m?.to });
      stageHist.set(lg.leadId, arr);
    }
    const stageAtTime = (lead: { id: string; stage: string }, at: Date): string => {
      const h = stageHist.get(lead.id);
      if (!h || !h.length) return lead.stage;
      let cur: string | undefined;
      for (const e of h) { if (e.at <= at) cur = e.to; else break; }
      return cur ?? h[0].from ?? 'MQL';
    };

    const inDue = (d: Date) => (!dueRange.gte || d >= dueRange.gte) && (!dueRange.lte || d <= dueRange.lte);
    const tRow = (t: typeof tasks[number]) => ({
      id: t.lead.id, leadId: t.lead.leadId, name: t.lead.name,
      taskId: t.id, status: t.status, dueDate: t.dueDate, dueAt: followUpDueInstant(t),
    });
    const due = tasks.filter((t) => (DUE_STATUSES as readonly string[]).includes(t.status) && inDue(t.dueDate));
    const completed = due.filter((t) => t.status === 'COMPLETED');
    const pending = tasks.filter((t) => t.status === 'PENDING' && !t.isCompleted && inDue(t.dueDate));
    const overdue = tasks.filter((t) => (t.status === 'PENDING' || t.status === 'NOT_DONE') && !t.isCompleted && followUpDueInstant(t) < now);
    const notDone = tasks.filter((t) => t.status === 'NOT_DONE' && inDue(t.dueDate));

    // No Activity > 3 Days (client definition): based on the LAST COMPLETED activity per lead
    // (completed meeting, call made, or completed follow-up/task). Never-touched leads are included,
    // measured from the date the lead was created.
    const activeIds = activeLeads.map((l) => l.id);
    const [lastMeet, lastCall, lastTask] = activeIds.length
      ? await Promise.all([
        prisma.meeting.groupBy({ by: ['leadId'], where: { leadId: { in: activeIds }, status: 'COMPLETED' }, _max: { scheduledAt: true } }),
        prisma.call.groupBy({ by: ['leadId'], where: { leadId: { in: activeIds } }, _max: { calledAt: true, createdAt: true } }),
        prisma.followUpTask.groupBy({ by: ['leadId'], where: { leadId: { in: activeIds }, status: 'COMPLETED' }, _max: { completedAt: true } }),
      ])
      : [[], [], []] as any[];
    const latestByLead = new Map<string, Date>();
    const bumpLatest = (id: string | null, d: Date | null | undefined) => {
      if (!id || !d) return;
      const cur = latestByLead.get(id);
      if (!cur || d > cur) latestByLead.set(id, d);
    };
    for (const r of lastMeet as any[]) bumpLatest(r.leadId, r._max.scheduledAt);
    for (const r of lastCall as any[]) bumpLatest(r.leadId, r._max.calledAt ?? r._max.createdAt);
    for (const r of lastTask as any[]) bumpLatest(r.leadId, r._max.completedAt);
    const staleRef = (l: { id: string; createdAt: Date }) => latestByLead.get(l.id) ?? l.createdAt;
    const stale = activeLeads.filter((l) => staleRef(l) < threeDaysAgo)
      .map((l) => ({ id: l.id, leadId: l.leadId, name: l.name, lastActivityAt: latestByLead.get(l.id) ?? null, neverTouched: !latestByLead.has(l.id) }));
    const activeNoLog = activeLeads.filter((l) => !latestByLead.has(l.id)).length;

    // Per-stage accumulation (stage = the lead's CURRENT stage).
    const ref = (l: { id: string; leadId: string; name: string }, extra: Record<string, unknown> = {}) => ({ id: l.id, leadId: l.leadId, name: l.name, ...extra });
    for (const l of leads) bump(l.stage, 'leads', ref(l));
    // Planned activities = meetings (SCHEDULED / COMPLETED / NO_SHOW; RESCHEDULED rows are superseded)
    // + follow-up tasks (calls, follow-ups, other tasks) due. Completed = completed meetings + completed tasks.
    for (const m of meetings) {
      const r = ref(m.lead, { meetingType: m.type, status: m.status, scheduledAt: m.scheduledAt });
      const st = stageAtTime(m.lead, m.scheduledAt);
      if (MEETING_STATUSES.includes(m.status as any)) bump(st, 'meetingsScheduled', r);
      if (m.status === 'COMPLETED') bump(st, 'meetingsCompleted', r);
      if (m.status === 'NO_SHOW') bump(st, 'noShow', r);
      if (m.status !== 'RESCHEDULED') bump(st, 'plannedActivities', r);
      if (m.status === 'COMPLETED') bump(st, 'completedActivities', r);
    }
    for (const c of calls) { const at = c.calledAt ?? c.createdAt; bump(stageAtTime(c.lead, at), 'callsMade', ref(c.lead, { outcome: c.outcome, calledAt: at })); }
    const tr = (t: typeof tasks[number]) => ref(t.lead, { status: t.status, dueDate: t.dueDate });
    const tst = (t: typeof tasks[number]) => stageAtTime(t.lead, followUpDueInstant(t));
    for (const t of due) { bump(tst(t), 'followUpsDue', tr(t)); bump(tst(t), 'plannedActivities', tr(t)); }
    for (const t of completed) { bump(tst(t), 'followUpsCompleted', tr(t)); bump(tst(t), 'completedActivities', tr(t)); }
    for (const t of pending) bump(tst(t), 'pending', tr(t));
    for (const t of overdue) bump(tst(t), 'overdue', tr(t));
    for (const l of stale) {
      const lead = activeLeads.find((x) => x.id === l.id)!;
      bump(lead.stage, 'noActivity', ref(lead, { lastActivityAt: l.lastActivityAt, neverTouched: l.neverTouched }));
    }

    const mCount = (st: string) => meetings.filter((m) => m.status === st);
    const mRow = (m: typeof meetings[number]) => ({ id: m.lead.id, leadId: m.lead.leadId, name: m.lead.name, meetingType: m.type, status: m.status, scheduledAt: m.scheduledAt });
    rows.push({
      designer: designer.name,
      designerId: designer.id,
      leads: leads.length,
      projects: projects.length,
      totalScheduled: meetings.filter((m) => MEETING_STATUSES.includes(m.status as any)).length,
      upcoming: mCount('SCHEDULED').length,
      meetingsCompleted: mCount('COMPLETED').length,
      noShow: mCount('NO_SHOW').length,
      rescheduled: mCount('RESCHEDULED').length,
      callsMade: calls.length,
      followUpsDue: due.length,
      followUpsCompleted: completed.length,
      plannedActivities: meetings.filter((m) => m.status !== 'RESCHEDULED').length + due.length,
      completedActivities: meetings.filter((m) => m.status === 'COMPLETED').length + completed.length,
      activityCompletionPct: (() => {
        const planned = meetings.filter((m) => m.status !== 'RESCHEDULED').length + due.length;
        const done = meetings.filter((m) => m.status === 'COMPLETED').length + completed.length;
        return planned > 0 ? round1((done / planned) * 100) : null;
      })(),
      pendingActivities: pending.length,
      notDone: notDone.length,
      overdueActivities: overdue.length,
      noActivityOver3Days: stale.length,
      activeLeadsWithNoActivityLog: activeNoLog,
      drilldown: {
        leads: leads,
        projects: projects.map((p) => ({ id: p.lead.id, leadId: p.lead.leadId, name: p.lead.name, projectCode: p.projectCode })),
        totalScheduled: meetings.filter((m) => MEETING_STATUSES.includes(m.status as any)).map(mRow),
        upcoming: mCount('SCHEDULED').map(mRow),
        rescheduled: mCount('RESCHEDULED').map(mRow),
        meetingsCompleted: mCount('COMPLETED').map(mRow),
        noShow: mCount('NO_SHOW').map(mRow),
        callsMade: calls.map((c) => ({ id: c.lead.id, leadId: c.lead.leadId, name: c.lead.name, outcome: c.outcome, calledAt: c.calledAt ?? c.createdAt })),
        followUpsDue: due.map(tRow),
        followUpsCompleted: completed.map(tRow),
        pendingActivities: pending.map(tRow),
        notDone: notDone.map(tRow),
        overdueActivities: overdue.map(tRow),
        noActivityOver3Days: stale,
      },
    });
  }
  return {
    scope: { designers: scope.designers, selectedDesignerIds: scope.designerIds },
    byStage: [
      ...STAGE_ROWS.map((r) => ({ stage: r.key, label: r.label, ...stageAcc.get(r.key)!, drilldown: stageDrill.get(r.key)! })),
      (() => {
        const tot = mk();
        const drill: Record<string, Record<string, unknown>[]> = {};
        for (const r of STAGE_ROWS) {
          const a = stageAcc.get(r.key)!;
          for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += a[k];
          for (const [k, v] of Object.entries(stageDrill.get(r.key)!)) (drill[k] ??= []).push(...v);
        }
        return { stage: 'TOTAL', label: 'Total', ...tot, drilldown: drill };
      })(),
    ].map((r) => ({
      ...r,
      activityCompletionPct: r.plannedActivities > 0 ? round1((r.completedActivities / r.plannedActivities) * 100) : null,
    })),
    byStageNote: "Each meeting, call and follow-up is counted under the stage the lead was in when the activity happened (meeting time, call time, follow-up due time), so history does not move when a lead progresses. The Leads and No Activity columns use the lead's current stage. Activity Completion % = (completed meetings + completed follow-ups/tasks) / (planned meetings + follow-ups/tasks) x 100; calls made are shown but are not part of the plan. Legacy stages (Effective Lead, Handed Over) are not in the table, so row totals can be lower than the by-designer table.",
    definitions: {
      followUpsDue: 'follow_up_tasks.status IN (PENDING, COMPLETED, NOT_DONE) with dueDate in range (RESCHEDULED excluded: superseded archive rows)',
      followUpsCompleted: "follow_up_tasks.status = 'COMPLETED' with dueDate in range",
      pending: "status = 'PENDING' and isCompleted = false, dueDate in range",
      overdue: "status IN (PENDING, NOT_DONE) and isCompleted = false and due instant earlier than now (IST, end of day if no time; not range-limited). RESCHEDULED excluded.",
      notDone: "status = 'NOT_DONE', dueDate in range",
      meetings: {
        totalScheduled: 'SCHEDULED + COMPLETED + NO_SHOW + RESCHEDULED, meetings.scheduledAt in range',
        upcoming: 'SCHEDULED', completed: 'COMPLETED', noShow: 'NO_SHOW', rescheduled: 'RESCHEDULED',
      },
      callsMade: 'calls.loggedById = designer, calls.calledAt (else createdAt) in range',
      leads: 'leads.assignedDesignerId = designer, non-test, all periods',
      projects: 'projects.designerId = designer, lead non-test, all periods and phases',
      noActivity: "ACTIVE leads whose last COMPLETED activity (completed meeting, call made, completed follow-up/task) is more than 3 days ago. Leads never touched are included, measured from the lead's creation date.",
      activityCompletionPct: "(completed meetings + completed follow-ups/tasks) / (planned meetings + follow-ups/tasks) x 100; RESCHEDULED meeting/task rows excluded",
    },
    rows,
  };
}

// ── Router ────────────────────────────────────────────────────────────────────
const HANDLERS: Record<string, (user: { id: string; role: string }, q: Record<string, unknown>) => Promise<unknown>> = {
  'my-performance': myPerformance,
  'my-lead-funnel': myLeadFunnel,
  'meeting-performance': meetingPerformanceByType,
  'sales-cycle': salesCycle,
  'my-trends-sales': myTrendsSales,
  'my-commitment': myCommitment,
  'task-call-activity': taskCallActivity,
};

designerReportsRouter.get('/:type', verifyToken, async (req, res) => {
  const handler = HANDLERS[req.params.type];
  if (!handler) { res.status(404).json({ error: `Unknown designer report: ${req.params.type}`, available: Object.keys(HANDLERS) }); return; }
  try {
    const data = await handler(req.user!, req.query as Record<string, unknown>);
    res.json({ type: req.params.type, data });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error(`[designer-reports:${req.params.type}]`, err);
    res.status(500).json({ error: err.message });
  }
});
