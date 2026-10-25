import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { createNotification } from '../lib/notifications.js';
import { sendEmail } from '../lib/email.js';
import { saveDraft } from '../lib/emailService.js';
import { sendWhatsAppMessage, normalizePhoneE164 } from '../lib/whatsapp.js';
import { isAuthorizedForLead, isAuthorizedToAssignTask } from '../lib/leadAuth.js';
import { istDayBounds } from '../lib/istTime.js';
import { isLenientLaunch, logGateBypass } from '../lib/lenientMode.js';
import { validateGenericAttachments, type AttachmentEntry } from '../lib/attachmentValidation.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';
import { renderMailTemplate } from '../lib/mailTemplates.js';
import { validateFutureDate } from '../lib/nextPlanOfAction.js';
import { creCreatedTaskIds, type TaskWithCreatorEvidence } from '../lib/creTaskScope.js';
import { isAutomationOn } from '../lib/automations.js';

type TaskAttachmentInput = AttachmentEntry;

export const tasksRouter = Router({ mergeParams: true });
export const myTasksRouter = Router();

const taskInclude = {
  assignedTo: { select: { id: true, name: true, role: true } },
  lead: { select: { id: true, leadId: true, name: true, stage: true, email: true, phone: true } },
  // Older callback tasks predate callStageType. Include their source call so
  // they can still be represented as scheduled calls without a data migration.
  originatingCall: { select: { outcome: true, loggedBy: { select: { role: true } } } },
} as const;

// Task attachments are uploaded via the shared calls upload-attachment
// endpoint, so they live in the same private bucket as call attachments.
const TASK_ATTACHMENTS_BUCKET = 'crm-call-attachments';

// Re-signs any storagePath-based attachments on a batch of tasks so the
// client always gets a fresh, short-lived download link — mirrors the same
// hydration pattern used for Call.attachments in calls.ts.
async function hydrateTaskAttachments<T extends { attachments: unknown }>(tasks: T[]): Promise<T[]> {
  if (!supabaseAdmin) return tasks;
  return Promise.all(
    tasks.map(async (task) => {
      const attachments = task.attachments as { type: string; storagePath?: string; fileUrl?: string; fileName?: string }[] | null;
      if (!attachments?.length) return task;
      const hydrated = await Promise.all(
        attachments.map(async (att) => {
          if (!att.storagePath) return att; // legacy/external URL — return as-is
          const { data, error } = await supabaseAdmin!.storage
            .from(TASK_ATTACHMENTS_BUCKET)
            .createSignedUrl(att.storagePath, 60 * 60); // 1-hour signed URL
          return { type: att.type, fileName: att.fileName, fileUrl: error ? undefined : data?.signedUrl };
        }),
      );
      return { ...task, attachments: hydrated };
    }),
  );
}

function normalizeScheduledCallTasks<T extends {
  callStageType: string | null;
  originatingCall?: { outcome: string } | null;
}>(tasks: T[]) {
  return tasks.map(({ originatingCall, ...task }) => ({
    ...task,
    // CALLBACK rows created before the scheduled-call marker was introduced
    // are still future calls, rather than generic tasks.
    callStageType: task.callStageType ?? (originatingCall?.outcome === 'CALLBACK' ? 'OTHER' : null),
  }));
}

async function onlyCRECreatedTasks<T extends TaskWithCreatorEvidence>(tasks: T[]): Promise<T[]> {
  if (tasks.length === 0) return tasks;
  const activities = await prisma.activityLog.findMany({
    where: {
      leadId: { in: [...new Set(tasks.map((task) => task.leadId))] },
      action: { in: ['TASK_CREATED', 'CALL_SCHEDULED', 'CALL_LOGGED', 'TASK_RESCHEDULED'] },
    },
    select: {
      leadId: true, action: true, createdAt: true, meta: true,
      user: { select: { role: true } },
    },
  });
  const allowedIds = creCreatedTaskIds(tasks, activities);
  return tasks.filter((task) => allowedIds.has(task.id));
}

const TASK_TYPES = ['INTERNAL', 'EXTERNAL'] as const;

// Midnight "today" in IST — used to block past-dated tasks without punishing
// same-day creation. Must match the overdue job's own IST boundary (task
// #112) or a task could be rejected as "in the past" client-side while the
// midnight job's own definition of today would've still accepted it.
function startOfToday(): Date {
  return istDayBounds().start;
}

// Returns a pendingMail descriptor (Batch 12c) instead of auto-sending the
// client email — the caller (task create/reschedule routes) must surface it
// in the response so the UI can open a review-and-send flow via
// POST /api/email/send-draft. WhatsApp still fires immediately; only the
// email leg is drafted.
async function notifyExternalTask(
  lead: { id: string; leadId: string; name: string; email: string | null; phone: string | null },
  task: { id: string; dueDate: Date; dueTime: string | null; agenda: string | null },
  notifyClientEmail = true,
  rescheduled?: { reason: string },
): Promise<{ draftKey: string; type: string; to: string; subject: string; html: string } | null> {
  const dueStr = task.dueDate.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
  const isRescheduled = Boolean(rescheduled);
  const mailType = isRescheduled ? 'CALL_RESCHEDULED' : 'EXTERNAL_TASK';
  let pendingMail: { draftKey: string; type: string; to: string; subject: string; html: string } | null = null;
  if (notifyClientEmail && lead.email && await isAutomationOn(mailType, 'email')) {
    const { subject, html } = isRescheduled
      ? await renderMailTemplate(mailType, {
        clientName: lead.name,
        scheduledDate: dueStr,
        scheduledTime: task.dueTime ?? 'To be confirmed',
        reason: rescheduled!.reason,
        agendaHtml: task.agenda ? `<p>Agenda: ${task.agenda}</p>` : '',
      })
      : await renderMailTemplate(mailType, {
        clientName: lead.name,
        dueDate: dueStr,
        dueTime: task.dueTime ? ` at ${task.dueTime}` : '',
        agendaHtml: task.agenda ? `<p>Agenda: ${task.agenda}</p>` : '',
      });
    const draftKey = `${lead.id}::${mailType}::${task.id}`;
    await saveDraft(draftKey, subject, html, { leadId: lead.id, type: mailType });
    pendingMail = { draftKey, type: mailType, to: lead.email, subject, html };
  }
  if (lead.phone && await isAutomationOn(mailType, 'whatsapp')) {
    const waBody = isRescheduled
      ? `Hi ${lead.name}, your call has been rescheduled to ${dueStr}${task.dueTime ? ` at ${task.dueTime}` : ''}. Reason: ${rescheduled!.reason}.${task.agenda ? ` Agenda: ${task.agenda}` : ''} — Team Interiors by DeX`
      : `Hi ${lead.name}, we have a follow-up scheduled with you on ${dueStr}${task.dueTime ? ` at ${task.dueTime}` : ''}.${task.agenda ? ` Agenda: ${task.agenda}` : ''} — Team Interiors by DeX`;
    try {
      const twilioSid = await sendWhatsAppMessage(normalizePhoneE164(lead.phone), waBody);
      if (twilioSid) {
        await prisma.whatsAppMessage.create({
          data: {
            leadId: lead.id,
            direction: 'OUTBOUND',
            body: waBody,
            templateId: isRescheduled ? 'call_rescheduled' : 'external_task',
            twilioSid,
          },
        });
      }
    } catch (error: any) {
      console.warn(`[tasks:whatsapp:${isRescheduled ? 'rescheduled' : 'followup'}]`, error?.message ?? error);
    }
  }
  return pendingMail;
}

// ── GET /api/leads/:leadId/tasks ──────────────────────────────────────────────
tasksRouter.get('/', verifyToken, async (req, res) => {
  const { leadId } = req.params as { leadId: string };
  const user = req.user!;

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, assignedDesignerId: true, assignedBLId: true },
  });
  if (!lead) {
    res.status(404).json({ error: 'Lead not found' });
    return;
  }
  if (!(await isAuthorizedForLead(lead, user))) {
    res.status(403).json({ error: 'Not authorised to view tasks for this lead' });
    return;
  }

  const rawTasks = await prisma.followUpTask.findMany({
    where: { leadId },
    include: taskInclude,
    orderBy: [{ isOverdue: 'desc' }, { isCompleted: 'asc' }, { dueDate: 'asc' }],
  });

  res.json({ tasks: normalizeScheduledCallTasks(await hydrateTaskAttachments(rawTasks)) });
});

// ── POST /api/leads/:leadId/tasks ─────────────────────────────────────────────
tasksRouter.post('/', verifyToken, async (req, res) => {
  const { leadId } = req.params as { leadId: string };
  const user = req.user!;

  const { dueDate, dueTime, timeFrom, timeTo, assignedToId, taskType, agenda, attachments, notifyClient, numberOfFollowUps, internalNotes } = req.body as {
    dueDate?: string;
    dueTime?: string;
    timeFrom?: string;
    timeTo?: string;
    assignedToId?: string;
    taskType?: string;
    agenda?: string;
    attachments?: TaskAttachmentInput[];
    // Gates the client-facing follow-up email — mandatory checkbox when taskType === 'EXTERNAL'.
    notifyClient?: boolean;
    numberOfFollowUps?: number;
    // Staff-only internal notes — never shared with the client.
    internalNotes?: string;
  };

  try {
    validateGenericAttachments(attachments, 'attachments');
  } catch (err: any) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (!dueDate) {
    res.status(400).json({ error: 'dueDate is required' });
    return;
  }

  const resolvedTimeFrom = timeFrom ?? dueTime;
  try {
    validateFutureDate(dueDate, 'dueDate', resolvedTimeFrom);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
    return;
  }
  const parsedDueDate = new Date(dueDate);

  if (taskType && !TASK_TYPES.includes(taskType as any)) {
    res.status(400).json({ error: `taskType must be one of: ${TASK_TYPES.join(', ')}` });
    return;
  }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, leadId: true, name: true, email: true, phone: true, assignedDesignerId: true, assignedBLId: true, status: true },
  });
  if (!lead) {
    res.status(404).json({ error: 'Lead not found' });
    return;
  }
  if (!(await isAuthorizedForLead(lead, user))) {
    res.status(403).json({ error: 'Not authorised to create tasks for this lead' });
    return;
  }
  if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

  const resolvedAssigneeId = assignedToId ?? user.id;
  if (!(await isAuthorizedToAssignTask(resolvedAssigneeId, user))) {
    res.status(403).json({ error: 'Not authorised to assign a task to this user' });
    return;
  }

  const task = await prisma.followUpTask.create({
    data: {
      leadId,
      assignedToId: resolvedAssigneeId,
      dueDate: parsedDueDate,
      dueTime: resolvedTimeFrom,
      timeFrom: resolvedTimeFrom,
      timeTo: timeTo,
      taskType: (taskType as any) ?? undefined,
      agenda: agenda?.trim() || undefined,
      internalNotes: internalNotes?.trim() || undefined,
      attachments: attachments?.length ? (attachments as any) : undefined,
      numberOfFollowUps: typeof numberOfFollowUps === 'number' ? numberOfFollowUps : undefined,
    },
    include: taskInclude,
  });

  await logActivity(user.id, 'TASK_CREATED', leadId, { taskId: task.id, createdByRole: user.role, dueDate, assignedToId, taskType });

  if (task.assignedToId !== user.id) {
    const dueStr = parsedDueDate.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
    await createNotification(
      task.assignedToId,
      'TASK_SCHEDULED',
      `Task scheduled for ${lead.name} (${lead.leadId}) — due ${dueStr}${resolvedTimeFrom ? ` at ${resolvedTimeFrom}` : ''}`,
      leadId,
      parsedDueDate,
    );
  }

  let pendingMail: Awaited<ReturnType<typeof notifyExternalTask>> = null;
  if (taskType === 'EXTERNAL') {
    pendingMail = await notifyExternalTask(lead, { id: task.id, dueDate: parsedDueDate, dueTime: resolvedTimeFrom ?? null, agenda: agenda ?? null }, notifyClient !== false);
  }

  res.status(201).json({ task, pendingMail });
});

// ── GET /api/tasks/my ─────────────────────────────────────────────────────────
myTasksRouter.get('/my', verifyToken, async (req, res) => {
  const user = req.user!;
  const { status, createdByRole } = req.query as { status?: string; createdByRole?: string };
  if (createdByRole && createdByRole !== 'CRE') {
    res.status(400).json({ error: 'createdByRole must be CRE' });
    return;
  }

  const where: any = { assignedToId: user.id };
  // status:'PENDING' excludes RESCHEDULED/NOT_DONE archive rows, which keep
  // isCompleted:false but are terminal and must never appear as "overdue".
  if (status === 'overdue') { where.isOverdue = true; where.status = 'PENDING'; }
  else if (status === 'completed') where.status = 'COMPLETED';
  else if (status === 'not_done') where.status = 'NOT_DONE';
  else if (status === 'rescheduled') where.status = 'RESCHEDULED';
  else if (status === 'upcoming') {
    where.status = 'PENDING';
    where.isOverdue = false;
  }

  const rawTasks = await prisma.followUpTask.findMany({
    where,
    include: taskInclude,
    orderBy: [{ isOverdue: 'desc' }, { dueDate: 'asc' }],
  });

  const visibleTasks = createdByRole === 'CRE' ? await onlyCRECreatedTasks(rawTasks) : rawTasks;
  res.json({ tasks: normalizeScheduledCallTasks(await hydrateTaskAttachments(visibleTasks)) });
});

// ── GET /api/tasks/team ───────────────────────────────────────────────────────
myTasksRouter.get(
  '/team',
  verifyToken,
  requireRole('BL', 'BRANCH_HEAD'),
  async (req, res) => {
    const user = req.user!;
    const { createdByRole } = req.query as { createdByRole?: string };
    if (createdByRole && createdByRole !== 'CRE') {
      res.status(400).json({ error: 'createdByRole must be CRE' });
      return;
    }

    let teamMemberIds: string[] = [];

    if (user.role === 'BL') {
      const members = await prisma.user.findMany({
        where: { blId: user.id },
        select: { id: true },
      });
      teamMemberIds = members.map((m) => m.id);
    }
    // BRANCH_HEAD: no filter → all users

    const rawTasks = await prisma.followUpTask.findMany({
      where: user.role === 'BL' ? { assignedToId: { in: teamMemberIds } } : {},
      include: taskInclude,
      orderBy: [{ isOverdue: 'desc' }, { dueDate: 'asc' }],
    });

    const visibleTasks = createdByRole === 'CRE' ? await onlyCRECreatedTasks(rawTasks) : rawTasks;
    res.json({ tasks: normalizeScheduledCallTasks(await hydrateTaskAttachments(visibleTasks)) });
  },
);

function canActOnTask(task: { assignedToId: string }, user: { id: string; role: string }) {
  return task.assignedToId === user.id || ['BL', 'BRANCH_HEAD'].includes(user.role);
}

// ── PATCH /api/tasks/:id/complete ─────────────────────────────────────────────
// A required "outcome" note and at least one attachment must be supplied before
// a task can be marked done.
// Follow-up tasks (unlike meetings/calls) may be backdated — completedAt may be
// any date up to and including now, but never in the future.
myTasksRouter.patch('/:id/complete', verifyToken, async (req, res) => {
  const { id } = req.params;
  const user = req.user!;
  const { outcome, completedAt, attachments } = req.body as {
    outcome?: string;
    completedAt?: string;
    attachments?: { type: string; storagePath?: string }[];
  };

  const task = await prisma.followUpTask.findUnique({ where: { id } });
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (!canActOnTask(task, user)) {
    res.status(403).json({ error: 'Not authorized to complete this task' });
    return;
  }
  if (task.status !== 'PENDING') {
    res.status(400).json({ error: `Cannot complete a task that is already ${task.status}` });
    return;
  }
  const taskLead = await prisma.lead.findUnique({ where: { id: task.leadId }, select: { status: true } });
  if (isLeadLocked(taskLead?.status)) { sendLeadLockedError(res); return; }
  if (!outcome?.trim()) {
    res.status(400).json({ error: 'An outcome note is required to complete this task' });
    return;
  }
  // Lenient launch: the attachment is optional; the outcome note stays required.
  if (!attachments?.length && !isLenientLaunch()) {
    res.status(400).json({ error: 'At least one attachment is required to complete this task' });
    return;
  }

  let resolvedCompletedAt = new Date();
  if (completedAt) {
    const parsed = new Date(completedAt);
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: 'completedAt is invalid' });
      return;
    }
    if (parsed.getTime() > Date.now()) {
      res.status(400).json({ error: 'completedAt cannot be in the future' });
      return;
    }
    resolvedCompletedAt = parsed;
  }

  const updated = await prisma.followUpTask.update({
    where: { id },
    data: {
      status: 'COMPLETED',
      isCompleted: true,
      isOverdue: false,
      outcome: outcome.trim(),
      completedAt: resolvedCompletedAt,
      ...(attachments?.length ? { attachments: attachments as any } : {}),
    },
    include: taskInclude,
  });

  await logActivity(user.id, 'TASK_COMPLETED', task.leadId, { taskId: id, outcome: outcome.trim() });

  if (!attachments?.length) await logGateBypass(user.id, task.leadId, 'TASK_COMPLETED_NO_ATTACHMENT', ['Task attachment'], { taskId: id });

  res.json({ task: updated });
});

// ── PATCH /api/tasks/:id/not-done ─────────────────────────────────────────────
myTasksRouter.patch('/:id/not-done', verifyToken, async (req, res) => {
  const { id } = req.params;
  const user = req.user!;
  const { outcome } = req.body as { outcome?: string };

  const task = await prisma.followUpTask.findUnique({ where: { id } });
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (!canActOnTask(task, user)) {
    res.status(403).json({ error: 'Not authorized to update this task' });
    return;
  }
  if (task.status !== 'PENDING') {
    res.status(400).json({ error: `Cannot mark not-done a task that is already ${task.status}` });
    return;
  }
  const notDoneLead = await prisma.lead.findUnique({ where: { id: task.leadId }, select: { status: true } });
  if (isLeadLocked(notDoneLead?.status)) { sendLeadLockedError(res); return; }
  if (!outcome?.trim()) {
    res.status(400).json({ error: 'An outcome note is required to mark this task not done' });
    return;
  }

  const updated = await prisma.followUpTask.update({
    where: { id },
    data: { status: 'NOT_DONE', isCompleted: false, outcome: outcome.trim() },
    include: taskInclude,
  });

  await logActivity(user.id, 'TASK_NOT_DONE', task.leadId, { taskId: id, outcome: outcome.trim() });

  res.json({ task: updated });
});

// ── PATCH /api/tasks/:id/reschedule ───────────────────────────────────────────
myTasksRouter.patch('/:id/reschedule', verifyToken, async (req, res) => {
  const { id } = req.params;
  const user = req.user!;
  const { dueDate, dueTime, timeFrom, timeTo, reason, notifyClient } = req.body as {
    dueDate?: string;
    dueTime?: string;
    timeFrom?: string;
    timeTo?: string;
    reason?: string;
    // Gates the client-facing follow-up email when the task is EXTERNAL.
    notifyClient?: boolean;
  };

  const task = await prisma.followUpTask.findUnique({ where: { id } });
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (!canActOnTask(task, user)) {
    res.status(403).json({ error: 'Not authorized to reschedule this task' });
    return;
  }
  if (task.status !== 'PENDING') {
    res.status(400).json({ error: `Cannot reschedule a task that is already ${task.status}` });
    return;
  }
  const rescheduleLead = await prisma.lead.findUnique({ where: { id: task.leadId }, select: { status: true } });
  if (isLeadLocked(rescheduleLead?.status)) { sendLeadLockedError(res); return; }
  if (!dueDate || !reason?.trim()) {
    res.status(400).json({ error: 'dueDate and reason are required to reschedule' });
    return;
  }

  const resolvedTimeFrom = timeFrom ?? dueTime;
  try {
    validateFutureDate(dueDate, 'dueDate', resolvedTimeFrom);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
    return;
  }
  const parsedDueDate = new Date(dueDate);

  // Archive the original as RESCHEDULED (a terminal, non-actionable status —
  // mirrors the meeting reschedule pattern) and create a fresh PENDING
  // replacement carrying the new date/time, rather than mutating the
  // original task back to PENDING in place. This keeps the task's own
  // history immutable once archived and makes the RESCHEDULED status/badge
  // actually reachable, instead of every reschedule silently reusing the
  // same row and status.
  const { archived, replacement } = await prisma.$transaction(async (tx) => {
    const archivedTask = await tx.followUpTask.update({
      where: { id },
      data: {
        status: 'RESCHEDULED',
        isCompleted: false,
        isOverdue: false,
        outcome: reason.trim(),
      },
      include: taskInclude,
    });
    const replacementTask = await tx.followUpTask.create({
      data: {
        leadId: task.leadId,
        assignedToId: task.assignedToId,
        dueDate: parsedDueDate,
        dueTime: resolvedTimeFrom,
        timeFrom: resolvedTimeFrom,
        timeTo: timeTo ?? undefined,
        taskType: task.taskType,
        agenda: task.agenda,
        originatingCallId: task.originatingCallId,
        // A rescheduled call must remain a scheduled call in the Call tab,
        // rather than becoming an unrelated generic task.
        callStageType: task.callStageType,
        // Carry forward the full prior chain so the active task always
        // reflects every reschedule, not just the immediately preceding one.
        rescheduleHistory: [
          ...(Array.isArray(task.rescheduleHistory) ? task.rescheduleHistory : []),
          {
            dueDate: task.dueDate,
            dueTime: task.dueTime,
            reason: reason.trim(),
            rescheduledAt: new Date().toISOString(),
            previousTaskId: task.id,
          },
        ],
      },
      include: taskInclude,
    });
    await tx.activityLog.create({
      data: {
        userId: user.id,
        action: 'TASK_RESCHEDULED',
        leadId: task.leadId,
        meta: { originalTaskId: id, replacementTaskId: replacementTask.id, createdByRole: user.role, dueDate, reason: reason.trim() },
        createdAt: replacementTask.createdAt,
      },
    });
    return { archived: archivedTask, replacement: replacementTask };
  });

  let pendingMail: Awaited<ReturnType<typeof notifyExternalTask>> = null;
  if (task.taskType === 'EXTERNAL') {
    const lead = await prisma.lead.findUnique({
      where: { id: task.leadId },
      select: { id: true, leadId: true, name: true, email: true, phone: true },
    });
    if (lead) {
      pendingMail = await notifyExternalTask(
        lead,
        { id: replacement.id, dueDate: parsedDueDate, dueTime: resolvedTimeFrom ?? null, agenda: task.agenda },
        notifyClient !== false,
        { reason: reason.trim() },
      );
    }
  }

  res.json({ task: archived, replacementTask: replacement, pendingMail });
});
