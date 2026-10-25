import { api } from './api';

/**
 * Meeting type names, which types can still be picked, and which details are
 * mandatory (Admin → Meetings; server: lib/meetingSettings.ts). Loaded once
 * after sign-in by Layout; the server enforces the same rules regardless.
 */
export type MeetingModeKey = 'EC_VISIT' | 'SITE_VISIT' | 'VIRTUAL' | 'PUBLIC_PLACE' | 'CLIENT_PLACE';
export interface MeetingSettings {
  modes: Record<MeetingModeKey, { label: string; stars: number; active: boolean }>;
  requireMom: boolean;
  requireRescheduleReason: boolean;
  requireNoShowReason: boolean;
}

const ORDER: MeetingModeKey[] = ['EC_VISIT', 'SITE_VISIT', 'VIRTUAL', 'PUBLIC_PLACE', 'CLIENT_PLACE'];
let current: MeetingSettings = {
  modes: {
    EC_VISIT: { label: 'EC Visit', stars: 5, active: true },
    SITE_VISIT: { label: 'Site Visit', stars: 4, active: true },
    VIRTUAL: { label: 'Virtual', stars: 3, active: true },
    PUBLIC_PLACE: { label: 'Public Place', stars: 2, active: true },
    CLIENT_PLACE: { label: "Client's Place", stars: 2, active: true },
  },
  requireMom: true,
  requireRescheduleReason: true,
  requireNoShowReason: true,
};

export async function loadMeetingSettings(): Promise<MeetingSettings> {
  current = (await api.get<{ settings: MeetingSettings }>('/config/meetings')).settings;
  return current;
}

export function meetingRules(): MeetingSettings {
  return current;
}

/** The meeting types that can be picked for a new or moved meeting. */
export function meetingModeOptions(): { value: MeetingModeKey; label: string }[] {
  return ORDER.filter((m) => current.modes[m]?.active).map((m) => ({ value: m, label: current.modes[m].label }));
}

/** Display name of any meeting type, including ones no longer in use. */
export function meetingModeLabel(mode: string | null | undefined): string {
  if (!mode) return '';
  return current.modes[mode as MeetingModeKey]?.label ?? mode;
}
