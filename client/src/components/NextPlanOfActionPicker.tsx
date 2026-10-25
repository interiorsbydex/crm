import type { NextPlanItem } from '../lib/api';
import { istDatetimeLocalValue } from '../lib/dateFormat';
import { DateInput, TimeInput, DateTimeInput } from './ui/DateTimeInputs';
import { meetingModeOptions } from '../lib/meetingSettings';

/**
 * Shared "next plan of action" multi-select (Task #86) — used by both the
 * call-log flow and the meeting MOM-completion flow. Lets the user add any
 * number of Call / Meeting / Task follow-ups, each with its own sub-form and
 * an independent "notify client by email" checkbox.
 */

const MEETING_TYPES = [
  { value: 'DQL', label: 'DQL' },
  { value: 'PP', label: 'PP' },
  { value: 'PD', label: 'PD' },
  { value: 'ONBOARDING', label: 'OB' },
  { value: 'OBM', label: 'OBM' },
];
function emptyItem(kind: NextPlanItem['kind']): NextPlanItem {
  return { kind, sendExternalMail: false };
}

interface Props {
  items: NextPlanItem[];
  onChange: (items: NextPlanItem[]) => void;
}

export default function NextPlanOfActionPicker({ items, onChange }: Props) {
  const currentDateTime = istDatetimeLocalValue(new Date());
  const todayIST = currentDateTime.slice(0, 10);
  const currentISTTime = currentDateTime.slice(11, 16);
  const minTimeForDate = (date: string) => date === todayIST ? currentISTTime : undefined;
  const addItem = (kind: NextPlanItem['kind']) => onChange([...items, emptyItem(kind)]);
  const removeItem = (idx: number) => onChange(items.filter((_, i) => i !== idx));
  const updateItem = (idx: number, patch: Partial<NextPlanItem>) =>
    onChange(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-gray-700">Next Plan of Action</label>
        <div className="flex gap-1.5">
          {(['CALL', 'MEETING', 'TASK'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => addItem(kind)}
              className="text-xs px-2.5 py-1 rounded-full border border-gray-200 text-gray-600 hover:border-brand-400 hover:text-brand-600 transition-colors"
            >
              + {kind.charAt(0) + kind.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      {items.map((item, idx) => (
        <div key={idx} className="border border-gray-200 rounded-lg p-3 space-y-2 bg-gray-50">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-600">{item.kind}</span>
            <button type="button" onClick={() => removeItem(idx)} className="text-xs text-red-500 hover:underline">
              Remove
            </button>
          </div>

          {(item.kind === 'TASK' || item.kind === 'CALL') && (
            <div className="grid grid-cols-2 gap-2">
              {item.kind === 'TASK' && (
                <input
                  type="text"
                  value={item.agenda ?? ''}
                  onChange={(e) => updateItem(idx, { agenda: e.target.value })}
                  placeholder="Agenda…"
                  className="col-span-2 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-400"
                />
              )}
              <DateInput
                required
                  min={todayIST}
                value={item.dueDate ?? ''}
                onChange={(v) => updateItem(idx, { dueDate: v })}
                className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-400 w-full"
              />
              <TimeInput
                required
                value={item.dueTime ?? ''}
                onChange={(v) => updateItem(idx, { dueTime: v })}
                min={minTimeForDate(item.dueDate ?? '')}
                className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-400 w-full"
              />
              {item.kind === 'TASK' && (
                <select
                  value={item.taskType ?? ''}
                  onChange={(e) => updateItem(idx, { taskType: (e.target.value || undefined) as any })}
                  className="col-span-2 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-400"
                >
                  <option value="">Internal/External…</option>
                  <option value="INTERNAL">Internal</option>
                  <option value="EXTERNAL">External</option>
                </select>
              )}
              {item.kind === 'CALL' && (
                <input
                  type="text"
                  value={item.notes ?? ''}
                  onChange={(e) => updateItem(idx, { notes: e.target.value })}
                  placeholder="Agenda…"
                  className="col-span-2 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-400"
                />
              )}
            </div>
          )}

          {item.kind === 'MEETING' && (
            <div className="grid grid-cols-2 gap-2">
              <select
                required
                value={item.meetingType ?? ''}
                onChange={(e) => updateItem(idx, { meetingType: e.target.value })}
                className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-400"
              >
                <option value="">Type…</option>
                {MEETING_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <select
                required
                value={item.mode ?? ''}
                onChange={(e) => updateItem(idx, { mode: e.target.value })}
                className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-400"
              >
                <option value="">Mode…</option>
                {meetingModeOptions().map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <DateTimeInput
                required
                min={istDatetimeLocalValue(new Date())}
                value={item.scheduledAt ?? ''}
                onChange={(v) => updateItem(idx, { scheduledAt: v })}
                className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-400 w-full"
              />
              <input
                type="text"
                value={item.location ?? ''}
                onChange={(e) => updateItem(idx, { location: e.target.value })}
                maxLength={250}
                placeholder="Meeting venue or virtual link"
                className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>
          )}

          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={!!item.sendExternalMail}
              onChange={(e) => updateItem(idx, { sendExternalMail: e.target.checked })}
            />
            Notify client by email for this item
          </label>
        </div>
      ))}
    </div>
  );
}
