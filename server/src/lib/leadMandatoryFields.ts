/**
 * Canonical mandatory project-detail fields a lead must have before it can be
 * promoted out of EFFECTIVE_LEAD into MQL (the funnel's real starting point).
 *
 * This is the same list the primary `POST /api/leads` form has always
 * required (name/phone/source have their own dedicated checks per route, so
 * they're intentionally not part of this list). Every lead-creation path that
 * decides whether a new lead is complete enough for MQL must import this
 * list rather than inventing its own copy — see stageRequirements.ts, which
 * documents EL→MQL as "enforced at lead creation, no runtime gate needed
 * here" and assumes this exact list is what performs that enforcement.
 */
export const LEAD_MQL_MANDATORY_FIELDS = ['projectType', 'scope', 'location', 'possessionTimeline'] as const;

export type LeadMqlMandatoryField = (typeof LEAD_MQL_MANDATORY_FIELDS)[number];

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

/** True when every MQL-mandatory field is present on the candidate lead data. */
export function hasAllMqlMandatoryFields(
  data: Partial<Record<LeadMqlMandatoryField, unknown>>,
): boolean {
  return LEAD_MQL_MANDATORY_FIELDS.every((f) => hasValue(data[f]));
}

/** Which MQL-mandatory fields are missing — useful for logging/diagnostics. */
export function missingMqlMandatoryFields(
  data: Partial<Record<LeadMqlMandatoryField, unknown>>,
): LeadMqlMandatoryField[] {
  return LEAD_MQL_MANDATORY_FIELDS.filter((f) => !hasValue(data[f]));
}
