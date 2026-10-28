/**
 * Performance Recalculation Job — runs nightly at 2am.
 * Recalculates per-designer: conversionRate, avgProjectValue, performanceTier.
 *
 * Tier thresholds:
 *   BASIC    — conversion < 20%
 *   STANDARD — conversion 20–40%
 *   PREMIUM  — conversion > 40%
 */

import { Queue, Worker } from 'bullmq';
import { queueOpts, workerOpts } from './index.js';
import { prisma } from '../lib/prisma.js';

const QUEUE_NAME = 'performance-recalc';

export const performanceRecalcQueue = new Queue(QUEUE_NAME, queueOpts);

export async function schedulePerformanceRecalc() {
  await performanceRecalcQueue.add(
    'nightly-recalc',
    {},
    {
      repeat: { pattern: '0 2 * * *' }, // 2am every night
      jobId: 'performance-recalc-singleton',
    },
  );
  console.log('[jobs] Nightly performance recalc scheduled (0 2 * * *)');
}

export async function runPerformanceRecalc(): Promise<{ updated: number }> {
  console.log('[performance] Running recalculation…');

  const designers = await prisma.user.findMany({
    where: { role: { in: ['DESIGNER', 'CRE'] }, isActive: true },
    select: { id: true },
  });

  let updated = 0;

  for (const designer of designers) {
    const [totalAssigned, totalConverted, avgValue] = await Promise.all([
      prisma.lead.count({ where: { assignedDesignerId: designer.id } }),
      // Conversion counts leads that reached Design in Progress — the funnel's
      // terminal/incentive-trigger stage. Both DESIGN_IN_PROGRESS (current
      // funnel) and HANDED_OVER (legacy) require a completed DIP checklist.
      // The previously unconditional HANDED_OVER branch was a regression that
      // inflated conversion rates for legacy leads with no checklist record.
      prisma.lead.count({
        where: {
          assignedDesignerId: designer.id,
          OR: [
            { stage: 'DESIGN_IN_PROGRESS', dipChecklist: { completedAt: { not: null } } },
            { stage: 'HANDED_OVER',        dipChecklist: { completedAt: { not: null } } },
          ],
        },
      }),
      prisma.lead.aggregate({
        where: {
          assignedDesignerId: designer.id,
          estimatedValue: { not: null },
        },
        _avg: { estimatedValue: true },
      }),
    ]);

    const conversionRate = totalAssigned > 0 ? totalConverted / totalAssigned : 0;

    let performanceTier: 'BASIC' | 'STANDARD' | 'PREMIUM';
    if (conversionRate > 0.4) performanceTier = 'PREMIUM';
    else if (conversionRate >= 0.2) performanceTier = 'STANDARD';
    else performanceTier = 'BASIC';

    await prisma.user.update({
      where: { id: designer.id },
      data: {
        totalLeadsAssigned: totalAssigned,
        totalLeadsConverted: totalConverted,
        conversionRate,
        avgProjectValue: avgValue._avg.estimatedValue ?? 0,
        performanceTier,
      },
    });

    updated++;
  }

  console.log(`[performance] Done. ${updated} designer(s) recalculated.`);
  return { updated };
}

export const performanceRecalcWorker = new Worker(
  QUEUE_NAME,
  async () => {
    console.log('[performance] Running nightly recalculation…');

    const designers = await prisma.user.findMany({
      where: { role: { in: ['DESIGNER', 'CRE'] }, isActive: true },
      select: { id: true },
    });

    let updated = 0;

    for (const designer of designers) {
      const [totalAssigned, totalConverted, avgValue] = await Promise.all([
        prisma.lead.count({ where: { assignedDesignerId: designer.id } }),
        prisma.lead.count({
          where: {
            assignedDesignerId: designer.id,
            // Both DIP and legacy HANDED_OVER require a completed DIP
            // checklist — unconditional HANDED_OVER was a regression.
            // See runPerformanceRecalc() above for the full rationale.
            OR: [
              { stage: 'DESIGN_IN_PROGRESS', dipChecklist: { completedAt: { not: null } } },
              { stage: 'HANDED_OVER',        dipChecklist: { completedAt: { not: null } } },
            ],
          },
        }),
        prisma.lead.aggregate({
          where: {
            assignedDesignerId: designer.id,
            estimatedValue: { not: null },
          },
          _avg: { estimatedValue: true },
        }),
      ]);

      const conversionRate = totalAssigned > 0
        ? totalConverted / totalAssigned
        : 0;

      let performanceTier: 'BASIC' | 'STANDARD' | 'PREMIUM';
      if (conversionRate > 0.4) performanceTier = 'PREMIUM';
      else if (conversionRate >= 0.2) performanceTier = 'STANDARD';
      else performanceTier = 'BASIC';

      await prisma.user.update({
        where: { id: designer.id },
        data: {
          totalLeadsAssigned: totalAssigned,
          totalLeadsConverted: totalConverted,
          conversionRate,
          avgProjectValue: avgValue._avg.estimatedValue ?? 0,
          performanceTier,
        },
      });

      updated++;
    }

    console.log(`[performance] Done. ${updated} designer(s) recalculated.`);
  },
  workerOpts,
);
