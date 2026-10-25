import { api } from './api';

/**
 * Numbers behind medals, scores, the booking forecast and health labels
 * (Admin → Formulas; server: lib/formulaSettings.ts). Loaded once after
 * sign-in by Layout so labels on screen match what the server calculates.
 */
export interface Formulas {
  medals: { gold: number; silver: number; bronze: number };
  salesPctBookingWeight: number;
  designerMedalSalesWeight: number;
  performanceWeights: { conversion: number; targetAchievement: number; averageBookingValue: number };
  intentTiers: { highFrom: number; mediumFrom: number };
  contactHealth: { warningDays: number; highRiskDays: number };
  completeness: { healthyFrom: number; atRiskFrom: number };
  fastOnboardingDays: number;
  noActivityDays: number;
}

let current: Formulas = {
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

export async function loadFormulas(): Promise<Formulas> {
  current = (await api.get<{ formulas: Formulas }>('/config/formulas')).formulas;
  return current;
}

export function formulas(): Formulas {
  return current;
}
