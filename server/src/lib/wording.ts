/**
 * Wording (Admin → Wording): screen labels the client can reword without a
 * developer. Checklist items are renamed in Admin → Checklists and stage
 * names in CRM Settings; this covers the other labels that matter.
 * Shown before sign-in too (the app name), so nothing here may be private.
 */
import { z } from 'zod';
import { ConfigError, plainMessage, versionedConfig } from './versionedConfig.js';

export const WORDING_KEYS: { key: string; where: string; text: string; long?: boolean }[] = [
  { key: 'app.name', where: 'App name (sidebar)', text: 'FYX' },
  { key: 'app.fullName', where: 'App name (sign-in page and browser tab)', text: 'FYX — For Your Xperience' },
  { key: 'title.DESIGN_TEAM_LEAD', where: 'Job title shown for the Design Team Lead designation', text: 'Design Team Lead' },
  { key: 'onboarding.targetValue', where: 'PD → OB checklist: the agreed value field', text: 'Target value — total after discount, excluding GST (₹)' },
  { key: 'onboarding.targetValueHelp', where: 'PD → OB checklist: help under the agreed value', long: true,
    text: 'Updates the recorded amount used by booking reports and credits. Include furniture in this total; record the furniture breakup separately below.' },
  { key: 'dip.threadUrl', where: 'OBM → DIP checklist: link field', text: 'Internal Mail Thread URL' },
];
const KEYS = new Set(WORDING_KEYS.map((w) => w.key));

/** Only the changed labels are stored; screens fall back to the defaults above. */
export type Wording = Record<string, string>;

export const wordingConfig = versionedConfig<Wording>({
  key: 'wording_v1',
  action: 'WORDING',
  noun: 'the wording',
  defaults: () => ({}),
  merge: (saved) => Object.fromEntries(Object.entries(saved ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string')),
  validate: (raw) => {
    const parsed = z.record(z.string(), z.string().trim().min(1, 'a label cannot be empty').max(400, 'labels are limited to 400 characters')).safeParse(raw);
    if (!parsed.success) throw new ConfigError(400, 'The wording could not be saved', parsed.error.issues.map((i) => `${String(i.path[0] ?? '')}: ${plainMessage(i.message)}`));
    const unknown = Object.keys(parsed.data).filter((k) => !KEYS.has(k));
    if (unknown.length) throw new ConfigError(400, 'The wording could not be saved', unknown.map((k) => `Unknown label "${k}"`));
    const defaults = new Map(WORDING_KEYS.map((w) => [w.key, w.text]));
    return Object.fromEntries(Object.entries(parsed.data).filter(([k, v]) => v !== defaults.get(k)));
  },
});
