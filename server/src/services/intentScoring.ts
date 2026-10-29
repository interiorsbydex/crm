/**
 * Intent rating rules — meeting-mode based auto-scoring.
 *
 * When a meeting is scheduled or completed the system automatically sets the
 * lead's intent rating based on the meeting mode. The designer can always
 * override this manually (which sets intentRatingSource = "manual").
 *
 * 1★ leads (no action planned) are blocked from advancing in the funnel.
 */

/**
 * Map a meeting mode to the auto-assigned star rating.
 * EC_VISIT = 5, SITE_VISIT = 4, VIRTUAL = 3, PUBLIC_PLACE = 2
 */
export const MODE_TO_RATING: Record<string, number> = {
  EC_VISIT: 5,
  SITE_VISIT: 4,
  VIRTUAL: 3,
  PUBLIC_PLACE: 2,
  CLIENT_PLACE: 2,
};

/**
 * Return the auto intent rating for a given meeting mode.
 * Falls back to 2 for any unrecognised mode.
 */
export function computeAutoRatingFromMode(mode: string, ratings: Record<string, number> = MODE_TO_RATING): number {
  // `ratings`: stars per meeting type from Admin → Meetings (lib/meetingSettings.ts).
  return ratings[mode] ?? 2;
}

/**
 * The rating a lead will carry after its next stage move (mirrors the stage-move code in
 * routes/leads.ts): a manual override stays; otherwise the system rating from the latest meeting.
 * Shown in the move box so the stars there are the stars the lead will end up with.
 */
export function ratingAfterStageMove(
  lead: {
    intentRating?: number | null;
    intentRatingSource?: string | null;
    meetings?: { mode?: string | null; status: string }[];
  },
  ratings: Record<string, number> = MODE_TO_RATING,
): { rating: number; systemRating: number; manual: boolean } {
  const systemRating = computeSystemRating(lead, ratings);
  const manual = lead.intentRatingSource === 'manual';
  return { rating: manual ? (lead.intentRating ?? systemRating) : systemRating, systemRating, manual };
}

/**
 * Backward-compatible wrapper: used by the intent-rating override validation.
 * Now returns the auto-rating derived from the most recent meeting mode,
 * or 1 if no meetings exist (no action planned).
 */
export function computeSystemRating(
  lead: {
    calls?: { id: string }[];
    meetings?: { mode?: string | null; status: string }[];
  },
  ratings: Record<string, number> = MODE_TO_RATING,
): number {
  if (!lead.meetings || lead.meetings.length === 0) return 1;
  // meetings is expected newest-first (orderBy createdAt desc from DB).
  // Find the first entry with a mode — that is the most recent rated meeting.
  const latest = lead.meetings.find((m) => m.mode);
  if (!latest?.mode) return 1;
  return computeAutoRatingFromMode(latest.mode, ratings);
}
