import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { stageLabel } from '../../lib/crmSettings';

// Admin → Reports & NPS: which stages count as onboarded in Reports, and which
// stage starts each NPS survey (server: lib/reportDefinitions.ts).

type Survey = 'SALE' | 'DESIGN_FREEZE' | 'SIGN_OFF';
interface Value { wonStages: string[]; npsTriggers: Record<Survey, string | null> }
interface LoadResp {
  value: Value; isDefault: boolean; revision: number; updatedAt: string | null; updatedByName: string | null;
  catalog: { wonStageChoices: string[]; surveys: { key: Survey; label: string }[]; triggerStages: string[] };
}
interface HistoryEntry { id: string; reset: boolean; createdAt: string; byName: string; revision: number | null; note: string | null; value: Value | null }

export default function ReportsNpsAdmin() {
  const [data, setData] = useState<LoadResp | null>(null);
  const [draft, setDraft] = useState<Value | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = async () => {
    const d = await api.get<LoadResp>('/admin/report-definitions');
    setData(d);
    setDraft(structuredClone(d.value));
    setProblems([]);
  };
  useEffect(() => { load().catch((e) => toast.error(e?.message ?? 'Could not load the settings')); }, []);
  const dirty = useMemo(() => !!data && !!draft && JSON.stringify(data.value) !== JSON.stringify(draft), [data, draft]);

  if (!data || !draft) return <p className="text-sm text-gray-400">Loading report and NPS settings…</p>;

  const toggleWon = (stage: string, on: boolean) =>
    setDraft({ ...draft, wonStages: on ? [...draft.wonStages, stage] : draft.wonStages.filter((s) => s !== stage) });

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/admin/report-definitions', { value: draft, revision: data.revision, note: note.trim() || undefined });
      toast.success('Saved — applies straight away');
      setNote('');
      setHistory(null);
      await load();
    } catch (e: any) {
      setProblems(Array.isArray(e?.data?.problems) ? e.data.problems : []);
      toast.error(e?.message ?? 'Could not save');
    } finally { setBusy(false); }
  };

  const restoreOriginal = async () => {
    if (!window.confirm('Go back to the original report and NPS settings? Your current settings stay in the change history.')) return;
    setBusy(true);
    try {
      await api.delete('/admin/report-definitions');
      toast.success('Original settings restored');
      setHistory(null);
      await load();
    } catch (e: any) { toast.error(e?.message ?? 'Could not restore'); } finally { setBusy(false); }
  };

  const openHistory = async () => {
    setShowHistory((v) => !v);
    if (!history) {
      try { setHistory((await api.get<{ history: HistoryEntry[] }>('/admin/report-definitions/history')).history); }
      catch (e: any) { toast.error(e?.message ?? 'Could not load history'); }
    }
  };

  return (
    <div className="space-y-5" data-testid="reports-nps-admin">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="font-semibold text-gray-900">Reports &amp; NPS</h2>
        <p className="mt-1 text-xs text-gray-500">
          What the Reports page counts as onboarded, and when NPS surveys start. To hide, reorder or rename Reports page
          sections, use Admin → Dashboards → Reports page. Changes apply straight away.
        </p>
        <p className="mt-2 text-xs text-gray-600">
          {data.isDefault
            ? 'Using the original settings (nothing saved yet).'
            : `Version ${data.revision}, saved${data.updatedByName ? ` by ${data.updatedByName}` : ''}${data.updatedAt ? ` on ${new Date(data.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}.`}
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5" data-testid="won-stages">
        <h3 className="text-sm font-semibold text-gray-800">Counts as "onboarded" in Reports</h3>
        <p className="mt-1 text-xs text-gray-500">
          A lead at any ticked stage counts as onboarded in the source, campaign, offer, sales-cycle and monthly-trend reports.
          Booking value, targets and credits don't change — they always follow the completed OBM → DIP checklist.
        </p>
        <div className="mt-3 flex flex-wrap gap-4">
          {data.catalog.wonStageChoices.map((stage) => (
            <label key={stage} className="flex items-center gap-2 text-sm text-gray-800">
              <input type="checkbox" checked={draft.wonStages.includes(stage)} onChange={(e) => toggleWon(stage, e.target.checked)} />
              {stageLabel(stage)}
            </label>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5" data-testid="nps-triggers">
        <h3 className="text-sm font-semibold text-gray-800">When NPS surveys start</h3>
        <p className="mt-1 text-xs text-gray-500">
          Pick the stage at which each survey email is prepared. As with other client mails, it opens for review before
          it is sent, and a lead gets each survey only once. The Onboarding survey always stays on the Onboarding → OBM checklist.
        </p>
        <div className="mt-3 space-y-2">
          {data.catalog.surveys.map((s) => (
            <div key={s.key} className="flex flex-wrap items-center gap-3 text-sm">
              <span className="w-44 text-gray-800">{s.label}</span>
              <select aria-label={`${s.label} starts at`} value={draft.npsTriggers[s.key] ?? ''}
                onChange={(e) => setDraft({ ...draft, npsTriggers: { ...draft.npsTriggers, [s.key]: e.target.value || null } })}
                className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm">
                <option value="">Not sent automatically</option>
                {data.catalog.triggerStages.map((st) => <option key={st} value={st}>When the lead reaches {stageLabel(st)}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>

      <div className="sticky bottom-0 bg-white rounded-xl border border-gray-200 p-4 space-y-3 shadow-sm">
        {problems.length > 0 && (
          <div className="rounded-lg bg-red-50 border border-red-100 p-3 text-xs text-red-700" role="alert">
            <ul className="list-disc pl-4 space-y-0.5">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
          </div>
        )}
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="What did you change? (optional — shown in the change history)"
          className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-xs" />
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={save} disabled={!dirty || busy} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save settings'}
          </button>
          <button onClick={() => { setDraft(structuredClone(data.value)); setProblems([]); }} disabled={!dirty || busy} className="text-xs text-gray-500 hover:underline disabled:opacity-40">Discard changes</button>
          <span className="flex-1" />
          <button onClick={openHistory} className="text-xs text-gray-500 hover:underline">{showHistory ? 'Hide' : 'Show'} change history</button>
          <button onClick={restoreOriginal} disabled={data.isDefault || busy} className="text-xs text-red-500 hover:underline disabled:opacity-40">Restore original settings</button>
        </div>
        {showHistory && (
          <div className="border-t border-gray-100 pt-3" data-testid="history">
            {!history ? <p className="text-xs text-gray-400">Loading…</p> : history.length === 0 ? <p className="text-xs text-gray-400">No changes yet.</p> : (
              <ul className="space-y-1.5">
                {history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                    <span className="font-medium text-gray-800">{h.reset ? 'Restored original settings' : `Version ${h.revision}`}</span>
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
