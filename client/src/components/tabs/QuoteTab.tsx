import { useEffect, useRef, useState } from 'react';
import { FileText, X as XIcon, Paperclip, Upload } from 'lucide-react';
import { api, uploadFile } from '../../lib/api';
import toast from 'react-hot-toast';

interface QuoteFile {
  id: string;
  fileName: string;
  signedUrl?: string;
}

interface Quote {
  id: string;
  quoteBuilderRef?: string;
  amount?: number;
  discountPct?: number;
  status: string;
  createdAt: string;
  files?: QuoteFile[];
}

interface Props {
  leadId: string;
  leadRef: string;
  pid?: string | null;
  name?: string;
  phone?: string;
  email?: string | null;
  projectType?: string | null;
  scope?: string | null;
  location?: string | null;
  estimatedValue?: number | string | null;
  isLocked?: boolean;
}

const QUOTE_BUILDER_URL = import.meta.env.VITE_QUOTE_BUILDER_URL ?? 'https://proposals.interiorsbydex.com';

export default function QuoteTab({ leadId, leadRef, pid, name, phone, email, projectType, scope, location, estimatedValue, isLocked }: Props) {
  const [showIframe, setShowIframe] = useState(false);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loadingQuotes, setLoadingQuotes] = useState(false);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const loadQuotes = async () => {
    setLoadingQuotes(true);
    try {
      const data = await api.get<{ quotes: Quote[] }>(`/quotes/lead/${leadId}`);
      setQuotes(data.quotes);
    } catch {
      toast.error('Could not load quotes');
    } finally {
      setLoadingQuotes(false);
    }
  };

  useEffect(() => {
    void loadQuotes();
  }, [leadId]);

  const handleAttach = async (quoteId: string, files: File[]) => {
    if (files.some((file) => file.type !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf'))) {
      toast.error('Quote attachments must be PDF files');
      return;
    }
    setUploadingFor(quoteId);
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.set('file', file);
        await uploadFile(`/quotes/${quoteId}/files`, fd);
      }
      toast.success(files.length > 1 ? 'Quote documents attached' : 'Quote document attached');
      await loadQuotes();
    } catch (e: any) {
      toast.error(e.message ?? 'Could not attach file');
    } finally {
      setUploadingFor(null);
    }
  };

  // Prefill the external Quote Builder with everything the CRM already knows
  // about this lead so nothing has to be re-typed there.
  //
  // The Quote Builder distinguishes its immutable project UUID from the
  // business-readable PID. Keep the CRM project code in `pid`; an existing
  // external project is reopened with its UUID through `projectId`.
  const existingQuoteRef = quotes.find((q) => q.quoteBuilderRef)?.quoteBuilderRef;

  const prefillParams = new URLSearchParams();
  prefillParams.set('leadId', leadRef);
  if (pid) prefillParams.set('pid', pid);
  if (existingQuoteRef) prefillParams.set('projectId', existingQuoteRef);
  if (name) prefillParams.set('clientName', name);
  if (phone) prefillParams.set('phone', phone);
  if (email) prefillParams.set('email', email);
  if (projectType) prefillParams.set('projectType', projectType);
  if (scope) prefillParams.set('scope', scope);
  if (location) prefillParams.set('location', location);
  if (estimatedValue !== undefined && estimatedValue !== null && estimatedValue !== '') {
    prefillParams.set('estimatedValue', String(estimatedValue));
  }
  const iframeSrc = `${QUOTE_BUILDER_URL}?${prefillParams.toString()}`;

  const formatINR = (n: number) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);

  const STATUS_COLORS: Record<string, string> = {
    DRAFT: 'bg-gray-100 text-gray-600',
    SENT: 'bg-blue-100 text-blue-700',
    ACCEPTED: 'bg-green-100 text-green-700',
    REJECTED: 'bg-red-100 text-red-700',
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Quote Builder</h2>
          <p className="text-sm text-gray-500">{quotes.length} quote{quotes.length !== 1 ? 's' : ''} for {leadRef}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadQuotes}
            className="text-sm bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg text-gray-700 transition-colors"
          >
            Refresh
          </button>
          {!isLocked && (
            <button
              onClick={() => setShowIframe(!showIframe)}
              className="bg-brand-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-600 transition-colors"
            >
              {showIframe ? 'Hide Builder' : '+ New Quote'}
            </button>
          )}
        </div>
      </div>

      {isLocked && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-700">
          This lead is Inactive — reactivate it to create or attach quotes.
        </div>
      )}

      {!isLocked && showIframe && (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <div className="bg-gray-50 border-b border-gray-200 px-4 py-2 flex items-center justify-between">
            <span className="text-xs text-gray-500 font-mono">{iframeSrc}</span>
            <button
              onClick={() => setShowIframe(false)}
              className="text-gray-400 hover:text-gray-600 flex items-center"
            >
              <XIcon size={15} strokeWidth={2} />
            </button>
          </div>
          <iframe
            src={iframeSrc}
            title="Quote Builder"
            className="w-full"
            style={{ height: '600px' }}
            sandbox="allow-forms allow-scripts allow-same-origin allow-popups"
          />
        </div>
      )}

      {loadingQuotes ? (
        <div className="text-center py-10 text-gray-400 text-sm animate-pulse">Loading quotes…</div>
      ) : quotes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-14 text-center">
          <div className="w-12 h-12 rounded-2xl bg-stone-100 flex items-center justify-center mb-3">
            <FileText size={22} strokeWidth={1.5} className="text-stone-400" />
          </div>
          <p className="font-medium text-gray-900 mb-1">No quotes yet</p>
          <p className="text-sm text-gray-400">Open the Quote Builder above to create the first proposal for {leadRef}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {quotes.map((q) => (
            <div key={q.id} className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_COLORS[q.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {q.status}
                    </span>
                    {q.quoteBuilderRef && (
                      <span className="text-xs text-gray-400 font-mono">Ref: {q.quoteBuilderRef}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {q.amount && <span className="font-semibold text-gray-900">{formatINR(q.amount)}</span>}
                    {q.discountPct && q.discountPct > 0 && (
                      <span className="text-xs text-brand-600 bg-brand-50 px-2 py-0.5 rounded">
                        {Number(q.discountPct).toFixed(1)}% off
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-gray-400">
                  {new Date(q.createdAt).toLocaleDateString('en-IN')}
                </span>
              </div>

              {/* ── Quote document attachments (task #89) ─────────────────── */}
              <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap items-center gap-2">
                {(q.files ?? []).map((f) => (
                  <a
                    key={f.id}
                    href={f.signedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-brand-600 bg-brand-50 px-2 py-1 rounded-lg hover:bg-brand-100 transition-colors"
                  >
                    <Paperclip size={11} /> {f.fileName}
                  </a>
                ))}
                <input
                  ref={(el) => { fileInputRefs.current[q.id] = el; }}
                  type="file"
                  multiple
                  accept=".pdf,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length > 0) handleAttach(q.id, files);
                    e.target.value = '';
                  }}
                />
                {!isLocked && (
                  <button
                    onClick={() => fileInputRefs.current[q.id]?.click()}
                    disabled={uploadingFor === q.id}
                    className="flex items-center gap-1 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded-lg disabled:opacity-50 transition-colors"
                  >
                    <Upload size={11} /> {uploadingFor === q.id ? 'Uploading…' : 'Attach document'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
