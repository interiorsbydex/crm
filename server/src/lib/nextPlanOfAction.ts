/**
 * Shared "next plan of action" flow (Task #86) — a multi-select of
 * Call / Meeting / Task follow-ups, offered from both the call-log flow and
 * the meeting MOM-completion flow. Each selected item renders its own
 * sub-form and can independently be flagged to notify the client externally.
 *
 * Every item is validated up-front against the same enums/date rules the
 * standalone create routes enforce; if any item is invalid the whole batch
 * is rejected before any record is created. Record creation itself happens
 * inside the caller's existing $transaction (via `createNextPlanRecords`) so
 * a mid-batch failure rolls back the primary Call/Meeting record too, rather
 * than reporting success while only part of the plan was persisted. Mail is
 * a separate best-effort side effect fired only after the transaction commits.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { renderMailTemplate } from './mailTemplates.js';
import { sendEmail } from './email.js';
import { assertNoActiveMeeting, computeMeetingNumbering, createMeetingRecord, runMeetingScheduledSideEffects, normalizeMeetingLocation, type ScheduleMeetingLead, type PendingMeetingMail } from './meetingScheduler.js';
import { validateGenericAttachments } from './attachmentValidation.js';
import { isAutomationOn, automationCc } from './automations.js';

export type NextPlanKind = 'CALL' | 'MEETING' | 'TASK';

// Kept in lockstep with the allowlists in routes/tasks.ts and routes/meetings.ts.
const TASK_TYPES = ['INTERNAL', 'EXTERNAL'] as const;
export const NEXT_PLAN_MEETING_TYPES = ['DQL', 'PP', 'PD', 'ONBOARDING', 'OBM'] as const;
// Kept in lockstep with the `validModes` list in routes/meetings.ts POST '/'.
export const NEXT_PLAN_MEETING_MODES = ['EC_VISIT', 'SITE_VISIT', 'VIRTUAL', 'PUBLIC_PLACE', 'CLIENT_PLACE'] as const;

export interface NextPlanItem {
  kind: NextPlanKind;
  sendExternalMail?: boolean;
  // TASK / CALL (a plain reminder to place another call — modeled as a follow-up task)
  dueDate?: string;
  dueTime?: string;
  timeFrom?: string;
  timeTo?: string;
  taskType?: 'INTERNAL' | 'EXTERNAL';
  agenda?: string;
  // TASK / CALL — Task #115, multiple attachments allowed, no fixed category list.
  attachments?: { type: string; storagePath?: string; fileUrl?: string }[];
  // MEETING
  meetingType?: string;
  mode?: string;
  scheduledAt?: string;
  location?: string;
  // CALL notes shown in the follow-up description
  notes?: string;
}

type Tx = Omit<PrismaClient, '$transaction' | '$connect' | '$disconnect' | '$on' | '$use' | '$extends'> | Prisma.TransactionClient;

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Shared due-date validation used everywhere a follow-up date is accepted
 * (standalone task create/reschedule, call follow-up/callback dates, and
 * next-plan-of-action TASK/CALL items) so every entry point enforces the
 * same "must parse, must be in the future" rule instead of only checking
 * presence and passing the raw string straight into `new Date(...)`.
 */
export function validateFutureDate(value: string | undefined, label: string, time?: string): void {
  if (!value) throw new Error(`${label} is required`);
  const parsed = time
    ? new Date(`${value}T${time}:00+05:30`)
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is invalid`);
  if (time && parsed <= new Date()) throw new Error(`${label} and time must be in the future`);
  if (!time && parsed < startOfToday()) throw new Error(`${label} cannot be in the past`);
}

/** Validates one item, or the shared meetingDetails/callbackDetails-style payload for a standalone meeting/task. */
export function validateMeetingTypeMode(type: string | undefined, mode: string | undefined, scheduledAt: string | undefined, label = 'meetingDetails', location?: string): void {
  if (!type || !NEXT_PLAN_MEETING_TYPES.includes(type as any)) {
    throw new Error(`${label}.type must be one of ${NEXT_PLAN_MEETING_TYPES.join(', ')}`);
  }
  if (!mode || !NEXT_PLAN_MEETING_MODES.includes(mode as any)) {
    throw new Error(`${label}.mode must be one of ${NEXT_PLAN_MEETING_MODES.join(', ')}`);
  }
  if (!scheduledAt) throw new Error(`${label}.scheduledAt is required`);
  const parsed = new Date(scheduledAt);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label}.scheduledAt is invalid`);
  if (parsed <= new Date()) throw new Error(`${label}.scheduledAt date and time must be in the future`);
  normalizeMeetingLocation(location, `${label}.location`);
}

/**
 * Throws a descriptive error naming the offending item (1-based index) on the
 * first invalid item found. Exported so routes can validate the whole batch
 * up-front and return 400 before creating the primary Call/Meeting record —
 * we never want to report success while only part of a next-plan batch
 * actually got created.
 */
export function validateNextPlanItems(items: NextPlanItem[]): void {
  // A lead can only ever have one active (SCHEDULED) meeting at a time — see
  // assertNoActiveMeeting — so a batch can request at most one new meeting.
  const meetingItems = items.filter((item) => item.kind === 'MEETING');
  if (meetingItems.length > 1) {
    throw new Error('Only one MEETING item is allowed per next-plan-of-action batch — a lead can have at most one active meeting at a time');
  }

  items.forEach((item, i) => {
    const label = `Next-plan item #${i + 1} (${item.kind})`;
    if (item.kind === 'TASK' || item.kind === 'CALL') {
      if (!item.dueDate) throw new Error(`${label}: dueDate is required`);
      const parsed = new Date(item.dueDate);
      if (Number.isNaN(parsed.getTime())) throw new Error(`${label}: dueDate is invalid`);
       if (item.dueTime) {
         validateFutureDate(item.dueDate, `${label}: dueDate`, item.dueTime);
       } else if (parsed < startOfToday()) {
         throw new Error(`${label}: dueDate cannot be in the past`);
       }
      if (item.kind === 'TASK' && item.taskType && !TASK_TYPES.includes(item.taskType)) {
        throw new Error(`${label}: taskType must be one of ${TASK_TYPES.join(', ')}`);
      }
      try {
        validateGenericAttachments(item.attachments, `${label}.attachments`);
      } catch (err: any) {
        throw new Error(err.message);
      }
    } else if (item.kind === 'MEETING') {
      try {
        validateMeetingTypeMode(item.meetingType, item.mode, item.scheduledAt, label, item.location);
      } catch (err: any) {
        throw new Error(err.message);
      }
    } else {
      throw new Error(`${label}: unknown kind`);
    }
  });
}

/**
 * For any MEETING item in the batch, enforces the same single-active-meeting
 * invariant the standalone scheduler and call-log MEETING_SCHEDULED outcome
 * use, and computes its PP/sequence numbering. Call this — after
 * `validateNextPlanItems` — before opening the transaction that will create
 * the batch's records, so a lead with an already-active meeting is rejected
 * with 409 instead of silently creating a second concurrent one.
 */
export async function assertNextPlanMeetingSchedulable(items: NextPlanItem[], leadId: string, excludeMeetingId?: string): Promise<number | null> {
  const meetingItem = items.find((item) => item.kind === 'MEETING');
  if (!meetingItem) return null;
  await assertNoActiveMeeting(leadId, excludeMeetingId);
  const { ppNumber } = await computeMeetingNumbering(leadId, meetingItem.meetingType!);
  return ppNumber;
}

export function summarizeNextPlanItems(items: NextPlanItem[]): string {
  return items
    .map((item) => {
      if (item.kind === 'TASK') return `Task: ${item.agenda || 'Follow-up'} on ${item.dueDate}${item.dueTime ? ` ${item.dueTime}` : ''}`;
      if (item.kind === 'MEETING') return `Meeting (${item.meetingType}): ${item.scheduledAt}`;
      return `Call: ${item.dueDate}${item.dueTime ? ` ${item.dueTime}` : ''}${item.notes ? ` — ${item.notes}` : ''}`;
    })
    .join('; ');
}

function describeItem(item: NextPlanItem): string {
  if (item.kind === 'TASK') return `A follow-up task${item.agenda ? ` (${item.agenda})` : ''} on ${item.dueDate}${item.dueTime ? ` at ${item.dueTime}` : ''}.`;
  if (item.kind === 'MEETING') return `A ${item.meetingType} meeting scheduled for ${item.scheduledAt}.`;
  return `A follow-up call planned for ${item.dueDate}${item.dueTime ? ` at ${item.dueTime}` : ''}.`;
}

/**
 * Creates the linked records for each next-plan-of-action item using the
 * given Prisma client (pass the caller's transaction client `tx` so this
 * lives in the same atomic transaction as the primary Call/Meeting write —
 * if any item fails to create, the whole transaction rolls back rather than
 * leaving a partially-created plan behind).
 *
 * Does NOT validate — call `validateNextPlanItems` first, before the
 * transaction opens, so invalid input is rejected with 400 before any write
 * begins. Does NOT send mail — call `sendNextPlanMails` after the
 * transaction commits successfully.
 *
 * New records are always assigned to the acting user — the picker UI does
 * not expose (and this flow does not accept) an arbitrary assignee/target id,
 * to avoid an authorization bypass via a client-supplied id.
 */
export interface NextPlanMeetingCreated {
  id: string;
  type: string;
  mode: string;
  scheduledAt: string;
  ppNumber: number | null;
}

export async function createNextPlanRecords(
  tx: Tx,
  items: NextPlanItem[],
  ctx: { leadId: string; userId: string; userRole: string; originatingCallId?: string; meetingPpNumber?: number | null },
): Promise<{ tasksCreated: number; meetingsCreated: number; meetingCreated: NextPlanMeetingCreated | null }> {
  let tasksCreated = 0;
  let meetingsCreated = 0;
  let meetingCreated: NextPlanMeetingCreated | null = null;

  for (const item of items) {
    if (item.kind === 'TASK' || item.kind === 'CALL') {
      const task = await tx.followUpTask.create({
        data: {
          leadId: ctx.leadId,
          assignedToId: ctx.userId,
          dueDate: new Date(item.dueDate!),
          dueTime: item.dueTime ?? item.timeFrom,
          timeFrom: item.timeFrom ?? item.dueTime,
          timeTo: item.timeTo,
          taskType: item.kind === 'TASK' ? item.taskType : undefined,
          agenda: item.agenda ?? (item.kind === 'CALL' ? 'Follow-up call' : undefined),
          originatingCallId: ctx.originatingCallId,
          attachments: item.attachments?.length ? (item.attachments as any) : undefined,
        },
      });
      await tx.activityLog.create({
        data: {
          userId: ctx.userId,
          action: 'TASK_CREATED',
          leadId: ctx.leadId,
          meta: { taskId: task.id, createdByRole: ctx.userRole, source: 'NEXT_PLAN' },
          createdAt: task.createdAt,
        },
      });
      tasksCreated++;
    } else {
      // Goes through the same shared meeting-record builder the standalone
      // scheduler and call-log MEETING_SCHEDULED outcome use — the caller
      // must have already run `assertNextPlanMeetingSchedulable` (single-
      // active-meeting guard + PP/sequence numbering) before this transaction
      // opened, and must run `runNextPlanMeetingSideEffects` after it commits.
      const newMeeting = await createMeetingRecord(tx, {
        leadId: ctx.leadId,
        type: item.meetingType!,
        mode: item.mode!,
        scheduledAt: item.scheduledAt!,
        location: item.location,
        ppNumber: ctx.meetingPpNumber ?? null,
        originatingCallId: ctx.originatingCallId,
      });
      meetingCreated = { id: newMeeting.id, type: item.meetingType!, mode: item.mode!, scheduledAt: item.scheduledAt!, ppNumber: ctx.meetingPpNumber ?? null };
      meetingsCreated++;
    }
  }

  return { tasksCreated, meetingsCreated, meetingCreated };
}

/**
 * Runs the standard meeting-scheduling side effects (activity log,
 * stakeholder notifications, client confirmation email/SMS, milestone
 * recalculation, auto intent-rating) for a next-plan MEETING item. Call this
 * once the transaction that created it has committed — mirrors what the
 * standalone scheduler and call-log MEETING_SCHEDULED outcome already do,
 * so a next-plan-created meeting is never missing required workflow.
 */
export async function runNextPlanMeetingSideEffects(
  meetingCreated: NextPlanMeetingCreated | null,
  lead: ScheduleMeetingLead,
  user: { id: string; role: string },
): Promise<PendingMeetingMail | null> {
  if (!meetingCreated) return null;
  return runMeetingScheduledSideEffects({
    meeting: { id: meetingCreated.id },
    lead,
    user,
    type: meetingCreated.type,
    mode: meetingCreated.mode,
    scheduledAt: meetingCreated.scheduledAt,
    ppNumber: meetingCreated.ppNumber,
  });
}

/** Best-effort per-item client email — call only after the transaction that created the records has committed. */
export async function sendNextPlanMails(items: NextPlanItem[], lead: { id?: string; name: string; email: string | null }): Promise<void> {
  if (!items.some((i) => i.sendExternalMail) || !(await isAutomationOn('NEXT_PLAN_OF_ACTION', 'email'))) return;
  const cc = lead.id ? (await automationCc('NEXT_PLAN_OF_ACTION', lead.id)).filter((e) => e !== lead.email) : [];
  for (const item of items) {
    if (!item.sendExternalMail || !lead.email) continue;
    const { subject, html } = await renderMailTemplate('NEXT_PLAN_OF_ACTION', {
      clientName: lead.name,
      kind: item.kind,
      details: describeItem(item),
    });
    await sendEmail({ to: lead.email, cc, subject, html }).catch(() => {});
  }
}
