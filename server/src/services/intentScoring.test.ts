import { describe, it, expect } from 'vitest';
import { ratingAfterStageMove } from './intentScoring.js';

describe('ratingAfterStageMove', () => {
  it('a rating typed at creation (not a manual override) gives way to the system rating: no meeting = 1', () => {
    expect(ratingAfterStageMove({ intentRating: 4, intentRatingSource: null, meetings: [] }))
      .toEqual({ rating: 1, systemRating: 1, manual: false });
  });

  it('follows the latest meeting type', () => {
    expect(ratingAfterStageMove({ intentRating: 1, intentRatingSource: 'system', meetings: [{ mode: 'SITE_VISIT', status: 'SCHEDULED' }, { mode: 'VIRTUAL', status: 'COMPLETED' }] }).rating)
      .toBe(4);
  });

  it('keeps a manual override', () => {
    expect(ratingAfterStageMove({ intentRating: 5, intentRatingSource: 'manual', meetings: [] }))
      .toEqual({ rating: 5, systemRating: 1, manual: true });
  });

  it('uses the stars set in Admin → Meetings', () => {
    expect(ratingAfterStageMove({ intentRatingSource: null, meetings: [{ mode: 'VIRTUAL', status: 'SCHEDULED' }] }, { VIRTUAL: 5 }).rating)
      .toBe(5);
  });
});
