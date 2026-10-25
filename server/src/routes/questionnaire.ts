/**
 * DQL Questionnaire routes
 *
 * POST /api/integrations/google-form-webhook  (public, no auth)
 * GET  /api/leads/:id/questionnaire           (authenticated)
 *
 * ACTIVATION REQUIRED: client must set up Google Form with Lead ID field +
 * configure Apps Script webhook to POST to this endpoint.
 * See docs/google-form-setup.md for setup instructions.
 */

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { createNotification } from '../lib/notifications.js';
import { isLeadLocked } from '../lib/leadLock.js';

export const googleFormWebhookRouter = Router();
export const questionnaireRouter = Router({ mergeParams: true });

const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID ?? 'system';

// ── POST /api/integrations/google-form-webhook ────────────────────────────────
googleFormWebhookRouter.post('/', async (req, res) => {
  try {
    const { formResponseId, leadIdentifier, responses } = req.body as {
      formResponseId?: string;
      leadIdentifier?: string;
      responses?: Record<string, string>;
    };

    if (!leadIdentifier?.trim()) {
      res.status(400).json({ error: 'leadIdentifier is required' });
      return;
    }

    // Match lead by X#### or UUID
    const lead = await prisma.lead.findFirst({
      where: {
        OR: [
          { leadId: leadIdentifier.trim().toUpperCase() },
          { id: leadIdentifier.trim() },
        ],
      },
      select: {
        id: true,
        leadId: true,
        name: true,
        status: true,
        assignedDesignerId: true,
        assignedBLId: true,
      },
    });

    if (!lead) {
      res.status(404).json({ error: `Lead not found for identifier: ${leadIdentifier}` });
      return;
    }

    if (isLeadLocked(lead.status)) {
      // Webhook has no interactive client to show a 423 to — ack it so the
      // external form provider doesn't retry, but skip the write entirely.
      res.json({ ok: false, error: 'Lead is inactive; questionnaire not recorded.' });
      return;
    }

    // Upsert questionnaire (one per lead)
    await prisma.dQLQuestionnaire.upsert({
      where: { leadId: lead.id },
      create: {
        leadId: lead.id,
        formResponseId: formResponseId ?? null,
        responses: responses ?? {},
      },
      update: {
        formResponseId: formResponseId ?? undefined,
        responses: responses ?? {},
        submittedAt: new Date(),
      },
    });

    // Log activity
    await logActivity(SYSTEM_USER_ID, 'DQL_QUESTIONNAIRE_RECEIVED', lead.id, {
      formResponseId,
      leadIdentifier,
    });

    // Notify assigned designer + BL
    const notify = async (userId: string | null) => {
      if (!userId) return;
      await createNotification(
        userId,
        'DQL_QUESTIONNAIRE',
        `Pre-DQL questionnaire received for lead ${lead.leadId} (${lead.name})`,
        lead.id,
      );
    };
    await Promise.all([
      notify(lead.assignedDesignerId),
      notify(lead.assignedBLId),
    ]);

    res.json({ ok: true, leadId: lead.leadId });
  } catch (err: any) {
    console.error('[questionnaire:webhook]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/:id/questionnaire ──────────────────────────────────────────
questionnaireRouter.get('/', verifyToken, async (req, res) => {
  try {
    const { leadId } = req.params;
    const q = await prisma.dQLQuestionnaire.findUnique({ where: { leadId } });
    if (!q) {
      res.json({ questionnaire: null });
      return;
    }
    res.json({ questionnaire: q });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
