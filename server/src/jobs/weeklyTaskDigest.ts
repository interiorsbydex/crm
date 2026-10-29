import { Worker, Queue } from 'bullmq';
import { scheduleDaily0800Ist, isWeeklyDigestDay } from './weeklyDigestDay.js';
import { queueOpts, workerOpts } from './index.js';
import { prisma } from '../lib/prisma.js';
import { sendEmail } from '../lib/email.js';
import { IST_TZ, time12 } from '../lib/istTime.js';
import { isAutomationOn } from '../lib/automations.js';

/**
 * Tuesday 08:00 IST weekly digest — emails every active user who has at least
 * one open follow-up task OR an upcoming meeting this week. Covers both items
 * in a single email so staff get a unified view each Tuesday morning.
 *
 * Distinct from the 15-minute "upcoming-due-reminder" job, which fires the
 * precise 1-hour-before notification for each individual task/meeting.
 */

const QUEUE_NAME = 'weekly-task-digest';

export const weeklyTaskDigestQueue = new Queue(QUEUE_NAME, queueOpts);

export async function scheduleWeeklyTaskDigest() {
  await scheduleDaily0800Ist(weeklyTaskDigestQueue, 'weekly-digest', 'weekly-task-digest-singleton');
  console.log('[jobs] Weekly task digest scheduled (08:00 IST on the day set in CRM Settings)');
}

const MEETING_TYPE_LABELS: Record<string, string> = {
  DQL: 'DQL', PP: 'PP', PD: 'PD (Pitch Discussion)',
  ONBOARDING: 'Onboarding', OBM: 'OBM',
};

export async function runWeeklyTaskDigest(): Promise<{ emailsSent: number }> {
  if (!(await isAutomationOn('STAFF_WEEKLY_DIGEST', 'email'))) return { emailsSent: 0 };
  console.log('[jobs] Running weekly task digest (tasks + meetings)…');

  const now = new Date();
  // Digest covers the next 7 days so it captures the full work-week ahead
  const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // ── Open follow-up tasks (PENDING, not completed) ────────────────────────────
  const openTasks = await prisma.followUpTask.findMany({
    where: { isCompleted: false, status: 'PENDING' },
    include: {
      lead: { select: { leadId: true, name: true } },
      assignedTo: { select: { id: true, name: true, email: true, isActive: true } },
    },
    orderBy: { dueDate: 'asc' },
  });

  // ── Upcoming meetings scheduled in the next 7 days ───────────────────────────
  const upcomingMeetings = await prisma.meeting.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledAt: { gte: now, lt: weekEnd },
    },
    include: {
      lead: {
        select: {
          leadId: true, name: true,
          assignedDesignerId: true, assignedBLId: true,
        },
      },
    },
    orderBy: { scheduledAt: 'asc' },
  });

  // ── Build per-user digest map ────────────────────────────────────────────────
  type UserEntry = {
    name: string;
    email: string;
    tasks: typeof openTasks;
    meetings: typeof upcomingMeetings;
  };
  const byUser = new Map<string, UserEntry>();

  // Bucket tasks by assigned user
  for (const t of openTasks) {
    if (!t.assignedTo?.isActive || !t.assignedTo.email) continue;
    const entry = byUser.get(t.assignedTo.id) ?? {
      name: t.assignedTo.name, email: t.assignedTo.email, tasks: [], meetings: [],
    };
    entry.tasks.push(t);
    byUser.set(t.assignedTo.id, entry);
  }

  // Bucket meetings by the lead's designer AND BL (both get the digest)
  const meetingRecipientIds = [
    ...new Set(
      upcomingMeetings.flatMap((m) =>
        [m.lead.assignedDesignerId, m.lead.assignedBLId].filter(Boolean) as string[],
      ),
    ),
  ];
  if (meetingRecipientIds.length > 0) {
    const meetingUsers = await prisma.user.findMany({
      where: { id: { in: meetingRecipientIds }, isActive: true },
      select: { id: true, name: true, email: true },
    });
    const userMap = new Map(meetingUsers.map((u) => [u.id, u]));
    for (const m of upcomingMeetings) {
      for (const userId of [m.lead.assignedDesignerId, m.lead.assignedBLId]) {
        if (!userId) continue;
        const u = userMap.get(userId);
        if (!u?.email) continue;
        const entry = byUser.get(userId) ?? {
          name: u.name, email: u.email, tasks: [], meetings: [],
        };
        entry.meetings.push(m);
        byUser.set(userId, entry);
      }
    }
  }

  // ── Send one digest email per user ───────────────────────────────────────────
  let emailsSent = 0;
  for (const { name, email, tasks, meetings } of byUser.values()) {
    const taskRows = tasks
      .map((t) => {
        const dueStr = t.dueDate.toLocaleDateString('en-IN', {
          timeZone: IST_TZ, day: 'numeric', month: 'short',
        });
        const overdueTag = t.isOverdue
          ? ' <strong style="color:#b91c1c">(overdue)</strong>'
          : '';
        return `<li>${t.lead.leadId} — ${t.lead.name}: due ${dueStr}${
          t.dueTime ? ` at ${time12(t.dueTime)}` : ''
        }${overdueTag}${t.agenda ? ` — ${t.agenda}` : ''}</li>`;
      })
      .join('');

    const meetingRows = meetings
      .map((m) => {
        const dateStr = m.scheduledAt.toLocaleDateString('en-IN', {
          timeZone: IST_TZ, weekday: 'short', day: 'numeric', month: 'short',
        });
        const timeStr = m.scheduledAt.toLocaleTimeString('en-IN', {
          timeZone: IST_TZ, hour: '2-digit', minute: '2-digit', hour12: true,
        });
        const typeLabel = MEETING_TYPE_LABELS[m.type] ?? m.type;
        return `<li>${m.lead.leadId} — ${m.lead.name}: ${typeLabel} on ${dateStr} at ${timeStr}</li>`;
      })
      .join('');

    const taskSection = tasks.length > 0
      ? `<p><strong>Open follow-up tasks (${tasks.length}):</strong></p><ul>${taskRows}</ul>`
      : '';
    const meetingSection = meetings.length > 0
      ? `<p><strong>Upcoming meetings this week (${meetings.length}):</strong></p><ul>${meetingRows}</ul>`
      : '';

    const totalItems = tasks.length + meetings.length;
    const subject = `Weekly summary: ${tasks.length} task${tasks.length !== 1 ? 's' : ''}, ${meetings.length} meeting${meetings.length !== 1 ? 's' : ''} — Interiors by DeX CRM`;
    const html = `
      <p>Hi ${name},</p>
      <p>Here's your weekly summary for the next 7 days (${totalItems} item${totalItems !== 1 ? 's' : ''}):</p>
      ${taskSection}
      ${meetingSection}
      <p>— CRM automated reminder</p>
    `;

    try {
      await sendEmail({ to: email, subject, html });
      emailsSent++;
    } catch (e) {
      console.warn(`[weekly-task-digest] failed to email ${email}:`, (e as Error).message);
    }
  }

  console.log(`[jobs] Weekly task digest (tasks + meetings) sent to ${emailsSent} user(s).`);
  return { emailsSent };
}

export const weeklyTaskDigestWorker = new Worker(
  QUEUE_NAME,
  async () => { if (await isWeeklyDigestDay()) await runWeeklyTaskDigest(); },
  workerOpts,
);
