// Task #45 — Booking/PO targets per designer, on a 16th–15th cycle.
// Setting/editing is BRANCH_HEAD (Admin)-only; a cycle that has already
// elapsed is locked from any further changes, even by BRANCH_HEAD.
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { getCurrentCycle, getCycleForDate, isCycleInPast } from '../lib/targetCycle.js';
import { logActivity } from '../lib/activityLog.js';

export const designerTargetsRouter = Router();

designerTargetsRouter.use(verifyToken);

function serializeTarget(t: {
  id: string; designerId: string; cycleStart: Date; cycleEnd: Date;
  bookingTargetValue: any; poTargetValue: any; conversionTargetPct: any;
  averageBookingValueTarget: any; dipTargetCount: number | null; setById: string; updatedAt: Date;
}) {
  return {
    id: t.id,
    designerId: t.designerId,
    cycleStart: t.cycleStart,
    cycleEnd: t.cycleEnd,
    bookingTargetValue: Number(t.bookingTargetValue),
    poTargetValue: Number(t.poTargetValue),
    conversionTargetPct: t.conversionTargetPct == null ? null : Number(t.conversionTargetPct),
    averageBookingValueTarget: t.averageBookingValueTarget == null ? null : Number(t.averageBookingValueTarget),
    dipTargetCount: t.dipTargetCount,
    setById: t.setById,
    updatedAt: t.updatedAt,
    locked: isCycleInPast(t.cycleStart),
  };
}

// ── GET /api/designer-targets/:designerId — a designer's own target history ──
// Visibility: the designer themself, their BL, or BRANCH_HEAD. Everyone else 403s.
designerTargetsRouter.get('/:designerId', async (req, res) => {
  try {
    const { designerId } = req.params;
    const user = req.user!;
    if (user.role !== 'BRANCH_HEAD' && user.id !== designerId) {
      if (user.role === 'BL') {
        const designer = await prisma.user.findUnique({ where: { id: designerId }, select: { blId: true } });
        if (!designer || designer.blId !== user.id) {
          res.status(403).json({ error: 'Not authorized to view this designer\'s targets' });
          return;
        }
      } else {
        res.status(403).json({ error: 'Not authorized to view this designer\'s targets' });
        return;
      }
    }

    const targets = await prisma.designerTarget.findMany({
      where: { designerId },
      orderBy: { cycleStart: 'desc' },
    });
    const current = getCurrentCycle();
    res.json({
      targets: targets.map(serializeTarget),
      currentCycle: { cycleStart: current.cycleStart, cycleEnd: current.cycleEnd, label: current.label },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/designer-targets — admin list-all (current cycle by default) ───
designerTargetsRouter.get('/', requireRole('BRANCH_HEAD'), async (req, res) => {
  try {
    const cycleParam = req.query.cycleStart ? new Date(req.query.cycleStart as string) : getCurrentCycle().cycleStart;
    const cycle = getCycleForDate(cycleParam);
    const designers = await prisma.user.findMany({
      where: { role: 'DESIGNER', isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
    const targets = await prisma.designerTarget.findMany({
      where: { cycleStart: cycle.cycleStart },
    });
    const byDesigner = new Map(targets.map((t) => [t.designerId, t]));
    res.json({
      cycle: { cycleStart: cycle.cycleStart, cycleEnd: cycle.cycleEnd, label: cycle.label },
      designers: designers.map((d) => ({
        designerId: d.id,
        name: d.name,
        email: d.email,
        target: byDesigner.has(d.id) ? serializeTarget(byDesigner.get(d.id)!) : null,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/designer-targets — BRANCH_HEAD-only create/update for one designer ─
// Upserts the (designerId, cycleStart) row. cycleStart defaults to the
// current cycle if omitted. Rejects any cycle that has already elapsed —
// once a cycle is in the past, its target is locked from future changes,
// including by BRANCH_HEAD.
designerTargetsRouter.post('/', requireRole('BRANCH_HEAD'), async (req, res) => {
  try {
    const user = req.user!;
    const {
      designerId, bookingTargetValue, poTargetValue,
      conversionTargetPct, averageBookingValueTarget, dipTargetCount,
    } = req.body as Record<string, any>;
    const cycleRef = req.body.cycleStart ? new Date(req.body.cycleStart) : new Date();

    if (!designerId) { res.status(400).json({ error: 'designerId is required' }); return; }
    if (bookingTargetValue == null || isNaN(Number(bookingTargetValue)) || Number(bookingTargetValue) < 0) {
      res.status(400).json({ error: 'bookingTargetValue must be a non-negative number' });
      return;
    }
    if (poTargetValue == null || isNaN(Number(poTargetValue)) || Number(poTargetValue) < 0) {
      res.status(400).json({ error: 'poTargetValue must be a non-negative number' });
      return;
    }
    if (conversionTargetPct == null || isNaN(Number(conversionTargetPct)) || Number(conversionTargetPct) <= 0 || Number(conversionTargetPct) > 100) {
      res.status(400).json({ error: 'conversionTargetPct must be greater than 0 and at most 100' });
      return;
    }
    if (averageBookingValueTarget == null || isNaN(Number(averageBookingValueTarget)) || Number(averageBookingValueTarget) <= 0) {
      res.status(400).json({ error: 'averageBookingValueTarget must be greater than 0' });
      return;
    }
    if (dipTargetCount == null || !Number.isInteger(Number(dipTargetCount)) || Number(dipTargetCount) < 0) {
      res.status(400).json({ error: 'dipTargetCount must be a non-negative whole number' });
      return;
    }

    const designer = await prisma.user.findUnique({ where: { id: designerId }, select: { id: true, role: true } });
    if (!designer || designer.role !== 'DESIGNER') {
      res.status(404).json({ error: 'Designer not found' });
      return;
    }

    const cycle = getCycleForDate(cycleRef);
    if (isCycleInPast(cycle.cycleStart)) {
      res.status(403).json({ error: `The cycle ${cycle.label} has already passed and its target is locked from changes.` });
      return;
    }

    const existing = await prisma.designerTarget.findUnique({
      where: { designerId_cycleStart: { designerId, cycleStart: cycle.cycleStart } },
    });

    const target = await prisma.designerTarget.upsert({
      where: { designerId_cycleStart: { designerId, cycleStart: cycle.cycleStart } },
      create: {
        designerId,
        cycleStart: cycle.cycleStart,
        cycleEnd: cycle.cycleEnd,
        bookingTargetValue: Number(bookingTargetValue),
        poTargetValue: Number(poTargetValue),
        conversionTargetPct: Number(conversionTargetPct),
        averageBookingValueTarget: Number(averageBookingValueTarget),
        dipTargetCount: Number(dipTargetCount),
        setById: user.id,
      },
      update: {
        bookingTargetValue: Number(bookingTargetValue),
        poTargetValue: Number(poTargetValue),
        conversionTargetPct: Number(conversionTargetPct),
        averageBookingValueTarget: Number(averageBookingValueTarget),
        dipTargetCount: Number(dipTargetCount),
        setById: user.id,
      },
    });

    // Not a lead-scoped action — activityLog.leadId is a real FK to leads, so
    // this must go through undefined leadId with the designer captured in meta.
    await logActivity(user.id, existing ? 'DESIGNER_TARGET_UPDATED' : 'DESIGNER_TARGET_SET', undefined, {
      designerId,
      cycle: cycle.label,
      bookingTargetValue: Number(bookingTargetValue),
      poTargetValue: Number(poTargetValue),
      conversionTargetPct: Number(conversionTargetPct),
      averageBookingValueTarget: Number(averageBookingValueTarget),
      dipTargetCount: Number(dipTargetCount),
    });

    res.json({ target: serializeTarget(target) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
