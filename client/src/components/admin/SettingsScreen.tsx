import { useEffect, useMemo, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';

// Shared frame for an Admin settings screen backed by a versioned server
// setting (server: lib/versionedConfig.ts → mountVersionedConfig): loads it,
// shows the version line, and gives Save / Discard / change history /
// restore original. The screen itself only draws the editor.

export interface SettingsLoad<T, C> {
  value: T; isDefault: boolean; revision: number; updatedAt: string | null; updatedByName: string | null; catalog?: C;
}
interface HistoryEntry<T> { id: string; reset: boolean; createdAt: string; byName: string; revision: number | null; note: string | null; value: T | null }

export default function SettingsScreen<T, C = unknown>({ path, title, intro, testId, onSaved, children }: {
  /** API path under /admin, e.g. "/lead-routing". */
  path: string;
  title: string;
  intro: ReactNode;
  testId: string;
  /** Called after a save or restore, e.g. to refresh a client-side cache. */
  onSaved?: () => void;
  children: (draft: T, setDraft: (v: T) => void, data: SettingsLoad<T, C>) => ReactNode;
}) {
  const [data, setData] = useState<SettingsLoad<T, C> | null>(null);
  const [draft, setDraft] = useState<T | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryEntry<T>[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = async () => {
    const d = await api.get<SettingsLoad<T, C>>(`/admin${path}`);
    setData(d);
    setDraft(structuredClone(d.value));
    setProblems([]);
  };
  useEffect(() => { load().catch((e) => toast.error(e?.message ?? 'Could not load the settings')); }, [path]);
  const dirty = useMemo(() => !!data && !!draft && JSON.stringify(data.value) !== JSON.stringify(draft), [data, draft]);

  if (!data || !draft) return <p className="text-sm text-gray-400">Loading…</p>;

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/admin${path}`, { value: draft, revision: data.revision, note: note.trim() || undefined });
      toast.success('Saved — applies straight away');
      setNote('');
      setHistory(null);
      await load();
      onSaved?.();
    } catch (e: any) {
      setProblems(Array.isArray(e?.data?.problems) ? e.data.problems : []);
      toast.error(e?.message ?? 'Could not save');
    } finally { setBusy(false); }
  };

  const restoreOriginal = async () => {
    if (!window.confirm('Go back to the original settings? Your current settings stay in the change history.')) return;
    setBusy(true);
    try {
      await api.delete(`/admin${path}`);
      toast.success('Original settings restored');
      setHistory(null);
      await load();
      onSaved?.();
    } catch (e: any) { toast.error(e?.message ?? 'Could not restore'); } finally { setBusy(false); }
  };

  const openHistory = async () => {
    setShowHistory((v) => !v);
    if (!history) {
      try { setHistory((await api.get<{ history: HistoryEntry<T>[] }>(`/admin${path}/history`)).history); }
      catch (e: any) { toast.error(e?.message ?? 'Could not load history'); }
    }
  };

  return (
    <div className="space-y-5" data-testid={testId}>
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="font-semibold text-gray-900">{title}</h2>
        <div className="mt-1 text-xs text-gray-500">{intro}</div>
        <p className="mt-2 text-xs text-gray-600">
          {data.isDefault
            ? 'Using the original settings (nothing saved yet).'
            : `Version ${data.revision}, saved${data.updatedByName ? ` by ${data.updatedByName}` : ''}${data.updatedAt ? ` on ${new Date(data.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}.`}
        </p>
      </div>

      {children(draft, (v) => setDraft(v), data)}

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

/** A labelled group of radio choices, used by settings screens. */
export function Choice<V extends string>({ name, label, help, value, options, onChange }: {
  name: string; label: string; help?: string; value: V;
  options: { value: V; label: string; help?: string }[];
  onChange: (v: V) => void;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-gray-800">{label}</legend>
      {help && <p className="text-xs text-gray-500">{help}</p>}
      {options.map((o) => (
        <label key={o.value} className="flex items-start gap-2 text-sm text-gray-700">
          <input type="radio" name={name} aria-label={`${label}: ${o.label}`} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-1" />
          <span>{o.label}{o.help && <span className="block text-xs text-gray-400">{o.help}</span>}</span>
        </label>
      ))}
    </fieldset>
  );
}
