import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';

// Admin → Checklists: which built-in items on the PD→OB, OB→OBM and OBM→DIP
// checklists are required, plus the admin's own items (server: lib/checklists.ts).

type Kind = 'pdOb' | 'obObm' | 'dip';
type ItemKind = 'tick' | 'date' | 'text' | 'document';
interface CustomItem { key: string; label: string; kind: ItemKind; docType?: string; required: boolean; active: boolean }
interface Settings { optional: string[]; custom: CustomItem[]; labels?: Record<string, string> }
type Value = Record<Kind, Settings>;
interface BuiltInItem { key: string; label: string; lockedReason?: string }
interface DocType { key: string; label: string }
interface LoadResp {
  value: Value; isDefault: boolean; revision: number; updatedAt: string | null; updatedByName: string | null;
  catalog: { names: Record<Kind, string>; builtIn: Record<Kind, BuiltInItem[]>; documentTypes: DocType[] };
}
interface HistoryEntry { id: string; reset: boolean; createdAt: string; byName: string; revision: number | null; note: string | null; value: Value | null }

const KINDS: Kind[] = ['pdOb', 'obObm', 'dip'];
const ITEM_KINDS: { kind: ItemKind; label: string }[] = [
  { kind: 'tick', label: 'Tick box' },
  { kind: 'date', label: 'Date' },
  { kind: 'text', label: 'Text' },
  { kind: 'document', label: 'Uploaded document' },
];

function keyFor(label: string, taken: Set<string>): string {
  const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'item').slice(0, 34).padEnd(2, '_');
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

export default function ChecklistsAdmin() {
  const [data, setData] = useState<LoadResp | null>(null);
  const [draft, setDraft] = useState<Value | null>(null);
  const [kind, setKind] = useState<Kind>('pdOb');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newKind, setNewKind] = useState<ItemKind>('tick');

  const load = async () => {
    const d = await api.get<LoadResp>('/admin/checklists');
    setData(d);
    setDraft(structuredClone(d.value));
    setProblems([]);
  };
  useEffect(() => { load().catch((e) => toast.error(e?.message ?? 'Could not load checklists')); }, []);
  const dirty = useMemo(() => !!data && !!draft && JSON.stringify(data.value) !== JSON.stringify(draft), [data, draft]);

  if (!data || !draft) return <p className="text-sm text-gray-400">Loading checklists…</p>;
  const s = draft[kind];
  const builtIn = data.catalog.builtIn[kind];
  const docTypes = data.catalog.documentTypes;

  const update = (next: Settings) => setDraft({ ...draft, [kind]: next });
  const setRequired = (key: string, required: boolean) =>
    update({ ...s, optional: required ? s.optional.filter((k) => k !== key) : [...s.optional, key] });
  const editCustom = (i: number, patch: Partial<CustomItem>) =>
    update({ ...s, custom: s.custom.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const removeCustom = (i: number) => update({ ...s, custom: s.custom.filter((_, j) => j !== i) });
  const moveCustom = (i: number, d: -1 | 1) => {
    const list = [...s.custom];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    update({ ...s, custom: list });
  };
  const addCustom = () => {
    const label = newLabel.trim();
    if (!label) return;
    const taken = new Set([...builtIn.map((b) => b.key), ...s.custom.map((c) => c.key)]);
    const item: CustomItem = { key: keyFor(label, taken), label, kind: newKind, required: true, active: true };
    if (newKind === 'document') item.docType = docTypes[0]?.key;
    update({ ...s, custom: [...s.custom, item] });
    setNewLabel('');
  };

  const save = async () => {
    // A typed-but-not-added item would otherwise be silently left out.
    if (newLabel.trim()) { toast.error(`You typed "${newLabel.trim()}" but didn't click "Add item". Click Add item, or clear the box, then save.`); return; }
    setBusy(true);
    try {
      await api.put('/admin/checklists', { value: draft, revision: data.revision, note: note.trim() || undefined });
      toast.success('Checklists saved — they apply straight away');
      setNote('');
      setHistory(null);
      await load();
    } catch (e: any) {
      setProblems(Array.isArray(e?.data?.problems) ? e.data.problems : []);
      toast.error(e?.message ?? 'Could not save checklists');
    } finally { setBusy(false); }
  };

  const restoreOriginal = async () => {
    if (!window.confirm('Put all three checklists back the way the CRM shipped them? Your own items are removed from the checklists (values already filled in are kept). Your current settings stay in the change history.')) return;
    setBusy(true);
    try {
      await api.delete('/admin/checklists');
      toast.success('Original checklists restored');
      setHistory(null);
      await load();
    } catch (e: any) { toast.error(e?.message ?? 'Could not restore'); } finally { setBusy(false); }
  };

  const openHistory = async () => {
    setShowHistory((v) => !v);
    if (!history) {
      try { setHistory((await api.get<{ history: HistoryEntry[] }>('/admin/checklists/history')).history); }
      catch (e: any) { toast.error(e?.message ?? 'Could not load history'); }
    }
  };

  return (
    <div className="space-y-5" data-testid="checklists-admin">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="font-semibold text-gray-900">Checklists</h2>
        <p className="mt-1 text-xs text-gray-500">
          Choose which items must be done before each checklist can be sent or completed, and add your own items.
          You can also rename any item; the new name shows on the checklist and in "still needed" messages.
          Optional items still show on the checklist, marked "(optional)". A few items can't be made optional; the reason is shown next to them.
          Changes apply straight away.
        </p>
        <p className="mt-2 text-xs text-gray-600">
          {data.isDefault
            ? 'Using the original checklists (nothing saved yet).'
            : `Version ${data.revision}, saved${data.updatedByName ? ` by ${data.updatedByName}` : ''}${data.updatedAt ? ` on ${new Date(data.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}.`}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button key={k} onClick={() => setKind(k)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${kind === k ? 'bg-brand-500 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            {data.catalog.names[k]}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5" data-testid={`checklist-${kind}`}>
        <h3 className="text-sm font-semibold text-gray-800">Built-in items</h3>
        <ul className="mt-2 divide-y divide-gray-50">
          {builtIn.map((b) => (
            <li key={b.key} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <input type="checkbox" aria-label={`Required: ${b.label}`} checked={!!b.lockedReason || !s.optional.includes(b.key)}
                disabled={!!b.lockedReason} onChange={(e) => setRequired(b.key, e.target.checked)} />
              <input aria-label={`Name for ${b.label}`} value={s.labels?.[b.key] ?? b.label} maxLength={120}
                onChange={(e) => update({ ...s, labels: { ...(s.labels ?? {}), [b.key]: e.target.value } })}
                className="flex-1 min-w-[220px] rounded border border-gray-200 px-2 py-1 text-sm text-gray-800" />
              <span className="text-[11px] text-gray-400">
                {b.lockedReason ? `Always required — ${b.lockedReason}` : s.optional.includes(b.key) ? 'Optional' : 'Required'}
              </span>
            </li>
          ))}
        </ul>

        <h3 className="mt-6 text-sm font-semibold text-gray-800">Your own items</h3>
        {s.custom.length === 0 && <p className="mt-1 text-xs text-gray-400">None yet.</p>}
        <ul className="mt-2 space-y-2">
          {s.custom.map((c, i) => (
            <li key={c.key} className={`flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm ${c.active ? 'border-gray-200' : 'border-dashed border-gray-200 opacity-60'}`}>
              <input aria-label="Item name" value={c.label} maxLength={120} onChange={(e) => editCustom(i, { label: e.target.value })}
                className="flex-1 min-w-[200px] rounded border border-gray-200 px-2 py-1 text-sm" />
              <select aria-label="Type" value={c.kind}
                onChange={(e) => {
                  const k = e.target.value as ItemKind;
                  editCustom(i, { kind: k, docType: k === 'document' ? (c.docType ?? docTypes[0]?.key) : undefined });
                }}
                className="rounded border border-gray-200 px-2 py-1 text-xs">
                {ITEM_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
              </select>
              {c.kind === 'document' && (
                <select aria-label="Document type" value={c.docType ?? ''} onChange={(e) => editCustom(i, { docType: e.target.value })}
                  className="rounded border border-gray-200 px-2 py-1 text-xs">
                  {!docTypes.some((t) => t.key === c.docType) && <option value={c.docType ?? ''}>Choose a document type…</option>}
                  {docTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              )}
              <label className="flex items-center gap-1 text-xs text-gray-600">
                <input type="checkbox" checked={c.required} onChange={(e) => editCustom(i, { required: e.target.checked })} /> Required
              </label>
              <label className="flex items-center gap-1 text-xs text-gray-600">
                <input type="checkbox" checked={c.active} onChange={(e) => editCustom(i, { active: e.target.checked })} /> In use
              </label>
              <button onClick={() => moveCustom(i, -1)} disabled={i === 0} aria-label="Move up" className="text-xs text-gray-400 hover:text-gray-700 disabled:opacity-30">↑</button>
              <button onClick={() => moveCustom(i, 1)} disabled={i === s.custom.length - 1} aria-label="Move down" className="text-xs text-gray-400 hover:text-gray-700 disabled:opacity-30">↓</button>
              <button onClick={() => removeCustom(i)} className="text-xs text-red-500 hover:underline">Remove</button>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCustom(); }}
            maxLength={120} placeholder="New item, e.g. Site measurement confirmed"
            className="flex-1 min-w-[220px] rounded-lg border border-gray-200 px-3 py-1.5 text-sm" />
          <select aria-label="New item type" value={newKind} onChange={(e) => setNewKind(e.target.value as ItemKind)} className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm">
            {ITEM_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </select>
          <button onClick={addCustom} disabled={!newLabel.trim()} className="rounded-lg border border-brand-500 px-3 py-1.5 text-sm text-brand-600 hover:bg-brand-50 disabled:opacity-40">Add item</button>
        </div>
        <p className="mt-2 text-[11px] text-gray-400">
          "Uploaded document" items are done when a file of that type is on the lead's Files tab. Untick "In use" to hide an item without losing what was filled in.
        </p>
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
          <button onClick={save} disabled={(!dirty && !newLabel.trim()) || busy} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save checklists'}
          </button>
          <button onClick={() => { setDraft(structuredClone(data.value)); setProblems([]); }} disabled={!dirty || busy} className="text-xs text-gray-500 hover:underline disabled:opacity-40">Discard changes</button>
          <span className="flex-1" />
          <button onClick={openHistory} className="text-xs text-gray-500 hover:underline">{showHistory ? 'Hide' : 'Show'} change history</button>
          <button onClick={restoreOriginal} disabled={data.isDefault || busy} className="text-xs text-red-500 hover:underline disabled:opacity-40">Restore original checklists</button>
        </div>
        {showHistory && (
          <div className="border-t border-gray-100 pt-3" data-testid="history">
            {!history ? <p className="text-xs text-gray-400">Loading…</p> : history.length === 0 ? <p className="text-xs text-gray-400">No changes yet.</p> : (
              <ul className="space-y-1.5">
                {history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                    <span className="font-medium text-gray-800">{h.reset ? 'Restored original checklists' : `Version ${h.revision}`}</span>
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
