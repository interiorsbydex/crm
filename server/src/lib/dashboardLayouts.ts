/**
 * Dashboards (Admin → Dashboards): for each role's dashboard, which tiles are
 * hidden, the order of tiles within each section, and renamed tile titles.
 * The list of tiles itself lives with the screens (client/src/lib/dashboardTiles.ts);
 * the server stores and checks the choices. With nothing saved, every tile
 * shows in its original order and name.
 */
import { z } from 'zod';
import { ConfigError, describeIssues, versionedConfig } from './versionedConfig.js';

export const DASHBOARDS = ['bh', 'bl', 'blTeam', 'designer', 'cre'] as const;
export type DashboardKey = (typeof DASHBOARDS)[number];

export interface DashboardLayout { order: string[]; hidden: string[]; labels: Record<string, string> }
export type DashboardLayouts = Record<DashboardKey, DashboardLayout>;

const empty = (): DashboardLayout => ({ order: [], hidden: [], labels: {} });
export function defaultDashboardLayouts(): DashboardLayouts {
  return Object.fromEntries(DASHBOARDS.map((d) => [d, empty()])) as DashboardLayouts;
}

const tileId = z.string().regex(/^[a-zA-Z]+\.[a-zA-Z0-9]+$/, 'is not a tile');
const layoutSchema = z.object({
  order: z.array(tileId).max(200),
  hidden: z.array(tileId).max(200),
  labels: z.record(tileId, z.string().trim().min(1, 'a tile name cannot be empty').max(60, 'tile names are limited to 60 characters')),
}).strict();

export const dashboardLayoutsConfig = versionedConfig<DashboardLayouts>({
  key: 'dashboards_v1',
  action: 'DASHBOARDS',
  noun: 'the dashboards',
  defaults: defaultDashboardLayouts,
  merge: (saved) => ({ ...defaultDashboardLayouts(), ...(saved ?? {}) }),
  validate: (raw) => {
    const parsed = z.object(Object.fromEntries(DASHBOARDS.map((d) => [d, layoutSchema.optional()]))).strict().safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(400, 'The dashboards could not be saved', describeIssues(parsed.error.issues, {
        bh: 'Branch Head dashboard', bl: 'Business Lead dashboard', blTeam: 'BL team panel', designer: 'Designer dashboard', cre: 'CRE dashboard',
      }));
    }
    return { ...defaultDashboardLayouts(), ...parsed.data } as DashboardLayouts;
  },
});
