// Shared display metadata for NotificationLog "type" values — used by the
// notification bell dropdown, the full /notifications page, and the
// designer dashboard's "Recent Notifications" panel so all three stay
// visually consistent.

export const NOTIF_ICON: Record<string, string> = {
  NPS_SUBMITTED: '⭐',
  BL_ASSIGNED: '👤',
  DESIGNER_ASSIGNED: '👤',
  DISCOUNT_REQUEST: '💸',
  MEETING_NO_SHOW: '❌',
  MEETING_SCHEDULED: '📅',
  CALL_LOGGED: '📞',
  TASK_SCHEDULED: '📝',
  SLA_BREACH: '⚠️',
  OVERDUE_TASK: '⏰',
  TASK_DUE: '⏰',
  RNR_ESCALATION: '📞',
  ONBOARDING_DIP_REQUIRED: '📋',
  DQL_QUESTIONNAIRE: '📋',
  DIP_CHECKLIST_COMPLETE: '✅',
  STAGE_MOVED_BACKWARD: '↩️',
  INTENT_RATING_CHANGED: '🎯',
  ON_HOLD_REOPEN: '🔓',
  LEAD_REACTIVATED: '🔁',
  TEAM_MEMBER_REQUESTED: '🙋',
  TEAM_MEMBER_APPROVED: '✅',
  TEAM_MEMBER_REJECTED: '🚫',
  PD_ASSIGNED: '🏗️',
  DTL_ASSIGNED: '🏗️',
  OB_DATE_REMINDER: '📆',
  MQL_ALLOCATED_TO_BL: '🤝',
  MQL_PUSHED_BACK: '↩️',
  TEAM_CHAT_MESSAGE: '💬',
};

export const NOTIF_LABEL: Record<string, string> = {
  NPS_SUBMITTED: 'NPS survey submitted',
  BL_ASSIGNED: 'BL assigned',
  DESIGNER_ASSIGNED: 'Designer assigned',
  DISCOUNT_REQUEST: 'Discount request',
  MEETING_NO_SHOW: 'Meeting no-show',
  MEETING_SCHEDULED: 'Meeting scheduled',
  CALL_LOGGED: 'Call logged',
  TASK_SCHEDULED: 'Task scheduled',
  SLA_BREACH: 'SLA breach',
  OVERDUE_TASK: 'Task overdue',
  TASK_DUE: 'Task due',
  RNR_ESCALATION: 'RNR escalation',
  ONBOARDING_DIP_REQUIRED: 'DIP required',
  DQL_QUESTIONNAIRE: 'Questionnaire',
  DIP_CHECKLIST_COMPLETE: 'DIP checklist complete',
  STAGE_MOVED_BACKWARD: 'Stage moved back',
  INTENT_RATING_CHANGED: 'Intent rating changed',
  ON_HOLD_REOPEN: 'On-hold reopened',
  LEAD_REACTIVATED: 'Lead reactivated',
  TEAM_MEMBER_REQUESTED: 'Team member request',
  TEAM_MEMBER_APPROVED: 'Team member approved',
  TEAM_MEMBER_REJECTED: 'Team member rejected',
  PD_ASSIGNED: 'PD assigned',
  DTL_ASSIGNED: 'DTL assigned',
  OB_DATE_REMINDER: 'Expected OB date approaching',
  MQL_ALLOCATED_TO_BL: 'Lead allocated to BL',
  MQL_PUSHED_BACK: 'Returned for re-qualification',
  TEAM_CHAT_MESSAGE: 'Team Chat',
};

export function notifIcon(type: string): string {
  return NOTIF_ICON[type] ?? '🔔';
}

export function notifLabel(type: string): string {
  return NOTIF_LABEL[type] ?? type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
