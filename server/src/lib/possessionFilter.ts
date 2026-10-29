/**
 * Leads list / export "Possession" filter. It searches the lead's Possession
 * field (possessionTimeline), which holds either "Possession Received" or a
 * date as YYYY-MM-DD (older imported leads may hold free text). The separate
 * "Expected Interior Handover Date" (expectedMoveIn) is not part of this filter.
 *
 * possession: 'received' → only leads marked Possession Received (dates ignored);
 *             'date'     → only leads with a possession date (in the range, if given);
 *             ''         → a from/to range alone behaves like 'date'.
 */
export const POSSESSION_RECEIVED = 'Possession Received';

export function possessionWhere(possession?: string, from?: string, to?: string): Record<string, any> | null {
  if (possession === 'received') {
    return { possessionTimeline: { contains: 'received', mode: 'insensitive' } };
  }
  if (possession !== 'date' && !from && !to) return null;
  // Dates are stored as YYYY-MM-DD text, so text comparison orders them by date.
  // The upper bound '9999…' also keeps out values starting with a letter.
  return {
    AND: [
      { possessionTimeline: { gte: from || '0' } },
      { possessionTimeline: { lte: to ? `${to}~` : '9999-12-31~' } },
      { possessionTimeline: { contains: '-' } },
    ],
  };
}
