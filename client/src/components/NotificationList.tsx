import { useNavigate } from 'react-router-dom';
import { notifIcon, notifLabel } from '../lib/notifTypes';
import { formatISTTime, formatISTDate, formatISTDateTime, istDateGroupLabel } from '../lib/dateFormat';

export interface NotifItem {
  id: string;
  type: string;
  message: string;
  isRead: boolean;
  createdAt: string;
  /** The task's due date/time or meeting's scheduled date/time this notification is about, if any. */
  eventAt?: string | null;
  lead?: { id: string; leadId: string; name: string } | null;
}

interface Props {
  notifications: NotifItem[];
  onMarkRead: (id: string) => void;
  emptyLabel?: string;
  /** Compact = dropdown styling; full = dedicated page styling */
  variant?: 'compact' | 'full';
}

function dateGroupLabel(iso: string) {
  return istDateGroupLabel(iso);
}

function fmtTime(iso: string) {
  return formatISTTime(iso);
}

// Task/meeting notifications should surface the date/time they're actually
// *about* (a task's due date, a meeting's scheduled time) rather than when
// the notification itself was logged — the latter is what `createdAt` means.
//
// Task due "dates" are stored as a date-only value (the time-of-day, if any,
// lives separately in `dueTime`/`timeFrom` and is already embedded in the
// notification's message text) — formatting that as a date+time would show
// a misleading midnight-IST clock time, so task-flavoured events render as a
// date only. Meeting `scheduledAt` is a real timestamp, so it renders with
// its time.
const EVENT_LABEL: Record<string, { label: string; withTime: boolean }> = {
  TASK_SCHEDULED: { label: 'Due', withTime: false },
  TASK_DUE: { label: 'Due', withTime: false },
  OVERDUE_TASK: { label: 'Was due', withTime: false },
  MEETING_SCHEDULED: { label: 'Meeting', withTime: true },
  MEETING_NO_SHOW: { label: 'Meeting was', withTime: true },
};

function eventTimeLabel(n: NotifItem): string {
  if (!n.eventAt) return fmtTime(n.createdAt);
  const cfg = EVENT_LABEL[n.type];
  if (!cfg) return formatISTDateTime(n.eventAt);
  const value = cfg.withTime ? formatISTDateTime(n.eventAt) : formatISTDate(n.eventAt);
  return `${cfg.label} ${value}`;
}

// Land the user on the lead-detail tab most relevant to what the notification is about,
// instead of always dropping them on the generic overview tab.
const TYPE_TAB: Record<string, string> = {
  MEETING_SCHEDULED: 'meetings',
  MEETING_NO_SHOW: 'meetings',
  CALL_LOGGED: 'calls',
  RNR_ESCALATION: 'calls',
  TASK_SCHEDULED: 'followups',
  TASK_DUE: 'followups',
  OVERDUE_TASK: 'followups',
  DISCOUNT_REQUEST: 'discount',
  NPS_SUBMITTED: 'activity',
  SLA_BREACH: 'activity',
  STAGE_MOVED_BACKWARD: 'activity',
  INTENT_RATING_CHANGED: 'activity',
  TEAM_CHAT_MESSAGE: 'audit',
};

function leadPathFor(n: NotifItem): string {
  const tab = TYPE_TAB[n.type];
  return tab ? `/leads/${n.lead!.id}?tab=${tab}` : `/leads/${n.lead!.id}`;
}

/** Group notifications by calendar day, preserving newest-first order of the groups. */
function groupByDate(items: NotifItem[]): { label: string; items: NotifItem[] }[] {
  const groups: { label: string; items: NotifItem[] }[] = [];
  for (const n of items) {
    const label = dateGroupLabel(n.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }
  return groups;
}

export default function NotificationList({ notifications, onMarkRead, emptyLabel = 'No notifications', variant = 'compact' }: Props) {
  const navigate = useNavigate();

  const handleClick = (n: NotifItem) => {
    if (!n.isRead) onMarkRead(n.id);
    if (n.lead) navigate(leadPathFor(n));
  };

  if (notifications.length === 0) {
    return <p className="text-center text-sm text-stone-400 py-8">{emptyLabel}</p>;
  }

  const groups = groupByDate(notifications);
  const rowPad = variant === 'compact' ? 'px-4 py-3' : 'px-5 py-3.5';

  return (
    <div className={variant === 'full' ? 'divide-y divide-stone-100' : 'divide-y divide-cream-100'}>
      {groups.map((group) => {
        const unread = group.items.filter((n) => !n.isRead);
        const read = group.items.filter((n) => n.isRead);
        return (
          <div key={group.label}>
            <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-400 bg-stone-50/60 sticky top-0">
              {group.label}
            </div>
            {unread.length > 0 && (
              <div>
                <p className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-brand-500">Unread</p>
                {unread.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => handleClick(n)}
                    className={`w-full text-left ${rowPad} flex items-start gap-2.5 bg-brand-50/70 hover:bg-brand-50 transition-colors`}
                  >
                    <span className="text-base shrink-0 mt-0.5">{notifIcon(n.type)}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-medium text-brand-600 uppercase tracking-wide">{notifLabel(n.type)}</p>
                      <p className="text-xs text-stone-800 leading-snug mt-0.5">{n.message}</p>
                      {n.lead && <p className="text-[10px] text-stone-400 mt-0.5">{n.lead.name} · {n.lead.leadId}</p>}
                      <p className="text-[10px] text-stone-400 mt-0.5">{eventTimeLabel(n)}</p>
                    </div>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 bg-brand-500" />
                  </button>
                ))}
              </div>
            )}
            {read.length > 0 && (
              <div>
                <p className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-stone-400">Read</p>
                {read.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => handleClick(n)}
                    className={`w-full text-left ${rowPad} flex items-start gap-2.5 hover:bg-stone-50 transition-colors`}
                  >
                    <span className="text-base shrink-0 mt-0.5 opacity-70">{notifIcon(n.type)}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-medium text-stone-400 uppercase tracking-wide">{notifLabel(n.type)}</p>
                      <p className="text-xs text-stone-600 leading-snug mt-0.5">{n.message}</p>
                      {n.lead && <p className="text-[10px] text-stone-400 mt-0.5">{n.lead.name} · {n.lead.leadId}</p>}
                      <p className="text-[10px] text-stone-400 mt-0.5">{eventTimeLabel(n)}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
