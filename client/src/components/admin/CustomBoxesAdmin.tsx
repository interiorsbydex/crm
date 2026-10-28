import SettingsScreen from './SettingsScreen';
import { crmSettings } from '../../lib/crmSettings';
import { MEASURE_LABELS } from '../dashboard/CustomBoxes';

// Admin → Custom Boxes (server: lib/customBoxes.ts). Boxes are built from menus:
// what to measure, which leads, how to split it, and whose dashboard shows it.

type Measure = keyof typeof MEASURE_LABELS;
type Split = 'none' | 'stage' | 'source' | 'designer' | 'status';
type Role = 'BRANCH_HEAD' | 'BL' | 'DESIGNER' | 'CRE';
interface Box {
  id: string; title: string; measure: Measure; split: Split;
  stages: string[]; statuses: string[]; sources: string[]; createdWithinDays: number | null; roles: Role[];
}
interface Config { boxes: Box[] }

const SPLITS: { value: Split; label: string }[] = [
  { value: 'none', label: 'One number' },
  { value: 'stage', label: 'A row per stage' },
  { value: 'source', label: 'A row per source' },
  { value: 'designer', label: 'A row per designer' },
  { value: 'status', label: 'A row per status (Active / On Hold / Inactive)' },
];
const ROLES: { value: Role; label: string }[] = [
  { value: 'BRANCH_HEAD', label: 'Branch Head' }, { value: 'BL', label: 'Business Lead' },
  { value: 'DESIGNER', label: 'Designer' }, { value: 'CRE', label: 'CRE' },
];
const STAGES = ['EFFECTIVE_LEAD', 'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER'];
const STATUSES = [['ACTIVE', 'Active'], ['ON_HOLD', 'On Hold'], ['INACTIVE', 'Inactive']];

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
const newId = () => `cb_${Math.random().toString(36).slice(2, 8)}`;

function Chips<T extends string>({ label, options, value, onChange, emptyHint }: {
  label: string; options: { value: T; label: string }[]; value: T[]; onChange: (v: T[]) => void; emptyHint?: string;
}) {
  return (
    <div>
      <p className="text-xs font-semibold text-gray-600 mb-1">{label}{emptyHint && value.length === 0 && <span className="font-normal text-gray-400"> — {emptyHint}</span>}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-1.5 text-sm text-gray-700">
            <input type="checkbox" checked={value.includes(o.value)} onChange={() => onChange(toggle(value, o.value))} /> {o.label}
          </label>
        ))}
      </div>
    </div>
  );
}

export default function CustomBoxesAdmin() {
  const s = crmSettings();
  return (
    <SettingsScreen<Config>
      path="/custom-boxes"
      title="Custom Boxes"
      testId="custom-boxes-admin"
      intro={<>Build your own boxes for the dashboards. Pick what to measure, which leads to include, whether to show one number or a row per stage, source or designer, and whose dashboard shows it. Each person only sees figures for their own leads (the Branch Head sees everyone's), and test leads are left out. New boxes appear under the existing boxes on each dashboard.</>}
    >
      {(draft, setDraft) => {
        const setBox = (i: number, patch: Partial<Box>) => setDraft({ boxes: draft.boxes.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
        return (
          <div className="space-y-4">
            {draft.boxes.length === 0 && <p className="text-sm text-gray-500">No custom boxes yet.</p>}
            {draft.boxes.map((b, i) => (
              <div key={b.id} className="bg-white rounded-xl border border-gray-200 p-5 space-y-3" data-testid={`box-editor-${i}`}>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-xs font-semibold text-gray-600">Box name
                    <input aria-label="Box name" value={b.title} maxLength={60} onChange={(e) => setBox(i, { title: e.target.value })}
                      className="mt-1 block w-64 rounded border border-gray-200 px-2 py-1 text-sm font-normal" placeholder="e.g. Active leads this month" />
                  </label>
                  <label className="text-xs font-semibold text-gray-600">What to measure
                    <select aria-label="What to measure" value={b.measure} onChange={(e) => setBox(i, { measure: e.target.value as Measure })}
                      className="mt-1 block rounded border border-gray-200 px-2 py-1 text-sm font-normal">
                      {(Object.keys(MEASURE_LABELS) as Measure[]).map((m) => <option key={m} value={m}>{MEASURE_LABELS[m]}</option>)}
                    </select>
                  </label>
                  <label className="text-xs font-semibold text-gray-600">Show as
                    <select aria-label="Show as" value={b.split} onChange={(e) => setBox(i, { split: e.target.value as Split })}
                      className="mt-1 block rounded border border-gray-200 px-2 py-1 text-sm font-normal">
                      {SPLITS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                  <label className="text-xs font-semibold text-gray-600">Only leads created in the last (days)
                    <input aria-label="Created within days" type="number" min={1} max={3650} value={b.createdWithinDays ?? ''} placeholder="any time"
                      onChange={(e) => setBox(i, { createdWithinDays: e.target.value === '' ? null : Number(e.target.value) })}
                      className="mt-1 block w-32 rounded border border-gray-200 px-2 py-1 text-sm font-normal" />
                  </label>
                  <button type="button" onClick={() => { if (window.confirm(`Remove the box "${b.title || 'untitled'}"?`)) setDraft({ boxes: draft.boxes.filter((_, j) => j !== i) }); }}
                    className="ml-auto text-xs font-semibold text-red-600 hover:text-red-800">Remove box</button>
                </div>
                <Chips label="Only these stages" emptyHint="leave empty for every stage" options={STAGES.map((v) => ({ value: v, label: s.stageLabels[v] ?? v }))} value={b.stages} onChange={(v) => setBox(i, { stages: v })} />
                <Chips label="Only these statuses" emptyHint="leave empty for every status" options={STATUSES.map(([value, label]) => ({ value, label }))} value={b.statuses} onChange={(v) => setBox(i, { statuses: v })} />
                <Chips label="Only these sources" emptyHint="leave empty for every source" options={s.leadSources.filter((x) => x.active || b.sources.includes(x.value)).map((x) => ({ value: x.value, label: x.label }))} value={b.sources} onChange={(v) => setBox(i, { sources: v })} />
                <Chips label="Show on these dashboards" options={ROLES} value={b.roles} onChange={(v) => setBox(i, { roles: v })} />
              </div>
            ))}
            <button type="button" disabled={draft.boxes.length >= 20}
              onClick={() => setDraft({ boxes: [...draft.boxes, { id: newId(), title: '', measure: 'count', split: 'none', stages: [], statuses: [], sources: [], createdWithinDays: null, roles: ['BRANCH_HEAD'] }] })}
              className="rounded-xl bg-brand-500 text-white text-sm font-semibold px-4 py-2 disabled:opacity-40">+ Add a box</button>
          </div>
        );
      }}
    </SettingsScreen>
  );
}
