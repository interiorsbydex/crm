import { Worker, Queue } from 'bullmq';
import { queueOpts, workerOpts } from './index.js';
import { prisma } from '../lib/prisma.js';
import { createNotification } from '../lib/notifications.js';
import { sendEmail } from '../lib/email.js';
import { renderMailTemplate } from '../lib/mailTemplates.js';
import { getCrmSettings } from '../lib/crmSettings.js';
import { isAutomationOn, automationCc } from '../lib/automations.js';

/**
 * Batch 14 item 3 — "1 hour before" (Admin → CRM Settings → reminder timing) in-app reminder for follow-up tasks and
 * meetings. Runs every 15 minutes (finer than the 60-minute window itself,
 * so a task/meeting due 61 minutes after the previous run isn't missed) and
 * notifies the assignee once per task/meeting, deduped via notificationLog.
 *
 * Distinct from the existing 15-min taskReminders.ts sweep, which is a
 * same-day/overdue digest — this one targets the precise ~60-minute-out
 * window and also covers meetings, which that sweep does not.
 */

const QUEUE_NAME = 'upcoming-due-reminder';

export const upcomingDueReminderQueue = new Queue(QUEUE_NAME, queueOpts);

export async function scheduleUpcomingDueReminder() {
  await upcomingDueReminderQueue.add(
    'upcoming-due-check',
    {},
    {
      repeat: { pattern: '*/15 * * * *' }, // every 15 minutes
      jobId: 'upcoming-due-reminder-singleton',
    },
  );
  console.log('[jobs] Upcoming due-soon reminder scheduled (every 15 min)');
}

/** Combine a task's dueDate with its dueTime/timeFrom (HH:MM) into one Date, IST wall-clock. */
function taskDueAt(dueDate: Date, hhmm: string | null): Date | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  // dueDate is stored as a UTC instant representing IST midnight of that
  // calendar day; the IST wall-clock offset is a fixed +5:30, so adding the
  // task's local HH:MM directly (minus the 5:30 already baked into the UTC
  // date) yields the correct UTC instant.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  return new Date(dueDate.getTime() + h * 60 * 60 * 1000 + m * 60 * 1000 - IST_OFFSET_MS);
}

export async function runUpcomingDueReminder(): Promise<{ taskReminders: number; meetingReminders: number; obReminders: number }> {
  const now = new Date();
  // How far ahead to remind: Admin → CRM Settings (default 60 minutes).
  const reminderMinutes = (await getCrmSettings()).reminderMinutesBefore;
  // Client reminder emails can be switched off in Admin → Automations (staff in-app reminders always run).
  const taskReminderOn = await isAutomationOn('TASK_REMINDER', 'email');
  const meetingReminderOn = await isAutomationOn('MEETING_REMINDER', 'email');
  const windowEnd = new Date(now.getTime() + reminderMinutes * 60 * 1000);
  const inAbout = reminderMinutes % 60 === 0
    ? `${reminderMinutes / 60} hour${reminderMinutes === 60 ? '' : 's'}`
    : `${reminderMinutes} minutes`;

  // ── Follow-up tasks with a specific due time, due within the next hour ──────
  const candidateTasks = await prisma.followUpTask.findMany({
    where: {
      isCompleted: false,
      status: 'PENDING',
      dueDate: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000), lt: windowEnd },
    },
    include: {
      // Fix C: include lead.email so we can auto-send the client reminder.
      lead: { select: { id: true, leadId: true, name: true, email: true } },
      assignedTo: { select: { id: true, isActive: true } },
    },
  });

  let taskReminders = 0;
  for (const t of candidateTasks) {
    if (!t.assignedTo?.isActive) continue;
    const dueAt = taskDueAt(t.dueDate, t.timeFrom ?? t.dueTime);
    if (!dueAt || dueAt < now || dueAt > windowEnd) continue;

    // Fix C: check if ANY staff notification for this task already exists
    // (not just for this assignee). If none → first run → auto-send to client.
    const anyStaffAlready = await prisma.notificationLog.findFirst({
      where: { type: 'TASK_DUE_SOON', taskId: t.id },
      select: { id: true },
    });

    if (!anyStaffAlready && t.lead.email && taskReminderOn) {
      const dueStr = t.dueDate.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
      try {
        const { subject, html } = await renderMailTemplate('TASK_REMINDER', {
          clientName: t.lead.name,
          dueDate: dueStr,
          dueTime: (t.timeFrom ?? t.dueTime) ? `${t.timeFrom ?? t.dueTime}` : 'the scheduled time',
          agendaHtml: t.agenda ? `<p>Agenda: ${t.agenda}</p>` : '',
        });
        const cc = (await automationCc('TASK_REMINDER', t.leadId)).filter((e) => e !== t.lead.email);
        await sendEmail({ to: t.lead.email, cc, subject, html });
        console.log(`[jobs:upcoming-due-reminder] Auto client reminder sent for task ${t.id} → ${t.lead.email}`);
      } catch (e: any) {
        console.warn(`[jobs:upcoming-due-reminder:task-client-email]`, e.message);
      }
    }

    const already = await prisma.notificationLog.findFirst({
      where: { userId: t.assignedToId, type: 'TASK_DUE_SOON', taskId: t.id },
      select: { id: true },
    });
    if (already) continue;

    await createNotification(
      t.assignedToId,
      'TASK_DUE_SOON',
      `Reminder: follow-up for lead ${t.lead.leadId} (${t.lead.name}) is due in about ${inAbout}${t.timeFrom ? ` at ${t.timeFrom}` : ''}`,
      t.leadId,
      dueAt,
      t.id,
    );
    taskReminders++;
  }

  // ── Scheduled meetings starting within the next hour ────────────────────────
  const candidateMeetings = await prisma.meeting.findMany({
    where: { status: 'SCHEDULED', scheduledAt: { gte: now, lt: windowEnd } },
    include: {
      // Fix C: include lead.email so we can auto-send the client reminder.
      lead: { select: { id: true, leadId: true, name: true, email: true, assignedDesignerId: true, assignedBLId: true } },
    },
  });

  let meetingReminders = 0;
  for (const m of candidateMeetings) {
    const recipientIds = [m.lead.assignedDesignerId, m.lead.assignedBLId].filter(
      (id): id is string => !!id,
    );
    if (recipientIds.length === 0) continue;

    const activeRecipients = await prisma.user.findMany({
      where: { id: { in: recipientIds }, isActive: true },
      select: { id: true },
    });

    // Fix C: send client email exactly once per meeting — on the first run that
    // finds this meeting in the window (before any staff notification exists).
    const anyMeetingNotified = await prisma.notificationLog.findFirst({
      where: { type: 'MEETING_DUE_SOON', leadId: m.lead.id, eventAt: m.scheduledAt },
      select: { id: true },
    });

    if (!anyMeetingNotified && m.lead.email && meetingReminderOn) {
      const scheduledStr = new Date(m.scheduledAt).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      try {
        const { subject, html } = await renderMailTemplate('MEETING_REMINDER', {
          clientName: m.lead.name,
          meetingType: m.type.replace(/_/g, ' ').toLowerCase(),
          scheduledAt: scheduledStr,
        });
        const cc = (await automationCc('MEETING_REMINDER', m.leadId)).filter((e) => e !== m.lead.email);
        await sendEmail({ to: m.lead.email, cc, subject, html });
        console.log(`[jobs:upcoming-due-reminder] Auto client reminder sent for meeting ${m.id} → ${m.lead.email}`);
      } catch (e: any) {
        console.warn(`[jobs:upcoming-due-reminder:meeting-client-email]`, e.message);
      }
    }

    for (const recipient of activeRecipients) {
      const already = await prisma.notificationLog.findFirst({
        where: { userId: recipient.id, type: 'MEETING_DUE_SOON', leadId: m.lead.id, eventAt: m.scheduledAt },
        select: { id: true },
      });
      if (already) continue;

      await createNotification(
        recipient.id,
        'MEETING_DUE_SOON',
        `Reminder: ${m.type} meeting for lead ${m.lead.leadId} (${m.lead.name}) starts in about ${inAbout}`,
        m.lead.id,
        m.scheduledAt,
      );
      meetingReminders++;
    }
  }

  // ── Leads with expectedObDate in the next 3 days ────────────────────────────
  const OB_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
  const obWindowEnd = new Date(now.getTime() + OB_WINDOW_MS);

  const obLeads = await prisma.lead.findMany({
    where: {
      status: 'ACTIVE',
      expectedObDate: { gte: now, lte: obWindowEnd },
    },
    select: {
      id: true,
      leadId: true,
      name: true,
      expectedObDate: true,
      assignedDesignerId: true,
      assignedBLId: true,
    },
  });

  let obReminders = 0;
  for (const lead of obLeads) {
    const recipientIds = [lead.assignedDesignerId, lead.assignedBLId].filter(
      (id): id is string => !!id,
    );
    if (recipientIds.length === 0) continue;

    const activeRecipients = await prisma.user.findMany({
      where: { id: { in: recipientIds }, isActive: true },
      select: { id: true },
    });

    for (const recipient of activeRecipients) {
      // Dedup: one reminder per lead per recipient per 48-hour window
      const already = await prisma.notificationLog.findFirst({
        where: {
          userId: recipient.id,
          type: 'OB_DATE_REMINDER',
          leadId: lead.id,
          createdAt: { gte: new Date(now.getTime() - 48 * 60 * 60 * 1000) },
        },
        select: { id: true },
      });
      if (already) continue;

      const obDate = new Date(lead.expectedObDate!).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
      });
      await createNotification(
        recipient.id,
        'OB_DATE_REMINDER',
        `Reminder: Expected OB date for ${lead.leadId} (${lead.name}) is on ${obDate}`,
        lead.id,
        lead.expectedObDate!,
      );
      obReminders++;
    }
  }

  if (taskReminders > 0 || meetingReminders > 0 || obReminders > 0) {
    console.log(`[jobs] Upcoming due-soon: ${taskReminders} task reminder(s), ${meetingReminders} meeting reminder(s), ${obReminders} OB date reminder(s).`);
  }
  return { taskReminders, meetingReminders, obReminders };
}

export const upcomingDueReminderWorker = new Worker(
  QUEUE_NAME,
  async () => { await runUpcomingDueReminder(); },
  workerOpts,
);
