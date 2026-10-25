import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';

// Admin → Document Types: the upload types on the Files tab. Built-in types can
// be renamed and made PDF-only; new types can be added and switched off (never
// deleted — uploaded files keep pointing at them).

interface Overrides {
  builtIn: Record<string, { label?: string; pdfOnly?: boolean }>;
  custom: { key: string; label: string; pdfOnly: boolean; active: boolean }[];
}
interface DocType { key: string; label: string; pdfOnly: boolean; builtIn: boolean; active: boolean }
interface Resp { overrides: Overrides; revision: number; updatedAt: string | null; types: DocType[] }

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

export default function DocumentTypesAdmin() {
  const [data, setData] = useState<Resp | null>(null);
  const [draft, setDraft] = useState<Overrides | null>(null);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const load = async () => {
    const d = await api.get<Resp>('/admin/document-types');
    setData(d);
    setDraft(structuredClone(d.overrides));
    setProblems([]);
  };
  useEffect(() => { load().catch((e) => toast.error(e?.message ?? 'Could not load document types')); }, []);
  const dirty = useMemo(() => !!data && !!draft && JSON.stringify(data.overrides) !== JSON.stringify(draft), [data, draft]);

  if (!data || !draft) return <p className="text-sm text-gray-400">Loading document types…</p>;
  const builtIns = data.types.filter((t) => t.builtIn);

  const setBuiltIn = (key: string, patch: { label?: string; pdfOnly?: boolean }) =>
    setDraft({ ...draft, builtIn: { ...draft.builtIn, [key]: { ...draft.builtIn[key], ...patch } } });
  const setCustom = (i: number, patch: Partial<Overrides['custom'][number]>) =>
    setDraft({ ...draft, custom: draft.custom.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  const add = () => {
    const label = newName.trim();
    const key = slug(label);
    if (key.length < 2) { toast.error('Use at least 2 letters or numbers in the name'); return; }
    if (draft.custom.some((c) => c.key === key)) { toast.error('A document type with this name already exists'); return; }
    setDraft({ ...draft, custom: [...draft.custom, { key, label, pdfOnly: false, active: true }] });
    setNewName('');
  };

  const save = async () => {
    setSaving(true);
    try {
      // An emptied name falls back to the standard one rather than failing.
      const builtIn: Overrides['builtIn'] = {};
      for (const [key, o] of Object.entries(draft.builtIn)) {
        const entry: { label?: string; pdfOnly?: boolean } = {};
        if (o.label?.trim()) entry.label = o.label.trim();
        if (o.pdfOnly !== undefined) entry.pdfOnly = o.pdfOnly;
        if (entry.label !== undefined || entry.pdfOnly !== undefined) builtIn[key] = entry;
      }
      await api.put('/admin/document-types', { overrides: { builtIn, custom: draft.custom }, revision: data.revision });
      toast.success('Document types saved');
      await load();
    } catch (e: any) {
      setProblems(Array.isArray(e?.data?.problems) ? e.data.problems : []);
      toast.error(e?.message ?? 'Could not save document types');
    } finally { setSaving(false); }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-5" data-testid="document-types">
      <div>
        <h2 className="font-semibold text-gray-900">Document Types</h2>
        <p className="mt-1 text-xs text-gray-500">
          The types designers pick when uploading on a lead's Files tab. New types can be required in Stage Rules.
        </p>
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Standard types</h3>
        {builtIns.map((t) => {
          const o = draft.builtIn[t.key] ?? {};
          return (
            <div key={t.key} className="flex flex-wrap items-center gap-3">
              <input value={o.label ?? t.label} maxLength={80} onChange={(e) => setBuiltIn(t.key, { label: e.target.value })}
                aria-label={`Name for ${t.label}`} className="w-72 rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm" />
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                <input type="checkbox" checked={o.pdfOnly ?? t.pdfOnly} onChange={(e) => setBuiltIn(t.key, { pdfOnly: e.target.checked })} />
                PDF only
              </label>
            </div>
          );
        })}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Your own types</h3>
        {draft.custom.length === 0 && <p className="text-xs text-gray-400">None yet.</p>}
        {draft.custom.map((c, i) => (
          <div key={c.key} className="flex flex-wrap items-center gap-3">
            <input value={c.label} maxLength={80} onChange={(e) => setCustom(i, { label: e.target.value })}
              aria-label={`Name for ${c.label}`} className={`w-72 rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm ${c.active ? '' : 'text-gray-400'}`} />
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input type="checkbox" checked={c.pdfOnly} onChange={(e) => setCustom(i, { pdfOnly: e.target.checked })} /> PDF only
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input type="checkbox" checked={c.active} onChange={(e) => setCustom(i, { active: e.target.checked })} /> In use
            </label>
          </div>
        ))}
        <div className="flex items-center gap-2 pt-1">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="e.g. Site photos" maxLength={80} className="w-72 rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm" />
          <button onClick={add} className="text-xs font-medium text-brand-600 hover:underline">+ Add type</button>
        </div>
      </section>

      {problems.length > 0 && (
        <div className="rounded-lg bg-red-50 border border-red-100 p-3 text-xs text-red-700" role="alert">
          <ul className="list-disc pl-4 space-y-0.5">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={!dirty || saving} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40">
          {saving ? 'Saving…' : 'Save document types'}
        </button>
        <button onClick={() => setDraft(structuredClone(data.overrides))} disabled={!dirty || saving} className="text-xs text-gray-500 hover:underline disabled:opacity-40">Discard changes</button>
      </div>
    </div>
  );
}
