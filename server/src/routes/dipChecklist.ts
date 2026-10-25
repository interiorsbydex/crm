/**
 * DIP Checklist routes
 *
 * GET   /api/leads/:id/dip-checklist    — get checklist state
 * PATCH /api/leads/:id/dip-checklist    — update checklist (BL only)
 */

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { createNotification } from '../lib/notifications.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';
import { requiredDipChecksComplete } from '../lib/dipChecklistRules.js';
import { requirePermission } from '../lib/permissions.js';

export const dipChecklistRouter = Router({ mergeParams: true });

async function googleReviewReceived(leadId: string) {
  const event = await prisma.activityLog.findFirst({
    where: { leadId, action: 'DIP_GOOGLE_REVIEW_UPDATED' },
    orderBy: { createdAt: 'desc' },
    select: { meta: true },
  });
  return (event?.meta as { received?: boolean } | null)?.received === true;
}

// ── GET /api/leads/:id/dip-checklist ─────────────────────────────────────────
dipChecklistRouter.get('/', verifyToken, async (req, res) => {
  try {
    const { leadId: id } = req.params;
    let checklist = await prisma.dIPChecklist.findUnique({ where: { leadId: id } });
    // Self-healing safety net (mirrors pdObChecklist.ts): a lead can be
    // sitting at ONBOARDING_MEETING or later without a checklist row if it
    // reached that stage via a path that bypassed the leads.ts auto-create —
    // without this, the Pipeline board / lead detail entry point shows a
    // dead end instead of the actual checklist.
    if (!checklist) {
      const lead = await prisma.lead.findUnique({ where: { id }, select: { stage: true } });
      const STAGES_PAST_OBM = new Set(['ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER']);
      if (lead && STAGES_PAST_OBM.has(lead.stage)) {
        checklist = await prisma.dIPChecklist.upsert({ where: { leadId: id }, create: { leadId: id }, update: {} });
      }
    }
    // Items were all ticked before the (now mandatory) payment screenshot was uploaded: complete now.
    if (checklist && !checklist.completedAt && requiredDipChecksComplete(checklist)) {
      const proof = await prisma.leadFile.findFirst({ where: { leadId: id, fileType: 'PAYMENT_SCREENSHOT' }, select: { id: true } });
      if (proof) checklist = await prisma.dIPChecklist.update({ where: { leadId: id }, data: { completedAt: new Date() } });
    }
    res.json({ checklist: checklist ? { ...checklist, googleReviewReceived: await googleReviewReceived(id) } : null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/leads/:id/dip-checklist ───────────────────────────────────────
dipChecklistRouter.patch('/', verifyToken, requirePermission('DIP_CHECKLIST_EDIT'), async (req, res) => {
  try {
    const { leadId: id } = req.params;
    const user = req.user!;
    const {
      welcomeMailSent,
      discountApprovalFormSent,
      npsTriggered,
      cxApprovalReceived,
      internalMailThreadCompleted,
      internalMailThreadUrl,
      googleReviewReceived: reviewReceived,
    } = req.body as {
      welcomeMailSent?: boolean;
      discountApprovalFormSent?: boolean;
      npsTriggered?: boolean;
      cxApprovalReceived?: boolean;
      internalMailThreadCompleted?: boolean;
      internalMailThreadUrl?: string;
      googleReviewReceived?: boolean;
    };
    if (reviewReceived !== undefined && typeof reviewReceived !== 'boolean') {
      res.status(400).json({ error: 'Google review status must be true or false' });
      return;
    }

    const leadForLock = await prisma.lead.findUnique({ where: { id }, select: { status: true } });
    if (!leadForLock) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (isLeadLocked(leadForLock.status)) { sendLeadLockedError(res); return; }

    const current = await prisma.dIPChecklist.findUnique({ where: { leadId: id } });
    if (!current) {
      res.status(404).json({ error: 'DIP checklist not found. Lead may not be in Onboarding Meeting stage yet.' });
      return;
    }

    const updateData: any = {};
    if (welcomeMailSent !== undefined) updateData.welcomeMailSent = welcomeMailSent;
    if (discountApprovalFormSent !== undefined) updateData.discountApprovalFormSent = discountApprovalFormSent;
    if (npsTriggered !== undefined) updateData.npsTriggered = npsTriggered;
    if (cxApprovalReceived !== undefined) updateData.cxApprovalReceived = cxApprovalReceived;
    if (internalMailThreadCompleted !== undefined) updateData.internalMailThreadCompleted = internalMailThreadCompleted;
    if (internalMailThreadUrl !== undefined) updateData.internalMailThreadUrl = internalMailThreadUrl;

    // NPS belongs to onboarding. Google Review is separately recorded and optional.
    const merged = { ...current, ...updateData };
    // Client decision: "welcome mail sent" and "discount approval form sent"
    // are no longer required. The columns/old values are kept; they just no
    // longer gate completion.
    // Client decision (Annie, Oct 2026): payment proof is mandatory and is what confirms a booking.
    // The checklist (and so Booking Value / incentives, which key on completedAt) cannot complete
    // without a payment screenshot, even in lenient mode.
    const paymentProof = await prisma.leadFile.findFirst({
      where: { leadId: id, fileType: 'PAYMENT_SCREENSHOT' },
      select: { id: true },
    });
    const itemsDone = requiredDipChecksComplete(merged);
    const allComplete = !!itemsDone && !!paymentProof;
    const paymentProofMissing = !!itemsDone && !paymentProof && !current.completedAt;

    if (allComplete && !current.completedAt) {
      updateData.completedAt = new Date();
    }

    const checklist = await prisma.dIPChecklist.update({
      where: { leadId: id },
      data: updateData,
    });

    await logActivity(user.id, 'DIP_CHECKLIST_UPDATED', id, updateData);
    if (reviewReceived !== undefined) {
      await logActivity(user.id, 'DIP_GOOGLE_REVIEW_UPDATED', id, { received: reviewReceived });
    }

    // Notify Branch Head when completed
    if (allComplete && !current.completedAt) {
      const branchHeads = await prisma.user.findMany({
        where: { role: 'BRANCH_HEAD', isActive: true },
        select: { id: true },
      });
      const lead = await prisma.lead.findUnique({
        where: { id },
        select: { leadId: true, name: true },
      });
      for (const bh of branchHeads) {
        await createNotification(
          bh.id,
          'DIP_CHECKLIST_COMPLETE',
          `DIP checklist complete for ${lead?.leadId ?? id} (${lead?.name ?? ''}). Sales task can be closed.`,
          id,
        );
      }
    }

    res.json({ checklist: { ...checklist, googleReviewReceived: await googleReviewReceived(id) }, paymentProofMissing });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
