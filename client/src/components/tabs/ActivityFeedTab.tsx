import { useLenientLaunch } from '../../lib/flags';
/**
 * ActivityFeedTab — combined chronological feed of Calls, Meetings, and Tasks.
 *
 * Creation forms are delegated to the existing tab components rendered as
 * sub-views (no duplication of form logic). Meeting status updates (Complete /
 * Reschedule / No-show) and task actions (Complete / Reschedule / Not-Done)
 * are handled inline with modals so the user never has to leave the feed to
 * manage an existing item.
 *
 * Sort timestamp per type:
 *   Call    → calledAt ?? createdAt  (when the call happened / was logged)
 *   Meeting → scheduledAt             (when it is / was scheduled)
 *   Task    → completedAt ?? createdAt (when acted on / created)
 *
 * ChatTab and the Audit Log are untouched — they live on the 'audit' tab.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import MeetingLocationField from '../MeetingLocationField';
import toast from 'react-hot-toast';
import { ChevronLeft, Paperclip, RefreshCw, X } from 'lucide-react';
import { api, type CallRecord, type Meeting, type FollowUpTask } from '../../lib/api';
import { formatISTDate, formatISTDateTime, formatTime12, istInputToISO } from '../../lib/dateFormat';
import { DateInput, DateTimeInput, TimeInput } from '../ui/DateTimeInputs';
import EmailPreviewModal from '../EmailPreviewModal';
import CallLogTab from './CallLogTab';
import MeetingsTab from './MeetingsTab';
import FollowUpTab from './FollowUpTab';
import { meetingModeOptions, meetingModeLabel, meetingRules } from '../../lib/meetingSettings';

// ── Constants (mirrors the originals in each tab component) ──────────────────

function getApiBase() {
  return (import.meta as any).env?.VITE_API_BASE ?? '/api';
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

const MEETING_STATUS_COLORS: Record<string, string> = {
  SCHEDULED: 'bg-blue-100 text-blue-700',
  COMPLETED: 'bg-green-100 text-green-700',
  RESCHEDULED: 'bg-amber-100 text-amber-700',
  NO_SHOW: 'bg-red-100 text-red-700',
};


const LOCATION_OPTIONS: Record<string, string> = {
  EC_VISIT: 'EC Visit',
  SITE_VISIT: 'Site Visit',
  VIRTUAL: 'Virtual',
  PUBLIC_PLACE: 'Public Place',
};
const RESCHEDULE_LOCATION_OPTIONS = ['Office', "Client's Site", 'Public Place', "Client's Place", 'Virtual'];

const MOM_ATTACHMENT_TYPES = ['Floor Plan', 'Proposal', 'Lifestyle Sheet', 'Other'] as const;


function formatDuration(secs?: number) {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

/** Derive a human label like "DQL Meeting", "OB 2", "PP" from a meeting + the full list. */
function meetingLabel(m: Meeting, allMeetings: Meeting[]) {
  const seq = m.seqNumber ?? 1;
  const typeMap: Record<string, string> = { DQL: 'DQL', PP: 'PP', ONBOARDING: 'OB' };
  const abbrev = typeMap[m.type] ?? m.type;
  const showNum = allMeetings.filter((x) => x.type === m.type).length > 1;
  if (showNum) return `${abbrev} ${seq}`;
  if (abbrev === 'DQL') return 'DQL Meeting';
  if (abbrev === 'OB') return 'Onboarding Meeting';
  return abbrev;
}

// ── Mini KPI card (matches the Meetings page KPI-row pattern) ────────────────

function MiniKpi({
  label,
  value,
  color,
  active,
  onClick,
}: {
  label: string;
  value: number;
  color?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`Show ${label.toLowerCase()} activity`}
      className={`text-left rounded-xl border shadow-sm px-3 py-2.5 flex flex-col gap-0.5 transition-colors ${
        active
          ? 'bg-brand-50 border-brand-300 ring-1 ring-brand-200'
          : 'bg-white border-stone-100 hover:border-brand-200 hover:bg-brand-50/40'
      }`}
    >
      <span className={`text-lg font-bold leading-none ${color ?? 'text-stone-800'}`}>{value}</span>
      <span className="text-[11px] text-stone-500">{label}</span>
    </button>
  );
}

// ── Feed item type ────────────────────────────────────────────────────────────

type FeedItem =
  | { kind: 'call';    sortTs: number; data: CallRecord }
  | { kind: 'meeting'; sortTs: number; data: Meeting }
  | { kind: 'task';    sortTs: number; data: FollowUpTask };

// ── Sub-view type (for creation forms) ───────────────────────────────────────

type SubView = 'log-call' | 'book-meeting' | 'log-meeting' | 'add-task';

// ── Inline CallCard (display-only, mirrors CallLogTab.CallCard) ───────────────

function CallCard({ call }: { call: CallRecord }) {
  const [refreshing, setRefreshing] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState(call.recordingUrl ?? null);

  const handleRefreshRecording = async () => {
    setRefreshing(true);
    try {
      const data = await api.get<{ recordingUrl: string | null }>(`/calls/${call.id}/recording-url`);
      if (data.recordingUrl) setRecordingUrl(data.recordingUrl);
    } catch {
      /* silent */
    } finally {
      setRefreshing(false);
    }
  };

  const callDateStr = call.calledAt ? formatISTDateTime(call.calledAt) : formatISTDate(call.createdAt);

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-sky-100 text-sky-700">📞 Call</span>
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${OUTCOME_COLORS[call.outcome] ?? 'bg-gray-100 text-gray-600'}`}>
            {call.outcome.replace(/_/g, ' ')}
          </span>
          <span className="text-xs text-gray-400">{formatDuration(call.duration)}</span>
          {call.location && <span className="text-xs text-gray-400">📍 {call.location}</span>}
          {!call.recordingUrl && (
            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Manual</span>
          )}
        </div>
        <div className="text-right text-xs text-gray-400 shrink-0">
          <p>{call.loggedBy.name}</p>
          <p>{callDateStr}</p>
        </div>
      </div>
      {call.notes && <p className="text-sm text-gray-600 mt-2">{call.notes}</p>}
      {call.nextPlanOfAction && (
        <div className="mt-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-1.5">
          <span className="text-xs font-medium text-blue-600">Next Plan: </span>
          <span className="text-xs text-blue-700">{call.nextPlanOfAction}</span>
        </div>
      )}
      {call.attachments && call.attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {call.attachments.map((att, i) => (
            <a key={i} href={att.fileUrl ?? '#'} target={att.fileUrl ? '_blank' : '_self'} rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full hover:bg-gray-200 transition-colors">
              <Paperclip size={9} strokeWidth={2} /> {att.type}
            </a>
          ))}
        </div>
      )}
      {recordingUrl ? (
        <div className="mt-3"><audio controls src={recordingUrl} className="w-full h-9" preload="none" /></div>
      ) : (
        <div className="mt-2">
          <button onClick={handleRefreshRecording} disabled={refreshing}
            className="text-xs text-brand-600 hover:text-brand-700 hover:underline disabled:opacity-50 flex items-center gap-1">
            <RefreshCw size={11} strokeWidth={2} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Checking…' : 'Fetch recording'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Meeting card (feed display + inline action buttons) ───────────────────────

function MeetingCard({
  meeting, allMeetings, isLocked,
  onAction,
}: {
  meeting: Meeting;
  allMeetings: Meeting[];
  isLocked?: boolean;
  onAction: (meeting: Meeting, status: 'COMPLETED' | 'RESCHEDULED' | 'NO_SHOW') => void;
}) {
  const label = meetingLabel(meeting, allMeetings);
  const scheduledStr = new Date(meeting.scheduledAt).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">📅 Meeting</span>
            <span className="font-medium text-gray-900 text-sm">{label}</span>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${MEETING_STATUS_COLORS[meeting.status] ?? 'bg-gray-100 text-gray-600'}`}>
              {meeting.status}
            </span>
          </div>
          <p className="text-xs text-gray-500">{scheduledStr}</p>
          <p className="text-xs text-gray-400 mt-0.5">{meetingModeLabel(meeting.mode)}</p>
        </div>
        {meeting.status === 'SCHEDULED' && !isLocked && (
          <div className="flex gap-2 shrink-0">
            <button onClick={() => onAction(meeting, 'COMPLETED')}
              className="text-xs bg-green-50 text-green-700 border border-green-200 px-2.5 py-1 rounded-lg hover:bg-green-100 transition-colors">
              Complete
            </button>
            <button onClick={() => onAction(meeting, 'RESCHEDULED')}
              className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-1 rounded-lg hover:bg-amber-100 transition-colors">
              Reschedule
            </button>
            <button onClick={() => onAction(meeting, 'NO_SHOW')}
              className="text-xs bg-red-50 text-red-700 border border-red-200 px-2.5 py-1 rounded-lg hover:bg-red-100 transition-colors">
              No-show
            </button>
          </div>
        )}
      </div>
      {meeting.rescheduleHistory && meeting.rescheduleHistory.length > 0 && (
        <div className="mt-2 space-y-1">
          {meeting.rescheduleHistory.map((h, i) => (
            <div key={i} className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-1.5">
              <span className="font-medium">Reschedule {i + 1}:</span>{' '}
              was {new Date(h.scheduledAt).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
                hour: '2-digit', minute: '2-digit',
              })} — {h.reason}
            </div>
          ))}
        </div>
      )}
      {meeting.noShowReason && (
        <p className="text-xs text-red-600 mt-2 bg-red-50 rounded-lg px-3 py-1.5">No-show reason: {meeting.noShowReason}</p>
      )}
      {meeting.status === 'NO_SHOW' && meeting.replanScheduledAt && (
        <p className="text-xs text-blue-700 mt-2 bg-blue-50 rounded-lg px-3 py-1.5">
          Next tentative replan: {formatISTDateTime(meeting.replanScheduledAt)}
          {meeting.replanMode ? ` · ${meetingModeLabel(meeting.replanMode)}` : ''}
          {meeting.replanLocation ? ` · ${meeting.replanLocation}` : ''}
        </p>
      )}
      {meeting.location && (
        <p className="text-xs text-gray-400 mt-1">📍 {LOCATION_OPTIONS[meeting.location] ?? meeting.location}</p>
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
    </div>
  );
}

// ── Task card (feed display + inline action buttons) ──────────────────────────

function TaskCard({
  task, isLocked,
  onAction,
}: {
  task: FollowUpTask;
  isLocked?: boolean;
  onAction: (task: FollowUpTask, kind: 'complete' | 'not-done' | 'reschedule') => void;
}) {
  const isScheduledCall = Boolean(task.callStageType);
  const statusBadge = () => {
    switch (task.status) {
      case 'COMPLETED':  return <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-green-100 text-green-700">Done</span>;
      case 'NOT_DONE':   return <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-gray-200 text-gray-600">Not Done</span>;
      case 'RESCHEDULED': return <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">Rescheduled</span>;
      default:
        return task.isOverdue
          ? <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-red-100 text-red-700">Overdue</span>
          : <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">Upcoming</span>;
    }
  };

  const cardCls = task.status === 'COMPLETED' ? 'bg-green-50 border-green-200'
    : task.status === 'NOT_DONE' ? 'bg-gray-50 border-gray-200'
    : task.isOverdue ? 'bg-red-50 border-red-200'
    : 'bg-white border-gray-200';

  return (
    <div className={`border rounded-xl p-4 ${cardCls}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            isScheduledCall ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'
          }`}>
            {isScheduledCall ? '☎ Call Scheduled' : '✓ Task'}
          </span>
          {statusBadge()}
          <div>
            <p className="text-sm font-medium text-gray-900">
              {formatISTDate(task.dueDate, { weekday: 'short' })}
              {(task.timeFrom || task.dueTime) && (
                <span className="text-gray-500 ml-1">
                  at {formatTime12(task.timeFrom ?? task.dueTime)}{task.timeTo ? `–${formatTime12(task.timeTo)}` : ''}
                </span>
              )}
              {task.taskType === 'EXTERNAL' && (
                <span className="ml-1.5 text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full">External</span>
              )}
            </p>
            {task.agenda && <p className="text-xs text-gray-500 italic">{task.agenda}</p>}
            {task.internalNotes && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded px-1.5 py-0.5 mt-0.5">🔒 {task.internalNotes}</p>
            )}
            <p className="text-xs text-gray-400">Assigned to {task.assignedTo.name}</p>
          </div>
        </div>
        {task.status === 'PENDING' && !isLocked && (
          <div className="flex gap-2">
            <button onClick={() => onAction(task, 'complete')}
              className="text-xs bg-green-50 text-green-700 border border-green-200 px-2.5 py-1.5 rounded-lg hover:bg-green-100 transition-colors">
              Complete
            </button>
            <button onClick={() => onAction(task, 'reschedule')}
              className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-1.5 rounded-lg hover:bg-amber-100 transition-colors">
              Reschedule
            </button>
            <button onClick={() => onAction(task, 'not-done')}
              className="text-xs bg-gray-100 text-gray-600 border border-gray-200 px-2.5 py-1.5 rounded-lg hover:bg-gray-200 transition-colors">
              Not Done
            </button>
          </div>
        )}
        {task.status === 'COMPLETED' && task.completedAt && (
          <p className="text-xs text-gray-400">Completed {formatISTDate(task.completedAt)}</p>
        )}
      </div>
      {task.outcome && (
        <div className="mt-2 bg-gray-50 rounded-lg px-3 py-2">
          <p className="text-xs font-medium text-gray-500 mb-0.5">Reason</p>
          <p className="text-xs text-gray-700">{task.outcome}</p>
        </div>
      )}
      {task.attachments && task.attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {task.attachments.map((att, i) =>
            att.fileUrl ? (
              <a key={i} href={att.fileUrl} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs bg-brand-50 text-brand-700 border border-brand-200 px-2 py-1 rounded-lg hover:bg-brand-100 transition-colors">
                <Paperclip size={11} strokeWidth={2} /> {att.fileName ?? `Attachment ${i + 1}`}
              </a>
            ) : (
              <span key={i} className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-400 px-2 py-1 rounded-lg">
                <Paperclip size={11} strokeWidth={2} /> Attachment unavailable
              </span>
            )
          )}
        </div>
      )}
      {task.rescheduleHistory && task.rescheduleHistory.length > 0 && (
        <div className="mt-2 space-y-1">
          {task.rescheduleHistory.map((h, i) => (
            <div key={i} className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-1.5">
              <span className="font-medium">Reschedule {i + 1}:</span>{' '}
              was {formatISTDate(h.dueDate)}{h.dueTime ? ` at ${formatTime12(h.dueTime)}` : ''} — {h.reason}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface ActivityBreakdown {
  calls:    { answered: number; rnr: number; callback: number; meetingScheduled: number; total: number };
  meetings: { scheduled: number; completed: number; noShow: number; rescheduled: number; total: number };
  tasks:    { pending: number; overdue: number; completed: number; total: number };
}

interface Props {
  leadId: string;
  clientEmail?: string | null;
  isLocked?: boolean;
  breakdown?: ActivityBreakdown | null;
  onCallLogged?: () => void;
  onMeetingCreated?: () => void;
  onMeetingCompleted?: (type: string) => void;
  onTasksChanged?: () => void;
}

export default function ActivityFeedTab({
  leadId, clientEmail, isLocked, breakdown,
  onCallLogged, onMeetingCreated, onMeetingCompleted, onTasksChanged,
}: Props) {
  const lenient = useLenientLaunch();
  // ── Feed data ──
  const [items, setItems] = useState<FeedItem[]>([]);
  const [allMeetings, setAllMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [activeKpiFilter, setActiveKpiFilter] = useState<string | null>(null);

  // ── Sub-view navigation (for creation forms) ──
  const [subView, setSubView] = useState<SubView | null>(null);

  // ── Meeting status modal ──
  const [statusModal, setStatusModal] = useState<{
    meetingId: string; meetingType: string;
    status: 'COMPLETED' | 'RESCHEDULED' | 'NO_SHOW';
    originalLocation?: string | null;
  } | null>(null);
  const [statusForm, setStatusForm] = useState({
    mom: '', rescheduledReason: '', newScheduledAt: '', rescheduleMode: '', rescheduleLocation: '', noShowReason: '',
    replanScheduledAt: '', replanMode: '', replanLocation: '',
  });
  const [momAttachmentTypes, setMomAttachmentTypes] = useState<string[]>([]);
  const [momFiles, setMomFiles] = useState<File[]>([]);
  const momFileRef = useRef<HTMLInputElement>(null);
  const [statusSubmitting, setStatusSubmitting] = useState(false);

  // ── Task action modal ──
  const [actionModal, setActionModal] = useState<{
    taskId: string; kind: 'complete' | 'not-done' | 'reschedule'; task: FollowUpTask;
  } | null>(null);
  const [actionForm, setActionForm] = useState({
    outcome: '', completedAt: '', reason: '', dueDate: '', timeFrom: '', timeTo: '',
  });
  const [actionAttachmentFiles, setActionAttachmentFiles] = useState<File[]>([]);
  const actionAttachmentFileRef = useRef<HTMLInputElement>(null);
  const [actionSubmitting, setActionSubmitting] = useState(false);

  // ── Pending email draft (from meeting status updates) ──
  const [pendingMail, setPendingMail] = useState<{
    draftKey: string; type: string; subject: string; html: string;
  } | null>(null);
  // Ref (not state) to avoid stale-closure issues and the unused-state TS warning.
  const mailQueueRef = useRef<NonNullable<typeof pendingMail>[]>([]);
  const [sendingMail, setSendingMail] = useState(false);

  const [modalError, setModalError] = useState<string | null>(null);

  // ── Load & normalize feed ──────────────────────────────────────────────────

  const loadFeed = useCallback(async () => {
    setLoading(true);
    setFeedError(null);
    try {
      const [callsData, meetingsData, tasksData] = await Promise.all([
        api.get<{ calls: CallRecord[] }>(`/leads/${leadId}/calls`),
        api.get<{ meetings: Meeting[] }>(`/leads/${leadId}/meetings`),
        api.get<{ tasks: FollowUpTask[] }>(`/leads/${leadId}/tasks`),
      ]);

      setAllMeetings(meetingsData.meetings);

      const feed: FeedItem[] = [
        ...callsData.calls.map((c): FeedItem => ({
          kind: 'call',
          sortTs: new Date(c.calledAt ?? c.createdAt).getTime(),
          data: c,
        })),
        ...meetingsData.meetings.map((m): FeedItem => ({
          kind: 'meeting',
          sortTs: new Date(m.scheduledAt).getTime(),
          data: m,
        })),
        ...tasksData.tasks.map((t): FeedItem => ({
          kind: 'task',
          // completedAt when the task was resolved; createdAt when it was added
          sortTs: new Date((t as any).completedAt ?? t.createdAt).getTime(),
          data: t,
        })),
      ].sort((a, b) => b.sortTs - a.sortTs); // newest first

      setItems(feed);
    } catch (e: any) {
      setFeedError(e.message);
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => { loadFeed(); }, [loadFeed]);

  // ── Meeting status update ─────────────────────────────────────────────────

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
    setModalError(null);
  };

  const handleMeetingStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!statusModal) return;
    setStatusSubmitting(true);
    setModalError(null);
    try {
      let momAttachments: { type: string; storagePath?: string }[] | undefined;
      if (statusModal.status === 'COMPLETED' && momFiles.length > 0 && momAttachmentTypes.length > 0) {
        const token = localStorage.getItem('crm_token') ?? '';
        const uploadedPaths: string[] = [];
        for (const file of momFiles) {
          const fd = new FormData();
          fd.append('file', file);
          const resp = await fetch(`${getApiBase()}/leads/${leadId}/calls/upload-attachment`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
          });
          if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error ?? 'Upload failed');
          uploadedPaths.push((await resp.json()).storagePath);
        }
        momAttachments = momAttachmentTypes.map((type, i) => ({ type, storagePath: uploadedPaths[i] }));
      }

      const result = await api.patch<{
        pendingMail?: { draftKey: string; type: string; subject: string; html: string };
        npsPendingMail?: { draftKey: string; type: string; subject: string; html: string };
      }>(`/meetings/${statusModal.meetingId}/status`, {
        status: statusModal.status,
        mom: statusForm.mom || undefined,
        momAttachmentTypes: momAttachmentTypes.length ? momAttachmentTypes : undefined,
        momAttachments,
        rescheduledReason: statusForm.rescheduledReason || undefined,
        rescheduleMode: statusForm.rescheduleMode || undefined,
        rescheduleLocation: statusForm.rescheduleLocation || undefined,
        noShowReason: statusForm.noShowReason || undefined,
        newScheduledAt: statusForm.newScheduledAt ? istInputToISO(statusForm.newScheduledAt) : undefined,
        replanScheduledAt: statusForm.replanScheduledAt ? istInputToISO(statusForm.replanScheduledAt) : undefined,
        replanMode: statusForm.replanMode || undefined,
        replanLocation: statusForm.replanLocation || undefined,
      });

      const completedType = statusModal.status === 'COMPLETED' ? statusModal.meetingType : null;
      setStatusModal(null);
      await loadFeed();
      onMeetingCreated?.();
      if (completedType) onMeetingCompleted?.(completedType);

      const drafts = [result.pendingMail, result.npsPendingMail].filter(Boolean) as NonNullable<typeof result.pendingMail>[];
      if (drafts.length) {
        setPendingMail(drafts[0]);
        mailQueueRef.current = drafts.slice(1);
      }
    } catch (e: any) {
      setModalError(e.message);
    } finally {
      setStatusSubmitting(false);
    }
  };

  // ── Task action ───────────────────────────────────────────────────────────

  const openTaskAction = (task: FollowUpTask, kind: 'complete' | 'not-done' | 'reschedule') => {
    setActionModal({ taskId: task.id, kind, task });
    setActionForm({ outcome: '', completedAt: '', reason: '', dueDate: '', timeFrom: '', timeTo: '' });
    setActionAttachmentFiles([]);
    setModalError(null);
  };

  const handleTaskAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!actionModal) return;
    setActionSubmitting(true);
    setModalError(null);
    try {
      if (actionModal.kind === 'complete') {
        if (actionAttachmentFiles.length === 0 && !lenient) {
          throw new Error('At least one attachment is required to complete this task');
        }
        const token = localStorage.getItem('crm_token') ?? '';
        const attachments: { type: string; storagePath: string }[] = [];
        for (const file of actionAttachmentFiles) {
          const formData = new FormData();
          formData.append('file', file);
          const response = await fetch(`${getApiBase()}/leads/${leadId}/calls/upload-attachment`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
          });
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error ?? 'Attachment upload failed');
          }
          const uploaded = await response.json();
          attachments.push({ type: 'ATTACHMENT', storagePath: uploaded.storagePath });
        }
        await api.patch(`/tasks/${actionModal.taskId}/complete`, {
          outcome: actionForm.outcome.trim(),
          completedAt: actionForm.completedAt ? new Date(actionForm.completedAt).toISOString() : undefined,
          attachments,
        });
        toast.success('Task marked complete');
      } else if (actionModal.kind === 'not-done') {
        await api.patch(`/tasks/${actionModal.taskId}/not-done`, { outcome: actionForm.outcome.trim() });
        toast.success('Task marked not done');
      } else {
        await api.patch(`/tasks/${actionModal.taskId}/reschedule`, {
          dueDate: actionForm.dueDate,
          dueTime: actionForm.timeFrom || undefined,
          timeFrom: actionForm.timeFrom || undefined,
          timeTo: actionForm.timeTo || undefined,
          reason: actionForm.reason.trim(),
          notifyClient: actionModal.task.taskType === 'EXTERNAL' ? true : undefined,
        });
        toast.success('Task rescheduled');
      }
      setActionModal(null);
      await loadFeed();
      onTasksChanged?.();
    } catch (e: any) {
      setModalError(e.message);
      toast.error(e.message);
    } finally {
      setActionSubmitting(false);
    }
  };

  // ── Mail draft queue helpers ──────────────────────────────────────────────

  const advanceMailQueue = () => {
    if (mailQueueRef.current.length === 0) { setPendingMail(null); return; }
    setPendingMail(mailQueueRef.current[0]);
    mailQueueRef.current = mailQueueRef.current.slice(1);
  };

  const handleSendPendingMail = async (subject: string, html: string) => {
    if (!pendingMail) return;
    setSendingMail(true);
    try {
      await api.patch(`/email/draft/${pendingMail.type}/${leadId}`, { subject, html });
      await api.post('/email/send-draft', { draftKey: pendingMail.draftKey, to: clientEmail });
      toast.success('Email sent');
      advanceMailQueue();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSendingMail(false);
    }
  };

  // ── Sub-view (existing tab components for creation) ───────────────────────

  if (subView) {
    const handleBack = async () => {
      setSubView(null);
      await loadFeed();
    };

    return (
      <div className="space-y-4">
        <button
          onClick={handleBack}
          className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700 font-medium"
        >
          <ChevronLeft size={16} strokeWidth={2} /> Back to Activity
        </button>
        {subView === 'log-call' && (
          <CallLogTab leadId={leadId} isLocked={isLocked} onCallLogged={() => {
            onCallLogged?.();
            onTasksChanged?.();
          }} />
        )}
        {(subView === 'book-meeting' || subView === 'log-meeting') && (
          <MeetingsTab
            key={subView}
            startWithLog={subView === 'log-meeting'}
            leadId={leadId}
            clientEmail={clientEmail}
            isLocked={isLocked}
            onMeetingCreated={onMeetingCreated}
            onMeetingCompleted={onMeetingCompleted}
          />
        )}
        {subView === 'add-task' && (
          <FollowUpTab leadId={leadId} isLocked={isLocked} onTasksChanged={onTasksChanged} />
        )}
      </div>
    );
  }

  // ── Feed view ─────────────────────────────────────────────────────────────

  const filterItems = (filter: string | null) => {
    if (!filter) return items;
    return items.filter((item) => {
      if (filter === 'calls-answered') return item.kind === 'call' && item.data.outcome === 'ANSWERED';
      if (filter === 'calls-rnr') return item.kind === 'call' && item.data.outcome.startsWith('RNR_');
      if (filter === 'calls-callback') return item.kind === 'call' && item.data.outcome === 'CALLBACK';
      if (filter === 'calls-meeting') return item.kind === 'call' && item.data.outcome === 'MEETING_SCHEDULED';
      if (filter === 'calls-total') return item.kind === 'call';
      if (filter === 'meetings-scheduled') return item.kind === 'meeting' && item.data.status === 'SCHEDULED';
      if (filter === 'meetings-completed') return item.kind === 'meeting' && item.data.status === 'COMPLETED';
      if (filter === 'meetings-no-show') return item.kind === 'meeting' && item.data.status === 'NO_SHOW';
      if (filter === 'meetings-rescheduled') return item.kind === 'meeting' && item.data.status === 'RESCHEDULED';
      if (filter === 'tasks-pending') return item.kind === 'task' && item.data.status === 'PENDING' && !item.data.isOverdue;
      if (filter === 'tasks-overdue') return item.kind === 'task' && item.data.status === 'PENDING' && item.data.isOverdue;
      if (filter === 'tasks-completed') return item.kind === 'task' && item.data.isCompleted;
      return true;
    });
  };

  const visibleItems = filterItems(activeKpiFilter);
  const activeFilterLabel: Record<string, string> = {
    'calls-answered': 'Answered calls',
    'calls-rnr': 'RNR calls',
    'calls-callback': 'Callback calls',
    'calls-meeting': 'Calls that booked a meeting',
    'calls-total': 'All calls',
    'meetings-scheduled': 'Scheduled meetings',
    'meetings-completed': 'Completed meetings',
    'meetings-no-show': 'No-show meetings',
    'meetings-rescheduled': 'Rescheduled meetings',
    'tasks-pending': 'Pending tasks',
    'tasks-overdue': 'Overdue tasks',
    'tasks-completed': 'Completed tasks',
  };
  const totalCount = visibleItems.length;
  const toggleKpiFilter = (filter: string) => {
    setActiveKpiFilter((current) => current === filter ? null : filter);
  };

  return (
    <div className="space-y-4">

      {/* Action buttons */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Activity</h2>
          <p className="text-sm text-gray-500">
            {activeKpiFilter ? `Showing ${activeFilterLabel[activeKpiFilter]} · ` : ''}
            {totalCount} item{totalCount !== 1 ? 's' : ''} · newest first
            {activeKpiFilter && (
              <button
                type="button"
                onClick={() => setActiveKpiFilter(null)}
                className="ml-2 text-brand-600 hover:text-brand-700 hover:underline"
              >
                Show all
              </button>
            )}
          </p>
        </div>
        {!isLocked && (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setSubView('log-call')}
              className="bg-brand-500 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-brand-600 transition-colors"
            >
              📞 Log Call
            </button>
            <button
              onClick={() => setSubView('book-meeting')}
              className="bg-white border border-brand-300 text-brand-600 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-brand-50 transition-colors"
            >
              📅 Book Meeting
            </button>
            <button
              onClick={() => setSubView('log-meeting')}
              data-testid="activity-log-meeting"
              title="Record a meeting that has already happened"
              className="bg-white border border-brand-300 text-brand-600 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-brand-50 transition-colors"
            >
              📝 Log Meeting
            </button>
            <button
              onClick={() => setSubView('add-task')}
              className="bg-white border border-brand-300 text-brand-600 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-brand-50 transition-colors"
            >
              ✓ Add Task
            </button>
          </div>
        )}
      </div>

      {/* ── KPI breakdown sub-row ─────────────────────────────────────── */}
      {breakdown && (breakdown.calls.total > 0 || breakdown.meetings.total > 0 || breakdown.tasks.total > 0) && (
        <div className="rounded-2xl border border-stone-100 bg-stone-50 px-4 py-3 space-y-3">
          {breakdown.calls.total > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-stone-400 uppercase tracking-widest mb-1.5">📞 Calls</p>
              <div className="grid grid-cols-5 gap-2">
                <MiniKpi label="Answered" value={breakdown.calls.answered} color="text-green-600"
                  active={activeKpiFilter === 'calls-answered'} onClick={() => toggleKpiFilter('calls-answered')} />
                <MiniKpi label="RNR" value={breakdown.calls.rnr} color="text-amber-600"
                  active={activeKpiFilter === 'calls-rnr'} onClick={() => toggleKpiFilter('calls-rnr')} />
                <MiniKpi label="Callback" value={breakdown.calls.callback} color="text-blue-600"
                  active={activeKpiFilter === 'calls-callback'} onClick={() => toggleKpiFilter('calls-callback')} />
                <MiniKpi label="Mtg Booked" value={breakdown.calls.meetingScheduled} color="text-purple-600"
                  active={activeKpiFilter === 'calls-meeting'} onClick={() => toggleKpiFilter('calls-meeting')} />
                <MiniKpi label="Total" value={breakdown.calls.total} color="text-stone-600"
                  active={activeKpiFilter === 'calls-total'} onClick={() => toggleKpiFilter('calls-total')} />
              </div>
            </div>
          )}
          {breakdown.meetings.total > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-stone-400 uppercase tracking-widest mb-1.5">📅 Meetings</p>
              <div className="grid grid-cols-4 gap-2">
                <MiniKpi label="Scheduled" value={breakdown.meetings.scheduled} color="text-blue-600"
                  active={activeKpiFilter === 'meetings-scheduled'} onClick={() => toggleKpiFilter('meetings-scheduled')} />
                <MiniKpi label="Completed" value={breakdown.meetings.completed} color="text-green-600"
                  active={activeKpiFilter === 'meetings-completed'} onClick={() => toggleKpiFilter('meetings-completed')} />
                <MiniKpi label="No-show" value={breakdown.meetings.noShow} color="text-red-500"
                  active={activeKpiFilter === 'meetings-no-show'} onClick={() => toggleKpiFilter('meetings-no-show')} />
                <MiniKpi label="Rescheduled" value={breakdown.meetings.rescheduled} color="text-amber-600"
                  active={activeKpiFilter === 'meetings-rescheduled'} onClick={() => toggleKpiFilter('meetings-rescheduled')} />
              </div>
            </div>
          )}
          {breakdown.tasks.total > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-stone-400 uppercase tracking-widest mb-1.5">✓ Tasks</p>
              <div className="grid grid-cols-3 gap-2">
                <MiniKpi label="Pending" value={breakdown.tasks.pending} color="text-blue-600"
                  active={activeKpiFilter === 'tasks-pending'} onClick={() => toggleKpiFilter('tasks-pending')} />
                <MiniKpi label="Overdue" value={breakdown.tasks.overdue} color="text-red-500"
                  active={activeKpiFilter === 'tasks-overdue'} onClick={() => toggleKpiFilter('tasks-overdue')} />
                <MiniKpi label="Completed" value={breakdown.tasks.completed} color="text-green-600"
                  active={activeKpiFilter === 'tasks-completed'} onClick={() => toggleKpiFilter('tasks-completed')} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Feed */}
      {loading ? (
        <div className="text-center py-10 text-gray-400 text-sm animate-pulse">Loading activity…</div>
      ) : feedError ? (
        <div className="text-center py-10 text-red-500 text-sm">{feedError}</div>
      ) : visibleItems.length === 0 ? (
        <div className="text-center py-10 text-gray-400 text-sm">
          {activeKpiFilter
            ? `No ${activeFilterLabel[activeKpiFilter].toLowerCase()} found.`
            : 'No activity yet — log a call, book a meeting, or add a task to get started.'}
        </div>
      ) : (
        <div className="space-y-3">
          {visibleItems.map((item) => {
            if (item.kind === 'call') {
              return <CallCard key={`call-${item.data.id}`} call={item.data} />;
            }
            if (item.kind === 'meeting') {
              return (
                <MeetingCard
                  key={`meeting-${item.data.id}`}
                  meeting={item.data}
                  allMeetings={allMeetings}
                  isLocked={isLocked}
                  onAction={openStatusModal}
                />
              );
            }
            // task
            return (
              <TaskCard
                key={`task-${item.data.id}`}
                task={item.data}
                isLocked={isLocked}
                onAction={openTaskAction}
              />
            );
          })}
        </div>
      )}

      {/* ── Meeting status modal ─────────────────────────────────────────── */}
      {statusModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h3 className="font-semibold text-gray-900 text-lg mb-4">
              {statusModal.status === 'COMPLETED' ? 'Mark Complete'
                : statusModal.status === 'RESCHEDULED' ? 'Reschedule Meeting'
                : 'Record No-show'}
            </h3>
            <form onSubmit={handleMeetingStatus} className="space-y-4">

              {statusModal.status === 'COMPLETED' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Minutes of Meeting (MOM)</label>
                    <textarea
                      value={statusForm.mom}
                      onChange={(e) => setStatusForm({ ...statusForm, mom: e.target.value })}
                      rows={3}
                      required={meetingRules().requireMom}
                      placeholder="Key discussion points…"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                    />
                  </div>
                  {/* MOM attachments */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">MOM Attachments</label>
                    <div className="flex flex-wrap gap-2 mb-2">
                      {MOM_ATTACHMENT_TYPES.map((type) => (
                        <button key={type} type="button"
                          onClick={() => setMomAttachmentTypes((prev) => [...prev, type])}
                          className="text-xs border border-gray-300 px-2.5 py-1 rounded-lg hover:bg-gray-50 text-gray-600">
                          + {type}
                        </button>
                      ))}
                    </div>
                    {momAttachmentTypes.map((type, i) => (
                      <div key={i} className="flex items-center gap-2 mb-1">
                        <span className="text-xs text-gray-500 w-32 truncate">{type}</span>
                        <input type="file" ref={i === 0 ? momFileRef : undefined}
                          onChange={(e) => {
                            if (!e.target.files?.[0]) return;
                            setMomFiles((prev) => {
                              const next = [...prev];
                              next[i] = e.target.files![0];
                              return next;
                            });
                          }}
                          className="text-xs flex-1" />
                        <button type="button" onClick={() => {
                          setMomAttachmentTypes((prev) => prev.filter((_, idx) => idx !== i));
                          setMomFiles((prev) => prev.filter((_, idx) => idx !== i));
                        }} className="text-red-400 hover:text-red-600 text-xs">✕</button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {statusModal.status === 'RESCHEDULED' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Reason for Rescheduling {meetingRules().requireRescheduleReason ? <span className="text-red-500">*</span> : <span className="text-gray-400 text-xs">(optional)</span>}
                    </label>
                    <input
                      type="text"
                      value={statusForm.rescheduledReason}
                      onChange={(e) => setStatusForm({ ...statusForm, rescheduledReason: e.target.value })}
                      required={meetingRules().requireRescheduleReason}
                      placeholder="Why is this being rescheduled?"
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
                        {meetingModeOptions().map(({ value, label }) => (
                          <option key={value} value={value}>{label}</option>
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
                      options={RESCHEDULE_LOCATION_OPTIONS}
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
                      Reason for no-show {meetingRules().requireNoShowReason ? <span className="text-red-500">*</span> : <span className="text-gray-400 text-xs">(optional)</span>}
                    </label>
                    <textarea
                      rows={2}
                      value={statusForm.noShowReason}
                      onChange={(e) => setStatusForm({ ...statusForm, noShowReason: e.target.value })}
                      required={meetingRules().requireNoShowReason}
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
                          Date &amp; Time <span className="text-red-500">*</span>
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
                          {meetingModeOptions().map(({ value, label }) => (
                            <option key={value} value={value}>{label}</option>
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

              {modalError && <p className="text-sm text-red-500">{modalError}</p>}
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setStatusModal(null)}
                  className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={statusSubmitting}
                  className="flex-1 bg-brand-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors">
                  {statusSubmitting ? 'Saving…' : 'Confirm'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Task action modal ────────────────────────────────────────────── */}
      {actionModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h3 className="font-semibold text-gray-900 text-lg mb-4">
              {actionModal.kind === 'complete' ? 'Mark Complete'
                : actionModal.kind === 'reschedule' ? 'Reschedule Task'
                : 'Mark Not Done'}
            </h3>
            <form onSubmit={handleTaskAction} className="space-y-4">
              {actionModal.kind === 'complete' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Outcome / Notes</label>
                    <textarea
                      value={actionForm.outcome}
                      onChange={(e) => setActionForm({ ...actionForm, outcome: e.target.value })}
                      rows={2}
                      placeholder="What was the outcome?"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Completed On</label>
                    <DateInput value={actionForm.completedAt}
                      onChange={(v) => setActionForm({ ...actionForm, completedAt: v })} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Attachment {!lenient && <span className="text-red-500">*</span>}{lenient && <span className="text-gray-400 font-normal">(optional)</span>}
                    </label>
                    <div className="space-y-1.5">
                      <label className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-dashed border-gray-300 text-gray-600 cursor-pointer hover:border-brand-400 w-fit">
                        <Paperclip size={11} strokeWidth={2} />
                        Add attachment(s)
                        <input
                          ref={actionAttachmentFileRef}
                          type="file"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            const picked = Array.from(e.target.files ?? []);
                            setActionAttachmentFiles((prev) => [...prev, ...picked]);
                            e.target.value = '';
                          }}
                        />
                      </label>
                      {actionAttachmentFiles.length === 0 && !lenient && (
                        <p className="text-xs text-red-400">At least one attachment is required</p>
                      )}
                      {actionAttachmentFiles.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {actionAttachmentFiles.map((file, index) => (
                            <span key={`${file.name}-${index}`} className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                              {file.name}
                              <button
                                type="button"
                                onClick={() => setActionAttachmentFiles((prev) => prev.filter((_, fileIndex) => fileIndex !== index))}
                                className="text-gray-400 hover:text-red-400"
                                aria-label={`Remove ${file.name}`}
                              >
                                <X size={10} strokeWidth={2} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
              {actionModal.kind === 'not-done' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Reason</label>
                  <textarea
                    value={actionForm.outcome}
                    onChange={(e) => setActionForm({ ...actionForm, outcome: e.target.value })}
                    rows={2}
                    placeholder="Why wasn't this completed?"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
              )}
              {actionModal.kind === 'reschedule' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Agenda</label>
                    <div className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                      {actionModal.task.agenda?.trim() || 'No agenda added'}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      New Date <span className="text-red-500">*</span>
                    </label>
                    <DateInput value={actionForm.dueDate}
                      onChange={(v) => setActionForm({ ...actionForm, dueDate: v })}
                      required />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">New Time — From</label>
                      <TimeInput
                        value={actionForm.timeFrom}
                        onChange={(value) => setActionForm({ ...actionForm, timeFrom: value })}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">New Time — To</label>
                      <TimeInput
                        value={actionForm.timeTo}
                        onChange={(value) => setActionForm({ ...actionForm, timeTo: value })}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                    <div className={`w-full rounded-lg px-3 py-2 text-sm border ${
                      actionModal.task.taskType === 'EXTERNAL'
                        ? 'bg-purple-50 border-purple-200 text-purple-700'
                        : 'bg-blue-50 border-blue-200 text-blue-700'
                    }`}>
                      {actionModal.task.taskType === 'EXTERNAL' ? 'External' : 'Internal'}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Reason <span className="text-red-500">*</span>
                    </label>
                    <input type="text" value={actionForm.reason}
                      onChange={(e) => setActionForm({ ...actionForm, reason: e.target.value })}
                      required
                      placeholder="Why is this being rescheduled?"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400" />
                  </div>
                </>
              )}
              {modalError && <p className="text-sm text-red-500">{modalError}</p>}
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setActionModal(null)}
                  className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={actionSubmitting}
                  className="flex-1 bg-brand-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors">
                  {actionSubmitting ? 'Saving…' : 'Confirm'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Email draft preview */}
      {pendingMail && (
        <EmailPreviewModal
          leadId={leadId}
          title="Review Email Draft"
          defaultSubject={pendingMail.subject}
          defaultHtml={pendingMail.html}
          recipientLabel={clientEmail ?? ''}
          sending={sendingMail}
          onSend={handleSendPendingMail}
          onClose={advanceMailQueue}
          requireSend={pendingMail.type === 'MEETING_COMPLETED' || pendingMail.type === 'NPS_ONBOARDING'}
        />
      )}
    </div>
  );
}
