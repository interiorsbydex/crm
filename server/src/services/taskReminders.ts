import { prisma } from '../lib/prisma.js';
import { createNotification } from '../lib/notifications.js';
import { IST_TZ as TZ, istDayBounds } from '../lib/istTime.js';

/**
 * Sends an in-app reminder to the assignee for every incomplete follow-up task
 * due today (IST) or overdue. Deduped: max one reminder per task per IST day.
 */
export async function runTaskReminderSweep() {
  const { start, end } = istDayBounds();

  const tasks = await prisma.followUpTask.findMany({
    // status: 'PENDING' excludes RESCHEDULED/NOT_DONE archive rows — those
    // keep isCompleted:false but are terminal and must not generate reminders.
    where: { isCompleted: false, status: 'PENDING', dueDate: { lt: end } },
    include: {
      lead: { select: { id: true, leadId: true, name: true } },
      assignedTo: { select: { id: true, isActive: true } },
    },
  });

  let sent = 0;
  for (const t of tasks) {
    if (!t.assignedTo?.isActive) continue;

    const dueToday = t.dueDate >= start;
     const message = dueToday
       ? `Reminder: follow-up for lead ${t.lead.leadId} (${t.lead.name}) is due today${t.dueTime ? ` at ${t.dueTime}` : ''}`
       : `Reminder: follow-up for lead ${t.lead.leadId} (${t.lead.name}) is overdue since ${t.dueDate.toLocaleDateString('en-IN', { timeZone: TZ })}`;

    // Dedupe: one TASK_DUE reminder per task per IST day. Keyed on the task's
    // own taskId rather than embedding the internal task identifier in the
    // user-visible message. Two same-day tasks for the same lead are distinct.
    const already = await prisma.notificationLog.findFirst({
      where: {
        userId: t.assignedToId,
        type: 'TASK_DUE',
        taskId: t.id,
        createdAt: { gte: start },
      },
      select: { id: true },
    });
    if (already) continue;

    await createNotification(t.assignedToId, 'TASK_DUE', message, t.leadId, t.dueDate, t.id);
    sent++;
  }
  if (sent > 0) console.log(`[task-reminders] sent ${sent} reminder(s)`);
  return sent;
}

/** In-process loop — intentionally not BullMQ (Redis quota constraints). */
export function startTaskReminderLoop(intervalMs = 15 * 60 * 1000) {
  runTaskReminderSweep().catch((e) => console.warn('[task-reminders]', e.message));
  setInterval(() => {
    runTaskReminderSweep().catch((e) => console.warn('[task-reminders]', e.message));
  }, intervalMs);
}
