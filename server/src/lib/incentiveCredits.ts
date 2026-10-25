// Designer credit calculator (Annie's "Designer Incentive Calculator – Only credits").
// Credit tracking only: no ₹ payout and no PO-based credits in this phase.
// Rules live in the admin-editable IncentiveConfig row; defaults below apply
// until an admin saves changes.
import { prisma } from './prisma.js';
import { getCycleForDate, type TargetCycle } from './targetCycle.js';
import { loadFirstStageEntries, mqlReceived } from '../routes/designerReports.js';
import { loadCompletedPitches } from './completedPitches.js';
import { CancellationReviewRequired, loadBookingCancellations } from './bookingCancellations.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export type PitchBracket = { minPitches: number; credits: number };
export type NpsRelease = { minRating: number; releasePct: number };

export interface IncentiveConfigValues {
  /** Standard credits per ₹1 lakh booked (counted only up to the booking target). */
  bookingCreditRatePerLakh: number;
  /** Extra core credits per ₹1 lakh above target. */
  overachievementCreditsPerLakh: number;
  /** Core credits needed for booster credits to be financially applicable. */
  boosterEligibleCore: number;
  /** Core credits needed to proceed to Core Incentive + NPS validation. */
  coreIncentiveEligibleCore: number;
  /** Highest matching minPitches wins; below the lowest bracket = 0 credits. */
  pitchBrackets: PitchBracket[];
  sameDayPitchCredits: number;
  sameDayBookingCredits: number;
  /** once_per_cycle: credit awarded once if at least one lead qualifies. per_lead: credit for every qualifying lead. */
  speedCreditMode: 'once_per_cycle' | 'per_lead';
  attendanceCredits: number;
  zeroEscalationCredits: number;
  /** Highest matching minRating wins; below the lowest rating = 0%. */
  npsRelease: NpsRelease[];
}

export const DEFAULT_INCENTIVE_CONFIG: IncentiveConfigValues = {
  bookingCreditRatePerLakh: 1,
  overachievementCreditsPerLakh: 2,
  boosterEligibleCore: 65,
  coreIncentiveEligibleCore: 75,
  // Annie: <20 = 0, 21–30 = +5, 31–39 = +8, 40+ = +10. Exactly 20 is not covered by her table; treated as 0.
  pitchBrackets: [
    { minPitches: 21, credits: 5 },
    { minPitches: 31, credits: 8 },
    { minPitches: 40, credits: 10 },
  ],
  sameDayPitchCredits: 3,
  sameDayBookingCredits: 5,
  speedCreditMode: 'once_per_cycle',
  attendanceCredits: 3,
  zeroEscalationCredits: 5,
  npsRelease: [
    { minRating: 8, releasePct: 25 },
    { minRating: 9, releasePct: 50 },
    { minRating: 10, releasePct: 100 },
  ],
};

/** Missing key = default; a present but blank/invalid/negative value is rejected, never silently defaulted. */
const num = (v: unknown, fallback: number, label = 'Value'): number => {
  if (v === undefined) return fallback;
  if (v === null || v === '') throw new Error(`${label} cannot be empty`);
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a number, 0 or more`);
  return n;
};

/** Validates and normalises a config blob; throws a readable message on invalid input. */
export function parseIncentiveConfig(raw: unknown): IncentiveConfigValues {
  const d = DEFAULT_INCENTIVE_CONFIG;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const brackets = Array.isArray(r.pitchBrackets) ? r.pitchBrackets : d.pitchBrackets;
  const release = Array.isArray(r.npsRelease) ? r.npsRelease : d.npsRelease;
  const cleanBrackets = brackets.map((b: any, i: number) => ({
    minPitches: num(b?.minPitches ?? null, 0, `Pitch bracket ${i + 1} minimum pitches`),
    credits: num(b?.credits ?? null, 0, `Pitch bracket ${i + 1} credits`),
  }));
  const cleanRelease = release.map((b: any, i: number) => {
    const row = { minRating: num(b?.minRating ?? null, 0, `NPS row ${i + 1} minimum rating`), releasePct: num(b?.releasePct ?? null, 0, `NPS row ${i + 1} release %`) };
    if (row.minRating > 10) throw new Error(`NPS row ${i + 1} rating must be 0–10`);
    if (row.releasePct > 100) throw new Error(`NPS row ${i + 1} release % must be 0–100`);
    return row;
  });
  return {
    bookingCreditRatePerLakh: num(r.bookingCreditRatePerLakh, d.bookingCreditRatePerLakh, 'Booking credit per lakh'),
    overachievementCreditsPerLakh: num(r.overachievementCreditsPerLakh, d.overachievementCreditsPerLakh, 'Overachievement credits per lakh'),
    boosterEligibleCore: num(r.boosterEligibleCore, d.boosterEligibleCore, 'Booster threshold'),
    coreIncentiveEligibleCore: num(r.coreIncentiveEligibleCore, d.coreIncentiveEligibleCore, 'Core incentive threshold'),
    pitchBrackets: [...cleanBrackets].sort((a, b) => a.minPitches - b.minPitches),
    sameDayPitchCredits: num(r.sameDayPitchCredits, d.sameDayPitchCredits, 'Same-day pitch credits'),
    sameDayBookingCredits: num(r.sameDayBookingCredits, d.sameDayBookingCredits, 'Same-day booking credits'),
    speedCreditMode: r.speedCreditMode === 'per_lead' ? 'per_lead' : 'once_per_cycle',
    attendanceCredits: num(r.attendanceCredits, d.attendanceCredits, 'Attendance credits'),
    zeroEscalationCredits: num(r.zeroEscalationCredits, d.zeroEscalationCredits, 'Zero escalation credits'),
    npsRelease: [...cleanRelease].sort((a, b) => a.minRating - b.minRating),
  };
}

export async function loadIncentiveConfig(): Promise<{ config: IncentiveConfigValues; isDefault: boolean; updatedAt: Date | null }> {
  const row = await prisma.incentiveConfig.findUnique({ where: { id: 'default' } });
  if (!row) return { config: DEFAULT_INCENTIVE_CONFIG, isDefault: true, updatedAt: null };
  return { config: parseIncentiveConfig(row.config), isDefault: false, updatedAt: row.updatedAt };
}

// ── Pure calculations (unit-checkable) ────────────────────────────────────────
const LAKH = 100_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function calcCoreCredits(achievedValue: number, targetValue: number | null, cfg: IncentiveConfigValues) {
  const achievedLakh = achievedValue / LAKH;
  if (targetValue == null || targetValue <= 0) {
    return { achievedLakh, targetLakh: null as number | null, standard: 0, overachievement: 0, total: 0, targetMissing: true };
  }
  const targetLakh = targetValue / LAKH;
  const standard = Math.min(achievedLakh, targetLakh) * cfg.bookingCreditRatePerLakh;
  const overachievement = achievedLakh > targetLakh ? (achievedLakh - targetLakh) * cfg.overachievementCreditsPerLakh : 0;
  return {
    achievedLakh, targetLakh,
    standard: r2(standard), overachievement: r2(overachievement), total: r2(standard + overachievement),
    targetMissing: false,
  };
}

export function calcPitchCredits(pitches: number, cfg: IncentiveConfigValues): number {
  let credits = 0;
  for (const b of cfg.pitchBrackets) if (pitches >= b.minPitches) credits = b.credits;
  return credits;
}

export function npsReleasePct(rating: number | null, cfg: IncentiveConfigValues): number | null {
  if (rating == null) return null;
  let pct = 0;
  for (const b of cfg.npsRelease) if (rating >= b.minRating) pct = b.releasePct;
  return pct;
}

export function eligibility(core: number, cfg: IncentiveConfigValues) {
  if (core >= cfg.coreIncentiveEligibleCore) {
    return { band: 'CORE_ELIGIBLE' as const, boosterApplicable: true, coreIncentiveEligible: true,
      note: `${cfg.coreIncentiveEligibleCore}+ core credits: booster applies and the designer proceeds to NPS/CX validation.` };
  }
  if (core >= cfg.boosterEligibleCore) {
    return { band: 'BOOSTER_ONLY' as const, boosterApplicable: true, coreIncentiveEligible: false,
      note: `${cfg.boosterEligibleCore}–${cfg.coreIncentiveEligibleCore - 1} core credits: booster and milestones apply; not eligible for core incentive.` };
  }
  return { band: 'BELOW_THRESHOLD' as const, boosterApplicable: false, coreIncentiveEligible: false,
    note: `Below ${cfg.boosterEligibleCore} core credits: booster credits are tracked but not applicable.` };
}

const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

// ── Per-designer calculation from CRM data ────────────────────────────────────
export async function calculateDesignerCredits(designerId: string, cycle: TargetCycle, cfg: IncentiveConfigValues) {
  const base: any = { assignedDesignerId: designerId, isTestLead: false };
  const inCycle = (d?: Date | null) => !!d && d >= cycle.cycleStart && d <= cycle.cycleEnd;
  const cancellations = await loadBookingCancellations(base, cycle);
  if (cancellations.pendingReview.length) {
    throw new CancellationReviewRequired(cancellations.pendingReview, cycle);
  }

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

  const [bookingLeads, designerLeads, target, attendance, designer] = await Promise.all([
    prisma.lead.findMany({
      where: bookingWhere,
      select: { id: true, leadId: true, name: true, estimatedValue: true, leadOriginDate: true },
    }),
    prisma.lead.findMany({ where: base, select: { id: true, leadId: true, name: true, leadOriginDate: true } }),
    prisma.designerTarget.findFirst({ where: { designerId, cycleStart: cycle.cycleStart }, select: { bookingTargetValue: true } }),
    prisma.incentiveAttendance.findUnique({
      where: { designerId_cycleStart: { designerId, cycleStart: cycle.cycleStart } },
    }),
    prisma.user.findUnique({ where: { id: designerId }, select: { id: true, name: true } }),
  ]);

  const entries = await loadFirstStageEntries(designerLeads.map((l) => l.id));
  const bookingValue = bookingLeads.reduce((a, l) => a + Number(l.estimatedValue ?? 0), 0);
  const core = calcCoreCredits(bookingValue, target ? Number(target.bookingTargetValue) : null, cfg);

  // A stage change is not a completed pitch. Match performance reporting.
  const completedPp = await loadCompletedPitches(base);
  const pitchLeads = completedPp.inPeriod({ from: cycle.cycleStart, to: cycle.cycleEnd }).pitches;
  const pitchCredits = calcPitchCredits(pitchLeads.length, cfg);

  // Same-day speed: MQL received date vs first Proposal Presented / Design in Progress entry, same IST calendar day.
  const sameDay = (l: { id: string; leadOriginDate: Date }, stage: string) => {
    const t = entries.get(l.id)?.get(stage);
    if (!t || !inCycle(t)) return false;
    return istDay(mqlReceived(entries, l).date) === istDay(t);
  };
  const sameDayPitchLeads = pitchLeads.filter((l) =>
    l.completedAt && istDay(mqlReceived(entries, l).date) === istDay(l.completedAt));
  const sameDayBookingLeads = bookingLeads.filter((l) => sameDay(l, 'DESIGN_IN_PROGRESS'));
  const speedMult = (n: number) => (n === 0 ? 0 : cfg.speedCreditMode === 'per_lead' ? n : 1);
  const speedPitchCredits = speedMult(sameDayPitchLeads.length) * cfg.sameDayPitchCredits;
  const speedBookingCredits = speedMult(sameDayBookingLeads.length) * cfg.sameDayBookingCredits;

  // Annie: a flag raised in this cycle only disqualifies if still unresolved
  // at cycle end. Resolving it during the cycle restores eligibility; resolving
  // it later must not retroactively restore a closed cycle's credit.
  const disqualifyingFlag = {
    createdAt: { gte: cycle.cycleStart, lte: cycle.cycleEnd },
    OR: [{ resolvedAt: null }, { resolvedAt: { gt: cycle.cycleEnd } }],
  };
  const leadIds = designerLeads.map((l) => l.id);
  const [leadFlags, projectFlags] = leadIds.length
    ? await Promise.all([
      prisma.leadAttentionFlag.count({ where: { leadId: { in: leadIds }, ...disqualifyingFlag } }),
      prisma.projectAttentionFlag.count({
        where: { project: { leadId: { in: leadIds } }, ...disqualifyingFlag },
      }),
    ])
    : [0, 0];
  const escalations = leadFlags + projectFlags;
  const zeroEscalationCredits = escalations === 0 ? cfg.zeroEscalationCredits : 0;

  const attendanceCredits = attendance?.awarded ? cfg.attendanceCredits : 0;
  const booster = pitchCredits + speedPitchCredits + speedBookingCredits + zeroEscalationCredits + attendanceCredits;

  const elig = eligibility(core.total, cfg);

  // NPS / client validation (display only; never changes credits).
  const npsRows = bookingLeads.length
    ? await prisma.nPSResponse.findMany({
      where: { leadId: { in: bookingLeads.map((l) => l.id) }, stage: 'ONBOARDING' },
      select: { leadId: true, score: true },
    })
    : [];
  const npsByLead = new Map(npsRows.map((n) => [n.leadId, n.score]));
  const validation = bookingLeads.map((l) => {
    const rating = npsByLead.get(l.id) ?? null;
    return {
      leadId: l.leadId, name: l.name, bookingValue: Number(l.estimatedValue ?? 0), rating,
      status: rating == null ? 'PENDING_VALIDATION' : 'VERIFIED',
      releasePct: npsReleasePct(rating, cfg),
    };
  });
  const pending = validation.filter((v) => v.status === 'PENDING_VALIDATION').length;

  return {
    designer: designer ?? { id: designerId, name: '' },
    cycle: { label: cycle.label, cycleStart: cycle.cycleStart, cycleEnd: cycle.cycleEnd },
    core: {
      ...core,
      bookingValue,
      bookingCount: bookingLeads.length,
      note: core.targetMissing
        ? 'No booking target is set for this cycle (Admin → Sales Performance Targets), so core credits cannot be calculated.'
        : 'Standard credits count booked value up to the target; value above target earns overachievement credits.',
    },
    booster: {
      total: r2(booster),
      pitch: { pitches: pitchLeads.length, credits: pitchCredits, missingCompletionDates: completedPp.all.missingCompletionDates },
      speed: {
        mode: cfg.speedCreditMode,
        sameDayPitchLeads: sameDayPitchLeads.length, sameDayPitchCredits: speedPitchCredits,
        sameDayBookingLeads: sameDayBookingLeads.length, sameDayBookingCredits: speedBookingCredits,
      },
      zeroEscalation: { escalations, credits: zeroEscalationCredits },
      attendance: attendance
        ? { awarded: attendance.awarded, credits: attendanceCredits, enteredById: attendance.enteredById, enteredAt: attendance.enteredAt }
        : { awarded: false, credits: 0, enteredById: null, enteredAt: null, notEntered: true },
    },
    totalCredits: r2(core.total + booster),
    eligibility: elig,
    validation: {
      applicable: elig.coreIncentiveEligible,
      overall: !elig.coreIncentiveEligible ? 'NOT_APPLICABLE' : pending > 0 || validation.length === 0 ? 'PENDING_VALIDATION' : 'VERIFIED',
      rows: validation,
      note: 'Client feedback is collected automatically at onboarding. This view shows rating, status and release % only; it does not change credits.',
    },
  };
}

export { getCycleForDate };
