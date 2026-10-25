/**
 * Shared meeting-scheduling logic used by both the standalone
 * `POST /leads/:leadId/meetings` route and the call-log MEETING_SCHEDULED
 * outcome (Task #86's next-plan-of-action work). Both entry points must
 * preserve the same invariants — one active (SCHEDULED) meeting per lead at
 * a time, correct PP/sequence numbering, and the full set of side effects
 * (activity log, stakeholder notifications, client confirmation email/SMS,
 * milestone recalculation, auto intent-rating) — so this logic lives in one
 * place instead of being duplicated (and drifting) per call site.
 */
import { prisma } from './prisma.js';
import { logActivity } from './activityLog.js';
import { createNotification } from './notifications.js';
import { renderMailTemplate } from './mailTemplates.js';
import { saveDraft } from './emailService.js';
import { supabaseAdmin } from './supabase.js';
import type { EmailAttachment } from './email.js';
import { recalculateMilestones } from './milestones.js';
import { computeAutoRatingFromMode } from '../services/intentScoring.js';
import { sendSms } from '../services/smsService.js';
import type { Prisma, PrismaClient } from '@prisma/client';

type Tx = Omit<PrismaClient, '$transaction' | '$connect' | '$disconnect' | '$on' | '$use' | '$extends'> | Prisma.TransactionClient;

/** Normalizes an optional human-entered meeting location for every scheduling
 * path. Location is descriptive (for example, "Prestige Lakeside Habitat,
 * Tower 4") rather than a fixed meeting-mode category. */
export function normalizeMeetingLocation(value: unknown, fieldName = 'location'): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${fieldName} must be text`);
  const location = value.trim();
  if (!location) return undefined;
  if (location.length > 250) throw new Error(`${fieldName} must be 250 characters or fewer`);
  return location;
}

export interface ScheduleMeetingLead {
  id: string;
  leadId: string;
  name: string;
  email: string | null;
  phone: string | null;
  assignedDesignerId: string | null;
  assignedBLId: string | null;
}

/**
 * Throws if the lead already has a SCHEDULED meeting. Call this before
 * creating a new one — from either entry point — so a lead can never end up
 * with two concurrently-active meetings.
 *
 * `excludeMeetingId` lets a caller that is itself in the process of moving a
 * SCHEDULED meeting to a terminal status (e.g. MOM completion) check for any
 * *other* active meeting without being blocked by the very meeting it is
 * completing — that meeting is still SCHEDULED at read time (its own status
 * update runs later in the same transaction), so without this exclusion the
 * check would always see it and reject.
 */
export async function assertNoActiveMeeting(leadId: string, excludeMeetingId?: string): Promise<void> {
  const activeMeeting = await prisma.meeting.findFirst({
    where: { leadId, status: 'SCHEDULED', ...(excludeMeetingId ? { id: { not: excludeMeetingId } } : {}) },
    select: { id: true, type: true, scheduledAt: true },
  });
  if (activeMeeting) {
    const activeDate = new Date(activeMeeting.scheduledAt).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit',
    });
    throw new Error(
      `A ${activeMeeting.type} meeting is already scheduled for ${activeDate}. Reschedule or mark no-show before creating a new one.`,
    );
  }
}

/** Auto-numbers PP meetings and computes the per-type display sequence — excludes RESCHEDULED rows so a reschedule doesn't shift later numbering. */
export async function computeMeetingNumbering(leadId: string, type: string): Promise<{ ppNumber: number | null; seqNumber: number }> {
  let ppNumber: number | null = null;
  if (type === 'PP') {
    const existingPP = await prisma.meeting.count({ where: { leadId, type: 'PP', status: { not: 'RESCHEDULED' } } });
    ppNumber = existingPP + 1;
  }
  const seqCount = await prisma.meeting.count({ where: { leadId, type: type as any, status: { not: 'RESCHEDULED' } } });
  return { ppNumber, seqNumber: seqCount + 1 };
}

export interface CreateMeetingRecordParams {
  leadId: string;
  type: string;
  mode: string;
  scheduledAt: string;
  location?: string;
  ppNumber: number | null;
  originatingCallId?: string;
  internalNotes?: string;
}

/** Creates the Meeting row itself using the given client (pass a transaction's `tx` to keep it atomic with a caller's other writes). Does not perform any side effects. */
export async function createMeetingRecord(tx: Tx, params: CreateMeetingRecordParams) {
  return tx.meeting.create({
    data: {
      leadId: params.leadId,
      type: params.type as any,
      ppNumber: params.ppNumber,
      mode: params.mode as any,
      scheduledAt: new Date(params.scheduledAt),
      location: params.location?.trim() || undefined,
      confirmationSent: true,
      originatingCallId: params.originatingCallId,
      internalNotes: params.internalNotes?.trim() || undefined,
    },
    include: { lead: { select: { id: true, leadId: true, name: true, email: true } } },
  });
}

export interface MeetingScheduledSideEffectsParams {
  meeting: { id: string };
  lead: ScheduleMeetingLead;
  user: { id: string; role: string };
  type: string;
  mode: string;
  scheduledAt: string;
  ppNumber: number | null;
  /** Gates the client-facing confirmation email only — internal notifications/SMS/milestones still fire. Defaults to true for call sites that predate the mandatory checkbox (Task: client-mail rules). */
  notifyClient?: boolean;
  /** Files uploaded while booking the meeting, to include in the confirmation draft. */
  bookingAttachments?: { storagePath: string; fileName?: string }[];
}

export interface PendingMeetingMail { draftKey: string; type: string; to: string; subject: string; html: string }

/**
 * Fires every side effect the canonical meeting scheduler performs once a
 * meeting row exists: activity log, stakeholder notifications, client
 * confirmation email + SMS, milestone recalculation, and auto intent-rating.
 * Call this AFTER the meeting record itself has committed (i.e. after the
 * transaction, if one was used) — these are best-effort/derived actions, not
 * part of the meeting's own atomic write.
 *
 * Batch 12c Round 3a: the client-facing confirmation mail is no longer
 * auto-queued — it's saved as a draft and returned so the caller's route can
 * hand it back to the frontend for mandatory review-and-send. Everything
 * else (notifications, milestones, intent rating, SMS) still fires
 * immediately/unattended as before.
 */
export async function runMeetingScheduledSideEffects(params: MeetingScheduledSideEffectsParams): Promise<PendingMeetingMail | null> {
  const { meeting, lead, user, type, mode, scheduledAt, ppNumber, notifyClient = true, bookingAttachments } = params;
  const leadId = lead.id;

  await logActivity(user.id, 'MEETING_SCHEDULED', leadId, { meetingId: meeting.id, type, ppNumber, scheduledAt, scheduledByRole: user.role });

  // Notify the assigned BL/designer (whoever didn't book it) that a meeting was scheduled
  {
    const meetingLabel = ppNumber ? `PP${ppNumber}` : type;
    const dateStr = new Date(scheduledAt).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
    const notifyIds = new Set([lead.assignedBLId, lead.assignedDesignerId].filter(
      (id): id is string => !!id && id !== user.id,
    ));
    await Promise.all(
      [...notifyIds].map((id) =>
        createNotification(id, 'MEETING_SCHEDULED', `${meetingLabel} meeting scheduled for ${lead.name} (${lead.leadId}) on ${dateStr}`, leadId, new Date(scheduledAt)),
      ),
    );
  }

  // Draft the confirmation email — gated by the mandatory "send externally?"
  // checkbox on the booking form. No longer auto-queued; the caller's route
  // returns this to the frontend for a mandatory review-and-send.
  let pendingMail: PendingMeetingMail | null = null;
  if (notifyClient && lead.email) {
    const designer = await prisma.user.findUnique({ where: { id: user.id }, select: { name: true } });
    const meetingDateStr = new Date(scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const emailAttachments: EmailAttachment[] = [];
    if (bookingAttachments?.length && supabaseAdmin) {
      for (const attachment of bookingAttachments) {
        const { data, error } = await supabaseAdmin.storage
          .from('crm-call-attachments')
          .download(attachment.storagePath);
        if (error || !data) {
          console.warn(`[meetingScheduler:confirmation-email] Could not download attachment ${attachment.storagePath}: ${error?.message ?? 'no data'}`);
          continue;
        }
        const originalName = attachment.fileName ?? attachment.storagePath.split('/').pop() ?? 'attachment';
        emailAttachments.push({
          filename: originalName,
          content: Buffer.from(await data.arrayBuffer()).toString('base64'),
          contentType: data.type || undefined,
        });
      }
    }
    const attachmentsHtml = emailAttachments.length
      ? `<p><strong>Attachments:</strong> ${emailAttachments.length} file(s) attached to this email.</p>`
      : '';
    const rendered = await renderMailTemplate('MEETING_CONFIRMATION', {
      clientName: lead.name,
      type: ppNumber ? `PP${ppNumber}` : type,
      mode,
      scheduledAt: meetingDateStr,
      designerName: designer?.name ?? 'Your Designer',
      attachmentsHtml,
    });
    // Older admin-edited templates may not contain the newer
    // {{attachmentsHtml}} placeholder. Keep the attachment information visible
    // in those templates too, rather than silently omitting it from the body.
    const renderedHtml = emailAttachments.length && !rendered.html.includes('Attachments:')
      ? `${rendered.html}\n${attachmentsHtml}`
      : rendered.html;
    const draftKey = `${leadId}::MEETING_CONFIRMATION::${meeting.id}`;
    await saveDraft(
      draftKey,
      rendered.subject,
      renderedHtml,
      { leadId, type: 'MEETING_CONFIRMATION' },
      emailAttachments.length ? emailAttachments : undefined,
    );
    pendingMail = { draftKey, type: 'MEETING_CONFIRMATION', to: lead.email, subject: rendered.subject, html: renderedHtml };
  }

  await recalculateMilestones(leadId);

  // ── Auto intent rating from meeting mode ──────────────────────────────────
  // Only applies when the current source is "auto" or not yet set — a manual
  // override from the designer is never auto-downgraded. Both the Lead update
  // AND the IntentRatingLog audit row must succeed together.
  {
    const currentLead = await prisma.lead.findUnique({ where: { id: leadId }, select: { intentRatingSource: true, intentRating: true } });
    if (!currentLead?.intentRatingSource || currentLead.intentRatingSource === 'auto') {
      const autoRating = computeAutoRatingFromMode(mode);
      await prisma.$transaction([
        prisma.lead.update({ where: { id: leadId }, data: { intentRating: autoRating, intentRatingSource: 'auto' } }),
        prisma.intentRatingLog.create({
          data: { leadId, systemRating: autoRating, finalRating: autoRating, reason: `Auto-set from ${mode} meeting (meeting ID: ${meeting.id})` },
        }),
      ]);
      await logActivity(user.id, 'INTENT_RATING_UPDATED', leadId, { rating: autoRating, systemRating: autoRating, reason: `Auto-set from ${mode} meeting mode`, isAuto: true });
    }
  }

  // SMS: meeting confirmation (auto-trigger)
  if (lead.phone) {
    const meetingLabel = ppNumber ? `PP${ppNumber}` : type;
    const dateStr = new Date(scheduledAt).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    sendSms(lead.phone, `Hi ${lead.name}, your ${meetingLabel} meeting is confirmed for ${dateStr}. - Interiors by DeX`, leadId)
      .catch((e) => console.warn('[meetingScheduler:sms:scheduled]', e.message));
  }

  return pendingMail;
}
