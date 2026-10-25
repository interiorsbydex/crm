import { useState, useEffect } from 'react';
import { Check, Mail, AlertCircle } from 'lucide-react';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import EmailPreviewModal from './EmailPreviewModal';
import { CustomChecklistItems, useChecklistStatus } from './ChecklistExtras';
import { DateTimeInput } from './ui/DateTimeInputs';
import { istDatetimeLocalValue, istInputToISO } from '../lib/dateFormat';
import { crmSettings } from '../lib/crmSettings';

interface PDOBChecklist {
  id: string;
  leadId: string;
  paymentValue: number | null;
  projectValue: number | null;
  furnitureValue: number | null;
  obMeetingScheduledAt: string | null;
  obMeetingLocation: string | null;
  notes: string | null;
  finalPitchPresentationConfirmed: boolean;
  welcomeMailSent: boolean;
  welcomeMailSentAt: string | null;
  completedAt: string | null;
}

interface Props {
  leadId: string;
  stage: string;
  clientEmail: string | null;
  onComplete?: () => void;
  isLocked?: boolean;
  refreshKey?: number;
}

// PROPOSAL_PRESENTED is included so this same mandatory checklist can be
// started/completed while a lead is still in PP, ahead of a PP→OB skip —
// the checklist is never bypassed by the skip, only started earlier.
const VISIBLE_STAGES = new Set(['PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER']);
const OB_MEETING_LOCATIONS = ['Office', "Client's Site", 'Public Place', "Client's Place", 'Virtual'] as const;
const OTHER_LOCATION_VALUE = '__other_location__';

export default function PDOBChecklistPanel({ leadId, stage, clientEmail, onComplete, isLocked, refreshKey = 0 }: Props) {
  const [checklist, setChecklist] = useState<PDOBChecklist | null>(null);
  const [hasPaymentScreenshot, setHasPaymentScreenshot] = useState(false);
  const [hasObQuote, setHasObQuote] = useState(false);
  const [hasWelcomeMailScreenshot, setHasWelcomeMailScreenshot] = useState(false);
  const [hasFinalPitchPresentationFile, setHasFinalPitchPresentationFile] = useState(false);
  const [hasGeneratedQuotationFile, setHasGeneratedQuotationFile] = useState(false);
  const [template, setTemplate] = useState({ subject: '', html: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [showMailModal, setShowMailModal] = useState(false);
  const statusPath = `/leads/${leadId}/pd-ob-checklist`;
  const { status, reload: reloadStatus } = useChecklistStatus(statusPath, [stage, refreshKey, checklist]);

  const [form, setForm] = useState({ paymentValue: '', targetValue: '', projectValue: '', furnitureValue: '', obMeetingScheduledAt: '', obMeetingLocation: '', notes: '', finalPitchPresentationConfirmed: false });
  const [showOtherLocation, setShowOtherLocation] = useState(false);
  const [obMeetingNotifyClient, setObMeetingNotifyClient] = useState(crmSettings().notifyClientByDefault);
  // Fix A — explicit "send externally?" checkbox for the PD→OB welcome email;
  // defaults to true (opt-out if not desired) but must be visible.
  const [welcomeNotifyClient, setWelcomeNotifyClient] = useState(true);

  const isEditable = (stage === 'PROPOSAL_PRESENTED' || stage === 'PROPOSAL_DISCUSSION') && !isLocked;
  const canEditTarget = !isLocked && (isEditable || stage === 'ONBOARDING' || stage === 'ONBOARDING_MEETING');

  const load = async () => {
    try {
      const data = await api.get<{
        checklist: PDOBChecklist | null;
        targetValue: number | null;
        hasPaymentScreenshot: boolean;
        hasObQuote: boolean;
        hasWelcomeMailScreenshot: boolean;
        hasFinalPitchPresentationFile: boolean;
        hasGeneratedQuotationFile: boolean;
        welcomeMailTemplate: { subject: string; html: string };
      }>(`/leads/${leadId}/pd-ob-checklist`);
      setChecklist(data.checklist);
      setHasPaymentScreenshot(data.hasPaymentScreenshot);
      setHasObQuote(data.hasObQuote);
      setHasWelcomeMailScreenshot(data.hasWelcomeMailScreenshot);
      setHasFinalPitchPresentationFile(data.hasFinalPitchPresentationFile);
      setHasGeneratedQuotationFile(data.hasGeneratedQuotationFile);
      setTemplate(data.welcomeMailTemplate);
      if (data.checklist) {
        const savedLocation = data.checklist.obMeetingLocation ?? '';
        setForm({
          paymentValue: data.checklist.paymentValue?.toString() ?? '',
          targetValue: data.targetValue?.toString() ?? '',
          projectValue: data.checklist.projectValue?.toString() ?? '',
          furnitureValue: data.checklist.furnitureValue?.toString() ?? '',
          obMeetingScheduledAt: data.checklist.obMeetingScheduledAt ? istDatetimeLocalValue(data.checklist.obMeetingScheduledAt) : '',
          obMeetingLocation: savedLocation,
          notes: data.checklist.notes ?? '',
          finalPitchPresentationConfirmed: data.checklist.finalPitchPresentationConfirmed,
        });
        setShowOtherLocation(
          !!savedLocation && !OB_MEETING_LOCATIONS.includes(savedLocation as typeof OB_MEETING_LOCATIONS[number]),
        );
      }
    } catch (e: any) {
      console.warn('[PD-OB] load error:', e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (VISIBLE_STAGES.has(stage)) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, stage, refreshKey]);

  const saveDetails = async () => {
    setSaving(true);
    try {
      const data = await api.patch<{ checklist: PDOBChecklist }>(`/leads/${leadId}/pd-ob-checklist`, {
        paymentValue: form.paymentValue === '' ? null : parseFloat(form.paymentValue),
        targetValue: form.targetValue === '' ? null : Number(form.targetValue),
        projectValue: form.projectValue === '' ? null : parseFloat(form.projectValue),
        furnitureValue: form.furnitureValue === '' ? null : parseFloat(form.furnitureValue),
        obMeetingScheduledAt: form.obMeetingScheduledAt ? istInputToISO(form.obMeetingScheduledAt) : null,
        obMeetingLocation: form.obMeetingLocation || null,
        notes: form.notes || null,
        finalPitchPresentationConfirmed: form.finalPitchPresentationConfirmed,
        notifyClient: obMeetingNotifyClient,
      });
      setChecklist(data.checklist);
      await load();
      onComplete?.();
      toast.success('Details saved');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const saveTarget = async () => {
    setSaving(true);
    try {
      await api.patch(`/leads/${leadId}/pd-ob-checklist`, {
        targetValue: form.targetValue === '' ? null : Number(form.targetValue),
      });
      await load();
      onComplete?.();
      toast.success('Target value saved');
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  // Batch 12c: this is now a two-step send against the real persisted-draft
  // infra (same one MOM mail uses) instead of one call that sent immediately.
  // Step 1 creates/updates the draft server-side (validates + saves, no send
  // yet); step 2 actually delivers it — only step 2 triggers the checklist
  // completion + stage-advance to Onboarding, so nothing advances until the
  // mail is truly sent, not merely edited in this modal.
  const sendWelcomeMail = async (subject: string, html: string) => {
    setSending(true);
    try {
      const draftResult = await api.post<{ pendingMail: { draftKey: string; to: string; subject: string; html: string } }>(
        `/leads/${leadId}/pd-ob-checklist/send-welcome-mail`,
        { subject, html },
      );
      await api.post('/email/send-draft', { draftKey: draftResult.pendingMail.draftKey, to: draftResult.pendingMail.to });
      toast.success('Welcome mail sent — lead moved to Onboarding');
      setShowMailModal(false);
      await load();
      onComplete?.();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSending(false);
    }
  };

  if (!VISIBLE_STAGES.has(stage)) return null;

  if (loading) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-5 animate-pulse">
        <div className="h-4 bg-gray-100 rounded w-40 mb-3" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <div key={i} className="h-8 bg-gray-100 rounded" />)}
        </div>
      </div>
    );
  }

  if (!checklist) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700">
        PD→OB checklist not yet created. It will appear once the lead enters Proposal Presented or PD (Pitch Discussion) stage.
      </div>
    );
  }

  const isComplete = !!checklist.completedAt;
  // What's missing comes from the server (Admin → Checklists can make items
  // optional or add new ones), so this always matches what sending will accept.
  const optionalKeys = new Set(status?.items.filter((i) => !i.required).map((i) => i.key) ?? []);
  const requiredMissing = [...(status?.missing ?? []), ...(!clientEmail ? ["Client's email"] : [])];
  const blockingMissing = [...(status?.blocking ?? status?.missing ?? []), ...(!clientEmail ? ["Client's email"] : [])];
  const lenient = !!status?.lenient;
  const optionalTag = (key: string) => (optionalKeys.has(key) ? ' (optional)' : '');

  return (
    <div className={`border rounded-xl p-5 ${isComplete ? 'bg-green-50 border-green-200' : 'bg-white border-gray-200'}`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-gray-900 text-sm">PD → OB Checklist</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {isComplete ? 'Welcome mail sent — lead moved to Onboarding' : 'Complete before moving to Onboarding'}
          </p>
        </div>
        {isComplete && (
          <span className="inline-flex items-center gap-1 text-xs font-medium bg-green-100 text-green-700 px-2.5 py-1 rounded-full">
            <Check size={11} strokeWidth={2.5} /> Done
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className={`text-xs px-3 py-2 rounded-lg ${hasPaymentScreenshot ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
          {hasPaymentScreenshot ? '✓' : '⚠'} Payment screenshot {hasPaymentScreenshot ? 'uploaded' : '— upload in Files tab'}{optionalTag('paymentScreenshot')}
        </div>
        <div className={`text-xs px-3 py-2 rounded-lg ${hasObQuote ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
          {hasObQuote ? '✓' : '⚠'} OB Quote {hasObQuote ? 'uploaded' : '— upload in Files tab'}{optionalTag('obQuote')}
        </div>
        <div className={`text-xs px-3 py-2 rounded-lg ${hasWelcomeMailScreenshot ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
          {hasWelcomeMailScreenshot ? '✓' : '⚠'} Approval screenshot {hasWelcomeMailScreenshot ? 'uploaded' : '— upload in Files tab'}{optionalTag('welcomeMailScreenshot')}
        </div>
        <div className={`text-xs px-3 py-2 rounded-lg ${hasFinalPitchPresentationFile ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
          {hasFinalPitchPresentationFile ? '✓' : '⚠'} Pitch Presentation file {hasFinalPitchPresentationFile ? 'uploaded' : '— upload in Files tab'}{optionalTag('finalPitchPresentation')}
        </div>
        <div className={`text-xs px-3 py-2 rounded-lg ${hasGeneratedQuotationFile ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
          {hasGeneratedQuotationFile ? '✓' : '⚠'} Generated Quotation file {hasGeneratedQuotationFile ? 'uploaded' : '— upload in Files tab'}{optionalTag('generatedQuotation')}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Payment value (₹){optionalTag('paymentValue')}</label>
          <input
            type="number"
            disabled={!isEditable || saving}
            value={form.paymentValue}
            onChange={(e) => setForm((f) => ({ ...f, paymentValue: e.target.value }))}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:bg-gray-50"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Target value — total after discount, excluding GST (₹)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            disabled={!canEditTarget || saving}
            value={form.targetValue}
            onChange={(e) => setForm((f) => ({ ...f, targetValue: e.target.value }))}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:bg-gray-50"
          />
          <p className="mt-1 text-xs text-gray-500">Updates the recorded amount used by booking reports and credits. Include furniture in this total; record the furniture breakup separately below.</p>
          {canEditTarget && !isEditable && (
            <button type="button" onClick={saveTarget} disabled={saving}
              className="mt-2 rounded bg-brand-500 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
              Save target value
            </button>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Project value excluding furniture (₹){optionalTag('projectValue')}</label>
          <input
            type="number"
            disabled={!isEditable || saving}
            value={form.projectValue}
            onChange={(e) => setForm((f) => ({ ...f, projectValue: e.target.value }))}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:bg-gray-50"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Furniture value (₹){optionalTag('furnitureValue')}</label>
          <input
            type="number"
            disabled={!isEditable || saving}
            value={form.furnitureValue}
            onChange={(e) => setForm((f) => ({ ...f, furnitureValue: e.target.value }))}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:bg-gray-50"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">OB meeting date &amp; time{optionalTag('obMeetingScheduledAt')}</label>
          <DateTimeInput
            disabled={!isEditable || saving}
            value={form.obMeetingScheduledAt}
            onChange={(v) => setForm((f) => ({ ...f, obMeetingScheduledAt: v }))}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">OB meeting location{optionalTag('obMeetingLocation')}</label>
          <select
            disabled={!isEditable || saving}
            value={showOtherLocation ? OTHER_LOCATION_VALUE : form.obMeetingLocation}
            onChange={(e) => {
              const isOther = e.target.value === OTHER_LOCATION_VALUE;
              setShowOtherLocation(isOther);
              setForm((f) => ({ ...f, obMeetingLocation: isOther ? '' : e.target.value }));
            }}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:bg-gray-50"
          >
            <option value="">Select location…</option>
            {OB_MEETING_LOCATIONS.map((location) => (
              <option key={location} value={location}>{location}</option>
            ))}
            <option value={OTHER_LOCATION_VALUE}>Other</option>
          </select>
          {showOtherLocation && (
            <input
              type="text"
              disabled={!isEditable || saving}
              value={form.obMeetingLocation}
              onChange={(e) => setForm((f) => ({ ...f, obMeetingLocation: e.target.value }))}
              maxLength={250}
              placeholder="e.g. DeX Experience Centre, Whitefield"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mt-2 focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:bg-gray-50"
            />
          )}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700 mb-3">
        <input
          type="checkbox"
          disabled={!isEditable || saving}
          checked={obMeetingNotifyClient}
          onChange={(e) => setObMeetingNotifyClient(e.target.checked)}
          className="rounded border-gray-300 text-brand-500 focus:ring-brand-400"
        />
        Send meeting confirmation email to client (applies when OB meeting date &amp; location above are saved)
      </label>

      <div className="mb-3">
        <label className="block text-xs font-medium text-gray-600 mb-1">Notes{optionalTag('notes')}</label>
        <textarea
          disabled={!isEditable || saving}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          rows={2}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:bg-gray-50"
        />
      </div>

      {/* Fix A — "send externally?" checkbox for the PD→OB welcome email */}
      {isEditable && (
        <label className="flex items-center gap-2 text-sm text-gray-700 mb-3">
          <input
            type="checkbox"
            disabled={saving}
            checked={welcomeNotifyClient}
            onChange={(e) => setWelcomeNotifyClient(e.target.checked)}
            className="rounded border-gray-300 text-brand-500 focus:ring-brand-400"
          />
          Send PD→OB welcome email to client
        </label>
      )}

      {isEditable && (
        <div className="flex gap-2">
          <button
            onClick={saveDetails}
            disabled={saving}
            className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save details'}
          </button>
          <button
            onClick={() => setShowMailModal(true)}
            disabled={saving || blockingMissing.length > 0 || !welcomeNotifyClient}
            title={
              !welcomeNotifyClient
                ? 'Enable "Send PD→OB welcome email to client" above to share the welcome mail'
                : blockingMissing.length > 0
                ? `Missing: ${blockingMissing.join(', ')}`
                : undefined
            }
            className="flex-1 flex items-center justify-center gap-1.5 bg-brand-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Mail size={13} strokeWidth={2.5} /> Share welcome mail
          </button>
        </div>
      )}

      <CustomChecklistItems basePath={statusPath} status={status} disabled={!isEditable || saving} onSaved={reloadStatus} />

      {isEditable && requiredMissing.length > 0 && (
        <div className="mt-3 flex items-start gap-1.5 text-xs text-amber-600">
          <AlertCircle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span>{lenient ? 'Not yet filled (you can still send; this will be recorded)' : 'Before sending'}: {requiredMissing.join(', ')}</span>
        </div>
      )}

      {showMailModal && (
        <EmailPreviewModal
          title="Share welcome mail"
          defaultSubject={template.subject}
          defaultHtml={template.html}
          recipientLabel={clientEmail ?? '(no email on file)'}
          sending={sending}
          onSend={sendWelcomeMail}
          onClose={() => setShowMailModal(false)}
        />
      )}
    </div>
  );
}
