import { useCallback, useEffect, useState } from 'react';
import { formatTime12 } from '../lib/dateFormat';
import { Link } from 'react-router-dom';
import { CalendarDays, Clock3, Phone, UserRound } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../lib/api';

interface CallRow {
  id: string;
  outcome: string;
  duration: number | null;
  notes: string | null;
  agenda: string | null;
  calledAt: string | null;
  createdAt: string;
  loggedBy: { id: string; name: string; role: string };
  lead: { id: string; leadId: string; name: string };
}

interface ScheduledCall {
  id: string;
  dueDate: string;
  dueTime: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  isOverdue: boolean;
  status: string;
  agenda: string | null;
  callStageType: string | null;
  assignedTo: { id: string; name: string; role: string };
  lead: { id: string; leadId: string; name: string; stage: string };
}

type PageTab = 'scheduled' | 'history';

const OUTCOME_STYLE: Record<string, string> = {
  ANSWERED: 'bg-green-100 text-green-700',
  CALLBACK: 'bg-amber-100 text-amber-800',
  MEETING_SCHEDULED: 'bg-brand-50 text-brand-700',
};

function outcomeLabel(outcome: string) {
  if (outcome.startsWith('RNR_')) return `RNR · ${outcome.replace('RNR_', '')}`;
  if (outcome === 'MEETING_SCHEDULED') return 'Meeting scheduled';
  return outcome === 'ANSWERED' ? 'Answered' : outcome === 'CALLBACK' ? 'Callback' : outcome.replace(/_/g, ' ');
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function durationLabel(seconds: number | null) {
  if (seconds == null || seconds < 0) return null;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function KpiCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="bg-white rounded-2xl p-5 flex flex-col gap-1 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
      <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest">{label}</p>
      <p className={`text-3xl font-extrabold tracking-tight ${color ?? 'text-stone-900'}`}>{value}</p>
    </div>
  );
}

export default function Calls() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [scheduledCalls, setScheduledCalls] = useState<ScheduledCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<PageTab>('history');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ calls: CallRow[]; scheduledCalls: ScheduledCall[] }>('/calls');
      setCalls(data.calls);
      setScheduledCalls(data.scheduledCalls);
    } catch (caught: any) {
      setError(caught.message);
      toast.error(caught.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const answered = calls.filter((call) => call.outcome === 'ANSWERED').length;
  const rnr = calls.filter((call) => call.outcome.startsWith('RNR_')).length;
  const callbacks = calls.filter((call) => call.outcome === 'CALLBACK').length;
  const meetingsBooked = calls.filter((call) => call.outcome === 'MEETING_SCHEDULED').length;
  const historyCalls = [...calls].sort((a, b) =>
    new Date(b.calledAt ?? b.createdAt).getTime() - new Date(a.calledAt ?? a.createdAt).getTime());

  return (
    <div>
      <div className="bg-white px-6 py-4" style={{ borderBottom: '1px solid #EDE8E3' }}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">Calls</h1>
            <p className="text-xs text-stone-400 mt-0.5">Call activity across your leads</p>
          </div>
          <Link to="/leads" className="rounded-xl bg-brand-500 hover:bg-brand-600 text-white px-4 py-2 text-sm font-semibold transition-colors">
            Open leads
          </Link>
        </div>
      </div>

      <div className="px-6 py-4 space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <KpiCard label="Total logged" value={calls.length} />
          <KpiCard label="Answered" value={answered} color="text-green-600" />
          <KpiCard label="RNR" value={rnr} color="text-amber-600" />
          <KpiCard label="Callback" value={callbacks} color="text-brand-600" />
          <KpiCard label="Meetings booked" value={meetingsBooked} color="text-purple-600" />
        </div>

        <div className="bg-white rounded-2xl overflow-hidden shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
          <div className="flex" style={{ borderBottom: '1px solid #EDE8E3' }}>
            {([
              ['scheduled', `Scheduled (${scheduledCalls.length})`],
              ['history', `Call history (${calls.length})`],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`px-5 py-3 text-sm font-semibold border-b-2 transition-colors ${
                  tab === id ? 'border-brand-500 text-brand-600' : 'border-transparent text-stone-500 hover:text-stone-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="py-16 text-center text-stone-400 text-sm animate-pulse">Loading calls…</div>
          ) : error ? (
            <div className="py-16 text-center">
              <p className="text-red-600 text-sm mb-3">Could not load calls: {error}</p>
              <button onClick={load} className="text-sm font-semibold text-brand-600 hover:underline">Try again</button>
            </div>
          ) : tab === 'scheduled' ? (
            scheduledCalls.length === 0 ? (
              <div className="py-16 text-center">
                <div className="w-12 h-12 rounded-2xl bg-stone-100 flex items-center justify-center mx-auto mb-2">
                  <CalendarDays size={22} strokeWidth={1.5} className="text-stone-400" />
                </div>
                <p className="text-stone-400 text-sm">No scheduled calls</p>
              </div>
            ) : (
              <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {scheduledCalls.map((call) => {
                  const dueTime = call.timeFrom ?? call.dueTime;
                  return (
                    <div key={call.id} className="bg-white rounded-2xl p-4 flex flex-col gap-2" style={{ border: '1px solid #EDE8E3' }}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <Link to={`/leads/${call.lead.id}`} className="font-bold text-stone-900 text-sm leading-tight tracking-tight hover:text-brand-600">
                            {call.lead.name}
                          </Link>
                          <p className="text-xs text-brand-500 font-mono font-semibold">{call.lead.leadId}</p>
                        </div>
                        {call.isOverdue && <span className="text-xs px-2 py-0.5 rounded-full font-semibold text-red-700 bg-red-100 shrink-0">Overdue</span>}
                      </div>
                      <div className="flex gap-1.5 flex-wrap">
                        <span className="text-xs bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full font-semibold">
                          {call.callStageType ?? 'Scheduled call'}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium text-stone-600" style={{ background: '#F5F0EB' }}>
                          {call.lead.stage.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-stone-500">
                        <CalendarDays size={13} strokeWidth={1.8} />
                        <span>{formatDate(call.dueDate)}</span>
                        {dueTime && <><span className="text-stone-300">·</span><Clock3 size={12} /><span>{formatTime12(dueTime)}</span></>}
                      </div>
                      {call.agenda && <p className="text-xs text-stone-400 italic">{call.agenda}</p>}
                      <div className="flex items-center gap-1.5 text-xs text-stone-500 pt-1">
                        <UserRound size={13} strokeWidth={1.8} />
                        <span>{call.assignedTo.name}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : calls.length === 0 ? (
            <div className="py-16 text-center">
              <div className="w-12 h-12 rounded-2xl bg-stone-100 flex items-center justify-center mx-auto mb-2">
                <Phone size={22} strokeWidth={1.5} className="text-stone-400" />
              </div>
              <p className="text-stone-400 text-sm">No calls logged yet</p>
            </div>
          ) : (
            <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {historyCalls.map((call) => {
                const date = call.calledAt ?? call.createdAt;
                const duration = durationLabel(call.duration);
                return (
                  <div key={call.id} className="bg-white rounded-2xl p-4 flex flex-col gap-2" style={{ border: '1px solid #EDE8E3' }}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link to={`/leads/${call.lead.id}`} className="font-bold text-stone-900 text-sm leading-tight tracking-tight hover:text-brand-600">
                          {call.lead.name}
                        </Link>
                        <p className="text-xs text-brand-500 font-mono font-semibold">{call.lead.leadId}</p>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold shrink-0 ${OUTCOME_STYLE[call.outcome] ?? 'bg-stone-100 text-stone-600'}`}>
                        {outcomeLabel(call.outcome)}
                      </span>
                    </div>
                    {call.agenda && <p className="text-xs text-stone-500">{call.agenda}</p>}
                    <div className="flex items-center gap-1.5 text-xs text-stone-500">
                      <CalendarDays size={13} strokeWidth={1.8} />
                      <span>{formatDate(date)}</span>
                      <span className="text-stone-300">·</span>
                      <span>{formatTime(date)}</span>
                      {duration && <><span className="text-stone-300">·</span><span>{duration}</span></>}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-stone-500">
                      <UserRound size={13} strokeWidth={1.8} />
                      <span>{call.loggedBy.name}</span>
                    </div>
                    {call.notes && <p className="text-xs text-stone-400 whitespace-pre-line line-clamp-3">{call.notes}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}