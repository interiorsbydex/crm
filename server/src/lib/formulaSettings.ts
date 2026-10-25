/**
 * Formulas (Admin → Formulas): the numbers behind medals, scores, the booking
 * forecast and contact health. Defaults are the original formulas.
 *
 * Booking value itself (what counts as a booking and its amount) is not here:
 * it follows the completed OBM → DIP checklist and the agreed target value,
 * which credits and targets depend on (client decision).
 */
import { z } from 'zod';
import { ConfigError, describeIssues, versionedConfig } from './versionedConfig.js';

export interface FormulaSettings {
  /** Monthly medal: score needed for each medal (%). */
  medals: { gold: number; silver: number; bronze: number };
  /** Sales % = booking % × bookingWeight + PO % × (100 − bookingWeight). */
  salesPctBookingWeight: number;
  /** Designer medal score = Sales % × salesWeight + Design DIP % × (100 − salesWeight). */
  designerMedalSalesWeight: number;
  /** Overall performance score: relative weight of each part (0 leaves it out). */
  performanceWeights: { conversion: number; targetAchievement: number; averageBookingValue: number };
  /** Intent tiers for the booking forecast and pipeline potential (stars). */
  intentTiers: { highFrom: number; mediumFrom: number };
  /** Contact health: days without completed contact before amber / red. */
  contactHealth: { warningDays: number; highRiskDays: number };
  /** Client Health page: % of details filled for Healthy / At Risk (below = Critical). */
  completeness: { healthyFrom: number; atRiskFrom: number };
  /** Reports: an onboarding this many days after MQL or sooner counts as fast. */
  fastOnboardingDays: number;
  /** Reports: an active lead with no completed activity for more than this many days. */
  noActivityDays: number;
}

export function defaultFormulas(): FormulaSettings {
  return {
    medals: { gold: 100, silver: 90, bronze: 80 },
    salesPctBookingWeight: 50,
    designerMedalSalesWeight: 50,
    performanceWeights: { conversion: 1, targetAchievement: 1, averageBookingValue: 1 },
    intentTiers: { highFrom: 4, mediumFrom: 3 },
    contactHealth: { warningDays: 3, highRiskDays: 7 },
    completeness: { healthyFrom: 80, atRiskFrom: 50 },
    fastOnboardingDays: 7,
    noActivityDays: 3,
  };
}

const pct = z.number().min(0, 'must be 0 to 200').max(200, 'must be 0 to 200');
const weight = z.number().int().min(0, 'weights are 0 to 100').max(100, 'weights are 0 to 100');
const schema = z.object({
  medals: z.object({ gold: pct, silver: pct, bronze: pct }).strict(),
  salesPctBookingWeight: weight,
  designerMedalSalesWeight: weight,
  performanceWeights: z.object({ conversion: z.number().int().min(0).max(10), targetAchievement: z.number().int().min(0).max(10), averageBookingValue: z.number().int().min(0).max(10) }).strict(),
  intentTiers: z.object({ highFrom: z.number().int().min(1).max(5), mediumFrom: z.number().int().min(1).max(5) }).strict(),
  contactHealth: z.object({ warningDays: z.number().int().min(1).max(60), highRiskDays: z.number().int().min(1).max(120) }).strict(),
  completeness: z.object({ healthyFrom: z.number().int().min(1).max(100), atRiskFrom: z.number().int().min(0).max(100) }).strict(),
  fastOnboardingDays: z.number().int().min(1).max(365),
  noActivityDays: z.number().int().min(1).max(90),
}).strict();

export const formulaSettingsConfig = versionedConfig<FormulaSettings>({
  key: 'formulas_v1',
  action: 'FORMULAS',
  noun: 'the formulas',
  defaults: defaultFormulas,
  merge: (saved) => {
    const d = defaultFormulas();
    return {
      ...d, ...(saved ?? {}),
      medals: { ...d.medals, ...saved?.medals },
      performanceWeights: { ...d.performanceWeights, ...saved?.performanceWeights },
      intentTiers: { ...d.intentTiers, ...saved?.intentTiers },
      contactHealth: { ...d.contactHealth, ...saved?.contactHealth },
      completeness: { ...d.completeness, ...saved?.completeness },
    };
  },
  validate: (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(400, 'The formulas could not be saved', describeIssues(parsed.error.issues, {
        medals: 'Medals', salesPctBookingWeight: 'Sales %', designerMedalSalesWeight: 'Designer medal score',
        performanceWeights: 'Performance score', intentTiers: 'Intent tiers', contactHealth: 'Contact health',
        completeness: 'Client health', fastOnboardingDays: 'Fast onboarding', noActivityDays: 'No activity',
      }));
    }
    const f = parsed.data;
    const problems: string[] = [];
    if (!(f.medals.gold >= f.medals.silver && f.medals.silver >= f.medals.bronze)) problems.push('Medals: Gold must need at least as much as Silver, and Silver at least as much as Bronze');
    if (f.performanceWeights.conversion + f.performanceWeights.targetAchievement + f.performanceWeights.averageBookingValue === 0) problems.push('Performance score: at least one part needs a weight above 0');
    if (f.intentTiers.mediumFrom > f.intentTiers.highFrom) problems.push('Intent tiers: medium intent must start at or below high intent');
    if (f.completeness.atRiskFrom >= f.completeness.healthyFrom) problems.push('Client health: "At Risk" must start below "Healthy"');
    if (f.contactHealth.warningDays >= f.contactHealth.highRiskDays) problems.push('Contact health: the red (high risk) day count must be higher than the amber one');
    if (problems.length) throw new ConfigError(400, 'The formulas could not be saved', problems);
    return f;
  },
});

export async function getFormulas(): Promise<FormulaSettings> {
  return formulaSettingsConfig.get().catch(() => defaultFormulas());
}

/** Medal for a score under these formulas (null = no medal). */
export function medalFor(score: number | null, f: FormulaSettings): 'GOLD' | 'SILVER' | 'BRONZE' | null {
  if (score == null) return null;
  if (score >= f.medals.gold) return 'GOLD';
  if (score >= f.medals.silver) return 'SILVER';
  if (score >= f.medals.bronze) return 'BRONZE';
  return null;
}

/** Weighted mix of two percentages, `weightA` (0–100) going to `a`. */
export function blend(a: number, b: number, weightA: number): number {
  return +((a * weightA + b * (100 - weightA)) / 100).toFixed(1);
}
