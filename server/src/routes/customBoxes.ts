import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { buildLeadRoleWhere } from '../lib/leadScope.js';
import { boxRoleFor, computeBox, customBoxesConfig, type BoxLead } from '../lib/customBoxes.js';

export const customBoxesRouter = Router();

// ── GET /api/custom-boxes — the boxes for this person's dashboard, with their figures ──
// Admin → Custom Boxes decides which boxes exist; each person only counts the
// leads they own (same scope as the dashboards), test leads left out.
customBoxesRouter.get('/', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const role = boxRoleFor(user.role);
    if (!role) { res.json({ boxes: [] }); return; }
    const boxes = (await customBoxesConfig.get()).boxes.filter((b) => b.roles.includes(role));
    if (!boxes.length) { res.json({ boxes: [] }); return; }

    const roleWhere = await buildLeadRoleWhere(user, prisma);
    const rows = await prisma.lead.findMany({
      where: { AND: [roleWhere, { isTestLead: false }] },
      select: {
        stage: true, status: true, source: true, estimatedValue: true, createdAt: true,
        assignedDesigner: { select: { name: true } },
      },
      take: 20000,
    });
    const leads: BoxLead[] = rows.map((r) => ({
      stage: r.stage, status: r.status, source: r.source,
      estimatedValue: r.estimatedValue == null ? null : Number(r.estimatedValue),
      createdAt: r.createdAt, designerName: r.assignedDesigner?.name ?? null,
    }));
    const now = new Date();
    res.json({ boxes: boxes.map((b) => computeBox(b, leads, now)) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
