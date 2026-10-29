import { useLenientLaunch } from '../../lib/flags';
import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Paperclip, X, AlertTriangle } from 'lucide-react';
import { api, type FollowUpTask } from '../../lib/api';
import { formatISTDate, formatTime12, todayISTDateString } from '../../lib/dateFormat';
import { DateInput, TimeInput } from '../ui/DateTimeInputs';
import EmailPreviewModal from '../EmailPreviewModal';
import { crmSettings } from '../../lib/crmSettings';

function todayDateStr() {
  return todayISTDateString();
}

function getApiBase() {
  return (import.meta as any).env?.VITE_API_BASE ?? '/api';
}

interface Props {
  leadId: string;
  isLocked?: boolean;
  onTasksChanged?: () => void;
}

export default function FollowUpTab({ leadId, isLocked, onTasksChanged }: Props) {
  const lenient = useLenientLaunch();
  const [tasks, setTasks] = useState<FollowUpTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    dueDate: '', dueTime: '', timeFrom: '', timeTo: '', taskType: 'INTERNAL', agenda: '', internalNotes: '',
    assignedToId: '', numberOfFollowUps: '',
  });
  const [taskNotifyClient, setTaskNotifyClient] = useState(crmSettings().notifyClientByDefault);
  const [rescheduleNotifyClient, setRescheduleNotifyClient] = useState(crmSettings().notifyClientByDefault);
  // Task #115 — tasks support multiple attachments; no fixed category list.
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const attachmentFileRef = useRef<HTMLInputElement>(null);
  const [assignees, setAssignees] = useState<{ id: string; name: string; role: string; isActive: boolean }[]>([]);
  const [actionAttachmentFiles, setActionAttachmentFiles] = useState<File[]>([]);
  const actionAttachmentFileRef = useRef<HTMLInputElement>(null);

  // Action modal: complete / not-done / reschedule
  const [actionModal, setActionModal] = useState<{ taskId: string; kind: 'complete' | 'not-done' | 'reschedule'; task: FollowUpTask } | null>(null);
  const [actionForm, setActionForm] = useState({
    outcome: '', completedAt: todayDateStr(), reason: '', dueDate: '', timeFrom: '', timeTo: '',
  });
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [pendingMail, setPendingMail] = useState<{ draftKey: string; to: string; subject: string; html: string } | null>(null);
  const [sendingMail, setSendingMail] = useState(false);
  const [mailSentNotice, setMailSentNotice] = useState<string | null>(null);

  const loadTasks = async () => {
    try {
      const data = await api.get<{ tasks: FollowUpTask[] }>(`/leads/${leadId}/tasks`);
      setTasks(data.tasks);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadTasks(); }, [leadId]);

  useEffect(() => {
    api.get<{ users: { id: string; name: string; role: string; isActive: boolean }[] }>('/admin/users')
      .then((d) => setAssignees(d.users.filter((u) => u.isActive)))
      .catch(() => {});
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.dueDate) return;
    setSubmitting(true);
    setError(null);
    try {
      let attachments: { type: string; storagePath: string }[] | undefined;
      if (attachmentFiles.length > 0) {
        setUploadingAttachment(true);
        const token = localStorage.getItem('crm_token') ?? '';
        attachments = [];
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
          attachments.push({ type: 'ATTACHMENT', storagePath: uploadData.storagePath });
        }
        setUploadingAttachment(false);
      }

      const result = await api.post<{ pendingMail?: { draftKey: string; type: string; to: string; subject: string; html: string } | null }>(
        `/leads/${leadId}/tasks`,
        {
          dueDate: form.dueDate,
          dueTime: form.dueTime || undefined,
          timeFrom: form.timeFrom || undefined,
          timeTo: form.timeTo || undefined,
          taskType: form.taskType,
          agenda: form.agenda.trim() || undefined,
          internalNotes: form.internalNotes.trim() || undefined,
          attachments,
          notifyClient: form.taskType === 'EXTERNAL' ? taskNotifyClient : undefined,
          assignedToId: form.assignedToId || undefined,
          numberOfFollowUps: form.numberOfFollowUps ? parseInt(form.numberOfFollowUps, 10) : undefined,
        },
      );
      setForm({ dueDate: '', dueTime: '', timeFrom: '', timeTo: '', taskType: 'INTERNAL', agenda: '', internalNotes: '', assignedToId: '', numberOfFollowUps: '' });
      setTaskNotifyClient(crmSettings().notifyClientByDefault);
      setAttachmentFiles([]);
      setShowForm(false);
      await loadTasks();
      onTasksChanged?.();
      // Batch 12c: the "upcoming follow-up" client mail is now a draft.
      if (result.pendingMail) {
        setPendingMail({
          draftKey: result.pendingMail.draftKey,
          to: result.pendingMail.to,
          subject: result.pendingMail.subject,
          html: result.pendingMail.html,
        });
      }
    } catch (e: any) {
      setError(e.message);
      setUploadingAttachment(false);
    } finally {
      setSubmitting(false);
    }
  };

  const openAction = (task: FollowUpTask, kind: 'complete' | 'not-done' | 'reschedule') => {
    setActionModal({ taskId: task.id, kind, task });
    setActionForm({ outcome: '', completedAt: todayDateStr(), reason: '', dueDate: '', timeFrom: '', timeTo: '' });
    setActionAttachmentFiles([]);
    setError(null);
  };

  const handleAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!actionModal) return;
    setActionSubmitting(true);
    setError(null);
    try {
      if (actionModal.kind === 'complete') {
        let completionAttachments: { type: string; storagePath: string }[] = [];
        if (actionAttachmentFiles.length > 0) {
          const token = localStorage.getItem('crm_token') ?? '';
          for (const file of actionAttachmentFiles) {
            const fd = new FormData();
            fd.append('file', file);
            const uploadResp = await fetch(`${getApiBase()}/leads/${leadId}/calls/upload-attachment`, {
              method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
            });
            if (!uploadResp.ok) { const err = await uploadResp.json().catch(() => ({})); throw new Error(err.error ?? 'Attachment upload failed'); }
            const uploadData = await uploadResp.json();
            completionAttachments.push({ type: 'ATTACHMENT', storagePath: uploadData.storagePath });
          }
        }
        await api.patch(`/tasks/${actionModal.taskId}/complete`, {
          outcome: actionForm.outcome.trim(),
          completedAt: actionForm.completedAt ? new Date(actionForm.completedAt).toISOString() : undefined,
          attachments: completionAttachments,
        });
        toast.success('Task marked complete');
      } else if (actionModal.kind === 'not-done') {
        await api.patch(`/tasks/${actionModal.taskId}/not-done`, { outcome: actionForm.outcome.trim() });
        toast.success('Task marked not done');
      } else {
        const result = await api.patch<{ pendingMail?: { draftKey: string; type: string; to: string; subject: string; html: string } | null }>(
          `/tasks/${actionModal.taskId}/reschedule`,
          {
            dueDate: actionForm.dueDate,
            dueTime: actionForm.timeFrom || undefined,
            timeFrom: actionForm.timeFrom || undefined,
            timeTo: actionForm.timeTo || undefined,
            reason: actionForm.reason.trim(),
            notifyClient: actionModal.task.taskType === 'EXTERNAL' ? rescheduleNotifyClient : undefined,
          },
        );
        toast.success('Task rescheduled');
        if (result.pendingMail) {
          setPendingMail({
            draftKey: result.pendingMail.draftKey,
            to: result.pendingMail.to,
            subject: result.pendingMail.subject,
            html: result.pendingMail.html,
          });
        }
      }
      setActionModal(null);
      await loadTasks();
      onTasksChanged?.();
    } catch (e: any) {
      setError(e.message);
      toast.error(e.message);
    } finally {
      setActionSubmitting(false);
    }
  };

  const handleSendPendingMail = async (subject: string, html: string) => {
    if (!pendingMail) return;
    setSendingMail(true);
    try {
      await api.post('/email/send-draft', { draftKey: pendingMail.draftKey, to: pendingMail.to, subject, html });
      setMailSentNotice(`Follow-up mail sent to ${pendingMail.to}`);
      setPendingMail(null);
      setTimeout(() => setMailSentNotice(null), 4000);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSendingMail(false);
    }
  };

  const statusBadge = (task: FollowUpTask) => {
    switch (task.status) {
      case 'COMPLETED': return <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-green-100 text-green-700">Done</span>;
      case 'NOT_DONE': return <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-gray-200 text-gray-600">Not Done</span>;
      case 'RESCHEDULED': return <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">Rescheduled</span>;
      default:
        return task.isOverdue
          ? <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-red-100 text-red-700">Overdue</span>
          : <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">Upcoming</span>;
    }
  };

  const taskStatusClass = (task: FollowUpTask) => {
    if (task.status === 'COMPLETED') return 'bg-green-50 border-green-200';
    if (task.status === 'NOT_DONE') return 'bg-gray-50 border-gray-200';
    if (task.isOverdue) return 'bg-red-50 border-red-200';
    return 'bg-white border-gray-200';
  };

  const isActionable = (task: FollowUpTask) => task.status === 'PENDING';
  const overdueBlocking = tasks.filter((t) => t.isOverdue && t.status === 'PENDING');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Follow-up Tasks</h2>
          <p className="text-sm text-gray-500">
            {tasks.length} total · {tasks.filter(t => t.status === 'COMPLETED').length} completed ·{' '}
            {tasks.filter(t => t.status === 'PENDING').length} pending
            {tasks.filter(t => t.isOverdue && t.status === 'PENDING').length > 0
              ? ` (${tasks.filter(t => t.isOverdue && t.status === 'PENDING').length} overdue)`
              : ''} ·{' '}
            {tasks.filter(t => t.status === 'RESCHEDULED').length} rescheduled ·{' '}
            {tasks.filter(t => t.status === 'NOT_DONE').length} not done
          </p>
        </div>
        {!isLocked && (
          <button
            onClick={() => setShowForm(!showForm)}
            disabled={!showForm && overdueBlocking.length > 0}
            title={!showForm && overdueBlocking.length > 0 ? 'Resolve overdue tasks first' : undefined}
            className="bg-brand-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {showForm ? 'Cancel' : '+ Add Task'}
          </button>
        )}
      </div>

      {isLocked && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-700">
          This lead is Inactive — reactivate it to add follow-up tasks.
        </div>
      )}

      {!isLocked && overdueBlocking.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle size={16} className="text-red-600 mt-0.5 shrink-0" />
          <div className="text-sm text-red-700">
            <p className="font-semibold mb-0.5">Resolve overdue tasks before adding new activity</p>
            <p>{overdueBlocking.length} overdue task{overdueBlocking.length > 1 ? 's need' : ' needs'} to be rescheduled or marked not done first.</p>
          </div>
        </div>
      )}

      {!isLocked && showForm && (
        <form onSubmit={handleCreate} className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <h3 className="font-medium text-gray-900">New Follow-up / Task</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Agenda</label>
            <input
              type="text"
              value={form.agenda}
              onChange={(e) => setForm({ ...form, agenda: e.target.value })}
              placeholder="What this task is about…"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Due Date <span className="text-red-500">*</span>
              </label>
              <DateInput
                value={form.dueDate}
                onChange={(v) => setForm({ ...form, dueDate: v })}
                min={todayDateStr()}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
              <select
                value={form.taskType}
                onChange={(e) => setForm({ ...form, taskType: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              >
                <option value="INTERNAL">Internal</option>
                <option value="EXTERNAL">External (notify client)</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Assigned To</label>
              <select
                value={form.assignedToId}
                onChange={(e) => setForm({ ...form, assignedToId: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              >
                <option value="">— Myself —</option>
                {assignees.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">No. of follow-ups</label>
              <input
                type="number"
                min={0}
                value={form.numberOfFollowUps}
                onChange={(e) => setForm({ ...form, numberOfFollowUps: e.target.value })}
                placeholder="e.g. 3"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>
          </div>
          {form.taskType === 'EXTERNAL' && (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={taskNotifyClient}
                onChange={(e) => setTaskNotifyClient(e.target.checked)}
                className="rounded border-gray-300 text-brand-500 focus:ring-brand-400"
              />
              Send follow-up reminder email to client
            </label>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">From</label>
              <TimeInput
                value={form.timeFrom}
                onChange={(v) => setForm({ ...form, timeFrom: v, dueTime: v || form.dueTime })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">To</label>
              <TimeInput
                value={form.timeTo}
                onChange={(v) => setForm({ ...form, timeTo: v })}
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Attachments</label>
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-dashed border-gray-300 text-gray-600 cursor-pointer hover:border-brand-400 w-fit">
                <Paperclip size={11} strokeWidth={2} />
                Add attachment(s)
                <input
                  ref={attachmentFileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []);
                    setAttachmentFiles((prev) => [...prev, ...picked]);
                    e.target.value = '';
                  }}
                />
              </label>
              {attachmentFiles.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {attachmentFiles.map((f, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                      {f.name}
                      <button type="button" onClick={() => setAttachmentFiles((prev) => prev.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-400">
                        <X size={10} strokeWidth={2} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={submitting || uploadingAttachment}
            className="w-full bg-brand-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
          >
            {uploadingAttachment ? 'Uploading attachment…' : submitting ? 'Creating…' : 'Create Task'}
          </button>
        </form>
      )}

      {/* Action modal */}
      {actionModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h3 className="font-semibold text-gray-900 mb-4">
              {actionModal.kind === 'complete' ? 'Mark Task Complete' : actionModal.kind === 'not-done' ? 'Mark Task Not Done' : 'Reschedule Task'}
            </h3>
            <form onSubmit={handleAction} className="space-y-4">
              {(actionModal.kind === 'complete' || actionModal.kind === 'not-done') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    rows={3}
                    value={actionForm.outcome}
                    onChange={(e) => setActionForm({ ...actionForm, outcome: e.target.value })}
                    required
                    placeholder="Outcome notes…"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
              )}
              {actionModal.kind === 'complete' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Completed On</label>
                  <DateInput
                    value={actionForm.completedAt}
                    onChange={(v) => setActionForm({ ...actionForm, completedAt: v })}
                    max={todayDateStr()}
                  />
                  <p className="text-xs text-gray-400 mt-1">Can be backdated; cannot be set in the future.</p>
                </div>
              )}
              {actionModal.kind === 'complete' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Attachment {!lenient && <span className="text-red-500">*</span>}{lenient && <span className="text-gray-400 font-normal">(optional)</span>}
                  </label>
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-dashed border-gray-300 text-gray-600 cursor-pointer hover:border-brand-400 w-fit">
                      <Paperclip size={11} strokeWidth={2} />
                      Add attachment(s)
                      <input ref={actionAttachmentFileRef} type="file" multiple className="hidden"
                        onChange={(e) => { const picked = Array.from(e.target.files ?? []); setActionAttachmentFiles((prev) => [...prev, ...picked]); e.target.value = ''; }}
                      />
                    </label>
                    {actionAttachmentFiles.length === 0 && !lenient && (
                      <p className="text-xs text-red-400">At least one attachment is required</p>
                    )}
                    {actionAttachmentFiles.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {actionAttachmentFiles.map((f, i) => (
                          <span key={i} className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                            {f.name}
                            <button type="button" onClick={() => setActionAttachmentFiles((prev) => prev.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-400">
                              <X size={10} strokeWidth={2} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {actionModal.kind === 'reschedule' && (
                <>
                  <div className="bg-gray-50 rounded-lg px-3 py-2 space-y-0.5">
                    <p className="text-xs font-medium text-gray-500">Currently scheduled</p>
                    <p className="text-sm text-gray-700">
                      {formatISTDate(actionModal.task.dueDate, { weekday: 'short' })}
                      {(actionModal.task.timeFrom || actionModal.task.dueTime) && (
                        <span className="text-gray-500">
                          {' '}at {formatTime12(actionModal.task.timeFrom ?? actionModal.task.dueTime)}
                          {actionModal.task.timeTo ? `–${formatTime12(actionModal.task.timeTo)}` : ''}
                        </span>
                      )}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Agenda</label>
                    <div className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                      {actionModal.task.agenda?.trim() || 'No agenda added'}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        New Due Date <span className="text-red-500">*</span>
                      </label>
                      <DateInput
                        value={actionForm.dueDate}
                        onChange={(v) => setActionForm({ ...actionForm, dueDate: v })}
                        min={todayDateStr()}
                        required
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">New Time — From</label>
                        <TimeInput
                          value={actionForm.timeFrom}
                          onChange={(v) => setActionForm({ ...actionForm, timeFrom: v })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">New Time — To</label>
                        <TimeInput
                          value={actionForm.timeTo}
                          onChange={(v) => setActionForm({ ...actionForm, timeTo: v })}
                        />
                      </div>
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
                    <input
                      type="text"
                      value={actionForm.reason}
                      onChange={(e) => setActionForm({ ...actionForm, reason: e.target.value })}
                      required
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                    />
                  </div>
                  {actionModal.task.taskType === 'EXTERNAL' && (
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={rescheduleNotifyClient}
                        onChange={(e) => setRescheduleNotifyClient(e.target.checked)}
                        className="rounded border-gray-300 text-brand-500 focus:ring-brand-400"
                      />
                      Send updated follow-up email to client
                    </label>
                  )}
                </>
              )}
              {error && <p className="text-sm text-red-500">{error}</p>}
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setActionModal(null)}
                  className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionSubmitting}
                  className="flex-1 bg-brand-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
                >
                  {actionSubmitting ? 'Saving…' : 'Confirm'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-10 text-gray-400 text-sm animate-pulse">Loading tasks…</div>
      ) : tasks.length === 0 ? (
        <div className="text-center py-10 text-gray-400 text-sm">No follow-up tasks yet</div>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <div key={task.id} className={`border rounded-xl p-4 ${taskStatusClass(task)}`}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  {statusBadge(task)}
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

                {isActionable(task) && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => openAction(task, 'complete')}
                      className="text-xs bg-green-50 text-green-700 border border-green-200 px-2.5 py-1.5 rounded-lg hover:bg-green-100 transition-colors"
                    >
                      Complete
                    </button>
                    <button
                      onClick={() => openAction(task, 'reschedule')}
                      className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-1.5 rounded-lg hover:bg-amber-100 transition-colors"
                    >
                      Reschedule
                    </button>
                    <button
                      onClick={() => openAction(task, 'not-done')}
                      className="text-xs bg-gray-100 text-gray-600 border border-gray-200 px-2.5 py-1.5 rounded-lg hover:bg-gray-200 transition-colors"
                    >
                      Not Done
                    </button>
                  </div>
                )}

                {task.status === 'COMPLETED' && task.completedAt && (
                  <p className="text-xs text-gray-400">
                    Completed {formatISTDate(task.completedAt)}
                  </p>
                )}
              </div>

              {task.outcome && (
                <div className="mt-2 bg-gray-50 rounded-lg px-3 py-2">
                  <p className="text-xs font-medium text-gray-500 mb-0.5">Reason</p>
                  <p className="text-xs text-gray-700">{task.outcome}</p>
                </div>
              )}

              {task.attachments && task.attachments.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-medium text-gray-500 mb-1">Attachments ({task.attachments.length})</p>
                <div className="flex flex-wrap gap-1.5">
                  {task.attachments.map((att, i) => (
                    att.fileUrl ? (
                      <a
                        key={i}
                        href={att.fileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs bg-brand-50 text-brand-700 border border-brand-200 px-2 py-1 rounded-lg hover:bg-brand-100 transition-colors"
                      >
                        <Paperclip size={11} strokeWidth={2} />
                        {att.fileName ?? `Attachment ${i + 1}`}
                      </a>
                    ) : (
                      <span key={i} className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-400 px-2 py-1 rounded-lg">
                        <Paperclip size={11} strokeWidth={2} />
                        Attachment unavailable
                      </span>
                    )
                  ))}
                </div>
                </div>
              )}

              {task.rescheduleHistory && task.rescheduleHistory.length > 0 && (
                <div className="mt-2 space-y-1">
                  {task.rescheduleHistory.map((h, i) => (
                    <div key={i} className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-1.5">
                      <span className="font-medium">Reschedule {i + 1}:</span>{' '}
                      was {formatISTDate(h.dueDate)}
                      {h.dueTime ? ` at ${formatTime12(h.dueTime)}` : ''} — {h.reason}
                    </div>
                  ))}
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
          leadId={leadId}
          title="Review Follow-up Email"
          defaultSubject={pendingMail.subject}
          defaultHtml={pendingMail.html}
          recipientLabel={pendingMail.to}
          sending={sendingMail}
          onSend={handleSendPendingMail}
          onClose={() => setPendingMail(null)}
        />
      )}
    </div>
  );
}
