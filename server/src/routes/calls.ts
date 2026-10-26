import multer from 'multer';
import { isLenientLaunch, logGateBypass } from '../lib/lenientMode.js';
import { Router } from 'express';
import { getCrmSettings } from '../lib/crmSettings.js';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { createNotification, notifyManagers } from '../lib/notifications.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { isAuthorizedForLead, isAuthorizedToAssignTask } from '../lib/leadAuth.js';
import { renderMailTemplate } from '../lib/mailTemplates.js';
import { sendEmail, type EmailAttachment } from '../lib/email.js';
import { saveDraft } from '../lib/emailService.js';
import { assertNextPlanMeetingSchedulable, createNextPlanRecords, runNextPlanMeetingSideEffects, sendNextPlanMails, summarizeNextPlanItems, validateFutureDate, validateMeetingTypeMode, validateNextPlanItems, type NextPlanItem } from '../lib/nextPlanOfAction.js';
import { assertNoActiveMeeting, computeMeetingNumbering, createMeetingRecord, runMeetingScheduledSideEffects } from '../lib/meetingScheduler.js';
import { validateAttachmentPairing, validateGenericAttachments } from '../lib/attachmentValidation.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';
import { isAutomationOn, automationCc } from '../lib/automations.js';

export const callsRouter = Router({ mergeParams: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const CALL_ATTACHMENT_TYPES = ['Lifestyle Capture', 'Proposal', 'Pitch Presentation'] as const;

const RNR_OUTCOMES = ['RNR_1', 'RNR_2', 'RNR_3', 'RNR_4', 'RNR_5', 'RNR_6_PLUS'] as const;

const VALID_OUTCOMES = ['ANSWERED', 'RNR_1', 'RNR_2', 'RNR_3', 'RNR_4', 'RNR_5', 'RNR_6_PLUS', 'CALLBACK', 'MEETING_SCHEDULED'];

// Same stage vocabulary as MeetingType, since a scheduled call is typically
// "the DQL call", "the PP call", etc. — kept as a plain string on FollowUpTask
// rather than the MeetingType enum since this is a call, not a meeting.
const CALL_STAGE_TYPES = ['DQL', 'PP', 'PD', 'ONBOARDING', 'OBM', 'OTHER'];
const CALL_TASK_TYPES = ['INTERNAL', 'EXTERNAL'];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] ?? char);
}

async function sendInternalCallNotes(
  lead: { id: string; leadId: string; name: string; assignedDesignerId: string | null; assignedBLId: string | null },
  user: { name: string },
  notes: string,
): Promise<void> {
  if (!(await isAutomationOn('TEAM_INTERNAL_CALL_NOTES', 'email'))) return;
  const recipientIds = new Set<string>(
    [lead.assignedDesignerId, lead.assignedBLId].filter((id): id is string => !!id),
  );
  const managers = await prisma.user.findMany({
    where: { role: { in: ['BL', 'BRANCH_HEAD'] }, isActive: true },
    select: { id: true },
  });
  managers.forEach((manager) => recipientIds.add(manager.id));

  // Everyone associated with the lead/project also gets the internal trail:
  // the assigned CRE, the project designer, and approved project team members.
  const associated = await prisma.lead.findUnique({
    where: { id: lead.id },
    select: {
      assignedCREId: true,
      project: { select: { designerId: true, teamMembers: { where: { status: 'APPROVED' }, select: { userId: true } } } },
    },
  });
  if (associated?.assignedCREId) recipientIds.add(associated.assignedCREId);
  if (associated?.project?.designerId) recipientIds.add(associated.project.designerId);
  associated?.project?.teamMembers.forEach((m) => recipientIds.add(m.userId));

  const recipients = await prisma.user.findMany({
    where: { id: { in: [...recipientIds] } },
    select: { email: true },
  });
  const subject = `Internal call notes — ${lead.leadId} — ${lead.name}`;
  const html = `<p><strong>Internal call notes</strong></p>
<p><strong>Lead:</strong> ${escapeHtml(lead.leadId)} — ${escapeHtml(lead.name)}<br/>
<strong>Added by:</strong> ${escapeHtml(user.name)}</p>
<p>${escapeHtml(notes.trim()).replace(/\r?\n/g, '<br/>')}</p>
<p><em>Interiors by DeX CRM — internal only</em></p>`;

  await Promise.all(
    recipients
      .map((recipient) => recipient.email)
      .filter((email): email is string => !!email)
      .map(async (email) => {
        try {
          await sendEmail({ to: email, subject, html });
          await prisma.emailLog.create({
            data: { leadId: lead.id, type: 'INTERNAL_CALL_NOTES', sentTo: email, subject },
          }).catch((error) => console.warn('[calls:internal-notes] Email log write failed:', error.message));
        } catch (error: any) {
          console.warn(`[calls:internal-notes] Could not send to ${email}:`, error?.message ?? error);
        }
      }),
  );
}

// ── POST /api/leads/:leadId/calls ─────────────────────────────────────────────
callsRouter.post('/', verifyToken, async (req, res) => {
  let followUpWasSkipped = false;
  const { leadId } = req.params as { leadId: string };
  const user = req.user!;

  const {
    outcome,
    duration,
    notes,
    externalNotes,
    externalNotesAttachments,
    recordingUrl,
    location,
    calledAt,
    attachments,
    followUpTask,
    callbackDetails,
    meetingDetails,
    nextPlanOfAction,
    notifyClient,
    scheduledCallId,
  } = req.body as {
    outcome: string;
    duration?: number;
    // "Internal Notes" — staff-only, never sent to the client.
    notes?: string;
    // "External Notes" (+ optional attachments) — the ONLY notes content
    // allowed into the ANSWERED-call auto-mail below.
    externalNotes?: string;
    externalNotesAttachments?: { fileName?: string; fileUrl?: string; storagePath?: string }[];
    recordingUrl?: string;
    location?: string;
    calledAt?: string;
    attachments?: { type: string; fileUrl?: string; storagePath?: string }[];
    followUpTask?: { dueDate: string; dueTime?: string; assignedToId?: string; attachments?: { type: string; fileUrl?: string; storagePath?: string }[] };
    // Required when outcome === 'CALLBACK': asks for date/time + agenda
    callbackDetails?: { dueDate: string; dueTime?: string; agenda?: string; assignedToId?: string; attachments?: { type: string; fileUrl?: string; storagePath?: string }[] };
    // Required when outcome === 'MEETING_SCHEDULED': creates a linked Meeting instead of a follow-up task.
    // notifyClient gates the client-facing confirmation email — mandatory checkbox on the call-log form.
    meetingDetails?: { type: string; mode: string; scheduledAt: string; location?: string; notifyClient?: boolean };
    // Shared Call/Meeting/Task multi-select "next plan of action" flow
    nextPlanOfAction?: NextPlanItem[];
    // Gates the ANSWERED-outcome call-summary and CALLBACK-outcome scheduled-call client emails — mandatory checkbox on the call-log form.
    notifyClient?: boolean;
    // The scheduled-call task to close after its call log is successfully saved.
    scheduledCallId?: string;
  };

  if (!outcome) {
    res.status(400).json({ error: 'outcome is required' });
    return;
  }

  if (!VALID_OUTCOMES.includes(outcome)) {
    res.status(400).json({ error: `outcome must be one of: ${VALID_OUTCOMES.join(', ')}` });
    return;
  }

  if (calledAt) {
    const parsedCalledAt = new Date(calledAt);
    if (Number.isNaN(parsedCalledAt.getTime())) {
      res.status(400).json({ error: 'calledAt is invalid' });
      return;
    }
    if (parsedCalledAt.getTime() > Date.now()) {
      res.status(400).json({ error: 'The call date and time cannot be in the future' });
      return;
    }
  }

  // Call notes are mandatory (Internal Notes)
  if (!notes?.trim()) {
    res.status(400).json({ error: 'Call notes are required' });
    return;
  }

  // External Notes attachments are optional, but if present must all be real
  // uploaded files — same "type is a fixed label, file must exist" shape as
  // the other generic attachment fields on this route.
  if (externalNotesAttachments?.length) {
    try {
      validateGenericAttachments(
        externalNotesAttachments.map((a) => ({ type: 'External Notes', ...a })),
        'externalNotesAttachments',
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }
  }

  if (outcome === 'CALLBACK') {
    try {
      validateGenericAttachments(callbackDetails?.attachments, 'callbackDetails.attachments');
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!callbackDetails?.dueTime) {
      res.status(400).json({ error: 'callbackDetails.dueDate and dueTime are required when outcome is CALLBACK' });
      return;
    }
    try {
      validateFutureDate(callbackDetails?.dueDate, 'callbackDetails.dueDate', callbackDetails?.dueTime);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }
  } else if (outcome === 'MEETING_SCHEDULED') {
    try {
      validateMeetingTypeMode(meetingDetails?.type, meetingDetails?.mode, meetingDetails?.scheduledAt, 'meetingDetails', meetingDetails?.location);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }
  } else {
    // Enforce mandatory follow-up with both date and time for every other outcome
    try {
      validateGenericAttachments(followUpTask?.attachments, 'followUpTask.attachments');
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }
    // Lenient launch: the follow-up is optional when neither date nor time was
    // given. If the user started filling it in, it is still validated.
    // Whether a follow-up is required: Admin → CRM Settings → Calls.
    const followUpSkipped = !(await getCrmSettings()).calls.requireFollowUp && !followUpTask?.dueDate && !followUpTask?.dueTime;
    followUpWasSkipped = followUpSkipped;
    if (!followUpSkipped && !followUpTask?.dueTime) {
      res.status(400).json({
        error: 'A follow-up task with due date and time must be set before saving the call',
      });
      return;
    }
    try {
      if (!followUpSkipped) validateFutureDate(followUpTask?.dueDate, 'followUpTask.dueDate', followUpTask?.dueTime);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }
  }

  if (attachments?.length) {
    try {
      validateAttachmentPairing(attachments, CALL_ATTACHMENT_TYPES, 'attachments');
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }
  }

  if (nextPlanOfAction?.length) {
    try {
      validateNextPlanItems(nextPlanOfAction);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }
    // The call outcome itself may already schedule a meeting (MEETING_SCHEDULED);
    // combining that with a next-plan MEETING item would try to create two
    // meetings for the same lead in one request, defeating the single-active-
    // meeting guard (which only sees committed state, not this in-flight batch).
    if (outcome === 'MEETING_SCHEDULED' && nextPlanOfAction.some((item) => item.kind === 'MEETING')) {
      res.status(400).json({ error: 'Cannot include a next-plan MEETING item when the call outcome itself is MEETING_SCHEDULED' });
      return;
    }
  }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, leadId: true, name: true, phone: true, email: true, createdAt: true, assignedDesignerId: true, assignedBLId: true, status: true },
  });
  if (!lead) {
    res.status(404).json({ error: 'Lead not found' });
    return;
  }
  if (!(await isAuthorizedForLead(lead, user))) {
    res.status(403).json({ error: 'Not authorised to log calls for this lead' });
    return;
  }
  if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }
  if (scheduledCallId) {
    const scheduledCall = await prisma.followUpTask.findUnique({ where: { id: scheduledCallId } });
    if (!scheduledCall || scheduledCall.leadId !== leadId || !scheduledCall.callStageType || scheduledCall.status !== 'PENDING') {
      res.status(400).json({ error: 'The selected scheduled call is no longer available to complete' });
      return;
    }
    if (scheduledCall.assignedToId !== user.id && !['BL', 'BRANCH_HEAD'].includes(user.role)) {
      res.status(403).json({ error: 'Not authorised to complete this scheduled call' });
      return;
    }
  }

  // callbackDetails/followUpTask may target another user's queue — the same
  // reporting-scope rule task creation uses applies here so a caller can't
  // use a call log as a side channel to assign a follow-up to an arbitrary user.
  for (const target of [callbackDetails?.assignedToId, followUpTask?.assignedToId]) {
    if (target && !(await isAuthorizedToAssignTask(target, user))) {
      res.status(403).json({ error: 'Not authorised to assign a follow-up to this user' });
      return;
    }
  }

  // A call that schedules a meeting must obey the same one-active-meeting-per-lead
  // invariant as the standalone meeting scheduler, and needs the same PP/sequence
  // numbering — computed up-front so it can be used inside the transaction below.
  let meetingPpNumber: number | null = null;
  if (outcome === 'MEETING_SCHEDULED') {
    try {
      await assertNoActiveMeeting(leadId);
    } catch (err: any) {
      res.status(409).json({ error: err.message });
      return;
    }
    ({ ppNumber: meetingPpNumber } = await computeMeetingNumbering(leadId, meetingDetails!.type));
  }

  // Same guard/numbering for a next-plan-of-action MEETING item (mutually
  // exclusive with the above per the check earlier in this handler).
  let nextPlanMeetingPpNumber: number | null = null;
  if (nextPlanOfAction?.length) {
    try {
      nextPlanMeetingPpNumber = await assertNextPlanMeetingSchedulable(nextPlanOfAction, leadId);
    } catch (err: any) {
      res.status(409).json({ error: err.message });
      return;
    }
  }

  // Create call + follow-up task / linked meeting in a transaction
  const { call, task, meeting, nextPlanMeeting } = await prisma.$transaction(async (tx) => {
    const newCall = await tx.call.create({
      data: {
        leadId,
        loggedById: user.id,
        outcome: outcome as any,
        duration,
        notes,
        externalNotes: externalNotes?.trim() || undefined,
        externalNotesAttachments: externalNotesAttachments?.length ? externalNotesAttachments : undefined,
        recordingUrl,
        location: location?.trim() || undefined,
        calledAt: calledAt ? new Date(calledAt) : undefined,
        attachments: attachments ?? undefined,
        nextPlanOfAction: nextPlanOfAction?.length ? summarizeNextPlanItems(nextPlanOfAction) : undefined,
        nextPlanOfActionItems: nextPlanOfAction?.length ? (nextPlanOfAction as any) : undefined,
      },
    });

    let newTask: Awaited<ReturnType<typeof tx.followUpTask.create>> | null = null;
    let newMeeting: Awaited<ReturnType<typeof tx.meeting.create>> | null = null;

    // Timestamp used for the CALL_LOGGED activity row so it lines up with
    // whatever follow-up record was created (kept for historical consistency
    // with other activity timestamps on the lead).
    let logAt = new Date();

    if (outcome === 'CALLBACK') {
      newTask = await tx.followUpTask.create({
        data: {
          leadId,
          assignedToId: callbackDetails!.assignedToId ?? user.id,
          dueDate: new Date(callbackDetails!.dueDate),
          dueTime: callbackDetails!.dueTime,
          timeFrom: callbackDetails!.dueTime,
          agenda: callbackDetails!.agenda?.trim() || undefined,
          originatingCallId: newCall.id,
          // A callback is a future call, not a generic to-do. Mark it with
          // the same discriminator used by the Schedule Call flow so it is
          // rendered consistently across the lead activity and call views.
          callStageType: 'OTHER',
          attachments: callbackDetails!.attachments?.length ? (callbackDetails!.attachments as any) : undefined,
        },
      });
      logAt = newTask.createdAt;
    } else if (outcome === 'MEETING_SCHEDULED') {
      newMeeting = await createMeetingRecord(tx, {
        leadId,
        type: meetingDetails!.type,
        mode: meetingDetails!.mode,
        scheduledAt: meetingDetails!.scheduledAt,
        location: meetingDetails!.location,
        ppNumber: meetingPpNumber,
        originatingCallId: newCall.id,
      });
      logAt = newMeeting.createdAt;
    } else if (followUpTask?.dueDate && followUpTask?.dueTime) {
      newTask = await tx.followUpTask.create({
        data: {
          leadId,
          assignedToId: followUpTask!.assignedToId ?? user.id,
          dueDate: new Date(followUpTask!.dueDate),
          dueTime: followUpTask!.dueTime,
          timeFrom: followUpTask!.dueTime,
          originatingCallId: newCall.id,
          attachments: followUpTask!.attachments?.length ? (followUpTask!.attachments as any) : undefined,
        },
      });
      logAt = newTask.createdAt;
    } else {
      // Lenient launch: call logged with no follow-up task.
      logAt = newCall.createdAt;
    }

    await tx.activityLog.create({
      data: {
        userId: user.id,
        action: 'CALL_LOGGED',
        leadId,
        meta: { outcome, duration, ...(newTask ? { taskId: newTask.id, createdByRole: user.role } : {}) },
        createdAt: logAt,
      },
    });

    if (scheduledCallId) {
      const completed = await tx.followUpTask.updateMany({
        where: { id: scheduledCallId, leadId, status: 'PENDING', callStageType: { not: null } },
        data: {
          status: 'COMPLETED',
          isCompleted: true,
          isOverdue: false,
          outcome: `Call logged: ${outcome.replace(/_/g, ' ')}`,
          completedAt: new Date(),
        },
      });
      if (completed.count !== 1) {
        throw new Error('The selected scheduled call could not be completed');
      }
      await tx.activityLog.create({
        data: {
          userId: user.id,
          action: 'TASK_COMPLETED',
          leadId,
          meta: { taskId: scheduledCallId, source: 'SCHEDULED_CALL_LOG' },
        },
      });
    }

    // Shared "next plan of action" multi-select — creates any extra linked
    // Call/Meeting/Task records beyond the mandatory follow-up above, in the
    // SAME transaction as the call itself so a mid-batch failure rolls the
    // whole call log back instead of reporting success on a partial plan.
    let nextPlanMeeting: Awaited<ReturnType<typeof createNextPlanRecords>>['meetingCreated'] = null;
    if (nextPlanOfAction?.length) {
      ({ meetingCreated: nextPlanMeeting } = await createNextPlanRecords(tx, nextPlanOfAction, {
        leadId, userId: user.id, userRole: user.role, originatingCallId: newCall.id, meetingPpNumber: nextPlanMeetingPpNumber,
      }));
    }

    return { call: newCall, task: newTask, meeting: newMeeting, nextPlanMeeting };
  });

  // Best-effort per-item client mail — only fired once the transaction above
  // has committed, so a mail failure never rolls back a persisted plan.
  if (nextPlanOfAction?.length) {
    await sendNextPlanMails(nextPlanOfAction, { id: lead.id, name: lead.name, email: lead.email });
  }

  // A next-plan-created meeting needs the same side effects as any other
  // scheduled meeting — fired only after the transaction above has committed.
  if (nextPlanMeeting) {
    await runNextPlanMeetingSideEffects(
      nextPlanMeeting,
      { id: lead.id, leadId: lead.leadId, name: lead.name, email: lead.email, phone: lead.phone, assignedDesignerId: lead.assignedDesignerId, assignedBLId: lead.assignedBLId },
      user,
    );
  }

  // A call-created meeting must go through the same side effects (activity
  // log, stakeholder notifications, client confirmation email/SMS, milestone
  // recalculation, auto intent-rating) as the standalone meeting scheduler —
  // fired only after the transaction above has committed the meeting row.
  if (outcome === 'MEETING_SCHEDULED' && meeting) {
    await runMeetingScheduledSideEffects({
      meeting,
      lead: { id: lead.id, leadId: lead.leadId, name: lead.name, email: lead.email, phone: lead.phone, assignedDesignerId: lead.assignedDesignerId, assignedBLId: lead.assignedBLId },
      user,
      type: meetingDetails!.type,
      mode: meetingDetails!.mode,
      scheduledAt: meetingDetails!.scheduledAt,
      ppNumber: meetingPpNumber,
      notifyClient: meetingDetails!.notifyClient !== false,
    });
  }

  // Notify the assigned BL (if not the one who logged the call) that a call happened
  if (lead.assignedBLId && lead.assignedBLId !== user.id) {
    await createNotification(
      lead.assignedBLId,
      'CALL_LOGGED',
      `Call logged for ${lead.name} (${lead.leadId}) — outcome: ${outcome.replace(/_/g, ' ')}`,
      leadId,
    );
  }

  // Notify the follow-up task's assignee (if not the one who logged the call)
  if (task && task.assignedToId !== user.id) {
    const dueStr = new Date(task.dueDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
    await createNotification(
      task.assignedToId,
      'TASK_SCHEDULED',
      `Follow-up task scheduled for ${lead.name} (${lead.leadId}) — due ${dueStr}${task.dueTime ? ` at ${task.dueTime}` : ''}`,
      leadId,
      new Date(task.dueDate),
    );
  }

  // Internal notes are sent only to the internal project team. The
  // client-facing draft below uses externalNotes exclusively.
  await sendInternalCallNotes(lead, user, notes!.trim());

  // Once a call is logged as successfully answered, prepare a client mail
  // draft (External Notes + follow-up plan, CC'ing the designer, BL, and
  // management) instead of auto-sending — the caller must explicitly review
  // and send it via POST /api/email/send-draft (Batch 12c). Internal Notes
  // (`notes`) must NEVER be read in this block — that is the enforcement
  // point that keeps internal content off client mail.
  let pendingMail: { draftKey: string; type: string; to: string; cc: string[]; subject: string; html: string } | null = null;
  if (outcome === 'ANSWERED' && notifyClient !== false && lead.email && await isAutomationOn('CALL_LOG_SUMMARY', 'email')) {
    const followUpDate = task
      ? new Date(task.dueDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) + (task.dueTime ? ` at ${task.dueTime}` : '')
      : meeting
        ? new Date(meeting.scheduledAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })
        : 'To be confirmed';

    // Who is copied is set in Admin → Automations (applied again when it's sent).
    const cc = await automationCc('CALL_LOG_SUMMARY', lead.id);

    // External Notes files are stored in a private bucket. Download their
    // bytes while creating the draft so the preview identifies them and the
    // eventual send includes real email attachments, rather than relying on a
    // short-lived signed URL that the client does not send back here.
    const emailAttachments: EmailAttachment[] = [];
    if (externalNotesAttachments?.length && supabaseAdmin) {
      for (const attachment of externalNotesAttachments) {
        if (!attachment.storagePath) continue;
        const { data, error } = await supabaseAdmin.storage
          .from(CALL_ATTACHMENTS_BUCKET)
          .download(attachment.storagePath);
        if (error || !data) {
          console.warn(`[calls:summary-email] Could not download attachment ${attachment.storagePath}: ${error?.message ?? 'no data'}`);
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

    const attachmentLinks = externalNotesAttachments?.length
      ? externalNotesAttachments
          .filter((a) => a.fileUrl)
          .map((a) => `<p><a href="${a.fileUrl}">${a.fileName ?? 'View attachment'}</a></p>`)
          .join('')
      : '';
    const attachmentsHtml = [
      emailAttachments.length
        ? `<p><strong>Attachments:</strong> ${emailAttachments.length} file(s) attached to this email.</p>`
        : '',
      attachmentLinks,
    ].join('');

    const { subject, html } = await renderMailTemplate('CALL_LOG_SUMMARY', {
      clientName: lead.name,
      externalNotes: externalNotes?.trim() || 'No additional notes shared.',
      attachmentsHtml,
      followUpDate,
    });
    const renderedHtml = emailAttachments.length && !html.includes('Attachments:')
      ? `${html}\n${attachmentsHtml}`
      : html;
    const finalSubject = emailAttachments.length || attachmentLinks
      ? `${subject} (Attachment included)`
      : subject;
    const draftKey = `${leadId}::CALL_LOG_SUMMARY::${call.id}`;
    await saveDraft(draftKey, finalSubject, renderedHtml, { leadId, type: 'CALL_LOG_SUMMARY' }, emailAttachments.length ? emailAttachments : undefined);
    pendingMail = { draftKey, type: 'CALL_LOG_SUMMARY', to: lead.email, cc, subject: finalSubject, html: renderedHtml };
  }

  // Callback Scheduled outcome → draft the same client "Call Scheduled" email
  // as the Schedule a Call flow. Returned as a draft for review; never auto-sent.
  if (outcome === 'CALLBACK' && task && notifyClient !== false && lead.email && await isAutomationOn('CALL_SCHEDULED', 'email')) {
    const scheduledDate = new Date(task.dueDate).toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric',
    });
    const callbackAgenda = task.agenda?.trim();
    const { subject, html } = await renderMailTemplate('CALL_SCHEDULED', {
      clientName: lead.name,
      stageType: 'Follow-up',
      scheduledDate,
      scheduledTime: task.dueTime ?? '',
      agendaHtml: callbackAgenda ? `<p><strong>Agenda:</strong> ${callbackAgenda}</p>` : '',
    });
    const cbDraftKey = `${leadId}::CALL_SCHEDULED::${task.id}`;
    await saveDraft(cbDraftKey, subject, html, { leadId, type: 'CALL_SCHEDULED' });
    const cbCc = await automationCc('CALL_SCHEDULED', lead.id);
    pendingMail = { draftKey: cbDraftKey, type: 'CALL_SCHEDULED', to: lead.email, cc: cbCc, subject, html };
  }

  // RNR escalation logic
  const rnrCount = await prisma.call.count({
    where: { leadId, outcome: { in: [...RNR_OUTCOMES] } },
  });

  let needsEscalation = false;
  let needsInactivationPrompt = false;
  const callRules = (await getCrmSettings()).calls;

  if (rnrCount >= callRules.rnrEscalationAfter) {
    needsEscalation = true;

    // Check if 3 months have passed since lead creation
    const monthsOld =
      (Date.now() - lead.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30);

    if (monthsOld >= callRules.rnrInactivationMonths) {
      needsInactivationPrompt = true;
    } else {
      // Notify BL about escalation need
      await notifyManagers(
        'RNR_ESCALATION',
        `Lead ${lead.leadId} (${lead.name}) has ${rnrCount} RNR attempts. Escalation review needed.`,
        leadId,
      );
    }
  }

  if (followUpWasSkipped) await logGateBypass(req.user!.id, leadId, 'CALL_FOLLOWUP_SKIPPED', ['Follow-up task after call']);

  res.status(201).json({
    call,
    followUpTask: task,
    meeting,
    needsEscalation,
    needsInactivationPrompt,
    openCallLogTab: true,
    pendingMail,
  });
});

// ── POST /api/leads/:leadId/calls/schedule ────────────────────────────────────
// Distinct entry point for scheduling a call that hasn't happened yet — separate
// from POST '/' above (Log Call), which always records a call that already took
// place. Creates a FollowUpTask marked with callStageType so it renders as a
// "Scheduled Call" wherever calls/tasks are shown, and can later be completed
// (logged) or rescheduled through the existing follow-up task flow.
callsRouter.post('/schedule', verifyToken, async (req, res) => {
  const { leadId } = req.params as { leadId: string };
  const user = req.user!;

  const { stageType, agenda, taskType, dueDate, dueTime, assignedToId, notifyClient } = req.body as {
    stageType: string;
    agenda?: string;
    taskType: string;
    dueDate: string;
    dueTime: string;
    assignedToId?: string;
    notifyClient?: boolean;
  };

  if (!stageType || !CALL_STAGE_TYPES.includes(stageType)) {
    res.status(400).json({ error: `stageType must be one of: ${CALL_STAGE_TYPES.join(', ')}` });
    return;
  }
  if (!taskType || !CALL_TASK_TYPES.includes(taskType)) {
    res.status(400).json({ error: `taskType must be one of: ${CALL_TASK_TYPES.join(', ')}` });
    return;
  }
  if (notifyClient !== undefined && typeof notifyClient !== 'boolean') {
    res.status(400).json({ error: 'notifyClient must be a boolean' });
    return;
  }
  if (!dueDate || !dueTime) {
    res.status(400).json({ error: 'dueDate and dueTime are required to schedule a call' });
    return;
  }
  try {
    validateFutureDate(dueDate, 'dueDate', dueTime);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
    return;
  }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, leadId: true, name: true, email: true, assignedDesignerId: true, assignedBLId: true, status: true },
  });
  if (!lead) {
    res.status(404).json({ error: 'Lead not found' });
    return;
  }
  if (!(await isAuthorizedForLead(lead, user))) {
    res.status(403).json({ error: 'Not authorised to schedule calls for this lead' });
    return;
  }
  if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

  if (assignedToId && !(await isAuthorizedToAssignTask(assignedToId, user))) {
    res.status(403).json({ error: 'Not authorised to assign a scheduled call to this user' });
    return;
  }

  const task = await prisma.followUpTask.create({
    data: {
      leadId,
      assignedToId: assignedToId ?? user.id,
      dueDate: new Date(dueDate),
      dueTime,
      timeFrom: dueTime,
      agenda: agenda?.trim() || undefined,
      taskType: taskType as any,
      callStageType: stageType,
    },
  });

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'CALL_SCHEDULED',
      leadId,
      meta: { taskId: task.id, createdByRole: user.role, stageType, taskType, dueDate, dueTime },
      createdAt: task.createdAt,
    },
  });

  if (task.assignedToId !== user.id) {
    const dueStr = new Date(task.dueDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
    await createNotification(
      task.assignedToId,
      'TASK_SCHEDULED',
      `Call scheduled for ${lead.name} (${lead.leadId}) — ${stageType} call due ${dueStr} at ${dueTime}`,
      leadId,
      new Date(task.dueDate),
    );
  }

  // ── External call → draft a client notification email ───────────────────────
  // Mirrors the answered-call pendingMail flow: the draft is returned to the
  // UI which shows an EmailPreviewModal; the user reviews then sends or discards.
  let pendingMail: { draftKey: string; type: string; to: string; cc?: string[]; subject: string; html: string } | null = null;
  if (taskType === 'EXTERNAL' && notifyClient !== false && lead.email && await isAutomationOn('CALL_SCHEDULED', 'email')) {
    const scheduledDate = new Date(dueDate).toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric',
    });
    const agendaHtml = agenda?.trim()
      ? `<p><strong>Agenda:</strong> ${agenda.trim()}</p>`
      : '';
    const stageLabel = stageType === 'OTHER' ? 'Follow-up' : stageType;
    const { subject, html } = await renderMailTemplate('CALL_SCHEDULED', {
      clientName: lead.name,
      stageType: stageLabel,
      scheduledDate,
      scheduledTime: dueTime,
      agendaHtml,
    });
    const draftKey = `${leadId}::CALL_SCHEDULED::${task.id}`;
    await saveDraft(draftKey, subject, html, { leadId, type: 'CALL_SCHEDULED' });
    const cc = await automationCc('CALL_SCHEDULED', lead.id);
    pendingMail = { draftKey, type: 'CALL_SCHEDULED', to: lead.email, cc, subject, html };
  }

  res.status(201).json({ scheduledCall: task, pendingMail });
});

// ── Allowed MIME types for call attachments ───────────────────────────────────
const ALLOWED_ATTACHMENT_MIMES = new Set([
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const ALLOWED_ATTACHMENT_EXTS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp', 'ppt', 'pptx', 'doc', 'docx']);
const CALL_ATTACHMENTS_BUCKET = 'crm-call-attachments'; // private bucket

// ── GET /api/leads/:leadId/calls ──────────────────────────────────────────────
callsRouter.get('/', verifyToken, async (req, res) => {
  const { leadId } = req.params as { leadId: string };
  const user = req.user!;

  // Enforce lead-scope authorization before exposing signed attachment URLs
  const scopeLead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, assignedDesignerId: true, assignedBLId: true, createdAt: true },
  });
  if (!scopeLead) { res.status(404).json({ error: 'Lead not found' }); return; }
  if (!(await isAuthorizedForLead(scopeLead, user))) {
    res.status(403).json({ error: 'Not authorised to view calls for this lead' });
    return;
  }

  const rawCalls = await prisma.call.findMany({
    where: { leadId },
    include: { loggedBy: { select: { id: true, name: true, role: true } } },
    orderBy: { createdAt: 'desc' },
  });

  // Generate fresh signed URLs for any call attachments stored as storagePaths
  const calls = await Promise.all(
    rawCalls.map(async (call) => {
      const attachments = call.attachments as { type: string; storagePath?: string; fileUrl?: string }[] | null;
      if (!attachments?.length || !supabaseAdmin) return call;
      const hydratedAttachments = await Promise.all(
        attachments.map(async (att) => {
          if (!att.storagePath) return att; // legacy public URL — return as-is
          const { data, error } = await supabaseAdmin!.storage
            .from(CALL_ATTACHMENTS_BUCKET)
            .createSignedUrl(att.storagePath, 60 * 60); // 1-hour signed URL
          return { type: att.type, fileUrl: error ? undefined : data?.signedUrl };
        }),
      );
      return { ...call, attachments: hydratedAttachments };
    }),
  );

  const rnrCount = rawCalls.filter((c) => RNR_OUTCOMES.includes(c.outcome as any)).length;

  // Scheduled-but-not-yet-made calls (created via "Schedule Call") — surfaced
  // in the same response so the Call tab can render them alongside logged
  // calls, clearly distinguished, without a second round-trip.
  const scheduledCalls = await prisma.followUpTask.findMany({
    where: { leadId, callStageType: { not: null }, status: 'PENDING' },
    include: { assignedTo: { select: { id: true, name: true, role: true } } },
    orderBy: { dueDate: 'asc' },
  });

  const callRules = (await getCrmSettings()).calls;
  const pastAttemptLimit = rnrCount >= callRules.rnrEscalationAfter;
  // Same rule as when a call is logged: an old enough lead gets the "make it inactive" prompt instead of escalation.
  const monthsOld = (Date.now() - scopeLead.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30);
  const needsInactivationPrompt = pastAttemptLimit && monthsOld >= callRules.rnrInactivationMonths;
  res.json({ calls, rnrCount, needsEscalation: pastAttemptLimit && !needsInactivationPrompt, needsInactivationPrompt, scheduledCalls });
});

// ── POST /api/leads/:leadId/calls/upload-attachment ───────────────────────────
callsRouter.post(
  '/upload-attachment',
  verifyToken,
  upload.single('file') as any,
  async (req, res) => {
    try {
      const { leadId } = req.params as { leadId: string };

      // Verify the lead exists and the requester is authorised for it
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { id: true, assignedDesignerId: true, assignedBLId: true, status: true },
      });
      if (!lead) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      if (!(await isAuthorizedForLead(lead, req.user!))) {
        res.status(403).json({ error: 'Not authorised to upload files for this lead' });
        return;
      }
      if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      // Validate MIME type and extension
      const ext = (file.originalname.split('.').pop() ?? '').toLowerCase();
      if (!ALLOWED_ATTACHMENT_MIMES.has(file.mimetype) || !ALLOWED_ATTACHMENT_EXTS.has(ext)) {
        res.status(400).json({
          error: `Unsupported file type. Allowed types: PDF, images (JPG, PNG, WebP), Word, and PowerPoint.`,
        });
        return;
      }

      if (!supabaseAdmin) {
        res.status(500).json({ error: 'Supabase storage not configured' });
        return;
      }

      // Use private bucket — never public
      await supabaseAdmin.storage.createBucket(CALL_ATTACHMENTS_BUCKET, { public: false }).catch(() => {});

      const storagePath = `${leadId}/${Date.now()}.${ext}`;
      const { error: uploadError } = await supabaseAdmin.storage
        .from(CALL_ATTACHMENTS_BUCKET)
        .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
      if (uploadError) {
        res.status(500).json({ error: uploadError.message });
        return;
      }

      // Return a short-lived signed URL for immediate display, plus the storagePath for DB storage
      const { data: signed, error: signError } = await supabaseAdmin.storage
        .from(CALL_ATTACHMENTS_BUCKET)
        .createSignedUrl(storagePath, 60 * 60); // 1 hour
      if (signError) {
        res.status(500).json({ error: signError.message });
        return;
      }

      // Client stores storagePath in DB; signedUrl is for immediate display only
      res.json({ storagePath, signedUrl: signed?.signedUrl });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ── Standalone calls router ───────────────────────────────────────────────────
export const callsStandaloneRouter = Router();

// ── GET /api/calls — role-scoped cross-lead call activity ───────────────────
callsStandaloneRouter.get('/', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    let leadScope: any = null;

    if (user.role === 'DESIGNER' || user.role === 'CRE') {
      leadScope = { assignedDesignerId: user.id };
    } else if (user.role === 'BL') {
      const members = await prisma.user.findMany({
        where: { blId: user.id },
        select: { id: true },
      });
      leadScope = {
        OR: [
          { assignedBLId: user.id },
          { assignedDesignerId: { in: members.map((member) => member.id) } },
        ],
      };
    } else if (!['ADMIN', 'BRANCH_HEAD'].includes(user.role)) {
      res.status(403).json({ error: 'Not authorised to view calls' });
      return;
    }

    // Mirror isAuthorizedForLead, which also protects each lead's Call Log.
    // Branch Heads and admins see all; other roles stay within lead scope.
    const scopedLead = leadScope ? { lead: leadScope } : {};
    const [calls, scheduledCalls] = await Promise.all([
      prisma.call.findMany({
        where: scopedLead,
        select: {
          id: true,
          outcome: true,
          duration: true,
          notes: true,
          agenda: true,
          calledAt: true,
          createdAt: true,
          loggedBy: { select: { id: true, name: true, role: true } },
          lead: { select: { id: true, leadId: true, name: true } },
        },
        orderBy: [{ calledAt: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.followUpTask.findMany({
        where: {
          status: 'PENDING',
          callStageType: { not: null },
          ...(leadScope ? { lead: leadScope } : {}),
        },
        select: {
          id: true,
          dueDate: true,
          dueTime: true,
          timeFrom: true,
          timeTo: true,
          isOverdue: true,
          status: true,
          agenda: true,
          callStageType: true,
          assignedTo: { select: { id: true, name: true, role: true } },
          lead: { select: { id: true, leadId: true, name: true, stage: true } },
        },
        orderBy: [{ dueDate: 'asc' }, { dueTime: 'asc' }],
      }),
    ]);

    res.json({ calls, scheduledCalls });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

callsStandaloneRouter.get('/:id/recording-url', verifyToken, async (req, res) => {
  try {
    const call = await prisma.call.findUnique({
      where: { id: req.params.id },
      select: { id: true, recordingUrl: true },
    });
    if (!call) { res.status(404).json({ error: 'Call not found' }); return; }
    // Stub: returns recordingUrl from DB.
    // Will proxy Exotel API for fresh signed URLs when EXOTEL_SID is configured.
    res.json({ recordingUrl: call.recordingUrl ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
