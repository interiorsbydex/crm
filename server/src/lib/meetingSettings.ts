/**
 * Meetings (Admin → Meetings): the name of each meeting type (mode), whether
 * it can still be picked, how many intent stars it gives the lead, and which
 * details are mandatory when a meeting is closed.
 *
 * The set of types is fixed by the database (MeetingMode); only their names,
 * availability and stars are settings. Defaults match the original rules.
 */
import { z } from 'zod';
import { ConfigError, describeIssues, versionedConfig } from './versionedConfig.js';

export const MEETING_MODES = ['EC_VISIT', 'SITE_VISIT', 'VIRTUAL', 'PUBLIC_PLACE', 'CLIENT_PLACE'] as const;
export type MeetingModeKey = (typeof MEETING_MODES)[number];

export interface ModeSetting { label: string; stars: number; active: boolean }
export interface MeetingSettings {
  modes: Record<MeetingModeKey, ModeSetting>;
  /** Minutes of meeting must be written when marking a meeting completed. */
  requireMom: boolean;
  /** A reason must be given when rescheduling. */
  requireRescheduleReason: boolean;
  /** A reason must be given when marking a no-show. */
  requireNoShowReason: boolean;
}

export function defaultMeetingSettings(): MeetingSettings {
  return {
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
}

const modeSchema = z.object({
  label: z.string().trim().min(1, 'a meeting type needs a name').max(40, 'names are limited to 40 characters'),
  stars: z.number().int().min(1, 'stars must be 1 to 5').max(5, 'stars must be 1 to 5'),
  active: z.boolean(),
}).strict();
const schema = z.object({
  modes: z.object(Object.fromEntries(MEETING_MODES.map((m) => [m, modeSchema]))).strict(),
  requireMom: z.boolean(),
  requireRescheduleReason: z.boolean(),
  requireNoShowReason: z.boolean(),
}).strict();

export const meetingSettingsConfig = versionedConfig<MeetingSettings>({
  key: 'meetings_v1',
  action: 'MEETING_SETTINGS',
  noun: 'the meeting settings',
  defaults: defaultMeetingSettings,
  merge: (saved) => {
    const d = defaultMeetingSettings();
    const modes = { ...d.modes };
    for (const m of MEETING_MODES) if (saved?.modes?.[m]) modes[m] = { ...d.modes[m], ...saved.modes[m] };
    return { ...d, ...(saved ?? {}), modes };
  },
  validate: (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(400, 'The meeting settings could not be saved', describeIssues(parsed.error.issues, Object.fromEntries(MEETING_MODES.map((m) => [m, defaultMeetingSettings().modes[m].label]))));
    }
    const data = parsed.data as MeetingSettings;
    if (!MEETING_MODES.some((m) => data.modes[m].active)) {
      throw new ConfigError(400, 'The meeting settings could not be saved', ['Keep at least one meeting type in use']);
    }
    // Two types with one name could not be told apart in the booking form.
    const seen = new Set<string>();
    for (const m of MEETING_MODES) {
      const name = data.modes[m].label.trim().toLowerCase();
      if (seen.has(name)) throw new ConfigError(400, 'The meeting settings could not be saved', [`"${data.modes[m].label.trim()}" is used by two meeting types`]);
      seen.add(name);
    }
    return data;
  },
});

export async function getMeetingSettings(): Promise<MeetingSettings> {
  return meetingSettingsConfig.get();
}

/** Stars per meeting type, for intent scoring. */
export async function getModeRatings(): Promise<Record<string, number>> {
  const { modes } = await getMeetingSettings();
  return Object.fromEntries(MEETING_MODES.map((m) => [m, modes[m].stars]));
}
