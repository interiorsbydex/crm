import { useEffect, useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, uploadFile } from '../lib/api';

interface ExtraFile { filename: string; size: number }

/**
 * "Attach files" on a mail's review screen. Files wait on the server for this
 * person and lead (server: lib/draftExtras.ts) and go out with the next mail
 * they send for the lead; closing the screen without sending drops them.
 * Standard documents (welcome documents, checklist documents) are listed by the
 * screen itself and are not touched here.
 */
export default function MailAttachments({ leadId }: { leadId: string }) {
  const [files, setFiles] = useState<ExtraFile[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Start clean (a screen left open earlier could have left files behind) and drop them again when the screen closes.
    api.delete(`/email/extras/${leadId}`).catch(() => {});
    return () => { api.delete(`/email/extras/${leadId}`).catch(() => {}); };
  }, [leadId]);

  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(list)) {
        const form = new FormData();
        form.append('file', file);
        setFiles((await uploadFile<{ files: ExtraFile[] }>(`/email/extras/${leadId}`, form)).files);
      }
    } catch (e: any) {
      toast.error(e.message ?? 'Could not attach the file');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const remove = async (filename: string) => {
    try {
      setFiles((await api.delete<{ files: ExtraFile[] }>(`/email/extras/${leadId}?filename=${encodeURIComponent(filename)}`)).files);
    } catch (e: any) { toast.error(e.message ?? 'Could not remove the file'); }
  };

  const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  return (
    <div className="text-xs text-gray-600" data-testid="mail-attachments">
      <div className="flex items-center gap-2">
        <span className="font-semibold">Attach files to this mail</span>
        <label className={`inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 font-medium text-gray-700 hover:bg-gray-50 ${busy ? 'opacity-50' : 'cursor-pointer'}`}>
          <Paperclip size={12} /> {busy ? 'Attaching…' : 'Add file'}
          <input ref={input} type="file" multiple className="hidden" accept=".pdf,.docx,.png,.jpg,.jpeg" disabled={busy}
            onChange={(e) => { void add(e.target.files); }} aria-label="Attach files to this mail" />
        </label>
      </div>
      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((f) => (
            <li key={f.filename} className="flex items-center justify-between rounded border border-gray-200 px-2 py-1">
              <span className="truncate">{f.filename} <span className="text-gray-400">({kb(f.size)})</span></span>
              <button type="button" onClick={() => { void remove(f.filename); }} className="ml-2 text-gray-400 hover:text-red-600" aria-label={`Remove ${f.filename}`}><X size={13} /></button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-[11px] text-gray-400">PDF, Word, PNG or JPG. Up to 4 MB each, 15 MB in all.</p>
    </div>
  );
}
