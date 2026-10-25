import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../lib/api';

/**
 * Shared by the PD→OB, OB→OBM and OBM→DIP checklist panels.
 * useChecklistStatus: what's done and what's still missing, worked out by the
 * server (lib/checklists.ts) so it always matches what the send/complete step
 * will accept, including Admin → Checklists choices.
 * <CustomChecklistItems>: the admin's own items, with an input for each.
 */
export interface ChecklistItemStatus {
  key: string;
  label: string;
  met: boolean;
  required: boolean;
  locked: boolean;
  renamed?: boolean;
  custom?: { kind: 'tick' | 'date' | 'text' | 'document'; docType?: string; value: unknown };
}
/** `missing`: required items not done. `blocking`: what the send step will refuse on (lenient mode waives most). */
export interface ChecklistStatus { items: ChecklistItemStatus[]; missing: string[]; blocking?: string[]; lenient?: boolean }

/** The admin's name for a built-in item (Admin → Checklists), else the panel's own wording. */
export function itemLabel(status: ChecklistStatus | null, key: string, fallback: string): string {
  const item = status?.items.find((i) => i.key === key);
  return item?.renamed ? item.label : fallback;
}

/** `basePath` is the checklist's API path, e.g. `/leads/<id>/pd-ob-checklist`. `refreshKey` re-fetches when it changes. */
export function useChecklistStatus(basePath: string, refreshKey: unknown) {
  const [status, setStatus] = useState<ChecklistStatus | null>(null);
  const reload = useCallback(() => api.get<ChecklistStatus>(`${basePath}/status`).then(setStatus).catch(() => {}), [basePath]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [reload, JSON.stringify(refreshKey)]);
  return { status, reload };
}

export function CustomChecklistItems({ basePath, status, disabled, onSaved }: {
  basePath: string;
  status: ChecklistStatus | null;
  disabled?: boolean;
  onSaved: () => void;
}) {
  const items = status?.items.filter((i) => i.custom) ?? [];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  if (!items.length) return null;

  const save = async (key: string, value: unknown) => {
    setSaving(key);
    try {
      await api.patch(basePath, { customValues: { [key]: value } });
      onSaved();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save');
    } finally { setSaving(null); }
  };

  return (
    <div className="mt-4 space-y-2" data-testid="custom-checklist-items">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">More items</p>
      {items.map((i) => {
        const kind = i.custom!.kind;
        const value = i.custom!.value;
        return (
          <div key={i.key} className="flex flex-wrap items-center gap-2 text-sm">
            <span className={`w-4 text-center ${i.met ? 'text-green-600' : 'text-gray-300'}`}>{i.met ? '✓' : '○'}</span>
            <span className="text-gray-800">{i.label}{!i.required && <span className="ml-1 text-[11px] text-gray-400">(optional)</span>}</span>
            {kind === 'tick' && (
              <input type="checkbox" aria-label={i.label} checked={value === true} disabled={disabled || saving === i.key}
                onChange={(e) => save(i.key, e.target.checked)} className="ml-1" />
            )}
            {kind === 'date' && (
              <input type="date" aria-label={i.label} value={typeof value === 'string' ? value.slice(0, 10) : ''} disabled={disabled || saving === i.key}
                onChange={(e) => save(i.key, e.target.value || null)} className="rounded border border-gray-200 px-2 py-1 text-xs" />
            )}
            {kind === 'text' && (
              <input aria-label={i.label} value={drafts[i.key] ?? (typeof value === 'string' ? value : '')} disabled={disabled || saving === i.key}
                onChange={(e) => setDrafts({ ...drafts, [i.key]: e.target.value })}
                onBlur={(e) => { if (e.target.value !== (value ?? '')) save(i.key, e.target.value.trim() || null); }}
                className="flex-1 min-w-[180px] rounded border border-gray-200 px-2 py-1 text-xs" />
            )}
            {kind === 'document' && <span className="text-[11px] text-gray-400">{i.met ? 'uploaded' : 'upload it on the Files tab'}</span>}
          </div>
        );
      })}
    </div>
  );
}
