import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { api } from '../../lib/api';
import { DASHBOARD_NAMES, DASHBOARD_TILES } from '../../lib/dashboardTiles';
import { loadDashboardLayouts, type DashboardLayout, type DashboardLayouts } from '../../lib/dashboardLayout';

// Admin → Dashboards: per role's dashboard, show/hide tiles, order them within
// their section and rename them (server: lib/dashboardLayouts.ts).

interface LoadResp { value: DashboardLayouts; isDefault: boolean; revision: number; updatedAt: string | null; updatedByName: string | null }
interface HistoryEntry { id: string; reset: boolean; createdAt: string; byName: string; revision: number | null; note: string | null; value: DashboardLayouts | null }

const EMPTY: DashboardLayout = { order: [], hidden: [], labels: {} };

/** The tiles of one section in their current order (ordered ones first, then the rest as on screen). */
function sectionOrder(layout: DashboardLayout, ids: string[]): string[] {
  const ranked = ids.map((id, i) => ({ id, r: layout.order.includes(id) ? layout.order.indexOf(id) : 10_000 + i }));
  return ranked.sort((a, b) => a.r - b.r).map((x) => x.id);
}

export default function DashboardsAdmin() {
  const [data, setData] = useState<LoadResp | null>(null);
  const [draft, setDraft] = useState<DashboardLayouts | null>(null);
  const [board, setBoard] = useState(Object.keys(DASHBOARD_NAMES)[0]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = async () => {
    const d = await api.get<LoadResp>('/admin/dashboards');
    setData(d);
    setDraft(structuredClone(d.value));
    setProblems([]);
  };
  useEffect(() => { load().catch((e) => toast.error(e?.message ?? 'Could not load dashboards')); }, []);
  const dirty = useMemo(() => !!data && !!draft && JSON.stringify(data.value) !== JSON.stringify(draft), [data, draft]);

  if (!data || !draft) return <p className="text-sm text-gray-400">Loading dashboards…</p>;
  const layout = draft[board] ?? EMPTY;
  const setLayout = (next: DashboardLayout) => setDraft({ ...draft, [board]: next });
  const tiles = DASHBOARD_TILES.filter((t) => t.dashboard === board);
  const sections = Array.from(new Set(tiles.map((t) => t.section)));

  const move = (section: string, id: string, by: number) => {
    // Re-express the whole board's order with this section's tiles swapped.
    const full = sections.flatMap((sec) => sectionOrder(layout, tiles.filter((t) => t.section === sec).map((t) => t.id)));
    const inSection = sectionOrder(layout, tiles.filter((t) => t.section === section).map((t) => t.id));
    const i = inSection.indexOf(id);
    const j = i + by;
    if (j < 0 || j >= inSection.length) return;
    const [a, b] = [full.indexOf(inSection[i]), full.indexOf(inSection[j])];
    [full[a], full[b]] = [full[b], full[a]];
    setLayout({ ...layout, order: full });
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/admin/dashboards', { value: draft, revision: data.revision, note: note.trim() || undefined });
      toast.success('Dashboards saved');
      setNote('');
      setHistory(null);
      await load();
      await loadDashboardLayouts(true);
    } catch (e: any) {
      setProblems(Array.isArray(e?.data?.problems) ? e.data.problems : []);
      toast.error(e?.message ?? 'Could not save dashboards');
    } finally { setBusy(false); }
  };

  const restoreOriginal = async () => {
    if (!window.confirm('Put every dashboard back as it shipped? Your current layout stays in the change history.')) return;
    setBusy(true);
    try {
      await api.delete('/admin/dashboards');
      toast.success('Original dashboards restored');
      setHistory(null);
      await load();
      await loadDashboardLayouts(true);
    } catch (e: any) { toast.error(e?.message ?? 'Could not restore'); } finally { setBusy(false); }
  };

  const openHistory = async () => {
    setShowHistory((v) => !v);
    if (!history) {
      try { setHistory((await api.get<{ history: HistoryEntry[] }>('/admin/dashboards/history')).history); }
      catch (e: any) { toast.error(e?.message ?? 'Could not load history'); }
    }
  };

  return (
    <div className="space-y-5" data-testid="dashboards-admin">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="font-semibold text-gray-900">Dashboards</h2>
        <p className="mt-1 text-xs text-gray-500">
          Choose which tiles each role sees on their dashboard, their order within each section, and their names.
          A tile can't move to another role's dashboard — each dashboard loads that role's own figures.
        </p>
        <p className="mt-2 text-xs text-gray-600">
          {data.isDefault
            ? 'Using the original dashboards (nothing saved yet).'
            : `Version ${data.revision}, saved${data.updatedByName ? ` by ${data.updatedByName}` : ''}${data.updatedAt ? ` on ${new Date(data.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}.`}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {Object.entries(DASHBOARD_NAMES).map(([key, name]) => (
          <button key={key} onClick={() => setBoard(key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium border ${board === key ? 'bg-brand-500 text-white border-brand-500' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
            {name}
          </button>
        ))}
      </div>

      {sections.map((section) => {
        const ids = sectionOrder(layout, tiles.filter((t) => t.section === section).map((t) => t.id));
        return (
          <div key={section} className="bg-white rounded-xl border border-gray-200 p-5 space-y-2" data-testid={`section-${section}`}>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">{section}</h3>
            {ids.map((id, i) => {
              const t = tiles.find((x) => x.id === id)!;
              const shown = !layout.hidden.includes(id);
              return (
                <div key={id} className={`flex flex-wrap items-center gap-3 ${shown ? '' : 'opacity-60'}`} data-testid={`tile-${id}`}>
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 w-16">
                    <input type="checkbox" checked={shown} aria-label={`Show ${t.label}`}
                      onChange={(e) => setLayout({ ...layout, hidden: e.target.checked ? layout.hidden.filter((x) => x !== id) : [...layout.hidden, id] })} />
                    Show
                  </label>
                  <input value={layout.labels[id] ?? t.label} maxLength={60} aria-label={`Name for ${t.label}`}
                    onChange={(e) => {
                      const labels = { ...layout.labels };
                      if (e.target.value === t.label) delete labels[id]; else labels[id] = e.target.value;
                      setLayout({ ...layout, labels });
                    }}
                    className="w-72 rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm" />
                  {layout.labels[id] && <span className="text-[11px] text-gray-400">originally "{t.label}"</span>}
                  <span className="flex-1" />
                  <button onClick={() => move(section, id, -1)} disabled={i === 0} className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30" aria-label={`Move ${t.label} up`}><ArrowUp size={13} /></button>
                  <button onClick={() => move(section, id, 1)} disabled={i === ids.length - 1} className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30" aria-label={`Move ${t.label} down`}><ArrowDown size={13} /></button>
                </div>
              );
            })}
          </div>
        );
      })}

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
            {busy ? 'Saving…' : 'Save dashboards'}
          </button>
          <button onClick={() => { setDraft(structuredClone(data.value)); setProblems([]); }} disabled={!dirty || busy} className="text-xs text-gray-500 hover:underline disabled:opacity-40">Discard changes</button>
          <span className="flex-1" />
          <button onClick={openHistory} className="text-xs text-gray-500 hover:underline">{showHistory ? 'Hide' : 'Show'} change history</button>
          <button onClick={restoreOriginal} disabled={data.isDefault || busy} className="text-xs text-red-500 hover:underline disabled:opacity-40">Restore original dashboards</button>
        </div>
        {showHistory && (
          <div className="border-t border-gray-100 pt-3" data-testid="history">
            {!history ? <p className="text-xs text-gray-400">Loading…</p> : history.length === 0 ? <p className="text-xs text-gray-400">No changes yet.</p> : (
              <ul className="space-y-1.5">
                {history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                    <span className="font-medium text-gray-800">{h.reset ? 'Restored original dashboards' : `Version ${h.revision}`}</span>
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
