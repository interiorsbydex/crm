import { getCrmSettings } from './crmSettings.js';

/**
 * The project details a lead must have before it counts as MQL (the funnel's
 * real starting point) — Admin → CRM Settings → "Details needed for a new
 * lead". Defaults to projectType, scope, location and possessionTimeline.
 *
 * The primary `POST /api/leads` form requires exactly these (plus name, phone
 * and source, which have their own checks per route), and every other
 * lead-creation path (webhooks, manual capture) uses the same list to decide
 * between MQL and Effective Lead — see stageRequirements.ts, which documents
 * EL→MQL as "enforced at lead creation, no runtime gate needed here".
 */
export async function getLeadMqlMandatoryFields(): Promise<string[]> {
  return (await getCrmSettings()).leadCreateRequired;
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

/** True when every MQL-mandatory field is present on the candidate lead data. */
export async function hasAllMqlMandatoryFields(data: Record<string, unknown>): Promise<boolean> {
  return (await getLeadMqlMandatoryFields()).every((f) => hasValue(data[f]));
}

/** Which MQL-mandatory fields are missing — useful for logging/diagnostics. */
export async function missingMqlMandatoryFields(data: Record<string, unknown>): Promise<string[]> {
  return (await getLeadMqlMandatoryFields()).filter((f) => !hasValue(data[f]));
}
