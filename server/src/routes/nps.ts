import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { buildLeadRoleWhere } from '../lib/leadScope.js';

export const npsRouter = Router();

function startOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

// ── GET /api/nps — role-scoped NPS response list ─────────────────────────────
// Drill-through target for the dashboard's "NPS Score" KPI. Mirrors the exact
// predicate used to compute `avgNPS` (respondedAt not null, in range; score
// not null), scoped via the same buildLeadRoleWhere the dashboard uses, and
// defaults to the current calendar month (the dashboard's default range) so
// the tile and this list always agree exactly (task #113).
npsRouter.get('/', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const { from, to } = req.query as { from?: string; to?: string };

    const leadRoleWhere = await buildLeadRoleWhere(user, prisma);
    const responses = await prisma.nPSResponse.findMany({
      where: {
        lead: leadRoleWhere,
        respondedAt: {
          not: null,
          gte: from ? new Date(from) : startOfMonth(),
          lte: to ? new Date(to) : endOfMonth(),
        },
        score: { not: null },
      },
      include: {
        lead: { select: { id: true, leadId: true, name: true } },
      },
      orderBy: { respondedAt: 'desc' },
    });

    // Average of per-stage averages — NOT a flat mean of every response.
    // Must match dashboard.ts's `avgNPS` formula exactly (task #113 review):
    // dashboard groups by stage, averages each stage's scores, then averages
    // those stage averages, so stages with more responses aren't
    // over-weighted. A flat mean over all responses disagrees whenever
    // stages have unequal response counts.
    const byStage: Record<string, number[]> = {};
    for (const r of responses) {
      if (r.score !== null) {
        if (!byStage[r.stage]) byStage[r.stage] = [];
        byStage[r.stage].push(r.score);
      }
    }
    const stageAverages = Object.values(byStage).map(
      (scores) => scores.reduce((a, b) => a + b, 0) / scores.length,
    );
    const average = stageAverages.length > 0
      ? +(stageAverages.reduce((a, b) => a + b, 0) / stageAverages.length).toFixed(1)
      : null;

    res.json({
      responses: responses.map((r) => ({
        id: r.id,
        stage: r.stage,
        score: r.score,
        respondedAt: r.respondedAt,
        leadId: r.lead.leadId,
        clientName: r.lead.name,
      })),
      total: responses.length,
      average,
    });
  } catch (err) {
    console.error('GET /api/nps error:', err);
    res.status(500).json({ error: 'Failed to fetch NPS responses' });
  }
});
