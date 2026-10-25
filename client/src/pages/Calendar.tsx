import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays } from 'lucide-react';
import { api } from '../lib/api';
import type { FollowUpTask } from '../lib/api';
import { getStoredUser } from '../lib/auth';
import { formatISTDate, istDateOnly } from '../lib/dateFormat';
import toast from 'react-hot-toast';

type ViewMode = 'month' | 'week' | 'day' | 'upcoming';
type Scope = 'mine' | 'team';
type Bucket = 'tomorrow' | 'thisWeek' | 'nextWeek';

interface CalEvent {
  id: string;
  leadId: string;
  leadDbId: string;
  leadName: string;
  type: string;
  ppNumber?: number | null;
  mode: string;
  status: string;
  scheduledAt: string;
  location: string | null;
}

const TYPE_COLORS: Record<string, string> = {
  DQL:       'bg-blue-100 text-blue-800 border-blue-200',
  PP:        'bg-orange-100 text-orange-800 border-orange-200',
  ONBOARDING:'bg-green-100 text-green-800 border-green-200',
};
const TYPE_DOT: Record<string, string> = {
  DQL:       'bg-blue-500',
  PP:        'bg-orange-500',
  ONBOARDING:'bg-green-500',
};

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const HOURS = Array.from({ length: 13 }, (_, i) => i + 8); // 8..20

const IST_TZ = 'Asia/Kolkata';

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-IN', { timeZone: IST_TZ, hour: '2-digit', minute: '2-digit', hour12: true });
}

// Grid cursor/day cells are plain local JS Dates (no timezone attached), so
// their key must be built from local fields (not toISOString, which is UTC
// and can land on the wrong day depending on the browser's timezone).
function isoDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Server event timestamps are real UTC instants — their calendar day/hour
// must be read in IST, not via raw UTC slicing (previous behaviour) or the
// browser's local timezone (whatever that happens to be in prod/dev).
function istDateKey(iso: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function istHour(iso: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: IST_TZ, hour: 'numeric', hour12: false }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  return h === 24 ? 0 : h;
}

function startOfMonth(y: number, m: number) { return new Date(y, m, 1); }
function endOfMonth(y: number, m: number)   { return new Date(y, m + 1, 0); }
function startOfWeek(d: Date) {
  const s = new Date(d);
  s.setDate(d.getDate() - d.getDay());
  return s;
}
function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function addDaysToDateKey(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function workWeekBounds(todayKey: string) {
  const today = new Date(`${todayKey}T00:00:00Z`);
  // Monday anchors the calendar week, but is intentionally excluded from the
  // Tuesday–Sunday work week.
  const daysSinceMonday = (today.getUTCDay() + 6) % 7;
  const mondayKey = addDaysToDateKey(todayKey, -daysSinceMonday);
  const thisWeekStart = addDaysToDateKey(mondayKey, 1);
  return {
    thisWeekStart,
    thisWeekEnd: addDaysToDateKey(mondayKey, 6),
    nextWeekStart: addDaysToDateKey(mondayKey, 8),
    nextWeekEnd: addDaysToDateKey(mondayKey, 13),
  };
}

// Status-based overrides (task follow-up to calendar styling): COMPLETED
// meetings are struck through, NO_SHOW ("not done") meetings show in red,
// and RESCHEDULED meetings show in yellow. These override the type color
// (DQL/PP/Onboarding) so status is always visible regardless of meeting type.
const STATUS_CLASSES: Record<string, string> = {
  NO_SHOW: 'bg-red-100 text-red-800 border-red-300',
  RESCHEDULED: 'bg-yellow-100 text-yellow-800 border-yellow-300',
};

function EventChip({ ev, onClick, compact = false }: { ev: CalEvent; onClick: () => void; compact?: boolean }) {
  const statusCls = STATUS_CLASSES[ev.status];
  const cls = statusCls ?? TYPE_COLORS[ev.type] ?? 'bg-gray-100 text-gray-700 border-gray-200';
  const dot = TYPE_DOT[ev.type] ?? 'bg-gray-400';
  const isCompleted = ev.status === 'COMPLETED';
  const textCls = isCompleted ? 'line-through opacity-70' : '';
  if (compact) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        title={`${ev.leadName} — ${ev.type} ${fmtTime(ev.scheduledAt)} (${ev.status})`}
        className={`w-full text-left text-[10px] font-medium px-1.5 py-0.5 rounded border truncate ${cls} hover:opacity-80 transition-opacity`}
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot} mr-1 align-middle`} />
        <span className={textCls}>{ev.leadName.split(' ')[0]} {fmtTime(ev.scheduledAt)}</span>
      </button>
    );
  }
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`w-full text-left text-xs font-medium px-2 py-1.5 rounded-lg border flex items-center gap-2 ${cls} hover:opacity-80 transition-opacity`}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${dot} shrink-0`} />
      <div className={`min-w-0 ${textCls}`}>
        <div className="truncate font-semibold">{ev.leadName}</div>
        <div className="text-[10px] opacity-70">{ev.type}{ev.ppNumber ? ` PP${ev.ppNumber}` : ''} · {fmtTime(ev.scheduledAt)}</div>
      </div>
    </button>
  );
}

export default function Calendar() {
  const navigate = useNavigate();
  const user = getStoredUser();

  const canToggleScope = user?.role === 'BL' || user?.role === 'BRANCH_HEAD';

  const today = new Date();
  const [view, setView] = useState<ViewMode>('month');
  const [scope, setScope] = useState<Scope>('mine');
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);

  // ── Upcoming view (task #127-batch) — Tomorrow / This Week / Next Week
  // buckets for tasks + meetings, separate from the dashboard's due-date
  // count widget (which is untouched). Reuses the existing /tasks/my and
  // /calendar endpoints — no data-model merge, no new backend route.
  const [upcomingTasks, setUpcomingTasks] = useState<FollowUpTask[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<CalEvent[]>([]);
  const [upcomingLoading, setUpcomingLoading] = useState(false);

  const getRange = useCallback((v: ViewMode, c: Date): [Date, Date] => {
    if (v === 'month') {
      return [startOfMonth(c.getFullYear(), c.getMonth()), endOfMonth(c.getFullYear(), c.getMonth())];
    }
    if (v === 'week') {
      const s = startOfWeek(c);
      return [s, addDays(s, 6)];
    }
    return [c, c];
  }, []);

  const fetchEvents = useCallback(async (v: ViewMode, c: Date, s: Scope) => {
    setLoading(true);
    try {
      const [from, to] = getRange(v, c);
      const data = await api.get<{ events: CalEvent[] }>(
        `/calendar?from=${isoDate(from)}&to=${isoDate(to)}&scope=${s}`
      );
      setEvents(data.events ?? []);
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to load calendar');
    } finally {
      setLoading(false);
    }
  }, [getRange]);

  useEffect(() => { fetchEvents(view, cursor, scope); }, [view, cursor, scope]);

  const fetchUpcoming = useCallback(async (s: Scope) => {
    setUpcomingLoading(true);
    try {
      const today = new Date();
      const from = today;
      const to = addDays(today, 14);
      const [tasksRes, eventsRes] = await Promise.all([
        s === 'mine'
          ? api.get<{ tasks: FollowUpTask[] }>('/tasks/my')
          : api.get<{ tasks: FollowUpTask[] }>('/tasks/team').catch(() => ({ tasks: [] })),
        api.get<{ events: CalEvent[] }>(`/calendar?from=${isoDate(from)}&to=${isoDate(to)}&scope=${s}`),
      ]);
      setUpcomingTasks((tasksRes.tasks ?? []).filter((t) => t.status === 'PENDING'));
      setUpcomingEvents(eventsRes.events ?? []);
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to load upcoming items');
    } finally {
      setUpcomingLoading(false);
    }
  }, []);

  useEffect(() => { if (view === 'upcoming') fetchUpcoming(scope); }, [view, scope, fetchUpcoming]);

  // Upcoming work follows the India team's Tuesday–Sunday work week. Monday
  // is a day off, so it belongs to neither work-week bucket. Tomorrow remains
  // a separate, higher-priority bucket when applicable.
  const bucketForDateKey = (dateKey: string): Bucket | null => {
    const todayKey = istDateOnly(today);
    if (dateKey <= todayKey) return null;
    if (dateKey === addDaysToDateKey(todayKey, 1)) return 'tomorrow';

    const { thisWeekStart, thisWeekEnd, nextWeekStart, nextWeekEnd } = workWeekBounds(todayKey);
    if (dateKey >= thisWeekStart && dateKey <= thisWeekEnd) return 'thisWeek';
    if (dateKey >= nextWeekStart && dateKey <= nextWeekEnd) return 'nextWeek';
    return null;
  };

  interface UpcomingItem { id: string; kind: 'Task' | 'Call' | 'Meeting'; title: string; leadName: string; leadDbId: string; dateLabel: string; bucket: Bucket }

  const upcomingItems: UpcomingItem[] = [
    ...upcomingTasks.flatMap((t) => {
      const bucket = bucketForDateKey(istDateOnly(t.dueDate));
      if (!bucket || !t.lead) return [];
      return [{
        id: `task-${t.id}`,
        kind: (t.callStageType ? 'Call' : 'Task') as 'Task' | 'Call',
        title: t.agenda || (t.callStageType ? `${t.callStageType} call` : 'Follow-up task'),
        leadName: t.lead.name,
        leadDbId: t.lead.id,
        dateLabel: formatISTDate(t.dueDate),
        bucket,
      }];
    }),
    ...upcomingEvents.flatMap((ev) => {
      const bucket = bucketForDateKey(istDateKey(ev.scheduledAt));
      if (!bucket) return [];
      return [{
        id: `meeting-${ev.id}`,
        kind: 'Meeting' as const,
        title: `${ev.type}${ev.ppNumber ? ` PP${ev.ppNumber}` : ''}`,
        leadName: ev.leadName,
        leadDbId: ev.leadDbId,
        dateLabel: formatISTDate(ev.scheduledAt),
        bucket,
      }];
    }),
  ];

  const KIND_BADGE: Record<UpcomingItem['kind'], string> = {
    Task: 'bg-stone-100 text-stone-700',
    Call: 'bg-amber-100 text-amber-700',
    Meeting: 'bg-green-100 text-green-700',
  };

  const renderUpcoming = () => (
    <div className="flex-1 overflow-auto p-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {([['tomorrow', 'Tomorrow'], ['thisWeek', 'This Week'], ['nextWeek', 'Next Week']] as [Bucket, string][]).map(([bucket, label]) => {
          const items = upcomingItems.filter((it) => it.bucket === bucket);
          return (
            <div key={bucket} className="bg-white rounded-2xl border border-gray-100 flex flex-col">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-800">{label}</h3>
                <span className="text-xs text-gray-400 font-medium">{items.length}</span>
              </div>
              <div className="p-3 space-y-2 flex-1">
                {items.length === 0 && !upcomingLoading && (
                  <p className="text-xs text-gray-400 text-center py-6">Nothing scheduled</p>
                )}
                {items.map((it) => (
                  <button
                    key={it.id}
                    onClick={() => navigate(`/leads/${it.leadDbId}`)}
                    className="w-full text-left p-2.5 rounded-xl border border-gray-100 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${KIND_BADGE[it.kind]}`}>{it.kind}</span>
                      <span className="text-[10px] text-gray-400">{it.dateLabel}</span>
                    </div>
                    <p className="text-xs font-medium text-gray-800 mt-1 truncate">{it.title}</p>
                    <p className="text-[11px] text-gray-500 truncate">{it.leadName}</p>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const goTo = (offset: number) => {
    setCursor((c) => {
      if (view === 'month') return new Date(c.getFullYear(), c.getMonth() + offset, 1);
      if (view === 'week')  return addDays(c, offset * 7);
      return addDays(c, offset);
    });
  };

  const goToday = () => {
    if (view === 'month') setCursor(new Date(today.getFullYear(), today.getMonth(), 1));
    else setCursor(new Date(today));
  };

  const navigate2Lead = (ev: CalEvent) => navigate(`/leads/${ev.leadDbId}`);

  const eventsOnDate = (d: Date) => {
    const key = isoDate(d);
    return events.filter((e) => istDateKey(e.scheduledAt) === key);
  };

  const eventsInHour = (d: Date, hour: number) => {
    const key = isoDate(d);
    return events.filter((e) => istDateKey(e.scheduledAt) === key && istHour(e.scheduledAt) === hour);
  };

  const periodLabel = () => {
    if (view === 'month') return `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;
    if (view === 'week') {
      const s = startOfWeek(cursor);
      const e = addDays(s, 6);
      return `${s.getDate()} ${MONTHS[s.getMonth()].slice(0,3)} – ${e.getDate()} ${MONTHS[e.getMonth()].slice(0,3)} ${e.getFullYear()}`;
    }
    return `${cursor.getDate()} ${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;
  };

  // ── Month grid ─────────────────────────────────────────────────────────────

  const renderMonth = () => {
    const firstDay = new Date(cursor.getFullYear(), cursor.getMonth(), 1).getDay();
    const daysInMonth = endOfMonth(cursor.getFullYear(), cursor.getMonth()).getDate();
    const cells: (Date | null)[] = [
      ...Array(firstDay).fill(null),
      ...Array.from({ length: daysInMonth }, (_, i) => new Date(cursor.getFullYear(), cursor.getMonth(), i + 1)),
    ];
    while (cells.length % 7 !== 0) cells.push(null);

    return (
      <div className="flex-1 overflow-auto">
        <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50">
          {DAYS_SHORT.map((d) => (
            <div key={d} className="py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 flex-1" style={{ minHeight: '480px' }}>
          {cells.map((d, i) => {
            if (!d) return <div key={`e${i}`} className="border-b border-r border-gray-100 bg-gray-50/50" />;
            const dayEvents = eventsOnDate(d);
            const isToday = isoDate(d) === isoDate(today);
            return (
              <div
                key={isoDate(d)}
                className="border-b border-r border-gray-100 p-1.5 min-h-[96px] hover:bg-gray-50/60 transition-colors"
                title="Schedule meetings from a lead's page"
              >
                <div className={`w-6 h-6 flex items-center justify-center rounded-full text-xs font-medium mb-1 ${
                  isToday ? 'bg-brand-500 text-white' : 'text-gray-600'
                }`}>
                  {d.getDate()}
                </div>
                <div className="space-y-0.5">
                  {dayEvents.slice(0, 3).map((ev) => (
                    <EventChip key={ev.id} ev={ev} onClick={() => navigate2Lead(ev)} compact />
                  ))}
                  {dayEvents.length > 3 && (
                    <p className="text-[10px] text-gray-400 pl-1">+{dayEvents.length - 3} more</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── Week grid ──────────────────────────────────────────────────────────────

  const renderWeek = () => {
    const weekStart = startOfWeek(cursor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

    return (
      <div className="flex-1 overflow-auto">
        {/* Day headers */}
        <div className="grid grid-cols-8 border-b border-gray-200 bg-gray-50 sticky top-0 z-10">
          <div className="py-2 border-r border-gray-100" />
          {days.map((d) => {
            const isToday = isoDate(d) === isoDate(today);
            return (
              <div key={isoDate(d)} className="py-2 text-center border-r border-gray-100 last:border-r-0">
                <span className="text-[10px] text-gray-500 uppercase tracking-wide block">{DAYS_SHORT[d.getDay()]}</span>
                <span className={`text-sm font-semibold inline-flex w-7 h-7 items-center justify-center rounded-full mx-auto ${isToday ? 'bg-brand-500 text-white' : 'text-gray-800'}`}>
                  {d.getDate()}
                </span>
              </div>
            );
          })}
        </div>

        {/* Hour rows */}
        {HOURS.map((hour) => (
          <div key={hour} className="grid grid-cols-8 border-b border-gray-100 min-h-[56px]">
            <div className="border-r border-gray-100 px-2 py-1 text-[10px] text-gray-400 text-right pt-1.5">
              {hour < 12 ? `${hour}am` : hour === 12 ? '12pm' : `${hour - 12}pm`}
            </div>
            {days.map((d) => {
              const evs = eventsInHour(d, hour);
              return (
                <div key={isoDate(d)} className="border-r border-gray-100 last:border-r-0 p-0.5 space-y-0.5">
                  {evs.map((ev) => (
                    <EventChip key={ev.id} ev={ev} onClick={() => navigate2Lead(ev)} compact />
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  };

  // ── Day grid ───────────────────────────────────────────────────────────────

  const renderDay = () => (
    <div className="flex-1 overflow-auto">
      <div className="grid grid-cols-[80px_1fr] divide-x divide-gray-100">
        {HOURS.flatMap((hour) => {
          const evs = eventsInHour(cursor, hour);
          return [
            <div key={`h${hour}`} className="border-b border-gray-100 px-2 py-2 text-xs text-gray-400 text-right">
              {hour < 12 ? `${hour}:00 AM` : hour === 12 ? '12:00 PM' : `${hour - 12}:00 PM`}
            </div>,
            <div key={`c${hour}`} className="border-b border-gray-100 p-1.5 min-h-[56px] space-y-1">
              {evs.map((ev) => (
                <EventChip key={ev.id} ev={ev} onClick={() => navigate2Lead(ev)} />
              ))}
            </div>,
          ];
        })}
      </div>
    </div>
  );

  const isEmpty = events.length === 0 && !loading;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="shrink-0 px-5 py-3 border-b border-gray-100 bg-white flex items-center gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-gray-900">Calendar</h1>
        </div>

        <div className="flex items-center gap-1 ml-2">
          <button onClick={() => goTo(-1)} className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-500 transition-colors text-sm">‹</button>
          <button onClick={() => goTo(1)}  className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-500 transition-colors text-sm">›</button>
          <span className="ml-1 text-sm font-medium text-gray-800 min-w-[160px]">{periodLabel()}</span>
          <button onClick={goToday} className="ml-1 text-xs text-brand-600 hover:text-brand-700 font-medium px-2 py-1 rounded-lg hover:bg-brand-50 transition-colors">
            Today
          </button>
        </div>

        <div className="flex items-center gap-1 ml-auto">
          {canToggleScope && (
            <div className="flex items-center gap-1 mr-3 bg-gray-100 rounded-lg p-0.5">
              <button
                onClick={() => setScope('mine')}
                className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${scope === 'mine' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
              >
                My schedule
              </button>
              <button
                onClick={() => setScope('team')}
                className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${scope === 'team' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
              >
                Team schedule
              </button>
            </div>
          )}

          <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
            {(['month', 'week', 'day', 'upcoming'] as ViewMode[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`text-xs font-medium px-2.5 py-1 rounded-md capitalize transition-colors ${view === v ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="shrink-0 px-5 py-1.5 bg-gray-50 border-b border-gray-100 flex items-center gap-4">
        {[['DQL','bg-blue-500'],['PP','bg-orange-500'],['Onboarding','bg-green-500']].map(([label, dot]) => (
          <div key={label} className="flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
            <span className="text-[10px] text-gray-500 font-medium">{label}</span>
          </div>
        ))}
        {loading && <span className="ml-auto text-[10px] text-gray-400 animate-pulse">Loading…</span>}
      </div>

      {/* Calendar body */}
      {view === 'upcoming' ? (
        renderUpcoming()
      ) : isEmpty ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-14 h-14 rounded-2xl bg-stone-100 flex items-center justify-center mb-3">
              <CalendarDays size={26} strokeWidth={1.5} className="text-stone-400" />
            </div>
            <p className="text-sm font-medium text-gray-600">No meetings scheduled for this period</p>
            <p className="text-xs text-gray-400 mt-1">Schedule meetings from a lead's page</p>
          </div>
        </div>
      ) : (
        view === 'month' ? renderMonth() :
        view === 'week'  ? renderWeek()  :
                           renderDay()
      )}
    </div>
  );
}
