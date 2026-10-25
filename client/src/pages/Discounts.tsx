import { useEffect, useState, useCallback } from 'react';
import { Tag } from 'lucide-react';
import { api } from '../lib/api';
import { getStoredUser } from '../lib/auth';
import toast from 'react-hot-toast';

interface Lead { id: string; leadId: string; name: string; }
interface AppUser { id: string; name: string; role: string; }
interface DiscountRequest {
  id: string; status: string;
  originalAmount: number; amount: number; discountPct: number;
  reason: string; reviewerComment?: string | null;
  woodworkValueExGst?: number | null; totalValueExGst?: number | null;
  /// Legacy link, superseded by the file attachment below (task #89).
  quoteLink?: string | null;
  quoteFileName?: string | null;
  quoteFileUrl?: string;
  forwardedToRole?: string | null;
  createdAt: string; reviewedAt?: string | null;
  lead: Lead;
  requestedBy: AppUser;
  reviewedBy?: AppUser | null;
  forwardedBy?: AppUser | null;
}

function fmtVal(v: number | null | undefined) {
  if (!v) return '—';
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
  return `₹${v.toLocaleString('en-IN')}`;
}

function relTime(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function discountColor(pct: number) {
  if (pct <= 10) return 'bg-green-100 text-green-700';
  if (pct <= 15) return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-700';
}

function KpiCard({ label, value, sub, color }: { label: string; value: string | number; sub: string; color?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-3xl font-bold mt-1 ${color ?? 'text-gray-900'}`}>{value}</p>
      <p className="text-xs text-gray-400 mt-0.5">{sub}</p>
    </div>
  );
}

export default function Discounts() {
  const currentUser = getStoredUser();
  const userRole = currentUser?.role ?? '';

  const [pending, setPending] = useState<DiscountRequest[]>([]);
  const [approved, setApproved] = useState<DiscountRequest[]>([]);
  const [rejected, setRejected] = useState<DiscountRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending');

  const [reviewTarget, setReviewTarget] = useState<DiscountRequest | null>(null);
  const [reviewComment, setReviewComment] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [forwarding, setForwarding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, a, r] = await Promise.all([
        api.get<{ requests: DiscountRequest[] }>('/discount-requests?status=PENDING'),
        api.get<{ requests: DiscountRequest[] }>('/discount-requests?status=APPROVED'),
        api.get<{ requests: DiscountRequest[] }>('/discount-requests?status=REJECTED'),
      ]);
      setPending(p.requests);
      setApproved(a.requests);
      setRejected(r.requests);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const pendingValue = pending.reduce((sum, r) => sum + (r.originalAmount - r.amount), 0);

  const canApproveDirectly = (req: DiscountRequest) => {
    if (userRole === 'BRANCH_HEAD') return true;
    if (userRole === 'BL' && req.discountPct <= 15) return true;
    return false;
  };
  const mustForward = (req: DiscountRequest) => userRole === 'BL' && req.discountPct > 15;

  const handleApprove = async () => {
    if (!reviewTarget) return;
    setReviewing(true);
    try {
      await api.patch(`/discount-requests/${reviewTarget.id}`, { status: 'APPROVED', reviewerComment: reviewComment.trim() || undefined });
      toast.success('Discount approved');
      setReviewTarget(null);
      await load();
    } catch (e: any) { toast.error(e.message); }
    finally { setReviewing(false); }
  };

  const handleReject = async () => {
    if (!reviewTarget) return;
    if (!reviewComment.trim()) { toast.error('Comment is required when rejecting'); return; }
    setReviewing(true);
    try {
      await api.patch(`/discount-requests/${reviewTarget.id}`, { status: 'REJECTED', reviewerComment: reviewComment });
      toast.success('Discount rejected');
      setReviewTarget(null);
      await load();
    } catch (e: any) { toast.error(e.message); }
    finally { setReviewing(false); }
  };

  const handleForward = async () => {
    if (!reviewTarget) return;
    setForwarding(true);
    try {
      await api.patch(`/discount-requests/${reviewTarget.id}/forward`, {});
      toast.success('Forwarded to Branch Head');
      setReviewTarget(null);
      await load();
    } catch (e: any) { toast.error(e.message); }
    finally { setForwarding(false); }
  };

  const openReview = (req: DiscountRequest) => { setReviewComment(''); setReviewTarget(req); };

  const tabData: Record<string, DiscountRequest[]> = { pending, approved, rejected };
  const displayed = tabData[tab] ?? [];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Review modal */}
      {reviewTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h3 className="font-semibold text-gray-900 mb-0.5">
              Review discount — {Number(reviewTarget.discountPct).toFixed(1)}%
            </h3>
            <p className="text-xs text-gray-400 mb-4">
              {fmtVal(reviewTarget.originalAmount - reviewTarget.amount)} off {fmtVal(reviewTarget.originalAmount)}. Reason: {reviewTarget.reason}
            </p>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Your decision rationale</label>
              <textarea rows={3} value={reviewComment} onChange={e => setReviewComment(e.target.value)}
                placeholder="Your decision rationale..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none" />
              <p className="text-xs text-gray-400 mt-1">Mandatory when rejecting</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setReviewTarget(null)}
                className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button onClick={handleReject} disabled={reviewing}
                className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg text-sm hover:bg-gray-50 font-medium disabled:opacity-50">
                {reviewing ? '…' : 'Reject'}
              </button>
              {mustForward(reviewTarget) ? (
                <button onClick={handleForward} disabled={forwarding}
                  className="flex-1 bg-amber-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-50">
                  {forwarding ? 'Forwarding…' : 'Forward to Branch Head'}
                </button>
              ) : canApproveDirectly(reviewTarget) ? (
                <button onClick={handleApprove} disabled={reviewing}
                  className="flex-1 bg-brand-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50">
                  {reviewing ? '…' : 'Approve'}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-lg font-semibold text-gray-900">Discounts</h1>
        <p className="text-xs text-gray-400 mt-0.5">Discount request queue for your scope</p>
      </div>

      <div className="px-6 py-4 space-y-4">
        {/* KPI bar */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard label="Pending" value={pending.length} sub="Awaiting a decision" color="text-amber-600" />
          <KpiCard label="Pending Value" value={fmtVal(pendingValue)} sub="Discount at stake" color="text-red-500" />
          <KpiCard label="Approved" value={approved.length} sub="Decisions granted" color="text-green-600" />
          <KpiCard label="Rejected" value={rejected.length} sub="Decisions declined" />
        </div>

        {/* Approval authority tier strip */}
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-3 flex items-center gap-6 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">⊙ Approval Authority</span>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-400" />
            <span className="text-xs text-gray-600">≤10% <span className="text-gray-400">Designer</span></span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            <span className="text-xs text-gray-600">10–15% <span className="text-gray-400">Business Lead</span></span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red-400" />
            <span className="text-xs text-gray-600">&gt;15% <span className="text-gray-400">Branch Head</span></span>
          </div>
          <span className="text-xs text-gray-300 ml-auto hidden lg:block">Enforced server-side</span>
        </div>

        {/* Tabs + list */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex border-b border-gray-100">
            {([
              ['pending', `Pending (${pending.length})`],
              ['approved', `Approved (${approved.length})`],
              ['rejected', `Rejected (${rejected.length})`],
            ] as const).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                  tab === id ? 'border-brand-500 text-brand-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="py-16 text-center text-gray-400 text-sm animate-pulse">Loading…</div>
          ) : displayed.length === 0 ? (
            <div className="py-16 text-center">
              <div className="w-12 h-12 rounded-2xl bg-stone-100 flex items-center justify-center mx-auto mb-2">
                <Tag size={22} strokeWidth={1.5} className="text-stone-400" />
              </div>
              <p className="text-gray-500 text-sm">No {tab} requests</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {displayed.map(req => {
                const pct = Number(req.discountPct);
                return (
                  <div key={req.id} className="px-5 py-4 flex items-start gap-4">
                    <div className="flex-1 min-w-0 space-y-1.5">
                      {/* Row 1: client + lead id + discount% + escalation */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-gray-900 text-sm">{req.lead.name}</span>
                        <span className="text-xs text-brand-500 font-mono bg-brand-50 px-1.5 py-0.5 rounded">{req.lead.leadId}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${discountColor(pct)}`}>
                          {pct.toFixed(1)}% off
                        </span>
                        {req.forwardedToRole === 'BRANCH_HEAD' && (
                          <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">
                            Branch Head
                          </span>
                        )}
                      </div>

                      {/* Row 2: amounts + requester */}
                      <div className="flex items-center gap-2 flex-wrap text-xs text-gray-500">
                        <span>{fmtVal(req.originalAmount - req.amount)} off {fmtVal(req.originalAmount)}</span>
                        <span className="text-gray-300">·</span>
                        <span className="flex items-center gap-1">
                          <span className="w-4 h-4 rounded-full bg-brand-100 text-brand-700 text-xs font-bold flex items-center justify-center">
                            {req.requestedBy.name.charAt(0)}
                          </span>
                          Requested by {req.requestedBy.name}
                        </span>
                        <span className="text-gray-300">·</span>
                        <span>{relTime(req.createdAt)}</span>
                      </div>

                      {/* Row 3: ex-GST values + quote attachment */}
                      {(req.woodworkValueExGst != null || req.totalValueExGst != null || req.quoteFileUrl || req.quoteLink) && (
                        <div className="flex items-center gap-3 flex-wrap text-xs text-gray-500">
                          {req.woodworkValueExGst != null && (
                            <span>Woodwork ex-GST: <span className="text-gray-700 font-medium">{fmtVal(Number(req.woodworkValueExGst))}</span></span>
                          )}
                          {req.totalValueExGst != null && (
                            <span>Total ex-GST: <span className="text-gray-700 font-medium">{fmtVal(Number(req.totalValueExGst))}</span></span>
                          )}
                          {req.quoteFileUrl ? (
                            <a href={req.quoteFileUrl} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline">
                              {req.quoteFileName ?? 'Quote attachment'}
                            </a>
                          ) : req.quoteLink ? (
                            <a href={req.quoteLink} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline">
                              View quote (legacy link)
                            </a>
                          ) : null}
                        </div>
                      )}

                      {/* Row 4: reason */}
                      <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-600">
                        {req.reason}
                      </div>

                      {/* Reviewer comment (if resolved) */}
                      {req.reviewerComment && (
                        <p className="text-xs text-gray-400 italic">
                          {req.reviewedBy?.name ?? 'Reviewer'}: "{req.reviewerComment}"
                        </p>
                      )}
                    </div>

                    {tab === 'pending' && (
                      <button onClick={() => openReview(req)}
                        className="shrink-0 border border-brand-300 text-brand-600 px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-brand-50 transition-colors whitespace-nowrap">
                        Review →
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
