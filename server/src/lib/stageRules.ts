/**
 * Admin editing of the stage-movement rules (Admin → Stage Rules).
 *
 * The engine itself lives in config/stageRequirements.ts; this module checks
 * what an admin submits, saves it (with a revision number so two admins can't
 * silently overwrite each other), records every change in the activity log
 * for the change history, and previews a change's effect on live leads.
 */
import { z } from 'zod';
import { prisma } from './prisma.js';
import { logActivity } from './activityLog.js';
import {
  FUNNEL_EDGES,
  FUNNEL_ORDER,
  SKIPPABLE_CANDIDATES,
  SKIP_FLAG_BY_STAGE,
  STAGE_RULES_CONFIG_KEY,
  WARNABLE_TARGETS,
  defaultStageRules,
  getEffectiveStageRules,
  isLockedRequirement,
  isRequirementMet,
  requirementsForMove,
  withLockedItems,
  type RuleItem,
  type StageRulesConfig,
} from '../config/stageRequirements.js';
import { getDocumentTypes } from './documentTypes.js';

export const STAGE_RULES_ACTIONS = ['STAGE_RULES_UPDATED', 'STAGE_RULES_RESET'] as const;

/** Lead fields an admin can make mandatory, with the names Annie sees. */
export const RULE_FIELD_OPTIONS: { field: string; label: string }[] = [
  { field: 'estimatedValue', label: 'Project value' },
  { field: 'expectedObDate', label: 'Expected OB date' },
  { field: 'intentRating', label: 'Intent rating' },
  { field: 'projectType', label: 'Project type' },
  { field: 'scope', label: 'Scope' },
  { field: 'location', label: 'Location' },
  { field: 'builder', label: 'Builder' },
  { field: 'source', label: 'Lead source' },
  { field: 'possessionTimeline', label: 'Possession timeline' },
  { field: 'expectedMoveIn', label: 'Expected move-in date' },
  { field: 'nextMeetingDate', label: 'Next meeting date' },
  { field: 'email', label: 'Client email' },
  { field: 'floorPlanUrl', label: 'Floor plan link (legacy)' },
];

export const RULE_MEETING_OPTIONS: { meetingType: string; label: string }[] = [
  { meetingType: 'DQL', label: 'DQL meeting' },
  { meetingType: 'PP', label: 'PP meeting' },
  { meetingType: 'PD', label: 'PD (Pitch Discussion) meeting' },
  { meetingType: 'OBM', label: 'Onboarding meeting (OBM)' },
  { meetingType: 'ONBOARDING', label: 'Onboarding meeting (old type)' },
];
const MEETING_TYPES = RULE_MEETING_OPTIONS.map((m) => m.meetingType) as [string, ...string[]];

const STAGE_VALUES = ['EFFECTIVE_LEAD', ...FUNNEL_ORDER, 'HANDED_OVER'] as [string, ...string[]];

const base = {
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1, 'Every requirement needs a message for the designer').max(200, 'Messages are limited to 200 characters'),
  whenSkipped: z.enum(['required', 'waived', 'owedLater']),
};
const status = z.enum(['scheduled', 'completed']).optional();

const itemSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('field'), field: z.enum(RULE_FIELD_OPTIONS.map((f) => f.field) as [string, ...string[]]) }).strict(),
  z.object({ ...base, type: z.literal('customField'), key: z.string().trim().min(1).max(80) }).strict(),
  z.object({ ...base, type: z.literal('meeting'), meetingType: z.enum(MEETING_TYPES), status }).strict(),
  z.object({ ...base, type: z.literal('meetingOrCall'), meetingType: z.enum(MEETING_TYPES) }).strict(),
  z.object({ ...base, type: z.literal('meetingAnyOf'), meetingTypes: z.array(z.enum(MEETING_TYPES)).min(1), status }).strict(),
  z.object({ ...base, type: z.literal('quote'), stages: z.array(z.enum(STAGE_VALUES)).default([]), fileTypes: z.array(z.string()).optional() }).strict(),
  z.object({ ...base, type: z.literal('file'), fileType: z.string().min(1), stages: z.array(z.enum(STAGE_VALUES)).default([]) }).strict(),
  z.object({ ...base, type: z.literal('fileAnyOf'), fileTypes: z.array(z.string().min(1)).min(1).max(20), stages: z.array(z.enum(STAGE_VALUES)).default([]) }).strict(),
]);

const configSchema = z.object({
  transitions: z.record(z.string(), z.array(z.unknown()).max(30, 'At most 30 requirements per stage move')),
  skippableStages: z.array(z.enum(SKIPPABLE_CANDIDATES as [string, ...string[]])),
  allowMqlToOnboarding: z.boolean(),
  enforcement: z.record(z.enum(WARNABLE_TARGETS as [string, ...string[]]), z.enum(['block', 'warn'])),
}).strict();

export class StageRulesError extends Error {
  constructor(public status: number, message: string, public problems: string[] = []) { super(message); }
}

const edgeName = (edge: string) => edge.replace('->', ' → ');

/**
 * Check an admin-submitted config and return the cleaned copy that will be
 * saved. Checklist-backed items are ignored here and always re-attached from
 * the defaults (see withLockedItems). Throws StageRulesError listing every
 * problem in plain words.
 */
export async function validateStageRules(raw: unknown): Promise<StageRulesConfig> {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StageRulesError(400, 'The stage rules could not be saved', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const [docTypes, customFields] = await Promise.all([
    getDocumentTypes(),
    prisma.customFieldDefinition.findMany({ where: { isActive: true }, select: { key: true } }),
  ]);
  const activeDocKeys = new Set(docTypes.filter((t) => t.active).map((t) => t.key));
  const fieldKeys = new Set(customFields.map((f) => f.key));

  const problems: string[] = [];
  const transitions: Record<string, RuleItem[]> = {};
  for (const key of Object.keys(parsed.data.transitions)) {
    if (!FUNNEL_EDGES.includes(key)) problems.push(`Unknown stage move "${key}"`);
  }
  for (const edge of FUNNEL_EDGES) {
    const toStage = edge.split('->')[1];
    const items: RuleItem[] = [];
    const ids = new Set<string>();
    const labels = new Set<string>();
    for (const [i, rawItem] of (parsed.data.transitions[edge] ?? []).entries()) {
      if (rawItem && typeof rawItem === 'object' && isLockedRequirement(rawItem as { type: string })) {
        // Kept only as a position marker; withLockedItems restores the original.
        items.push({ type: (rawItem as { type: string }).type } as RuleItem);
        continue;
      }
      const res = itemSchema.safeParse(rawItem);
      const where = `${edgeName(edge)}, requirement ${i + 1}`;
      if (!res.success) {
        problems.push(...res.error.issues.map((iss) => `${where}: ${iss.path.length ? `${iss.path.join('.')} — ` : ''}${iss.message}`));
        continue;
      }
      const item = res.data as RuleItem;
      if (ids.has(item.id)) problems.push(`${where}: duplicate id`);
      ids.add(item.id);
      if (labels.has(item.label.toLowerCase())) problems.push(`${where}: the message "${item.label}" is used twice on this move`);
      labels.add(item.label.toLowerCase());
      if (item.whenSkipped === 'owedLater' && !SKIP_FLAG_BY_STAGE[toStage]) {
        problems.push(`${where}: "still owed later" is only possible on moves into DQL, Proposal Ready or PD`);
      }
      const docKeys = item.type === 'file' ? [item.fileType] : item.type === 'fileAnyOf' ? item.fileTypes : item.type === 'quote' ? item.fileTypes ?? [] : [];
      for (const k of docKeys) if (!activeDocKeys.has(k)) problems.push(`${where}: unknown or switched-off document type "${k}"`);
      if (item.type === 'customField' && !fieldKeys.has(item.key)) problems.push(`${where}: unknown or switched-off custom field "${item.key}"`);
      items.push(item);
    }
    transitions[edge] = items;
  }
  if (problems.length) throw new StageRulesError(400, 'The stage rules could not be saved', problems);

  const enforcement: StageRulesConfig['enforcement'] = {};
  for (const stage of WARNABLE_TARGETS) enforcement[stage] = parsed.data.enforcement[stage] ?? 'block';
  return withLockedItems({
    transitions,
    skippableStages: SKIPPABLE_CANDIDATES.filter((s) => parsed.data.skippableStages.includes(s)),
    allowMqlToOnboarding: parsed.data.allowMqlToOnboarding,
    enforcement,
  });
}

interface StoredStageRules {
  config: StageRulesConfig;
  revision: number;
  updatedAt: string;
  updatedById: string;
}

export async function loadStageRulesState() {
  const row = await prisma.assignmentConfig.findUnique({ where: { key: STAGE_RULES_CONFIG_KEY } });
  const stored = row?.value as StoredStageRules | null | undefined;
  const updatedBy = stored?.updatedById
    ? await prisma.user.findUnique({ where: { id: stored.updatedById }, select: { name: true } })
    : null;
  return {
    config: await getEffectiveStageRules(),
    isDefault: !stored,
    revision: stored?.revision ?? 0,
    updatedAt: stored?.updatedAt ?? null,
    updatedByName: updatedBy?.name ?? null,
  };
}

/** Save a new version. `expectedRevision` must match what the admin loaded, or nothing is saved (409). */
export async function saveStageRules(raw: unknown, expectedRevision: unknown, userId: string, note?: string) {
  const config = await validateStageRules(raw);
  return prisma.$transaction(async (tx) => {
    const row = await tx.assignmentConfig.findUnique({ where: { key: STAGE_RULES_CONFIG_KEY } });
    const current = (row?.value as StoredStageRules | null)?.revision ?? 0;
    if (expectedRevision !== current) {
      throw new StageRulesError(409, 'Someone else saved the stage rules since you opened this page. Reload to see their changes, then make yours again.');
    }
    const value: StoredStageRules = { config, revision: current + 1, updatedAt: new Date().toISOString(), updatedById: userId };
    await tx.assignmentConfig.upsert({
      where: { key: STAGE_RULES_CONFIG_KEY },
      create: { key: STAGE_RULES_CONFIG_KEY, value: value as any },
      update: { value: value as any },
    });
    await tx.activityLog.create({
      data: { userId, action: 'STAGE_RULES_UPDATED', meta: { revision: value.revision, config, ...(note && { note: note.slice(0, 300) }) } as any },
    });
    return value;
  });
}

/** Go back to the shipped rules. The previous version stays in the change history. */
export async function resetStageRules(userId: string) {
  await prisma.assignmentConfig.deleteMany({ where: { key: STAGE_RULES_CONFIG_KEY } });
  await logActivity(userId, 'STAGE_RULES_RESET', undefined, { config: defaultStageRules() });
}

export async function stageRulesHistory(limit = 30) {
  const rows = await prisma.activityLog.findMany({
    where: { action: { in: [...STAGE_RULES_ACTIONS] }, leadId: null },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, action: true, createdAt: true, meta: true, user: { select: { name: true } } },
  });
  return rows.map((r) => {
    const meta = (r.meta ?? {}) as { revision?: number; note?: string; config?: StageRulesConfig };
    return {
      id: r.id,
      action: r.action,
      createdAt: r.createdAt,
      byName: r.user?.name ?? 'Unknown',
      revision: meta.revision ?? null,
      note: meta.note ?? null,
      config: meta.config ?? null,
    };
  });
}

export interface ImpactRow {
  stage: string;
  nextStage: string;
  leads: number;
  /** Leads whose next move would newly be held up (blocked, or warned if the move only warns). */
  newlyHeldUp: number;
  /** Leads whose next move would no longer be held up. */
  newlyClear: number;
  examples: string[];
}

/**
 * How a proposed config changes the NEXT stage move for active leads, compared
 * with the rules in force now. Read-only.
 */
export async function previewStageRulesImpact(raw: unknown): Promise<{ rows: ImpactRow[]; leadsChecked: number; truncated: boolean }> {
  const proposed = await validateStageRules(raw);
  const current = await getEffectiveStageRules();
  const LIMIT = 2000;
  const leads = await prisma.lead.findMany({
    where: { status: 'ACTIVE', isTestLead: false, stage: { in: FUNNEL_ORDER.slice(0, -1) as any } },
    take: LIMIT + 1,
  });
  const truncated = leads.length > LIMIT;
  const rows = new Map<string, ImpactRow>();
  for (const lead of leads.slice(0, LIMIT)) {
    const idx = FUNNEL_ORDER.indexOf(lead.stage as (typeof FUNNEL_ORDER)[number]);
    const next = FUNNEL_ORDER[idx + 1];
    const row = rows.get(lead.stage) ?? { stage: lead.stage, nextStage: next, leads: 0, newlyHeldUp: 0, newlyClear: 0, examples: [] };
    row.leads++;
    const cache = new Map<string, boolean>();
    const gaps = async (rules: StageRulesConfig) => {
      for (const r of requirementsForMove(lead, lead.stage, next, rules)) {
        const { id: _id, label: _label, whenSkipped: _w, locked: _l, ...req } = r;
        const k = JSON.stringify(req);
        if (!cache.has(k)) cache.set(k, await isRequirementMet(r, lead));
        if (!cache.get(k)) return true;
      }
      return false;
    };
    const [before, after] = [await gaps(current), await gaps(proposed)];
    if (!before && after) { row.newlyHeldUp++; if (row.examples.length < 5) row.examples.push(lead.leadId); }
    if (before && !after) row.newlyClear++;
    rows.set(lead.stage, row);
  }
  return {
    rows: FUNNEL_ORDER.map((s) => rows.get(s)).filter((r): r is ImpactRow => !!r),
    leadsChecked: Math.min(leads.length, LIMIT),
    truncated,
  };
}
