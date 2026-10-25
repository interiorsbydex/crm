import { Router } from 'express';
import twilio from 'twilio';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { createNotification } from '../lib/notifications.js';
import {
  sendWhatsAppMessage,
  fillTemplate,
  WA_TEMPLATES,
  isTwilioConfigured,
} from '../lib/whatsapp.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';

/**
 * Verifies that an inbound WhatsApp webhook request genuinely came from
 * Twilio using the `X-Twilio-Signature` header (HMAC-SHA1 of the request URL
 * + sorted form params, keyed by TWILIO_AUTH_TOKEN) — see
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security. Without this,
 * anything claiming to be from a matching phone number would be accepted and
 * silently attributed to that lead's conversation thread.
 *
 * TWILIO_AUTH_TOKEN missing means we have no way to verify — that is treated
 * as a failed verification (fail closed), not a bypass, since a spoofed
 * request could otherwise reach production if the secret was never set.
 */
function isVerifiedTwilioRequest(req: import('express').Request): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.header('X-Twilio-Signature');
  if (!authToken || !signature) return false;

  // Twilio signs the exact public URL it POSTed to. BASE_URL is the same
  // configured base used elsewhere (e.g. NPS survey links) to build
  // externally-reachable URLs, so the signed URL matches what Twilio has on
  // file for the webhook regardless of how the request reached this process
  // (proxy, load balancer, etc).
  const base = (process.env.BASE_URL ?? '').replace(/\/$/, '');
  const url = `${base}/api/whatsapp/webhook`;

  return twilio.validateRequest(authToken, signature, url, req.body as Record<string, string>);
}

export const whatsappRouter = Router();
export const leadWhatsAppRouter = Router({ mergeParams: true });

// ── POST /api/whatsapp/send ───────────────────────────────────────────────────
whatsappRouter.post('/send', verifyToken, async (req, res) => {
  const user = req.user!;

  const { leadId, body: rawBody, templateId, templateVars } = req.body as {
    leadId?: string;
    body?: string;
    templateId?: string;
    templateVars?: Record<string, string>;
  };

  if (!leadId) { res.status(400).json({ error: 'leadId is required' }); return; }
  if (!rawBody && !templateId) { res.status(400).json({ error: 'body or templateId is required' }); return; }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, leadId: true, name: true, phone: true, status: true },
  });
  if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
  if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }
  if (!lead.phone) { res.status(400).json({ error: 'Lead has no phone number' }); return; }

  let messageBody = rawBody ?? '';
  if (templateId) {
    messageBody = fillTemplate(templateId, { clientName: lead.name, ...templateVars });
  }

  // Save record to DB first — always, even if Twilio is not configured
  let twilioSid: string | null = null;
  let deliveryWarning: string | undefined;

  if (isTwilioConfigured()) {
    try {
      const sid = await sendWhatsAppMessage(lead.phone, messageBody);
      if (!sid) throw new Error('The WhatsApp provider did not accept the message.');
      twilioSid = sid;
    } catch (e: any) {
      const detail = e?.message || 'Unknown error';
      console.error('[whatsapp] Send failed:', detail);
      deliveryWarning = `WhatsApp delivery failed: ${detail}`;
    }
  } else {
    deliveryWarning = 'WhatsApp is not connected. Message saved but not delivered via Twilio. An administrator must add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER.';
  }

  const message = await prisma.whatsAppMessage.create({
    data: {
      leadId,
      direction: 'OUTBOUND',
      body: messageBody,
      templateId,
      sentById: user.id,
      twilioSid,
      isRead: true,
    },
  });

  await logActivity(user.id, 'WHATSAPP_SENT', leadId, { templateId, twilioSid });

  res.status(201).json({ message, sent: !deliveryWarning, warning: deliveryWarning });
});

// ── POST /api/whatsapp/webhook — Twilio inbound ───────────────────────────────
whatsappRouter.post('/webhook', async (req, res) => {
  if (!isVerifiedTwilioRequest(req)) {
    console.warn(
      `[whatsapp:webhook] Rejected unverified inbound request from ${req.ip} — ` +
      `missing/invalid X-Twilio-Signature (claimed From: ${(req.body as any)?.From ?? 'unknown'})`,
    );
    res.status(403).send('Forbidden');
    return;
  }

  const { From, Body, MessageSid } = req.body as {
    From?: string;
    Body?: string;
    MessageSid?: string;
  };

  if (!From || !Body) {
    res.status(400).send('Bad request');
    return;
  }

  // Twilio's From is like "whatsapp:+919876543210". Match on the last 10 digits
  // (with endsWith, not contains) so it works regardless of whether the lead's
  // stored number has a country code or formatting, and check phone2 too.
  const digits = From.replace('whatsapp:', '').replace(/[^\d]/g, '');
  if (digits.length < 10) {
    console.log(`[whatsapp:webhook] Ignoring malformed sender "${From}"`);
    res.status(200).send('<Response/>');
    return;
  }
  const last10 = digits.slice(-10);

  const lead = await prisma.lead.findFirst({
    where: {
      OR: [
        { phone: { endsWith: last10 } },
        { phone2: { endsWith: last10 } },
      ],
    },
    include: {
      assignedDesigner: { select: { id: true } },
      assignedBL: true,
    },
  });

  if (!lead) {
    console.log(`[whatsapp:webhook] Unmatched phone ${digits}`);
    res.status(200).send('<Response/>');
    return;
  }

  const message = await prisma.whatsAppMessage.create({
    data: {
      leadId: lead.id,
      direction: 'INBOUND',
      body: Body,
      twilioSid: MessageSid,
      isRead: false,
    },
  });

  // Notify assigned designer
  if (lead.assignedDesignerId) {
    await createNotification(
      lead.assignedDesignerId,
      'RNR_ESCALATION', // reusing as generic type; spec doesn't define a WA type
      `New WhatsApp from ${lead.name}: "${Body.substring(0, 80)}${Body.length > 80 ? '…' : ''}"`,
      lead.id,
    );
  }
  // Notify BL
  if (lead.assignedBLId) {
    await createNotification(
      lead.assignedBLId,
      'RNR_ESCALATION',
      `WhatsApp inbound from ${lead.name} (${lead.leadId})`,
      lead.id,
    );
  }

  // Respond with empty TwiML so Twilio doesn't retry
  res.setHeader('Content-Type', 'text/xml');
  res.send('<Response/>');
});

// ── GET /api/leads/:leadId/whatsapp — full thread ─────────────────────────────
leadWhatsAppRouter.get('/', verifyToken, async (req, res) => {
  const { leadId } = req.params as { leadId: string };

  const messages = await prisma.whatsAppMessage.findMany({
    where: { leadId },
    include: { sentBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  // Mark inbound as read
  await prisma.whatsAppMessage.updateMany({
    where: { leadId, direction: 'INBOUND', isRead: false },
    data: { isRead: true },
  });

  res.json({ messages });
});

// ── GET /api/whatsapp/inbox — role-scoped ────────────────────────────────────
whatsappRouter.get('/inbox', verifyToken, async (req, res) => {
  const user = req.user!;

  let leadFilter: any = {};

  if (user.role === 'DESIGNER') {
    leadFilter = { assignedDesignerId: user.id };
  } else if (user.role === 'BL') {
    const teamMembers = await prisma.user.findMany({
      where: { blId: user.id },
      select: { id: true },
    });
    leadFilter = { assignedDesignerId: { in: teamMembers.map((m) => m.id) } };
  }
  // BRANCH_HEAD + ADMIN → no filter (all leads)

  // Get all leads matching filter that have WhatsApp messages
  const leads = await prisma.lead.findMany({
    where: {
      ...leadFilter,
      whatsappMessages: { some: {} },
    },
    include: {
      whatsappMessages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      _count: { select: { whatsappMessages: { where: { isRead: false, direction: 'INBOUND' } } } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const inbox = leads.map((lead) => ({
    leadId: lead.id,
    leadNumber: lead.leadId,
    leadName: lead.name,
    latestMessage: lead.whatsappMessages[0] ?? null,
    unreadCount: lead._count.whatsappMessages,
  }));

  const totalUnread = inbox.reduce((acc, row) => acc + row.unreadCount, 0);

  res.json({ inbox, totalUnread });
});
