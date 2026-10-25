import { prisma } from '../lib/prisma.js';
import { isLenientLaunch } from '../lib/lenientMode.js';

/**
 * Stage-movement rules: the mandatory fields/actions required to move a lead
 * from one stage to another.
 *
 * The rules are admin-editable (Admin → Stage Rules, see lib/stageRules.ts):
 * the saved copy lives in AssignmentConfig under STAGE_RULES_CONFIG_KEY. When
 * nothing has been saved, `defaultStageRules()` applies — built from
 * STAGE_REQUIREMENTS below, which is the founder's 8-gate spec (Task #83):
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
 * leaping ahead — except when every skipped stage is skippable, in which case
 * each item's `whenSkipped` decides whether it still applies on the jump.
 * Backward moves and off-funnel stages are unrestricted.
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
        | 'expectedObDate'
        | 'possessionTimeline'
        | 'email';
      label: string;
    }
  /** An admin-defined custom field (CustomFieldDefinition.key) must be filled in. */
  | { type: 'customField'; key: string; label: string }
  /** A meeting of the given type must exist. `status` defaults to 'scheduled'
   * (any active status — SCHEDULED/RESCHEDULED/COMPLETED all count); pass
   * 'completed' to require the meeting be specifically marked COMPLETED. */
  | { type: 'meeting'; meetingType: 'DQL' | 'PP' | 'PD' | 'ONBOARDING' | 'OBM'; status?: 'scheduled' | 'completed'; label: string }
  /** Satisfied by EITHER a completed meeting of the given type, OR any logged
   * Call for the lead (calls have no separate "scheduled" state — they are
   * logged after the fact, so any Call row counts as "completed"). */
  | { type: 'meetingOrCall'; meetingType: 'DQL' | 'PP' | 'PD' | 'ONBOARDING' | 'OBM'; label: string }
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
   * Admin-defined document types use the form `custom:<key>`.
   */
  | { type: 'file'; fileType: string; stages: string[]; label: string }
  /** Satisfied if a LeadFile with ANY of the given fileTypes exists in one of the listed stages. */
  | { type: 'fileAnyOf'; fileTypes: string[]; stages: string[]; label: string };

/** The founder's spec — the defaults behind defaultStageRules(). Admin edits never change this object. */
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

/** Every adjacent funnel step, in order — the transitions an admin can configure. */
export const FUNNEL_EDGES: string[] = FUNNEL_ORDER.slice(0, -1).map((s, i) => `${s}->${FUNNEL_ORDER[i + 1]}`);

// ── Admin-editable rules ─────────────────────────────────────────────────────

/**
 * What happens to an item on the edge INTO a stage when a lead jumps over that
 * stage:
 *   required  — still has to be met on the jump;
 *   waived    — dropped for good;
 *   owedLater — dropped for the jump, but asked for again on every later
 *               forward move until met (needs the lead's skipped-stage flag,
 *               so only DQL, Proposal Ready and PD support it).
 */
export type WhenSkipped = 'required' | 'waived' | 'owedLater';
export type RuleItem = StageRequirement & {
  id: string;
  whenSkipped: WhenSkipped;
  /** Checklist-backed items: the checklist performs the move, so they can't be edited or removed. */
  locked?: boolean;
};
/** block = the move is refused; warn = the move goes ahead and the gap is logged (GATE_BYPASSED). */
export type Enforcement = 'block' | 'warn';

export interface StageRulesConfig {
  transitions: Record<string, RuleItem[]>;
  /** Stages a lead may jump straight past. Subset of SKIPPABLE_CANDIDATES. */
  skippableStages: string[];
  /** Client-approved shortcut MQL → Onboarding (skips DQL, PR, PP and PD). */
  allowMqlToOnboarding: boolean;
  /** Keyed by target stage; only WARNABLE_TARGETS can be 'warn'. */
  enforcement: Record<string, Enforcement>;
}

export const STAGE_RULES_CONFIG_KEY = 'stage_rules_v1';

/** MQL, Proposal Presented, Onboarding, Onboarding Meeting and DIP stay one-at-a-time steps. */
export const SKIPPABLE_CANDIDATES = ['DQL', 'PROPOSAL_READY', 'PROPOSAL_DISCUSSION'];

/**
 * Annie (Oct 2026): from Onboarding onward the full rules always apply (OB,
 * OBM and DIP checklists, uploads, stage-move requirements), so only moves
 * into the pre-Onboarding stages may be set to "warn".
 */
export const WARNABLE_TARGETS = ['DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION'];

/** Lead flag recording that a stage was jumped over (set by the stage-change handler). */
export const SKIP_FLAG_BY_STAGE: Record<string, 'skippedDQL' | 'skippedProposalReady' | 'skippedProposalDiscussion'> = {
  DQL: 'skippedDQL',
  PROPOSAL_READY: 'skippedProposalReady',
  PROPOSAL_DISCUSSION: 'skippedProposalDiscussion',
};

const LOCKED_TYPES = new Set(['pdObChecklist', 'obObmChecklist', 'dip']);
export function isLockedRequirement(req: { type: string }): boolean {
  return LOCKED_TYPES.has(req.type);
}

/**
 * The founder-spec skip behaviour, expressed per item: which requirements on
 * the edge INTO `stage` become optional when `stage` itself is skipped over.
 */
function defaultWhenSkipped(req: StageRequirement, stage: string): WhenSkipped {
  if (stage === 'DQL') {
    // "the DQL meeting" becomes optional when DQL itself is skipped over.
    return req.type === 'meeting' && req.meetingType === 'DQL' ? 'waived' : 'required';
  }
  if (stage === 'PROPOSAL_READY') {
    // Requirements for entering PR (the DQL pitch-ready file and PR-specific
    // quotation) become optional when PR itself is skipped. The PR→PP edge
    // still contributes its own PP presentation and PP quotation requirements.
    // A DQL→PP skip's PP-folder documents replace the PR paperwork, so nothing
    // stays owed afterwards.
    const waived = (req.type === 'file' && req.fileType === 'PITCH_PRESENTATION' && req.stages.includes('DQL'))
      || (req.type === 'quote' && !!req.fileTypes?.includes('PR_QUOTATION'));
    return waived ? 'waived' : 'required';
  }
  if (stage === 'PROPOSAL_PRESENTED') {
    // Only reachable on the MQL → Onboarding shortcut: the PP meeting never
    // happens, so it can't be required. PP documents/value still apply.
    return req.type === 'meeting' && req.meetingType === 'PP' ? 'waived' : 'required';
  }
  if (stage === 'PROPOSAL_DISCUSSION') {
    // Skipping PD drops that leg's requirements (meeting/call + PD quote) for
    // the jump itself, but they are still owed on every later forward move.
    return 'owedLater';
  }
  return 'required';
}

/** The rules as shipped (the founder's spec). Used until an admin saves changes. */
export function defaultStageRules(lenient: boolean = isLenientLaunch()): StageRulesConfig {
  const transitions: Record<string, RuleItem[]> = {};
  for (const edge of FUNNEL_EDGES) {
    const toStage = edge.split('->')[1];
    transitions[edge] = (STAGE_REQUIREMENTS[edge] ?? []).map((req, i) => ({
      ...req,
      id: `default:${edge}:${i + 1}`,
      whenSkipped: defaultWhenSkipped(req, toStage),
      ...(isLockedRequirement(req) && { locked: true }),
    }));
  }
  const enforcement: Record<string, Enforcement> = {};
  for (const stage of WARNABLE_TARGETS) enforcement[stage] = lenient ? 'warn' : 'block';
  return {
    transitions,
    skippableStages: [...SKIPPABLE_CANDIDATES],
    allowMqlToOnboarding: true,
    enforcement,
  };
}

/** Effective rules: the admin-saved copy if there is one, else the defaults. */
export async function getEffectiveStageRules(): Promise<StageRulesConfig> {
  const row = await prisma.assignmentConfig.findUnique({ where: { key: STAGE_RULES_CONFIG_KEY } });
  const stored = (row?.value as { config?: StageRulesConfig } | null)?.config;
  return stored ? withLockedItems(stored) : defaultStageRules();
}

/**
 * Checklist-backed items can never be dropped from a saved copy: the checklist
 * routes perform those moves and rely on the gate also guarding a direct
 * stage change.
 */
export function withLockedItems(config: StageRulesConfig): StageRulesConfig {
  const defaults = defaultStageRules();
  const transitions: Record<string, RuleItem[]> = {};
  for (const edge of FUNNEL_EDGES) {
    const locked = defaults.transitions[edge].filter((r) => isLockedRequirement(r));
    // A checklist step keeps the position the admin left it in, but always in
    // its original form; one that was removed comes back at the end.
    const items = (config.transitions?.[edge] ?? []).flatMap((r) => {
      if (!isLockedRequirement(r)) return [r];
      const original = locked.find((l) => l.type === r.type);
      return original ? [original] : [];
    });
    for (const l of locked) if (!items.some((r) => r.type === l.type)) items.push(l);
    transitions[edge] = items;
  }
  return { ...config, transitions };
}

/** Whether a gap on a move into `toStage` only warns instead of blocking. */
export function isWarnOnly(toStage: string, rules: StageRulesConfig): boolean {
  return WARNABLE_TARGETS.includes(toStage) && rules.enforcement[toStage] === 'warn';
}

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
export function isStageJumpAllowed(
  fromStage: string,
  toStage: string,
  rules: StageRulesConfig = defaultStageRules(),
): boolean {
  if (toStage === 'HANDED_OVER') return false;

  const toIdx = FUNNEL_ORDER.indexOf(toStage as (typeof FUNNEL_ORDER)[number]);

  // EFFECTIVE_LEAD is legacy/off-funnel (not in FUNNEL_ORDER), so it's handled
  // by two explicit, symmetric rules rather than the index arithmetic below:
  //   - Moving OUT of EL into an active funnel stage may only land on MQL.
  //   - Moving INTO EL is only ever the explicit MQL → EL rollback, matching
  //     the "only MQL → Effective Lead" rule enforced in leads.ts.
  if (fromStage === 'EFFECTIVE_LEAD' && toIdx !== -1) return toStage === 'MQL';
  if (toStage === 'EFFECTIVE_LEAD') return fromStage === 'MQL';

  const fromIdx = FUNNEL_ORDER.indexOf(fromStage as (typeof FUNNEL_ORDER)[number]);
  if (fromIdx === -1 || toIdx === -1) return true; // other legacy/off-funnel — unrestricted
  if (rules.allowMqlToOnboarding && fromStage === 'MQL' && toStage === 'ONBOARDING') return true;
  if (toIdx <= fromIdx) return true; // backward/no-op — handled elsewhere
  if (toIdx === fromIdx + 1) return true; // adjacent forward step always fine
  // Every stage strictly between fromStage and toStage must be skippable.
  for (let i = fromIdx + 1; i < toIdx; i++) {
    if (!rules.skippableStages.includes(FUNNEL_ORDER[i])) return false;
  }
  return true;
}

/** Human-readable list of the allowed skips, for error messages. */
export function describeAllowedSkips(rules: StageRulesConfig, label: (stage: string) => string = (s) => s): string {
  const parts = rules.skippableStages.map(label);
  const skips = parts.length ? `only ${parts.join(', ')} can be skipped over` : 'no stage can be skipped over';
  return rules.allowMqlToOnboarding ? `${skips} (plus MQL → Onboarding directly)` : skips;
}

/**
 * Collect all requirements that apply when moving from `fromStage` to
 * `toStage`. For forward moves along the funnel this accumulates every
 * intermediate step's requirements so jumps cannot bypass a gate — dropping,
 * on each stage jumped over, the items whose `whenSkipped` isn't 'required'.
 * The edge landing exactly on `toStage` always applies in full. Backward moves
 * and off-funnel stages are ungated.
 */
function requirementsForTransition(fromStage: string, toStage: string, rules: StageRulesConfig): RuleItem[] {
  const explicit = rules.transitions[`${fromStage}->${toStage}`];
  if (explicit !== undefined) return [...explicit];

  const fromIdx = FUNNEL_ORDER.indexOf(fromStage as (typeof FUNNEL_ORDER)[number]);
  const toIdx = FUNNEL_ORDER.indexOf(toStage as (typeof FUNNEL_ORDER)[number]);
  if (fromIdx === -1 || toIdx === -1 || toIdx <= fromIdx) return [];

  const reqs: RuleItem[] = [];
  for (let i = fromIdx; i < toIdx; i++) {
    const stepTo = FUNNEL_ORDER[i + 1];
    const stepReqs = rules.transitions[`${FUNNEL_ORDER[i]}->${stepTo}`] ?? [];
    const isSkippedStage = stepTo !== toStage;
    reqs.push(...(isSkippedStage ? stepReqs.filter((r) => r.whenSkipped === 'required') : stepReqs));
  }
  return reqs;
}

/**
 * Every requirement that applies to this move, including items a previous
 * skip left owed ('owedLater'). Pure — no database access.
 */
export function requirementsForMove(
  lead: Record<string, any>,
  fromStage: string,
  toStage: string,
  rules: StageRulesConfig,
): RuleItem[] {
  const fromIdx = FUNNEL_ORDER.indexOf(fromStage as (typeof FUNNEL_ORDER)[number]);
  const toIdx = FUNNEL_ORDER.indexOf(toStage as (typeof FUNNEL_ORDER)[number]);
  const reqs = requirementsForTransition(fromStage, toStage, rules);

  // A lead that previously skipped a stage still owes that stage's 'owedLater'
  // items on every later forward move until fulfilled. Dedup by label in case
  // a requirement is already part of this transition's own leg.
  if (fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx) {
    const seenLabels = new Set(reqs.map((r) => r.label));
    for (const [stage, flag] of Object.entries(SKIP_FLAG_BY_STAGE)) {
      if (!lead[flag]) continue;
      const edge = FUNNEL_EDGES.find((e) => e.endsWith(`->${stage}`));
      for (const r of (edge && rules.transitions[edge]) || []) {
        if (r.whenSkipped !== 'owedLater' || seenLabels.has(r.label)) continue;
        seenLabels.add(r.label);
        reqs.push(r);
      }
    }
  }
  return reqs;
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

export const CUSTOM_DOC_PREFIX = 'custom:';

/** Prisma filter matching a lead's files of any of `types` (built-in enum values or `custom:<key>`). */
function leadFileWhere(leadId: string, types: string[]) {
  const builtIn = types.filter((t) => !t.startsWith(CUSTOM_DOC_PREFIX));
  const custom = types.filter((t) => t.startsWith(CUSTOM_DOC_PREFIX)).map((t) => t.slice(CUSTOM_DOC_PREFIX.length));
  const or: any[] = [];
  if (builtIn.length) or.push({ fileType: { in: builtIn as any } });
  if (custom.length) or.push({ fileType: 'OTHER' as any, customType: { in: custom } });
  return { leadId, OR: or.length ? or : [{ id: '__none__' }] };
}

const ACTIVE_MEETING_STATUSES = ['SCHEDULED', 'RESCHEDULED', 'COMPLETED'] as const;

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

/** Whether one requirement is met for the lead. */
export async function isRequirementMet(r: StageRequirement, lead: Record<string, any>): Promise<boolean> {
  switch (r.type) {
    case 'field':
      return hasValue(lead[r.field]);
    case 'customField':
      return hasValue((lead.customFields as Record<string, unknown> | null | undefined)?.[r.key]);
    case 'meeting': {
      const statuses = r.status === 'completed' ? ['COMPLETED'] : ACTIVE_MEETING_STATUSES;
      const m = await prisma.meeting.findFirst({
        where: { leadId: lead.id, type: r.meetingType as any, status: { in: statuses as any } },
        select: { id: true },
      });
      return !!m;
    }
    case 'meetingAnyOf': {
      const statuses = r.status === 'completed' ? ['COMPLETED'] : ACTIVE_MEETING_STATUSES;
      const m = await prisma.meeting.findFirst({
        where: { leadId: lead.id, type: { in: r.meetingTypes as any }, status: { in: statuses as any } },
        select: { id: true },
      });
      return !!m;
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
      return !!m || !!c;
    }
    case 'quote': {
      const [q, f] = await Promise.all([
        prisma.quote.findFirst({ where: { leadId: lead.id }, select: { id: true } }),
        prisma.leadFile.findFirst({
          where: leadFileWhere(lead.id, expandQuoteTypes(r.fileTypes ?? ['QUOTATION', 'GENERATED_QUOTE'])),
          select: { id: true },
        }),
      ]);
      return !!q || !!f;
    }
    case 'dip': {
      const dip = await prisma.dIPChecklist.findUnique({ where: { leadId: lead.id }, select: { completedAt: true } });
      return !!dip?.completedAt;
    }
    case 'pdObChecklist': {
      const c = await prisma.pDOBChecklist.findUnique({ where: { leadId: lead.id }, select: { completedAt: true } });
      return !!c?.completedAt;
    }
    case 'obObmChecklist': {
      const c = await prisma.oBOBMChecklist.findUnique({ where: { leadId: lead.id }, select: { completedAt: true } });
      return !!c?.completedAt;
    }
    case 'file': {
      const fileRecord = await prisma.leadFile.findFirst({
        where: leadFileWhere(lead.id, expandFileTypes(r.fileType)),
        select: { id: true },
      });
      // Backward-compat: floor plan field on the lead also satisfies FLOOR_PLAN check
      return !!fileRecord || (r.fileType === 'FLOOR_PLAN' && hasValue(lead.floorPlanUrl));
    }
    case 'fileAnyOf': {
      const fileRecord = await prisma.leadFile.findFirst({
        where: leadFileWhere(lead.id, r.fileTypes.flatMap(expandFileTypes)),
        select: { id: true },
      });
      return !!fileRecord;
    }
  }
  return false;
}

export interface StageCheckResult {
  ok: boolean;
  missing: string[];
  /** Per-requirement satisfaction, in the same order as configured, so UI can show which specific items are met vs. missing.
   * `type` mirrors the requirement's config type (or 'intent' for the intent-rating gate) so callers can decide how to act on
   * an unmet item — e.g. deep-link to the PD→OB / OBM→DIP checklist rather than just showing text. */
  details: { label: string; satisfied: boolean; type: string }[];
  /** True when the rules say a gap on this move only warns (the move still goes ahead). */
  warnOnly: boolean;
}

/**
 * Evaluate whether a lead satisfies the requirements for a stage transition.
 * `lead` must include `id` and should reflect any field changes being applied
 * in the same request (so a user can set a required field and change stage in
 * one update). `rules` defaults to the effective (admin-saved or default) rules.
 */
export async function checkStageRequirements(
  lead: Record<string, any>,
  fromStage: string,
  toStage: string,
  rules?: StageRulesConfig,
): Promise<StageCheckResult> {
  const effective = rules ?? await getEffectiveStageRules();
  const fromIdx = FUNNEL_ORDER.indexOf(fromStage as (typeof FUNNEL_ORDER)[number]);
  const toIdx = FUNNEL_ORDER.indexOf(toStage as (typeof FUNNEL_ORDER)[number]);

  const missing: string[] = [];
  const details: { label: string; satisfied: boolean; type: string }[] = [];
  for (const r of requirementsForMove(lead, fromStage, toStage, effective)) {
    const satisfied = await isRequirementMet(r, lead);
    if (!satisfied) missing.push(r.label);
    details.push({ label: r.label, satisfied, type: r.type });
  }

  // Intent-rating=1 ("no action planned") gate — scoped to the MQL→DQL
  // qualification decision only: a lead that has already been qualified past
  // MQL has, by definition, had action taken on it, so re-checking this rating
  // on every later hop only left leads looking permanently "stuck". The gate
  // the founder's spec cares about is the qualification decision itself.
  if (fromStage === 'MQL' && toIdx > fromIdx && lead.intentRating === 1) {
    const label = 'Intent rating is 1★ (no action planned) — update the lead\'s intent rating before qualifying past MQL';
    missing.push(label);
    details.push({ label, satisfied: false, type: 'intent' });
  }

  return { ok: missing.length === 0, missing, details, warnOnly: isWarnOnly(toStage, effective) };
}

/** File-type requirements for one Files-tab folder: the items on the edge out of `stage`. */
export function fileRequirementsForFolder(stage: string, rules: StageRulesConfig): RuleItem[] {
  const edge = FUNNEL_EDGES.find((e) => e.startsWith(`${stage}->`));
  return ((edge && rules.transitions[edge]) || []).filter((r) => r.type === 'file' || r.type === 'fileAnyOf' || r.type === 'quote');
}
