export interface LeadProgressionRow {
  stage: string;
  label: string;
  total: number;
  progressionPct: number | null;
  avgTatDays: number | null;
}

/** Presentation only: retain the report's precise TAT for its calculations. */
export function formatLeadProgressionTat(days: number | null): string {
  if (days == null || !Number.isFinite(days) || days < 0) return '—';
  if (days === 0) return '0 days';
  if (days < 1) return 'Less than 1 day';
  const rounded = Math.round(days);
  return `${rounded} ${rounded === 1 ? 'day' : 'days'}`;
}
