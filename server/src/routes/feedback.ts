import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { createNotification } from '../lib/notifications.js';

export const feedbackRouter = Router();

// NOTE on task #149 (lock inactive leads from all edits): the NPS and
// inactivation-feedback flows below are deliberately NOT gated by
// isLeadLocked. Both are public, token-based forms sent to the *client*,
// and inactivation-feedback in particular only ever fires once a lead is
// already INACTIVE — locking it would make the flow it exists for
// impossible to complete. This is an intentional exception, not a bypass.

// ── GET /api/feedback/nps/:token — public: NPS form (must come before /:token) ─
feedbackRouter.get('/nps/:token', async (req, res) => {
  try {
    const nps = await prisma.nPSResponse.findUnique({
      where: { formToken: req.params.token },
      include: { lead: { select: { name: true } } },
    });
    if (!nps) { res.status(404).json({ error: 'Invalid or expired NPS link' }); return; }

    if (nps.respondedAt) {
      res.json({ alreadySubmitted: true, clientName: nps.lead.name });
      return;
    }
    res.json({ alreadySubmitted: false, clientName: nps.lead.name, stage: nps.stage });
  } catch (err: any) {
    console.error('[feedback:nps:get]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/feedback/nps/:token { score } — public: submit NPS score ─────────
feedbackRouter.post('/nps/:token', async (req, res) => {
  try {
    const { score } = req.body as { score?: number };
    if (score === undefined || score === null || score < 0 || score > 10) {
      res.status(400).json({ error: 'score must be an integer between 0 and 10' });
      return;
    }

    const nps = await prisma.nPSResponse.findUnique({
      where: { formToken: req.params.token },
    });
    if (!nps) { res.status(404).json({ error: 'Invalid or expired NPS link' }); return; }
    if (nps.respondedAt) { res.status(409).json({ error: 'NPS score already submitted' }); return; }

    const updated = await prisma.nPSResponse.update({
      where: { id: nps.id },
      data: { score: Math.round(score), respondedAt: new Date() },
      include: {
        lead: {
          select: {
            id: true, leadId: true, name: true,
            assignedDesignerId: true,
          },
        },
      },
    });

    // Notify assigned designer about the NPS submission (fire-and-forget)
    if (updated.lead?.assignedDesignerId) {
      const stageName = { SALE: 'Sales', ONBOARDING: 'Onboarding', DESIGN_FREEZE: 'Design Freeze', SIGN_OFF: 'Sign Off' }[updated.stage] ?? updated.stage;
      const msg = `Client ${updated.lead.name} (${updated.lead.leadId}) rated you ${Math.round(score)}/10 for ${stageName}.`;
      createNotification(updated.lead.assignedDesignerId, 'NPS_SUBMITTED', msg, updated.lead.id).catch(() => {});
    }

    res.json({ message: 'Thank you for your feedback!' });
  } catch (err: any) {
    console.error('[feedback:nps:post]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/feedback/:token — public: load inactivation feedback form data ───
feedbackRouter.get('/:token', async (req, res) => {
  try {
    const feedback = await prisma.inactivationFeedback.findUnique({
      where: { formToken: req.params.token },
      include: { lead: { select: { name: true } } },
    });
    if (!feedback) { res.status(404).json({ error: 'Feedback form not found or expired' }); return; }

    if (feedback.respondedAt) {
      res.json({ alreadySubmitted: true, clientName: feedback.lead.name });
      return;
    }
    res.json({ alreadySubmitted: false, clientName: feedback.lead.name, reason: feedback.reason });
  } catch (err: any) {
    console.error('[feedback:get]', err.message);
    res.status(500).json({ error: 'Service unavailable — database not configured' });
  }
});

// ── POST /api/feedback/:token — public: submit client response ────────────────
feedbackRouter.post('/:token', async (req, res) => {
  try {
    const { response } = req.body as { response?: string };
    if (!response?.trim()) { res.status(400).json({ error: 'response is required' }); return; }

    const feedback = await prisma.inactivationFeedback.findUnique({
      where: { formToken: req.params.token },
    });
    if (!feedback) { res.status(404).json({ error: 'Feedback form not found' }); return; }
    if (feedback.respondedAt) { res.status(409).json({ error: 'Already submitted' }); return; }

    await prisma.inactivationFeedback.update({
      where: { formToken: req.params.token },
      data: { clientResponse: response, respondedAt: new Date() },
    });

    res.json({ message: 'Thank you for your feedback!' });
  } catch (err: any) {
    console.error('[feedback:post]', err.message);
    res.status(500).json({ error: 'Service unavailable — database not configured' });
  }
});
