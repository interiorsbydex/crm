import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';

export const offersRouter = Router();
export const leadOfferRouter = Router({ mergeParams: true });

// ── GET /api/offers ───────────────────────────────────────────────────────────
offersRouter.get('/', verifyToken, async (req, res) => {
  const { activeOnly } = req.query;
  const offers = await prisma.offer.findMany({
    where: activeOnly === 'true' ? { isActive: true } : {},
    include: { _count: { select: { currentLeads: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ offers });
});

// ── POST /api/offers ──────────────────────────────────────────────────────────
offersRouter.post('/', verifyToken, requireRole('BL', 'BRANCH_HEAD'), async (req, res) => {
  const { name, description, startDate, endDate } = req.body as {
    name?: string; description?: string; startDate?: string; endDate?: string;
  };
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }

  const offer = await prisma.offer.create({
    data: {
      name,
      description,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    },
  });
  res.status(201).json({ offer });
});

// ── PATCH /api/offers/:id ─────────────────────────────────────────────────────
offersRouter.patch('/:id', verifyToken, requireRole('BL', 'BRANCH_HEAD'), async (req, res) => {
  const { id } = req.params;
  const { name, description, startDate, endDate, isActive } = req.body;

  const offer = await prisma.offer.update({
    where: { id },
    data: {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(startDate !== undefined && { startDate: new Date(startDate) }),
      ...(endDate !== undefined && { endDate: new Date(endDate) }),
      ...(isActive !== undefined && { isActive }),
    },
  });
  res.json({ offer });
});

// ── PATCH /api/offers/:id/toggle { isActive: boolean } (BRANCH_HEAD only) ────
offersRouter.patch('/:id/toggle', verifyToken, requireRole('BRANCH_HEAD'), async (req, res) => {
  const { isActive } = req.body as { isActive?: boolean };
  if (typeof isActive !== 'boolean') {
    res.status(400).json({ error: 'isActive (boolean) is required' });
    return;
  }
  const offer = await prisma.offer.update({
    where: { id: req.params.id },
    data: { isActive },
  });
  res.json({ offer });
});

// ── DELETE /api/offers/:id (soft delete) ──────────────────────────────────────
offersRouter.delete('/:id', verifyToken, requireRole('BL', 'BRANCH_HEAD'), async (req, res) => {
  await prisma.offer.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.json({ message: 'Offer deactivated' });
});

// ── POST /api/leads/:leadId/offer — apply offer to lead ───────────────────────
leadOfferRouter.post('/', verifyToken, async (req, res) => {
  const { leadId } = req.params as { leadId: string };
  const user = req.user!;
  const { offerId } = req.body as { offerId?: string };

  if (!offerId) { res.status(400).json({ error: 'offerId is required' }); return; }

  const [lead, offer] = await Promise.all([
    prisma.lead.findUnique({ where: { id: leadId } }),
    prisma.offer.findUnique({ where: { id: offerId } }),
  ]);
  if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
  if (!offer) { res.status(404).json({ error: 'Offer not found' }); return; }
  if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

  await prisma.$transaction([
    // offer1 is kept in sync for legacy exports/reports that still read the
    // free-text column, but currentOfferId is the authoritative link.
    prisma.lead.update({ where: { id: leadId }, data: { currentOfferId: offerId, offer1: offer.name } }),
    prisma.leadOffer.create({ data: { leadId, offerId } }),
  ]);

  await logActivity(user.id, 'OFFER_APPLIED', leadId, { offerId, offerName: offer.name });

  const updated = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { currentOffer: true },
  });
  res.json({ lead: updated });
});
