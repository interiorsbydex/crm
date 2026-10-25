import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';

export const calendarRouter = Router();

// ── GET /api/calendar?from=&to=&scope=mine|team ───────────────────────────────
calendarRouter.get('/', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const { from, to, scope = 'mine' } = req.query as {
      from?: string; to?: string; scope?: string;
    };

    // scope=team only for BL / BRANCH_HEAD
    if (scope === 'team' && user.role !== 'BL' && user.role !== 'BRANCH_HEAD') {
      res.status(403).json({ error: 'scope=team is only available for BL and BRANCH_HEAD roles' });
      return;
    }

    // Date range filter
    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      dateFilter.lte = toDate;
    }

    // Build lead scope filter
    let leadWhere: any = {};
    if (scope === 'mine') {
      if (user.role === 'DESIGNER' || user.role === 'CRE') {
        leadWhere = { assignedDesignerId: user.id };
      } else if (user.role === 'BL') {
        leadWhere = { assignedBLId: user.id };
      }
      // BRANCH_HEAD mine = all their own leads (no filter)
    } else {
      // scope=team — BL sees team member leads, BRANCH_HEAD sees all
      if (user.role === 'BL') {
        const members = await prisma.user.findMany({
          where: { blId: user.id, isActive: true },
          select: { id: true },
        });
        leadWhere = {
          OR: [
            { assignedDesignerId: { in: members.map((m) => m.id) } },
            { assignedBLId: user.id },
          ],
        };
      }
      // BRANCH_HEAD team = all leads, no leadWhere filter needed
    }

    const meetingWhere: any = {};
    if (Object.keys(leadWhere).length > 0) meetingWhere.lead = leadWhere;
    if (Object.keys(dateFilter).length > 0) meetingWhere.scheduledAt = dateFilter;

    const meetings = await prisma.meeting.findMany({
      where: meetingWhere,
      include: {
        lead: {
          select: { id: true, leadId: true, name: true, location: true },
        },
      },
      orderBy: { scheduledAt: 'asc' },
      take: 500,
    });

    const events = meetings.map((m) => ({
      id: m.id,
      leadId: m.lead.leadId,
      leadDbId: m.lead.id,
      leadName: m.lead.name,
      type: m.type,
      ppNumber: m.ppNumber,
      mode: m.mode,
      status: m.status,
      scheduledAt: m.scheduledAt,
      location: m.lead.location ?? null,
    }));

    res.json({ events, count: events.length });
  } catch (err: any) {
    console.error('[calendar:get]', err.message);
    res.status(500).json({ error: err.message });
  }
});
