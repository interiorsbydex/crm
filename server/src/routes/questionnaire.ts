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
import { timingSafeEqual } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { createNotification } from '../lib/notifications.js';
import { isLeadLocked } from '../lib/leadLock.js';

export const googleFormWebhookRouter = Router();
export const questionnaireRouter = Router({ mergeParams: true });

const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID ?? 'system';

/**
 * Shared secret for the form's Apps Script (sent as the `x-google-form-secret` header; set GOOGLE_FORM_WEBHOOK_SECRET on the server).
 * Not set → 'unconfigured': the request is still accepted (with a warning) so nothing breaks until the secret is added.
 */
export function googleFormSecretCheck(provided: string | undefined, expected = process.env.GOOGLE_FORM_WEBHOOK_SECRET ?? ''): 'ok' | 'unconfigured' | 'bad' {
  if (!expected) return 'unconfigured';
  const a = Buffer.from(provided ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'bad';
}

// ── POST /api/integrations/google-form-webhook ────────────────────────────────
googleFormWebhookRouter.post('/', async (req, res) => {
  const secret = googleFormSecretCheck(req.header('x-google-form-secret'));
  if (secret === 'bad') {
    console.warn(`[google-form] Rejected a request with a missing or wrong secret from ${req.ip}`);
    res.status(401).json({ error: 'Invalid or missing secret' });
    return;
  }
  if (secret === 'unconfigured') {
    console.warn('[google-form] GOOGLE_FORM_WEBHOOK_SECRET is not configured — the webhook is unauthenticated');
  }
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
