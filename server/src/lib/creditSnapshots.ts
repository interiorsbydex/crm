import { prisma } from './prisma.js';
import { calculateDesignerCredits, getCycleForDate, loadIncentiveConfig } from './incentiveCredits.js';
import { CancellationReviewRequired } from './bookingCancellations.js';

/**
 * Saves each active designer's computed credits for the current and previous
 * 16th–15th cycle. Review-required cycles are not overwritten: retained older
 * snapshot rows are historical evidence, not verified current credit totals.
 * External BI availability metadata remains a separate integration requirement.
 * The calculation itself stays in calculateDesignerCredits (single source).
 */
export async function refreshCreditSnapshots(): Promise<{ saved: number; pendingReview: number }> {
  const now = new Date();
  const current = getCycleForDate(now);
  const previous = getCycleForDate(new Date(current.cycleStart.getTime() - 24 * 60 * 60 * 1000));
  const { config } = await loadIncentiveConfig();
  const designers = await prisma.user.findMany({ where: { role: 'DESIGNER', isActive: true }, select: { id: true } });

  let saved = 0;
  let pendingReview = 0;
  for (const designer of designers) {
    for (const cycle of [previous, current]) {
      let r;
      try {
        r = await calculateDesignerCredits(designer.id, cycle, config);
      } catch (error) {
        if (!(error instanceof CancellationReviewRequired)) throw error;
        // Do not overwrite retained historical evidence with estimated totals.
        pendingReview++;
        continue;
      }
      const data = {
        cycleEnd: cycle.cycleEnd,
        cycleLabel: cycle.label,
        bookingTargetValue: r.core.targetLakh != null ? r.core.targetLakh * 100_000 : null,
        bookingValue: r.core.bookingValue,
        bookingCount: r.core.bookingCount,
        coreStandardCredits: r.core.standard,
        coreOverachievementCredits: r.core.overachievement,
        coreCredits: r.core.total,
        boosterCredits: r.booster.total,
        totalCredits: r.totalCredits,
        eligibilityBand: r.eligibility.band,
        computedAt: new Date(),
      };
      await prisma.designerCreditSnapshot.upsert({
        where: { designerId_cycleStart: { designerId: designer.id, cycleStart: cycle.cycleStart } },
        create: { designerId: designer.id, cycleStart: cycle.cycleStart, ...data },
        update: data,
      });
      saved++;
    }
  }
  return { saved, pendingReview };
}
