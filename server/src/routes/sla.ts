import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';
import { requirePermission } from '../lib/permissions.js';

export const slaRouter = Router();

// ── GET /api/sla/breaches ─────────────────────────────────────────────────────
slaRouter.get('/breaches', verifyToken, requirePermission('SLA_MANAGE'), async (req, res) => {
  const user = req.user!;
  const { rule, resolved } = req.query as { rule?: string; resolved?: string };

  let leadFilter: any = {};
  if (user.role === 'BL') {
    const members = await prisma.user.findMany({
      where: { blId: user.id },
      select: { id: true },
    });
    leadFilter = { assignedDesignerId: { in: members.map((m) => m.id) } };
  }

  const where: any = {
    // ONBOARDING excluded (task #14) — the legacy engine never had an OB→OBM
    // rule, so any record here for a lead now in ONBOARDING is stale/left
    // over from an earlier stage; that stage relies on the new stage-SLA
    // system instead.
    lead: { ...leadFilter, stage: { not: 'ONBOARDING' } },
  };
  if (rule) where.rule = rule;
  if (resolved === 'true') where.resolvedAt = { not: null };
  else if (resolved === 'false') where.resolvedAt = null;

  const breaches = await prisma.sLABreach.findMany({
    where,
    include: {
      lead: {
        select: {
          id: true,
          leadId: true,
          name: true,
          stage: true,
          isSLABreached: true,
          assignedDesigner: { select: { id: true, name: true } },
          assignedBL: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { breachedAt: 'desc' },
  });

  const summary = {
    total: breaches.length,
    active: breaches.filter((b) => !b.resolvedAt).length,
    byRule: breaches.reduce<Record<string, number>>((acc, b) => {
      acc[b.rule] = (acc[b.rule] ?? 0) + 1;
      return acc;
    }, {}),
  };

  res.json({ breaches, summary });
});

// ── PATCH /api/sla/breaches/:id/resolve ──────────────────────────────────────
slaRouter.patch('/breaches/:id/resolve', verifyToken, requirePermission('SLA_MANAGE'), async (req, res) => {
  const { id } = req.params;

  const breach = await prisma.sLABreach.findUnique({ where: { id } });
  if (!breach) { res.status(404).json({ error: 'SLA breach not found' }); return; }

  const leadForLock = await prisma.lead.findUnique({ where: { id: breach.leadId }, select: { status: true } });
  if (leadForLock && isLeadLocked(leadForLock.status)) { sendLeadLockedError(res); return; }

  const updated = await prisma.sLABreach.update({
    where: { id },
    data: { resolvedAt: new Date() },
  });

  // If no active breaches remain on this lead, clear the flag
  const activeCount = await prisma.sLABreach.count({
    where: { leadId: breach.leadId, resolvedAt: null },
  });
  if (activeCount === 0) {
    await prisma.lead.update({
      where: { id: breach.leadId },
      data: { isSLABreached: false },
    });
  }

  res.json({ breach: updated });
});
