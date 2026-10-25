// ── Lead status actions (task #88) ────────────────────────────────────────────
// Shared logic for moving a lead between ACTIVE / ON_HOLD / INACTIVE, and back.
// `status` is decoupled from `stage` — placing a lead on hold or marking it
// inactive never touches `stage`, so the lead's real funnel position is
// preserved and both can be displayed together (e.g. "DQL — On Hold").
//
// Used by:
//   - PATCH /api/leads/:id/status  (manual On Hold / Inactive)
//   - POST  /api/leads/:id/reactivate  (manual reactivation)
//   - jobs/midnightOverdueTask.ts  (auto-reactivation when the reopen date arrives)
// Keeping the reactivation logic in one place means the manual and automatic
// paths can never diverge.
import { randomUUID } from 'crypto';
import { prisma } from './prisma.js';
import { logActivity } from './activityLog.js';
import { createNotification } from './notifications.js';
import { sendSms } from '../services/smsService.js';
import {
  sendEmail, onHoldInternalEmail, inactiveInternalEmail,
  leadReactivatedInternalEmail,
} from './email.js';
import { renderMailTemplate } from './mailTemplates.js';
import { sendWhatsAppMessage, fillTemplate } from './whatsapp.js';
import { saveDraft } from './emailService.js';
import { isAutomationOn } from './automations.js';

// A draft descriptor surfaced to the caller (routes/leads.ts) so the UI can
// open a review-and-send flow via POST /api/email/send-draft instead of the
// mail going out immediately (Batch 12c). Only the client-facing mail is
// drafted — internal staff notifications below still send immediately.
export interface PendingMail { draftKey: string; type: string; to: string; subject: string; html: string }

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}

function externalNotesHtml(notes?: string) {
  const trimmed = notes?.trim();
  return trimmed
    ? `<p><strong>Additional note:</strong><br/>${escapeHtml(trimmed).replace(/\r?\n/g, '<br/>')}</p>`
    : '';
}

async function internalRecipientsFor(lead: { assignedBLId: string | null; assignedDesignerId: string | null }) {
  const ids = new Set<string>();
  if (lead.assignedBLId) ids.add(lead.assignedBLId);
  if (lead.assignedDesignerId) ids.add(lead.assignedDesignerId);
  const managers = await prisma.user.findMany({ where: { role: { in: ['BL', 'BRANCH_HEAD'] }, isActive: true }, select: { id: true } });
  for (const m of managers) ids.add(m.id);
  return prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, email: true } });
}

// ── Place a lead On Hold ───────────────────────────────────────────────────────
export async function putLeadOnHold(opts: {
  leadId: string;
  actorId: string;
  actorName: string;
  reason: string;
  notes?: string;
  externalNotes?: string;
  revivalDate: Date;
  notifyClient: boolean;
}) {
  const { leadId, actorId, actorName, reason, notes, externalNotes, revivalDate, notifyClient } = opts;
  const existing = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!existing) throw new Error('Lead not found');

  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: 'ON_HOLD',
      onHoldReason: reason,
      onHoldNotes: notes?.trim() || null,
      onHoldExternalNotes: externalNotes?.trim() || null,
      onHoldRevivalDate: revivalDate,
    },
  });

  await logActivity(actorId, 'STATUS_CHANGED', leadId, {
    from: existing.status, to: 'ON_HOLD', reason, notes: notes?.trim() || undefined,
  });

  const revivalStr = revivalDate.toLocaleDateString('en-IN');
  let pendingMail: PendingMail | null = null;

  const auto = {
    sms: await isAutomationOn('ON_HOLD', 'sms'),
    email: await isAutomationOn('ON_HOLD', 'email'),
    whatsapp: await isAutomationOn('ON_HOLD', 'whatsapp'),
  };
  if (existing.phone) {
    if (auto.sms) sendSms(
      existing.phone,
      `Hi ${existing.name}, your Interiors by DeX project has been put on hold until ${revivalStr}. We'll be in touch. - Interiors by DeX`,
      leadId,
    ).catch((e) => console.warn('[leadStatus:sms:on_hold]', e.message));

    if (notifyClient && existing.email && auto.email) {
      try {
        const clientNotesHtml = externalNotesHtml(externalNotes);
        const rendered = await renderMailTemplate('ON_HOLD', {
          clientName: existing.name, revivalDate: revivalStr, reason, externalNotesHtml: clientNotesHtml,
        });
        const renderedHtml = clientNotesHtml && !rendered.html.includes(clientNotesHtml)
          ? `${rendered.html}\n${clientNotesHtml}` : rendered.html;
        const draftKey = `${leadId}::ON_HOLD`;
        await saveDraft(draftKey, rendered.subject, renderedHtml, { leadId, type: 'ON_HOLD' });
        pendingMail = { draftKey, type: 'ON_HOLD', to: existing.email, subject: rendered.subject, html: renderedHtml };
      } catch (e) {
        console.error('[ON_HOLD draft failed]', e);
      }
    }

    if (auto.whatsapp) try {
      const waBody = fillTemplate('on_hold_notification', { clientName: existing.name, revivalDate: revivalStr, reason });
      const twilioSid = await sendWhatsAppMessage(existing.phone, waBody);
      if (twilioSid) {
        await prisma.whatsAppMessage.create({
          data: { leadId, direction: 'OUTBOUND', body: waBody, templateId: 'on_hold_notification', twilioSid },
        });
      }
    } catch (e) {
      console.error('[ON_HOLD whatsapp failed]', e);
    }
  }

  // Mandatory internal notification (in-app always; the email can be switched off in Admin → Automations)
  const teamEmails = await isAutomationOn('TEAM_STATUS_CHANGE', 'email');
  const internalTargets = await internalRecipientsFor(existing);
  const msg = `Lead ${existing.leadId} (${existing.name}) placed On Hold by ${actorName}. Reopens ${revivalStr}.`;
  for (const t of internalTargets) {
    await createNotification(t.id, 'LEAD_ON_HOLD', msg, leadId).catch(() => {});
    const payload = onHoldInternalEmail({
      recipientName: t.name, leadId: existing.leadId, leadName: existing.name,
      revivalDate: revivalStr, reason, movedByName: actorName,
    });
    payload.to = t.email;
    if (teamEmails) sendEmail(payload).catch(() => {});
  }

  return { lead, pendingMail };
}

// ── Mark a lead Inactive ───────────────────────────────────────────────────────
export async function markLeadInactive(opts: {
  leadId: string;
  actorId: string;
  actorName: string;
  reason: string;
  notes?: string;
  externalNotes?: string;
  notifyClient: boolean;
}) {
  const { leadId, actorId, actorName, reason, notes, externalNotes, notifyClient } = opts;
  const existing = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!existing) throw new Error('Lead not found');

  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: 'INACTIVE',
      inactiveReason: reason,
      inactiveNotes: notes?.trim() || null,
      inactiveExternalNotes: externalNotes?.trim() || null,
    },
  });

  // Mirrors the terminal-stage SLA-breach auto-resolve in routes/leads.ts —
  // an inactive lead should never keep carrying a stale breach flag.
  await prisma.sLABreach.updateMany({ where: { leadId, resolvedAt: null }, data: { resolvedAt: new Date() } });
  await prisma.lead.update({ where: { id: leadId }, data: { isSLABreached: false } });

  // Auto-clear this lead's open tasks (task-batch request) — an inactive
  // lead should never keep dangling PENDING tasks on anyone's Tasks list.
  // Uses the same terminal status/fields the manual "Not Done" action writes
  // (server/src/routes/tasks.ts PATCH /:id/not-done), with a synthetic
  // outcome so the audit trail still reads sensibly.
  await prisma.followUpTask.updateMany({
    where: { leadId, status: 'PENDING' },
    data: { status: 'NOT_DONE', isCompleted: false, outcome: 'Lead marked inactive — task auto-cleared' },
  });

  await logActivity(actorId, 'STATUS_CHANGED', leadId, {
    from: existing.status, to: 'INACTIVE', reason, notes: notes?.trim() || undefined, notifiedClient: notifyClient,
  });

  // Client-facing feedback form — only when explicitly opted in (task #88).
  let pendingMail: PendingMail | null = null;
  if (notifyClient) {
    const formToken = randomUUID();
    const baseUrl = process.env.BASE_URL ?? '';
    const feedbackUrl = `${baseUrl}/feedback/${formToken}`;

    await prisma.inactivationFeedback.upsert({
      where: { leadId },
      create: { leadId, reason, formToken, feedbackFormSentAt: new Date() },
      update: { reason, formToken, feedbackFormSentAt: new Date(), respondedAt: null, clientResponse: null },
    });

    if (existing.email && await isAutomationOn('INACTIVATION_FEEDBACK', 'email')) {
      const reasonHtml = reason ? `<p>We understand that the project may not have moved forward at this time.</p>` : '';
      const clientNotesHtml = externalNotesHtml(externalNotes);
      const rendered = await renderMailTemplate('INACTIVATION_FEEDBACK', {
        clientName: existing.name, feedbackUrl, reasonHtml, externalNotesHtml: clientNotesHtml,
      });
      const renderedHtml = clientNotesHtml && !rendered.html.includes(clientNotesHtml)
        ? `${rendered.html}\n${clientNotesHtml}` : rendered.html;
      const draftKey = `${leadId}::INACTIVATION_FEEDBACK`;
      await saveDraft(draftKey, rendered.subject, renderedHtml, { leadId, type: 'INACTIVATION_FEEDBACK' });
      pendingMail = { draftKey, type: 'INACTIVATION_FEEDBACK', to: existing.email, subject: rendered.subject, html: renderedHtml };
    }

    if (existing.phone && await isAutomationOn('INACTIVATION_FEEDBACK', 'sms')) {
      sendSms(
        existing.phone,
        `Hi ${existing.name}, thank you for your interest in Interiors by DeX. We'd love your feedback: ${feedbackUrl} - Interiors by DeX`,
        leadId,
      ).catch((e) => console.warn('[leadStatus:sms:inactive]', e.message));
    }
  }

  // Mandatory internal notification (in-app always; the email can be switched off in Admin → Automations)
  const teamEmails = await isAutomationOn('TEAM_STATUS_CHANGE', 'email');
  const internalTargets = await internalRecipientsFor(existing);
  const msg = `Lead ${existing.leadId} (${existing.name}) marked Inactive by ${actorName}. Reason: ${reason}`;
  for (const t of internalTargets) {
    await createNotification(t.id, 'LEAD_INACTIVATED', msg, leadId).catch(() => {});
    const payload = inactiveInternalEmail({
      recipientName: t.name, leadId: existing.leadId, leadName: existing.name, reason, movedByName: actorName,
    });
    payload.to = t.email;
    if (teamEmails) sendEmail(payload).catch(() => {});
  }

  return { lead, pendingMail };
}

// ── Reactivate a lead (manual or automatic) ───────────────────────────────────
export async function reactivateLead(opts: {
  leadId: string;
  actorId: string;
  actorName: string;
  reason: string;
  notes?: string;
  notifyClient: boolean;
}) {
  const { leadId, actorId, actorName, reason, notes, notifyClient } = opts;
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new Error('Lead not found');
  if (lead.status !== 'ON_HOLD' && lead.status !== 'INACTIVE') {
    throw new Error('Only leads that are On Hold or Inactive can be reactivated.');
  }

  const fromStatus = lead.status === 'ON_HOLD' ? 'On Hold' : 'Inactive';

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: 'ACTIVE',
      onHoldRevivalDate: null,
      onHoldReason: null,
      onHoldNotes: null,
      onHoldExternalNotes: null,
      inactiveReason: null,
      inactiveNotes: null,
      inactiveExternalNotes: null,
    },
    include: {
      assignedDesigner: { select: { id: true, name: true, role: true } },
      assignedBL: { select: { id: true, name: true } },
    },
  });

  await logActivity(actorId, 'LEAD_REACTIVATED', leadId, {
    from: fromStatus, reason: reason.trim(), notes: notes?.trim() || undefined, notifiedClient: notifyClient,
  });

  const teamEmails = await isAutomationOn('TEAM_STATUS_CHANGE', 'email');
  const internalTargets = await internalRecipientsFor(lead);
  const msg = `Lead ${lead.leadId} (${lead.name}) reactivated from ${fromStatus} by ${actorName}. Reason: ${reason.trim()}`;
  for (const t of internalTargets) {
    await createNotification(t.id, 'LEAD_REACTIVATED', msg, leadId).catch(() => {});
    const payload = leadReactivatedInternalEmail({
      recipientName: t.name, leadId: lead.leadId, leadName: lead.name,
      fromStatus, reason: reason.trim(), notes: notes?.trim(), reactivatedByName: actorName,
    });
    payload.to = t.email;
    if (teamEmails) sendEmail(payload).catch(() => {});
  }

  let pendingMail: PendingMail | null = null;
  if (notifyClient && lead.email && await isAutomationOn('REACTIVATION', 'email')) {
    const trimmedNotes = notes?.trim();
    const notesHtml = trimmedNotes ? `<p>${trimmedNotes}</p>` : '';
    const rendered = await renderMailTemplate('REACTIVATION', { clientName: lead.name, notesHtml });
    const draftKey = `${leadId}::REACTIVATION`;
    await saveDraft(draftKey, rendered.subject, rendered.html, { leadId, type: 'REACTIVATION' });
    pendingMail = { draftKey, type: 'REACTIVATION', to: lead.email, subject: rendered.subject, html: rendered.html };
  }

  return { lead: updated, pendingMail };
}
