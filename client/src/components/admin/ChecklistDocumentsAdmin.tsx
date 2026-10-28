import { useState } from 'react';
import toast from 'react-hot-toast';
import SettingsScreen from './SettingsScreen';
import { uploadFile } from '../../lib/api';

// Admin → Checklist Documents (server: lib/obmDocuments.ts). One set of standard
// documents per Onboarding → OBM checklist item; they go out with the OBM mail
// whenever that item is ticked on a lead.

interface Doc { storagePath: string; name: string; size: number }
interface Config { docs: Record<string, Doc[]> }
interface Catalog { items: { key: string; label: string }[] }

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function ChecklistDocumentsAdmin() {
  const [uploading, setUploading] = useState<string | null>(null);
  return (
    <SettingsScreen<Config, Catalog>
      path="/obm-documents"
      title="Checklist Documents"
      testId="checklist-documents-admin"
      intro={<>Attach the standard document for each Onboarding → OBM checklist item (for example the Credit system PDF). When someone ticks that item on a lead, its documents go out with the OBM mail automatically, and the designer sees them listed on the mail's review screen. Welcome documents that go with every OBM mail are still set on the Settings page. PDF, Word, PNG or JPG, up to 4 MB each and 20 MB in all.</>}
    >
      {(draft, setDraft, data) => (
        <div className="space-y-3">
          {(data.catalog?.items ?? []).map((item) => {
            const docs = draft.docs[item.key] ?? [];
            const set = (list: Doc[]) => setDraft({ docs: { ...draft.docs, [item.key]: list } });
            const add = async (files: FileList | null) => {
              if (!files?.length) return;
              setUploading(item.key);
              try {
                let list = docs;
                for (const file of Array.from(files)) {
                  const form = new FormData();
                  form.append('file', file);
                  list = [...list, (await uploadFile<{ attachment: Doc }>('/admin/obm-documents/upload', form)).attachment];
                }
                set(list);
              } catch (e: any) {
                toast.error(e.message ?? 'Could not upload the document');
              } finally { setUploading(null); }
            };
            return (
              <div key={item.key} className="bg-white rounded-xl border border-gray-200 p-4" data-testid={`obm-doc-${item.key}`}>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-gray-800">{item.label}</h3>
                  <label className={`rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 ${uploading === item.key ? 'opacity-50' : 'cursor-pointer'}`}>
                    {uploading === item.key ? 'Uploading…' : '+ Add document'}
                    <input type="file" multiple className="hidden" accept=".pdf,.docx,.png,.jpg,.jpeg" disabled={uploading !== null}
                      aria-label={`Add a document for ${item.label}`} onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
                  </label>
                </div>
                {docs.length === 0
                  ? <p className="mt-2 text-xs text-gray-400">No document yet: ticking this item attaches nothing.</p>
                  : (
                    <ul className="mt-2 space-y-1">
                      {docs.map((d) => (
                        <li key={d.storagePath} className="flex items-center justify-between rounded border border-gray-100 px-2 py-1 text-xs text-gray-700">
                          <span className="truncate">{d.name} <span className="text-gray-400">({kb(d.size)})</span></span>
                          <button type="button" className="ml-2 text-red-600 hover:text-red-800" onClick={() => set(docs.filter((x) => x.storagePath !== d.storagePath))}>Remove</button>
                        </li>
                      ))}
                    </ul>
                  )}
              </div>
            );
          })}
        </div>
      )}
    </SettingsScreen>
  );
}
