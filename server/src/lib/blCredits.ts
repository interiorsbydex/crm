// Business Lead credit calculator (Annie's answers, "Queries (Non launch
// blockers)", items 1, 2, 3, 4, 6 and 7). Credit tracking only: no ₹ payout.
// Every number lives in the admin-editable IncentiveConfig row 'bl'; the
// defaults below are Annie's answers.
import { prisma } from './prisma.js';
import type { TargetCycle } from './targetCycle.js';
import { getCycleForDate } from './targetCycle.js';
import { loadFirstStageEntries, mqlReceived } from '../routes/designerReports.js';
import { loadCompletedPitches } from './completedPitches.js';
import { blAt, loadTeamChanges, membershipShare, teamIntervals } from './blTeamHistory.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const LAKH = 100_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

export type PitchSlab = { abovePerDesigner: number; credits: number };

export interface BlCreditConfigValues {
  /** keep_growing: achieved ÷ target × 100 with no cap. stop_at_100: standard credits stop at 100 once the target is met. */
  standardAboveTarget: 'keep_growing' | 'stop_at_100';
  /** Extra core credits per ₹1 lakh above the BL's booking target, proportional (no rounding). */
  overachievementCreditsPerLakh: number;
  /** Team pitches must be ABOVE abovePerDesigner × team size; highest matching slab wins. */
  pitchSlabs: PitchSlab[];
  /** Per qualifying lead, once per lead. */
  sameDayPitchCredits: number;
  sameDayBookingCredits: number;
}

export const DEFAULT_BL_CREDIT_CONFIG: BlCreditConfigValues = {
  standardAboveTarget: 'keep_growing',
  overachievementCreditsPerLakh: 2,
  // Annie: up to 20 per designer = 0, above 20–25 = +3, above 25–30 = +5, above 30–35 = +8.
  // Her table stops at 35; above 35 keeps +8 (highest slab).
  pitchSlabs: [
    { abovePerDesigner: 20, credits: 3 },
    { abovePerDesigner: 25, credits: 5 },
    { abovePerDesigner: 30, credits: 8 },
  ],
  sameDayPitchCredits: 1,
  sameDayBookingCredits: 2,
};

const num = (v: unknown, fallback: number, label: string): number => {
  if (v === undefined) return fallback;
  if (v === null || v === '') throw new Error(`${label} cannot be empty`);
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a number, 0 or more`);
  return n;
};

export function parseBlCreditConfig(raw: unknown): BlCreditConfigValues {
  const d = DEFAULT_BL_CREDIT_CONFIG;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const slabs = Array.isArray(r.pitchSlabs) ? r.pitchSlabs : d.pitchSlabs;
  return {
    standardAboveTarget: r.standardAboveTarget === 'stop_at_100' ? 'stop_at_100'
      : r.standardAboveTarget === 'keep_growing' ? 'keep_growing' : d.standardAboveTarget,
    overachievementCreditsPerLakh: num(r.overachievementCreditsPerLakh, d.overachievementCreditsPerLakh, 'Overachievement credits per lakh'),
    pitchSlabs: slabs.map((s: any, i: number) => ({
      abovePerDesigner: num(s?.abovePerDesigner ?? null, 0, `Pitch slab ${i + 1} pitches per designer`),
      credits: num(s?.credits ?? null, 0, `Pitch slab ${i + 1} credits`),
    })).sort((a: PitchSlab, b: PitchSlab) => a.abovePerDesigner - b.abovePerDesigner),
    sameDayPitchCredits: num(r.sameDayPitchCredits, d.sameDayPitchCredits, 'Same-day pitch credits'),
    sameDayBookingCredits: num(r.sameDayBookingCredits, d.sameDayBookingCredits, 'Same-day booking credits'),
  };
}

export const BL_CONFIG_ID = 'bl';
const targetId = (blId: string, cycleStart: Date) => `bl-target:${blId}:${cycleStart.toISOString()}`;
const approvalId = (blId: string, cycleStart: Date) => `bl-pitch-approval:${blId}:${cycleStart.toISOString()}`;

export async function loadBlCreditConfig() {
  const row = await prisma.incentiveConfig.findUnique({ where: { id: BL_CONFIG_ID } });
  if (!row) return { config: DEFAULT_BL_CREDIT_CONFIG, isDefault: true, updatedAt: null as Date | null };
  return { config: parseBlCreditConfig(row.config), isDefault: false, updatedAt: row.updatedAt as Date | null };
}

// BL booking targets and pitch-booster approvals are small JSON rows in the
// same incentive_config table (no database change needed).
export async function loadBlTargets(cycleStart: Date): Promise<Map<string, { value: number; updatedAt: Date }>> {
  const rows = await prisma.incentiveConfig.findMany({ where: { id: { startsWith: 'bl-target:', endsWith: `:${cycleStart.toISOString()}` } } });
  const out = new Map<string, { value: number; updatedAt: Date }>();
  for (const row of rows) {
    const blId = row.id.split(':')[1];
    const value = Number((row.config as { bookingTargetValue?: unknown })?.bookingTargetValue);
    if (blId && Number.isFinite(value)) out.set(blId, { value, updatedAt: row.updatedAt });
  }
  return out;
}

export async function saveBlTarget(blId: string, cycle: TargetCycle, bookingTargetValue: number, userId: string) {
  const id = targetId(blId, cycle.cycleStart);
  const config = { blId, cycleStart: cycle.cycleStart.toISOString(), bookingTargetValue };
  const existing = await prisma.incentiveConfig.findUnique({ where: { id } });
  await prisma.incentiveConfig.upsert({
    where: { id }, create: { id, config, updatedById: userId }, update: { config, updatedById: userId },
  });
  return { updated: !!existing };
}

export type PitchApproval = { approved: boolean; byId: string; at: string };
export async function loadPitchApproval(blId: string, cycle: TargetCycle): Promise<PitchApproval | null> {
  const row = await prisma.incentiveConfig.findUnique({ where: { id: approvalId(blId, cycle.cycleStart) } });
  return row ? row.config as PitchApproval : null;
}
export async function savePitchApproval(blId: string, cycle: TargetCycle, approved: boolean, userId: string) {
  const id = approvalId(blId, cycle.cycleStart);
  const config: PitchApproval = { approved, byId: userId, at: new Date().toISOString() };
  await prisma.incentiveConfig.upsert({
    where: { id }, create: { id, config, updatedById: userId }, update: { config, updatedById: userId },
  });
  return config;
}

// ── Pure calculations (unit-checkable) ────────────────────────────────────────

export function calcBlCore(eligibleValue: number, targetValue: number | null, cfg: BlCreditConfigValues) {
  if (targetValue == null || targetValue <= 0) {
    return { achievementPct: null as number | null, standard: 0, overachievement: 0, total: 0, targetMissing: true };
  }
  const pct = (eligibleValue / targetValue) * 100;
  const standard = cfg.standardAboveTarget === 'stop_at_100' ? Math.min(pct, 100) : pct;
  const overachievement = eligibleValue > targetValue
    ? ((eligibleValue - targetValue) / LAKH) * cfg.overachievementCreditsPerLakh : 0;
  return {
    achievementPct: r2(pct), standard: r2(standard), overachievement: r2(overachievement),
    total: r2(standard + overachievement), targetMissing: false,
  };
}

/** Team pitches vs (pitches per designer × team size). Team size can be fractional when someone joined or left mid-cycle. */
export function calcBlPitchBooster(teamPitches: number, teamSize: number, cfg: BlCreditConfigValues) {
  const slabs = cfg.pitchSlabs.map((s) => ({ ...s, abovePitches: r2(s.abovePerDesigner * teamSize) }));
  let credits = 0;
  let reached: (typeof slabs)[number] | null = null;
  if (teamSize > 0) {
    for (const s of slabs) if (teamPitches > s.abovePitches) { credits = s.credits; reached = s; }
  }
  const next = teamSize > 0 ? slabs.find((s) => teamPitches <= s.abovePitches) ?? null : null;
  return { credits, slabs, reached, next };
}

export type BlBooking = {
  id: string; leadId: string; name: string; value: number;
  bookedAt: Date; mqlAt: Date;
  /** First recorded cancellation after the booking. */
  cancelledAt: Date | null;
  /** Inactive now, but with no dated cancellation in the history. */
  undatedCancellation: boolean;
  designerId: string | null; designerName: string | null;
};
export type BlPitch = { id: string; leadId: string; name: string; completedAt: Date; mqlAt: Date; designerId: string | null };
export type BlTeamMember = { id: string; name: string; share: number; pitches: number };

/** All bookings and pitches given here are already attributed to this BL (team at the time, or BL-held). */
export function calcBlCredits(input: {
  bookings: BlBooking[]; pitches: BlPitch[]; team: BlTeamMember[];
  targetValue: number | null; cycle: { cycleStart: Date; cycleEnd: Date };
  pitchApproval: PitchApproval | null; now?: Date;
}, cfg: BlCreditConfigValues) {
  const { cycle } = input;
  const cutoff = new Date(Math.min(cycle.cycleEnd.getTime(), (input.now ?? new Date()).getTime()));
  const inCycle = (d: Date | null) => !!d && d >= cycle.cycleStart && d <= cutoff;
  const isCurrent = cutoff < cycle.cycleEnd;
  const sameDay = (a: Date, b: Date) => istDay(a) === istDay(b);

  const counted: (BlBooking & { sameDay: boolean })[] = [];
  const cancelledInCycle: BlBooking[] = [];
  const reversals: (BlBooking & { sameDay: boolean })[] = [];
  const undated: BlBooking[] = [];
  for (const b of input.bookings) {
    const isSameDay = sameDay(b.mqlAt, b.bookedAt);
    if (inCycle(b.bookedAt)) {
      if (b.cancelledAt && inCycle(b.cancelledAt)) { cancelledInCycle.push(b); continue; }
      if (b.undatedCancellation) {
        // Cancelled, date unknown. In the running cycle it simply earns nothing;
        // in a closed cycle the original award stands and is flagged, never guessed.
        undated.push(b);
        if (isCurrent) continue;
      }
      counted.push({ ...b, sameDay: isSameDay });
    } else if (b.bookedAt < cycle.cycleStart && inCycle(b.cancelledAt)) {
      // Annie item 6: an earlier cycle's booking cancelled now is reversed in this cycle, once.
      reversals.push({ ...b, sameDay: isSameDay });
    }
  }

  const bookingValue = counted.reduce((a, b) => a + b.value, 0);
  const reversedValue = reversals.reduce((a, b) => a + b.value, 0);
  const eligibleValue = bookingValue - reversedValue;
  const core = calcBlCore(eligibleValue, input.targetValue, cfg);

  const cyclePitches = input.pitches.filter((p) => inCycle(p.completedAt));
  const teamPitches = cyclePitches.filter((p) => p.designerId).length;
  const teamSize = r2(input.team.reduce((a, m) => a + m.share, 0));
  const booster = calcBlPitchBooster(teamPitches, teamSize, cfg);
  const approved = input.pitchApproval?.approved === true;
  const pitchCounted = approved ? booster.credits : 0;

  const seen = new Set<string>();
  const sameDayPitchLeads = cyclePitches.filter((p) => {
    if (seen.has(p.id) || !sameDay(p.mqlAt, p.completedAt)) return false;
    seen.add(p.id); return true;
  });
  const sameDayBookingLeads = counted.filter((b) => b.sameDay);
  const reversedSameDay = reversals.filter((b) => b.sameDay);
  const sameDayPitchCredits = sameDayPitchLeads.length * cfg.sameDayPitchCredits;
  const sameDayBookingCredits = (sameDayBookingLeads.length - reversedSameDay.length) * cfg.sameDayBookingCredits;
  const boosterTotal = pitchCounted + sameDayPitchCredits + sameDayBookingCredits;

  const row = (b: BlBooking) => ({
    id: b.id, leadId: b.leadId, name: b.name, value: b.value, bookedAt: b.bookedAt,
    cancelledAt: b.cancelledAt, heldBy: b.designerName ?? 'BL-held (no designer)',
  });
  return {
    core: {
      ...core, bookingValue, reversedValue, eligibleValue, targetValue: input.targetValue,
      bookings: counted.map(row),
      cancelledInCycle: cancelledInCycle.map(row),
      reversals: reversals.map(row),
      undatedCancellations: undated.map(row),
    },
    booster: {
      pitch: {
        teamPitches, teamSize, team: input.team,
        slabs: booster.slabs, reached: booster.reached, next: booster.next,
        calculatedCredits: booster.credits,
        approval: input.pitchApproval
          ? { status: approved ? 'APPROVED' as const : 'NOT_APPROVED' as const, byId: input.pitchApproval.byId, at: input.pitchApproval.at }
          : { status: 'AWAITING' as const, byId: null, at: null },
        credits: pitchCounted,
      },
      sameDayPitch: { leads: sameDayPitchLeads.map((p) => ({ id: p.id, leadId: p.leadId, name: p.name, at: p.completedAt })), credits: sameDayPitchCredits },
      sameDayBooking: {
        leads: sameDayBookingLeads.map(row), reversed: reversedSameDay.map(row), credits: sameDayBookingCredits,
      },
      total: r2(boosterTotal),
    },
    totalCredits: r2(core.total + boosterTotal),
  };
}

// ── Loading from CRM data ─────────────────────────────────────────────────────
type Event = { action: string; createdAt: Date; meta: unknown };
const meta = (e: Event) => (e.meta && typeof e.meta === 'object' && !Array.isArray(e.meta) ? e.meta as Record<string, unknown> : {});

export function bookingDates(events: Event[], status: string, stage: string) {
  const sorted = [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const bookedAt = sorted.find((e) => e.action === 'STAGE_CHANGED' && meta(e).to === 'DESIGN_IN_PROGRESS' && meta(e).isBackward !== true)?.createdAt ?? null;
  const cancelledAt = bookedAt ? sorted.find((e) => e.createdAt >= bookedAt
    && ['STATUS_CHANGED', 'STAGE_CHANGED'].includes(e.action) && meta(e).to === 'INACTIVE')?.createdAt ?? null : null;
  const undatedCancellation = !cancelledAt && (status === 'INACTIVE' || stage === 'INACTIVE');
  return { bookedAt, cancelledAt, undatedCancellation };
}

export async function calculateBlCredits(blId: string, cycle: TargetCycle, cfg: BlCreditConfigValues, now = new Date()) {
  const [bl, designers, changes, targets, pitchApproval] = await Promise.all([
    prisma.user.findUnique({ where: { id: blId }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { role: 'DESIGNER' }, select: { id: true, name: true, blId: true, isActive: true } }),
    loadTeamChanges(),
    loadBlTargets(cycle.cycleStart),
    loadPitchApproval(blId, cycle),
  ]);
  const intervals = new Map(designers.map((d) => [d.id, teamIntervals(d, changes)]));
  const everInTeam = designers.filter((d) => intervals.get(d.id)!.some((i) => i.blId === blId));
  const names = new Map(designers.map((d) => [d.id, d.name]));
  const belongs = (designerId: string | null, at: Date) =>
    designerId ? blAt(intervals.get(designerId) ?? [], at) === blId : true;

  const designerIds = everInTeam.map((d) => d.id);
  const scope = { isTestLead: false, OR: [
    ...(designerIds.length ? [{ assignedDesignerId: { in: designerIds } }] : []),
    { assignedDesignerId: null, assignedBLId: blId },
  ] };
  const leads = await prisma.lead.findMany({
    where: { ...scope, estimatedValue: { not: null }, dipChecklist: { completedAt: { not: null } } },
    select: {
      id: true, leadId: true, name: true, estimatedValue: true, leadOriginDate: true, status: true, stage: true,
      assignedDesignerId: true,
      activityLogs: {
        where: { action: { in: ['STAGE_CHANGED', 'STATUS_CHANGED'] } },
        select: { action: true, createdAt: true, meta: true },
      },
    },
  });

  // Pitches: per designer (as the designer calculator does), plus BL-held leads.
  const pitchSets = await Promise.all([
    ...designerIds.map(async (id) => ({ designerId: id as string | null, set: await loadCompletedPitches({ assignedDesignerId: id, isTestLead: false }) })),
    (async () => ({ designerId: null as string | null, set: await loadCompletedPitches({ assignedDesignerId: null, assignedBLId: blId, isTestLead: false }) }))(),
  ]);
  const rawPitches = pitchSets.flatMap(({ designerId, set }) =>
    set.inPeriod({ from: cycle.cycleStart, to: cycle.cycleEnd }).pitches
      .filter((p) => p.completedAt && belongs(designerId, p.completedAt))
      .map((p) => ({ ...p, completedAt: p.completedAt as Date, designerId })));
  const missingCompletionDates = pitchSets.reduce((a, { set }) => a + set.all.missingCompletionDates, 0);

  const entries = await loadFirstStageEntries([...new Set([...leads.map((l) => l.id), ...rawPitches.map((p) => p.id)])]);

  const bookings: BlBooking[] = [];
  for (const l of leads) {
    const d = bookingDates(l.activityLogs, l.status, l.stage);
    if (!d.bookedAt || !belongs(l.assignedDesignerId, d.bookedAt)) continue;
    bookings.push({
      id: l.id, leadId: l.leadId, name: l.name, value: Number(l.estimatedValue ?? 0),
      bookedAt: d.bookedAt, mqlAt: mqlReceived(entries, l).date,
      cancelledAt: d.cancelledAt, undatedCancellation: d.undatedCancellation,
      designerId: l.assignedDesignerId, designerName: l.assignedDesignerId ? names.get(l.assignedDesignerId) ?? null : null,
    });
  }
  const pitches: BlPitch[] = rawPitches.map((p) => ({
    id: p.id, leadId: p.leadId, name: p.name, completedAt: p.completedAt,
    mqlAt: mqlReceived(entries, p).date, designerId: p.designerId,
  }));
  const team: BlTeamMember[] = everInTeam
    .map((d) => ({
      id: d.id, name: d.name,
      share: membershipShare(d, intervals.get(d.id)!, blId, cycle),
      pitches: pitches.filter((p) => p.designerId === d.id).length,
    }))
    .filter((m) => m.share > 0 || m.pitches > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const target = targets.get(blId);
  const result = calcBlCredits({
    bookings, pitches, team, targetValue: target ? target.value : null, cycle, pitchApproval, now,
  }, cfg);
  return {
    bl: bl ?? { id: blId, name: '' },
    cycle: { label: cycle.label, cycleStart: cycle.cycleStart, cycleEnd: cycle.cycleEnd },
    ...result,
    missingCompletionDates,
  };
}

export { getCycleForDate };
