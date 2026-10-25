import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ writes: [] as any[] }));
vi.mock('./prisma.js', () => ({ prisma: {
  user: { findMany: async () => [{ id: 'review-designer' }, { id: 'ordinary-designer' }] },
  designerCreditSnapshot: { upsert: async (query: any) => { state.writes.push(query); } },
} }));
vi.mock('./incentiveCredits.js', async () => {
  const cycle = await import('./targetCycle.js');
  return {
    getCycleForDate: cycle.getCycleForDate,
    loadIncentiveConfig: async () => ({ config: {} }),
    calculateDesignerCredits: async (designerId: string, period: any) => {
      if (designerId === 'review-designer') throw new CancellationReviewRequired([], period);
      return {
        core: { targetLakh: 10, bookingValue: 750000, bookingCount: 1, standard: 7.5, overachievement: 0, total: 7.5 },
        booster: { total: 5 }, totalCredits: 12.5, eligibility: { band: 'BELOW_THRESHOLD' },
      };
    },
  };
});
import { CancellationReviewRequired } from './bookingCancellations.js';
import { refreshCreditSnapshots } from './creditSnapshots.js';

describe('credit snapshot safety', () => {
  it('skips unverifiable totals without overwriting retained evidence or stopping other designers', async () => {
    state.writes = [];
    expect(await refreshCreditSnapshots()).toEqual({ saved: 2, pendingReview: 2 });
    expect(state.writes).toHaveLength(2);
    expect(state.writes.every((query) => query.where.designerId_cycleStart.designerId === 'ordinary-designer')).toBe(true);
    expect(state.writes.every((query) => query.update.totalCredits === 12.5)).toBe(true);
  });
});
