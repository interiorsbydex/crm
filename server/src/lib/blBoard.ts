/**
 * The Business Lead dashboard, as Annie's mockup (12 Nov 2026): one summary of
 * the BL's team, for a date range she picks. The rules behind "needs attention"
 * and "today's focus" (how many days, what amount, which items) are hers to
 * change in Admin → Dashboards → BL dashboard rules (blBoardRulesConfig).
 *
 * Team = the BL's active designers, plus leads the BL holds with no designer.
 * Test leads are left out, as on every dashboard.
 */
import { z } from 'zod';
import { prisma } from './prisma.js';
import { ConfigError, describeIssues, versionedConfig } from './versionedConfig.js';
import { bookingDates } from './blCredits.js';
import { loadCompletedPitches } from './completedPitches.js';
import { getFormulas } from './formulaSettings.js';
import { istDayBounds } from './istTime.js';

// ── Rules (Admin) ──────────────────────────────────────────────────────────────
export const ATTENTION_ITEMS = [
  { key: 'slaBreaches', label: 'SLA breaches' },
  { key: 'inactiveDqls', label: 'Inactive DQLs' },
  { key: 'proposalsPending', label: 'Proposals pending follow-up' },
  { key: 'noNextAction', label: 'Leads without next action' },
  { key: 'highValueUnassigned', label: 'High-value lead unassigned' },
] as const;
export const FOCUS_ITEMS = [
  { key: 'ppToday', label: 'PP expected today' },
  { key: 'onboardingsToday', label: 'Onboardings expected today' },
  { key: 'newBatches', label: 'Lead allocation for new batches' },
  { key: 'discountsPending', label: 'Discount approvals pending' },
  { key: 'teamRequestsPending', label: 'General approvals pending' },
] as const;
type AttentionKey = (typeof ATTENTION_ITEMS)[number]['key'];
type FocusKey = (typeof FOCUS_ITEMS)[number]['key'];

export interface BlBoardRules {
  /** A DQL lead with no activity for this many days is "inactive". */
  inactiveDqlDays: number;
  /** A proposal (PP or PD stage) with nothing planned and no activity for this many days is "pending follow-up". */
  proposalFollowUpDays: number;
  /** A lead worth at least this much (₹) is "high value". */
  highValueFrom: number;
  /** How many months the NPS trend line shows. */
  npsTrendMonths: number;
  attention: Record<AttentionKey, boolean>;
  focus: Record<FocusKey, boolean>;
}

export function defaultBlBoardRules(): BlBoardRules {
  return {
    inactiveDqlDays: 7,
    proposalFollowUpDays: 3,
    highValueFrom: 2500000,
    npsTrendMonths: 6,
    attention: Object.fromEntries(ATTENTION_ITEMS.map((i) => [i.key, true])) as Record<AttentionKey, boolean>,
    focus: Object.fromEntries(FOCUS_ITEMS.map((i) => [i.key, true])) as Record<FocusKey, boolean>,
  };
}

const flags = <K extends string>(keys: readonly { key: K }[]) =>
  z.object(Object.fromEntries(keys.map((k) => [k.key, z.boolean()])) as Record<K, z.ZodBoolean>).strict();
const schema = z.object({
  inactiveDqlDays: z.number().int('days must be a whole number').min(1, 'days must be at least 1').max(365, 'days can be at most 365'),
  proposalFollowUpDays: z.number().int('days must be a whole number').min(1, 'days must be at least 1').max(365, 'days can be at most 365'),
  highValueFrom: z.number().min(0, 'the amount cannot be negative').max(1e10, 'the amount is too large'),
  npsTrendMonths: z.number().int().min(2, 'show at least 2 months').max(12, 'show at most 12 months'),
  attention: flags(ATTENTION_ITEMS),
  focus: flags(FOCUS_ITEMS),
}).strict();

export const blBoardRulesConfig = versionedConfig<BlBoardRules>({
  key: 'bl_board_rules_v1',
  action: 'BL_BOARD_RULES',
  noun: 'the BL dashboard rules',
  defaults: defaultBlBoardRules,
  merge: (saved) => {
    const d = defaultBlBoardRules();
    return { ...d, ...(saved ?? {}), attention: { ...d.attention, ...(saved?.attention ?? {}) }, focus: { ...d.focus, ...(saved?.focus ?? {}) } };
  },
  validate: (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ConfigError(400, 'The BL dashboard rules could not be saved', describeIssues(parsed.error.issues, {}));
    return parsed.data as BlBoardRules;
  },
});

// ── Pure helpers (unit-checked) ────────────────────────────────────────────────
const DONE_STAGES = ['DESIGN_IN_PROGRESS', 'HANDED_OVER'];
export const FUNNEL_STAGES = [
  'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS',
] as const;
export const POTENTIAL_STAGES = ['PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING'];

type Change = { action: string; createdAt: Date; meta: unknown };
const metaOf = (m: unknown) => (m && typeof m === 'object' && !Array.isArray(m) ? m as Record<string, unknown> : {});

/**
 * Was this lead an active, not-yet-booked lead at moment `at`? Worked back from
 * today's status and stage through the first status/stage change after `at`.
 */
export function wasActiveAt(lead: { createdAt: Date; status: string; stage: string; changes: Change[] }, at: Date): boolean {
  if (lead.createdAt > at) return false;
  const after = lead.changes.filter((c) => c.createdAt > at).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const firstStatus = after.find((c) => c.action === 'STATUS_CHANGED' && typeof metaOf(c.meta).from === 'string');
  const firstStage = after.find((c) => c.action === 'STAGE_CHANGED' && typeof metaOf(c.meta).from === 'string');
  const status = firstStatus ? String(metaOf(firstStatus.meta).from) : lead.status;
  const stage = firstStage ? String(metaOf(firstStage.meta).from) : lead.stage;
  return status === 'ACTIVE' && !DONE_STAGES.includes(stage);
}

/** Each stage's count, and the share of all these leads that are at that stage or further on. */
export function funnelRows(stageOf: string[]) {
  const total = stageOf.length;
  return FUNNEL_STAGES.map((stage, i) => {
    const here = stageOf.filter((s) => s === stage).length;
    const atOrBeyond = stageOf.filter((s) => FUNNEL_STAGES.indexOf(s as never) >= i).length;
    return { stage, count: here, pctAtOrBeyond: total ? Math.round((atOrBeyond / total) * 100) : 0 };
  });
}

export function intentTier(rating: number | null, tiers: { highFrom: number; mediumFrom: number }): 'high' | 'medium' | 'low' {
  if (rating != null && rating >= tiers.highFrom) return 'high';
  if (rating != null && rating >= tiers.mediumFrom) return 'medium';
  return 'low';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Calendar months (India time) ending with the month of `now`, oldest first. */
export function monthWindows(now: Date, count: number) {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const out: { label: string; from: Date; to: Date }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const y = ist.getUTCFullYear(); const m = ist.getUTCMonth() - i;
    const from = new Date(Date.UTC(y, m, 1) - 5.5 * 3600_000);
    const to = new Date(Date.UTC(y, m + 1, 1) - 5.5 * 3600_000 - 1);
    out.push({ label: MONTHS[new Date(Date.UTC(y, m, 1)).getUTCMonth()], from, to });
  }
  return out;
}

// ── The summary ────────────────────────────────────────────────────────────────
type LeadRef = { id: string; leadId: string; name: string };
const ref = (l: LeadRef): LeadRef => ({ id: l.id, leadId: l.leadId, name: l.name });
const LIST_CAP = 50;
const num = (v: unknown) => Number(v ?? 0);

export async function computeBlBoard(blId: string, range: { from: Date; to: Date }, rules: BlBoardRules, now = new Date()) {
  const designers = await prisma.user.findMany({
    where: { role: 'DESIGNER', blId, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' },
  });
  const designerIds = designers.map((d) => d.id);
  const scope = {
    isTestLead: false,
    OR: [...(designerIds.length ? [{ assignedDesignerId: { in: designerIds } }] : []), { assignedDesignerId: null, assignedBLId: blId }],
  };
  const today = istDayBounds(now);
  const monthAgo = new Date(now); monthAgo.setMonth(monthAgo.getMonth() - 1);

  const [leads, tiers] = await Promise.all([
    prisma.lead.findMany({
      where: scope,
      select: {
        id: true, leadId: true, name: true, stage: true, status: true, estimatedValue: true, intentRating: true,
        assignedDesignerId: true, assignedBLId: true, leadOriginDate: true, createdAt: true,
        dipChecklist: { select: { completedAt: true } },
        activityLogs: { where: { action: { in: ['STATUS_CHANGED', 'STAGE_CHANGED'] } }, select: { action: true, createdAt: true, meta: true } },
        followUpTasks: { where: { status: 'PENDING' }, select: { id: true }, take: 1 },
        meetings: { where: { status: 'SCHEDULED' }, select: { id: true, type: true, scheduledAt: true } },
        slaBreaches: { where: { resolvedAt: null }, select: { id: true }, take: 1 },
        attentionFlags: { where: { resolvedAt: null }, select: { id: true } },
      },
    }),
    getFormulas().then((f) => f.intentTiers),
  ]);
  const lastActivity = new Map((await prisma.activityLog.groupBy({
    by: ['leadId'], where: { leadId: { in: leads.map((l) => l.id) } }, _max: { createdAt: true },
  })).map((r) => [r.leadId, r._max.createdAt]));

  const active = leads.filter((l) => l.status === 'ACTIVE');
  const pipeline = active.filter((l) => !DONE_STAGES.includes(l.stage));
  const changesOf = (l: (typeof leads)[number]) => ({ createdAt: l.leadOriginDate, status: l.status, stage: l.stage, changes: l.activityLogs });
  const activeMonthAgo = leads.filter((l) => wasActiveAt(changesOf(l), monthAgo)).length;

  // Bookings: the same rule as credits (entered DIP, OBM→DIP checklist done), dated by the move to DIP.
  const bookings = leads
    .filter((l) => l.dipChecklist?.completedAt)
    .map((l) => ({ lead: l, ...bookingDates(l.activityLogs, l.status, l.stage) }))
    .filter((b) => b.bookedAt && b.bookedAt >= range.from && b.bookedAt <= range.to);
  const designerName = new Map(designers.map((d) => [d.id, d.name]));

  // PP presented in the range, per designer (completed PP meetings, each lead once).
  const pitchSets = await Promise.all(designers.map(async (d) =>
    [d.id, (await loadCompletedPitches({ assignedDesignerId: d.id, isTestLead: false })).inPeriod(range).pitches.length] as const));
  const pitchesBy = new Map(pitchSets);

  const team = designers.map((d) => {
    const mine = pipeline.filter((l) => l.assignedDesignerId === d.id);
    const booked = bookings.filter((b) => b.lead.assignedDesignerId === d.id && !b.cancelledAt);
    return {
      designer: d,
      bookingsDone: booked.length,
      bookedValue: booked.reduce((a, b) => a + num(b.lead.estimatedValue), 0),
      ppPresented: pitchesBy.get(d.id) ?? 0,
      activeLeads: mine.length,
      pipelineValue: mine.reduce((a, l) => a + num(l.estimatedValue), 0),
    };
  });

  // NPS from onboarding (OBM) clients, by month.
  const months = monthWindows(now, rules.npsTrendMonths);
  const npsRows = await prisma.nPSResponse.findMany({
    where: { lead: scope, stage: 'ONBOARDING', score: { not: null }, respondedAt: { gte: months[0].from, lte: months[months.length - 1].to } },
    select: { score: true, respondedAt: true },
  });
  const npsTrend = months.map((m) => {
    const s = npsRows.filter((r) => r.respondedAt! >= m.from && r.respondedAt! <= m.to).map((r) => r.score!);
    return { month: m.label, score: s.length ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10 : null, responses: s.length };
  });

  // Allocation: leads received in the range, by where they are now; pushbacks the BL made in the range.
  const received = leads.filter((l) => l.leadOriginDate >= range.from && l.leadOriginDate <= range.to);
  const pushbacks = await prisma.activityLog.count({ where: { action: 'MQL_PUSHED_BACK', userId: blId, createdAt: { gte: range.from, lte: range.to } } });

  // Needs attention.
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const quietSince = (l: (typeof leads)[number], d: number) => (lastActivity.get(l.id) ?? l.createdAt) < daysAgo(d);
  const nothingPlanned = (l: (typeof leads)[number]) => l.followUpTasks.length === 0 && l.meetings.length === 0;
  const attentionLists: Record<AttentionKey, LeadRef[]> = {
    slaBreaches: active.filter((l) => l.slaBreaches.length > 0),
    inactiveDqls: active.filter((l) => l.stage === 'DQL' && quietSince(l, rules.inactiveDqlDays)),
    proposalsPending: active.filter((l) => ['PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION'].includes(l.stage) && nothingPlanned(l) && quietSince(l, rules.proposalFollowUpDays)),
    noNextAction: pipeline.filter(nothingPlanned),
    highValueUnassigned: active.filter((l) => !l.assignedDesignerId && num(l.estimatedValue) >= rules.highValueFrom),
  };

  // Today's focus.
  const isToday = (d: Date) => d >= today.start && d < today.end;
  const meetingToday = (types: string[]) => active.filter((l) => l.meetings.some((m) => types.includes(m.type) && isToday(m.scheduledAt)));
  const leadIds = leads.map((l) => l.id);
  const [discounts, teamRequests, projectFlags] = await Promise.all([
    prisma.discountRequest.findMany({
      where: { leadId: { in: leadIds }, status: 'PENDING', forwardedToRole: null },
      select: { lead: { select: { id: true, leadId: true, name: true } } },
    }),
    prisma.projectTeamMember.findMany({
      where: { status: 'PENDING', project: { leadId: { in: leadIds } } },
      select: { project: { select: { lead: { select: { id: true, leadId: true, name: true } } } } },
    }),
    prisma.projectAttentionFlag.findMany({
      where: { resolvedAt: null, project: { leadId: { in: leadIds } } },
      select: { project: { select: { lead: { select: { id: true, leadId: true, name: true, assignedDesignerId: true } } } } },
    }),
  ]);
  const focusLists: Record<FocusKey, LeadRef[]> = {
    ppToday: meetingToday(['PP']),
    onboardingsToday: meetingToday(['ONBOARDING', 'OBM']),
    newBatches: active.filter((l) => l.assignedBLId === blId && !l.assignedDesignerId),
    discountsPending: discounts.map((d) => d.lead),
    teamRequestsPending: teamRequests.map((r) => r.project.lead),
  };

  // Flags on leads and on projects, by designer.
  const flagged = new Map<string, { designer: string; items: LeadRef[] }>();
  const addFlag = (designerId: string | null, l: LeadRef) => {
    const name = designerId ? designerName.get(designerId) ?? 'Other' : 'No designer';
    if (!flagged.has(name)) flagged.set(name, { designer: name, items: [] });
    const row = flagged.get(name)!;
    if (!row.items.some((x) => x.id === l.id)) row.items.push(ref(l));
  };
  for (const l of leads) if (l.attentionFlags.length) addFlag(l.assignedDesignerId, l);
  for (const f of projectFlags) addFlag(f.project.lead.assignedDesignerId, f.project.lead);

  const potential = { high: { count: 0, value: 0 }, medium: { count: 0, value: 0 }, low: { count: 0, value: 0 } };
  for (const l of active.filter((x) => POTENTIAL_STAGES.includes(x.stage))) {
    const t = potential[intentTier(l.intentRating, tiers)];
    t.count += 1; t.value += num(l.estimatedValue);
  }

  const pick = <K extends string>(items: readonly { key: K; label: string }[], on: Record<K, boolean>, lists: Record<K, LeadRef[]>) =>
    items.filter((i) => on[i.key]).map((i) => ({ key: i.key, label: i.label, count: lists[i.key].length, leads: lists[i.key].slice(0, LIST_CAP).map(ref) }));

  return {
    range,
    designers,
    activeLeads: {
      count: pipeline.length,
      value: pipeline.reduce((a, l) => a + num(l.estimatedValue), 0),
      monthAgo: activeMonthAgo,
      changePct: activeMonthAgo ? Math.round(((pipeline.length - activeMonthAgo) / activeMonthAgo) * 100) : null,
    },
    nps: { thisMonth: npsTrend[npsTrend.length - 1]?.score ?? null, lastMonth: npsTrend[npsTrend.length - 2]?.score ?? null, trend: npsTrend },
    funnel: { total: active.filter((l) => (FUNNEL_STAGES as readonly string[]).includes(l.stage)).length, stages: funnelRows(active.map((l) => l.stage)) },
    potential: { ...potential, tiers },
    team,
    bookings: bookings
      .sort((a, b) => b.bookedAt!.getTime() - a.bookedAt!.getTime())
      .map((b) => ({ ...ref(b.lead), value: num(b.lead.estimatedValue), bookedAt: b.bookedAt, cancelled: !!b.cancelledAt || b.undatedCancellation, designer: b.lead.assignedDesignerId ? designerName.get(b.lead.assignedDesignerId) ?? null : null })),
    allocation: {
      total: received.length,
      active: received.filter((l) => l.status === 'ACTIVE').length,
      inactiveOrOnHold: received.filter((l) => l.status === 'INACTIVE' || l.status === 'ON_HOLD').length,
      pushbacks,
    },
    attention: pick(ATTENTION_ITEMS, rules.attention, attentionLists),
    focus: pick(FOCUS_ITEMS, rules.focus, focusLists),
    flagged: [...flagged.values()].sort((a, b) => a.designer.localeCompare(b.designer)),
    rules,
  };
}
