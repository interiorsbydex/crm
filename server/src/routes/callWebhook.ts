import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { isLeadLocked } from '../lib/leadLock.js';

export const callWebhookRouter = Router();

/**
 * POST /api/calls/webhook/exotel
 *
 * Receives Exotel call completion webhook.
 * - Matches to existing Call record by phone + timestamp (within 5 min window)
 * - Updates recordingUrl + duration if match found
 * - Creates new Call record (outcome: ANSWERED, source: exotel_auto) if no match
 *
 * Expected Exotel payload:
 *   CallSid, Status, From, To, RecordingUrl, Duration, Direction
 *
 * ACTIVATION REQUIRED: set EXOTEL_SID and EXOTEL_KEY env vars when credentials are provided.
 */
callWebhookRouter.post('/exotel', async (req, res) => {
  const payload = req.body as {
    CallSid?: string;
    Status?: string;
    From?: string;
    To?: string;
    RecordingUrl?: string;
    Duration?: string;
    Direction?: string;
  };

  console.log('[exotel:webhook] Received payload:', JSON.stringify(payload, null, 2));

  try {
    const rawPhone = payload.Direction === 'inbound' ? payload.From : payload.To;
    const phone = rawPhone?.replace(/^\+91/, '').replace(/\D/g, '') ?? '';
    const durationSecs = payload.Duration ? parseInt(payload.Duration) : undefined;
    const recordingUrl = payload.RecordingUrl ?? undefined;

    if (phone) {
      // Find lead by phone number
      const lead = await prisma.lead.findFirst({
        where: {
          OR: [
            { phone: { contains: phone } },
            { phone2: { contains: phone } },
          ],
        },
        select: { id: true, status: true },
      });

      if (lead && !isLeadLocked(lead.status)) {
        // Look for a matching call within the last 5 minutes (manual log created around same time)
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
        const existing = await prisma.call.findFirst({
          where: {
            leadId: lead.id,
            createdAt: { gte: fiveMinAgo },
            recordingUrl: null,
          },
          orderBy: { createdAt: 'desc' },
        });

        if (existing) {
          // Update existing call with Exotel data
          await prisma.call.update({
            where: { id: existing.id },
            data: {
              ...(recordingUrl && { recordingUrl }),
              ...(durationSecs !== undefined && { duration: durationSecs }),
            },
          });
          console.log(`[exotel:webhook] Updated call ${existing.id} for lead ${lead.id}`);
        } else if (recordingUrl || durationSecs) {
          // Create a new auto-call record from Exotel data
          const systemUser = await prisma.user.findFirst({
            where: { role: 'BRANCH_HEAD', isActive: true },
            select: { id: true },
          });
          if (systemUser) {
            await prisma.call.create({
              data: {
                leadId: lead.id,
                loggedById: systemUser.id,
                outcome: 'ANSWERED',
                duration: durationSecs,
                recordingUrl,
                notes: `Auto-logged from Exotel (CallSid: ${payload.CallSid ?? 'unknown'})`,
              },
            });
            console.log(`[exotel:webhook] Created auto-call for lead ${lead.id}`);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err: any) {
    console.error('[exotel:webhook] Error:', err.message);
    res.sendStatus(200); // always ACK Exotel
  }
});
