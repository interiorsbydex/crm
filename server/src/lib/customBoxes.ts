/**
 * Custom boxes (Admin → Custom Boxes): boxes the Branch Head builds herself and
 * puts on a role's dashboard. Each box is a menu choice, not a typed formula:
 * one measure over a filtered set of leads, optionally split into rows.
 *
 * A box only ever counts the leads the person looking at the dashboard owns
 * (the same ownership scope the dashboards use), so a designer's box shows the
 * designer's own leads and the Branch Head's shows everyone's. Test leads are
 * left out, as on the dashboards.
 */
import { z } from 'zod';
import { ConfigError, describeIssues, versionedConfig } from './versionedConfig.js';

export const BOX_MEASURES = ['count', 'totalValue', 'avgValue', 'avgAgeDays'] as const;
export type BoxMeasure = (typeof BOX_MEASURES)[number];
export const BOX_SPLITS = ['none', 'stage', 'source', 'designer', 'status'] as const;
export type BoxSplit = (typeof BOX_SPLITS)[number];
export const BOX_ROLES = ['BRANCH_HEAD', 'BL', 'DESIGNER', 'CRE'] as const;
export type BoxRole = (typeof BOX_ROLES)[number];
export const BOX_STAGES = [
  'EFFECTIVE_LEAD', 'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION',
  'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER',
] as const;
export const BOX_STATUSES = ['ACTIVE', 'ON_HOLD', 'INACTIVE'] as const;

export interface CustomBox {
  id: string;
  title: string;
  measure: BoxMeasure;
  split: BoxSplit;
  /** Only leads in these stages (empty = any stage). */
  stages: string[];
  /** Only leads with these statuses (empty = any status). */
  statuses: string[];
  /** Only leads from these sources (empty = any source). */
  sources: string[];
  /** Only leads created in the last N days (null = no limit). */
  createdWithinDays: number | null;
  /** Whose dashboard shows the box. */
  roles: BoxRole[];
}
export interface CustomBoxesConfig { boxes: CustomBox[] }

const boxSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{2,40}$/, 'the box has no valid id'),
  title: z.string().trim().min(1, 'every box needs a name').max(60, 'box names are limited to 60 characters'),
  measure: z.enum(BOX_MEASURES),
  split: z.enum(BOX_SPLITS),
  stages: z.array(z.enum(BOX_STAGES)),
  statuses: z.array(z.enum(BOX_STATUSES)),
  sources: z.array(z.string().trim().min(1).max(60)).max(30),
  createdWithinDays: z.number().int('days must be a whole number').min(1, 'days must be at least 1').max(3650, 'days can be at most 3650').nullable(),
  roles: z.array(z.enum(BOX_ROLES)).min(1, 'pick at least one dashboard'),
}).strict();
const schema = z.object({ boxes: z.array(boxSchema).max(20, 'at most 20 boxes') }).strict();

export const customBoxesConfig = versionedConfig<CustomBoxesConfig>({
  key: 'custom_boxes_v1',
  action: 'CUSTOM_BOXES',
  noun: 'the custom boxes',
  defaults: () => ({ boxes: [] }),
  merge: (saved) => ({ boxes: saved?.boxes ?? [] }),
  validate: (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ConfigError(400, 'The custom boxes could not be saved', describeIssues(parsed.error.issues, {}));
    const data = parsed.data as CustomBoxesConfig;
    const problems: string[] = [];
    const titles = new Set<string>();
    const ids = new Set<string>();
    for (const b of data.boxes) {
      const t = b.title.trim().toLowerCase();
      if (titles.has(t)) problems.push(`"${b.title.trim()}" is used by two boxes`);
      titles.add(t);
      if (ids.has(b.id)) problems.push(`Two boxes share one id (${b.id})`);
      ids.add(b.id);
    }
    if (problems.length) throw new ConfigError(400, 'The custom boxes could not be saved', problems);
    return data;
  },
});

export interface BoxLead {
  stage: string;
  status: string;
  source: string | null;
  estimatedValue: number | null;
  createdAt: Date;
  designerName: string | null;
}
export type BoxResult =
  | { id: string; title: string; measure: BoxMeasure; split: 'none'; value: number | null }
  | { id: string; title: string; measure: BoxMeasure; split: Exclude<BoxSplit, 'none'>; rows: { key: string; value: number | null; leads: number }[] };

/** The dashboard's role key for a signed-in role (admins see the Branch Head's). */
export function boxRoleFor(role: string): BoxRole | null {
  if (role === 'ADMIN') return 'BRANCH_HEAD';
  return (BOX_ROLES as readonly string[]).includes(role) ? (role as BoxRole) : null;
}

/** Narrow a lead set to what the box's filters allow. */
export function filterLeads(box: CustomBox, leads: BoxLead[], now = new Date()): BoxLead[] {
  const since = box.createdWithinDays ? now.getTime() - box.createdWithinDays * 86_400_000 : null;
  return leads.filter((l) =>
    (!box.stages.length || box.stages.includes(l.stage))
    && (!box.statuses.length || box.statuses.includes(l.status))
    && (!box.sources.length || (l.source != null && box.sources.includes(l.source)))
    && (since === null || l.createdAt.getTime() >= since));
}

function measureOf(measure: BoxMeasure, leads: BoxLead[], now: Date): number | null {
  if (measure === 'count') return leads.length;
  if (!leads.length) return null;
  if (measure === 'avgAgeDays') {
    return Math.round((leads.reduce((s, l) => s + (now.getTime() - l.createdAt.getTime()) / 86_400_000, 0) / leads.length) * 10) / 10;
  }
  const withValue = leads.filter((l) => l.estimatedValue != null);
  const total = withValue.reduce((s, l) => s + (l.estimatedValue ?? 0), 0);
  if (measure === 'totalValue') return total;
  return withValue.length ? Math.round(total / withValue.length) : null;
}

export function computeBox(box: CustomBox, allLeads: BoxLead[], now = new Date()): BoxResult {
  const leads = filterLeads(box, allLeads, now);
  const head = { id: box.id, title: box.title, measure: box.measure };
  if (box.split === 'none') return { ...head, split: 'none', value: measureOf(box.measure, leads, now) };
  const keyOf = (l: BoxLead) => (box.split === 'stage' ? l.stage : box.split === 'source' ? (l.source ?? 'Not set') : box.split === 'designer' ? (l.designerName ?? 'Not assigned') : l.status);
  const groups = new Map<string, BoxLead[]>();
  for (const l of leads) groups.set(keyOf(l), [...(groups.get(keyOf(l)) ?? []), l]);
  const rows = [...groups.entries()]
    .map(([key, ls]) => ({ key, value: measureOf(box.measure, ls, now), leads: ls.length }))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  return { ...head, split: box.split, rows };
}
