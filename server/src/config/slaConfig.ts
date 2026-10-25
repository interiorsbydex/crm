/**
 * Task #56 — SLA breach indicators (sales funnel) + Design Pipeline 8-stage
 * timeline. Single source of truth for both, exposed to the client via
 * `GET /api/config/sla` so thresholds are never duplicated client-side.
 */

// ── Sales funnel stage-transition SLAs ─────────────────────────────────────
// Keyed by the CURRENT stage a lead sits in — the threshold governs how long
// it may remain there before the next transition is expected. Stages not
// listed here have no defined SLA (always 'ok').
export interface StageSlaThreshold {
  /** Days in stage after which the indicator turns orange ("approaching"). */
  warningDays: number;
  /** Days in stage after which the indicator turns red ("breached"). */
  breachDays: number;
  /** Human-readable description of the transition this SLA governs. */
  label: string;
}

// Founder-specified windows (task #14): MQL→DQL 7-15d, DQL→Proposal Ready 2d,
// Proposal Ready→Proposal Presented (or DQL→PP direct) 2d, Proposal
// Discussion→Onboarding 7-15d, OB→OBM 3d. Flat (single-number) windows use
// the same value for warning and breach so they turn red immediately rather
// than passing through a yellow phase that was never specified.
export const SALES_STAGE_SLA: Record<string, StageSlaThreshold> = {
  MQL: { warningDays: 7, breachDays: 15, label: 'MQL → DQL' },
  DQL: { warningDays: 2, breachDays: 2, label: 'DQL → Proposal Ready/Presented' },
  PROPOSAL_READY: { warningDays: 2, breachDays: 2, label: 'Proposal Ready → Proposal Presented' },
  PROPOSAL_DISCUSSION: { warningDays: 7, breachDays: 15, label: 'PD (Pitch Discussion) → Onboarding' },
  ONBOARDING: { warningDays: 3, breachDays: 3, label: 'Onboarding → Onboarding Meeting' },
};

/** Every stage this SLA system governs, for admin UI listing purposes. */
export const SLA_GOVERNED_STAGES = Object.keys(SALES_STAGE_SLA);

export type SlaStatus = 'ok' | 'warning' | 'breach';

/**
 * Compute the sales-funnel SLA status for a lead's current stage. Accepts an
 * optional thresholds map (the admin-configured effective thresholds from
 * `getEffectiveStageSla()`) so callers aren't stuck with the hardcoded
 * defaults; falls back to the defaults when omitted.
 */
export function computeStageSlaStatus(
  stage: string,
  daysInStage: number,
  thresholds: Record<string, StageSlaThreshold> = SALES_STAGE_SLA,
): SlaStatus {
  const threshold = thresholds[stage];
  if (!threshold) return 'ok';
  if (daysInStage >= threshold.breachDays) return 'breach';
  if (daysInStage >= threshold.warningDays) return 'warning';
  return 'ok';
}

// ── Design Pipeline — 8 confirmed interior design phases ──────────────────
// Order matches the client spec. The first 7 map to the manual timeline
// dates captured on the OB→OBM checklist; EIP has no checklist date field —
// it begins once Sign Off is recorded and runs until project handover.
export interface DesignPhaseDef {
  key: string;
  label: string;
  /** Field on OBOBMChecklist holding this phase's start date, or null for EIP. */
  dateField:
    | 'siteDocumentationAt'
    | 'initialSiteDiscussionAt'
    | 'layoutFinalisationAt'
    | 'designDiscussionAt'
    | 'preSignOffAt'
    | 'maskingAt'
    | 'signOffAt'
    | null;
}

export const DESIGN_PHASES: DesignPhaseDef[] = [
  { key: 'SITE_DOCUMENTATION', label: 'Site Documentation', dateField: 'siteDocumentationAt' },
  { key: 'SITE_DISCUSSION', label: 'Site Discussion', dateField: 'initialSiteDiscussionAt' },
  { key: 'LAYOUT_FINALISATION', label: 'Layout Finalisation', dateField: 'layoutFinalisationAt' },
  { key: 'DESIGN_DISCUSSION', label: 'Design Discussion', dateField: 'designDiscussionAt' },
  { key: 'PRE_SIGN_OFF', label: 'Pre Sign-Off', dateField: 'preSignOffAt' },
  { key: 'MASKING', label: 'Masking', dateField: 'maskingAt' },
  { key: 'SIGN_OFF', label: 'Sign Off', dateField: 'signOffAt' },
  { key: 'EIP', label: 'EIP (Execution in Progress)', dateField: null },
];

/** Overall design pipeline SLA — 45 days from kickoff (first phase started). */
export const DESIGN_OVERALL_SLA_DAYS = 45;

/**
 * Default per-phase day budgets, used as the SLA for a phase only when the
 * *next* phase's actual start date hasn't been recorded yet (so there's no
 * real timeline range to measure against). Sums to the 45-day overall SLA.
 */
export const DESIGN_PHASE_DEFAULT_DAYS: Record<string, number> = {
  SITE_DOCUMENTATION: 3,
  SITE_DISCUSSION: 4,
  LAYOUT_FINALISATION: 10,
  DESIGN_DISCUSSION: 7,
  PRE_SIGN_OFF: 7,
  MASKING: 7,
  SIGN_OFF: 4,
  EIP: 3,
};

export const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}

export interface DesignPhaseTimeline {
  key: string;
  label: string;
  /** ISO date this phase started, or null if not yet reached. */
  startDate: string | null;
  status: 'upcoming' | 'in_progress' | 'done';
  elapsedDays: number | null;
  allocatedDays: number | null;
  slaStatus: SlaStatus;
}

export interface DesignPipelineTimeline {
  kickoffDate: string | null;
  overallElapsedDays: number | null;
  overallRemainingDays: number | null;
  overallSlaDays: number;
  overallStatus: SlaStatus;
  phases: DesignPhaseTimeline[];
}

/**
 * Build the 8-phase Design Pipeline timeline for a lead from its
 * OB→OBM checklist dates plus a fallback kickoff (project/lead createdAt)
 * for when no checklist dates have been recorded yet.
 */
export function computeDesignPipelineTimeline(
  obm: Partial<Record<NonNullable<DesignPhaseDef['dateField']>, Date | null>> | null | undefined,
  fallbackKickoff: Date,
  now: Date = new Date(),
  /** Admin → CRM Settings design days; defaults to the constants above. */
  budget: { phaseDays: Record<string, number>; overallDays: number } = { phaseDays: DESIGN_PHASE_DEFAULT_DAYS, overallDays: DESIGN_OVERALL_SLA_DAYS },
): DesignPipelineTimeline {
  const dates = DESIGN_PHASES.map((phase) =>
    phase.dateField ? obm?.[phase.dateField] ?? null : null,
  );

  const kickoffDate = dates.find((d): d is Date => !!d) ?? null;
  const effectiveKickoff = kickoffDate ?? null;

  const phases: DesignPhaseTimeline[] = DESIGN_PHASES.map((phase, idx) => {
    // EIP has no checklist date field of its own (dateField is null, so
    // dates[idx] is always null) — it actually begins the moment Sign Off
    // (the previous phase) is recorded, per the doc comment above. Without
    // this, EIP would incorrectly sit at "upcoming" forever.
    const startDate = phase.key === 'EIP' ? dates[idx - 1] ?? null : dates[idx];
    if (!startDate) {
      return {
        key: phase.key,
        label: phase.label,
        startDate: null,
        status: 'upcoming',
        elapsedDays: null,
        allocatedDays: null,
        slaStatus: 'ok',
      };
    }

    // Next recorded date (if any) marks this phase's actual end / handoff.
    // EIP has no follow-on checklist date, so it's always "in progress" once started.
    const nextDate = phase.key === 'EIP' ? null : dates[idx + 1] ?? null;
    const endpoint = nextDate ?? now;
    const elapsedDays = daysBetween(startDate, endpoint);
    const allocatedDays = nextDate
      ? daysBetween(startDate, nextDate)
      : budget.phaseDays[phase.key];

    let slaStatus: SlaStatus = 'ok';
    if (elapsedDays > allocatedDays) slaStatus = 'breach';
    else if (elapsedDays >= Math.ceil(allocatedDays * 0.7)) slaStatus = 'warning';

    return {
      key: phase.key,
      label: phase.label,
      startDate: startDate.toISOString(),
      status: nextDate ? 'done' : 'in_progress',
      elapsedDays,
      allocatedDays,
      slaStatus,
    };
  });

  const kickoff = effectiveKickoff ?? fallbackKickoff;
  const hasStarted = !!effectiveKickoff;
  const overallElapsedDays = hasStarted ? daysBetween(kickoff, now) : null;
  const overallRemainingDays = overallElapsedDays != null ? budget.overallDays - overallElapsedDays : null;
  let overallStatus: SlaStatus = 'ok';
  if (overallElapsedDays != null) {
    if (overallElapsedDays >= budget.overallDays) overallStatus = 'breach';
    else if (overallElapsedDays >= Math.ceil(budget.overallDays * 0.7)) overallStatus = 'warning';
  }

  return {
    kickoffDate: effectiveKickoff ? effectiveKickoff.toISOString() : null,
    overallElapsedDays,
    overallRemainingDays,
    overallSlaDays: budget.overallDays,
    overallStatus,
    phases,
  };
}
