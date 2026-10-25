import { useEffect, useRef, useState } from 'react';
import { useLenientLaunch } from '../../lib/flags';
import { AlertTriangle, RefreshCw, Paperclip, X } from 'lucide-react';
import { api, type CallRecord, type FollowUpTask, type NextPlanItem } from '../../lib/api';
import NextPlanOfActionPicker from '../NextPlanOfActionPicker';
import EmailPreviewModal from '../EmailPreviewModal';
import { formatISTDate, formatISTDateTime, istDatetimeLocalValue, istInputToISO } from '../../lib/dateFormat';
import { DateInput, TimeInput, DateTimeInput } from '../ui/DateTimeInputs';

const ATTACHMENT_TYPES = ['Lifestyle Capture', 'Proposal', 'Pitch Presentation'] as const;

const MEETING_TYPES = [
  { value: 'DQL', label: 'DQL' },
  { value: 'PP', label: 'PP' },
  { value: 'PD', label: 'PD' },
  { value: 'ONBOARDING', label: 'OB' },
  { value: 'OBM', label: 'OBM' },
];
// Same stage vocabulary as MEETING_TYPES, plus a catch-all — a scheduled
// call is usually "the DQL call", "the PP call", etc., but not every call
// maps to a meeting stage.
const CALL_STAGE_TYPES = [
  { value: 'DQL', label: 'DQL' },
  { value: 'PP', label: 'PP' },
  { value: 'PD', label: 'PD' },
  { value: 'ONBOARDING', label: 'OB' },
  { value: 'OBM', label: 'OBM' },
  { value: 'OTHER', label: 'Other' },
];
const MEETING_MODES = [
  { value: 'EC_VISIT', label: 'EC Visit' },
  { value: 'SITE_VISIT', label: 'Site Visit' },
  { value: 'VIRTUAL', label: 'Virtual' },
  { value: 'PUBLIC_PLACE', label: 'Public Place' },
  { value: 'CLIENT_PLACE', label: "Client's Place" },
];
function getApiBase() {
  return (import.meta as any).env?.VITE_API_BASE ?? '/api';
}

const OUTCOMES = [
  { value: 'ANSWERED', label: 'Answered' },
  { value: 'RNR_1', label: 'RNR 1' },
  { value: 'RNR_2', label: 'RNR 2' },
  { value: 'RNR_3', label: 'RNR 3' },
  { value: 'RNR_4', label: 'RNR 4' },
  { value: 'RNR_5', label: 'RNR 5' },
  { value: 'RNR_6_PLUS', label: 'RNR 6 & beyond' },
  { value: 'CALLBACK', label: 'Callback Scheduled' },
  { value: 'MEETING_SCHEDULED', label: 'Meeting Scheduled' },
];

function formatDuration(secs?: number) {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

const OUTCOME_COLORS: Record<string, string> = {
  ANSWERED: 'bg-green-100 text-green-700',
  RNR_1: 'bg-amber-100 text-amber-700',
  RNR_2: 'bg-amber-100 text-amber-700',
  RNR_3: 'bg-orange-100 text-orange-700',
  RNR_4: 'bg-orange-100 text-orange-700',
  RNR_5: 'bg-red-100 text-red-700',
  RNR_6_PLUS: 'bg-red-100 text-red-700',
  CALLBACK: 'bg-blue-100 text-blue-700',
  MEETING_SCHEDULED: 'bg-purple-100 text-purple-700',
};

interface CardProps { call: CallRecord; onRecordingRefresh: (url: string) => void }

function CallCard({ call, onRecordingRefresh }: CardProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState(call.recordingUrl ?? null);
  const isManual = !recordingUrl;

  const handleRefreshRecording = async () => {
    setRefreshing(true);
    try {
      const data = await api.get<{ recordingUrl: string | null }>(`/calls/${call.id}/recording-url`);
      if (data.recordingUrl) {
        setRecordingUrl(data.recordingUrl);
        onRecordingRefresh(data.recordingUrl);
      }
    } catch (e) {
      console.warn('Recording refresh failed:', e);
    } finally {
      setRefreshing(false);
    }
  };

  const callDateStr = call.calledAt
    ? formatISTDateTime(call.calledAt)
    : formatISTDate(call.createdAt);

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${OUTCOME_COLORS[call.outcome] ?? 'bg-gray-100 text-gray-600'}`}>
            {call.outcome.replace(/_/g, ' ')}
          </span>
          <span className="text-xs text-gray-400">{formatDuration(call.duration)}</span>
          {call.location && <span className="text-xs text-gray-400">📍 {call.location}</span>}
          {isManual && (
            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Manual</span>
          )}
        </div>
        <div className="text-right text-xs text-gray-400 shrink-0">
          <p>{call.loggedBy.name}</p>
          <p>{callDateStr}</p>
        </div>
      </div>

      {call.notes && (
        <p className="text-sm text-gray-600 mt-2">{call.notes}</p>
      )}
      {call.nextPlanOfAction && (
        <div className="mt-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-1.5">
          <span className="text-xs font-medium text-blue-600">Next Plan: </span>
          <span className="text-xs text-blue-700">{call.nextPlanOfAction}</span>
        </div>
      )}

      {/* Attachments */}
      {call.attachments && call.attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {call.attachments.map((att, i) => (
            <a
              key={i}
              href={att.fileUrl ?? '#'}
              target={att.fileUrl ? '_blank' : '_self'}
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full hover:bg-gray-200 transition-colors"
            >
              <Paperclip size={9} strokeWidth={2} /> {att.type}
            </a>
          ))}
        </div>
      )}

      {/* Recording player */}
      {recordingUrl ? (
        <div className="mt-3">
          <audio controls src={recordingUrl} className="w-full h-9" preload="none" />
        </div>
      ) : (
        <div className="mt-2">
          <button
            onClick={handleRefreshRecording}
            disabled={refreshing}
            className="text-xs text-brand-600 hover:text-brand-700 hover:underline disabled:opacity-50"
          >
            <span className="flex items-center gap-1">
              <RefreshCw size={11} strokeWidth={2} className={refreshing ? 'animate-spin' : ''} />
              {refreshing ? 'Checking…' : 'Fetch recording'}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

interface Props { leadId: string; isLocked?: boolean; onCallLogged?: () => void }

export default function CallLogTab({ leadId, isLocked, onCallLogged }: Props) {
  const lenient = useLenientLaunch();
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [scheduledCalls, setScheduledCalls] = useState<FollowUpTask[]>([]);
  const [rnrCount, setRnrCount] = useState(0);
  const [needsEscalation, setNeedsEscalation] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // "Schedule Call" — a distinct entry point/form from "Log Call" above, for
  // calls that haven't happened yet.
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [completingScheduledCall, setCompletingScheduledCall] = useState<FollowUpTask | null>(null);
  const [scheduledCallAction, setScheduledCallAction] = useState<{ task: FollowUpTask; type: 'not-done' | 'reschedule' } | null>(null);
  const [scheduledCallOutcome, setScheduledCallOutcome] = useState('');
  const [rescheduleDetails, setRescheduleDetails] = useState({ dueDate: '', dueTime: '', reason: '', notifyClient: true });
  const [savingScheduledCallAction, setSavingScheduledCallAction] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({
    stageType: '',
    taskType: 'EXTERNAL',
    dueDate: '',
    dueTime: '',
    agenda: '',
  });
  const [scheduleNotifyClient, setScheduleNotifyClient] = useState(true);

  const [form, setForm] = useState({
    outcome: '',
    duration: '',
    calledAt: '',
    location: '',
    notes: '',
    externalNotes: '',
    dueDate: '',
    dueTime: '',
    // Callback sub-form
    callbackDueDate: '',
    callbackDueTime: '',
    callbackAgenda: '',
    // Meeting-scheduled sub-form
    meetingType: '',
    meetingMode: '',
    meetingScheduledAt: '',
    meetingLocation: '',
  });
  const [meetingNotifyClient, setMeetingNotifyClient] = useState(true);
  const [answeredNotifyClient, setAnsweredNotifyClient] = useState(true);
  const [callbackNotifyClient, setCallbackNotifyClient] = useState(true);
  const [nextPlanItems, setNextPlanItems] = useState<NextPlanItem[]>([]);
  const [selectedAttachmentTypes, setSelectedAttachmentTypes] = useState<string[]>([]);
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const attachmentFileRef = useRef<HTMLInputElement>(null);
  // Task #115 — the mandatory follow-up task sub-form also supports multiple attachments.
  const [taskAttachmentFiles, setTaskAttachmentFiles] = useState<File[]>([]);
  const taskAttachmentFileRef = useRef<HTMLInputElement>(null);
  // External Notes — a single optional attachment, deliberately separate from
  // the categorized attachment selector above (Lifestyle Capture/Proposal/Pitch).
  const [externalNotesFiles, setExternalNotesFiles] = useState<File[]>([]);
  const [pendingMail, setPendingMail] = useState<{ draftKey: string; type?: string; to: string; cc?: string[]; subject: string; html: string } | null>(null);
  const [sendingMail, setSendingMail] = useState(false);
  const [mailSentNotice, setMailSentNotice] = useState<string | null>(null);
  const externalNotesFileRef = useRef<HTMLInputElement>(null);
  const [currentDateTime, setCurrentDateTime] = useState(() => istDatetimeLocalValue(new Date()));

  const todayIST = currentDateTime.slice(0, 10);
  const currentISTTime = currentDateTime.slice(11, 16);
  const minTimeForDate = (date: string) => date === todayIST ? currentISTTime : undefined;
  const isFutureDateTime = (date: string, time: string) => `${date}T${time}` > currentDateTime;

  const loadCalls = async () => {
    try {
      const data = await api.get<{ calls: CallRecord[]; rnrCount: number; needsEscalation: boolean; scheduledCalls: FollowUpTask[] }>(
        `/leads/${leadId}/calls`,
      );
      setCalls(data.calls);
      setRnrCount(data.rnrCount);
      setNeedsEscalation(data.needsEscalation);
      setScheduledCalls(data.scheduledCalls ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadCalls(); }, [leadId]);
  useEffect(() => {
    const refreshNow = () => setCurrentDateTime(istDatetimeLocalValue(new Date()));
    const interval = window.setInterval(refreshNow, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const handleScheduleCall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scheduleForm.stageType) { setError('Please select a stage type'); return; }
    if (!scheduleForm.dueDate || !scheduleForm.dueTime) { setError('Please pick a date and time'); return; }
    if (!isFutureDateTime(scheduleForm.dueDate, scheduleForm.dueTime)) {
      setError('A scheduled call must be set for a future date and time.');
      return;
    }
    setError(null);
    setScheduling(true);
    try {
      const result = await api.post<{
        scheduledCall: unknown;
        pendingMail?: { draftKey: string; to: string; cc?: string[]; subject: string; html: string } | null;
      }>(`/leads/${leadId}/calls/schedule`, {
        stageType: scheduleForm.stageType,
        taskType: scheduleForm.taskType,
        dueDate: scheduleForm.dueDate,
        dueTime: scheduleForm.dueTime,
        agenda: scheduleForm.agenda.trim() || undefined,
        notifyClient: scheduleForm.taskType === 'EXTERNAL' && scheduleNotifyClient,
      });
      setScheduleForm({ stageType: '', taskType: 'EXTERNAL', dueDate: '', dueTime: '', agenda: '' });
      setScheduleNotifyClient(true);
      setShowScheduleForm(false);
      await loadCalls();
      // External scheduled calls generate a client notification draft —
      // open the EmailPreviewModal so the user can review before sending,
      // mirroring the answered-call flow.
      if (result.pendingMail) {
        setPendingMail({
          draftKey: result.pendingMail.draftKey,
          type: 'CALL_SCHEDULED',
          to: result.pendingMail.to,
          cc: result.pendingMail.cc,
          subject: result.pendingMail.subject,
          html: result.pendingMail.html,
        });
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setScheduling(false);
    }
  };

  // Task #115 — attachments support multiple files per category. Each click
  // on a category button adds a new attachment slot (categories can repeat);
  // slots and uploaded files are paired by position, in the order added.
  const addAttachmentType = (type: string) => {
    setSelectedAttachmentTypes((prev) => [...prev, type]);
  };
  const removeAttachmentSlot = (index: number) => {
    setSelectedAttachmentTypes((prev) => prev.filter((_, i) => i !== index));
    setAttachmentFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const resetForm = () => {
    setCallbackNotifyClient(true);
    setForm({
      outcome: '', duration: '', calledAt: '', location: '', notes: '', externalNotes: '', dueDate: '', dueTime: '',
      callbackDueDate: '', callbackDueTime: '', callbackAgenda: '',
      meetingType: '', meetingMode: '', meetingScheduledAt: '', meetingLocation: '',
    });
    setNextPlanItems([]);
    setSelectedAttachmentTypes([]);
    setAttachmentFiles([]);
    setExternalNotesFiles([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.outcome || !form.notes.trim()) return;
    if (form.calledAt && form.calledAt > currentDateTime) {
      setError('The call date and time cannot be in the future.');
      return;
    }
    if (form.outcome === 'CALLBACK' && (!form.callbackDueDate || !form.callbackDueTime)) return;
    if (form.outcome === 'MEETING_SCHEDULED' && (!form.meetingType || !form.meetingMode || !form.meetingScheduledAt)) return;
    const needsFollowUp = !['CALLBACK', 'MEETING_SCHEDULED'].includes(form.outcome);
    // Lenient launch: follow-up may be left empty entirely, but not half-filled.
    const followUpSkipped = lenient && !form.dueDate && !form.dueTime;
    if (needsFollowUp && !followUpSkipped && (!form.dueDate || !form.dueTime)) {
      setError('Set both the follow-up date and time, or clear both to skip it.');
      return;
    }
    if (form.outcome === 'CALLBACK' && !isFutureDateTime(form.callbackDueDate, form.callbackDueTime)) {
      setError('The callback must be set for a future date and time.');
      return;
    }
    if (needsFollowUp && !followUpSkipped && !isFutureDateTime(form.dueDate, form.dueTime)) {
      setError('The follow-up must be set for a future date and time.');
      return;
    }
    if (selectedAttachmentTypes.length !== attachmentFiles.length) {
      setError('Each selected attachment category must have exactly one uploaded file.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // Upload attachment files first if provided (returns storagePath for DB + signedUrl for display)
      const uploadedPaths: string[] = [];
      if (attachmentFiles.length > 0 && selectedAttachmentTypes.length > 0) {
        setUploadingAttachment(true);
        const token = localStorage.getItem('crm_token') ?? '';
        for (const file of attachmentFiles) {
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
        setUploadingAttachment(false);
      }

      // Pair each selected attachment type with an uploaded file (in order)
      const attachments = selectedAttachmentTypes.length > 0
        ? selectedAttachmentTypes.map((type, i) => ({ type, storagePath: uploadedPaths[i] }))
        : undefined;

      // Task #115 — upload the follow-up task's own attachments (no fixed category list).
      let taskAttachments: { type: string; storagePath: string }[] | undefined;
      if (!['CALLBACK', 'MEETING_SCHEDULED'].includes(form.outcome) && taskAttachmentFiles.length > 0) {
        setUploadingAttachment(true);
        const token = localStorage.getItem('crm_token') ?? '';
        taskAttachments = [];
        for (const file of taskAttachmentFiles) {
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
          taskAttachments.push({ type: 'ATTACHMENT', storagePath: uploadData.storagePath });
        }
        setUploadingAttachment(false);
      }

      // Upload the External Notes attachment(s), if provided — independent of
      // the categorized `attachments` upload above.
      const externalNotesAttachments: { fileName: string; storagePath: string }[] = [];
      if (externalNotesFiles.length > 0) {
        setUploadingAttachment(true);
        const token = localStorage.getItem('crm_token') ?? '';
        for (const file of externalNotesFiles) {
          const fd = new FormData();
          fd.append('file', file);
          const uploadResp = await fetch(`${getApiBase()}/leads/${leadId}/calls/upload-attachment`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: fd,
          });
          if (!uploadResp.ok) {
            const err = await uploadResp.json().catch(() => ({}));
            throw new Error(err.error ?? 'External notes attachment upload failed');
          }
          const uploadData = await uploadResp.json();
          externalNotesAttachments.push({ fileName: file.name, storagePath: uploadData.storagePath });
        }
        setUploadingAttachment(false);
      }

      const result = await api.post<{ pendingMail?: { draftKey: string; type: string; to: string; cc?: string[]; subject: string; html: string } | null }>(
        `/leads/${leadId}/calls`,
        {
          outcome: form.outcome,
          duration: form.duration ? Number(form.duration) * 60 : undefined,
          notes: form.notes.trim(),
          externalNotes: form.externalNotes.trim() || undefined,
          externalNotesAttachments,
          calledAt: form.calledAt ? istInputToISO(form.calledAt) : undefined,
          location: form.location.trim() || undefined,
          attachments,
          followUpTask: !['CALLBACK', 'MEETING_SCHEDULED'].includes(form.outcome) && !(lenient && !form.dueDate && !form.dueTime)
            ? { dueDate: form.dueDate, dueTime: form.dueTime, attachments: taskAttachments }
            : undefined,
          callbackDetails: form.outcome === 'CALLBACK'
            ? { dueDate: form.callbackDueDate, dueTime: form.callbackDueTime, agenda: form.callbackAgenda.trim() || undefined }
            : undefined,
          meetingDetails: form.outcome === 'MEETING_SCHEDULED'
            ? { type: form.meetingType, mode: form.meetingMode, scheduledAt: istInputToISO(form.meetingScheduledAt), location: form.meetingLocation.trim() || undefined, notifyClient: meetingNotifyClient }
            : undefined,
          nextPlanOfAction: nextPlanItems.length ? nextPlanItems : undefined,
          notifyClient: form.outcome === 'ANSWERED' ? answeredNotifyClient : form.outcome === 'CALLBACK' ? callbackNotifyClient : undefined,
          scheduledCallId: completingScheduledCall?.id,
        },
      );
      resetForm();
      setTaskAttachmentFiles([]);
      setShowForm(false);
      setCompletingScheduledCall(null);
      await loadCalls();
      onCallLogged?.();
      // Batch 12c: the call-log summary mail is now a draft — open it for
      // review instead of it having already been sent.
      if (result.pendingMail) {
        setPendingMail({
          draftKey: result.pendingMail.draftKey,
          to: result.pendingMail.to,
          cc: result.pendingMail.cc,
          subject: result.pendingMail.subject,
          html: result.pendingMail.html,
          type: result.pendingMail.type,
        });
      }
    } catch (e: any) {
      setError(e.message);
      setUploadingAttachment(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCompleteScheduledCall = (task: FollowUpTask) => {
    setError(null);
    setShowScheduleForm(false);
    setScheduledCallAction(null);
    setCompletingScheduledCall(task);
    setShowForm(true);
    window.setTimeout(() => document.getElementById('log-call-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };

  const handleScheduledCallAction = async () => {
    if (!scheduledCallAction) return;
    const { task, type } = scheduledCallAction;
    if (type === 'not-done' && !scheduledCallOutcome.trim()) {
      setError('Please add a reason for why the call was not completed.');
      return;
    }
    if (type === 'reschedule' && (!rescheduleDetails.dueDate || !rescheduleDetails.dueTime || !rescheduleDetails.reason.trim())) {
      setError('Please provide the new date, time, and reason for rescheduling.');
      return;
    }
    if (type === 'reschedule' && !isFutureDateTime(rescheduleDetails.dueDate, rescheduleDetails.dueTime)) {
      setError('The rescheduled call must be set for a future date and time.');
      return;
    }

    setSavingScheduledCallAction(true);
    setError(null);
    try {
      if (type === 'not-done') {
        await api.patch(`/tasks/${task.id}/not-done`, { outcome: scheduledCallOutcome.trim() });
      } else {
        const result = await api.patch<{
          pendingMail?: { draftKey: string; type: string; to: string; cc?: string[]; subject: string; html: string } | null;
        }>(`/tasks/${task.id}/reschedule`, {
          dueDate: rescheduleDetails.dueDate,
          dueTime: rescheduleDetails.dueTime,
          reason: rescheduleDetails.reason.trim(),
          notifyClient: task.taskType === 'EXTERNAL' && rescheduleDetails.notifyClient,
        });
        if (result.pendingMail) {
          setPendingMail(result.pendingMail);
        }
      }
      setScheduledCallAction(null);
      setScheduledCallOutcome('');
      setRescheduleDetails({ dueDate: '', dueTime: '', reason: '', notifyClient: true });
      await loadCalls();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingScheduledCallAction(false);
    }
  };

  const handleSendPendingMail = async (subject: string, html: string) => {
    if (!pendingMail) return;
    setSendingMail(true);
    try {
      await api.post('/email/send-draft', { draftKey: pendingMail.draftKey, to: pendingMail.to, subject, html });
      setMailSentNotice(`Call summary mail sent to ${pendingMail.to}`);
      setPendingMail(null);
      setTimeout(() => setMailSentNotice(null), 4000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSendingMail(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Escalation banner */}
      {needsEscalation && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex gap-3">
          <AlertTriangle size={18} strokeWidth={2} className="text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-red-700">Escalation Required</p>
            <p className="text-sm text-red-600 mt-0.5">
              This lead has {rnrCount} RNR attempts. Please escalate to your Business Lead for review.
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Call Log</h2>
          <p className="text-sm text-gray-500">
            {calls.length} total · {calls.filter((c) => c.outcome === 'ANSWERED').length} answered ·{' '}
            {rnrCount} RNR ·{' '}
            {calls.filter((c) => c.outcome === 'CALLBACK').length} callback ·{' '}
            {calls.filter((c) => c.outcome === 'MEETING_SCHEDULED').length} meeting scheduled
          </p>
        </div>
        {!isLocked && (
          <div className="flex gap-2">
            <button
              onClick={() => { setShowScheduleForm(false); setShowForm(!showForm); }}
              className="bg-brand-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-600 transition-colors"
            >
              {showForm ? 'Cancel' : '+ Log Call'}
            </button>
            <button
              onClick={() => { setShowForm(false); setShowScheduleForm(!showScheduleForm); }}
              className="bg-white border border-brand-300 text-brand-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-50 transition-colors"
            >
              {showScheduleForm ? 'Cancel' : '+ Schedule Call'}
            </button>
          </div>
        )}
      </div>

      {/* Schedule Call Form — distinct entry point for a call that hasn't happened yet */}
      {!isLocked && showScheduleForm && (
        <form onSubmit={handleScheduleCall} className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <h3 className="font-medium text-gray-900">Schedule a Call</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Agenda</label>
              <input
                type="text"
                value={scheduleForm.agenda}
                onChange={(e) => setScheduleForm({ ...scheduleForm, agenda: e.target.value })}
                placeholder="What's this call for…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Stage Type <span className="text-red-500">*</span>
              </label>
              <select
                value={scheduleForm.stageType}
                onChange={(e) => setScheduleForm({ ...scheduleForm, stageType: e.target.value })}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              >
                <option value="">Select…</option>
                {CALL_STAGE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Internal / External <span className="text-red-500">*</span>
              </label>
              <select
                value={scheduleForm.taskType}
                onChange={(e) => setScheduleForm({ ...scheduleForm, taskType: e.target.value })}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              >
                <option value="EXTERNAL">External (with client)</option>
                <option value="INTERNAL">Internal</option>
              </select>
            </div>
            {scheduleForm.taskType === 'EXTERNAL' && (
              <label className="col-span-2 flex items-start gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2.5 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={scheduleNotifyClient}
                  onChange={(e) => setScheduleNotifyClient(e.target.checked)}
                  className="mt-0.5 accent-brand-500"
                />
                <span>
                  <span className="font-medium">Notify client by email</span>
                  <span className="block text-xs text-gray-500 mt-0.5">A scheduled-call email will open for your review after saving.</span>
                </span>
              </label>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Date <span className="text-red-500">*</span>
              </label>
              <DateInput
                value={scheduleForm.dueDate}
                onChange={(v) => setScheduleForm({ ...scheduleForm, dueDate: v })}
                        min={todayIST}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Time <span className="text-red-500">*</span>
              </label>
              <TimeInput
                value={scheduleForm.dueTime}
                onChange={(v) => setScheduleForm({ ...scheduleForm, dueTime: v })}
                        min={minTimeForDate(scheduleForm.dueDate)}
                required
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowScheduleForm(false)}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={scheduling}
              className="bg-brand-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
            >
              {scheduling ? 'Scheduling…' : 'Schedule Call'}
            </button>
          </div>
        </form>
      )}

      {isLocked && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-700">
          This lead is Inactive — reactivate it to log a new call.
        </div>
      )}

      {/* Log Call Form */}
      {!isLocked && showForm && (
        <form id="log-call-form" onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <h3 className="font-medium text-gray-900">Log a Call</h3>
          {completingScheduledCall && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Completing the scheduled {completingScheduledCall.callStageType} call
              {completingScheduledCall.agenda ? ` · Agenda: ${completingScheduledCall.agenda}` : ''}.
              Saving this call log will mark the scheduled call as completed.
            </div>
          )}

          {/* Row 1: Outcome + Duration */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Outcome <span className="text-red-500">*</span>
              </label>
              <select
                value={form.outcome}
                onChange={(e) => setForm({ ...form, outcome: e.target.value })}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              >
                <option value="">Select outcome…</option>
                {OUTCOMES.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Duration (minutes)</label>
              <input
                type="number"
                min="0"
                value={form.duration}
                onChange={(e) => setForm({ ...form, duration: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                placeholder="0"
              />
            </div>
          </div>

          {/* Row 2: Date + Time of call */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date & Time of Call</label>
              <DateTimeInput
                value={form.calledAt}
                onChange={(v) => setForm({ ...form, calledAt: v })}
                max={currentDateTime}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
              <input
                type="text"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder="e.g. Office, Virtual…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>
          </div>

          {/* Attachments — now occupies the slot the free-text Agenda field used to.
              Task #115: multiple attachments are allowed, including repeats of the
              same category — clicking a category adds another slot rather than
              toggling a single one. */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Attachments</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {ATTACHMENT_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => addAttachmentType(type)}
                  className="text-xs px-3 py-1 rounded-full border border-gray-200 text-gray-500 hover:border-brand-300 hover:text-brand-700"
                >
                  + {type}
                </button>
              ))}
            </div>
            {selectedAttachmentTypes.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex flex-wrap gap-1.5">
                  {selectedAttachmentTypes.map((type, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-xs bg-brand-50 border border-brand-200 text-brand-700 px-2 py-0.5 rounded-full">
                      {type}{attachmentFiles[i] ? `: ${attachmentFiles[i].name}` : ' (no file yet)'}
                      <button type="button" onClick={() => removeAttachmentSlot(i)} className="text-brand-400 hover:text-red-400">
                        <X size={10} strokeWidth={2} />
                      </button>
                    </span>
                  ))}
                </div>
                <label className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-dashed w-fit transition-colors ${
                  attachmentFiles.length >= selectedAttachmentTypes.length
                    ? 'border-gray-200 text-gray-300 cursor-not-allowed'
                    : 'border-gray-300 text-gray-600 cursor-pointer hover:border-brand-400'
                }`}>
                  <Paperclip size={11} strokeWidth={2} />
                  Upload file ({attachmentFiles.length}/{selectedAttachmentTypes.length})
                  <input
                    ref={attachmentFileRef}
                    type="file"
                    multiple
                    disabled={attachmentFiles.length >= selectedAttachmentTypes.length}
                    className="hidden"
                    onChange={(e) => {
                      const remaining = selectedAttachmentTypes.length - attachmentFiles.length;
                      const picked = Array.from(e.target.files ?? []).slice(0, Math.max(remaining, 0));
                      setAttachmentFiles((prev) => [...prev, ...picked]);
                      e.target.value = '';
                    }}
                  />
                </label>
                {attachmentFiles.length < selectedAttachmentTypes.length && (
                  <p className="text-[11px] text-amber-600">
                    Upload {selectedAttachmentTypes.length - attachmentFiles.length} more file(s) to match the added attachment slots, or remove a slot.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* External Notes — the only content that reaches the client's auto-mail on an Answered call */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">External Notes</label>
            <textarea
              rows={2}
              value={form.externalNotes}
              onChange={(e) => setForm({ ...form, externalNotes: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              placeholder="What the client should see in the call summary email…"
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {externalNotesFiles.map((f, idx) => (
                <span key={`${f.name}-${idx}`} className="inline-flex items-center gap-1.5 text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded-lg">
                  <Paperclip size={11} strokeWidth={2} />
                  {f.name}
                  <button type="button" onClick={() => setExternalNotesFiles(externalNotesFiles.filter((_, i) => i !== idx))} className="text-gray-400 hover:text-gray-600">
                    <X size={11} strokeWidth={2} />
                  </button>
                </span>
              ))}
              <label className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-dashed border-gray-300 text-gray-600 cursor-pointer hover:border-brand-400 w-fit">
                <Paperclip size={11} strokeWidth={2} />
                Add attachment
                <input
                  ref={externalNotesFileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []);
                    if (picked.length > 0) setExternalNotesFiles([...externalNotesFiles, ...picked]);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
            {form.outcome === 'ANSWERED' && (
              <label className="flex items-center gap-2 text-sm text-gray-700 mt-2">
                <input
                  type="checkbox"
                  checked={answeredNotifyClient}
                  onChange={(e) => setAnsweredNotifyClient(e.target.checked)}
                  className="rounded border-gray-300 text-brand-500 focus:ring-brand-400"
                />
                Send call summary email to client
              </label>
            )}
          </div>

          {/* Outcome-specific sub-forms */}
          {form.outcome === 'CALLBACK' && (
            <div className="border-t border-gray-100 pt-4">
              <p className="text-sm font-medium text-gray-700 mb-2">
                Callback Details <span className="text-red-500">*</span>
              </p>
              <div className="grid grid-cols-2 gap-3">
                <DateInput
                  value={form.callbackDueDate}
                  onChange={(v) => setForm({ ...form, callbackDueDate: v })}
                  min={todayIST}
                  required
                />
                <TimeInput
                  value={form.callbackDueTime}
                  onChange={(v) => setForm({ ...form, callbackDueTime: v })}
                  min={minTimeForDate(form.callbackDueDate)}
                  required
                />
                <input
                  type="text"
                  value={form.callbackAgenda}
                  onChange={(e) => setForm({ ...form, callbackAgenda: e.target.value })}
                  placeholder="Agenda for the callback…"
                  className="col-span-2 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
                <input
                  type="checkbox"
                  checked={callbackNotifyClient}
                  onChange={(e) => setCallbackNotifyClient(e.target.checked)}
                  className="rounded border-gray-300 text-brand-500 focus:ring-brand-400"
                />
                Notify client by email
              </label>
              <p className="text-xs text-gray-400 mt-1">A scheduled-call email will open for your review after saving. A follow-up call task will be created automatically and linked back to this call.</p>
            </div>
          )}

          {form.outcome === 'MEETING_SCHEDULED' && (
            <div className="border-t border-gray-100 pt-4">
              <p className="text-sm font-medium text-gray-700 mb-2">
                Meeting Details <span className="text-red-500">*</span>
              </p>
              <div className="grid grid-cols-2 gap-3">
                <select
                  value={form.meetingType}
                  onChange={(e) => setForm({ ...form, meetingType: e.target.value })}
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                >
                  <option value="">Type…</option>
                  {MEETING_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <select
                  value={form.meetingMode}
                  onChange={(e) => setForm({ ...form, meetingMode: e.target.value })}
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                >
                  <option value="">Mode…</option>
                  {MEETING_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
                <DateTimeInput
                  value={form.meetingScheduledAt}
                  onChange={(v) => setForm({ ...form, meetingScheduledAt: v })}
                  required
                />
                <input
                  type="text"
                  value={form.meetingLocation}
                  onChange={(e) => setForm({ ...form, meetingLocation: e.target.value })}
                  maxLength={250}
                  placeholder="Meeting venue or virtual link"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
                <input
                  type="checkbox"
                  checked={meetingNotifyClient}
                  onChange={(e) => setMeetingNotifyClient(e.target.checked)}
                  className="rounded border-gray-300 text-brand-500 focus:ring-brand-400"
                />
                Send confirmation email to client
              </label>
              <p className="text-xs text-gray-400 mt-1">A meeting will be created automatically and linked back to this call.</p>
            </div>
          )}

          {!['CALLBACK', 'MEETING_SCHEDULED'].includes(form.outcome) && (
            <div className="border-t border-gray-100 pt-4">
              <p className="text-sm font-medium text-gray-700 mb-2">
                Follow-up / Task {!lenient && <span className="text-red-500">*</span>}
                <span className="text-xs font-normal text-gray-400 ml-1">{lenient ? '(optional)' : '(mandatory)'}</span>
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Due Date</label>
                  <DateInput
                    value={form.dueDate}
                    onChange={(v) => setForm({ ...form, dueDate: v })}
                    min={todayIST}
                    required={!lenient}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Due Time {!lenient && <span className="text-red-500">*</span>}</label>
                  <TimeInput
                    value={form.dueTime}
                    onChange={(v) => setForm({ ...form, dueTime: v })}
                    min={minTimeForDate(form.dueDate)}
                    required={!lenient}
                  />
                </div>
              </div>
              <div className="mt-3">
                <label className="block text-xs text-gray-500 mb-1">Attachments</label>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-dashed border-gray-300 text-gray-600 cursor-pointer hover:border-brand-400 w-fit">
                    <Paperclip size={11} strokeWidth={2} />
                    Add attachment(s)
                    <input
                      ref={taskAttachmentFileRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const picked = Array.from(e.target.files ?? []);
                        setTaskAttachmentFiles((prev) => [...prev, ...picked]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {taskAttachmentFiles.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {taskAttachmentFiles.map((f, i) => (
                        <span key={i} className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                          {f.name}
                          <button type="button" onClick={() => setTaskAttachmentFiles((prev) => prev.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-400">
                            <X size={10} strokeWidth={2} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="border-t border-gray-100 pt-4">
            {/* Internal Notes — staff-only, sent to the internal project team, never to the client */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Internal Notes <span className="text-red-500">*</span>
              </label>
              <textarea
                rows={2}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                placeholder="Notes for the internal project team… (never sent to the client)"
              />
            </div>
            <NextPlanOfActionPicker items={nextPlanItems} onChange={setNextPlanItems} />
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <button
            type="submit"
            disabled={submitting || uploadingAttachment}
            className="w-full bg-brand-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
          >
            {uploadingAttachment ? 'Uploading attachment…' : submitting ? 'Saving…' : 'Save Call'}
          </button>
        </form>
      )}

      {/* Scheduled Calls — calls not yet made, clearly separate from the logged-call list below */}
      {!loading && scheduledCalls.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Scheduled Calls</p>
          {scheduledCalls.map((task) => (
            <div key={task.id} className="bg-amber-50 border border-amber-200 rounded-xl p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded">
                      Scheduled
                    </span>
                    <span className="text-sm font-medium text-gray-900">{task.callStageType} call</span>
                    <span className="text-xs text-gray-500">
                      {task.taskType === 'INTERNAL' ? 'Internal' : 'External'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {formatISTDate(task.dueDate)}{task.dueTime ? ` at ${task.dueTime}` : ''}
                    {task.agenda ? ` · ${task.agenda}` : ''}
                  </p>
                </div>
                {!isLocked && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <button type="button" onClick={() => handleCompleteScheduledCall(task)}
                      className="rounded-md bg-brand-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-600">
                      Complete & log
                    </button>
                    <button type="button" onClick={() => { setScheduledCallAction({ task, type: 'not-done' }); setScheduledCallOutcome(''); setError(null); }}
                      className="rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                      Not completed
                    </button>
                    <button type="button" onClick={() => { setScheduledCallAction({ task, type: 'reschedule' }); setRescheduleDetails({ dueDate: '', dueTime: '', reason: '', notifyClient: true }); setError(null); }}
                      className="rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100">
                      Reschedule
                    </button>
                  </div>
                )}
              </div>
              {scheduledCallAction?.task.id === task.id && (
                <div className="mt-3 border-t border-amber-200 pt-3">
                  {scheduledCallAction.type === 'not-done' ? (
                    <div className="space-y-2">
                      <label className="block text-xs font-medium text-gray-700">Why was this call not completed?</label>
                      <textarea value={scheduledCallOutcome} onChange={(e) => setScheduledCallOutcome(e.target.value)} rows={2}
                        placeholder="Add the reason…" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400" />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <DateInput value={rescheduleDetails.dueDate} onChange={(dueDate) => setRescheduleDetails({ ...rescheduleDetails, dueDate })} min={todayIST} required />
                        <TimeInput value={rescheduleDetails.dueTime} onChange={(dueTime) => setRescheduleDetails({ ...rescheduleDetails, dueTime })} min={minTimeForDate(rescheduleDetails.dueDate)} required />
                      </div>
                      <textarea value={rescheduleDetails.reason} onChange={(e) => setRescheduleDetails({ ...rescheduleDetails, reason: e.target.value })} rows={2}
                        placeholder="Reason for rescheduling…" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400" />
                      {task.taskType === 'EXTERNAL' && (
                        <label className="flex items-center gap-2 text-xs text-gray-700">
                          <input type="checkbox" checked={rescheduleDetails.notifyClient}
                            onChange={(e) => setRescheduleDetails({ ...rescheduleDetails, notifyClient: e.target.checked })} />
                          Notify client by email
                        </label>
                      )}
                    </div>
                  )}
                  <div className="mt-2 flex justify-end gap-2">
                    <button type="button" onClick={() => setScheduledCallAction(null)}
                      className="px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-amber-100 rounded-md">Cancel</button>
                    <button type="button" onClick={handleScheduledCallAction} disabled={savingScheduledCallAction}
                      className="rounded-md bg-brand-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50">
                      {savingScheduledCallAction ? 'Saving…' : scheduledCallAction.type === 'not-done' ? 'Save status' : 'Confirm reschedule'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Call List */}
      {loading ? (
        <div className="text-center py-10 text-gray-400 text-sm animate-pulse">Loading calls…</div>
      ) : calls.length === 0 ? (
        <div className="text-center py-10 text-gray-400 text-sm">No calls logged yet</div>
      ) : (
        <div className="space-y-2">
          {calls.map((call) => (
            <CallCard key={call.id} call={call} onRecordingRefresh={(url) => {
              setCalls((prev) => prev.map((c) => c.id === call.id ? { ...c, recordingUrl: url } : c));
            }} />
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
          title={pendingMail.type === 'CALL_SCHEDULED'
            ? 'Review Scheduled Call Email'
            : pendingMail.type === 'CALL_RESCHEDULED'
              ? 'Review Rescheduled Call Email'
              : pendingMail.type === 'EXTERNAL_TASK'
                ? 'Review Follow-up Email'
              : 'Review Call Summary Email'}
          defaultSubject={pendingMail.subject}
          defaultHtml={pendingMail.html}
          recipientLabel={pendingMail.cc?.length ? `${pendingMail.to} (cc: ${pendingMail.cc.join(', ')})` : pendingMail.to}
          sending={sendingMail}
          onSend={handleSendPendingMail}
          onClose={() => setPendingMail(null)}
        />
      )}
    </div>
  );
}
