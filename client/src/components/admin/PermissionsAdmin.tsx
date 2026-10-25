import { Fragment, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { loadMyPermissions } from '../../lib/permissions';

// Admin → Permissions: which roles may do each action (server: lib/permissions.ts).
// A role can only be ticked for actions built for it; the Branch Head keeps its own.

type Role = 'DESIGNER' | 'DESIGN_MANAGER' | 'CRE' | 'BL' | 'BRANCH_HEAD';
interface PermissionDef { key: string; label: string; area: string; roles: Role[] }
type Value = Record<string, Role[]>;
interface LoadResp { value: Value; isDefault: boolean; revision: number; updatedAt: string | null; updatedByName: string | null; catalog: { permissions: PermissionDef[] } }
interface HistoryEntry { id: string; reset: boolean; createdAt: string; byName: string; revision: number | null; note: string | null; value: Value | null }

const ROLES: { role: Role; label: string }[] = [
  { role: 'DESIGNER', label: 'Designer' },
  { role: 'CRE', label: 'CRE' },
  { role: 'BL', label: 'Business Lead' },
  { role: 'BRANCH_HEAD', label: 'Branch Head' },
];

export default function PermissionsAdmin() {
  const [data, setData] = useState<LoadResp | null>(null);
  const [draft, setDraft] = useState<Value | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = async () => {
    const d = await api.get<LoadResp>('/admin/permissions');
    setData(d);
    setDraft(structuredClone(d.value));
    setProblems([]);
  };
  useEffect(() => { load().catch((e) => toast.error(e?.message ?? 'Could not load permissions')); }, []);
  const dirty = useMemo(() => !!data && !!draft && JSON.stringify(data.value) !== JSON.stringify(draft), [data, draft]);

  if (!data || !draft) return <p className="text-sm text-gray-400">Loading permissions…</p>;
  const areas = Array.from(new Set(data.catalog.permissions.map((p) => p.area)));

  const toggle = (key: string, role: Role, on: boolean) => {
    const roles = draft[key] ?? [];
    setDraft({ ...draft, [key]: on ? [...roles, role] : roles.filter((r) => r !== role) });
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/admin/permissions', { value: draft, revision: data.revision, note: note.trim() || undefined });
      toast.success('Permissions saved — they apply straight away');
      setNote('');
      setHistory(null);
      await load();
      await loadMyPermissions(true);
    } catch (e: any) {
      setProblems(Array.isArray(e?.data?.problems) ? e.data.problems : []);
      toast.error(e?.message ?? 'Could not save permissions');
    } finally { setBusy(false); }
  };

  const restoreOriginal = async () => {
    if (!window.confirm('Give every role back the permissions the CRM shipped with? Your current settings stay in the change history.')) return;
    setBusy(true);
    try {
      await api.delete('/admin/permissions');
      toast.success('Original permissions restored');
      setHistory(null);
      await load();
      await loadMyPermissions(true);
    } catch (e: any) { toast.error(e?.message ?? 'Could not restore'); } finally { setBusy(false); }
  };

  const openHistory = async () => {
    setShowHistory((v) => !v);
    if (!history) {
      try { setHistory((await api.get<{ history: HistoryEntry[] }>('/admin/permissions/history')).history); }
      catch (e: any) { toast.error(e?.message ?? 'Could not load history'); }
    }
  };

  return (
    <div className="space-y-5" data-testid="permissions-admin">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="font-semibold text-gray-900">Permissions</h2>
        <p className="mt-1 text-xs text-gray-500">
          Which roles may do each action. A box only appears where the action was built for that role.
          The Branch Head always keeps its own permissions so the admin screens stay reachable. Changes apply straight away.
        </p>
        <p className="mt-2 text-xs text-gray-600">
          {data.isDefault
            ? 'Using the original permissions (nothing saved yet).'
            : `Version ${data.revision}, saved${data.updatedByName ? ` by ${data.updatedByName}` : ''}${data.updatedAt ? ` on ${new Date(data.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}.`}
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
              <th className="px-4 py-2.5 font-semibold">Action</th>
              {ROLES.map((r) => <th key={r.role} className="px-3 py-2.5 font-semibold text-center whitespace-nowrap">{r.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {areas.map((area) => (
              <Fragment key={area}>
                <tr className="bg-gray-50"><td colSpan={ROLES.length + 1} className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{area}</td></tr>
                {data.catalog.permissions.filter((p) => p.area === area).map((p) => (
                  <tr key={p.key} className="border-t border-gray-50" data-testid={`perm-${p.key}`}>
                    <td className="px-4 py-2.5 text-gray-800">{p.label}</td>
                    {ROLES.map(({ role, label }) => (
                      <td key={role} className="px-3 py-2.5 text-center">
                        {p.roles.includes(role) ? (
                          <input type="checkbox" aria-label={`${label}: ${p.label}`}
                            checked={role === 'BRANCH_HEAD' || (draft[p.key] ?? []).includes(role)}
                            disabled={role === 'BRANCH_HEAD'}
                            onChange={(e) => toggle(p.key, role, e.target.checked)} />
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
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
            {busy ? 'Saving…' : 'Save permissions'}
          </button>
          <button onClick={() => { setDraft(structuredClone(data.value)); setProblems([]); }} disabled={!dirty || busy} className="text-xs text-gray-500 hover:underline disabled:opacity-40">Discard changes</button>
          <span className="flex-1" />
          <button onClick={openHistory} className="text-xs text-gray-500 hover:underline">{showHistory ? 'Hide' : 'Show'} change history</button>
          <button onClick={restoreOriginal} disabled={data.isDefault || busy} className="text-xs text-red-500 hover:underline disabled:opacity-40">Restore original permissions</button>
        </div>
        {showHistory && (
          <div className="border-t border-gray-100 pt-3" data-testid="history">
            {!history ? <p className="text-xs text-gray-400">Loading…</p> : history.length === 0 ? <p className="text-xs text-gray-400">No changes yet.</p> : (
              <ul className="space-y-1.5">
                {history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                    <span className="font-medium text-gray-800">{h.reset ? 'Restored original permissions' : `Version ${h.revision}`}</span>
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
