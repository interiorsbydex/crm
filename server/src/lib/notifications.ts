import { z } from 'zod';
import { prisma } from './prisma.js';
import { ConfigError, describeIssues, versionedConfig } from './versionedConfig.js';

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

/** Every in-app alert type, with the name shown in Admin → In-app Alerts. */
export const NOTIFICATION_TYPES: { type: NotificationType; label: string }[] = [
  { type: 'BL_ASSIGNED', label: 'A lead is assigned to a Business Lead' },
  { type: 'DESIGNER_ASSIGNED', label: 'A lead is assigned to a designer' },
  { type: 'MQL_ALLOCATED_TO_BL', label: 'An MQL lead is allocated to a Business Lead' },
  { type: 'MQL_PUSHED_BACK', label: 'An MQL lead is sent back to Effective Lead' },
  { type: 'DISCOUNT_REQUEST', label: 'Discount requests and decisions' },
  { type: 'SLA_BREACH', label: 'A lead breaches its SLA' },
  { type: 'RNR_ESCALATION', label: 'Too many unanswered calls on a lead' },
  { type: 'CALL_LOGGED', label: 'A call is logged' },
  { type: 'MEETING_SCHEDULED', label: 'A meeting is scheduled' },
  { type: 'MEETING_DUE_SOON', label: 'A meeting starts soon' },
  { type: 'MEETING_NO_SHOW', label: 'A client misses a meeting' },
  { type: 'TASK_SCHEDULED', label: 'A task is scheduled' },
  { type: 'TASK_DUE', label: 'A task is due' },
  { type: 'TASK_DUE_SOON', label: 'A task is due soon' },
  { type: 'OVERDUE_TASK', label: 'A task is overdue' },
  { type: 'STAGE_MOVED_BACKWARD', label: 'A lead is moved back a stage' },
  { type: 'INTENT_RATING_CHANGED', label: 'A lead\'s intent rating changes' },
  { type: 'LEAD_ON_HOLD', label: 'A lead is put on hold' },
  { type: 'ON_HOLD_REOPEN', label: 'An on-hold lead\'s reopen date arrives' },
  { type: 'LEAD_REACTIVATED', label: 'A lead is reactivated' },
  { type: 'LEAD_INACTIVATED', label: 'A lead is made inactive' },
  { type: 'OB_DATE_REMINDER', label: 'An expected onboarding date is near' },
  { type: 'ONBOARDING_DIP_REQUIRED', label: 'A lead reaches Onboarding (checklist next)' },
  { type: 'DIP_CHECKLIST_COMPLETE', label: 'The OBM → DIP checklist is completed' },
  { type: 'DQL_QUESTIONNAIRE', label: 'A pre-meeting questionnaire is answered' },
  { type: 'NPS_SUBMITTED', label: 'A client submits an NPS survey' },
  { type: 'TEAM_MEMBER_REQUESTED', label: 'A project team member is requested' },
  { type: 'TEAM_MEMBER_APPROVED', label: 'A project team member is approved' },
  { type: 'TEAM_MEMBER_REJECTED', label: 'A project team member is rejected' },
  { type: 'PD_ASSIGNED', label: 'A Project Designer is assigned' },
  { type: 'DTL_ASSIGNED', label: 'A Design Team Lead is assigned' },
  { type: 'TEAM_CHAT_MESSAGE', label: 'A message in a lead\'s team chat' },
];
export const ALERT_ROLES = ['DESIGNER', 'DESIGN_MANAGER', 'CRE', 'BL', 'BRANCH_HEAD'] as const;
export type AlertRole = (typeof ALERT_ROLES)[number];

/** Per alert type, the roles that don't see it (Admin → In-app Alerts). Empty = everyone sees everything. */
export type AlertSettings = { off: Partial<Record<NotificationType, AlertRole[]>> };

export const alertSettingsConfig = versionedConfig<AlertSettings>({
  key: 'in_app_alerts_v1',
  action: 'IN_APP_ALERTS',
  noun: 'the in-app alert settings',
  defaults: () => ({ off: {} }),
  merge: (saved) => ({ off: { ...(saved?.off ?? {}) } }),
  validate: (raw) => {
    const types = NOTIFICATION_TYPES.map((t) => t.type) as [NotificationType, ...NotificationType[]];
    const parsed = z.object({ off: z.record(z.enum(types), z.array(z.enum(ALERT_ROLES))) }).strict().safeParse(raw);
    if (!parsed.success) throw new ConfigError(400, 'The in-app alert settings could not be saved', describeIssues(parsed.error.issues, {}));
    return parsed.data as AlertSettings;
  },
});

async function mutedFor(type: NotificationType, role: string | null | undefined): Promise<boolean> {
  if (!role) return false;
  const settings = await alertSettingsConfig.get().catch(() => ({ off: {} as AlertSettings['off'] }));
  return (settings.off[type] ?? []).includes(role as AlertRole);
}

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
  // Alerts switched off for this person's role are recorded but hidden.
  const role = (await prisma.user.findUnique({ where: { id: userId }, select: { role: true } }))?.role;
  const muted = await mutedFor(type, role);
  return prisma.notificationLog.create({
    data: { userId, type, message, leadId, eventAt, taskId, ...(muted && { muted: true, isRead: true }) },
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
    select: { id: true, role: true },
  });
  const data = [];
  for (const m of managers) {
    const muted = await mutedFor(type, m.role);
    data.push({ userId: m.id, type, message, leadId, eventAt, ...(muted && { muted: true, isRead: true }) });
  }
  await prisma.notificationLog.createMany({ data });
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
