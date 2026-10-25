import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Lock } from 'lucide-react';
import { api } from '../../lib/api';

// Admin → Automations: which automatic messages are sent, on which channels,
// and who is copied on client emails (server: lib/automations.ts).

type Channel = 'email' | 'sms' | 'whatsapp';
interface EventDef { code: string; label: string; when: string; audience: 'client' | 'team'; channels: Channel[]; reviewed?: boolean; lockedReason?: string }
interface Setting { enabled: boolean; channels: Partial<Record<Channel, boolean>>; cc: string[] }
type Value = Record<string, Setting>;
interface LoadResp {
  value: Value; defaults: Value; isDefault: boolean; revision: number; updatedAt: string | null; updatedByName: string | null;
  catalog: { events: EventDef[]; ccRoles: { role: string; label: string }[] };
}
interface HistoryEntry { id: string; reset: boolean; createdAt: string; byName: string; revision: number | null; note: string | null; value: Value | null }

const CHANNEL_LABELS: Record<Channel, string> = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };

function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-brand-500' : 'bg-gray-200'}`}>
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${on ? 'translate-x-5' : 'translate-x-1'}`} />
    </button>
  );
}

export default function AutomationsAdmin() {
  const [data, setData] = useState<LoadResp | null>(null);
  const [draft, setDraft] = useState<Value | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = async () => {
    const d = await api.get<LoadResp>('/admin/automations');
    setData(d);
    setDraft(structuredClone(d.value));
    setProblems([]);
  };
  useEffect(() => { load().catch((e) => toast.error(e?.message ?? 'Could not load automations')); }, []);
  const dirty = useMemo(() => !!data && !!draft && JSON.stringify(data.value) !== JSON.stringify(draft), [data, draft]);

  if (!data || !draft) return <p className="text-sm text-gray-400">Loading automations…</p>;
  const update = (code: string, patch: Partial<Setting>) => setDraft({ ...draft, [code]: { ...draft[code], ...patch } });

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/admin/automations', { value: draft, revision: data.revision, note: note.trim() || undefined });
      toast.success('Automations saved — they apply from the next message');
      setNote('');
      setHistory(null);
      await load();
    } catch (e: any) {
      setProblems(Array.isArray(e?.data?.problems) ? e.data.problems : []);
      toast.error(e?.message ?? 'Could not save automations');
    } finally { setBusy(false); }
  };

  const restoreOriginal = async () => {
    if (!window.confirm('Switch every automation back to how the CRM shipped? Your current settings stay in the change history.')) return;
    setBusy(true);
    try {
      await api.delete('/admin/automations');
      toast.success('Original automations restored');
      setHistory(null);
      await load();
    } catch (e: any) { toast.error(e?.message ?? 'Could not restore'); } finally { setBusy(false); }
  };

  const openHistory = async () => {
    setShowHistory((v) => !v);
    if (!history) {
      try { setHistory((await api.get<{ history: HistoryEntry[] }>('/admin/automations/history')).history); }
      catch (e: any) { toast.error(e?.message ?? 'Could not load history'); }
    }
  };

  const section = (audience: 'client' | 'team', title: string, hint: string) => (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3" data-testid={`automations-${audience}`}>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">{title}</h3>
        <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>
      </div>
      <div className="divide-y divide-gray-50">
        {data.catalog.events.filter((e) => e.audience === audience).map((e) => {
          const s = draft[e.code];
          const locked = !!e.lockedReason;
          return (
            <div key={e.code} className={`py-3 flex flex-wrap items-start gap-x-6 gap-y-2 ${s.enabled ? '' : 'opacity-60'}`} data-testid={`automation-${e.code}`}>
              <div className="flex items-start gap-3 min-w-[260px] flex-1">
                <Toggle on={s.enabled} disabled={locked} label={`${e.label} on or off`} onChange={(v) => update(e.code, { enabled: v })} />
                <div>
                  <p className="text-sm font-medium text-gray-800">
                    {e.label}
                    {e.reviewed && <span className="ml-2 text-[10px] font-normal text-gray-400">reviewed before sending</span>}
                  </p>
                  <p className="text-[11px] text-gray-500">{e.when}</p>
                  {locked && <p className="text-[11px] text-gray-400 flex items-center gap-1 mt-0.5"><Lock size={10} /> Always on — {e.lockedReason}</p>}
                </div>
              </div>
              {e.channels.length > 1 && (
                <div className="flex items-center gap-3">
                  {e.channels.map((c) => (
                    <label key={c} className="flex items-center gap-1.5 text-xs text-gray-600">
                      <input type="checkbox" checked={s.channels[c] !== false} disabled={!s.enabled || locked}
                        onChange={(ev) => update(e.code, { channels: { ...s.channels, [c]: ev.target.checked } })} />
                      {CHANNEL_LABELS[c]}
                    </label>
                  ))}
                </div>
              )}
              {audience === 'client' && e.channels.includes('email') && (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[11px] text-gray-500">Copy:</span>
                  {data.catalog.ccRoles.map((r) => (
                    <label key={r.role} className="flex items-center gap-1.5 text-xs text-gray-600">
                      <input type="checkbox" checked={s.cc.includes(r.role)} disabled={!s.enabled}
                        onChange={(ev) => update(e.code, { cc: ev.target.checked ? [...s.cc, r.role] : s.cc.filter((x) => x !== r.role) })} />
                      {r.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="space-y-5" data-testid="automations">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="font-semibold text-gray-900">Automations</h2>
        <p className="mt-1 text-xs text-gray-500">
          Which messages the CRM sends by itself, on which channels, and who is copied on client emails.
          Wording is edited under Settings → Mail templates. In-app notifications always stay on.
        </p>
        <p className="mt-2 text-xs text-gray-600">
          {data.isDefault
            ? 'Using the original automations (nothing saved yet).'
            : `Version ${data.revision}, saved${data.updatedByName ? ` by ${data.updatedByName}` : ''}${data.updatedAt ? ` on ${new Date(data.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}.`}
        </p>
      </div>

      {section('client', 'Messages to clients', 'Switching a message off means it is not sent or prepared at all. "Reviewed before sending" emails are shown to the user first.')}
      {section('team', 'Emails to the team', 'In-app notifications for these events are always sent.')}

      <div className="sticky bottom-0 bg-white rounded-xl border border-gray-200 p-4 space-y-3 shadow-sm">
        {problems.length > 0 && (
          <div className="rounded-lg bg-red-50 border border-red-100 p-3 text-xs text-red-700" role="alert">
            <p className="font-medium mb-1">Please fix these before saving:</p>
            <ul className="list-disc pl-4 space-y-0.5">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
          </div>
        )}
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="What did you change? (optional — shown in the change history)"
          className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-xs" />
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={save} disabled={!dirty || busy} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save automations'}
          </button>
          <button onClick={() => { setDraft(structuredClone(data.value)); setProblems([]); }} disabled={!dirty || busy} className="text-xs text-gray-500 hover:underline disabled:opacity-40">Discard changes</button>
          <span className="flex-1" />
          <button onClick={openHistory} className="text-xs text-gray-500 hover:underline">{showHistory ? 'Hide' : 'Show'} change history</button>
          <button onClick={restoreOriginal} disabled={data.isDefault || busy} className="text-xs text-red-500 hover:underline disabled:opacity-40">Restore original automations</button>
        </div>
        {showHistory && (
          <div className="border-t border-gray-100 pt-3" data-testid="history">
            {!history ? <p className="text-xs text-gray-400">Loading…</p> : history.length === 0 ? <p className="text-xs text-gray-400">No changes yet.</p> : (
              <ul className="space-y-1.5">
                {history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                    <span className="font-medium text-gray-800">{h.reset ? 'Restored original automations' : `Version ${h.revision}`}</span>
                    <span>{h.byName} · {new Date(h.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>
                    {h.note && <span className="text-gray-500">— {h.note}</span>}
                    {h.value && (
                      <button onClick={() => { setDraft(structuredClone(h.value!)); toast('Loaded into the editor — review it, then save to apply'); }}
                        className="text-brand-600 hover:underline">Load into editor</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
