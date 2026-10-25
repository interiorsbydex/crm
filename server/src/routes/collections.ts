import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { buildLeadRoleWhere } from '../lib/leadScope.js';

export const collectionsRouter = Router();

function startOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

// ── GET /api/collections — role-scoped collection (payment) list ─────────────
// Drill-through target for the dashboard's "Collected This Month" KPI.
// Scoped via the same buildLeadRoleWhere predicate the dashboard uses, and
// defaults to the current calendar month (matching the dashboard's default
// `collectedThisMonth` aggregate) so the tile and this list always agree
// exactly unless the caller explicitly overrides `from`/`to` (task #113).
collectionsRouter.get('/', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const { status, from, to } = req.query as { status?: string; from?: string; to?: string };

    const leadRoleWhere = await buildLeadRoleWhere(user, prisma);
    const where: any = {
      project: Object.keys(leadRoleWhere).length > 0 ? { lead: leadRoleWhere } : {},
    };
    if (status) where.status = status;
    where.collectedAt = {
      gte: from ? new Date(from) : startOfMonth(),
      lte: to ? new Date(to) : endOfMonth(),
    };

    const collections = await prisma.collection.findMany({
      where,
      include: {
        project: {
          select: {
            id: true,
            projectCode: true,
            lead: { select: { id: true, leadId: true, name: true } },
          },
        },
      },
      orderBy: { collectedAt: 'desc' },
    });

    res.json({
      collections: collections.map((c) => ({
        id: c.id,
        milestone: c.milestone,
        amount: c.amount,
        status: c.status,
        dueDate: c.dueDate,
        collectedAt: c.collectedAt,
        projectId: c.projectId,
        projectCode: c.project.projectCode,
        leadId: c.project.lead.leadId,
        clientName: c.project.lead.name,
      })),
      total: collections.length,
      sum: collections.reduce((acc, c) => acc + c.amount, 0),
    });
  } catch (err) {
    console.error('GET /api/collections error:', err);
    res.status(500).json({ error: 'Failed to fetch collections' });
  }
});
