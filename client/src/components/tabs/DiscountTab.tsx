import { useEffect, useState } from 'react';
import { Check, X, Tag, AlertTriangle, Info, Paperclip } from 'lucide-react';
import { api, uploadFile } from '../../lib/api';
import toast from 'react-hot-toast';
import ConfirmDialog from '../ui/ConfirmDialog';
import { crmSettings, useCrmSettings } from '../../lib/crmSettings';

interface DiscountRequest {
  id: string;
  originalAmount: number;
  amount: number;
  discountPct: number;
  reason: string;
  woodworkValueExGst?: number | null;
  totalValueExGst?: number | null;
  /// Legacy link, superseded by the file attachment(s) below (task #89).
  quoteLink?: string | null;
  /// Legacy single-file attachment, superseded by `files` (multiple attachments).
  quoteFileName?: string | null;
  quoteFileUrl?: string;
  files?: { id: string; fileName: string; fileUrl?: string }[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  approverRole?: string | null;  // 'SELF' | 'BL' | 'BRANCH_HEAD'
  isSpecialCase?: boolean;
  reviewerComment?: string;
  createdAt: string;
  requestedBy: { id: string; name: string; role: string };
  reviewedBy?: { id: string; name: string } | null;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING:  'bg-amber-100 text-amber-700',
  APPROVED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
};

// ── Approval threshold helper (limits from Admin → CRM Settings; the server ──
// applies the same limits when the request is raised) ──────────────────────
interface ApprovalInfo {
  label: string;
  detail: string;
  color: 'green' | 'amber' | 'orange' | 'red';
  isSpecialCase: boolean;
  approverRole: 'SELF' | 'BL' | 'BRANCH_HEAD';
}

const fmtLakh = (v: number) => (v >= 100_000 ? `₹${+(v / 100_000).toFixed(2)}L` : `₹${v.toLocaleString('en-IN')}`);

function getApprovalInfo(pct: number, woodworkValue: number): ApprovalInfo {
  const { selfApproveUpToPct: self, blApproveUpToPct: bl, branchHeadUpToPct: bh, woodworkSpecialCaseBelow } = crmSettings().discount;
  const postDiscountWoodwork = woodworkValue * (1 - pct / 100);
  const woodworkBelowThreshold = postDiscountWoodwork < woodworkSpecialCaseBelow;

  if (woodworkBelowThreshold || pct > bh) {
    return {
      label: 'Special Case — Branch Head',
      detail: woodworkBelowThreshold
        ? `Post-discount woodwork (₹${Math.round(postDiscountWoodwork).toLocaleString('en-IN')}) falls below ${fmtLakh(woodworkSpecialCaseBelow)} threshold → Branch Head required`
        : `Discount above ${bh}% → Special case requiring Branch Head approval`,
      color: 'red',
      isSpecialCase: true,
      approverRole: 'BRANCH_HEAD',
    };
  }
  if (pct > bl) {
    return {
      label: 'Branch Head approval required',
      detail: `Above ${bl}% and up to ${bh}% → goes directly to Branch Head (no BL step)`,
      color: 'orange',
      isSpecialCase: false,
      approverRole: 'BRANCH_HEAD',
    };
  }
  if (pct > self) {
    return {
      label: 'BL approval required',
      detail: `Above ${self}% and up to ${bl}% → your Business Lead will review`,
      color: 'amber',
      isSpecialCase: false,
      approverRole: 'BL',
    };
  }
  return {
    label: `Self-approved (≤ ${self}%)`,
    detail: `Discounts up to ${self}% are auto-approved — no review needed`,
    color: 'green',
    isSpecialCase: false,
    approverRole: 'SELF',
  };
}

const APPROVAL_COLOR: Record<string, string> = {
  green:  'bg-green-50 border-green-200 text-green-800',
  amber:  'bg-amber-50 border-amber-200 text-amber-800',
  orange: 'bg-orange-50 border-orange-200 text-orange-800',
  red:    'bg-red-50 border-red-200 text-red-800',
};

interface Props { leadId: string; isLocked?: boolean }

function getStoredRole(): string | null {
  try {
    const u = localStorage.getItem('crm_user');
    return u ? JSON.parse(u).role : null;
  } catch { return null; }
}

const formatINR = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);

export default function DiscountTab({ leadId, isLocked }: Props) {
  const limits = useCrmSettings().discount;
  const [requests, setRequests] = useState<DiscountRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirm, setConfirm] = useState<{ open: boolean }>({ open: false });
  const [form, setForm] = useState({ woodworkValue: '', totalValue: '', discountPct: '', reason: '' });
  const [quoteFiles, setQuoteFiles] = useState<File[]>([]);

  const userRole = getStoredRole();
  const isBL = userRole === 'BL' || userRole === 'BRANCH_HEAD';
  const [reviewModal, setReviewModal] = useState<{ id: string; action: 'APPROVED' | 'REJECTED' } | null>(null);
  const [rejectComment, setRejectComment] = useState('');
  const [reviewing, setReviewing] = useState(false);

  const loadRequests = async () => {
    try {
      const data = await api.get<{ requests: DiscountRequest[] }>(`/discount-requests?leadId=${leadId}`);
      setRequests(data.requests);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadRequests(); }, [leadId]);

  // ── Computed approval preview ─────────────────────────────────────────────
  const pctNum = Number(form.discountPct);
  const woodworkNum = Number(form.woodworkValue);
  const approvalInfo = form.discountPct && form.woodworkValue && pctNum > 0 && woodworkNum > 0
    ? getApprovalInfo(pctNum, woodworkNum)
    : null;

  const discountedTotal = form.totalValue && pctNum > 0
    ? Number(form.totalValue) * (1 - pctNum / 100)
    : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.woodworkValue || !form.totalValue || !form.discountPct || !form.reason) {
      toast.error('Woodwork value, total project value, discount % and reason are required');
      return;
    }
    if (isNaN(pctNum) || pctNum <= 0 || pctNum >= 100) {
      toast.error('Discount % must be between 0 and 100');
      return;
    }
    setConfirm({ open: true });
  };

  const doSubmit = async () => {
    setConfirm({ open: false });
    setSubmitting(true);
    try {
      const total = Number(form.totalValue);
      const fd = new FormData();
      fd.set('originalAmount', String(total));
      fd.set('amount', String(+(total * (1 - pctNum / 100)).toFixed(2)));
      fd.set('discountPct', String(pctNum));
      fd.set('reason', form.reason);
      fd.set('woodworkValueExGst', form.woodworkValue);
      fd.set('totalValueExGst', form.totalValue);
      for (const f of quoteFiles) fd.append('quoteFiles', f);
      await uploadFile(`/leads/${leadId}/discount-request`, fd);

      const info = getApprovalInfo(pctNum, Number(form.woodworkValue));
      if (info.approverRole === 'SELF') {
        toast.success(`Discount auto-approved (≤ ${crmSettings().discount.selfApproveUpToPct}%) ✓`);
      } else {
        toast.success(`Request submitted — sent to ${info.approverRole === 'BL' ? 'your BL' : 'Branch Head'} for approval`);
      }
      setForm({ woodworkValue: '', totalValue: '', discountPct: '', reason: '' });
      setQuoteFiles([]);
      setShowForm(false);
      await loadRequests();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewModal) return;
    if (reviewModal.action === 'REJECTED' && !rejectComment.trim()) {
      toast.error('Please add a comment explaining the rejection');
      return;
    }
    if (reviewModal.action === 'APPROVED' && crmSettings().discount.requireApprovalComment && !rejectComment.trim()) {
      toast.error('Please add a comment for this approval');
      return;
    }
    setReviewing(true);
    try {
      await api.patch(`/discount-requests/${reviewModal.id}`, {
        status: reviewModal.action,
        reviewerComment: rejectComment || undefined,
      });
      toast.success(reviewModal.action === 'APPROVED' ? 'Request approved ✓' : 'Request rejected');
      setReviewModal(null);
      setRejectComment('');
      await loadRequests();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setReviewing(false);
    }
  };

  const hasPending = requests.some((r) => r.status === 'PENDING');

  // Confirm dialog message
  const confirmMessage = approvalInfo
    ? `Request ${pctNum.toFixed(1)}% discount — ${approvalInfo.label}.`
    : `Request ${pctNum.toFixed(1)}% discount.`;

  return (
    <div className="space-y-4">
      <ConfirmDialog
        open={confirm.open}
        title="Submit Discount Request?"
        message={confirmMessage}
        confirmLabel="Submit"
        onConfirm={doSubmit}
        onCancel={() => setConfirm({ open: false })}
      />

      {/* BL / BH Review Modal */}
      {reviewModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h3 className="font-semibold text-gray-900 mb-4">
              <span className="flex items-center gap-2">
                {reviewModal.action === 'APPROVED' ? <Check size={16} strokeWidth={2.5} /> : <X size={16} strokeWidth={2.5} />}
                {reviewModal.action === 'APPROVED' ? 'Approve Discount Request' : 'Reject Discount Request'}
              </span>
            </h3>
            <form onSubmit={handleReview} className="space-y-4">
              {reviewModal.action === 'REJECTED' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason for rejection <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    rows={3}
                    value={rejectComment}
                    onChange={(e) => setRejectComment(e.target.value)}
                    required
                    placeholder="e.g. 8% too high, max 5%"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
              )}
              {reviewModal.action === 'APPROVED' && (
                <>
                  <p className="text-sm text-gray-500">
                    Approving this discount will notify the designer and update the request status.
                  </p>
                  <textarea rows={2} value={rejectComment} onChange={(e) => setRejectComment(e.target.value)}
                    required={crmSettings().discount.requireApprovalComment} aria-label="Approval comment"
                    placeholder={crmSettings().discount.requireApprovalComment ? 'Comment (required)' : 'Comment (optional)'}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400" />
                </>
              )}
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setReviewModal(null); setRejectComment(''); }}
                  className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={reviewing}
                  className={`flex-1 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors ${
                    reviewModal.action === 'APPROVED' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'
                  }`}
                >
                  {reviewing ? 'Saving…' : reviewModal.action === 'APPROVED' ? 'Approve' : 'Reject'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Discount Requests</h2>
          <p className="text-sm text-gray-500">
            {requests.length} request{requests.length !== 1 ? 's' : ''} ·{' '}
            {requests.filter((r) => r.status === 'PENDING').length} pending
          </p>
        </div>
        {!isBL && !isLocked && (
          <button
            onClick={() => setShowForm(!showForm)}
            disabled={hasPending}
            title={hasPending ? 'A pending request already exists' : undefined}
            className="bg-brand-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-40 transition-colors"
          >
            {showForm ? 'Cancel' : '+ Request Discount'}
          </button>
        )}
      </div>

      {isLocked && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-700">
          This lead is Inactive — reactivate it to request discounts.
        </div>
      )}

      {hasPending && !showForm && !isBL && !isLocked && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-700">
          A discount request is currently pending review.
        </div>
      )}

      {/* ── Discount approval rules summary ────────────────────────────────── */}
      {!isBL && !showForm && !isLocked && (
        <div className="bg-stone-50 border border-stone-200 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2 text-xs font-semibold text-stone-600 uppercase tracking-wider">
            <Info size={13} /> Approval rules
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs text-stone-600">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
              <span><span className="font-semibold">0–{limits.selfApproveUpToPct}%</span> — Auto-approved (no review)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
              <span><span className="font-semibold">Up to {limits.blApproveUpToPct}%</span> — BL approval required</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
              <span><span className="font-semibold">Up to {limits.branchHeadUpToPct}%</span> — Branch Head required</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
              <span><span className="font-semibold">&gt;{limits.branchHeadUpToPct}% or woodwork &lt;{fmtLakh(limits.woodworkSpecialCaseBelow)}</span> — Special case, Branch Head</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Request form ───────────────────────────────────────────────────── */}
      {!isBL && !isLocked && showForm && (
        <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <h3 className="font-medium text-gray-900">New Discount Request</h3>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Woodwork Value ex-GST (₹) <span className="text-red-500">*</span>
              </label>
              <input
                type="number" min="0" value={form.woodworkValue}
                onChange={(e) => setForm({ ...form, woodworkValue: e.target.value })}
                required placeholder="350000"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Total Project Value ex-GST (₹) <span className="text-red-500">*</span>
              </label>
              <input
                type="number" min="0" value={form.totalValue}
                onChange={(e) => setForm({ ...form, totalValue: e.target.value })}
                required placeholder="500000"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Proposed Discount % <span className="text-red-500">*</span>
              </label>
              <input
                type="number" min="0.1" max="99.9" step="0.1" value={form.discountPct}
                onChange={(e) => setForm({ ...form, discountPct: e.target.value })}
                required placeholder="10"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Quote Attachment(s)
              </label>
              <input
                type="file" multiple accept=".pdf,application/pdf"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.some((file) => file.type !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf'))) {
                    toast.error('Quote attachments must be PDF files');
                    e.target.value = '';
                    return;
                  }
                  setQuoteFiles((prev) => [...prev, ...files]);
                }}
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-600 file:mr-3 file:py-1 file:px-2 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-brand-50 file:text-brand-700 hover:file:bg-brand-100 focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
              {quoteFiles.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {quoteFiles.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center justify-between text-xs text-gray-500">
                      <span className="truncate">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => setQuoteFiles((prev) => prev.filter((_, idx) => idx !== i))}
                        className="text-red-500 hover:text-red-700 ml-2 shrink-0"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Live discount preview */}
          {discountedTotal != null && pctNum > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 flex items-center gap-2">
              <span className="font-semibold text-amber-700">{pctNum.toFixed(1)}% discount</span>
              <span className="text-amber-600 text-sm">
                (₹{(Number(form.totalValue) * pctNum / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })} off → ₹{discountedTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })})
              </span>
            </div>
          )}

          {/* Live approval routing preview */}
          {approvalInfo && (
            <div className={`border rounded-lg px-4 py-3 flex items-start gap-2.5 ${APPROVAL_COLOR[approvalInfo.color]}`}>
              {approvalInfo.isSpecialCase
                ? <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                : <Info size={15} className="shrink-0 mt-0.5" />}
              <div>
                <p className="text-xs font-semibold">{approvalInfo.label}</p>
                <p className="text-xs mt-0.5 opacity-80">{approvalInfo.detail}</p>
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Reason <span className="text-red-500">*</span>
            </label>
            <textarea
              rows={3} value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              required placeholder="Why is this discount needed?"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
          </div>

          <button
            type="submit" disabled={submitting}
            className="w-full bg-brand-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Submitting…' : approvalInfo?.approverRole === 'SELF'
              ? 'Submit (auto-approved)'
              : approvalInfo?.approverRole === 'BL'
              ? 'Submit for BL Approval'
              : 'Submit for Branch Head Approval'}
          </button>
        </form>
      )}

      {/* ── Request list ───────────────────────────────────────────────────── */}
      {loading ? (
        <div className="text-center py-10 text-gray-400 text-sm animate-pulse">Loading requests…</div>
      ) : requests.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-14 text-center">
          <div className="w-12 h-12 rounded-2xl bg-stone-100 flex items-center justify-center mb-3">
            <Tag size={22} strokeWidth={1.5} className="text-stone-400" />
          </div>
          <p className="font-medium text-gray-900 mb-1">No discount requests</p>
          <p className="text-sm text-gray-400">
            {isBL ? 'No discount requests raised for this lead yet.' : 'Use the button above to raise a discount request.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => (
            <div key={req.id} className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_COLORS[req.status]}`}>
                      {req.status}
                    </span>
                    {req.isSpecialCase && (
                      <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200">
                        <AlertTriangle size={10} />
                        Special Case
                      </span>
                    )}
                    {req.approverRole === 'SELF' && req.status === 'APPROVED' && (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                        Auto-approved
                      </span>
                    )}
                    <span className="text-base font-bold text-brand-600">{Number(req.discountPct).toFixed(1)}%</span>
                    <span className="text-xs text-gray-400">discount</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-gray-400 line-through">{formatINR(req.originalAmount)}</span>
                    <span className="text-gray-900 font-medium">{formatINR(req.amount)}</span>
                  </div>
                </div>
                <div className="text-right text-xs text-gray-400 shrink-0">
                  <p>By {req.requestedBy.name}</p>
                  <p>{new Date(req.createdAt).toLocaleDateString('en-IN')}</p>
                  {req.approverRole && req.approverRole !== 'SELF' && (
                    <p className="text-stone-400 mt-0.5">
                      → {req.approverRole === 'BL' ? 'BL' : 'Branch Head'}
                    </p>
                  )}
                </div>
              </div>

              {(req.woodworkValueExGst != null || req.totalValueExGst != null || (req.files && req.files.length > 0) || req.quoteFileUrl || req.quoteLink) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 mb-2">
                  {req.woodworkValueExGst != null && (
                    <span>
                      Woodwork ex-GST:{' '}
                      <span className="text-gray-700 font-medium">{formatINR(Number(req.woodworkValueExGst))}</span>
                    </span>
                  )}
                  {req.totalValueExGst != null && (
                    <span>
                      Total ex-GST:{' '}
                      <span className="text-gray-700 font-medium">{formatINR(Number(req.totalValueExGst))}</span>
                    </span>
                  )}
                  {req.woodworkValueExGst != null && req.discountPct != null && (
                    <span>
                      Post-discount woodwork:{' '}
                      <span className={`font-medium ${
                        Number(req.woodworkValueExGst) * (1 - Number(req.discountPct) / 100) < 500000
                          ? 'text-red-600'
                          : 'text-gray-700'
                      }`}>
                        {formatINR(Number(req.woodworkValueExGst) * (1 - Number(req.discountPct) / 100))}
                      </span>
                    </span>
                  )}
                  {req.files && req.files.length > 0 ? (
                    req.files.map((f) => (
                      <a key={f.id} href={f.fileUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-brand-600 underline">
                        <Paperclip size={11} /> {f.fileName}
                      </a>
                    ))
                  ) : req.quoteFileUrl ? (
                    <a href={req.quoteFileUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-brand-600 underline">
                      <Paperclip size={11} /> {req.quoteFileName ?? 'Quote attachment'}
                    </a>
                  ) : req.quoteLink ? (
                    <a href={req.quoteLink} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline">
                      View quote (legacy link)
                    </a>
                  ) : null}
                </div>
              )}

              <p className="text-sm text-gray-600 mb-2">{req.reason}</p>

              {/* BL / BH action buttons on PENDING requests */}
              {isBL && req.status === 'PENDING' && (
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => setReviewModal({ id: req.id, action: 'APPROVED' })}
                    className="flex-1 flex items-center justify-center gap-1 text-xs bg-green-50 text-green-700 border border-green-200 px-3 py-1.5 rounded-lg hover:bg-green-100 font-medium transition-colors"
                  >
                    <Check size={12} strokeWidth={2.5} /> Approve
                  </button>
                  <button
                    onClick={() => { setReviewModal({ id: req.id, action: 'REJECTED' }); setRejectComment(''); }}
                    className="flex-1 flex items-center justify-center gap-1 text-xs bg-red-50 text-red-700 border border-red-200 px-3 py-1.5 rounded-lg hover:bg-red-100 font-medium transition-colors"
                  >
                    <X size={12} strokeWidth={2.5} /> Reject
                  </button>
                </div>
              )}

              {req.reviewedBy && (
                <div className={`rounded-lg px-3 py-2 text-xs mt-2 ${req.status === 'APPROVED' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                  <span className="font-medium">{req.reviewedBy.name}</span>
                  {req.status === 'REJECTED' && req.reviewerComment && <span className="ml-1">— {req.reviewerComment}</span>}
                  {req.status === 'APPROVED' && <span className="ml-1">
                    {req.reviewerComment?.startsWith('Auto-approved: discount ≤') ? 'auto-approved this request' : 'approved this request'}
                  </span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
