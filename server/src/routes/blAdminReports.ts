// BL and Branch-Head/Admin reports. Own role scoping inside each handler; the
// designerId / blId query parameters can only narrow within the caller's
// permitted scope. Metrics that already exist in designerReports.ts (Booking
// Value, onboarding, targets, meeting totals) are obtained by calling those
// exported functions, not re-implemented. Existing /api/reports is untouched.
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { buildLeadRoleWhere } from '../lib/leadScope.js';
import { currentStageInventory, stageProgression } from '../lib/reportPipeline.js';
import { computeSlaInfoForLeads, getEffectiveStageSla } from '../lib/stageSla.js';
import {
  HttpError, FUNNEL_STAGES, DASHBOARD_ONBOARDING_OR, IST_OFFSET_MS, round1,
  myPerformance, meetingPerformanceByType, resolveRange, loadFirstStageEntries, mqlReceived,
} from './designerReports.js';

export const blAdminReportsRouter = Router();

type U = { id: string; role: string };
type Q = Record<string, unknown>;
type DrillLead = { id: string; leadId: string; name: string; [k: string]: unknown };
type Table = {
  title: string;
  columns: { key: string; label: string }[];
  rows: { cells: Record<string, unknown>; drill?: Record<string, DrillLead[]>; na?: Record<string, string> }[];
};
type Result = { notes: string[]; summary?: Record<string, unknown>; tables: Table[]; scope?: { designers: { id: string; name: string }[] } };

const NA = 'N/A';
const BL_BOOKING_VALUE_NOTE = 'BL booking value uses the total project value recorded in the CRM (estimatedValue): after discount and excluding GST. Furniture is a separate reporting breakdown, not an additional deduction. This report uses the recorded amount directly; it does not apply another discount or recalculate GST.';
/** Reason text for N/A cells: entries are [value, reason]; a reason is emitted only for cells whose value is the N/A marker. */
const naWhy = (e: Record<string, [unknown, string]>): Record<string, string> | undefined => {
  const o: Record<string, string> = {};
  for (const [k, [v, why]] of Object.entries(e)) if (v === NA || v == null) o[k] = why;
  return Object.keys(o).length ? o : undefined;
};
const WHY_EMPTY_COHORT = 'No leads in the cohort for these dates/filters (zero denominator)';
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const pct = (n: number, d: number) => (d > 0 ? round1((n / d) * 100) : null);
const brief = (l: { id: string; leadId: string; name: string }, extra: Record<string, unknown> = {}): DrillLead =>
  ({ id: l.id, leadId: l.leadId, name: l.name, ...extra });
const STAGES: readonly string[] = FUNNEL_STAGES;
const LEAD_STAGES = ['EFFECTIVE_LEAD', ...FUNNEL_STAGES, 'HANDED_OVER', 'INACTIVE', 'ON_HOLD'];

function requireRole(user: U, roles: string[]) {
  if (!roles.includes(user.role)) throw new HttpError(403, `This report is available to ${roles.join(' / ')} only`);
}

// ── Scope ─────────────────────────────────────────────────────────────────────
type Team = { bl: { id: string; name: string }; designers: { id: string; name: string }[] };

/** BL: own team only. BRANCH_HEAD: all BLs. blId/designerId may only narrow. */
async function resolveTeams(user: U, q: Q): Promise<Team[]> {
  requireRole(user, ['BL', 'BRANCH_HEAD']);
  const blParam = str(q.blId);
  const desParam = str(q.designerId);
  let bls: { id: string; name: string }[];
  if (user.role === 'BL') {
    if (blParam && blParam !== user.id) throw new HttpError(403, 'BL is outside your permitted scope');
    bls = await prisma.user.findMany({ where: { id: user.id }, select: { id: true, name: true } });
  } else {
    bls = await prisma.user.findMany({
      where: { role: 'BL', isActive: true, ...(blParam ? { id: blParam } : {}) },
      select: { id: true, name: true }, orderBy: { name: 'asc' },
    });
    if (blParam && !bls.length) throw new HttpError(403, 'BL is outside your permitted scope');
  }
  const teams: Team[] = [];
  for (const bl of bls) {
    const designers = await prisma.user.findMany({
      where: { blId: bl.id, role: 'DESIGNER', isActive: true },
      select: { id: true, name: true }, orderBy: { name: 'asc' },
    });
    teams.push({ bl, designers });
  }
  if (desParam) {
    const found = teams.some((t) => t.designers.some((d) => d.id === desParam));
    if (!found) throw new HttpError(403, 'Designer is outside your permitted scope');
    for (const t of teams) t.designers = t.designers.filter((d) => d.id === desParam);
    return teams.filter((t) => t.designers.length);
  }
  return teams;
}

/** Lead `where` for lead-level reports: non-test + permitted scope + filters. */
async function leadWhere(user: U, q: Q, opts: { dateField?: 'leadOriginDate' | null } = {}): Promise<any> {
  const w: any = { isTestLead: false };
  const blParam = str(q.blId);
  const desParam = str(q.designerId);
  if (user.role === 'BL') {
    if (blParam && blParam !== user.id) throw new HttpError(403, 'BL is outside your permitted scope');
    // Same lead scope as the BL dashboard (leadScope.ts): team designers OR assignedBLId = BL.
    w.AND = [await buildLeadRoleWhere(user, prisma)];
    if (desParam) {
      const ok = await prisma.user.count({ where: { id: desParam, blId: user.id, role: 'DESIGNER' } });
      if (!ok) throw new HttpError(403, 'Designer is outside your permitted scope');
    }
  } else if (user.role === 'BRANCH_HEAD') {
    if (blParam) w.assignedBLId = blParam;
  } else if (user.role === 'DESIGNER') {
    if ((desParam && desParam !== user.id) || blParam) throw new HttpError(403, 'Designer is outside your permitted scope');
    w.assignedDesignerId = user.id;
  } else {
    throw new HttpError(403, 'Not available for your role');
  }
  if (desParam) w.assignedDesignerId = desParam;
  const ci = (v: string) => ({ equals: v, mode: 'insensitive' });
  const src = str(q.source); if (src) w.source = ci(src);
  const pt = str(q.projectType); if (pt) w.projectType = ci(pt);
  const loc = str(q.location); if (loc) w.location = ci(loc);
  const stage = str(q.stage);
  if (stage) {
    if (!LEAD_STAGES.includes(stage)) throw new HttpError(400, `Invalid stage ${stage}`);
    w.stage = stage;
  }
  if (opts.dateField !== null) {
    const r = resolveRange(q);
    if (r.gte || r.lte) w.leadOriginDate = r;
  }
  return w;
}

// Report 10 / Report 6 source normalisation (also used by the Source filter below): ignore case, treat '-', '_' and space as the same.
const normSource = (s: string | null) => (s ?? '').trim().toLowerCase().replace(/[-_\s]+/g, ' ') || 'unknown';

/** Source / Stage / Project Type / Location as a lead-level condition (case-insensitive equals; Stage = current stage).
 *  Returned object is AND-ed onto the already-scoped lead filter inside the Designer functions, so it can only narrow.
 *  Returns undefined when no filter is selected so default behaviour is untouched. */
async function attrFilter(q: Q): Promise<Record<string, unknown> | undefined> {
  const ci = (v: string) => ({ equals: v, mode: 'insensitive' });
  const f: Record<string, unknown> = {};
  const src = str(q.source);
  if (src) {
    // Prisma cannot run normSource in SQL, so resolve the stored raw values whose normSource equals the requested one.
    const want = normSource(src);
    const distinct = await prisma.lead.findMany({ distinct: ['source'], select: { source: true } });
    const raws = distinct.map((d) => d.source).filter((v): v is string => v != null && normSource(v) === want);
    f.source = want === 'unknown' ? { OR: [{ in: raws }, { equals: null }] } : { in: raws };
    if (want === 'unknown') { delete f.source; f.OR = [{ source: { in: raws } }, { source: null }]; }
  }
  const pt = str(q.projectType); if (pt) f.projectType = ci(pt);
  const loc = str(q.location); if (loc) f.location = ci(loc);
  const stage = str(q.stage);
  if (stage) {
    if (!LEAD_STAGES.includes(stage)) throw new HttpError(400, `Invalid stage ${stage}`);
    f.stage = stage;
  }
  return Object.keys(f).length ? f : undefined;
}
const FILTER_NOTE = (q: Q) => {
  const a = ['source', 'stage', 'projectType', 'location'].some((k) => str(q[k]));
  return a ? `Filters applied at lead level (a lead is included only if it matches all): ${['source', 'stage', 'projectType', 'location'].filter((k) => str(q[k])).map((k) => `${k}=${str(q[k])}`).join(', ')}. Every metric is computed only from the included leads.` : 'No Source/Stage/Project Type/Location filter selected.';
};

// Shown only when a lead filter is selected, on reports that show a Target (1, 8, 9).
const TARGET_NOTE = (q: Q): string[] => (['source', 'stage', 'projectType', 'location'].some((k) => str(q[k]))
  ? ['Target is the full target for the cycle. Achievement % compares the filtered bookings to the full target.'] : []);

const rangeLabel = (q: Q) => `${str(q.from) ?? 'start'} → ${str(q.to) ?? 'today/open'} (IST days)`;

const stageNote = `Stage order (LeadStage enum, active funnel): ${FUNNEL_STAGES.join(' → ')}`;

// ── Shared funnel math (dashboard.ts cumulative logic: reached = current stage is this or later funnel stage)
function cumulative<T extends { id: string; leadId: string; name: string; stage: string }>(leads: T[]) {
  const total = leads.length;
  return FUNNEL_STAGES.map((stage, idx) => {
    const later = new Set<string>(FUNNEL_STAGES.slice(idx));
    const reached = leads.filter((l) => later.has(l.stage));
    return { stage, count: reached.length, pct: pct(reached.length, total), leads: reached };
  });
}

const FUNNEL_COHORT_SELECT = { id: true, leadId: true, name: true, stage: true, assignedBLId: true, assignedDesignerId: true } as const;

// ── 1. BL Performance (Team + Overall) ────────────────────────────────────────
async function teamPerformanceBlocks(user: U, team: Team, q: Q) {
  // One myPerformance call per designer (same Booking Value / target / cycle logic as Designer report 1).
  const perDesigner = [];
  for (const d of team.designers) {
    perDesigner.push({ d, perf: await myPerformance(user, { from: q.from, to: q.to, designerId: d.id }, await attrFilter(q)) });
  }
  const cycleCount = perDesigner[0]?.perf.blocks.length ?? 0;
  const blocks = [];
  for (let i = 0; i < cycleCount; i++) {
    const rows = perDesigner.map(({ d, perf }) => {
      const b = perf.blocks[i];
      const target = b.target.monthlyTarget;
      return {
        designerId: d.id, designer: d.name, target,
        achieved: b.result.bookingValue, bookingCount: b.result.bookingCount,
        pct: target == null || target === 0 ? null : round1((b.result.bookingValue / target) * 100),
        pctWhy: target == null ? 'No target row for this designer for this cycle' : 'Target is 0, so achievement % cannot be computed',
        bookings: b.drilldown.bookings as DrillLead[],
      };
    });
    const withTarget = rows.filter((r) => r.target != null);
    const teamTarget = withTarget.reduce((a, r) => a + (r.target as number), 0);
    const teamAchieved = rows.reduce((a, r) => a + r.achieved, 0);
    blocks.push({
      cycle: perDesigner[0].perf.blocks[i].cycle.label, rows,
      teamTarget: withTarget.length ? teamTarget : null,
      teamAchieved,
      achievedByDesignersWithTarget: withTarget.reduce((a, r) => a + r.achieved, 0),
      overallPct: withTarget.length && teamTarget > 0 ? round1((teamAchieved / teamTarget) * 100) : null,
      teamWhy: withTarget.length ? 'Total target of designers with a target row is 0' : 'No designer in this team has a target row for this cycle',
      designersExcludedNoTarget: rows.length - withTarget.length,
    });
  }
  return blocks;
}

async function blPerformance(user: U, q: Q): Promise<Result> {
  const teams = await resolveTeams(user, q);
  const tables: Table[] = [];
  const summary: Record<string, unknown> = {};
  for (const team of teams) {
    const blocks = await teamPerformanceBlocks(user, team, q);
    for (const b of blocks) {
      tables.push({
        title: `${team.bl.name} — cycle ${b.cycle}`,
        columns: [
          { key: 'designer', label: 'Designer' }, { key: 'target', label: 'Individual Target' },
          { key: 'achieved', label: 'Individual Achieved' }, { key: 'pct', label: 'Achievement %' },
        ],
        rows: [
          ...b.rows.map((r) => ({
            cells: { designer: r.designer, target: r.target ?? NA, achieved: r.achieved, pct: r.pct ?? NA },
            na: naWhy({ target: [r.target, 'No target row for this designer for this cycle'], pct: [r.pct, r.pctWhy] }),
            drill: { achieved: r.bookings },
          })),
          {
            cells: {
              designer: 'TEAM TOTAL', target: b.teamTarget ?? NA, achieved: b.teamAchieved,
              pct: b.overallPct ?? NA,
            },
            na: naWhy({ target: [b.teamTarget, b.teamWhy], pct: [b.overallPct, b.teamWhy] }),
            drill: { achieved: b.rows.flatMap((r) => r.bookings) },
          },
        ],
      });
      summary[`${team.bl.name} | ${b.cycle}`] = {
        teamTarget: b.teamTarget, teamAchieved: b.teamAchieved, overallPct: b.overallPct,
        designersInTeam: b.rows.length, designersExcludedNoTarget: b.designersExcludedNoTarget,
        achievedByDesignersWithTarget: b.achievedByDesignersWithTarget,
      };
    }
  }
  return {
    notes: [
      'Individual Achieved = Booking Value from the Designer report 1 logic (designerReports.ts myPerformance), per designer, per 16th–15th cycle.',
      BL_BOOKING_VALUE_NOTE,
      'Individual Target = designer_targets.bookingTargetValue for the cycle. A designer without a row shows N/A and is excluded from Team Total Target; their achieved value is still in Team Total Achieved (see summary.achievedByDesignersWithTarget).',
      'Overall BL Achievement % = Team Total Achieved / Team Total Target.',
      FILTER_NOTE(q),
      ...TARGET_NOTE(q),
      `Date range: ${str(q.from) || str(q.to) ? rangeLabel(q) : 'current cycle'}`,
    ],
    summary, tables,
  };
}

// ── 2. BL Pipeline ────────────────────────────────────────────────────────────
async function blPipeline(user: U, q: Q): Promise<Result> {
  requireRole(user, ['BL', 'BRANCH_HEAD']);
  return rolePipeline(user, q);
}

// ── 3. BL Conversion Metrics ──────────────────────────────────────────────────
async function blConversion(user: U, q: Q): Promise<Result> {
  requireRole(user, ['BL', 'BRANCH_HEAD']);
  return roleConversion(user, q);
}

async function reportScope(user: U, q: Q) {
  if (user.role === 'DESIGNER') {
    return { designers: await prisma.user.findMany({ where: { id: user.id }, select: { id: true, name: true } }) };
  }
  const teams = await resolveTeams(user, { ...q, designerId: undefined });
  return { designers: teams.flatMap((team) => team.designers) };
}

/** Current-stage inventory, shared by BL and designer portals. */
async function rolePipeline(user: U, q: Q): Promise<Result> {
  requireRole(user, ['DESIGNER', 'BL', 'BRANCH_HEAD']);
  const where = await leadWhere(user, q);
  if (user.role === 'BRANCH_HEAD' && !where.assignedBLId) where.assignedBLId = { not: null };
  const all = await prisma.lead.findMany({
    where, select: { ...FUNNEL_COHORT_SELECT, status: true },
  });
  const cohort = all.filter((lead) => FUNNEL_STAGES.includes(lead.stage as any));
  const rows = currentStageInventory(cohort, FUNNEL_STAGES);
  return {
    scope: await reportScope(user, q),
    notes: [
      'Current pipeline snapshot: each lead is counted only in its current stage, not again in earlier stages.',
      'Total = Active + On Hold + Inactive. All three statuses are included; test leads are excluded. Date filters use Lead Received Date.',
      `Legacy/off-funnel leads excluded: ${all.length - cohort.length}. Date range: ${rangeLabel(q)}`,
    ],
    summary: { cohortSize: cohort.length, offFunnelExcluded: all.length - cohort.length },
    tables: [{
      title: user.role === 'DESIGNER' ? 'Designer Pipeline' : 'BL Pipeline',
      columns: [
        { key: 'stage', label: 'Stage' }, { key: 'total', label: 'Total' },
        { key: 'active', label: 'Active' }, { key: 'onHold', label: 'On Hold' }, { key: 'inactive', label: 'Inactive' },
      ],
      rows: rows.map((r) => ({
        cells: { stage: r.stage, total: r.total, active: r.active.length, onHold: r.onHold.length, inactive: r.inactive.length },
        drill: {
          total: r.leads.map((l) => brief(l, { currentStage: l.stage, status: l.status })),
          active: r.active.map((l) => brief(l)), onHold: r.onHold.map((l) => brief(l)), inactive: r.inactive.map((l) => brief(l)),
        },
      })),
    }],
  };
}

/** Full adjacent-stage progression replaces the repeated three-row summary. */
async function roleConversion(user: U, q: Q): Promise<Result> {
  requireRole(user, ['DESIGNER', 'BL', 'BRANCH_HEAD']);
  const where = await leadWhere(user, q);
  if (user.role === 'BRANCH_HEAD' && !where.assignedBLId) where.assignedBLId = { not: null };
  const cohort = await prisma.lead.findMany({
    where: { AND: [where, { stage: { in: [...FUNNEL_STAGES] } }] },
    select: { ...FUNNEL_COHORT_SELECT, status: true, dipChecklist: { select: { completedAt: true } } },
  });
  const entries = await loadFirstStageEntries(cohort.map((l) => l.id));
  const transitions = stageProgression(cohort, FUNNEL_STAGES, entries);
  return {
    scope: await reportScope(user, q),
    notes: [
      'Stage-by-stage progression: Leads = reached the source stage; Converted = reached the next stage. Conversion % = Converted ÷ Leads × 100. N/A means no source leads.',
      'Reached uses the furthest stage in recorded history or the current stage; later stages imply earlier stages. Moving a lead backwards does not erase its earlier progress. This is not the current-stage Pipeline inventory.',
      'Design in Progress conversion requires a completed DIP checklist. All lead statuses are included; test and legacy/off-funnel leads are excluded. Date filters use Lead Received Date.',
      `Date range: ${rangeLabel(q)}`,
    ],
    summary: { cohortSize: cohort.length },
    tables: [{
      title: user.role === 'DESIGNER' ? 'Designer Conversion' : 'BL Conversion',
      columns: [
        { key: 'from', label: 'Stage' }, { key: 'to', label: 'To' },
        { key: 'fromCount', label: 'Leads' }, { key: 'toCount', label: 'Converted' }, { key: 'rate', label: 'Conversion %' },
      ],
      rows: transitions.map((t) => ({
        cells: { from: t.from, to: t.to, fromCount: t.source.length, toCount: t.converted.length, rate: t.rate ?? NA },
        na: naWhy({ rate: [t.rate, 'No leads reached this source stage (zero denominator)'] }),
        drill: {
          fromCount: t.source.map((l) => brief(l, { currentStage: l.stage })),
          toCount: t.converted.map((l) => brief(l, { currentStage: l.stage })),
          rate: t.converted.map((l) => brief(l, { currentStage: l.stage })),
        },
      })),
    }],
  };
}

// ── 4. Discount Metrics ───────────────────────────────────────────────────────
async function discountMetrics(user: U, q: Q): Promise<Result> {
  requireRole(user, ['DESIGNER', 'BL', 'BRANCH_HEAD']);
  const where = await leadWhere(user, q);
  const teams: Team[] = user.role === 'DESIGNER'
    ? [{ bl: { id: user.id, name: 'Designer' }, designers: (await reportScope(user, q)).designers }]
    : await resolveTeams(user, q);
  const tables: Table[] = [];
  for (const team of teams) {
    const rows: Table['rows'] = [];
    for (const d of team.designers) {
      const reqs = await prisma.discountRequest.findMany({
        where: {
          lead: { AND: [where, { assignedDesignerId: d.id }] },
        },
        select: {
          id: true, status: true, amount: true, originalAmount: true,
          lead: { select: { id: true, leadId: true, name: true } },
        },
      });
      const by = (st: string) => reqs.filter((r) => r.status === st);
      const approved = by('APPROVED');
      const sumAmount = approved.reduce((a, r) => a + Number(r.amount), 0);
      const sumGiven = approved.reduce((a, r) => a + (Number(r.originalAmount) - Number(r.amount)), 0);
      const L = (list: typeof reqs, extra?: (r: typeof reqs[number]) => Record<string, unknown>) =>
        list.map((r) => brief(r.lead, { status: r.status, amount: Number(r.amount), originalAmount: Number(r.originalAmount), ...(extra?.(r) ?? {}) }));
      rows.push({
        cells: {
          designer: d.name, requests: reqs.length, approved: approved.length, rejected: by('REJECTED').length,
          pending: by('PENDING').length, rate: pct(approved.length, reqs.length) ?? NA,
          sumAmount, sumGiven,
        },
        na: naWhy({ rate: [pct(approved.length, reqs.length), 'No discount requests in this period (zero denominator)'] }),
        drill: { requests: L(reqs), approved: L(approved), rejected: L(by('REJECTED')), pending: L(by('PENDING')), sumAmount: L(approved), sumGiven: L(approved) },
      });
    }
    tables.push({
      title: `${team.bl.name} — discount metrics`,
      columns: [
        { key: 'designer', label: 'Designer' }, { key: 'requests', label: 'Requests' }, { key: 'approved', label: 'Approved' },
        { key: 'rejected', label: 'Rejected' }, { key: 'pending', label: 'Pending' }, { key: 'rate', label: 'Approval Rate %' },
        { key: 'sumGiven', label: 'Total Discount Value' },
        { key: 'sumAmount', label: 'Approved Deal Value (post-discount)' },
      ],
      rows,
    });
  }
  return {
    scope: await reportScope(user, q),
    notes: [
      'Total Discount Value = sum of (originalAmount − amount) for APPROVED requests. Approved Deal Value (post-discount) = sum of discount_requests.amount for APPROVED requests; `amount` is the post-discount price (discounts.ts:130/160), so it is a deal value, not a discount.',
      'Requests are attributed to the designer assigned to the lead (lead.assignedDesignerId) — the same lead-based attribution reports.ts blPerformance uses. Cohort: leadOriginDate in range (non-test).',
      'Approval Rate % = Approved / Total Requests x 100.',
      `Date range: ${rangeLabel(q)}`,
    ],
    tables,
  };
}

// ── 5. Meeting Performance (Team) ─────────────────────────────────────────────
async function teamMeetings(user: U, q: Q): Promise<Result> {
  const teams = await resolveTeams(user, q);
  const tables: Table[] = [];
  for (const team of teams) {
    const rows: Table['rows'] = [];
    for (const d of team.designers) {
      const m: any = await meetingPerformanceByType(user, { from: q.from, to: q.to, designerId: d.id }, await attrFilter(q));
      const all = m.rows.flatMap((r: any) => r.drilldown) as any[];
      const sel = (st?: string) => all.filter((x) => !st || x.status === st).map((x) => brief(x, { status: x.status, scheduledAt: x.scheduledAt }));
      rows.push({
        cells: {
          designer: d.name, total: m.totals.total, upcoming: m.totals.upcoming, completed: m.totals.completed,
          noShow: m.totals.noShow, rescheduled: m.totals.rescheduled, noShowPct: m.totals.noShowPct ?? NA,
        },
        na: naWhy({ noShowPct: [m.totals.noShowPct, 'No meetings scheduled in this period (zero denominator)'] }),
        drill: { total: sel(), upcoming: sel('SCHEDULED'), completed: sel('COMPLETED'), noShow: sel('NO_SHOW'), rescheduled: sel('RESCHEDULED') },
      });
    }
    const sumK = (k: string) => rows.reduce((a, r) => a + (r.cells as any)[k], 0);
    const tot = sumK('total');
    rows.push({
      cells: {
        designer: 'TEAM TOTAL', total: tot, upcoming: sumK('upcoming'), completed: sumK('completed'),
        noShow: sumK('noShow'), rescheduled: sumK('rescheduled'), noShowPct: pct(sumK('noShow'), tot) ?? NA,
      },
      na: naWhy({ noShowPct: [pct(sumK('noShow'), tot), 'No meetings scheduled in this period (zero denominator)'] }),
      drill: Object.fromEntries(['total', 'upcoming', 'completed', 'noShow', 'rescheduled'].map((k) => [k, rows.flatMap((r) => r.drill![k])])),
    });
    tables.push({
      title: `${team.bl.name} — meetings`,
      columns: [
        { key: 'designer', label: 'Designer' }, { key: 'total', label: 'Total Scheduled' }, { key: 'upcoming', label: 'Upcoming' },
        { key: 'completed', label: 'Completed' }, { key: 'noShow', label: 'No-Show' }, { key: 'rescheduled', label: 'Rescheduled' },
        { key: 'noShowPct', label: 'No-Show %' },
      ],
      rows,
    });
  }
  return {
    notes: [
      'Per designer this calls meetingPerformanceByType (designerReports.ts) and uses its totals. Total Scheduled = SCHEDULED + COMPLETED + NO_SHOW + RESCHEDULED; Upcoming = SCHEDULED; No-Show % = No-Show / Total Scheduled x 100. Filtered by meetings.scheduledAt.',
      FILTER_NOTE(q),
      `Date range: ${rangeLabel(q)}`,
    ],
    tables,
  };
}

// ── 6. Company-Wide Lead Summary ──────────────────────────────────────────────

async function userNames(ids: (string | null)[]) {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  const users = uniq.length ? await prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } }) : [];
  return new Map(users.map((u) => [u.id, u.name]));
}

async function companyLeadSummary(user: U, q: Q): Promise<Result> {
  requireRole(user, ['BRANCH_HEAD']);
  const range = resolveRange(q);
  const where = await leadWhere(user, q, { dateField: null });
  const select = { id: true, leadId: true, name: true, source: true, assignedBLId: true, assignedDesignerId: true, leadOriginDate: true } as const;
  const hasRange = !!(range.gte || range.lte);
  const all = await prisma.lead.findMany({ where, select });
  const entries = await loadFirstStageEntries(all.map((l) => l.id));
  const inR = (d: Date) => (!range.gte || d >= range.gte) && (!range.lte || d <= range.lte);
  let fallback = 0;
  const info = all.map((l) => {
    const m = mqlReceived(entries, l);
    if (m.fallback) fallback += 1;
    return { l, received: !hasRange || inR(l.leadOriginDate), mql: !hasRange || inR(m.date) };
  }).filter((x) => x.received || x.mql);
  const names = await userNames(info.flatMap((x) => [x.l.assignedBLId, x.l.assignedDesignerId]));
  const groups = new Map<string, { bl: string; designer: string; source: string; variants: Map<string, number>; leads: DrillLead[]; mqlLeads: DrillLead[] }>();
  for (const x of info) {
    const bl = x.l.assignedBLId ? names.get(x.l.assignedBLId) ?? x.l.assignedBLId : 'Unassigned';
    const des = x.l.assignedDesignerId ? names.get(x.l.assignedDesignerId) ?? x.l.assignedDesignerId : 'Unassigned';
    const key = `${bl}|${des}|${normSource(x.l.source)}`;
    const g: (typeof groups extends Map<string, infer V> ? V : never) = groups.get(key) ?? { bl, designer: des, source: normSource(x.l.source), variants: new Map(), leads: [], mqlLeads: [] };
    const raw = x.l.source?.trim() || 'Unknown';
    g.variants.set(raw, (g.variants.get(raw) ?? 0) + 1);
    if (x.received) g.leads.push(brief(x.l));
    if (x.mql) g.mqlLeads.push(brief(x.l));
    groups.set(key, g);
  }
  const rows = [...groups.values()]
    .sort((a, b) => a.bl.localeCompare(b.bl) || a.designer.localeCompare(b.designer) || a.source.localeCompare(b.source))
    .map((g) => ({
      cells: {
        range: rangeLabel(q), bl: g.bl, designer: g.designer,
        source: [...g.variants.entries()].sort((a, b) => b[1] - a[1])[0][0],
        leadCount: g.leads.length, mqlCount: g.mqlLeads.length,
      },
      drill: { leadCount: g.leads, mqlCount: g.mqlLeads },
    }));
  return {
    notes: [
      'No Branch column: the schema has no branch field on Lead or User (BRANCH_HEAD is a role only).',
      'Lead Count = leads with leadOriginDate in the range. MQL Count = leads whose MQL Received Date (first STAGE_CHANGED log with meta.to = MQL, else leadOriginDate) is in the range. The two columns use different date anchors, so MQL Count can exceed Lead Count.',
      `Leads using the leadOriginDate fallback for MQL date (all non-test leads in filter scope): ${fallback}`,
      'Source values are grouped ignoring case and treating "-", "_" and space as the same; stored data is unchanged.',
    ],
    summary: { mqlFallbackLeads: fallback },
    tables: [{
      title: 'Company-wide lead summary',
      columns: [
        { key: 'range', label: 'Date Range' }, { key: 'bl', label: 'BL' }, { key: 'designer', label: 'Designer' },
        { key: 'source', label: 'Source' }, { key: 'leadCount', label: 'Lead Count' }, { key: 'mqlCount', label: 'MQL Count' },
      ],
      rows,
    }],
  };
}

// ── 7. Company-Wide Pipeline & Conversion ─────────────────────────────────────
async function companyPipeline(user: U, q: Q): Promise<Result> {
  requireRole(user, ['BRANCH_HEAD']);
  const where = await leadWhere(user, q);
  const [cohort, off] = await Promise.all([
    prisma.lead.findMany({ where: { ...where, stage: { in: [...FUNNEL_STAGES] } }, select: FUNNEL_COHORT_SELECT }),
    prisma.lead.count({ where: { ...where, stage: { notIn: [...FUNNEL_STAGES] } } }),
  ]);
  const names = await userNames(cohort.flatMap((l) => [l.assignedBLId, l.assignedDesignerId]));
  const cum = cumulative(cohort);
  const tables: Table[] = [{
    title: 'Company-wide pipeline',
    columns: [{ key: 'stage', label: 'Stage' }, { key: 'count', label: 'Cumulative Count' }, { key: 'pct', label: 'Cumulative %' }],
    rows: cum.map((r) => ({
      cells: { stage: r.stage, count: r.count, pct: r.pct ?? NA },
      na: naWhy({ pct: [r.pct, WHY_EMPTY_COHORT] }),
      drill: { count: r.leads.map((l) => brief(l, { currentStage: l.stage })) },
    })),
  }];
  // Drill-down to BL and Designer, per stage.
  const dd: { stage: string; bl: string; designer: string; n: number; leads: DrillLead[] }[] = [];
  for (const r of cum) {
    const g = new Map<string, { bl: string; designer: string; leads: DrillLead[] }>();
    for (const l of r.leads) {
      const bl = l.assignedBLId ? names.get(l.assignedBLId) ?? l.assignedBLId : 'Unassigned';
      const des = l.assignedDesignerId ? names.get(l.assignedDesignerId) ?? l.assignedDesignerId : 'Unassigned';
      const k = `${bl}|${des}`;
      const e = g.get(k) ?? { bl, designer: des, leads: [] };
      e.leads.push(brief(l, { currentStage: l.stage }));
      g.set(k, e);
    }
    for (const e of [...g.values()].sort((a, b) => a.bl.localeCompare(b.bl) || a.designer.localeCompare(b.designer))) {
      dd.push({ stage: r.stage, bl: e.bl, designer: e.designer, n: e.leads.length, leads: e.leads });
    }
  }
  tables.push({
    title: 'Drill-down by BL and Designer (cumulative count per stage)',
    columns: [{ key: 'stage', label: 'Stage' }, { key: 'bl', label: 'BL' }, { key: 'designer', label: 'Designer' }, { key: 'count', label: 'Cumulative Count' }],
    rows: dd.map((e) => ({ cells: { stage: e.stage, bl: e.bl, designer: e.designer, count: e.n }, drill: { count: e.leads } })),
  });
  return {
    notes: [
      stageNote,
      'Cohort: all non-test leads matching the filters with leadOriginDate in the range and current stage on the active funnel. Cumulative Count = current stage is this stage or any later funnel stage; % = count / cohort size (dashboard.ts logic).',
      `Cohort size ${cohort.length}; legacy/off-funnel excluded: ${off}. Date range: ${rangeLabel(q)}`,
    ],
    summary: { cohortSize: cohort.length, offFunnelExcluded: off },
    tables,
  };
}

// ── 8. Designer Performance (All) ─────────────────────────────────────────────
async function designerPerformanceAll(user: U, q: Q): Promise<Result> {
  requireRole(user, ['BRANCH_HEAD']);
  const designers = await prisma.user.findMany({
    where: { role: 'DESIGNER', isActive: true, ...(str(q.blId) ? { blId: str(q.blId)! } : {}), ...(str(q.designerId) ? { id: str(q.designerId)! } : {}) },
    select: { id: true, name: true }, orderBy: { name: 'asc' },
  });
  const tables: Table[] = [];
  const summary: Record<string, unknown> = {};
  for (const d of designers) {
    const p = await myPerformance(user, { from: q.from, to: q.to, designerId: d.id }, await attrFilter(q));
    for (const b of p.blocks) {
      const leadsMap = (list: any[]) => list as DrillLead[];
      tables.push({
        title: `${d.name} — cycle ${b.cycle.label}`,
        columns: [
          { key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value' },
        ],
        rows: [
          { cells: { metric: 'Proposal Presented', value: b.effort.proposalPresentedCount }, drill: { value: leadsMap(b.drilldown.proposalPresented) } },
          { cells: { metric: 'Lead → Onboarding TAT (avg days)', value: b.effort.leadToOnboardingTatAvgDays ?? NA }, na: naWhy({ value: [b.effort.leadToOnboardingTatAvgDays, 'No onboardings with a Design-in-Progress log in this cycle'] }), drill: { value: leadsMap(b.drilldown.onboardings) } },
          { cells: { metric: 'Onboarding within 7 days %', value: b.effort.onboardingWithin7DaysPct ?? NA }, na: naWhy({ value: [b.effort.onboardingWithin7DaysPct, 'No onboardings with a TAT in this cycle (zero denominator)'] }) },
          { cells: { metric: 'Average NPS', value: b.effort.averageNps ?? NA }, na: naWhy({ value: [b.effort.averageNps, 'No scored NPS responses in this cycle'] }) },
          { cells: { metric: 'Onboarding count', value: b.result.onboardingCount }, drill: { value: leadsMap(b.drilldown.onboardings) } },
          { cells: { metric: 'Booking Value', value: b.result.bookingValue }, drill: { value: leadsMap(b.drilldown.bookings) } },
          { cells: { metric: 'Conversion %', value: b.result.conversionPct ?? NA }, na: naWhy({ value: [b.result.conversionPct, 'No leads received in this cycle (zero denominator)'] }), drill: { value: leadsMap(b.drilldown.leadsReceived) } },
          { cells: { metric: 'Monthly Target', value: b.target.monthlyTarget ?? NA }, na: naWhy({ value: [b.target.monthlyTarget, 'No target row for this designer for this cycle'] }) },
          { cells: { metric: 'Remaining Target', value: b.target.remainingTarget ?? NA }, na: naWhy({ value: [b.target.remainingTarget, 'No target row for this designer for this cycle, so nothing to subtract from'] }) },
        ],
      });
      summary[`${d.name} | ${b.cycle.label}`] = { onboardingCount: b.result.onboardingCount, bookingValue: b.result.bookingValue, conversionPct: b.result.conversionPct };
    }
  }
  return {
    notes: [
      'Each designer block is the output of the Designer report 1 function (designerReports.ts myPerformance), unchanged.',
      FILTER_NOTE(q),
      ...TARGET_NOTE(q),
      `Date range: ${str(q.from) || str(q.to) ? rangeLabel(q) : 'current cycle'}`,
    ],
    summary, tables,
  };
}

// ── 9. BL Performance (All) ───────────────────────────────────────────────────
async function blPerformanceAll(user: U, q: Q): Promise<Result> {
  requireRole(user, ['BRANCH_HEAD']);
  const bls = await prisma.user.findMany({
    where: { role: 'BL', isActive: true, ...(str(q.blId) ? { id: str(q.blId)! } : {}) },
    select: { id: true, name: true }, orderBy: { name: 'asc' },
  });
  const byCycle = new Map<string, { bl: string; team: number; achieved: number; pct: number | null; excluded: number; bookings: DrillLead[]; why: string }[]>();
  for (const bl of bls) {
    const designers = await prisma.user.findMany({
      where: { blId: bl.id, role: 'DESIGNER', isActive: true, ...(str(q.designerId) ? { id: str(q.designerId)! } : {}) },
      select: { id: true, name: true }, orderBy: { name: 'asc' },
    });
    if (str(q.designerId) && !designers.length) continue;
    const blocks = await teamPerformanceBlocks(user, { bl, designers }, q);
    for (const b of blocks) {
      const list = byCycle.get(b.cycle) ?? [];
      list.push({
        bl: bl.name, team: b.teamTarget as number, achieved: b.teamAchieved, pct: b.overallPct,
        excluded: b.designersExcludedNoTarget, bookings: b.rows.flatMap((r) => r.bookings), why: b.teamWhy,
      });
      byCycle.set(b.cycle, list);
    }
  }
  const tables: Table[] = [...byCycle.entries()].map(([cycle, list]) => ({
    title: `Cycle ${cycle}`,
    columns: [
      { key: 'bl', label: 'BL' }, { key: 'target', label: 'Team Total Target' }, { key: 'achieved', label: 'Team Total Achieved' },
      { key: 'pct', label: 'Achievement %' }, { key: 'excluded', label: 'Designers excluded (no target)' },
    ],
    rows: list.map((r) => ({
      cells: { bl: r.bl, target: r.team ?? NA, achieved: r.achieved, pct: r.pct ?? NA, excluded: r.excluded },
      na: naWhy({ target: [r.team, r.why], pct: [r.pct, r.why] }),
      drill: { achieved: r.bookings },
    })),
  }));
  return {
    notes: [
      'Per BL this is the same team computation as BL Performance (report 1): Booking Value and targets come from the Designer report 1 logic. Team Total Target excludes designers with no designer_targets row for the cycle; Achievement % = Team Total Achieved / Team Total Target.',
      BL_BOOKING_VALUE_NOTE,
      FILTER_NOTE(q),
      ...TARGET_NOTE(q),
      `Date range: ${str(q.from) || str(q.to) ? rangeLabel(q) : 'current cycle'}`,
    ],
    tables,
  };
}

// ── 10. Lead Source & Campaign Performance ────────────────────────────────────
async function sourceCampaign(user: U, q: Q): Promise<Result> {
  requireRole(user, ['BRANCH_HEAD']);
  const where = await leadWhere(user, q);
  const leads = await prisma.lead.findMany({
    where, select: { id: true, leadId: true, name: true, source: true, utmCampaign: true, stage: true },
  });
  const mqlSet = new Set<string>(FUNNEL_STAGES);
  const obSet = new Set<string>(FUNNEL_STAGES.slice(FUNNEL_STAGES.indexOf('ONBOARDING')));
  const groups = new Map<string, { variants: Map<string, number>; campaign: string; leads: typeof leads }>();
  for (const l of leads) {
    const campaign = l.utmCampaign?.trim() || '—';
    const key = `${normSource(l.source)}|${campaign}`;
    const g: (typeof groups extends Map<string, infer V> ? V : never) = groups.get(key) ?? { variants: new Map(), campaign, leads: [] };
    const raw = l.source?.trim() || 'Unknown';
    g.variants.set(raw, (g.variants.get(raw) ?? 0) + 1);
    g.leads.push(l);
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.leads.length - a.leads.length).map((g) => {
    const mql = g.leads.filter((l) => mqlSet.has(l.stage));
    const ob = g.leads.filter((l) => obSet.has(l.stage));
    const d = (list: typeof leads) => list.map((l) => brief(l, { currentStage: l.stage }));
    return {
      cells: {
        source: [...g.variants.entries()].sort((a, b) => b[1] - a[1])[0][0], campaign: g.campaign,
        total: g.leads.length, mqlRate: pct(mql.length, g.leads.length) ?? NA, obRate: pct(ob.length, g.leads.length) ?? NA,
      },
      drill: { total: d(g.leads), mqlRate: d(mql), obRate: d(ob) },
    };
  });
  return {
    notes: [
      stageNote,
      'MQL Reach Rate % = leads whose current stage is MQL or later on the active funnel / total leads in the group. OB Reach Rate % = current stage ONBOARDING or later (ONBOARDING, ONBOARDING_MEETING, DESIGN_IN_PROGRESS) / total. Legacy stages (EFFECTIVE_LEAD, HANDED_OVER, INACTIVE, ON_HOLD) count in the total but not as reached.',
      'Source grouping ignores case and treats "-", "_" and space as the same (display only). UTM campaign is grouped by exact trimmed value; blank shows "—".',
      `Cohort: non-test leads with leadOriginDate in range. Date range: ${rangeLabel(q)}`,
      FILTER_NOTE(q),
    ],
    tables: [{
      title: 'Source & campaign performance',
      columns: [
        { key: 'source', label: 'Source' }, { key: 'campaign', label: 'UTM Campaign' }, { key: 'total', label: 'Total Leads' },
        { key: 'mqlRate', label: 'MQL Reach Rate %' }, { key: 'obRate', label: 'OB Reach Rate %' },
      ],
      rows,
    }],
  };
}

// ── 11. Inactive Leads & Reasons ──────────────────────────────────────────────
async function inactiveLeadsReport(user: U, q: Q): Promise<Result> {
  requireRole(user, ['BRANCH_HEAD']);
  const where = { ...(await leadWhere(user, q)), status: 'INACTIVE' };
  delete where.stage; // stage filter is applied to the stage at drop-off below
  const leads = await prisma.lead.findMany({
    where,
    select: {
      id: true, leadId: true, name: true, stage: true, preHoldStage: true, inactiveReason: true,
      inactivationFeedback: { select: { reason: true } },
    },
  });
  const ids = leads.map((l) => l.id);
  const logs = ids.length
    ? await prisma.activityLog.findMany({
      where: { leadId: { in: ids }, action: { in: ['STATUS_CHANGED', 'STAGE_CHANGED'] } },
      orderBy: { createdAt: 'asc' }, select: { leadId: true, action: true, createdAt: true, meta: true },
    })
    : [];
  const stageFilter = str(q.stage);
  const rows: Table['rows'] = [];
  for (const l of leads) {
    const mine = logs.filter((x) => x.leadId === l.id);
    const toInactive = mine.filter((x) => (x.meta as any)?.to === 'INACTIVE');
    const last = toInactive[toInactive.length - 1];
    let stageAt: string = l.stage;
    let stageNote = '';
    if (l.stage === 'INACTIVE' || l.stage === 'ON_HOLD') {
      const from = (last?.meta as any)?.from;
      stageAt = l.preHoldStage ?? (last?.action === 'STAGE_CHANGED' && from) ?? NA;
      if (stageAt === NA) stageNote = ' (legacy stage value; no earlier stage recorded)';
    }
    if (stageFilter && stageAt !== stageFilter) continue;
    rows.push({
      cells: {
        lead: `${l.name} (${l.leadId})`,
        stage: stageAt === NA ? `${NA}${stageNote}` : stageAt,
        reason: l.inactiveReason ?? l.inactivationFeedback?.reason ?? `${NA} (no reason recorded)`,
        date: last ? last.createdAt.toISOString().slice(0, 10) : `${NA} (no inactivation log)`,
      },
      drill: { lead: [brief(l)] },
    });
  }
  return {
    notes: [
      'Stage at drop-off = lead.stage (stage is preserved while status = INACTIVE, task #88). For legacy rows whose stage is INACTIVE/ON_HOLD it uses preHoldStage, else the log `from`, else N/A.',
      'Reason = lead.inactiveReason, else inactivation_feedback.reason, else N/A. Date Inactivated = createdAt of the latest activity log whose meta.to = INACTIVE, else N/A.',
      `Cohort: non-test leads with status INACTIVE and leadOriginDate in range (lead-cohort rule). The Stage filter applies to the stage at drop-off. Date range: ${rangeLabel(q)}`,
    ],
    summary: { inactiveLeads: rows.length },
    tables: [{
      title: 'Inactive leads',
      columns: [{ key: 'lead', label: 'Lead' }, { key: 'stage', label: 'Stage at drop-off' }, { key: 'reason', label: 'Reason' }, { key: 'date', label: 'Date Inactivated' }],
      rows,
    }],
  };
}

// ── 12. Lead Aging ────────────────────────────────────────────────────────────
async function leadAging(user: U, q: Q): Promise<Result> {
  requireRole(user, ['BRANCH_HEAD']);
  const where = { ...(await leadWhere(user, q)), status: 'ACTIVE' };
  if (!where.stage) where.stage = { in: [...FUNNEL_STAGES] };
  const leads = await prisma.lead.findMany({
    where, select: { id: true, leadId: true, name: true, stage: true, createdAt: true },
  });
  const [info, thresholds] = await Promise.all([computeSlaInfoForLeads(leads), getEffectiveStageSla()]);
  const rows = leads
    .map((l) => ({ l, i: info[l.id], t: thresholds[l.stage] }))
    .sort((a, b) => b.i.daysInCurrentStage - a.i.daysInCurrentStage)
    .map(({ l, i, t }) => ({
      cells: {
        lead: `${l.name} (${l.leadId})`, stage: l.stage, days: i.daysInCurrentStage,
        threshold: t ? `${t.breachDays} days (warning ${t.warningDays})` : `${NA} (no SLA defined for this stage)`,
        breached: t ? (i.slaStatus === 'breach' ? 'Y' : 'N') : NA,
      },
      na: t ? undefined : { breached: 'No SLA is defined for this stage' },
      drill: { lead: [brief(l, { currentStage: l.stage })] },
    }));
  return {
    notes: [
      'Days in Stage and Breached come from lib/stageSla.ts computeSlaInfoForLeads (same as the lead list SLA badge): days since the latest STAGE_CHANGED log (lead.createdAt if none). SLA Threshold = effective breachDays (config/slaConfig.ts defaults plus admin overrides in stage_sla_thresholds). Breached = Y when days >= breachDays.',
      'Stages without a configured SLA (PROPOSAL_PRESENTED, ONBOARDING_MEETING, DESIGN_IN_PROGRESS) show N/A for threshold and Breached.',
      'Cohort: non-test leads with status ACTIVE on the active funnel (or the Stage filter), leadOriginDate in range.',
    ],
    summary: { leads: rows.length, breached: rows.filter((r) => r.cells.breached === 'Y').length },
    tables: [{
      title: 'Lead aging',
      columns: [
        { key: 'lead', label: 'Lead' }, { key: 'stage', label: 'Current Stage' }, { key: 'days', label: 'Days in Stage' },
        { key: 'threshold', label: 'SLA Threshold' }, { key: 'breached', label: 'Breached (Y/N)' },
      ],
      rows,
    }],
  };
}

// ── 13. Trend (monthly / quarterly / annual) ──────────────────────────────────
const WON_STAGES = ['DESIGN_IN_PROGRESS', 'HANDED_OVER']; // same definition as reports.ts WON_STAGES / monthly_trend

async function trend(user: U, q: Q): Promise<Result> {
  requireRole(user, ['BRANCH_HEAD']);
  const g = str(q.granularity) ?? 'monthly';
  if (!['monthly', 'quarterly', 'annual'].includes(g)) throw new HttpError(400, 'granularity must be monthly, quarterly or annual');
  const where = await leadWhere(user, q);
  const leads = await prisma.lead.findMany({
    where, select: { id: true, leadId: true, name: true, stage: true, leadOriginDate: true },
  });
  const key = (d: Date) => {
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    const y = ist.getUTCFullYear(); const m = ist.getUTCMonth();
    return g === 'monthly' ? `${y}-${String(m + 1).padStart(2, '0')}` : g === 'quarterly' ? `${y}-Q${Math.floor(m / 3) + 1}` : `${y}`;
  };
  const groups = new Map<string, typeof leads>();
  for (const l of leads) { const k = key(l.leadOriginDate); groups.set(k, [...(groups.get(k) ?? []), l]); }
  const rows = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, list]) => {
    const conv = list.filter((l) => WON_STAGES.includes(l.stage));
    const d = (x: typeof leads) => x.map((l) => brief(l, { currentStage: l.stage }));
    return {
      cells: { period: k, created: list.length, converted: conv.length, pct: pct(conv.length, list.length) ?? NA },
      drill: { created: d(list), converted: d(conv) },
    };
  });
  return {
    notes: [
      `Converted = the existing monthly_trend definition (reports.ts:12 WON_STAGES, used at reports.ts monthlyTrend): lead's CURRENT stage is DESIGN_IN_PROGRESS or HANDED_OVER. It has no DIP-checklist condition, so it can differ from the Designer-report onboarding count.`,
      'Leads Created = non-test leads with leadOriginDate in the period (IST); the existing monthly_trend buckets by createdAt in UTC, so its counts can differ for the same range. Conversion % = Converted / Created.',
      `Granularity: ${g}. Date range: ${rangeLabel(q)}`,
    ],
    tables: [{
      title: `${g[0].toUpperCase()}${g.slice(1)} trend`,
      columns: [{ key: 'period', label: 'Period' }, { key: 'created', label: 'Leads Created' }, { key: 'converted', label: 'Leads Converted' }, { key: 'pct', label: 'Conversion %' }],
      rows,
    }],
  };
}

// ── 14. Offer Performance ─────────────────────────────────────────────────────
async function offerPerformance(user: U, q: Q): Promise<Result> {
  requireRole(user, ['BRANCH_HEAD']);
  const range = resolveRange(q);
  const where = await leadWhere(user, q, { dateField: null });
  const linked = await prisma.lead.findMany({
    where: { ...where, leadOffers: { some: {} } },
    select: { id: true, leadId: true, name: true, estimatedValue: true, leadOffers: { select: { offerId: true } } },
  });
  const onboardedIds = new Set((await prisma.lead.findMany({
    where: { ...where, id: { in: linked.map((l) => l.id) }, OR: DASHBOARD_ONBOARDING_OR as any },
    select: { id: true },
  })).map((l) => l.id));
  const entries = await loadFirstStageEntries([...onboardedIds]);
  const inR = (d: Date) => (!range.gte || d >= range.gte) && (!range.lte || d <= range.lte);
  const offers = await prisma.offer.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const hasRange = !!(range.gte || range.lte);
  const rows = offers.map((o) => {
    const ls = linked.filter((l) => l.leadOffers.some((x) => x.offerId === o.id));
    const ob = ls.filter((l) => {
      if (!onboardedIds.has(l.id)) return false;
      if (!hasRange) return true;
      const dip = entries.get(l.id)?.get('DESIGN_IN_PROGRESS');
      return !!dip && inR(dip);
    });
    const value = ob.reduce((a, l) => a + Number(l.estimatedValue ?? 0), 0);
    const d = (x: typeof ls) => x.map((l) => brief(l, { estimatedValue: l.estimatedValue == null ? null : Number(l.estimatedValue) }));
    return {
      cells: { offer: o.name, onboardings: ob.length, value, linked: ls.length },
      drill: { onboardings: d(ob), value: d(ob), linked: d(ls) },
    };
  });
  return {
    notes: [
      `Leads with an offer linked (any lead_offers row, non-test, filters applied): ${linked.length}.`,
      'A lead counts for an offer if the offer was ever applied (lead_offers history), as in the existing offer_performance report. Onboarding = Designer-report onboarding condition (DESIGN_IN_PROGRESS/HANDED_OVER with completed DIP checklist), and when a date range is set, first DESIGN_IN_PROGRESS log inside the range. Total Booking Value = sum of estimatedValue of those onboarded leads (N/A values count as 0 and are not invented).',
      'A lead linked to several offers is counted under each of them, so the column totals can exceed the number of onboarded leads.',
      `Date range: ${rangeLabel(q)}`,
    ],
    summary: { leadsWithOfferLinked: linked.length },
    tables: [{
      title: 'Offer performance',
      columns: [
        { key: 'offer', label: 'Offer Name' }, { key: 'onboardings', label: 'Onboardings Count' },
        { key: 'value', label: 'Total Booking Value' }, { key: 'linked', label: 'Leads linked to offer' },
      ],
      rows,
    }],
  };
}

// ── Router ────────────────────────────────────────────────────────────────────
const HANDLERS: Record<string, (user: U, q: Q) => Promise<Result>> = {
  'bl-performance': blPerformance,
  'bl-pipeline': blPipeline,
  'bl-conversion': blConversion,
  'discount-metrics': discountMetrics,
  'team-meetings': teamMeetings,
  'designer-pipeline': async (user, q) => { requireRole(user, ['DESIGNER']); return rolePipeline(user, q); },
  'designer-conversion': async (user, q) => { requireRole(user, ['DESIGNER']); return roleConversion(user, q); },
  'designer-discount-metrics': async (user, q) => { requireRole(user, ['DESIGNER']); return discountMetrics(user, q); },
  'company-lead-summary': companyLeadSummary,
  'company-pipeline': companyPipeline,
  'designer-performance-all': designerPerformanceAll,
  'bl-performance-all': blPerformanceAll,
  'source-campaign': sourceCampaign,
  'inactive-leads': inactiveLeadsReport,
  'lead-aging': leadAging,
  'trend': trend,
  'offer-performance': offerPerformance,
};

blAdminReportsRouter.get('/:type', verifyToken, async (req, res) => {
  const handler = HANDLERS[req.params.type];
  if (!handler) { res.status(404).json({ error: `Unknown report: ${req.params.type}`, available: Object.keys(HANDLERS) }); return; }
  try {
    const data = await handler(req.user!, req.query as Q);
    res.json({ type: req.params.type, data });
  } catch (err: any) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    console.error(`[bl-admin-reports:${req.params.type}]`, err);
    res.status(500).json({ error: err.message });
  }
});
