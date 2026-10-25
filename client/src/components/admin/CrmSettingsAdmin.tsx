import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { loadCrmSettings, type CrmSettings, type CycleInfo } from '../../lib/crmSettings';

// Admin → CRM Settings: dropdown lists, stage names and simple numbers
// (server: lib/crmSettings.ts). Lists are edited one item per line.

interface LoadResp {
  settings: CrmSettings;
  defaults: CrmSettings;
  isDefault: boolean;
  revision: number;
  updatedAt: string | null;
  updatedByName: string | null;
  cycles: CycleInfo;
  catalog: { leadDetails: { field: string; label: string }[]; hideableStages: string[]; nameableStages: string[]; designPhases: string[] };
}
interface HistoryEntry { id: string; action: string; createdAt: string; byName: string; revision: number | null; note: string | null; settings: CrmSettings | null }

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PHASE_LABELS: Record<string, string> = {
  SITE_DOCUMENTATION: 'Site Documentation', SITE_DISCUSSION: 'Site Discussion', LAYOUT_FINALISATION: 'Layout Finalisation',
  DESIGN_DISCUSSION: 'Design Discussion', PRE_SIGN_OFF: 'Pre Sign-Off', MASKING: 'Masking', SIGN_OFF: 'Sign Off', EIP: 'EIP (Execution in Progress)',
};
const LIST_SECTIONS: { key: 'onHoldReasons' | 'inactiveReasons' | 'reactivationReasons' | 'flagCategories'; title: string; hint: string }[] = [
  { key: 'onHoldReasons', title: 'On-hold reasons', hint: 'Shown when a lead is put On Hold.' },
  { key: 'inactiveReasons', title: 'Inactive reasons', hint: 'Shown when a lead is marked Inactive.' },
  { key: 'reactivationReasons', title: 'Reactivation reasons', hint: 'Shown when a lead is reactivated. An item called "Other" lets the user type a reason.' },
  { key: 'flagCategories', title: 'Flag categories', hint: 'Shown when a lead is flagged for attention.' },
];
const toLines = (items: string[]) => items.join('\n');
const fromLines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);
const codeFor = (label: string) => label.toUpperCase().trim().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/** "2026-11-16" → "16 Nov 2026". */
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const INPUT = 'rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm';
const H3 = 'text-xs font-semibold uppercase tracking-wider text-gray-500';
const CARD = 'bg-white rounded-xl border border-gray-200 p-5 space-y-3';

function NumField({ label, value, onChange, suffix, min = 0 }: { label: string; value: number; onChange: (n: number) => void; suffix?: string; min?: number }) {
  return (
    <label className="block text-xs text-gray-600">
      <span className="font-medium text-gray-800">{label}</span>
      <span className="mt-1 flex items-center gap-1.5">
        <input type="number" min={min} aria-label={label} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
          className={`${INPUT} w-28`} />
        {suffix && <span className="text-gray-400">{suffix}</span>}
      </span>
    </label>
  );
}

export default function CrmSettingsAdmin() {
  const [data, setData] = useState<LoadResp | null>(null);
  const [draft, setDraft] = useState<CrmSettings | null>(null);
  // Text being typed into the list boxes, kept as typed (blank lines etc.) until saved.
  const [listText, setListText] = useState<Record<string, string>>({});
  const [openCity, setOpenCity] = useState<string | null>(null);
  const [newSource, setNewSource] = useState('');
  const [newCity, setNewCity] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [cyclePreview, setCyclePreview] = useState<string[] | null>(null);

  const adopt = (s: CrmSettings) => {
    setDraft(structuredClone(s));
    setListText(Object.fromEntries([
      ...LIST_SECTIONS.map((l) => [l.key, toLines(s[l.key])]),
      ...s.cities.map((c) => [`city:${c.name}`, toLines(c.areas)]),
    ]));
  };
  const load = async () => {
    const d = await api.get<LoadResp>('/admin/crm-settings');
    setData(d);
    adopt(d.settings);
    setProblems([]);
  };
  useEffect(() => { load().catch((e) => toast.error(e?.message ?? 'Could not load CRM settings')); }, []);

  // Show what a different cycle start day would mean before it's saved.
  const chosenDay = draft?.cycleStartDay;
  useEffect(() => {
    setCyclePreview(null);
    if (!data || !chosenDay || !Number.isInteger(chosenDay) || chosenDay < 1 || chosenDay > 28) return;
    const t = setTimeout(() => {
      api.get<{ upcoming: string[] }>(`/admin/crm-settings/cycle-preview?startDay=${chosenDay}`)
        .then((r) => setCyclePreview(r.upcoming)).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [chosenDay, data]);

  /** The draft with the list boxes' text applied. */
  const effective = useMemo<CrmSettings | null>(() => {
    if (!draft) return null;
    const next = structuredClone(draft);
    for (const l of LIST_SECTIONS) if (listText[l.key] !== undefined) next[l.key] = fromLines(listText[l.key]);
    next.cities = next.cities.map((c) => ({ ...c, areas: listText[`city:${c.name}`] !== undefined ? fromLines(listText[`city:${c.name}`]) : c.areas }));
    return next;
  }, [draft, listText]);
  const dirty = !!data && !!effective && JSON.stringify(data.settings) !== JSON.stringify(effective);

  if (!data || !draft || !effective) return <p className="text-sm text-gray-400">Loading CRM settings…</p>;
  const set = <K extends keyof CrmSettings>(k: K, v: CrmSettings[K]) => setDraft({ ...draft, [k]: v });

  const save = async () => {
    // A typed-but-not-added source or city would otherwise be silently left out.
    const pending = [newSource.trim() && `source "${newSource.trim()}"`, newCity.trim() && `city "${newCity.trim()}"`].filter(Boolean);
    if (pending.length) { toast.error(`You typed the ${pending.join(' and ')} but didn't click Add. Click Add, or clear the box, then save.`); return; }
    setBusy(true);
    try {
      await api.put('/admin/crm-settings', { settings: effective, revision: data.revision, note: note.trim() || undefined });
      toast.success('CRM settings saved');
      setNote('');
      setHistory(null);
      await load();
      await loadCrmSettings(true); // refresh every open screen's lists and names
    } catch (e: any) {
      setProblems(Array.isArray(e?.data?.problems) ? e.data.problems : []);
      toast.error(e?.message ?? 'Could not save CRM settings');
    } finally { setBusy(false); }
  };

  const restoreOriginal = async () => {
    if (!window.confirm('Go back to the original CRM settings? Your current settings stay in the change history.')) return;
    setBusy(true);
    try {
      await api.delete('/admin/crm-settings');
      toast.success('Original CRM settings restored');
      setHistory(null);
      await load();
      await loadCrmSettings(true);
    } catch (e: any) { toast.error(e?.message ?? 'Could not restore'); } finally { setBusy(false); }
  };

  const openHistory = async () => {
    setShowHistory((v) => !v);
    if (!history) {
      try { setHistory((await api.get<{ history: HistoryEntry[] }>('/admin/crm-settings/history')).history); }
      catch (e: any) { toast.error(e?.message ?? 'Could not load history'); }
    }
  };

  const addSource = () => {
    const label = newSource.trim();
    const value = codeFor(label);
    if (value.length < 2) { toast.error('Use at least 2 letters or numbers'); return; }
    if (draft.leadSources.some((s) => s.value === value)) { toast.error('That source is already listed'); return; }
    const others = draft.leadSources.filter((s) => s.value !== 'OTHER');
    const other = draft.leadSources.filter((s) => s.value === 'OTHER');
    set('leadSources', [...others, { value, label, active: true }, ...other]);
    setNewSource('');
  };

  const addCity = () => {
    const name = newCity.trim();
    if (!name) return;
    if (draft.cities.some((c) => c.name.toLowerCase() === name.toLowerCase())) { toast.error('That city is already listed'); return; }
    set('cities', [...draft.cities, { name, areas: [] }]);
    setListText({ ...listText, [`city:${name}`]: '' });
    setOpenCity(name);
    setNewCity('');
  };

  return (
    <div className="space-y-5" data-testid="crm-settings">
      <div className={CARD}>
        <h2 className="font-semibold text-gray-900">CRM Settings</h2>
        <p className="text-xs text-gray-500">Dropdown lists, stage names and simple numbers used across the CRM. Changes apply as soon as you save.</p>
        <p className="text-xs text-gray-600">
          {data.isDefault
            ? 'Using the original settings (nothing saved yet).'
            : `Version ${data.revision}, saved${data.updatedByName ? ` by ${data.updatedByName}` : ''}${data.updatedAt ? ` on ${new Date(data.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}.`}
        </p>
      </div>

      <div className={CARD} data-testid="section-stages">
        <h3 className={H3}>Stage names</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {data.catalog.nameableStages.map((st) => (
            <label key={st} className="text-xs text-gray-500">
              {data.defaults.stageLabels[st]}
              <input value={draft.stageLabels[st] ?? ''} maxLength={40} aria-label={`Name for ${data.defaults.stageLabels[st]}`}
                onChange={(e) => set('stageLabels', { ...draft.stageLabels, [st]: e.target.value })} className={`${INPUT} mt-0.5 block w-full`} />
            </label>
          ))}
        </div>
        <p className="text-[11px] text-gray-400 pt-2">Switch off stages you don't use. They disappear from stage menus and the pipeline board, and leads can jump straight past them.</p>
        <div className="flex flex-wrap gap-4">
          {data.catalog.hideableStages.map((st) => (
            <label key={st} className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={draft.hiddenStages.includes(st)}
                onChange={(e) => set('hiddenStages', e.target.checked ? [...draft.hiddenStages, st] : draft.hiddenStages.filter((x) => x !== st))} />
              Switch off {draft.stageLabels[st] || data.defaults.stageLabels[st]}
            </label>
          ))}
        </div>
      </div>

      <div className={CARD} data-testid="section-sources">
        <h3 className={H3}>Lead sources</h3>
        <p className="text-[11px] text-gray-400">Untick to stop offering a source (leads that already have it keep it). "Other" lets designers type a new source.</p>
        <div className="space-y-1.5">
          {draft.leadSources.map((s, i) => (
            <div key={s.value} className="flex items-center gap-3">
              <input value={s.label} maxLength={60} aria-label={`Name for source ${s.value}`}
                onChange={(e) => set('leadSources', draft.leadSources.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                className={`${INPUT} w-64 ${s.active ? '' : 'text-gray-400'}`} />
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                <input type="checkbox" checked={s.active} disabled={s.value === 'OTHER'}
                  onChange={(e) => set('leadSources', draft.leadSources.map((x, j) => (j === i ? { ...x, active: e.target.checked } : x)))} /> In use
              </label>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input value={newSource} onChange={(e) => setNewSource(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addSource()}
            placeholder="e.g. Housing.com" maxLength={60} className={`${INPUT} w-64`} />
          <button onClick={addSource} className="text-xs font-medium text-brand-600 hover:underline">+ Add source</button>
        </div>
      </div>

      <div className={CARD} data-testid="section-cities">
        <h3 className={H3}>Cities and areas</h3>
        <p className="text-[11px] text-gray-400">A city with areas listed gets an area dropdown; without, designers type the area. Users can always pick "Other" to type a city.</p>
        <div className="space-y-1.5">
          {draft.cities.map((c) => {
            const areas = fromLines(listText[`city:${c.name}`] ?? '');
            const open = openCity === c.name;
            return (
              <div key={c.name} className="rounded-lg border border-gray-100">
                <div className="flex items-center gap-3 px-3 py-2">
                  <button onClick={() => setOpenCity(open ? null : c.name)} className="text-sm font-medium text-gray-800 hover:underline">{c.name}</button>
                  <span className="text-xs text-gray-400">{areas.length ? `${areas.length} areas` : 'no areas — typed'}</span>
                  <span className="flex-1" />
                  <button onClick={() => set('cities', draft.cities.filter((x) => x.name !== c.name))} className="text-xs text-red-500 hover:underline">Remove</button>
                </div>
                {open && (
                  <div className="px-3 pb-3">
                    <textarea rows={8} value={listText[`city:${c.name}`] ?? ''} aria-label={`Areas in ${c.name}`}
                      onChange={(e) => setListText({ ...listText, [`city:${c.name}`]: e.target.value })}
                      placeholder="One area per line" className={`${INPUT} w-full font-mono text-xs`} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <input value={newCity} onChange={(e) => setNewCity(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addCity()}
            placeholder="e.g. Kochi" maxLength={60} className={`${INPUT} w-64`} />
          <button onClick={addCity} className="text-xs font-medium text-brand-600 hover:underline">+ Add city</button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {LIST_SECTIONS.map((l) => (
          <div key={l.key} className={CARD} data-testid={`section-${l.key}`}>
            <h3 className={H3}>{l.title}</h3>
            <p className="text-[11px] text-gray-400">{l.hint} One per line.</p>
            <textarea rows={7} value={listText[l.key] ?? ''} aria-label={l.title}
              onChange={(e) => setListText({ ...listText, [l.key]: e.target.value })} className={`${INPUT} w-full text-xs`} />
          </div>
        ))}
      </div>

      <div className={CARD} data-testid="section-new-lead">
        <h3 className={H3}>Details needed for a new lead</h3>
        <p className="text-[11px] text-gray-400">Name, phone and source are always needed. A lead missing any ticked detail (e.g. from an ad form) starts as Effective Lead instead of MQL.</p>
        <div className="flex flex-wrap gap-4">
          {data.catalog.leadDetails.map((d) => (
            <label key={d.field} className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={draft.leadCreateRequired.includes(d.field)}
                onChange={(e) => set('leadCreateRequired', e.target.checked ? [...draft.leadCreateRequired, d.field] : draft.leadCreateRequired.filter((x) => x !== d.field))} />
              {d.label}
            </label>
          ))}
        </div>
      </div>

      <div className={CARD} data-testid="section-discount">
        <h3 className={H3}>Discount approval limits</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumField label="Designer approves up to" suffix="%" value={draft.discount.selfApproveUpToPct} onChange={(n) => set('discount', { ...draft.discount, selfApproveUpToPct: n })} />
          <NumField label="Business Lead approves up to" suffix="%" value={draft.discount.blApproveUpToPct} onChange={(n) => set('discount', { ...draft.discount, blApproveUpToPct: n })} />
          <NumField label="Branch Head approves up to" suffix="% (above = special case)" value={draft.discount.branchHeadUpToPct} onChange={(n) => set('discount', { ...draft.discount, branchHeadUpToPct: n })} />
          <NumField label="Special case if woodwork after discount is below" suffix="₹" value={draft.discount.woodworkSpecialCaseBelow} onChange={(n) => set('discount', { ...draft.discount, woodworkSpecialCaseBelow: n })} />
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={draft.discount.requireApprovalComment} onChange={(e) => set('discount', { ...draft.discount, requireApprovalComment: e.target.checked })} />
          A comment is required when approving a discount (rejecting always needs one)
        </label>
      </div>

      <div className={CARD} data-testid="section-calls">
        <h3 className={H3}>Calls</h3>
        <div className="flex flex-wrap items-end gap-6">
          <NumField label="Flag for escalation after this many unanswered calls" suffix="calls" min={1} value={draft.calls.rnrEscalationAfter} onChange={(n) => set('calls', { ...draft.calls, rnrEscalationAfter: n })} />
          <NumField label="Suggest making it inactive once the lead is this old" suffix="months" min={1} value={draft.calls.rnrInactivationMonths} onChange={(n) => set('calls', { ...draft.calls, rnrInactivationMonths: n })} />
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={draft.calls.requireFollowUp} onChange={(e) => set('calls', { ...draft.calls, requireFollowUp: e.target.checked })} />
          A follow-up task (date and time) must be set when logging a call
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={draft.notifyClientByDefault} onChange={(e) => set('notifyClientByDefault', e.target.checked)} />
          "Notify the client" boxes on call, meeting and follow-up forms start ticked
        </label>
      </div>

      <div className={CARD} data-testid="section-display">
        <h3 className={H3}>Display</h3>
        <label className="block text-xs text-gray-600">
          <span className="font-medium text-gray-800">Country preselected for new phone numbers</span>
          <input value={draft.defaultPhoneCountry} maxLength={2} onChange={(e) => set('defaultPhoneCountry', e.target.value.toUpperCase())}
            className={`${INPUT} mt-1 block w-20`} aria-label="Default phone country" />
          <span className="text-[11px] text-gray-400">Two-letter code, e.g. IN, AE, US</span>
        </label>
        <p className="mt-4 text-xs font-medium text-gray-800">Shown on Sales Pipeline cards</p>
        <div className="mt-1 flex flex-wrap gap-4">
          {([['scope', 'Project type & scope'], ['value', 'Value'], ['location', 'Location'], ['owner', 'Designer / BL'], ['source', 'Source'], ['age', 'Age'], ['intent', 'Intent stars'], ['phone', 'Phone']] as const).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1.5 text-sm text-gray-700">
              <input type="checkbox" checked={draft.pipelineCardFields.includes(key)}
                onChange={(e) => set('pipelineCardFields', e.target.checked ? [...draft.pipelineCardFields, key] : draft.pipelineCardFields.filter((f) => f !== key))} />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className={CARD} data-testid="section-timing">
        <h3 className={H3}>Reminders and digests</h3>
        <div className="flex flex-wrap items-end gap-6">
          <NumField label="Remind before a meeting or follow-up" suffix="minutes" min={15} value={draft.reminderMinutesBefore} onChange={(n) => set('reminderMinutesBefore', n)} />
          <label className="block text-xs text-gray-600">
            <span className="font-medium text-gray-800">Weekly digest day (08:00)</span>
            <select value={draft.weeklyDigestDay} onChange={(e) => set('weeklyDigestDay', Number(e.target.value))} className={`${INPUT} mt-1 block`}>
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </label>
        </div>
        <p className="text-[11px] text-gray-400">The wording of the reminder and digest emails is edited under Settings → Mail templates.</p>
      </div>

      <div className={CARD} data-testid="section-cycle">
        <h3 className={H3}>Targets and credits cycle</h3>
        <p className="text-[11px] text-gray-400">
          The day of the month each target and credit cycle starts. A change starts when the current cycle ends — cycles already
          under way never move, so targets and credits already recorded stay as they are.
        </p>
        <div className="flex flex-wrap items-end gap-6">
          <NumField label="Cycle starts on day" suffix="of the month (1–28)" min={1} value={draft.cycleStartDay} onChange={(n) => set('cycleStartDay', n)} />
        </div>
        <div className="text-xs text-gray-600 space-y-0.5" data-testid="cycle-info">
          <p>In force now: cycles start on day {data.cycles.startDayInEffect}.{data.cycles.pending ? ` Already scheduled: day ${data.cycles.pending.startDay} from ${fmtDay(data.cycles.pending.from)}.` : ''}</p>
          {cyclePreview && <p>Next cycles{draft.cycleStartDay !== data.settings.cycleStartDay ? ' after saving' : ''}: {cyclePreview.join(' → ')}</p>}
        </div>
      </div>

      <div className={CARD} data-testid="section-design">
        <h3 className={H3}>Design phase days</h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {data.catalog.designPhases.map((ph) => (
            <NumField key={ph} label={PHASE_LABELS[ph] ?? ph} suffix="days" min={1} value={draft.designPhaseDays[ph]}
              onChange={(n) => set('designPhaseDays', { ...draft.designPhaseDays, [ph]: n })} />
          ))}
          <NumField label="Overall design time" suffix="days" min={1} value={draft.designOverallDays} onChange={(n) => set('designOverallDays', n)} />
        </div>
      </div>

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
            {busy ? 'Saving…' : 'Save CRM settings'}
          </button>
          <button onClick={() => { adopt(data.settings); setProblems([]); }} disabled={!dirty || busy} className="text-xs text-gray-500 hover:underline disabled:opacity-40">Discard changes</button>
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
                    <span className="font-medium text-gray-800">{h.action === 'CRM_SETTINGS_RESET' ? 'Restored original settings' : `Version ${h.revision}`}</span>
                    <span>{h.byName} · {new Date(h.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>
                    {h.note && <span className="text-gray-500">— {h.note}</span>}
                    {h.settings && (
                      <button onClick={() => { adopt(h.settings!); toast('Loaded into the editor — review it, then save to apply'); }}
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
