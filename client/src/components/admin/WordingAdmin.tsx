import SettingsScreen from './SettingsScreen';
import { loadWording } from '../../lib/wording';

// Admin → Wording: relabel screen text (server: lib/wording.ts).

type Value = Record<string, string>;
interface Catalog { labels: { key: string; where: string; text: string; long?: boolean }[] }

export default function WordingAdmin() {
  return (
    <SettingsScreen<Value, Catalog>
      path="/wording"
      title="Wording"
      testId="wording-admin"
      onSaved={() => { loadWording(true).catch(() => {}); }}
      intro={<>Change what these labels say. Leave a box as it is to keep the original wording. Checklist items are renamed in Admin → Checklists, stage names in CRM Settings and meeting types in Meetings.</>}
    >
      {(draft, setDraft, data) => (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          {data.catalog!.labels.map((l) => {
            const value = draft[l.key] ?? l.text;
            const set = (v: string) => {
              const next = { ...draft };
              if (v === l.text) delete next[l.key]; else next[l.key] = v;
              setDraft(next);
            };
            return (
              <label key={l.key} className="block text-xs text-gray-500" data-testid={`wording-${l.key}`}>
                <span className="flex items-center gap-2">
                  {l.where}
                  {draft[l.key] !== undefined && (
                    <button type="button" onClick={() => set(l.text)} className="text-brand-600 hover:underline">use original</button>
                  )}
                </span>
                {l.long ? (
                  <textarea rows={2} value={value} maxLength={400} onChange={(e) => set(e.target.value)} aria-label={l.where}
                    className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-800" />
                ) : (
                  <input value={value} maxLength={400} onChange={(e) => set(e.target.value)} aria-label={l.where}
                    className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-800" />
                )}
              </label>
            );
          })}
        </div>
      )}
    </SettingsScreen>
  );
}
