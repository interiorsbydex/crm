/**
 * Reports & NPS (Admin → Reports & NPS).
 *
 * wonStages: which stages count as "onboarded" in the Reports page's
 * conversion and trend numbers. Booking value, targets and credits are not
 * affected — those follow the completed OBM → DIP checklist (client decision).
 *
 * npsTriggers: for the Sales, Design Freeze and Sign Off surveys, the stage
 * whose arrival drafts the survey email for review (null = never automatic).
 * With nothing saved none is automatic, matching the client decision that NPS
 * goes out only from the Onboarding Meeting checklist. The Onboarding survey
 * itself always stays on that checklist.
 */
import { z } from 'zod';
import { ConfigError, describeIssues, versionedConfig } from './versionedConfig.js';

export const WON_STAGE_CHOICES = ['ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER'] as const;
export const NPS_SURVEYS = ['SALE', 'DESIGN_FREEZE', 'SIGN_OFF'] as const;
export type NpsSurvey = (typeof NPS_SURVEYS)[number];
export const NPS_SURVEY_LABELS: Record<NpsSurvey, string> = { SALE: 'Sales NPS', DESIGN_FREEZE: 'Design Freeze NPS', SIGN_OFF: 'Sign Off NPS' };
export const NPS_TRIGGER_STAGES = ['PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER'] as const;

export interface ReportDefinitions {
  wonStages: string[];
  npsTriggers: Record<NpsSurvey, string | null>;
}

export function defaultReportDefinitions(): ReportDefinitions {
  return { wonStages: ['DESIGN_IN_PROGRESS', 'HANDED_OVER'], npsTriggers: { SALE: null, DESIGN_FREEZE: null, SIGN_OFF: null } };
}

const schema = z.object({
  wonStages: z.array(z.enum(WON_STAGE_CHOICES)).min(1, 'pick at least one stage that counts as onboarded'),
  npsTriggers: z.object(Object.fromEntries(NPS_SURVEYS.map((s) => [s, z.enum(NPS_TRIGGER_STAGES).nullable()]))).strict(),
}).strict();

export const reportDefinitionsConfig = versionedConfig<ReportDefinitions>({
  key: 'report_definitions_v1',
  action: 'REPORT_DEFINITIONS',
  noun: 'the report and NPS settings',
  defaults: defaultReportDefinitions,
  merge: (saved) => {
    const d = defaultReportDefinitions();
    return { wonStages: saved?.wonStages?.length ? saved.wonStages : d.wonStages, npsTriggers: { ...d.npsTriggers, ...(saved?.npsTriggers ?? {}) } };
  },
  validate: (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(400, 'The report and NPS settings could not be saved', describeIssues(parsed.error.issues, { wonStages: 'Counts as onboarded', npsTriggers: 'NPS surveys', ...NPS_SURVEY_LABELS }));
    }
    const problems: string[] = [];
    const byStage = new Map<string, NpsSurvey>();
    for (const s of NPS_SURVEYS) {
      const stage = parsed.data.npsTriggers[s];
      if (!stage) continue;
      if (byStage.has(stage)) problems.push(`${NPS_SURVEY_LABELS[byStage.get(stage)!]} and ${NPS_SURVEY_LABELS[s]} can't both start at the same stage — the lead would get two surveys at once`);
      byStage.set(stage, s);
    }
    if (problems.length) throw new ConfigError(400, 'The report and NPS settings could not be saved', problems);
    return { wonStages: [...new Set(parsed.data.wonStages)], npsTriggers: parsed.data.npsTriggers as Record<NpsSurvey, string | null> };
  },
});

export async function getWonStages(): Promise<string[]> {
  return (await reportDefinitionsConfig.get()).wonStages;
}

/** The survey (if any) a lead arriving at `stage` should get. */
export async function npsSurveyForStage(stage: string): Promise<NpsSurvey | null> {
  const triggers = (await reportDefinitionsConfig.get()).npsTriggers;
  return NPS_SURVEYS.find((s) => triggers[s] === stage) ?? null;
}
