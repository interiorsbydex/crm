import { useEffect, useRef, useState } from 'react';
import MeetingLocationField from '../MeetingLocationField';
import { Mail, ChevronDown, ChevronUp, Paperclip, X } from 'lucide-react';
import { api, type Meeting, type NextPlanItem } from '../../lib/api';
import NextPlanOfActionPicker from '../NextPlanOfActionPicker';
import EmailPreviewModal from '../EmailPreviewModal';
import { formatISTDateTime, istDatetimeLocalValue, istInputToISO } from '../../lib/dateFormat';
import { DateTimeInput } from '../ui/DateTimeInputs';

const MOM_ATTACHMENT_TYPES = ['Floor Plan', 'Proposal', 'Lifestyle Sheet', 'Other'] as const;

function getApiBase() {
  return (import.meta as any).env?.VITE_API_BASE ?? '/api';
}

const MODES = [
  { value: 'EC_VISIT', label: 'EC Visit' },
  { value: 'SITE_VISIT', label: 'Site Visit' },
  { value: 'VIRTUAL', label: 'Virtual' },
  { value: 'PUBLIC_PLACE', label: 'Public Place' },
  { value: 'CLIENT_PLACE', label: "Client's Place" },
];
const LOCATION_OPTIONS = ['Office', "Client's Site", 'Public Place', "Client's Place", 'Virtual'];
/** Earliest allowed datetime-local value: tomorrow at 00:00 IST (blocks same-day-or-earlier). */
function minRescheduleDateTime() {
  return `${istDatetimeLocalValue(new Date(Date.now() + 86400000)).slice(0, 10)}T00:00`;
}

const TYPES = [
  { value: 'DQL', label: 'DQL (Initial Meeting)' },
  { value: 'PP', label: 'PP (Proposal Presentation)' },
  { value: 'PD', label: 'PD (Pitch Discussion)' },
  { value: 'ONBOARDING', label: 'OB (Onboarding)' },
  { value: 'OBM', label: 'OBM (Onboarding Meeting)' },
];

const STATUS_COLORS: Record<string, string> = {
  SCHEDULED: 'bg-blue-100 text-blue-700',
  COMPLETED: 'bg-green-100 text-green-700',
  RESCHEDULED: 'bg-amber-100 text-amber-700',
  NO_SHOW: 'bg-red-100 text-red-700',
};

interface Props {
  leadId: string;
  clientEmail?: string | null;
  onMeetingCreated?: () => void;
  onMeetingCompleted?: (meetingType: string) => void;
  isLocked?: boolean;
}

export default function MeetingsTab({ leadId, clientEmail, onMeetingCreated, onMeetingCompleted, isLocked }: Props) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Pre-DQL questionnaire
  const [questionnaire, setQuestionnaire] = useState<{ responses: Record<string, string>; submittedAt: string } | null>(null);
  const [showQuestionnaire, setShowQuestionnaire] = useState(false);

  // Schedule form
  const [form, setForm] = useState({ type: '', mode: '', scheduledAt: '', location: '', internalNotes: '' });
  const [notifyClient, setNotifyClient] = useState(true);

  // Status update modal
  const [statusModal, setStatusModal] = useState<{
    meetingId: string;
    meetingType: string;
    status: 'COMPLETED' | 'RESCHEDULED' | 'NO_SHOW';
    originalLocation?: string | null;
  } | null>(null);
  const [statusForm, setStatusForm] = useState({
    mom: '', rescheduledReason: '', newScheduledAt: '', rescheduleMode: '', rescheduleLocation: '', noShowReason: '',
    replanScheduledAt: '', replanMode: '', replanLocation: '',
  });
  const [statusSubmitting, setStatusSubmitting] = useState(false);
  // Editable draft ("click Send") step for client-facing MOM/reschedule/
  // no-show mail — mirrors the PD→OB Welcome Mail / OB→OBM pattern instead
  // of auto-sending on completion.
  const [pendingMail, setPendingMail] = useState<{ draftKey: string; type: string; subject: string; html: string } | null>(null);
  // A single action (e.g. completing a DQL/PP/DESIGN_FREEZE/SIGN_OFF meeting)
  // can produce two client-facing drafts at once — the MOM mail and the NPS
  // survey mail. Both must be reviewed individually, never auto-sent, so any
  // drafts beyond the first queue here and surface one modal at a time.
  const [mailQueue, setMailQueue] = useState<{ draftKey: string; type: string; subject: string; html: string }[]>([]);
  const [sendingMail, setSendingMail] = useState(false);
  const [mailSentNotice, setMailSentNotice] = useState<string | null>(null);
  const [momAttachmentTypes, setMomAttachmentTypes] = useState<string[]>([]);
  const [momFiles, setMomFiles] = useState<File[]>([]);
  const [uploadingMomAttachment, setUploadingMomAttachment] = useState(false);
  const momFileRef = useRef<HTMLInputElement>(null);
  const [bookingFiles, setBookingFiles] = useState<File[]>([]);
  const bookingFileRef = useRef<HTMLInputElement>(null);
  const [nextPlanItems, setNextPlanItems] = useState<NextPlanItem[]>([]);

  // Task #115 — multiple attachments per category are allowed. Each click on
  // a category button adds a new attachment slot (categories can repeat);
  // slots and uploaded files are paired by position, in the order added.
  const addMomAttachmentType = (type: string) => {
    setMomAttachmentTypes((prev) => [...prev, type]);
  };
  const removeMomAttachmentSlot = (index: number) => {
    setMomAttachmentTypes((prev) => prev.filter((_, i) => i !== index));
    setMomFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const loadMeetings = async () => {
    try {
      const data = await api.get<{ meetings: Meeting[] }>(`/leads/${leadId}/meetings`);
      setMeetings(data.meetings);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadMeetings(); }, [leadId]);

  useEffect(() => {
    api.get<{ questionnaire: { responses: Record<string, string>; submittedAt: string } | null }>(`/leads/${leadId}/questionnaire`)
      .then((d) => setQuestionnaire(d.questionnaire))
      .catch(() => {});
  }, [leadId]);

  const handleSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.type || !form.mode || !form.scheduledAt) return;
    setSubmitting(true);
    setError(null);
    try {
      // Upload booking attachments before posting the meeting
      const uploadedAttachments: { storagePath: string; fileName: string }[] = [];
      if (bookingFiles.length > 0) {
        const token = localStorage.getItem('crm_token') ?? '';
        for (const file of bookingFiles) {
          const fd = new FormData();
          fd.append('file', file);
          const uploadResp = await fetch(`${getApiBase()}/leads/${leadId}/calls/upload-attachment`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: fd,
          });
          if (!uploadResp.ok) {
            const err = await uploadResp.json().catch(() => ({}));
            throw new Error(err.error ?? 'Attachment upload failed');
          }
          const uploadData = await uploadResp.json();
          uploadedAttachments.push({ storagePath: uploadData.storagePath, fileName: file.name });
        }
      }
      const result = await api.post<{ pendingMail?: { draftKey: string; type: string; to: string; subject: string; html: string } | null }>(
        `/leads/${leadId}/meetings`,
        {
          type: form.type,
          mode: form.mode,
          scheduledAt: istInputToISO(form.scheduledAt),
          location: form.location || undefined,
          internalNotes: form.internalNotes.trim() || undefined,
          notifyClient,
          bookingAttachments: uploadedAttachments.length ? uploadedAttachments : undefined,
        },
      );
      setForm({ type: '', mode: '', scheduledAt: '', location: '', internalNotes: '' });
      setNotifyClient(true);
      setBookingFiles([]);
      setShowForm(false);
      await loadMeetings();
      onMeetingCreated?.();
      // Batch 12c Round 3a — the booking confirmation mail is now a draft the
      // designer must review and explicitly send, not auto-sent on schedule.
      if (result.pendingMail) {
        setPendingMail({
          draftKey: result.pendingMail.draftKey,
          type: result.pendingMail.type,
          subject: result.pendingMail.subject,
          html: result.pendingMail.html,
        });
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const openStatusModal = (meeting: Meeting, status: 'COMPLETED' | 'RESCHEDULED' | 'NO_SHOW') => {
    setStatusModal({
      meetingId: meeting.id,
      meetingType: meeting.type,
      status,
      originalLocation: meeting.location,
    });
    setStatusForm({
      mom: '',
      rescheduledReason: '',
      newScheduledAt: '',
      rescheduleMode: status === 'RESCHEDULED' ? meeting.mode : '',
      rescheduleLocation: status === 'RESCHEDULED' ? (meeting.location ?? '') : '',
      noShowReason: '',
      replanScheduledAt: '', replanMode: '', replanLocation: '',
    });
    setMomAttachmentTypes([]);
    setMomFiles([]);
    setNextPlanItems([]);
    setError(null);
  };

  const handleStatusUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!statusModal) return;
    if (statusModal.status === 'COMPLETED' && momAttachmentTypes.length !== momFiles.length) {
      setError('Each selected attachment category must have exactly one uploaded file.');
      return;
    }
    setStatusSubmitting(true);
    setError(null);
    try {
      let momAttachments: { type: string; storagePath?: string }[] | undefined;
      if (statusModal.status === 'COMPLETED' && momFiles.length > 0 && momAttachmentTypes.length > 0) {
        setUploadingMomAttachment(true);
        const token = localStorage.getItem('crm_token') ?? '';
        const uploadedPaths: string[] = [];
        for (const file of momFiles) {
          const fd = new FormData();
          fd.append('file', file);
          const uploadResp = await fetch(`${getApiBase()}/leads/${leadId}/calls/upload-attachment`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: fd,
          });
          if (!uploadResp.ok) {
            const err = await uploadResp.json().catch(() => ({}));
            throw new Error(err.error ?? 'Attachment upload failed');
          }
          const uploadData = await uploadResp.json();
          uploadedPaths.push(uploadData.storagePath);
        }
        momAttachments = momAttachmentTypes.map((type, i) => ({ type, storagePath: uploadedPaths[i] }));
        setUploadingMomAttachment(false);
      }

      const result = await api.patch<{
        pendingMail?: { draftKey: string; type: string; to: string; subject: string; html: string };
        npsPendingMail?: { draftKey: string; type: string; to: string; subject: string; html: string };
      }>(
        `/meetings/${statusModal.meetingId}/status`,
        {
          status: statusModal.status,
          mom: statusForm.mom || undefined,
          momAttachmentTypes: momAttachmentTypes.length ? momAttachmentTypes : undefined,
          momAttachments,
          nextPlanOfAction: nextPlanItems.length ? nextPlanItems : undefined,
          rescheduledReason: statusForm.rescheduledReason || undefined,
           rescheduleMode: statusForm.rescheduleMode || undefined,
           rescheduleLocation: statusForm.rescheduleLocation || undefined,
          noShowReason: statusForm.noShowReason || undefined,
          newScheduledAt: statusForm.newScheduledAt
            ? istInputToISO(statusForm.newScheduledAt)
            : undefined,
          replanScheduledAt: statusForm.replanScheduledAt
            ? istInputToISO(statusForm.replanScheduledAt)
            : undefined,
          replanMode: statusForm.replanMode || undefined,
          replanLocation: statusForm.replanLocation || undefined,
        },
      );
      const completedType = statusModal.status === 'COMPLETED' ? statusModal.meetingType : null;
      setStatusModal(null);
      await loadMeetings();
      onMeetingCreated?.(); // reload lead data in parent
      if (completedType) onMeetingCompleted?.(completedType);
      // Open the editable draft(s) the designer must review and click Send
      // on — client-facing mail is never auto-sent. Completing a meeting can
      // produce both a MOM mail and an NPS survey mail; show them one at a
      // time via the queue.
      const drafts = [result.pendingMail, result.npsPendingMail].filter(Boolean) as {
        draftKey: string; type: string; subject: string; html: string;
      }[];
      if (drafts.length) {
        setPendingMail(drafts[0]);
        setMailQueue(drafts.slice(1));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setStatusSubmitting(false);
      setUploadingMomAttachment(false);
    }
  };

  /** Advance to the next queued draft (MOM → NPS), if any, after the current one is sent or dismissed. */
  const advanceMailQueue = () => {
    setMailQueue((queue) => {
      if (queue.length === 0) { setPendingMail(null); return queue; }
      setPendingMail(queue[0]);
      return queue.slice(1);
    });
  };

  const handleSendPendingMail = async (subject: string, html: string) => {
    if (!pendingMail) return;
    setSendingMail(true);
    setError(null);
    try {
      // NPS drafts carry a per-stage draftKey (leadId::NPS_<stage>) that this
      // simple type+leadId PATCH can reconstruct just as well as the MOM/
      // reschedule/no-show ones do, so the same two-step edit-then-send flow applies.
      await api.patch(`/email/draft/${pendingMail.type}/${leadId}`, { subject, html });
      await api.post('/email/send-draft', { draftKey: pendingMail.draftKey, to: clientEmail });
      setMailSentNotice(`Email sent to ${clientEmail}`);
      advanceMailQueue();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSendingMail(false);
    }
  };

  /** Derive a display label like "DQL 1", "PP 2", "OB 1" using seqNumber */
  const meetingLabel = (m: Meeting) => {
    const seq = m.seqNumber ?? 1;
    const typeMap: Record<string, string> = { DQL: 'DQL', PP: 'PP', ONBOARDING: 'OB' };
    const abbrev = typeMap[m.type] ?? m.type;
    // Only append number if there are multiple of the same type
    const showNum = meetings.filter((x) => x.type === m.type).length > 1;
    return showNum ? `${abbrev} ${seq}` : abbrev === 'DQL' ? 'DQL Meeting' : abbrev === 'OB' ? 'Onboarding Meeting' : abbrev;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Meetings</h2>
          <p className="text-sm text-gray-500">
            {meetings.length} total · {meetings.filter((m) => m.status === 'COMPLETED').length} completed ·{' '}
            {meetings.filter((m) => m.status === 'SCHEDULED').length} scheduled ·{' '}
            {meetings.filter((m) => m.status === 'RESCHEDULED').length} rescheduled ·{' '}
            {meetings.filter((m) => m.status === 'NO_SHOW').length} no-shows
          </p>
        </div>
        {!isLocked && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="bg-brand-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-600 transition-colors"
          >
            {showForm ? 'Cancel' : '+ Schedule Meeting'}
          </button>
        )}
      </div>

      {isLocked && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-700">
          This lead is Inactive — reactivate it to schedule meetings.
        </div>
      )}

      {/* Schedule Form */}
      {!isLocked && showForm && (
        <form onSubmit={handleSchedule} className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <h3 className="font-medium text-gray-900">Schedule a Meeting</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Type <span className="text-red-500">*</span>
              </label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              >
                <option value="">Select type…</option>
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Mode <span className="text-red-500">*</span>
              </label>
              <select
                value={form.mode}
                onChange={(e) => setForm({ ...form, mode: e.target.value })}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              >
                <option value="">Select mode…</option>
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Date & Time <span className="text-red-500">*</span>
              </label>
              <DateTimeInput
                value={form.scheduledAt}
                onChange={(v) => setForm({ ...form, scheduledAt: v })}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
              <input
                type="text"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                maxLength={250}
                placeholder="e.g. Prestige Lakeside Habitat, Tower 4"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={notifyClient}
              onChange={(e) => setNotifyClient(e.target.checked)}
              className="rounded border-gray-300 text-brand-500 focus:ring-brand-400"
            />
            <span className="flex items-center gap-1.5">
              <Mail size={14} strokeWidth={1.8} className="text-gray-400" />
              Send confirmation email to client
            </span>
          </label>
          <p className="text-xs text-gray-400 pl-6">
            A confirmation email + SMS will be sent to the client.
          </p>
          {/* Booking document attachments */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Attach Documents <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              ref={bookingFileRef}
              type="file"
              multiple
              accept=".pdf,.jpg,.jpeg,.png,.webp,.xls,.xlsx,.doc,.docx"
              className="hidden"
              onChange={(e) => setBookingFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])])}
            />
            <button
              type="button"
              onClick={() => bookingFileRef.current?.click()}
              className="text-sm border border-dashed border-gray-300 rounded-lg px-3 py-2 w-full text-gray-500 hover:border-brand-400 hover:text-brand-600 transition-colors"
            >
              + Add file
            </button>
            {bookingFiles.length > 0 && (
              <ul className="mt-2 space-y-1">
                {bookingFiles.map((f, i) => (
                  <li key={i} className="flex items-center justify-between text-xs text-gray-600 bg-gray-50 rounded px-2 py-1">
                    <span className="truncate">{f.name}</span>
                    <button type="button" onClick={() => setBookingFiles((prev) => prev.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500 ml-2 shrink-0">✕</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Internal Notes <span className="text-gray-400 font-normal">(staff only, never shared with client)</span>
            </label>
            <textarea
              value={form.internalNotes}
              onChange={(e) => setForm({ ...form, internalNotes: e.target.value })}
              rows={2}
              placeholder="Private notes for the team…"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none"
            />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-brand-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Scheduling…' : 'Schedule Meeting'}
          </button>
        </form>
      )}

      {/* Status Update Modal */}
      {statusModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h3 className="font-semibold text-gray-900 mb-4">
              Mark as {statusModal.status.charAt(0) + statusModal.status.slice(1).toLowerCase()}
            </h3>
            <form onSubmit={handleStatusUpdate} className="space-y-4">
              {statusModal.status === 'COMPLETED' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Minutes of Meeting (MOM) <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    rows={4}
                    value={statusForm.mom}
                    onChange={(e) => setStatusForm({ ...statusForm, mom: e.target.value })}
                    required
                    placeholder="Summary of what was discussed, decisions made, next steps…"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                  <p className="text-xs text-gray-400 mt-1">MOM will be emailed to the client automatically.</p>
                </div>
              )}
              {statusModal.status === 'COMPLETED' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Attachments</label>
                    <div className="flex flex-wrap gap-2 mb-2">
                      {MOM_ATTACHMENT_TYPES.map((type) => (
                        <button
                          key={type}
                          type="button"
                          onClick={() => addMomAttachmentType(type)}
                          className="text-xs px-3 py-1 rounded-full border border-gray-200 text-gray-500 hover:border-brand-300 hover:text-brand-700"
                        >
                          + {type}
                        </button>
                      ))}
                    </div>
                    {momAttachmentTypes.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap gap-1.5">
                          {momAttachmentTypes.map((type, i) => (
                            <span key={i} className="inline-flex items-center gap-1 text-xs bg-brand-50 border border-brand-200 text-brand-700 px-2 py-0.5 rounded-full">
                              {type}{momFiles[i] ? `: ${momFiles[i].name}` : ' (no file yet)'}
                              <button type="button" onClick={() => removeMomAttachmentSlot(i)} className="text-brand-400 hover:text-red-400">
                                <X size={10} strokeWidth={2} />
                              </button>
                            </span>
                          ))}
                        </div>
                        <label className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-dashed w-fit transition-colors ${
                          momFiles.length >= momAttachmentTypes.length
                            ? 'border-gray-200 text-gray-300 cursor-not-allowed'
                            : 'border-gray-300 text-gray-600 cursor-pointer hover:border-brand-400'
                        }`}>
                          <Paperclip size={11} strokeWidth={2} />
                          Upload file ({momFiles.length}/{momAttachmentTypes.length})
                          <input
                            ref={momFileRef}
                            type="file"
                            multiple
                            disabled={momFiles.length >= momAttachmentTypes.length}
                            className="hidden"
                            onChange={(e) => {
                              const remaining = momAttachmentTypes.length - momFiles.length;
                              const picked = Array.from(e.target.files ?? []).slice(0, Math.max(remaining, 0));
                              setMomFiles((prev) => [...prev, ...picked]);
                              e.target.value = '';
                            }}
                          />
                        </label>
                        {momFiles.length < momAttachmentTypes.length && (
                          <p className="text-[11px] text-amber-600">
                            Upload {momAttachmentTypes.length - momFiles.length} more file(s) to match the added attachment slots, or remove a slot.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-gray-400">You'll be able to review and edit the MOM email before it's sent to the client.</p>
                  <div className="border-t border-gray-100 pt-3">
                    <NextPlanOfActionPicker items={nextPlanItems} onChange={setNextPlanItems} />
                  </div>
                </>
              )}
              {statusModal.status === 'RESCHEDULED' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Reason for Rescheduling <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={statusForm.rescheduledReason}
                      onChange={(e) => setStatusForm({ ...statusForm, rescheduledReason: e.target.value })}
                      required
                      placeholder="e.g. Client unavailable, site not ready…"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        New Date & Time <span className="text-red-500">*</span>
                      </label>
                      <DateTimeInput
                        value={statusForm.newScheduledAt}
                        onChange={(v) => setStatusForm({ ...statusForm, newScheduledAt: v })}
                        required
                        min={minRescheduleDateTime()}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Mode <span className="text-red-500">*</span>
                      </label>
                      <select
                        value={statusForm.rescheduleMode}
                        onChange={(e) => setStatusForm({ ...statusForm, rescheduleMode: e.target.value })}
                        required
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                      >
                        <option value="">Select mode…</option>
                        {MODES.map((mode) => (
                          <option key={mode.value} value={mode.value}>{mode.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Location <span className="text-red-500">*</span>
                    </label>
                    <MeetingLocationField
                      value={statusForm.rescheduleLocation}
                      onChange={(v) => setStatusForm({ ...statusForm, rescheduleLocation: v })}
                      options={LOCATION_OPTIONS}
                    />
                    <p className="text-xs text-gray-400 mt-1">Mode and location are carried over from the original meeting and can be changed before confirming.</p>
                  </div>
                  <p className="text-xs text-gray-400">The meeting stays active and moves to this new time. You'll review the client notification email before it's sent.</p>
                </>
              )}
              {statusModal.status === 'NO_SHOW' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Reason for no-show <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      rows={2}
                      value={statusForm.noShowReason}
                      onChange={(e) => setStatusForm({ ...statusForm, noShowReason: e.target.value })}
                      required
                      placeholder="e.g. Client forgot, unavailable at last minute…"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                    />
                    <p className="text-xs text-gray-400 mt-1">You'll be able to review and edit the follow-up email before it's sent to the client.</p>
                  </div>
                  <div className="border-t border-gray-100 pt-3">
                    <p className="text-xs font-semibold text-gray-500 mb-2">Next tentative replan</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Date & Time <span className="text-red-500">*</span>
                        </label>
                        <DateTimeInput
                          value={statusForm.replanScheduledAt}
                          onChange={(v) => setStatusForm({ ...statusForm, replanScheduledAt: v })}
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Mode <span className="text-red-500">*</span>
                        </label>
                        <select
                          value={statusForm.replanMode}
                          onChange={(e) => setStatusForm({ ...statusForm, replanMode: e.target.value })}
                          required
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                        >
                          <option value="">Select mode…</option>
                          {MODES.map((mode) => (
                            <option key={mode.value} value={mode.value}>{mode.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="mt-3">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Location <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={statusForm.replanLocation}
                        onChange={(e) => setStatusForm({ ...statusForm, replanLocation: e.target.value })}
                        required
                        maxLength={250}
                        placeholder="e.g. Office, Client's site…"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                      />
                    </div>
                    <p className="text-xs text-gray-400 mt-1">Required so this no-show doesn't fall through the cracks — you can formally reschedule later.</p>
                  </div>
                </>
              )}
              {error && <p className="text-sm text-red-500">{error}</p>}
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setStatusModal(null)}
                  className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={statusSubmitting || uploadingMomAttachment}
                  className="flex-1 bg-brand-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
                >
                  {uploadingMomAttachment ? 'Uploading…' : statusSubmitting ? 'Saving…' : 'Confirm'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Meeting List */}
      {loading ? (
        <div className="text-center py-10 text-gray-400 text-sm animate-pulse">Loading meetings…</div>
      ) : meetings.length === 0 ? (
        <div className="text-center py-10 text-gray-400 text-sm">No meetings scheduled yet</div>
      ) : (
        <div className="space-y-3">
          {meetings.map((meeting) => (
            <div key={meeting.id} className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-gray-900 text-sm">{meetingLabel(meeting)}</span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[meeting.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {meeting.status}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {new Date(meeting.scheduledAt).toLocaleString('en-IN', {
                      timeZone: 'Asia/Kolkata',
                      weekday: 'short', day: 'numeric', month: 'short',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {MODES.find(m => m.value === meeting.mode)?.label ?? meeting.mode}
                  </p>
                </div>

                {meeting.status === 'SCHEDULED' && (
                  <div className="flex gap-2 shrink-0">
                    <button
                       onClick={() => openStatusModal(meeting, 'COMPLETED')}
                      className="text-xs bg-green-50 text-green-700 border border-green-200 px-2.5 py-1 rounded-lg hover:bg-green-100 transition-colors"
                    >
                      Complete
                    </button>
                    <button
                       onClick={() => openStatusModal(meeting, 'RESCHEDULED')}
                      className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-1 rounded-lg hover:bg-amber-100 transition-colors"
                    >
                      Reschedule
                    </button>
                    <button
                       onClick={() => openStatusModal(meeting, 'NO_SHOW')}
                      className="text-xs bg-red-50 text-red-700 border border-red-200 px-2.5 py-1 rounded-lg hover:bg-red-100 transition-colors"
                    >
                      No-show
                    </button>
                  </div>
                )}
              </div>

              {/* Reschedule history — oldest first */}
              {meeting.rescheduleHistory && meeting.rescheduleHistory.length > 0 && (
                <div className="mt-2 space-y-1">
                  {meeting.rescheduleHistory.map((h, i) => (
                    <div key={i} className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-1.5">
                      <span className="font-medium">Reschedule {i + 1}:</span>{' '}
                      was {new Date(h.scheduledAt).toLocaleString('en-IN', {
                        timeZone: 'Asia/Kolkata',
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                      })} — {h.reason}
                    </div>
                  ))}
                </div>
              )}
              {/* Current reschedule reason (latest) */}
              {!meeting.rescheduleHistory?.length && meeting.rescheduledReason && (
                <p className="text-xs text-amber-600 mt-2 bg-amber-50 rounded-lg px-3 py-1.5">
                  Rescheduled: {meeting.rescheduledReason}
                </p>
              )}
              {meeting.noShowReason && (
                <p className="text-xs text-red-600 mt-2 bg-red-50 rounded-lg px-3 py-1.5">
                  No-show reason: {meeting.noShowReason}
                </p>
              )}
              {meeting.status === 'NO_SHOW' && meeting.replanScheduledAt && (
                <p className="text-xs text-blue-700 mt-2 bg-blue-50 rounded-lg px-3 py-1.5">
                  Next tentative replan: {formatISTDateTime(meeting.replanScheduledAt)}
                  {meeting.replanMode ? ` · ${MODES.find((m) => m.value === meeting.replanMode)?.label ?? meeting.replanMode}` : ''}
                  {meeting.replanLocation ? ` · ${meeting.replanLocation}` : ''}
                </p>
              )}
              {meeting.location && (
                <p className="text-xs text-gray-400 mt-1">📍 {meeting.location}</p>
              )}
              {meeting.internalNotes && (
                <div className="mt-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  <p className="text-xs font-medium text-amber-700 mb-0.5">🔒 Internal Notes</p>
                  <p className="text-xs text-amber-800">{meeting.internalNotes}</p>
                </div>
              )}
              {meeting.mom && (
                <div className="mt-2 bg-gray-50 rounded-lg px-3 py-2">
                  <p className="text-xs font-medium text-gray-500 mb-0.5">MOM</p>
                  <p className="text-xs text-gray-700">{meeting.mom}</p>
                </div>
              )}

              {/* Pre-DQL questionnaire view */}
              {meeting.type === 'DQL' && questionnaire && (
                <div className="mt-2">
                  <button
                    onClick={() => setShowQuestionnaire(!showQuestionnaire)}
                    className="text-xs text-brand-600 hover:text-brand-700 font-medium hover:underline"
                  >
                    <span className="flex items-center gap-1">
                      {showQuestionnaire ? <ChevronUp size={12} strokeWidth={2} /> : <ChevronDown size={12} strokeWidth={2} />}
                      {showQuestionnaire ? 'Hide' : 'View'} Pre-meeting Questionnaire
                    </span>
                  </button>
                  {showQuestionnaire && (
                    <div className="mt-2 bg-fuchsia-50 border border-fuchsia-100 rounded-lg p-3 space-y-2">
                      <p className="text-xs text-fuchsia-600 font-medium mb-1">
                        Submitted: {new Date(questionnaire.submittedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
                      </p>
                      {Object.entries(questionnaire.responses).map(([q, a]) => (
                        <div key={q}>
                          <p className="text-xs font-medium text-gray-600">{q}</p>
                          <p className="text-xs text-gray-800">{a}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

            </div>
          ))}
        </div>
      )}

      {mailSentNotice && (
        <div className="fixed bottom-4 right-4 bg-green-600 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg z-50">
          {mailSentNotice}
        </div>
      )}

      {pendingMail && (
        <EmailPreviewModal
          title={
            pendingMail.type === 'MEETING_COMPLETED'
              ? 'Review MOM Email'
              : pendingMail.type === 'MEETING_RESCHEDULED'
              ? 'Review Reschedule Email'
              : pendingMail.type === 'MEETING_CONFIRMATION'
              ? 'Review Meeting Confirmation Email'
              : pendingMail.type.startsWith('NPS_')
              ? 'Review NPS Survey Email'
              : 'Review No-show Email'
          }
          defaultSubject={pendingMail.subject}
          defaultHtml={pendingMail.html}
          recipientLabel={clientEmail ?? '(no client email on file)'}
          sending={sendingMail}
          onSend={handleSendPendingMail}
          onClose={advanceMailQueue}
          requireSend={pendingMail.type === 'MEETING_COMPLETED' || pendingMail.type === 'NPS_ONBOARDING'}
        />
      )}
      {pendingMail && mailQueue.length > 0 && (
        <div className="fixed bottom-16 right-4 bg-gray-800 text-white text-xs px-3 py-1.5 rounded-lg shadow-lg z-50">
          {mailQueue.length} more email{mailQueue.length > 1 ? 's' : ''} to review after this one
        </div>
      )}
    </div>
  );
}
