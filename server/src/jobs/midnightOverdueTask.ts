import { Worker, Queue } from 'bullmq';
import { connection } from './index.js';
import { prisma } from '../lib/prisma.js';
import { createNotification } from '../lib/notifications.js';
import { reactivateLead } from '../lib/leadStatusActions.js';
import { sendDraft } from '../lib/emailService.js';
import { istDayBounds } from '../lib/istTime.js';

// SYSTEM_USER_ID isn't a real user row (see .agents/memory/system-user-id-fk.md)
// — logActivity/createNotification need an actual user id. Auto-reactivation
// must never get stuck just because no Branch Head happens to be active, so
// fall through a chain of real, currently-active users: the lead's own
// assigned BL/designer first (best attribution), then any Branch Head, then
// any BL, then — as a last resort — any active user at all. Only if the
// whole users table is empty (never happens in practice) do we skip.
async function resolveSystemActor(lead: { assignedBLId: string | null; assignedDesignerId: string | null }): Promise<{ id: string; name: string } | null> {
  const candidateIds = [lead.assignedBLId, lead.assignedDesignerId].filter((id): id is string => !!id);
  if (candidateIds.length > 0) {
    const assigned = await prisma.user.findFirst({
      where: { id: { in: candidateIds }, isActive: true },
      select: { id: true, name: true },
    });
    if (assigned) return assigned;
  }
  const byRole = await prisma.user.findFirst({
    where: { role: { in: ['BRANCH_HEAD', 'BL'] }, isActive: true },
    orderBy: { role: 'asc' }, // BL < BRANCH_HEAD alphabetically is fine — either works, just needs to be deterministic
    select: { id: true, name: true },
  });
  if (byRole) return byRole;
  return prisma.user.findFirst({ where: { isActive: true }, select: { id: true, name: true } });
}

const QUEUE_NAME = 'midnight-overdue-check';

export const midnightQueue = new Queue(QUEUE_NAME, { connection });

// Schedule repeatable job at midnight IST (18:30 UTC)
export async function scheduleMidnightJob() {
  await midnightQueue.add(
    'check-overdue-tasks',
    {},
    {
      repeat: { pattern: '30 18 * * *' }, // 00:00 IST = 18:30 UTC
      jobId: 'midnight-overdue-singleton',
    },
  );
  console.log('[jobs] Midnight overdue-task job scheduled (30 18 * * *)');
}

// ── Core logic — callable directly for on-demand triggers ─────────────────────
export async function runMidnightCheck(): Promise<{ markedOverdue: number; reopenNotified: number; details: string[] }> {
  console.log('[jobs] Running midnight overdue-task scan…');

  // IST day boundaries — this job is cron-scheduled for 00:00 IST (18:30 UTC,
  // see scheduleMidnightJob below), but the boundary itself must also be
  // computed in IST rather than server-local (UTC) time, or "today"/"tomorrow"
  // silently drift to UTC midnight (5:30am IST) instead of actual midnight IST.
  const { start: today, end: tomorrow } = istDayBounds();

  // ── 1. Overdue follow-up tasks ─────────────────────────────────────────────
  // Only PENDING tasks are actionable — RESCHEDULED/NOT_DONE rows are terminal
  // archive records (isCompleted stays false on them) and must never be
  // re-surfaced as overdue or trigger a duplicate BL notification.
  const overdueTasks = await prisma.followUpTask.findMany({
    where: {
      dueDate: { lt: tomorrow },
      status: 'PENDING',
      isCompleted: false,
      isOverdue: false,
    },
    include: {
      assignedTo: { select: { id: true, name: true, blId: true } },
      lead: { select: { id: true, leadId: true, name: true } },
    },
  });

  if (overdueTasks.length > 0) {
    await prisma.followUpTask.updateMany({
      where: { id: { in: overdueTasks.map((t) => t.id) } },
      data: { isOverdue: true },
    });
  }

  const details: string[] = [];
  for (const task of overdueTasks) {
    // Guard against orphaned/malformed tasks (assignedTo relation missing) —
    // dereferencing .name unconditionally used to throw and abort the whole
    // scan before any later task's notification was sent.
    if (!task.assignedTo) {
      console.warn(`[jobs] midnight-overdue: task ${task.id} has no assignedTo user, skipping notification`);
      details.push(`task:${task.id} lead:${task.lead.leadId} assignee:MISSING`);
      continue;
    }
    const message = `Task for lead ${task.lead.leadId} (${task.lead.name}) assigned to ${task.assignedTo.name} is overdue.`;
    if (task.assignedTo.blId) {
      // Dedupe: a retried/concurrent run could re-notify the same task if it
      // hasn't been flipped to isOverdue yet by the updateMany above (unlike
      // the 15-min task reminder loop, this job had no notificationLog check).
      const alreadyNotified = await prisma.notificationLog.findFirst({
        where: { userId: task.assignedTo.blId, type: 'OVERDUE_TASK', leadId: task.lead.id, eventAt: task.dueDate, taskId: task.id },
        select: { id: true },
      });
      if (!alreadyNotified) {
        await createNotification(task.assignedTo.blId, 'OVERDUE_TASK', message, task.lead.id, task.dueDate);
      }
    }
    details.push(`task:${task.id} lead:${task.lead.leadId} assignee:${task.assignedTo.name}`);
  }

  // ── 2. Auto-reactivate ON_HOLD leads whose reopen date has arrived (task #88) ──
  // Trigger is "date has arrived" (<= today), not "arriving tomorrow" — this
  // used to just notify the designer; now it calls the same reactivateLead()
  // used by the manual flow, and always notifies the client (the manual flow
  // makes that optional, but an automatic reactivation the client wasn't
  // asked about must always be communicated to them).
  const onHoldLeads = await prisma.lead.findMany({
    where: {
      status: 'ON_HOLD',
      onHoldRevivalDate: { lte: today },
    },
    select: { id: true, leadId: true, name: true, assignedBLId: true, assignedDesignerId: true, onHoldRevivalDate: true },
  });

  let reopenNotified = 0;
  if (onHoldLeads.length > 0) {
    for (const lead of onHoldLeads) {
      // Idempotency: skip if we already auto-reactivated this lead today
      // (prevents double-firing on repeated midnight runs).
      const alreadyNotifiedToday = await prisma.notificationLog.findFirst({
        where: { leadId: lead.id, type: 'LEAD_REACTIVATED', createdAt: { gte: today } },
        select: { id: true },
      });
      if (alreadyNotifiedToday) continue;

      // Resolved per-lead (not once for the whole batch) so each reactivation
      // is attributed to that lead's own BL/designer when possible, and a
      // missing/deactivated Branch Head never blocks the job — see
      // resolveSystemActor's fallback chain above.
      const systemActor = await resolveSystemActor(lead);
      if (!systemActor) {
        console.error('[jobs] No active user found at all — cannot attribute auto-reactivation, skipping', lead.leadId);
        continue;
      }

      try {
        const { pendingMail } = await reactivateLead({
          leadId: lead.id,
          actorId: systemActor.id,
          actorName: 'System (auto-reactivation)',
          reason: 'On-hold reopen date arrived — automatically reactivated',
          notifyClient: true,
        });
        // This is an unattended system job, not a human clicking through a
        // review UI — the Batch 12c "editable draft, never auto-send" rule
        // is about user-initiated flows. Nobody is present to review/send a
        // draft here, so flush it immediately or the reactivation mail would
        // silently never go out.
        if (pendingMail) {
          await sendDraft(pendingMail.draftKey, pendingMail.to, systemActor.id).catch((e) =>
            console.warn(`[jobs] Failed to send auto-reactivation mail for ${lead.leadId}:`, e),
          );
        }
        details.push(`reopen:${lead.leadId}`);
        reopenNotified++;
      } catch (e) {
        console.warn(`[jobs] Failed to auto-reactivate lead ${lead.leadId}:`, e);
      }
    }
  }

  console.log(`[jobs] Marked ${overdueTasks.length} task(s) as overdue; auto-reactivated ${reopenNotified} on-hold lead(s).`);
  return { markedOverdue: overdueTasks.length, reopenNotified, details };
}

export const midnightWorker = new Worker(
  QUEUE_NAME,
  async () => { await runMidnightCheck(); },
  { connection },
);
