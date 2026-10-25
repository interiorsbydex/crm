import { stageLabel as settingsStageLabel } from './crmSettings';

/** Stage names follow Admin → CRM Settings. */
function stageLabel(s?: string) {
  return s ? settingsStageLabel(s) : '—';
}

function fmtWhen(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

export function describeActivity(action: string, meta?: Record<string, any>): string {
  const m = meta ?? {};
  switch (action) {
    case 'GATE_BYPASSED':
      return `Proceeded with missing items (${Array.isArray(m.missing) ? m.missing.join('; ') : '—'})`;
    case 'STAGE_CHANGED':
      return `${m.isBackward ? '↩ Moved backward: ' : 'Moved stage: '}${stageLabel(m.from)} → ${stageLabel(m.to)}`;
    case 'NOTE_ADDED':
      return `Added a note: ${m.note ?? ''}`;
    case 'INTENT_RATING_UPDATED': {
      const dir = m.direction === 'increase' ? ' ↑' : m.direction === 'decrease' ? ' ↓' : '';
      const oldPart = m.oldRating != null ? ` (${m.oldRating} → ${m.rating ?? '—'}${dir})` : ` to ${m.rating ?? '—'}${dir}`;
      return `${m.isAuto ? 'Auto-set' : 'Updated'} intent rating${oldPart}${m.reason ? ` — ${m.reason}` : ''}`;
    }
    case 'CALL_LOGGED': {
      const secs = Number(m.duration);
      const dur = m.duration && !isNaN(secs)
        ? secs >= 60 ? ` (${Math.floor(secs / 60)}m ${secs % 60}s)` : ` (${secs}s)`
        : '';
      return `Logged a call${m.outcome ? ` — ${String(m.outcome).replace(/_/g, ' ').toLowerCase()}` : ''}${dur}`;
    }
    case 'MEETING_SCHEDULED':
      return `Scheduled a meeting${m.type ? ` (${String(m.type).replace(/_/g, ' ').toLowerCase()})` : ''}${m.scheduledAt ? ` for ${fmtWhen(m.scheduledAt)}` : ''}`;
    case 'MEETING_COMPLETED':
      return 'Marked meeting as completed';
    case 'MEETING_RESCHEDULED':
      return `Rescheduled meeting${m.newDate || m.scheduledAt ? ` to ${fmtWhen(m.newDate ?? m.scheduledAt)}` : ''}${m.rescheduledReason ? ` — ${m.rescheduledReason}` : ''}`;
    case 'MEETING_CANCELLED':
      return 'Cancelled a meeting';
    case 'MEETING_NO_SHOW':
      return `Marked meeting as no-show${m.noShowReason ? ` — ${m.noShowReason}` : ''}`;
    case 'TASK_CREATED':
      return `Created a follow-up task${m.dueDate ? ` due ${fmtWhen(m.dueDate)}` : ''}`;
    case 'TASK_COMPLETED':
      return 'Completed a follow-up task';
    case 'WHATSAPP_SENT':
      return 'Sent a WhatsApp message';
    case 'DISCOUNT_REQUESTED':
      return `Requested a discount${m.discountPct != null ? ` of ${Number(m.discountPct).toFixed(1)}%` : ''}${m.reason ? ` — ${m.reason}` : ''}`;
    case 'DISCOUNT_APPROVED':
      return `Approved discount request${m.discountPct != null ? ` (${Number(m.discountPct).toFixed(1)}%)` : ''}${m.reviewerComment ? ` — ${m.reviewerComment}` : ''}`;
    case 'DISCOUNT_REJECTED':
      return `Rejected discount request${m.discountPct != null ? ` (${Number(m.discountPct).toFixed(1)}%)` : ''}${m.reviewerComment ? ` — ${m.reviewerComment}` : ''}`;
    case 'DISCOUNT_FORWARDED':
      return `Forwarded discount request${m.discountPct != null ? ` (${Number(m.discountPct).toFixed(1)}%)` : ''} to Branch Head`;
    case 'OFFER_APPLIED':
      return `Applied offer${m.offerName ? `: ${m.offerName}` : ''}`;
    case 'QUOTE_RECEIVED':
      return 'Quote received';
    case 'DQL_QUESTIONNAIRE_RECEIVED':
      return 'Qualification questionnaire received';
    case 'DIP_CHECKLIST_UPDATED':
      return 'Updated the DIP checklist';
    case 'PD_OB_CHECKLIST_UPDATED':
      return 'Updated the PD to OB checklist';
    case 'OB_OBM_CHECKLIST_UPDATED':
      return 'Updated the OB to OBM checklist';
    case 'LEAD_CREATED':
    case 'LEAD_CREATED_MANUAL':
      return 'Created this lead';
    case 'LEAD_CREATED_VIA_WEBHOOK':
      return `Lead captured from web form${m.autoAssignedCREName ? ` — auto-assigned to ${m.autoAssignedCREName} for qualification (round-robin)` : ''}`;
    case 'BULK_IMPORT':
      return 'Lead imported';
    case 'BL_ASSIGNED':
      return 'Assigned a Business Lead';
    case 'DIRECT_ASSIGNMENT':
      return 'Assigned this lead';
    case 'ATTENTION_FLAG_ADDED':
      return `Flagged for attention${m.reason ? ` — ${m.reason}` : ''}`;
    case 'ATTENTION_FLAG_RESOLVED':
      return 'Resolved the attention flag';
    case 'SLA_BREACH':
      return 'Response time limit breached';
    case 'PROJECT_CREATED':
      return 'Created a project';
    case 'PROJECT_UPDATED':
      return 'Updated project details';
    default:
      return action.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  }
}
