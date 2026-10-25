import { Worker, Queue } from 'bullmq';
import { scheduleDaily0800Ist, isWeeklyDigestDay } from './weeklyDigestDay.js';
import { connection } from './index.js';
import { prisma } from '../lib/prisma.js';
import { renderMailTemplate } from '../lib/mailTemplates.js';
import { saveDraft } from '../lib/emailService.js';
import { istDayBounds } from '../lib/istTime.js';
import { isAutomationOn } from '../lib/automations.js';

/**
 * Fix C — Client-facing Tuesday weekly digest.
 *
 * Every Tuesday at 08:00 IST (cron 30 2 * * 2 in UTC), queries all active
 * leads that have:
 *   - at least one SCHEDULED meeting, OR
 *   - at least one active EXTERNAL follow-up task
 *   …due within the current week (today through +6 days IST), AND a valid
 *   client email on file.
 *
 * For each matching lead, a review-then-send draft is created (not auto-sent)
 * so the assigned designer or BL can review it before delivery.
 */

const QUEUE_NAME = 'client-tuesday-digest';

export const clientTuesdayDigestQueue = new Queue(QUEUE_NAME, { connection });

export async function scheduleClientTuesdayDigest() {
  await scheduleDaily0800Ist(clientTuesdayDigestQueue, 'tuesday-digest', 'client-tuesday-digest-singleton');
  console.log('[jobs] Client weekly digest scheduled (08:00 IST on the day set in CRM Settings)');
}

export async function runClientTuesdayDigest(): Promise<{ digests: number }> {
  if (!(await isAutomationOn('WEEKLY_DIGEST', 'email'))) return { digests: 0 };
  const now = new Date();
  // Window: today (Tuesday) 00:00 IST through end of the following Sunday
  const { start: weekStart } = istDayBounds(now);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  // ── Leads with upcoming meetings this week ────────────────────────────────
  const leadsRaw = await prisma.lead.findMany({
    where: {
      status: 'ACTIVE',
      email: { not: null },
      OR: [
        {
          meetings: {
            some: { status: 'SCHEDULED', scheduledAt: { gte: weekStart, lt: weekEnd } },
          },
        },
        {
          followUpTasks: {
            some: {
              isCompleted: false,
              status: 'PENDING',
              taskType: 'EXTERNAL',
              dueDate: { gte: weekStart, lt: weekEnd },
            },
          },
        },
      ],
    },
    select: {
      id: true,
      leadId: true,
      name: true,
      email: true,
      meetings: {
        where: { status: 'SCHEDULED', scheduledAt: { gte: weekStart, lt: weekEnd } },
        select: { id: true, type: true, scheduledAt: true },
        orderBy: { scheduledAt: 'asc' },
      },
      followUpTasks: {
        where: {
          isCompleted: false,
          status: 'PENDING',
          taskType: 'EXTERNAL',
          dueDate: { gte: weekStart, lt: weekEnd },
        },
        select: { id: true, agenda: true, dueDate: true, dueTime: true },
        orderBy: { dueDate: 'asc' },
      },
    },
  });

  let digests = 0;
  for (const lead of leadsRaw) {
    if (!lead.email) continue;

    // Build the meeting + task list for this client's digest
    const meetingLines = lead.meetings.map((m) => {
      const when = new Date(m.scheduledAt).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      return `<li>${m.type.replace(/_/g, ' ')} — ${when}</li>`;
    });

    const taskLines = lead.followUpTasks.map((t) => {
      const day = new Date(t.dueDate).toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      const time = t.dueTime ? ` at ${t.dueTime}` : '';
      const agenda = t.agenda ? ` — ${t.agenda}` : '';
      return `<li>Follow-up${time} on ${day}${agenda}</li>`;
    });

    const allLines = [...meetingLines, ...taskLines];
    if (allLines.length === 0) continue;

    const itemsHtml = `<ul style="padding-left:18px;margin:12px 0;">${allLines.join('')}</ul>`;

    try {
      const { subject, html } = await renderMailTemplate('WEEKLY_DIGEST', {
        clientName: lead.name,
        itemsHtml,
      });
      // One draft per lead per week — key prevents duplicate drafts on retries
      const weekKey = weekStart.toISOString().slice(0, 10);
      const draftKey = `${lead.id}::WEEKLY_DIGEST::${weekKey}`;
      await saveDraft(draftKey, subject, html, { leadId: lead.id, type: 'WEEKLY_DIGEST' });
      digests++;
      console.log(`[jobs:client-tuesday-digest] Draft created for lead ${lead.leadId}`);
    } catch (e: any) {
      console.warn(`[jobs:client-tuesday-digest] Failed for lead ${lead.leadId}:`, e.message);
    }
  }

  console.log(`[jobs] Client Tuesday digest: ${digests} draft(s) created`);
  return { digests };
}

export const clientTuesdayDigestWorker = new Worker(
  QUEUE_NAME,
  async () => { if (await isWeeklyDigestDay()) await runClientTuesdayDigest(); },
  { connection },
);
