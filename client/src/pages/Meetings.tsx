import { useEffect, useState, useCallback } from 'react';
import { CalendarDays } from 'lucide-react';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import { meetingModeLabel, meetingRules } from '../lib/meetingSettings';

interface Lead {
  id: string; leadId: string; name: string; phone?: string;
  assignedDesigner?: { id: string; name: string } | null;
}

interface Meeting {
  id: string; type: string; mode: string; status: string;
  scheduledAt: string; ppNumber?: number | null;
  mom?: string | null; outcome?: string | null;
  rescheduledReason?: string | null; momSent?: boolean;
  lead: Lead;
}

const STATUS_COLORS: Record<string, string> = {
  SCHEDULED: 'bg-brand-50 text-brand-700',
  COMPLETED: 'bg-green-100 text-green-700',
  NO_SHOW: 'bg-red-100 text-red-700',
  RESCHEDULED: 'bg-amber-100 text-amber-800',
};

const STATUS_LABELS: Record<string, string> = {
  SCHEDULED: 'Scheduled', COMPLETED: 'Completed',
  NO_SHOW: 'No-show', RESCHEDULED: 'Rescheduled',
};


const TYPE_AGENDAS: Record<string, string> = {
  DQL: 'Initial design consultation',
  PP: 'Proposal presentation',
};

function meetingTypeLabel(m: Meeting) {
  if (m.type === 'PP' && m.ppNumber) return `PP${m.ppNumber}`;
  return m.type;
}

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }),
  };
}

function KpiCard({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color?: string }) {
  return (
    <div className="bg-white rounded-2xl p-5 flex flex-col gap-1 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
      <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest">{label}</p>
      <p className={`text-3xl font-extrabold tracking-tight ${color ?? 'text-stone-900'}`}>{value}</p>
      {sub && <p className="text-xs text-stone-400">{sub}</p>}
    </div>
  );
}

export default function Meetings() {
  const now = new Date();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');

  const [completeModal, setCompleteModal] = useState<Meeting | null>(null);
  const [noShowModal, setNoShowModal] = useState<Meeting | null>(null);
  const [mom, setMom] = useState('');
  const [outcome, setOutcome] = useState('');
  const [noShowReason, setNoShowReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<{ meetings: Meeting[] }>('/meetings');
      setMeetings(d.meetings);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const upcoming = meetings.filter(m => m.status === 'SCHEDULED' && new Date(m.scheduledAt) >= now)
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  const past = meetings.filter(m => m.status !== 'SCHEDULED' || new Date(m.scheduledAt) < now)
    .sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime());

  const rescheduled = meetings.filter(m => m.status === 'RESCHEDULED').length;
  const kpi = {
    upcoming: meetings.filter(m => m.status === 'SCHEDULED' && new Date(m.scheduledAt) >= now).length,
    completed: meetings.filter(m => m.status === 'COMPLETED').length,
    noShow: meetings.filter(m => m.status === 'NO_SHOW').length,
    rescheduled,
    total: meetings.length,
  };

  const openComplete = (m: Meeting) => { setMom(''); setOutcome(''); setCompleteModal(m); };
  const openNoShow = (m: Meeting) => { setNoShowReason(''); setNoShowModal(m); };

  const handleComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (meetingRules().requireMom && !mom.trim()) { toast.error('MOM is required'); return; }
    if (!outcome.trim()) { toast.error('Outcome is required'); return; }
    if (!completeModal) return;
    setSubmitting(true);
    try {
      await api.patch(`/meetings/${completeModal.id}/status`, { status: 'COMPLETED', mom, outcome });
      toast.success('Meeting marked complete');
      setCompleteModal(null);
      await load();
    } catch (e: any) { toast.error(e.message); }
    finally { setSubmitting(false); }
  };

  const handleNoShow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (meetingRules().requireNoShowReason && !noShowReason.trim()) { toast.error('Reason is required'); return; }
    if (!noShowModal) return;
    setSubmitting(true);
    try {
      await api.patch(`/meetings/${noShowModal.id}/status`, { status: 'NO_SHOW', noShowReason });
      toast.success('Meeting marked no-show');
      setNoShowModal(null);
      await load();
    } catch (e: any) { toast.error(e.message); }
    finally { setSubmitting(false); }
  };

  const displayed = tab === 'upcoming' ? upcoming : past;

  return (
    <div className="min-h-screen">
      {/* Complete modal */}
      {completeModal && (
        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-warm-lg w-full max-w-md p-6">
            <h3 className="font-bold text-stone-900 mb-1 tracking-tight">Mark Meeting Complete</h3>
            <p className="text-xs text-stone-400 mb-4">{completeModal.lead.name} · {meetingTypeLabel(completeModal)} · {fmtDateTime(completeModal.scheduledAt).date}</p>
            <form onSubmit={handleComplete} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-stone-700 mb-1.5">
                  Minutes of Meeting (MOM) <span className="text-brand-500">*</span>
                </label>
                <textarea rows={4} value={mom} onChange={e => setMom(e.target.value)} required={meetingRules().requireMom}
                  placeholder="Summarise what was discussed, decisions made, client feedback..."
                  className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 resize-none transition-all"
                  style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
              </div>
              <div>
                <label className="block text-sm font-semibold text-stone-700 mb-1.5">
                  Outcome <span className="text-brand-500">*</span>
                </label>
                <textarea rows={2} value={outcome} onChange={e => setOutcome(e.target.value)} required
                  placeholder="e.g. Client approved 2BHK concept, ready for proposal..."
                  className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 resize-none transition-all"
                  style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => setCompleteModal(null)}
                  className="flex-1 text-stone-600 py-2.5 rounded-xl text-sm hover:bg-stone-50 transition-colors"
                  style={{ border: '1px solid #EDE8E3' }}>Cancel</button>
                <button type="submit" disabled={submitting}
                  className="flex-1 bg-brand-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-brand-600 disabled:opacity-50 transition-colors">
                  {submitting ? 'Saving…' : 'Mark Complete'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* No-show modal */}
      {noShowModal && (
        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-warm-lg w-full max-w-sm p-6">
            <h3 className="font-bold text-stone-900 mb-1 tracking-tight">Mark as No-show</h3>
            <p className="text-xs text-stone-400 mb-4">{noShowModal.lead.name} · {meetingTypeLabel(noShowModal)}</p>
            <form onSubmit={handleNoShow} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-stone-700 mb-1.5">
                  Reason <span className="text-brand-500">*</span>
                </label>
                <textarea rows={3} value={noShowReason} onChange={e => setNoShowReason(e.target.value)} required={meetingRules().requireNoShowReason}
                  placeholder="e.g. Client did not pick up calls, WhatsApp unread..."
                  className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 resize-none transition-all"
                  style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
                <p className="text-xs text-stone-400 mt-1">Required — you must provide a reason to mark a meeting as no-show.</p>
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => setNoShowModal(null)}
                  className="flex-1 text-stone-600 py-2.5 rounded-xl text-sm hover:bg-stone-50 transition-colors"
                  style={{ border: '1px solid #EDE8E3' }}>Cancel</button>
                <button type="submit" disabled={submitting}
                  className="flex-1 bg-red-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-red-600 disabled:opacity-50 transition-colors">
                  {submitting ? 'Saving…' : 'Mark No-show'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div className="bg-white px-6 py-4" style={{ borderBottom: '1px solid #EDE8E3' }}>
        <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">Meetings</h1>
        <p className="text-xs text-stone-400 mt-0.5">Meetings scheduled by CREs in your scope</p>
      </div>

      <div className="px-6 py-4 space-y-4">
        {/* KPI bar */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <KpiCard label="Upcoming" value={kpi.upcoming} sub="Scheduled ahead" color="text-brand-600" />
          <KpiCard label="Completed" value={kpi.completed} sub="Successfully done" color="text-green-600" />
          <KpiCard label="No-show" value={kpi.noShow} sub="Client absent" color="text-red-500" />
          <KpiCard label="Rescheduled" value={`${kpi.rescheduled}/${kpi.total}`} sub="Of all meetings" color="text-amber-600" />
          <KpiCard label="Total" value={kpi.total} sub="CRE-scheduled in scope" />
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-2xl overflow-hidden shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
          <div className="flex" style={{ borderBottom: '1px solid #EDE8E3' }}>
            {([['upcoming', `Upcoming (${upcoming.length})`], ['past', `Past (${past.length})`]] as const).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`px-5 py-3 text-sm font-semibold border-b-2 transition-colors ${
                  tab === id ? 'border-brand-500 text-brand-600' : 'border-transparent text-stone-500 hover:text-stone-700'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="py-16 text-center text-stone-400 text-sm animate-pulse">Loading meetings…</div>
          ) : displayed.length === 0 ? (
            <div className="py-16 text-center">
              <div className="w-12 h-12 rounded-2xl bg-stone-100 flex items-center justify-center mx-auto mb-2">
                <CalendarDays size={22} strokeWidth={1.5} className="text-stone-400" />
              </div>
              <p className="text-stone-400 text-sm">No {tab} meetings</p>
            </div>
          ) : (
            <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {displayed.map(m => {
                const { date, time } = fmtDateTime(m.scheduledAt);
                const typeLabel = meetingTypeLabel(m);
                return (
                  <div key={m.id} className="bg-white rounded-2xl p-4 flex flex-col gap-2 transition-all hover:shadow-warm"
                    style={{ border: '1px solid #EDE8E3', boxShadow: '0 1px 3px 0 rgba(100,60,20,0.06)' }}>
                    {/* Row 1: name + status */}
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-bold text-stone-900 text-sm leading-tight tracking-tight">{m.lead.name}</p>
                        <span className="text-xs text-brand-500 font-mono font-semibold">{m.lead.leadId}</span>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold shrink-0 ${STATUS_COLORS[m.status] ?? 'bg-stone-100 text-stone-600'}`}>
                        {STATUS_LABELS[m.status] ?? m.status}
                      </span>
                    </div>

                    {/* Row 2: type + mode chips */}
                    <div className="flex gap-1.5 flex-wrap">
                      <span className="text-xs bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full font-semibold">{typeLabel}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium text-stone-600" style={{ background: '#F5F0EB' }}>{meetingModeLabel(m.mode)}</span>
                    </div>

                    {/* Row 3: date + time */}
                    <div className="flex items-center gap-1.5 text-xs text-stone-500">
                      <CalendarDays size={13} strokeWidth={1.8} className="shrink-0" />
                      <span>{date}</span>
                      <span className="text-stone-300">·</span>
                      <span>{time}</span>
                    </div>

                    {/* Row 4: agenda */}
                    <p className="text-xs text-stone-400 italic">{TYPE_AGENDAS[m.type] ?? m.type}</p>

                    {/* Bottom: assignee + action */}
                    <div className="flex items-center justify-between gap-2 pt-1.5 mt-auto" style={{ borderTop: '1px solid #F5F0EB' }}>
                      <div className="flex items-center gap-1.5">
                        {m.lead.assignedDesigner ? (
                          <>
                            <span className="w-5 h-5 rounded-full bg-brand-100 text-brand-700 text-xs font-bold flex items-center justify-center">
                              {m.lead.assignedDesigner.name.charAt(0)}
                            </span>
                            <span className="text-xs text-stone-500 truncate max-w-[90px]">{m.lead.assignedDesigner.name}</span>
                          </>
                        ) : <span className="text-xs text-stone-300">Unassigned</span>}
                      </div>

                      {m.status === 'SCHEDULED' && (
                        <div className="flex gap-1.5">
                          <button onClick={() => openNoShow(m)}
                            className="text-xs text-stone-600 px-2.5 py-1 rounded-xl hover:bg-stone-50 transition-colors font-medium"
                            style={{ border: '1px solid #EDE8E3' }}>
                            No-show
                          </button>
                          <button onClick={() => openComplete(m)}
                            className="text-xs bg-brand-500 text-white px-2.5 py-1 rounded-xl hover:bg-brand-600 transition-colors font-semibold">
                            Complete
                          </button>
                        </div>
                      )}
                      {m.status === 'COMPLETED' && (
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">MOM sent</span>
                      )}
                      {m.status === 'RESCHEDULED' && (
                        <div className="text-right">
                          <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-semibold">Rescheduled</span>
                          {m.rescheduledReason && (
                            <p className="text-xs text-stone-400 mt-0.5 max-w-[120px] truncate" title={m.rescheduledReason}>{m.rescheduledReason}</p>
                          )}
                        </div>
                      )}
                      {m.status === 'NO_SHOW' && (
                        <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-semibold">No-show</span>
                      )}
                    </div>
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
