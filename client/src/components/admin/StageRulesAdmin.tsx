import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowDown, ArrowUp, Lock, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';

// Admin → Stage Rules: what a lead needs before it can move to the next stage.
// The server (config/stageRequirements.ts) is the only place these rules are
// enforced; this screen edits the saved copy.

type WhenSkipped = 'required' | 'waived' | 'owedLater';
interface Item {
  id: string;
  type: string;
  label: string;
  whenSkipped: WhenSkipped;
  locked?: boolean;
  field?: string;
  key?: string;
  meetingType?: string;
  meetingTypes?: string[];
  status?: 'scheduled' | 'completed';
  fileType?: string;
  fileTypes?: string[];
  stages?: string[];
}
interface Config {
  transitions: Record<string, Item[]>;
  skippableStages: string[];
  allowMqlToOnboarding: boolean;
  enforcement: Record<string, 'block' | 'warn'>;
}
interface DocType { key: string; label: string; active: boolean }
interface Catalog {
  edges: string[];
  skippableCandidates: string[];
  warnableTargets: string[];
  owedLaterStages: string[];
  fields: { field: string; label: string }[];
  meetings: { meetingType: string; label: string }[];
  customFields: { key: string; label: string }[];
  documentTypes: DocType[];
}
interface LoadResp {
  config: Config;
  defaults: Config;
  isDefault: boolean;
  revision: number;
  updatedAt: string | null;
  updatedByName: string | null;
  catalog: Catalog;
}
interface HistoryEntry {
  id: string; action: string; createdAt: string; byName: string;
  revision: number | null; note: string | null; config: Config | null;
}
interface ImpactRow { stage: string; nextStage: string; leads: number; newlyHeldUp: number; newlyClear: number; examples: string[] }

const STAGE_LABELS: Record<string, string> = {
  MQL: 'MQL', DQL: 'DQL', PROPOSAL_READY: 'Proposal Ready', PROPOSAL_PRESENTED: 'Proposal Presented',
  PROPOSAL_DISCUSSION: 'PD (Pitch Discussion)', ONBOARDING: 'Onboarding',
  ONBOARDING_MEETING: 'Onboarding Meeting', DESIGN_IN_PROGRESS: 'Design in Progress',
};
const stageLabel = (s: string) => STAGE_LABELS[s] ?? s;
const edgeLabel = (edge: string) => edge.split('->').map(stageLabel).join(' → ');
/** Stages a lead can jump over (directly, or PP via the MQL → Onboarding shortcut). */
const JUMPABLE = ['DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION'];

type Kind = 'field' | 'document' | 'quote' | 'meeting' | 'meetingOrCall';
const KIND_LABELS: Record<Kind, string> = {
  field: 'A lead detail is filled in',
  document: 'A document is uploaded',
  quote: 'A quotation exists (Quote Builder or uploaded)',
  meeting: 'A meeting',
  meetingOrCall: 'A completed meeting, or any logged call',
};
function kindOf(item: Item): Kind {
  if (item.type === 'field' || item.type === 'customField') return 'field';
  if (item.type === 'file' || item.type === 'fileAnyOf') return 'document';
  if (item.type === 'meeting' || item.type === 'meetingAnyOf') return 'meeting';
  return item.type as Kind;
}
const newId = () => `item:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const SELECT = 'rounded-lg border border-gray-200 px-2 py-1.5 text-xs bg-white';

export default function StageRulesAdmin() {
  const [data, setData] = useState<LoadResp | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'preview' | 'reset'>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [impact, setImpact] = useState<{ rows: ImpactRow[]; leadsChecked: number; truncated: boolean } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = async () => {
    const d = await api.get<LoadResp>('/admin/stage-rules');
    setData(d);
    setDraft(structuredClone(d.config));
    setProblems([]);
    setImpact(null);
  };
  useEffect(() => { load().catch((e) => toast.error(e?.message ?? 'Could not load stage rules')); }, []);

  const dirty = useMemo(() => !!data && !!draft && JSON.stringify(data.config) !== JSON.stringify(draft), [data, draft]);
  useEffect(() => { setImpact(null); }, [draft]);

  if (!data || !draft) return <p className="text-sm text-gray-400">Loading stage rules…</p>;
  const { catalog } = data;
  const activeDocs = catalog.documentTypes.filter((t) => t.active);
  const docLabel = (k: string) => catalog.documentTypes.find((t) => t.key === k)?.label ?? k;
  // Suggested messages. A message still equal to its suggestion follows the
  // selection; one the admin has rewritten is left alone.
  const docMessage = (keys: string[]) => `${keys.map(docLabel).join(' or ')} uploaded`;
  const meetingMessage = (type?: string, status?: string) =>
    `${catalog.meetings.find((m) => m.meetingType === type)?.label ?? type} ${status === 'completed' ? 'completed' : 'scheduled'}`;

  const setEdge = (edge: string, items: Item[]) => setDraft({ ...draft, transitions: { ...draft.transitions, [edge]: items } });
  const updateItem = (edge: string, i: number, patch: Partial<Item>) =>
    setEdge(edge, draft.transitions[edge].map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const replaceItem = (edge: string, i: number, item: Item) =>
    setEdge(edge, draft.transitions[edge].map((it, j) => (j === i ? item : it)));
  const move = (edge: string, i: number, by: number) => {
    const items = [...draft.transitions[edge]];
    const j = i + by;
    if (j < 0 || j >= items.length || items[j].locked) return;
    [items[i], items[j]] = [items[j], items[i]];
    setEdge(edge, items);
  };

  const changeKind = (edge: string, i: number, kind: Kind) => {
    const old = draft.transitions[edge][i];
    const base = { id: old.id, whenSkipped: old.whenSkipped };
    const f = catalog.fields[0];
    const fresh: Record<Kind, Item> = {
      field: { ...base, type: 'field', field: f.field, label: f.label },
      document: { ...base, type: 'file', fileType: activeDocs[0]?.key ?? 'FLOOR_PLAN', stages: [], label: docMessage([activeDocs[0]?.key ?? 'FLOOR_PLAN']) },
      quote: { ...base, type: 'quote', stages: [], fileTypes: ['QUOTATION', 'GENERATED_QUOTE'], label: 'Quotation' },
      meeting: { ...base, type: 'meeting', meetingType: 'DQL', status: 'completed', label: meetingMessage('DQL', 'completed') },
      meetingOrCall: { ...base, type: 'meetingOrCall', meetingType: 'PP', label: 'Meeting or call completed' },
    };
    replaceItem(edge, i, fresh[kind]);
  };

  const addItem = (edge: string) => {
    const items = draft.transitions[edge];
    const firstLocked = items.findIndex((it) => it.locked);
    const item: Item = { id: newId(), type: 'field', field: 'estimatedValue', label: 'Project value', whenSkipped: 'required' };
    setEdge(edge, firstLocked === -1 ? [...items, item] : [...items.slice(0, firstLocked), item, ...items.slice(firstLocked)]);
  };

  const errorProblems = (e: any) => {
    const p = e?.data?.problems;
    setProblems(Array.isArray(p) ? p : []);
    toast.error(e?.message ?? 'Something went wrong');
  };

  const preview = async () => {
    setBusy('preview');
    try {
      setProblems([]);
      setImpact(await api.post('/admin/stage-rules/preview', { config: draft }));
    } catch (e) { errorProblems(e); } finally { setBusy(null); }
  };

  const save = async () => {
    setBusy('save');
    try {
      await api.put('/admin/stage-rules', { config: draft, revision: data.revision, note: note.trim() || undefined });
      toast.success('Stage rules saved — they apply to the next stage move');
      setNote('');
      setHistory(null);
      await load();
    } catch (e) { errorProblems(e); } finally { setBusy(null); }
  };

  const restoreOriginal = async () => {
    if (!window.confirm('Go back to the original stage rules? Your current rules stay in the change history.')) return;
    setBusy('reset');
    try {
      await api.delete('/admin/stage-rules');
      toast.success('Original stage rules restored');
      setHistory(null);
      await load();
    } catch (e) { errorProblems(e); } finally { setBusy(null); }
  };

  const openHistory = async () => {
    setShowHistory((v) => !v);
    if (!history) {
      try { setHistory((await api.get<{ history: HistoryEntry[] }>('/admin/stage-rules/history')).history); }
      catch (e: any) { toast.error(e?.message ?? 'Could not load history'); }
    }
  };

  const toggleSkippable = (stage: string, on: boolean) =>
    setDraft({ ...draft, skippableStages: on ? [...draft.skippableStages, stage] : draft.skippableStages.filter((s) => s !== stage) });

  return (
    <div className="space-y-5" data-testid="stage-rules">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="font-semibold text-gray-900">Stage Rules</h2>
        <p className="mt-1 text-xs text-gray-500">
          What a lead needs before it can move to the next stage. Changes apply to the next stage move — leads already moved are not affected.
        </p>
        <p className="mt-2 text-xs text-gray-600">
          {data.isDefault
            ? 'Using the original rules (nothing saved yet).'
            : `Version ${data.revision}, saved${data.updatedByName ? ` by ${data.updatedByName}` : ''}${data.updatedAt ? ` on ${new Date(data.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}.`}
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Skipping stages</h3>
        <p className="text-[11px] text-gray-400">Stages a lead may jump straight past. Every other stage must be visited one at a time.</p>
        <div className="flex flex-wrap gap-4">
          {catalog.skippableCandidates.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={draft.skippableStages.includes(s)} onChange={(e) => toggleSkippable(s, e.target.checked)} />
              {stageLabel(s)} can be skipped
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={draft.allowMqlToOnboarding} onChange={(e) => setDraft({ ...draft, allowMqlToOnboarding: e.target.checked })} />
            Allow MQL → Onboarding directly
          </label>
        </div>
      </div>

      {catalog.edges.map((edge) => {
        const toStage = edge.split('->')[1];
        const items = draft.transitions[edge] ?? [];
        const warnable = catalog.warnableTargets.includes(toStage);
        const showSkip = JUMPABLE.includes(toStage);
        const canOweLater = catalog.owedLaterStages.includes(toStage);
        return (
          <div key={edge} className="bg-white rounded-xl border border-gray-200 p-5 space-y-3" data-testid={`edge-${edge}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-medium text-gray-900">{edgeLabel(edge)}</h3>
              {warnable ? (
                <label className="flex items-center gap-2 text-xs text-gray-600">
                  If something is missing:
                  <select className={SELECT} value={draft.enforcement[toStage] ?? 'block'}
                    onChange={(e) => setDraft({ ...draft, enforcement: { ...draft.enforcement, [toStage]: e.target.value as 'block' | 'warn' } })}>
                    <option value="block">Block the move</option>
                    <option value="warn">Allow the move, but record what was missing</option>
                  </select>
                </label>
              ) : (
                <span className="text-[11px] text-gray-400">Always blocked if something is missing (Onboarding onward)</span>
              )}
            </div>

            {items.length === 0 && <p className="text-xs text-gray-400">Nothing required — any lead can make this move.</p>}

            <div className="space-y-2">
              {items.map((item, i) => {
                if (item.locked) {
                  return (
                    <div key={item.id} className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
                      <Lock size={12} /> {item.label} <span className="text-gray-400">— checklist step, edited in the checklist itself</span>
                    </div>
                  );
                }
                const kind = kindOf(item);
                return (
                  <div key={item.id} className="rounded-lg border border-gray-100 p-3 space-y-2" data-testid="rule-item">
                    <div className="flex flex-wrap items-center gap-2">
                      <select className={SELECT} value={kind} onChange={(e) => changeKind(edge, i, e.target.value as Kind)} aria-label="Requirement type">
                        {(Object.keys(KIND_LABELS) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                      </select>

                      {kind === 'field' && (
                        <select className={SELECT} aria-label="Lead detail"
                          value={item.type === 'customField' ? `custom:${item.key}` : `field:${item.field}`}
                          onChange={(e) => {
                            const [t, v] = e.target.value.split(/:(.*)/);
                            const label = t === 'custom' ? catalog.customFields.find((c) => c.key === v)?.label : catalog.fields.find((f) => f.field === v)?.label;
                            replaceItem(edge, i, t === 'custom'
                              ? { id: item.id, whenSkipped: item.whenSkipped, type: 'customField', key: v, label: label ?? v }
                              : { id: item.id, whenSkipped: item.whenSkipped, type: 'field', field: v, label: label ?? v });
                          }}>
                          {catalog.fields.map((f) => <option key={f.field} value={`field:${f.field}`}>{f.label}</option>)}
                          {catalog.customFields.length > 0 && (
                            <optgroup label="Custom fields">
                              {catalog.customFields.map((c) => <option key={c.key} value={`custom:${c.key}`}>{c.label}</option>)}
                            </optgroup>
                          )}
                        </select>
                      )}

                      {(kind === 'meeting' || kind === 'meetingOrCall') && item.type !== 'meetingAnyOf' && (
                        <select className={SELECT} aria-label="Meeting type" value={item.meetingType}
                          onChange={(e) => updateItem(edge, i, {
                            meetingType: e.target.value,
                            ...(kind === 'meeting' && item.label === meetingMessage(item.meetingType, item.status) && { label: meetingMessage(e.target.value, item.status) }),
                          })}>
                          {catalog.meetings.map((m) => <option key={m.meetingType} value={m.meetingType}>{m.label}</option>)}
                        </select>
                      )}
                      {item.type === 'meetingAnyOf' && (
                        <span className="text-xs text-gray-600">{(item.meetingTypes ?? []).map((t) => catalog.meetings.find((m) => m.meetingType === t)?.label ?? t).join(' or ')}</span>
                      )}
                      {kind === 'meeting' && (
                        <select className={SELECT} aria-label="Meeting status" value={item.status ?? 'scheduled'}
                          onChange={(e) => updateItem(edge, i, {
                            status: e.target.value as Item['status'],
                            ...(item.type === 'meeting' && item.label === meetingMessage(item.meetingType, item.status) && { label: meetingMessage(item.meetingType, e.target.value) }),
                          })}>
                          <option value="scheduled">is scheduled (or done)</option>
                          <option value="completed">is marked completed</option>
                        </select>
                      )}

                      <div className="ml-auto flex items-center gap-1">
                        <button onClick={() => move(edge, i, -1)} disabled={i === 0} className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30" aria-label="Move up"><ArrowUp size={13} /></button>
                        <button onClick={() => move(edge, i, 1)} className="p-1 text-gray-400 hover:text-gray-700" aria-label="Move down"><ArrowDown size={13} /></button>
                        <button onClick={() => setEdge(edge, items.filter((_, j) => j !== i))} className="p-1 text-red-400 hover:text-red-600" aria-label="Remove requirement"><Trash2 size={13} /></button>
                      </div>
                    </div>

                    {kind === 'document' && (
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        <span className="text-[11px] text-gray-500 w-full">Any one of these counts:</span>
                        {[...new Set([...(item.type === 'fileAnyOf' ? item.fileTypes ?? [] : [item.fileType ?? '']), ...activeDocs.map((d) => d.key)])].filter(Boolean).map((k) => {
                          const chosen = item.type === 'fileAnyOf' ? item.fileTypes ?? [] : [item.fileType ?? ''];
                          const on = chosen.includes(k);
                          return (
                            <label key={k} className="flex items-center gap-1.5 text-xs text-gray-700">
                              <input type="checkbox" checked={on} onChange={(e) => {
                                const next = e.target.checked ? [...chosen, k] : chosen.filter((x) => x !== k);
                                if (next.length === 0) return;
                                const label = item.label === docMessage(chosen) ? docMessage(next) : item.label;
                                replaceItem(edge, i, next.length === 1
                                  ? { id: item.id, whenSkipped: item.whenSkipped, label, type: 'file', fileType: next[0], stages: item.stages ?? [] }
                                  : { id: item.id, whenSkipped: item.whenSkipped, label, type: 'fileAnyOf', fileTypes: next, stages: item.stages ?? [] });
                              }} />
                              {docLabel(k)}
                            </label>
                          );
                        })}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex-1 min-w-[240px] text-[11px] text-gray-500">
                        Message the designer sees
                        <input value={item.label} maxLength={200} onChange={(e) => updateItem(edge, i, { label: e.target.value })}
                          className="mt-0.5 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-800" />
                      </label>
                      {showSkip && (
                        <label className="text-[11px] text-gray-500">
                          If {stageLabel(toStage)} is skipped
                          <select className={`${SELECT} mt-0.5 block`} value={item.whenSkipped}
                            onChange={(e) => updateItem(edge, i, { whenSkipped: e.target.value as WhenSkipped })}>
                            <option value="required">still required</option>
                            <option value="waived">not needed</option>
                            {canOweLater && <option value="owedLater">not needed now, but owed at the next move</option>}
                          </select>
                        </label>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <button onClick={() => addItem(edge)} className="text-xs font-medium text-brand-600 hover:underline">+ Add requirement</button>
          </div>
        );
      })}

      <div className="sticky bottom-0 bg-white rounded-xl border border-gray-200 p-4 space-y-3 shadow-sm">
        {problems.length > 0 && (
          <div className="rounded-lg bg-red-50 border border-red-100 p-3 text-xs text-red-700" role="alert">
            <p className="font-medium mb-1">Please fix these before saving:</p>
            <ul className="list-disc pl-4 space-y-0.5">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
          </div>
        )}
        {impact && (
          <div className="rounded-lg bg-gray-50 border border-gray-100 p-3 text-xs text-gray-700" data-testid="impact">
            <p className="font-medium mb-1">Effect on active leads' next stage move ({impact.leadsChecked} leads checked{impact.truncated ? ', first 2,000 only' : ''}):</p>
            {impact.rows.every((r) => r.newlyHeldUp === 0 && r.newlyClear === 0)
              ? <p>No active lead's next move changes.</p>
              : (
                <ul className="space-y-0.5">
                  {impact.rows.filter((r) => r.newlyHeldUp || r.newlyClear).map((r) => (
                    <li key={r.stage}>
                      {edgeLabel(`${r.stage}->${r.nextStage}`)}: {r.newlyHeldUp > 0 && <span className="text-amber-700">{r.newlyHeldUp} of {r.leads} would now be missing something{r.examples.length ? ` (e.g. ${r.examples.join(', ')})` : ''}</span>}
                      {r.newlyHeldUp > 0 && r.newlyClear > 0 && '; '}
                      {r.newlyClear > 0 && <span className="text-green-700">{r.newlyClear} would no longer be missing anything</span>}
                    </li>
                  ))}
                </ul>
              )}
          </div>
        )}
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="What did you change? (optional — shown in the change history)"
          className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-xs" />
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={save} disabled={!dirty || !!busy} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40">
            {busy === 'save' ? 'Saving…' : 'Save stage rules'}
          </button>
          <button onClick={preview} disabled={!dirty || !!busy} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40">
            {busy === 'preview' ? 'Checking leads…' : 'Preview effect on leads'}
          </button>
          <button onClick={() => { setDraft(structuredClone(data.config)); setProblems([]); }} disabled={!dirty || !!busy} className="text-xs text-gray-500 hover:underline disabled:opacity-40">Discard changes</button>
          <span className="flex-1" />
          <button onClick={openHistory} className="text-xs text-gray-500 hover:underline">{showHistory ? 'Hide' : 'Show'} change history</button>
          <button onClick={restoreOriginal} disabled={data.isDefault || !!busy} className="text-xs text-red-500 hover:underline disabled:opacity-40">Restore original rules</button>
        </div>
        {showHistory && (
          <div className="border-t border-gray-100 pt-3" data-testid="history">
            {!history ? <p className="text-xs text-gray-400">Loading…</p> : history.length === 0 ? <p className="text-xs text-gray-400">No changes yet.</p> : (
              <ul className="space-y-1.5">
                {history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                    <span className="font-medium text-gray-800">{h.action === 'STAGE_RULES_RESET' ? 'Restored original rules' : `Version ${h.revision}`}</span>
                    <span>{h.byName} · {new Date(h.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>
                    {h.note && <span className="text-gray-500">— {h.note}</span>}
                    {h.config && (
                      <button onClick={() => { setDraft(structuredClone(h.config!)); toast('Loaded into the editor — review it, then save to apply'); }}
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
