// Lenient-launch visibility: what the team moved past (bypass log) and what is
// still blank on each lead (data completeness), each with an owner.
import { DateInput } from '../components/ui/DateTimeInputs';
import { getStoredUser } from '../lib/auth';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import EmptyState from '../components/ui/EmptyState';
import { stageLabel as crmStageLabel } from '../lib/crmSettings';

const STAGES: { value: string; label: string }[] = [
  { value: 'MQL', label: 'MQL' },
  { value: 'DQL', label: 'DQL' },
  { value: 'PROPOSAL_READY', label: 'Proposal Ready' },
  { value: 'PROPOSAL_PRESENTED', label: 'Proposal Presented' },
  { value: 'PROPOSAL_DISCUSSION', label: 'Pitch Discussion' },
  { value: 'ONBOARDING', label: 'Onboarding' },
  { value: 'ONBOARDING_MEETING', label: 'Onboarding Meeting' },
  { value: 'DESIGN_IN_PROGRESS', label: 'Design in Progress' },
];
// Names follow Admin → CRM Settings.
const stageLabel = (s?: string | null) => (s ? crmStageLabel(s) || STAGES.find((x) => x.value === s)?.label || s.replace(/_/g, ' ') : '—');

interface Person { id: string; name: string; role: string }
interface LeadRef { id: string; leadId: string; name: string }
interface BypassRow {
  id: string; at: string; item: string; kind: string | null;
  fromStage: string | null; toStage: string | null; stage: string | null;
  by: Person | null; lead: (LeadRef & { currentStage: string }) | null;
}
interface GapRow {
  id: string; lead: LeadRef; stage: string; itemKey: string; item: string; requiredFrom: string;
  owner: Person | null; since: string; daysOutstanding: number;
}

const KIND_LABEL: Record<string, string> = {
  STAGE_GATE: 'Stage move',
  PD_OB_CHECKLIST: 'PD → OB checklist',
  OB_OBM_CHECKLIST: 'OB → OBM checklist',
  CALL_FOLLOWUP_SKIPPED: 'Call saved without follow-up',
  TASK_COMPLETED_NO_ATTACHMENT: 'Task completed without attachment',
};

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });

const selectCls = 'rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-300';
const selectStyle = { border: '1px solid #EDE8E3' };

function BypassLog({ includeTest }: { includeTest: boolean }) {
  const [rows, setRows] = useState<BypassRow[]>([]);
  const [byPerson, setByPerson] = useState<(Person & { count: number })[]>([]);
  const [userId, setUserId] = useState('');
  const [stage, setStage] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (userId) p.set('userId', userId);
      if (stage) p.set('stage', stage);
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      if (includeTest) p.set('includeTest', 'true');
      const d = await api.get<{ rows: BypassRow[]; byPerson: (Person & { count: number })[] }>(`/data-quality/bypasses?${p}`);
      setRows(d.rows); setByPerson(d.byPerson);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [userId, stage, from, to, includeTest]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <p className="text-sm text-stone-500 mb-4">
        Every time someone moved a lead forward, or sent a checklist, with items still missing. Who did it and when is recorded.
      </p>
      <div className="flex flex-wrap gap-3 mb-4">
        <select className={selectCls} style={selectStyle} value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Everyone</option>
          {byPerson.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.count})</option>)}
        </select>
        <select className={selectCls} style={selectStyle} value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">All stages moved into</option>
          {STAGES.map((s) => <option key={s.value} value={s.value}>{stageLabel(s.value)}</option>)}
        </select>
        <span className="w-36" aria-label="From date"><DateInput value={from} onChange={setFrom} placeholderText="From date" className={`${selectCls} w-full border border-[#EDE8E3]`} /></span>
        <span className="w-36" aria-label="To date"><DateInput value={to} onChange={setTo} placeholderText="To date" className={`${selectCls} w-full border border-[#EDE8E3]`} /></span>
      </div>
      {error && <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm mb-4">{error}</div>}
      {loading ? <p className="text-sm text-stone-400">Loading…</p> : rows.length === 0 ? (
        <EmptyState title="Nothing skipped yet" description="No stage move or checklist has gone ahead with missing items." />
      ) : (
        <div className="bg-white rounded-2xl overflow-x-auto" style={{ border: '1px solid #EDE8E3' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-stone-400 uppercase tracking-wide">
                <th className="px-4 py-3">When</th><th className="px-4 py-3">Lead</th><th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Missing item</th><th className="px-4 py-3">Done by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid #F3EEE9' }}>
                  <td className="px-4 py-2.5 whitespace-nowrap text-stone-500">{fmt(r.at)}</td>
                  <td className="px-4 py-2.5">
                    {r.lead ? <Link to={`/leads/${r.lead.id}`} className="text-brand-600 hover:underline">{r.lead.leadId} · {r.lead.name}</Link> : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-stone-600">
                    {r.fromStage && r.toStage ? `${stageLabel(r.fromStage)} → ${stageLabel(r.toStage)}` : (KIND_LABEL[r.kind ?? ''] ?? r.kind ?? '—')}
                  </td>
                  <td className="px-4 py-2.5 text-stone-800">{r.item}</td>
                  <td className="px-4 py-2.5 text-stone-600">{r.by ? `${r.by.name}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Completeness({ includeTest }: { includeTest: boolean }) {
  const [rows, setRows] = useState<GapRow[]>([]);
  const [byOwner, setByOwner] = useState<{ id: string | null; name: string; role: string | null; count: number; leads: number }[]>([]);
  const [items, setItems] = useState<{ key: string; label: string }[]>([]);
  const [summary, setSummary] = useState({ checked: 0, withGaps: 0 });
  const [ownerId, setOwnerId] = useState('');
  const [stage, setStage] = useState('');
  const [item, setItem] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (ownerId) p.set('ownerId', ownerId);
      if (stage) p.set('stage', stage);
      if (item) p.set('item', item);
      if (includeTest) p.set('includeTest', 'true');
      const d = await api.get<any>(`/data-quality/completeness?${p}`);
      setRows(d.rows); setByOwner(d.byOwner); setItems(d.items);
      setSummary({ checked: d.leadsChecked, withGaps: d.leadsWithGaps });
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [ownerId, stage, item, includeTest]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <p className="text-sm text-stone-500 mb-4">
        Details still blank on active leads, based on the stage each lead has reached. "Owner" is the person assigned to the lead
        for that kind of detail, so they know what to fill in. {summary.checked > 0 && <>{summary.withGaps} of {summary.checked} active leads have gaps.</>}
      </p>
      <div className="flex flex-wrap gap-3 mb-4">
        <select className={selectCls} style={selectStyle} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
          <option value="">Everyone</option>
          {byOwner.map((o) => <option key={o.id ?? 'unassigned'} value={o.id ?? 'unassigned'}>{o.name} ({o.count})</option>)}
        </select>
        <select className={selectCls} style={selectStyle} value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">All current stages</option>
          {STAGES.map((s) => <option key={s.value} value={s.value}>{stageLabel(s.value)}</option>)}
        </select>
        <select className={selectCls} style={selectStyle} value={item} onChange={(e) => setItem(e.target.value)}>
          <option value="">All missing items</option>
          {items.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
        </select>
      </div>
      {error && <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm mb-4">{error}</div>}
      {loading ? <p className="text-sm text-stone-400">Loading…</p> : rows.length === 0 ? (
        <EmptyState title="No gaps found" description="Every active lead has the details expected for its stage." />
      ) : (
        <div className="bg-white rounded-2xl overflow-x-auto" style={{ border: '1px solid #EDE8E3' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-stone-400 uppercase tracking-wide">
                <th className="px-4 py-3">Lead</th><th className="px-4 py-3">Stage</th><th className="px-4 py-3">Missing</th>
                <th className="px-4 py-3">Owner</th><th className="px-4 py-3 text-right">Days outstanding</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid #F3EEE9' }}>
                  <td className="px-4 py-2.5"><Link to={`/leads/${r.lead.id}`} className="text-brand-600 hover:underline">{r.lead.leadId} · {r.lead.name}</Link></td>
                  <td className="px-4 py-2.5 text-stone-600">{stageLabel(r.stage)}</td>
                  <td className="px-4 py-2.5 text-stone-800">{r.item}</td>
                  <td className="px-4 py-2.5 text-stone-600">{r.owner ? r.owner.name : <span className="text-amber-600">Unassigned</span>}</td>
                  <td className="px-4 py-2.5 text-right text-stone-600">{r.daysOutstanding}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function DataQuality() {
  const [tab, setTab] = useState<'gaps' | 'bypasses'>('gaps');
  const [includeTest, setIncludeTest] = useState(false);
  const canSeeTest = ['ADMIN', 'BRANCH_HEAD'].includes(getStoredUser()?.role ?? '');
  return (
    <div className="min-h-screen">
      <div className="bg-white px-6 py-4" style={{ borderBottom: '1px solid #EDE8E3' }}>
        <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">Data Quality</h1>
        <p className="text-sm text-stone-400 mt-0.5">What is missing, who owns it, and what was skipped</p>
      </div>
      <div className="p-6">
        <div className="flex gap-2 mb-5">
          {([['gaps', 'Missing details'], ['bypasses', 'Skipped items log']] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${tab === k ? 'bg-brand-500 text-white' : 'bg-white text-stone-600 hover:bg-stone-50'}`}
              style={tab === k ? undefined : { border: '1px solid #EDE8E3' }}
            >
              {label}
            </button>
          ))}
          {canSeeTest && (
            <label className="ml-auto flex items-center gap-2 text-sm text-stone-600">
              <input type="checkbox" data-testid="include-test-leads" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} />
              Include test leads
            </label>
          )}
        </div>
        {tab === 'gaps' ? <Completeness includeTest={includeTest} /> : <BypassLog includeTest={includeTest} />}
      </div>
    </div>
  );
}
