import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Admin → CRM Settings (server: lib/crmSettings.ts): the dropdown lists, stage
 * names and simple numbers every screen uses. Loaded once after sign-in by
 * <CrmSettingsGate> in Layout, cached here, and refreshed when an admin saves.
 */
export interface CrmSettings {
  cities: { name: string; areas: string[] }[];
  leadSources: { value: string; label: string; active: boolean }[];
  onHoldReasons: string[];
  inactiveReasons: string[];
  reactivationReasons: string[];
  flagCategories: string[];
  leadCreateRequired: string[];
  discount: { selfApproveUpToPct: number; blApproveUpToPct: number; branchHeadUpToPct: number; woodworkSpecialCaseBelow: number };
  reminderMinutesBefore: number;
  weeklyDigestDay: number;
  designPhaseDays: Record<string, number>;
  designOverallDays: number;
  stageLabels: Record<string, string>;
  hiddenStages: string[];
}

/** Used only until the server copy arrives (or if it can't be loaded). */
const FALLBACK: CrmSettings = {
  cities: [],
  leadSources: [['META_ADS', 'Meta Ads'], ['GOOGLE_ADS', 'Google Ads'], ['REFERRAL', 'Referral'], ['WALK_IN', 'Walk-in'], ['ORGANIC', 'Organic'], ['OTHER', 'Other']]
    .map(([value, label]) => ({ value, label, active: true })),
  onHoldReasons: [],
  inactiveReasons: [],
  reactivationReasons: [],
  flagCategories: [],
  leadCreateRequired: ['projectType', 'scope', 'location', 'possessionTimeline'],
  discount: { selfApproveUpToPct: 10, blApproveUpToPct: 15, branchHeadUpToPct: 20, woodworkSpecialCaseBelow: 500_000 },
  reminderMinutesBefore: 60,
  weeklyDigestDay: 2,
  designPhaseDays: {},
  designOverallDays: 45,
  stageLabels: {
    EFFECTIVE_LEAD: 'Effective Lead', MQL: 'MQL', DQL: 'DQL', PROPOSAL_READY: 'Proposal Ready',
    PROPOSAL_PRESENTED: 'Proposal Presented', PROPOSAL_DISCUSSION: 'PD (Pitch Discussion)',
    ONBOARDING: 'Onboarding', ONBOARDING_MEETING: 'Onboarding Meeting',
    DESIGN_IN_PROGRESS: 'Design in Progress', HANDED_OVER: 'Handed Over',
  },
  hiddenStages: [],
};

let current: CrmSettings = FALLBACK;
let loaded = false;
let inflight: Promise<CrmSettings> | null = null;
const listeners = new Set<(s: CrmSettings) => void>();

export function loadCrmSettings(force = false): Promise<CrmSettings> {
  if (loaded && !force) return Promise.resolve(current);
  if (!inflight) {
    inflight = api.get<{ settings: CrmSettings }>('/config/crm-settings')
      .then(({ settings }) => {
        current = settings;
        loaded = true;
        listeners.forEach((fn) => fn(settings));
        return settings;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** The settings as currently loaded (for code outside React components). */
export function crmSettings(): CrmSettings {
  return current;
}

/** React hook: the current settings, re-rendering when an admin saves new ones. */
export function useCrmSettings(): CrmSettings {
  const [s, setS] = useState(current);
  useEffect(() => {
    listeners.add(setS);
    if (!loaded) loadCrmSettings().catch(() => {});
    else setS(current);
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}

/** Former stage values that only appear on historical records. */
const LEGACY_STAGE_LABELS: Record<string, string> = { INACTIVE: 'Inactive', ON_HOLD: 'On Hold' };

/** A stage's display name, e.g. stageLabel('PROPOSAL_DISCUSSION') → 'PD (Pitch Discussion)'. */
export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return '';
  return current.stageLabels[stage] ?? FALLBACK.stageLabels[stage] ?? LEGACY_STAGE_LABELS[stage] ?? stage.replace(/_/g, ' ');
}

/**
 * For space-constrained places (chart axes) that use their own short form:
 * the short form, unless the admin has renamed the stage — then the new name.
 */
export function stageShortLabel(stage: string, short: string | undefined): string {
  const renamed = current.stageLabels[stage] && current.stageLabels[stage] !== FALLBACK.stageLabels[stage];
  return renamed ? current.stageLabels[stage] : short ?? stageLabel(stage);
}

/** Display name for a stored lead source, whether saved as a code (META_ADS) or a name ("Meta Ads"). */
export function sourceLabel(source: string | null | undefined): string {
  if (!source) return '';
  const match = current.leadSources.find((s) => s.value === source || s.label.toLowerCase() === source.toLowerCase());
  return match?.label ?? source.replace(/_/g, ' ');
}

/** The code a stored source corresponds to, or '' if it matches no listed source. */
export function sourceValue(source: string | null | undefined): string {
  if (!source) return '';
  return current.leadSources.find((s) => s.value === source || s.label.toLowerCase() === source.toLowerCase())?.value ?? '';
}
