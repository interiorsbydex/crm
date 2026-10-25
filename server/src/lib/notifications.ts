import { prisma } from './prisma.js';

export type NotificationType =
  | 'OVERDUE_TASK'
  | 'RNR_ESCALATION'
  | 'DISCOUNT_REQUEST'
  | 'SLA_BREACH'
  | 'MEETING_NO_SHOW'
  | 'TASK_DUE'
  | 'BL_ASSIGNED'
  | 'DESIGNER_ASSIGNED'
  | 'ONBOARDING_DIP_REQUIRED'
  | 'DQL_QUESTIONNAIRE'
  | 'DIP_CHECKLIST_COMPLETE'
  | 'STAGE_MOVED_BACKWARD'
  | 'INTENT_RATING_CHANGED'
  | 'ON_HOLD_REOPEN'
  | 'NPS_SUBMITTED'
  | 'LEAD_REACTIVATED'
  | 'LEAD_ON_HOLD'
  | 'LEAD_INACTIVATED'
  | 'MEETING_SCHEDULED'
  | 'CALL_LOGGED'
  | 'TASK_SCHEDULED'
  | 'TEAM_MEMBER_REQUESTED'
  | 'TEAM_MEMBER_APPROVED'
  | 'TEAM_MEMBER_REJECTED'
  | 'PD_ASSIGNED'
  | 'DTL_ASSIGNED'
  | 'TASK_DUE_SOON'
  | 'MEETING_DUE_SOON'
  | 'OB_DATE_REMINDER'
  // CRE module Stage 2
  | 'MQL_ALLOCATED_TO_BL'
  | 'MQL_PUSHED_BACK'
  | 'TEAM_CHAT_MESSAGE';

export async function createNotification(
  userId: string,
  type: NotificationType,
  message: string,
  leadId?: string,
  // The date/time this notification is actually *about* (a task's due
  // date/time, or a meeting's scheduled date/time) — distinct from
  // createdAt, which is when the notification itself was generated. Left
  // undefined for notification types with no inherent due/event date.
  eventAt?: Date,
  // Set only for follow-up task reminders. This is intentionally stored
  // separately from the user-visible message so callers can dedupe reliably
  // without leaking an internal task identifier into notification text.
  taskId?: string,
) {
  return prisma.notificationLog.create({
    data: { userId, type, message, leadId, eventAt, taskId },
  });
}

/** Notify all BLs and Branch Heads */
export async function notifyManagers(
  type: NotificationType,
  message: string,
  leadId?: string,
  eventAt?: Date,
) {
  const managers = await prisma.user.findMany({
    where: { role: { in: ['BL', 'BRANCH_HEAD'] }, isActive: true },
    select: { id: true },
  });

  await prisma.notificationLog.createMany({
    data: managers.map((m) => ({ userId: m.id, type, message, leadId, eventAt })),
  });
}

/** Notify specific user's BL (if they have one) */
export async function notifyUserBL(
  userId: string,
  type: NotificationType,
  message: string,
  leadId?: string,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { blId: true },
  });
  if (user?.blId) {
    await createNotification(user.blId, type, message, leadId);
  }
}
