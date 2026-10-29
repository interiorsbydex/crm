/**
 * Leads list / export "Possession" filter. It searches the lead's Possession
 * field (possessionTimeline), which holds "Possession Received", a date
 * (YYYY-MM-DD from the CRM's date picker, or DD-MM-YYYY from imported sheets),
 * or free text such as "3-6 months". The separate "Expected Interior Handover
 * Date" (expectedMoveIn) is not part of this filter.
 *
 * possession: 'received' → only leads marked Possession Received (dates ignored);
 *             'date'     → only leads with a possession date (in the range, if given);
 *             ''         → a from/to range alone behaves like 'date'.
 */
export const POSSESSION_RECEIVED = 'Possession Received';

/** The possession date as YYYY-MM-DD, or null when the value isn't a full date. */
export function possessionDate(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(T.*)?$/.exec(v);
  if (match) { y = +match[1]; m = +match[2]; d = +match[3]; }
  else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v))) { d = +match[1]; m = +match[2]; y = +match[3]; }
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

type LeadFinder = { lead: { findMany: (args: any) => Promise<{ id: string; possessionTimeline: string | null }[]> } };

export async function possessionWhere(
  db: LeadFinder, possession?: string, from?: string, to?: string,
): Promise<Record<string, any> | null> {
  if (possession === 'received') {
    return { possessionTimeline: { contains: 'received', mode: 'insensitive' } };
  }
  if (possession !== 'date' && !from && !to) return null;
  // Dates are written two ways, so they're read here rather than compared as text.
  const rows = await db.lead.findMany({
    where: { possessionTimeline: { not: null } },
    select: { id: true, possessionTimeline: true },
  });
  const ids = rows.filter((r) => {
    const date = possessionDate(r.possessionTimeline);
    return date != null && (!from || date >= from) && (!to || date <= to);
  }).map((r) => r.id);
  return { id: { in: ids } };
}
