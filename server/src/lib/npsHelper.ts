/**
 * NPS helper — creates an NPSResponse record and drafts the survey email for
 * review-and-send.
 *
 * Idempotency contract:
 * - A unique constraint on (leadId, stage) guarantees at most one record per lead/stage.
 * - Unsent, unanswered records without a send log remain retryable.
 * - Sent or answered surveys are not requested again.
 * - sentAt means the sender accepted the message, not confirmed inbox receipt.
 * - sentAt is only written by the onSentAction handler AFTER a human clicks
 *   Send on the draft (Batch 12c Round 3b) — never at draft-creation time —
 *   so re-triggering before it's sent just re-surfaces the same pending draft.
 */
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { renderMailTemplate } from './mailTemplates.js';
import { saveDraft, registerOnSentHandler } from './emailService.js';
import { resolveBaseUrl as resolveBaseUrlShared } from './baseUrl.js';

const NPS_STAGE_LABELS: Record<string, string> = {
  SALE: 'Sales',
  ONBOARDING: 'Onboarding',
  DESIGN_FREEZE: 'Design Freeze',
  SIGN_OFF: 'Sign Off',
};

/** Same resolution as {@link resolveBaseUrlShared}, but warns with NPS-specific context when unset. */
function resolveBaseUrl(): string | null {
  const url = resolveBaseUrlShared();
  if (!url) console.warn('[nps] Neither BASE_URL nor REPLIT_DEV_DOMAIN is configured — NPS survey email will not be sent.');
  return url;
}

export interface PendingNpsMail { draftKey: string; type: string; to: string; subject: string; html: string }

type NpsResponseClient = Pick<Prisma.TransactionClient, 'nPSResponse'>;

export async function ensureNpsResponse(
  leadId: string,
  stage: string,
  client: NpsResponseClient = prisma,
) {
  return client.nPSResponse.upsert({
    where: { leadId_stage: { leadId, stage } },
    create: { leadId, stage, formToken: randomUUID() },
    update: {},
    select: { id: true, formToken: true, sentAt: true, respondedAt: true },
  });
}

export async function getNpsSendState(leadId: string, stage: string) {
  const response = await prisma.nPSResponse.findUnique({
    where: { leadId_stage: { leadId, stage } },
    select: { sentAt: true, respondedAt: true },
  });
  // Older edited drafts could be sent without their post-send callback. The
  // existing send ledger is evidence, not permission to rewrite old records.
  const logged = response?.sentAt ? null : await prisma.emailLog.findFirst({
    where: { leadId, type: `NPS_${stage}` },
    orderBy: { sentAt: 'desc' },
    select: { sentAt: true },
  });
  const sentAt = response?.sentAt ?? logged?.sentAt ?? null;
  const respondedAt = response?.respondedAt ?? null;
  const status = respondedAt ? 'RESPONDED' as const : sentAt ? 'SENT' as const : 'NOT_SENT' as const;
  // A prepared-but-unsent draft is reported separately and never counts as sent.
  const draftPrepared = status === 'NOT_SENT'
    && !!(await prisma.emailDraft.findUnique({ where: { key: `${leadId}::NPS_${stage}` }, select: { key: true } }).catch(() => null));
  return { status, sentAt, respondedAt, draftPrepared };
}

export async function markNpsSent(
  leadId: string,
  stage: string,
  sentAt = new Date(),
  client: NpsResponseClient = prisma,
) {
  return client.nPSResponse.update({
    where: { leadId_stage: { leadId, stage } },
    data: { sentAt },
    select: { id: true, sentAt: true },
  });
}

// Each NPS stage gets its own onSentAction key so the generic draft/send
// infra can flip the right NPSResponse row's sentAt once a human actually
// sends the survey — never at draft-creation time. Registered once here
// (not per-call) since the stage set is fixed and known up front.
for (const stage of Object.keys(NPS_STAGE_LABELS)) {
  registerOnSentHandler(`NPS_SENT_${stage}`, async (leadId: string) => {
    try {
      const sent = await markNpsSent(leadId, stage);
      if (stage === 'ONBOARDING') {
        await prisma.oBOBMChecklist.updateMany({
          where: { leadId },
          data: { npsTriggered: true, npsTriggeredAt: sent.sentAt },
        });
      }
    } catch (error: any) {
      // Preserve the successful send ledger even if checklist bookkeeping fails.
      // Read paths reconcile from that ledger without resending the email.
      console.warn('[nps] Post-send status update failed:', error.message);
    }
  });
}

/**
 * Create an NPS record (if needed) and draft the survey email for
 * review-and-send.
 *
 * The (leadId, stage) unique constraint enforces one record per milestone.
 * An upsert-style approach is used: find the existing record, or create one,
 * then draft the email if sentAt is still null. Returns the pending-mail
 * descriptor the caller's route should hand back to the frontend, or null if
 * nothing needs to be drafted (already sent, no email on file, etc).
 */
export async function createAndSendNps(leadId: string, npsStage: string): Promise<PendingNpsMail | null> {
  try {
    // ── 1. Atomically find or create the record ────────────────────────────────
    // The database unique index plus upsert closes both the concurrent-trigger
    // race and later legitimate retries for the same lead/stage combination.
    const record = await ensureNpsResponse(leadId, npsStage);

    // ── 2. Idempotency: skip if the survey was already actually sent ──────────
    if (record.sentAt != null || record.respondedAt != null) return null;
    if ((await getNpsSendState(leadId, npsStage)).status !== 'NOT_SENT') return null;

    // ── 3. Resolve lead contact details ───────────────────────────────────────
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        name: true,
        email: true,
        assignedDesigner: { select: { name: true } },
      },
    });
    if (!lead) return null;

    if (!lead.email) {
      console.warn(`[nps] Lead ${leadId} has no email; NPS record created but survey email not drafted`);
      return null;
    }

    const baseUrl = resolveBaseUrl();
    if (!baseUrl) {
      // Record created / exists — email cannot be drafted without a public
      // URL for the rating link. sentAt remains null so the next trigger will retry.
      return null;
    }

    // ── 4. Build email payload ─────────────────────────────────────────────────
    const ratingUrl = `${baseUrl}/nps/${record.formToken}`;
    const stageName = NPS_STAGE_LABELS[npsStage] ?? npsStage;

    const scores = Array.from({ length: 11 }, (_, i) => i);
    const scoreLinksHtml = scores.map((i) => {
      const bg = i <= 6 ? '#f0ece8' : i <= 8 ? '#f59e0b' : '#22c55e';
      const color = i <= 6 ? '#6b7280' : '#fff';
      return `<a href="${ratingUrl}?score=${i}" style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;background:${bg};color:${color};border-radius:8px;text-decoration:none;margin:2px;font-size:13px;font-weight:700">${i}</a>`;
    }).join('');

    const rendered = await renderMailTemplate('NPS_SURVEY', {
      clientName: lead.name,
      stageName,
      ratingUrl,
      scoreLinksHtml,
    });

    // ── 5. Save as an editable draft instead of auto-sending ─────────────────
    // The onSentAction handler registered above flips this NPSResponse row's
    // sentAt once a human actually clicks Send — never at draft-creation time.
    const type = `NPS_${npsStage}`;
    const draftKey = `${leadId}::${type}`;
    await saveDraft(draftKey, rendered.subject, rendered.html, { leadId, type, onSentAction: `NPS_SENT_${npsStage}` });

    return { draftKey, type, to: lead.email, subject: rendered.subject, html: rendered.html };
  } catch (e) {
    // Log the error so operators can observe and retry; do not swallow silently.
    // sentAt remains null, so the next completion trigger will retry automatically.
    console.error(`[nps] Failed to draft NPS survey for lead ${leadId} stage ${npsStage}:`, (e as Error).message);
    return null;
  }
}
