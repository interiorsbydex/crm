/** Lead details whose edits are written to the lead's history, with the name shown for each. */
export const TRACKED_LEAD_FIELDS: { field: string; label: string; hideValues?: boolean }[] = [
  { field: 'name', label: 'Name' },
  { field: 'phone', label: 'Phone' },
  { field: 'phone2', label: 'Second phone' },
  { field: 'email', label: 'Email' },
  { field: 'email2', label: 'Second email' },
  { field: 'source', label: 'Source' },
  { field: 'projectType', label: 'Project type' },
  { field: 'scope', label: 'Scope of work' },
  { field: 'location', label: 'Location' },
  { field: 'estimatedValue', label: 'Client budget / value' },
  { field: 'possessionTimeline', label: 'Possession timeline' },
  { field: 'expectedObDate', label: 'Expected onboarding date' },
  { field: 'expectedMoveIn', label: 'Expected move-in' },
  { field: 'builder', label: 'Builder' },
  { field: 'offer1', label: 'Offer 1' },
  { field: 'offer2', label: 'Offer 2' },
  { field: 'offer3', label: 'Offer 3' },
  // ID numbers and free notes: the history says they changed, but does not copy the contents.
  { field: 'pan', label: 'PAN', hideValues: true },
  { field: 'gst', label: 'GST', hideValues: true },
  { field: 'notes', label: 'Notes', hideValues: true },
];

export interface LeadFieldChange { field: string; label: string; from: string | null; to: string | null }

function norm(v: unknown, numeric = false): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // Decimals (Prisma) and numbers compare by value, so 1500000 and "1500000.00" are the same.
  if (typeof v === 'object' && typeof (v as { toString: () => string }).toString === 'function') {
    const n = Number(String(v));
    return Number.isNaN(n) ? String(v) : String(n);
  }
  if (typeof v === 'number') return String(v);
  const t = String(v).trim();
  if (numeric && /^-?\d+(\.\d+)?$/.test(t)) return String(Number(t));
  return t || null;
}

/** What changed between two versions of a lead, in the tracked fields only. Nothing changed → []. */
export function diffLeadDetails(before: Record<string, unknown>, after: Record<string, unknown>): LeadFieldChange[] {
  const changes: LeadFieldChange[] = [];
  for (const { field, label, hideValues } of TRACKED_LEAD_FIELDS) {
    const from = norm(before[field], field === 'estimatedValue');
    const to = norm(after[field], field === 'estimatedValue');
    if (from === to) continue;
    changes.push({ field, label, from: hideValues ? null : from, to: hideValues ? null : to });
  }
  return changes;
}
