import { useState } from 'react';
import { Star, AlertTriangle } from 'lucide-react';
import { useLenientLaunch } from '../lib/flags';

// Task #114 — shown as a confirmation step on every stage move (from the
// lead-detail stage dropdown and the Pipeline kanban drag-drop) to capture
// an up-to-date intent rating and project value before the move commits.

interface Props {
  leadName: string;
  targetStageLabel: string;
  initialRating: number | null | undefined;
  initialValue: number | string | null | undefined;
  saving: boolean;
  error: string | null;
  /** True when this move fires the automatic sign-off NPS survey email (DESIGN_IN_PROGRESS/HANDED_OVER) — shows the mandatory checkbox. */
  triggersNpsSurvey?: boolean;
  /** Fix D — True when this move targets PROPOSAL_READY — shows an info note that a draft notification will be created. */
  triggersProposalEmail?: boolean;
  /** The move was blocked by missing items and this user may push it forward with a reason (Admin → Permissions). */
  canOverride?: boolean;
  onCancel: () => void;
  /** In lenient launch rating may be 0 and value null — the user skipped them. */
  onConfirm: (rating: number, value: number | null, reason: string, sendNpsSurvey: boolean, overrideReason?: string) => void;
}

export default function StageCaptureModal({
  leadName, targetStageLabel, initialRating, initialValue, saving, error, triggersNpsSurvey, triggersProposalEmail, canOverride, onCancel, onConfirm,
}: Props) {
  const [overrideReason, setOverrideReason] = useState('');
  const [rating, setRating] = useState(initialRating || 0);
  const [value, setValue] = useState(initialValue != null ? String(initialValue) : '');
  const [reason, setReason] = useState('');
  const [sendNpsSurvey, setSendNpsSurvey] = useState(true);

  const lenient = useLenientLaunch();
  const parsedValue = parseFloat(value);
  const valueOk = value.trim() !== '' && !isNaN(parsedValue) && parsedValue >= 0;
  // Lenient launch: rating and value may be skipped, but a typed value must be valid.
  const canSubmit = lenient ? (value.trim() === '' || valueOk) : (rating > 0 && valueOk);

  return (
    <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-3xl shadow-warm-lg w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-stone-900 mb-1 tracking-tight">Confirm move to {targetStageLabel}</h3>
        <p className="text-xs text-stone-400 mb-4">
          {leadName} — {lenient ? 'update intent rating and project value if you have them (optional).' : 'confirm intent rating and project value before completing this move.'}
        </p>

        <div className="mb-4">
          <label className="block text-sm font-semibold text-stone-700 mb-1.5">Intent Rating</label>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" onClick={() => setRating(n)} className="p-0.5" aria-label={`${n} star`}>
                <Star
                  size={22}
                  strokeWidth={1.8}
                  className={n <= rating ? 'fill-amber-400 text-amber-400' : 'text-stone-300'}
                />
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-semibold text-stone-700 mb-1.5">Project Value (₹)</label>
          <input
            type="number"
            min="0"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="1500000"
            className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
            style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
          />
        </div>

        <div className="mb-4">
          <label className="block text-sm font-semibold text-stone-700 mb-1.5">
            Reason for rating change <span className="text-stone-400 font-normal">(optional)</span>
          </label>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Required only if this overrides the system-computed rating"
            className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
            style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
          />
        </div>

        {triggersNpsSurvey && (
          <label className="flex items-center gap-2 text-sm text-stone-700 mb-4">
            <input type="checkbox" checked={sendNpsSurvey} onChange={(e) => setSendNpsSurvey(e.target.checked)}
              className="rounded border-stone-300 text-brand-500 focus:ring-brand-400" />
            Notify client via email
          </label>
        )}

        {/* Fix D — informational note when moving to Proposal Ready */}
        {triggersProposalEmail && (
          <div className="flex items-start gap-2 text-sm text-stone-600 mb-4 bg-sky-50 border border-sky-100 rounded-xl px-3 py-2.5">
            <span className="text-sky-400 shrink-0 font-bold mt-0.5">ℹ</span>
            <span>A <strong>Proposal Ready</strong> email draft will be queued for your review and sending after this move.</span>
          </div>
        )}

        {error && (
          <div className="mb-3 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-3 py-2 text-xs">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {error && canOverride && (
          <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="stage-override">
            <p className="font-semibold">Push forward anyway?</p>
            <p className="mt-0.5">The lead moves now even though the items above are missing. Your reason and the missing items are recorded on the lead's activity.</p>
            <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} rows={2} maxLength={1000}
              placeholder="Why must this lead move now? (at least 10 characters)" aria-label="Reason for pushing forward"
              className="mt-2 w-full rounded-lg border border-amber-200 bg-white px-2 py-1.5 text-xs text-stone-800" />
            <button type="button" disabled={saving || overrideReason.trim().length < 10}
              onClick={() => onConfirm(rating, valueOk ? parsedValue : null, reason.trim(), sendNpsSurvey, overrideReason.trim())}
              className="mt-2 w-full rounded-lg bg-amber-600 py-2 font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Push forward with this reason'}
            </button>
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="flex-1 text-stone-600 py-2.5 rounded-xl text-sm hover:bg-stone-50 transition-colors disabled:opacity-50"
            style={{ border: '1px solid #EDE8E3' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(rating, valueOk ? parsedValue : null, reason.trim(), sendNpsSurvey)}
            disabled={saving || !canSubmit}
            className="flex-1 bg-brand-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-brand-600 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Confirm Move'}
          </button>
        </div>
      </div>
    </div>
  );
}
