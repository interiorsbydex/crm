import { useState, useEffect } from 'react';
import { Check, Mail } from 'lucide-react';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import { usePermissions } from '../lib/permissions';
import { CustomChecklistItems, itemLabel, useChecklistStatus } from './ChecklistExtras';
import { wording } from '../lib/wording';

interface DIPChecklist {
  id: string;
  leadId: string;
  welcomeMailSent: boolean;
  discountApprovalFormSent: boolean;
  npsTriggered: boolean;
  googleReviewReceived: boolean;
  cxApprovalReceived: boolean;
  internalMailThreadCompleted: boolean;
  internalMailThreadUrl: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface Props {
  leadId: string;
  stage: string;
  onComplete?: () => void;
  isLocked?: boolean;
}

// Google review is never required; whether the other two are follows Admin → Checklists.
const ITEMS = [
  { key: 'googleReviewReceived', label: 'Google review received' },
  { key: 'internalMailThreadCompleted', label: 'Internal mail trigger' },
  { key: 'cxApprovalReceived', label: 'Client mail approval' },
] as const;

type ChecklistKey = typeof ITEMS[number]['key'];

export default function DIPChecklistPanel({ leadId, stage, onComplete, isLocked: lockedByStatus }: Props) {
  // Read-only for roles without the DIP checklist permission (Admin → Permissions).
  const { can } = usePermissions();
  const isLocked = lockedByStatus || !can('DIP_CHECKLIST_EDIT');
  const [checklist, setChecklist] = useState<DIPChecklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [threadUrl, setThreadUrl] = useState('');
  const statusPath = `/leads/${leadId}/dip-checklist`;
  const { status } = useChecklistStatus(statusPath, [stage, checklist]);

  const load = async () => {
    try {
      const data = await api.get<{ checklist: DIPChecklist | null }>(`/leads/${leadId}/dip-checklist`);
      setChecklist(data.checklist);
      if (data.checklist?.internalMailThreadUrl) {
        setThreadUrl(data.checklist.internalMailThreadUrl);
      }
    } catch (e: any) {
      console.warn('[DIP] load error:', e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (stage === 'ONBOARDING_MEETING' || stage === 'DESIGN_IN_PROGRESS' || stage === 'HANDED_OVER') load();
  }, [leadId, stage]);

  const toggle = async (key: ChecklistKey, currentValue: boolean) => {
    if (isLocked) return;
    setSaving(true);
    try {
      const data = await api.patch<{ checklist: DIPChecklist; paymentProofMissing?: boolean }>(`/leads/${leadId}/dip-checklist`, {
        [key]: !currentValue,
      });
      setChecklist(data.checklist);
      if (data.paymentProofMissing) {
        toast.error('All items are ticked, but the checklist cannot complete until a payment screenshot is uploaded in the Files tab. It is mandatory and confirms the booking.', { duration: 8000 });
      } else if (data.checklist.completedAt) {
        toast.success('DIP checklist complete! Lead can now be moved to Design in Progress.');
        onComplete?.();
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const saveThreadUrl = async () => {
    if (isLocked) return;
    setSaving(true);
    try {
      const data = await api.patch<{ checklist: DIPChecklist }>(`/leads/${leadId}/dip-checklist`, {
        internalMailThreadUrl: threadUrl,
      });
      setChecklist(data.checklist);
      toast.success('Thread URL saved');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (stage !== 'ONBOARDING_MEETING' && stage !== 'DESIGN_IN_PROGRESS' && stage !== 'HANDED_OVER') return null;

  if (loading) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-5 animate-pulse">
        <div className="h-4 bg-gray-100 rounded w-40 mb-3" />
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-8 bg-gray-100 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (!checklist) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700">
        DIP checklist not yet created. It will appear once the lead enters Onboarding Meeting stage.
      </div>
    );
  }

  // Counts and what's missing come from the server, which applies Admin → Checklists.
  const required = status?.items.filter((i) => i.required) ?? [];
  const completedCount = required.filter((i) => i.met).length;
  const isRequired = (key: string) => !!status?.items.find((i) => i.key === key)?.required;
  const isComplete = !!checklist.completedAt;
  const progress = required.length ? (completedCount / required.length) * 100 : 0;
  const onlyPaymentMissing = status?.missing.length === 1 && !!status.items.find((i) => i.key === 'paymentScreenshot' && !i.met);

  return (
    <div className={`border rounded-xl p-5 ${isComplete ? 'bg-green-50 border-green-200' : 'bg-white border-gray-200'}`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-gray-900 text-sm">DIP Checklist</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {isComplete
              ? 'Required checks complete — lead can be moved to Design in Progress'
              : onlyPaymentMissing ? 'Required checks ticked — payment screenshot still required' : `${completedCount} of ${required.length} required checks complete`}
          </p>
        </div>
        {isComplete && (
          <span className="inline-flex items-center gap-1 text-xs font-medium bg-green-100 text-green-700 px-2.5 py-1 rounded-full">
            <Check size={11} strokeWidth={2.5} /> Done
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="mb-4">
        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${isComplete ? 'bg-green-500' : 'bg-brand-500'}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Checklist items */}
      <div className="space-y-2 mb-4">
        {ITEMS.map((item) => {
          const checked = checklist[item.key];
          const optional = !isRequired(item.key);
          return (
            <label
              key={item.key}
              className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors
                ${checked ? 'bg-green-50' : 'bg-gray-50 hover:bg-gray-100'}
                 ${((!optional && (stage === 'DESIGN_IN_PROGRESS' || stage === 'HANDED_OVER')) || isLocked) ? 'pointer-events-none opacity-70' : ''}`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={saving || (!optional && (stage === 'DESIGN_IN_PROGRESS' || stage === 'HANDED_OVER')) || isLocked}
                onChange={() => toggle(item.key, checked)}
                className="w-4 h-4 accent-brand-500"
              />
              <span className={`text-sm ${checked ? 'text-green-700 line-through' : 'text-gray-700'}`}>
                {itemLabel(status, item.key, item.label)}{optional ? ' (optional)' : ''}
              </span>
            </label>
          );
        })}
      </div>

      <CustomChecklistItems basePath={statusPath} status={status} disabled={saving || isLocked || stage !== 'ONBOARDING_MEETING'}
        onSaved={async () => { await load(); }} />

      {!isComplete && !onlyPaymentMissing && (status?.missing.length ?? 0) > 0 && completedCount > 0 && (
        <div className="mt-3 mb-3 text-xs text-amber-700">Still needed: {status!.missing.join(', ')}</div>
      )}

      {!isComplete && onlyPaymentMissing && (
        <div data-testid="dip-payment-proof-warning" className="mb-3 text-xs text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2">
          All items are ticked, but this checklist is <b>not complete</b> until a payment screenshot is uploaded in the Files tab. Payment proof is mandatory and confirms the booking. After uploading, reload this page.
        </div>
      )}

      {!lockedByStatus && isLocked && (
        <div className="mb-3 text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">
          Your role can view this checklist but not change it (Admin → Permissions).
        </div>
      )}
      {lockedByStatus && (
        <div className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Lead is Inactive — reactivate the lead to update the checklist.
        </div>
      )}

      {/* Internal mail thread URL */}
      {stage !== 'DESIGN_IN_PROGRESS' && stage !== 'HANDED_OVER' && (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            {wording('dip.threadUrl', 'Internal Mail Thread URL')} (optional)
          </label>
          <div className="flex gap-2">
            <input
              type="url"
              value={threadUrl}
              onChange={(e) => setThreadUrl(e.target.value)}
              placeholder="https://mail.google.com/…"
              disabled={isLocked}
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:opacity-50"
            />
            <button
              onClick={saveThreadUrl}
              disabled={saving || !threadUrl || isLocked}
              className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg text-sm disabled:opacity-50 transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {checklist.internalMailThreadUrl && (
        <a
          href={checklist.internalMailThreadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex items-center gap-1.5 text-xs text-brand-600 hover:underline truncate"
        >
          <Mail size={12} strokeWidth={1.8} /> View internal thread →
        </a>
      )}
    </div>
  );
}
