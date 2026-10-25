import { prisma } from '../../lib/prisma.js';

/**
 * Single source of truth for mandatory fields/actions required to move a lead
 * from one stage to another. Edit this object to adjust gating rules later.
 *
 * Rebuilt for Task #83 to match the founder's 8-gate spec:
 *   1. EL→MQL           — project details mandatory (enforced at lead
 *                          creation, Task #82; no runtime gate needed here).
 *   2. MQL→DQL          — floor plan + DQL meeting (completed) + lifestyle
 *                          capture sheet + tentative project value.
 *   3. DQL→PR           — pitch-ready file uploaded + project value.
 *   4. PR→PP            — PP meeting (completed) + PP presentation attached +
 *                          project value + Expected OB date.
 *   5. PP→PD            — meeting OR call (completed) + PD quotation.
 *   6. PD→OB            — generated OB quote + final pitch presentation/PD
 *                          file + payment value + project value (excl.
 *                          furniture) + furniture value (itemised via the
 *                          PD→OB checklist, whose completion performs the
 *                          transition — see routes/pdObChecklist.ts).
 *   7. OB→OBM           — completed OB→OBM checklist and welcome mail.
 *   8. OBM→DIP          — OBM meeting completed + OBM checklist completed.
 *
 * Key format: `${fromStage}->${toStage}` for adjacent funnel steps. Forward
 * jumps that skip stages are gated by accumulating the requirements of every
 * intermediate step (see FUNNEL_ORDER), so a lead can never bypass a gate by
 * leaping ahead — except when every skipped stage is in SKIPPABLE_STAGES
 * (DQL, Proposal Ready, PD (Pitch Discussion) per the agreed spec), which each
 * drop the specific items the founder marked optional when skipped over (see
 * isExcludedWhenSkipping). Backward moves and off-funnel stages are
 * unrestricted.
 */
export type StageRequirement =
  | {
      type: 'field';
      field:
        | 'intentRating'
        | 'estimatedValue'
        | 'floorPlanUrl'
        | 'nextMeetingDate'
        | 'projectType'
        | 'source'
        | 'location'
        | 'builder'
        | 'scope'
        | 'expectedMoveIn'
        | 'expectedObDate';
      label: string;
    }
  /** A meeting of the given type must exist. `status` defaults to 'scheduled'
   * (any active status — SCHEDULED/RESCHEDULED/COMPLETED all count); pass
   * 'completed' to require the meeting be specifically marked COMPLETED. */
  | { type: 'meeting'; meetingType: 'DQL' | 'PP' | 'ONBOARDING'; status?: 'scheduled' | 'completed'; label: string }
  /** Satisfied by EITHER a completed meeting of the given type, OR any logged
   * Call for the lead (calls have no separate "scheduled" state — they are
   * logged after the fact, so any Call row counts as "completed"). */
  | { type: 'meetingOrCall'; meetingType: 'DQL' | 'PP' | 'ONBOARDING'; label: string }
  /** Satisfied by a meeting matching ANY of the given meetingType values —
   * for gates where the same real-world meeting has been created under more
   * than one meetingType value over time (e.g. Onboarding Meeting rows use
   * 'OBM', but an earlier 'ONBOARDING' type also exists historically). */
  | { type: 'meetingAnyOf'; meetingTypes: string[]; status?: 'scheduled' | 'completed'; label: string }
  /**
   * A generated Quote (Quote Builder callback row) or an uploaded
   * QUOTATION/GENERATED_QUOTE file in one of the given stages. Accepting
   * either fixes the reported bug where uploading "the generated quotation"
   * as a file didn't satisfy a gate that only checked for a Quote db row.
   */
  | { type: 'quote'; stages: string[]; fileTypes?: string[]; label: string }
  | { type: 'dip'; label: string }
  | { type: 'pdObChecklist'; label: string }
  | { type: 'obObmChecklist'; label: string }
  /**
   * File gate: a LeadFile with the given fileType must exist in one of the
   * listed stages. For FLOOR_PLAN the legacy `floorPlanUrl` field on the lead
   * is also accepted as a fallback so existing leads are not broken.
   */
  | { type: 'file'; fileType: string; stages: string[]; label: string }
  /** Satisfied if a LeadFile with ANY of the given fileTypes exists in one of the listed stages. */
  | { type: 'fileAnyOf'; fileTypes: string[]; stages: string[]; label: string };

export const STAGE_REQUIREMENTS: Record<string, StageRequirement[]> = {
  /**
   * Task #83 spec item 2 — MQL → DQL: floor plan, a completed DQL meeting,
   * the lifestyle capture sheet (moved here from DQL→PR per spec — it's
   * meant to be captured before the DQL meeting, not after), and a tentative
   * project value. Data-quality fields (project type, source, location,
   * builder, scope, possession date) are no longer re-checked here: Task #82
   * made them mandatory at lead creation, so by the time a lead exists they
   * are already filled in.
   */
  'MQL->DQL': [
    {
      type: 'file', fileType: 'FLOOR_PLAN', stages: ['EFFECTIVE_LEAD', 'MQL'],
      label: 'Floor plan uploaded (Files tab)',
    },
    { type: 'meeting', meetingType: 'DQL', status: 'completed', label: 'DQL meeting completed' },
    { type: 'file', fileType: 'LIFESTYLE_CAPTURE', stages: ['MQL'], label: 'Lifestyle capture sheet (Files → MQL)' },
    { type: 'field', field: 'estimatedValue', label: 'Tentative project value' },
  ],
  /** DQL → Proposal Ready: pitch-ready file, PR quotation, and project value. */
  'DQL->PROPOSAL_READY': [
    { type: 'file', fileType: 'PITCH_PRESENTATION', stages: ['DQL'], label: 'Pitch-ready file uploaded (Files → DQL)' },
    {
      // The lead is still in DQL while this gate is evaluated, so both
      // documents required to enter Proposal Ready must be uploaded in the
      // DQL folder. Also keep PROPOSAL_READY for compatibility with older
      // records that may already have been tagged there.
      type: 'quote', stages: ['DQL', 'PROPOSAL_READY'], fileTypes: ['QUOTATION', 'GENERATED_QUOTE', 'PR_QUOTATION'],
      label: 'PR quotation file (generated quote or Files → DQL)',
    },
    { type: 'field', field: 'estimatedValue', label: 'Project value' },
  ],
  /**
   * Proposal Ready → Proposal Presented: a completed PP meeting, the PP
   * documents, project value, and the Expected OB date. When a lead skips
   * Proposal Ready from DQL, its PP documents are intentionally uploaded to
   * the Proposal Presented folder; requiring a duplicate PR upload would make
   * the allowed skip unusable.
   */
  'PROPOSAL_READY->PROPOSAL_PRESENTED': [
    { type: 'meeting', meetingType: 'PP', status: 'completed', label: 'PP meeting completed' },
    {
      type: 'file', fileType: 'PITCH_PRESENTATION', stages: ['PROPOSAL_READY', 'PROPOSAL_PRESENTED'],
      label: 'PP presentation attached (Files → PR, or PP when skipping PR)',
    },
    {
      type: 'quote', stages: ['PROPOSAL_READY', 'PROPOSAL_PRESENTED'], fileTypes: ['QUOTATION', 'GENERATED_QUOTE', 'PP_QUOTATION'],
      label: 'PP quotation file (generated quote or Files → PR, or PP when skipping PR)',
    },
    { type: 'field', field: 'estimatedValue', label: 'Project value' },
    { type: 'field', field: 'expectedObDate', label: 'Expected OB date' },
  ],
  /**
   * Task #83 spec item 5 — Proposal Presented → PD (Pitch Discussion): a
   * completed meeting OR a logged call, plus a PD quotation. The quotation
   * check accepts either a real Quote row (from the Quote Builder callback)
   * or an uploaded QUOTATION/GENERATED_QUOTE file — this is the fix for the
   * reported "uploaded the generated quotation but couldn't move stage" bug:
   * the gate previously only recognised a Quote db row, so a manually
   * uploaded quotation document never satisfied it.
   */
  'PROPOSAL_PRESENTED->PROPOSAL_DISCUSSION': [
    { type: 'meetingOrCall', meetingType: 'PP', label: 'Meeting or call scheduled & completed' },
    { type: 'quote', stages: ['PROPOSAL_PRESENTED'], fileTypes: ['QUOTATION', 'GENERATED_QUOTE', 'PP_QUOTATION'], label: 'PP Quotation' },
    { type: 'file', fileType: 'PITCH_PRESENTATION', stages: ['PROPOSAL_PRESENTED'], label: 'PD Pitch Presentation file (Files → PP)' },
  ],
  /**
   * Task #83 spec item 6 — PD (Pitch Discussion) → Onboarding: generated OB
   * quote, final pitch presentation or PD file, payment value, project value
   * (excl. furniture), and furniture value. The PD→OB checklist's
   * "send welcome mail" action validates all of these itemised fields (plus
   * a couple of operational extras — payment screenshot, OB meeting
   * date/location, notes) and performs the transition directly — see
   * routes/pdObChecklist.ts. The `fileAnyOf` requirement below is an
   * independent, always-checked baseline for the "final pitch presentation
   * or PD file" item, which nothing previously enforced.
   */
  'PROPOSAL_DISCUSSION->ONBOARDING': [
    {
      // Also accepts PROPOSAL_PRESENTED: when a lead skips PD entirely
      // (PP→OB), it never visits the PROPOSAL_DISCUSSION folder — per spec
      // its files stay grouped under PP (virtual stage-based grouping), so
      // this file must be attachable, and checked, while still in PP.
      // Either upload type counts: the Files tab offers both "Pitch Presentation"
      // and "Final Pitch Presentation", and users reasonably pick the latter here.
      type: 'fileAnyOf', fileTypes: ['PITCH_PRESENTATION', 'FINAL_PITCH_PRESENTATION'], stages: ['PROPOSAL_DISCUSSION', 'PROPOSAL_PRESENTED'],
      label: 'Final Pitch Presentation file (Files → PD or PP if skipping PD)',
    },
    {
      type: 'quote', stages: ['PROPOSAL_DISCUSSION', 'PROPOSAL_PRESENTED'], fileTypes: ['GENERATED_QUOTE'],
      label: 'Generated Quotation (Quote Builder or Files → PP/PD)',
    },
    // Mandatory in every case, including a PP→OB skip — never one of the
    // items dropped by isExcludedWhenSkipping('PROPOSAL_DISCUSSION').
    { type: 'pdObChecklist', label: 'Completed PD→OB checklist (welcome mail sent)' },
  ],
  /**
   * Onboarding → Onboarding Meeting must follow the same gate as the guided
   * checklist flow. A scheduled meeting alone used to let a direct stage
   * change bypass the documents, timeline, NPS, client email and welcome-mail
   * checks enforced by send-obm-mail.
   */
  'ONBOARDING->ONBOARDING_MEETING': [
    { type: 'obObmChecklist', label: 'Completed OB→OBM checklist (welcome mail sent)' },
  ],
  /**
   * Task #83 spec item 8 — Onboarding Meeting → Design in Progress: the OBM
   * meeting must be marked completed, and the OBM checklist (DIPChecklist —
   * welcome mail sent, discount approval form sent, NPS triggered, CX
   * approval received, internal mail thread completed) must be completed.
   */
  'ONBOARDING_MEETING->DESIGN_IN_PROGRESS': [
    // Onboarding Meeting records are created with meetingType 'OBM' (see
    // CREATABLE_MEETING_TYPES in routes/meetings.ts); 'ONBOARDING' is the
    // earlier Onboarding-stage meeting type. Checking only 'ONBOARDING' here
    // meant a genuinely completed OBM meeting could never satisfy this gate.
    { type: 'meetingAnyOf', meetingTypes: ['OBM', 'ONBOARDING'], status: 'completed', label: 'OBM meeting completed' },
    { type: 'dip', label: 'OBM checklist completed' },
    // The client's written confirmation that they received and approved the
    // OBM welcome mail must be uploaded to the Files tab (as a
    // WELCOME_MAIL_SCREENSHOT) before the lead may advance to Design in
    // Progress. Accepts files uploaded at either ONBOARDING or
    // ONBOARDING_MEETING stage so leads aren't blocked by upload-stage drift.
    {
      type: 'file',
      fileType: 'WELCOME_MAIL_SCREENSHOT',
      stages: ['ONBOARDING', 'ONBOARDING_MEETING'],
      label: 'Client OBM mail approval screenshot (Files → Onboarding Meeting)',
    },
  ],
};

/**
 * Linear funnel order. Used to expand a forward stage jump into the set of
 * intermediate adjacent transitions whose requirements must all be satisfied.
 * Stages not listed here (EFFECTIVE_LEAD, HANDED_OVER, INACTIVE, ON_HOLD) are
 * legacy/off-funnel and ungated.
 */
export const FUNNEL_ORDER = [
  'MQL',
  'DQL',
  'PROPOSAL_READY',
  'PROPOSAL_PRESENTED',
  'PROPOSAL_DISCUSSION',
  'ONBOARDING',
  'ONBOARDING_MEETING',
  'DESIGN_IN_PROGRESS',
] as const;

/**
 * Stages the founder's agreed spec marks as genuinely optional — a lead may
 * jump straight past any of these without visiting them. MQL, Proposal
 * Presented, Onboarding, Onboarding Meeting and Design in Progress are NOT
 * skippable: they remain mandatory one-at-a-time steps.
 *
 * A forward jump from `fromStage` to `toStage` is allowed whenever every
 * FUNNEL_ORDER stage strictly between them is in this set — see
 * isStageJumpAllowed(). This generalises what used to be a hardcoded list of
 * three exact (from,to) pairs (DQL→PP, MQL→PP, PP→OB) into "DQL, Proposal
 * Ready and PD (Pitch Discussion) are all skippable", which also legalises the
 * previously-missing MQL→Proposal Ready combination (skip DQL only) without
 * opening up any jump that would also skip the mandatory PP step.
 */
const SKIPPABLE_STAGES = new Set<string>(['DQL', 'PROPOSAL_READY', 'PROPOSAL_DISCUSSION']);

/**
 * Whether a stage change from `fromStage` to `toStage` is structurally
 * permitted at all (independent of whether its gate requirements are met).
 * Backward moves within the active funnel are left to the caller's own
 * backward-move restriction. Legacy stages (EFFECTIVE_LEAD, HANDED_OVER) are
 * off-funnel for *new* transitions, not an unrestricted bypass of it:
 *   - EFFECTIVE_LEAD may only move forward into MQL (the funnel's real
 *     starting point) — it can't be used to jump straight into DQL/PP/etc.
 *   - HANDED_OVER can never be entered going forward now that
 *     DESIGN_IN_PROGRESS is the funnel's terminal/incentive stage; it only
 *     exists on pre-restructure leads.
 * This only blocks illegal forward skips/entries — off-funnel side moves
 * (INACTIVE, ON_HOLD) and true backward moves are handled by the caller.
 */
export function isStageJumpAllowed(fromStage: string, toStage: string): boolean {
  if (toStage === 'HANDED_OVER') return false;

  const toIdx = FUNNEL_ORDER.indexOf(toStage as (typeof FUNNEL_ORDER)[number]);

  // EFFECTIVE_LEAD is legacy/off-funnel (not in FUNNEL_ORDER), so it's handled
  // by two explicit, symmetric rules rather than the index arithmetic below:
  //   - Moving OUT of EL into an active funnel stage may only land on MQL
  //     (the funnel's real starting point) — this does NOT restrict EL's
  //     side moves (ON_HOLD/INACTIVE), which aren't in FUNNEL_ORDER either
  //     and so fall through to the "unrestricted off-funnel" branch below.
  //   - Moving INTO EL is only ever the explicit MQL → EL rollback; every
  //     other stage (DQL and beyond) is blocked from demoting back to EL,
  //     matching the "only MQL → Effective Lead" rule enforced in leads.ts.
  if (fromStage === 'EFFECTIVE_LEAD' && toIdx !== -1) return toStage === 'MQL';
  if (toStage === 'EFFECTIVE_LEAD') return fromStage === 'MQL';

  const fromIdx = FUNNEL_ORDER.indexOf(fromStage as (typeof FUNNEL_ORDER)[number]);
  if (fromIdx === -1 || toIdx === -1) return true; // other legacy/off-funnel — unrestricted
  // Client-approved direct shortcut: MQL → Onboarding (skips DQL, PR, PP, PD).
  // MQL → Proposal Presented is already covered by the skippable-stage rule.
  if (fromStage === 'MQL' && toStage === 'ONBOARDING') return true;
  if (toIdx <= fromIdx) return true; // backward/no-op — handled elsewhere
  if (toIdx === fromIdx + 1) return true; // adjacent forward step always fine
  // Every stage strictly between fromStage and toStage must be an
  // explicitly-skippable one, or the jump is not structurally allowed.
  for (let i = fromIdx + 1; i < toIdx; i++) {
    if (!SKIPPABLE_STAGES.has(FUNNEL_ORDER[i])) return false;
  }
  return true;
}

/** True when a requirement on the edge INTO `skippedStage` becomes optional
 * because `skippedStage` itself is being skipped over on this jump. */
function isExcludedWhenSkipping(req: StageRequirement, skippedStage: string): boolean {
  if (skippedStage === 'DQL') {
    // "the DQL meeting" becomes optional when DQL itself is skipped over.
    return req.type === 'meeting' && req.meetingType === 'DQL';
  }
  if (skippedStage === 'PROPOSAL_READY') {
    // Requirements for entering PR (the DQL pitch-ready file and PR-specific
    // quotation) become optional when PR itself is skipped. The PR→PP edge
    // still contributes its own PP presentation and PP quotation requirements.
    return (
      (req.type === 'file' && req.fileType === 'PITCH_PRESENTATION' && req.stages.includes('DQL'))
      || (req.type === 'quote' && !!req.fileTypes?.includes('PR_QUOTATION'))
    );
  }
  if (skippedStage === 'PROPOSAL_PRESENTED') {
    // Only reachable on the MQL → Onboarding shortcut: the PP meeting never
    // happens, so it can't be required. PP documents/value still apply.
    return req.type === 'meeting' && req.meetingType === 'PP';
  }
  if (skippedStage === 'PROPOSAL_DISCUSSION') {
    // Per spec, skipping PD (Pitch Discussion) drops that leg's requirements
    // (meeting/call + PD quote) entirely — only the PD→OB leg's own
    // requirements (the PD→OB checklist etc.) still apply.
    return true;
  }
  return false;
}

/**
 * Requirements that get excluded from the gate on the skip transition itself
 * (per isExcludedWhenSkipping) but must still be collected before the lead
 * can advance any further. Keyed by the Lead boolean flag
 * (skippedProposalDiscussion) that records the skip actually happened, so
 * these only apply to leads that took that specific skip path.
 *
 * DQL is intentionally absent: when DQL is skipped, its DQL-meeting
 * requirement is waived for the rest of the funnel. A lead that skips DQL
 * must still satisfy the requirements of the stage it is entering and every
 * later stage it actually visits, but it must not retroactively complete the
 * skipped DQL meeting.
 */
const DEFERRED_SKIP_REQUIREMENTS: Record<string, StageRequirement[]> = {
  // DQL→PP is an approved shortcut. Its PP-folder quotation and presentation
  // replace the otherwise separate PR-folder paperwork, so no duplicate PR
  // upload remains owed after that skip.
  skippedProposalReady: [],
  skippedProposalDiscussion: (STAGE_REQUIREMENTS['PROPOSAL_PRESENTED->PROPOSAL_DISCUSSION'] ?? [])
    .filter((r) => isExcludedWhenSkipping(r, 'PROPOSAL_DISCUSSION')),
};

/**
 * Collect all requirements that apply when moving from `fromStage` to
 * `toStage`. For forward moves along the funnel this accumulates every
 * intermediate step's requirements so jumps cannot bypass a gate — except
 * the three explicitly-allowed skip transitions, which drop the specific
 * items the founder marked optional for that skip (see
 * ALLOWED_SKIP_TRANSITIONS and isExcludedWhenSkipping). Backward moves and
 * off-funnel stages return any directly-configured requirements (currently
 * none), i.e. they are ungated.
 */
function requirementsForTransition(fromStage: string, toStage: string): StageRequirement[] {
  const key = `${fromStage}->${toStage}`;

  // An explicit STAGE_REQUIREMENTS entry always takes precedence for a plain
  // adjacent step.
  const explicit = STAGE_REQUIREMENTS[key];
  if (explicit !== undefined) return explicit;

  const fromIdx = FUNNEL_ORDER.indexOf(fromStage as (typeof FUNNEL_ORDER)[number]);
  const toIdx = FUNNEL_ORDER.indexOf(toStage as (typeof FUNNEL_ORDER)[number]);

  if (fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx) {
    // Skip jump: accumulate every intermediate edge's requirements, dropping
    // whichever items become optional for each stage that's skipped over
    // (see isExcludedWhenSkipping). The edge landing exactly on `toStage` is
    // never treated as "skipped" — its requirements always apply in full.
    const reqs: StageRequirement[] = [];
    for (let i = fromIdx; i < toIdx; i++) {
      const stepFrom = FUNNEL_ORDER[i];
      const stepTo = FUNNEL_ORDER[i + 1];
      const stepReqs = STAGE_REQUIREMENTS[`${stepFrom}->${stepTo}`] ?? [];
      const isSkippedStage = stepTo !== toStage;
      reqs.push(...(isSkippedStage ? stepReqs.filter((r) => !isExcludedWhenSkipping(r, stepTo)) : stepReqs));
    }
    return reqs;
  }

  return [];
}

/**
 * "One upload satisfies every matching checklist item": file gates ignore which
 * stage folder a file was uploaded under, and equivalent document types count
 * as the same document (floor plan = lifestyle capture sheet, pitch = final
 * pitch). The configured `stages` stay in the config as documentation of where
 * the Files tab offers the upload, but are no longer enforced.
 */
const FILE_TYPE_EQUIVALENTS: string[][] = [
  ['FLOOR_PLAN', 'LIFESTYLE_CAPTURE'],
  ['PITCH_PRESENTATION', 'FINAL_PITCH_PRESENTATION'],
];
export function expandFileTypes(t: string): string[] {
  const group = FILE_TYPE_EQUIVALENTS.find((g) => g.includes(t));
  return group ?? [t];
}
/** Any quotation file satisfies PR/PP quotation items; the Onboarding quote too (one upload satisfies all). */
const QUOTATION_FAMILY = ['OB_QUOTE', 'QUOTATION', 'PR_QUOTATION', 'PP_QUOTATION', 'GENERATED_QUOTE'];
export function expandQuoteTypes(types: string[]): string[] {
  return Array.from(new Set([...types, ...QUOTATION_FAMILY]));
}

const ACTIVE_MEETING_STATUSES = ['SCHEDULED', 'RESCHEDULED', 'COMPLETED'] as const;

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

export interface StageCheckResult {
  ok: boolean;
  missing: string[];
  /** Per-requirement satisfaction, in the same order as configured, so UI can show which specific items are met vs. missing.
   * `type` mirrors the requirement's config type (or 'intent' for the intent-rating gate) so callers can decide how to act on
   * an unmet item — e.g. deep-link to the PD→OB / OBM→DIP checklist rather than just showing text. */
  details: { label: string; satisfied: boolean; type: string }[];
}

/**
 * Evaluate whether a lead satisfies the requirements for a stage transition.
 * `lead` must include `id` and should reflect any field changes being applied
 * in the same request (so a user can set a required field and change stage in
 * one update).
 */
export async function checkStageRequirements(
  lead: Record<string, any>,
  fromStage: string,
  toStage: string,
): Promise<StageCheckResult> {
  const fromIdx = FUNNEL_ORDER.indexOf(fromStage as (typeof FUNNEL_ORDER)[number]);
  const toIdx = FUNNEL_ORDER.indexOf(toStage as (typeof FUNNEL_ORDER)[number]);
  const isForwardFunnelMove = fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx;

  const reqs = requirementsForTransition(fromStage, toStage);

  // A lead that previously skipped DQL/Proposal Ready/PD (Pitch Discussion)
  // still owes that stage's excluded requirements — they were only waived
  // for the skip hop itself, not forever. Keep surfacing them on every later
  // forward move until fulfilled. Dedup by label in case a requirement is
  // already part of this transition's own leg.
  if (isForwardFunnelMove) {
    const seenLabels = new Set(reqs.map((r) => r.label));
    for (const [flag, deferredReqs] of Object.entries(DEFERRED_SKIP_REQUIREMENTS)) {
      if (!lead[flag]) continue;
      for (const r of deferredReqs) {
        if (seenLabels.has(r.label)) continue;
        seenLabels.add(r.label);
        reqs.push(r);
      }
    }
  }

  const missing: string[] = [];
  const details: { label: string; satisfied: boolean; type: string }[] = [];

  for (const r of reqs) {
    let satisfied = false;
    switch (r.type) {
      case 'field':
        satisfied = hasValue(lead[r.field]);
        break;
      case 'meeting': {
        const statuses = r.status === 'completed' ? ['COMPLETED'] : ACTIVE_MEETING_STATUSES;
        const m = await prisma.meeting.findFirst({
          where: {
            leadId: lead.id,
            type: r.meetingType as any,
            status: { in: statuses as any },
          },
          select: { id: true },
        });
        satisfied = !!m;
        break;
      }
      case 'meetingAnyOf': {
        const statuses = r.status === 'completed' ? ['COMPLETED'] : ACTIVE_MEETING_STATUSES;
        const m = await prisma.meeting.findFirst({
          where: {
            leadId: lead.id,
            type: { in: r.meetingTypes as any },
            status: { in: statuses as any },
          },
          select: { id: true },
        });
        satisfied = !!m;
        break;
      }
      case 'meetingOrCall': {
        const [m, c] = await Promise.all([
          prisma.meeting.findFirst({
            // A completed PD (Pitch Discussion) meeting also satisfies the PP→PD
            // meeting-or-call item, since PD meetings are held while still in PP.
            where: { leadId: lead.id, type: { in: (r.meetingType === 'PP' ? ['PP', 'PD'] : [r.meetingType]) as any }, status: 'COMPLETED' as any },
            select: { id: true },
          }),
          prisma.call.findFirst({ where: { leadId: lead.id }, select: { id: true } }),
        ]);
        satisfied = !!m || !!c;
        break;
      }
      case 'quote': {
        const [q, f] = await Promise.all([
          prisma.quote.findFirst({ where: { leadId: lead.id }, select: { id: true } }),
          prisma.leadFile.findFirst({
            where: {
              leadId: lead.id,
              fileType: { in: expandQuoteTypes(r.fileTypes ?? ['QUOTATION', 'GENERATED_QUOTE']) as any },
            },
            select: { id: true },
          }),
        ]);
        satisfied = !!q || !!f;
        break;
      }
      case 'dip': {
        const dip = await prisma.dIPChecklist.findUnique({
          where: { leadId: lead.id },
          select: { completedAt: true },
        });
        satisfied = !!dip?.completedAt;
        break;
      }
      case 'pdObChecklist': {
        const c = await prisma.pDOBChecklist.findUnique({
          where: { leadId: lead.id },
          select: { completedAt: true },
        });
        satisfied = !!c?.completedAt;
        break;
      }
      case 'obObmChecklist': {
        const c = await prisma.oBOBMChecklist.findUnique({
          where: { leadId: lead.id },
          select: { completedAt: true },
        });
        satisfied = !!c?.completedAt;
        break;
      }
      case 'file': {
        const fileRecord = await prisma.leadFile.findFirst({
          where: {
            leadId: lead.id,
            fileType: { in: expandFileTypes(r.fileType) as any },
          },
          select: { id: true },
        });
        satisfied = !!fileRecord;
        // Backward-compat: floor plan field on the lead also satisfies FLOOR_PLAN check
        if (!satisfied && r.fileType === 'FLOOR_PLAN') {
          satisfied = hasValue(lead.floorPlanUrl);
        }
        break;
      }
      case 'fileAnyOf': {
        const fileRecord = await prisma.leadFile.findFirst({
          where: {
            leadId: lead.id,
            fileType: { in: r.fileTypes.flatMap(expandFileTypes) as any },
          },
          select: { id: true },
        });
        satisfied = !!fileRecord;
        break;
      }
    }
    if (!satisfied) missing.push(r.label);
    details.push({ label: r.label, satisfied, type: r.type });
  }

  // Intent-rating=1 ("no action planned") gate — scoped to the MQL→DQL
  // qualification decision only. This previously blocked EVERY forward move
  // for the rest of a lead's life once its rating hit 1★ (e.g. an early
  // low-signal meeting auto-scored it 1★, and the lead was then frozen at
  // every later stage even after real progress was made) — a lead that has
  // already been qualified past MQL has, by definition, had action taken on
  // it, so re-checking this rating on every subsequent hop served no purpose
  // and was the reported cause of leads looking permanently "stuck". The one
  // gate the founder's spec actually cares about is the qualification
  // decision itself: don't let a "no action planned" lead be qualified out
  // of MQL in the first place.
  if (fromStage === 'MQL' && toIdx > fromIdx && lead.intentRating === 1) {
    const label = 'Intent rating is 1★ (no action planned) — update the lead\'s intent rating before qualifying past MQL';
    missing.push(label);
    details.push({ label, satisfied: false, type: 'intent' });
  }

  return { ok: missing.length === 0, missing, details };
}

// ── Test-only export (added to the frozen pre-refactor copy) ─────────────────
// Mirrors the requirement assembly at the top of checkStageRequirements so the
// new configurable engine can be compared against the original behaviour.
export function legacyRequirementLabels(lead: Record<string, any>, fromStage: string, toStage: string): string[] {
  const fromIdx = FUNNEL_ORDER.indexOf(fromStage as (typeof FUNNEL_ORDER)[number]);
  const toIdx = FUNNEL_ORDER.indexOf(toStage as (typeof FUNNEL_ORDER)[number]);
  const isForwardFunnelMove = fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx;
  // Copied, unlike the original: the original pushed owed items straight into
  // the shared STAGE_REQUIREMENTS array for adjacent moves, so they leaked into
  // every later lead's gate until restart. Compare against the intended output.
  const reqs = [...requirementsForTransition(fromStage, toStage)];
  if (isForwardFunnelMove) {
    const seenLabels = new Set(reqs.map((r) => r.label));
    for (const [flag, deferredReqs] of Object.entries(DEFERRED_SKIP_REQUIREMENTS)) {
      if (!lead[flag]) continue;
      for (const r of deferredReqs) {
        if (seenLabels.has(r.label)) continue;
        seenLabels.add(r.label);
        reqs.push(r);
      }
    }
  }
  return reqs.map((r) => r.label);
}
