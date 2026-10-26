import { useEffect, useState } from 'react';
import { useLenientLaunch } from '../lib/flags';
import { Link } from 'react-router-dom';
import { Calendar, User, Paperclip } from 'lucide-react';
import { api } from '../lib/api';
import type { FollowUpTask } from '../lib/api';
import toast from 'react-hot-toast';
import { getStoredUser } from '../lib/auth';
import { usePermissions } from '../lib/permissions';
import { formatISTDate, todayISTDateString } from '../lib/dateFormat';
import { DateInput, TimeInput } from '../components/ui/DateTimeInputs';

type Filter = 'upcoming' | 'overdue' | 'completed' | 'not_done' | 'all';

function todayDateStr() {
  return todayISTDateString();
}

function formatDate(iso: string) {
  return formatISTDate(iso, { year: 'numeric' });
}

function statusBadge(task: FollowUpTask) {
  switch (task.status) {
    case 'COMPLETED':
      return <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">Done</span>;
    case 'NOT_DONE':
      return <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full font-semibold">Not Done</span>;
    case 'RESCHEDULED':
      return <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-semibold">Rescheduled</span>;
    default:
      return task.isOverdue
        ? <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-semibold">Overdue</span>
        : null;
  }
}

// Only PENDING tasks can be acted on — completed/not-done/rescheduled records are a fixed history.
const isActionable = (task: FollowUpTask) => task.status === 'PENDING';

function TaskCard({
  task,
  onAction,
}: {
  task: FollowUpTask;
  onAction: (taskId: string, kind: 'complete' | 'not-done' | 'reschedule') => void;
}) {
  const isOverduePending = task.isOverdue && task.status === 'PENDING';

  return (
    <div
      className="bg-white rounded-2xl p-4 flex items-start gap-4 transition-all"
      style={{
        border: isOverduePending ? '1px solid #FECACA' : '1px solid #EDE8E3',
        background: isOverduePending ? '#FFF5F5' : '#fff',
        opacity: task.status === 'PENDING' ? 1 : 0.7,
        boxShadow: '0 1px 3px 0 rgba(100,60,20,0.06)',
      }}
    >
      <div className="mt-0.5 shrink-0">
        {task.status === 'COMPLETED' ? (
          <span className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center text-green-600 text-xs font-bold">✓</span>
        ) : task.status === 'NOT_DONE' ? (
          <span className="w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-xs font-bold">✕</span>
        ) : task.isOverdue ? (
          <span className="w-5 h-5 rounded-full bg-red-100 flex items-center justify-center text-red-600 text-xs font-bold">!</span>
        ) : (
          <span className="w-5 h-5 rounded-full" style={{ border: '2px solid #EDE8E3' }} />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            {task.lead && (
              <Link
                to={`/leads/${task.lead.id}`}
                className="text-sm font-semibold text-brand-600 hover:text-brand-700 hover:underline transition-colors"
              >
                {task.lead.name}
              </Link>
            )}
            {task.lead && (
              <span className="ml-2 text-xs text-stone-400 font-mono font-medium">{task.lead.leadId}</span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">{statusBadge(task)}</div>
        </div>

        <div className="flex items-center gap-3 mt-1 text-xs text-stone-500">
          <span className="flex items-center gap-1"><Calendar size={12} strokeWidth={1.8} /> {formatDate(task.dueDate)}{(task.timeFrom ?? task.dueTime) ? ` at ${task.timeFrom ?? task.dueTime}` : ''}</span>
          <span className="text-stone-300">·</span>
          <span className="flex items-center gap-1"><User size={12} strokeWidth={1.8} /> {task.assignedTo?.name}</span>
          {task.lead?.stage && (
            <>
              <span className="text-stone-300">·</span>
              <span className="capitalize">{task.lead.stage.replace(/_/g, ' ')}</span>
            </>
          )}
        </div>
        {task.agenda && <p className="text-xs text-stone-400 italic mt-1">{task.agenda}</p>}
        {task.outcome && (
          <p className="text-xs text-stone-500 mt-1"><span className="font-medium">Reason:</span> {task.outcome}</p>
        )}
        {task.attachments && task.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {task.attachments.map((att, i) => (
              att.fileUrl ? (
                <a
                  key={i}
                  href={att.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs bg-brand-50 text-brand-700 px-2 py-1 rounded-lg hover:bg-brand-100 transition-colors"
                  style={{ border: '1px solid #EDE8E3' }}
                >
                  <Paperclip size={11} strokeWidth={1.8} />
                  {att.fileName ?? `Attachment ${i + 1}`}
                </a>
              ) : (
                <span key={i} className="inline-flex items-center gap-1 text-xs bg-stone-100 text-stone-400 px-2 py-1 rounded-lg">
                  <Paperclip size={11} strokeWidth={1.8} />
                  Attachment unavailable
                </span>
              )
            ))}
          </div>
        )}
      </div>

      {isActionable(task) && (
        <div className="flex flex-col gap-1.5 shrink-0">
          <button
            onClick={() => onAction(task.id, 'complete')}
            className="text-xs text-stone-500 hover:text-green-600 transition-colors font-medium px-2.5 py-1 rounded-xl"
            style={{ border: '1px solid #EDE8E3' }}
          >
            Done
          </button>
          <button
            onClick={() => onAction(task.id, 'reschedule')}
            className="text-xs text-stone-500 hover:text-amber-600 transition-colors font-medium px-2.5 py-1 rounded-xl"
            style={{ border: '1px solid #EDE8E3' }}
          >
            Reschedule
          </button>
          <button
            onClick={() => onAction(task.id, 'not-done')}
            className="text-xs text-stone-500 hover:text-gray-700 transition-colors font-medium px-2.5 py-1 rounded-xl"
            style={{ border: '1px solid #EDE8E3' }}
          >
            Not Done
          </button>
        </div>
      )}
    </div>
  );
}

export default function Tasks() {
  const lenient = useLenientLaunch();
  const [myTasks, setMyTasks] = useState<FollowUpTask[]>([]);
  const [teamTasks, setTeamTasks] = useState<FollowUpTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('upcoming');
  const [tab, setTab] = useState<'my' | 'team'>('my');
  const user = getStoredUser();
  const { can } = usePermissions();
  // Team tasks follow Admin → Permissions ("See the team's tasks").
  const isBLOrHead = (user?.role === 'BL' || user?.role === 'BRANCH_HEAD') && can('TEAM_TASKS_VIEW');

  // Action modal: complete / not-done / reschedule — mirrors FollowUpTab.tsx's lead-scoped version.
  const [actionModal, setActionModal] = useState<{ taskId: string; kind: 'complete' | 'not-done' | 'reschedule' } | null>(null);
  const [actionFiles, setActionFiles] = useState<File[]>([]);
  const [actionForm, setActionForm] = useState({ outcome: '', completedAt: todayDateStr(), reason: '', dueDate: '', dueTime: '' });
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const [myRes, teamRes] = await Promise.all([
        api.get<{ tasks: FollowUpTask[] }>('/tasks/my?createdByRole=CRE'),
        isBLOrHead
          ? api.get<{ tasks: FollowUpTask[] }>('/tasks/team?createdByRole=CRE').catch(() => ({ tasks: [] as FollowUpTask[] }))
          : Promise.resolve({ tasks: [] }),
      ]);
      setMyTasks(myRes.tasks ?? []);
      setTeamTasks(teamRes.tasks ?? []);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTasks(); }, []);

  const openAction = (taskId: string, kind: 'complete' | 'not-done' | 'reschedule') => {
    setActionModal({ taskId, kind });
    setActionForm({ outcome: '', completedAt: todayDateStr(), reason: '', dueDate: '', dueTime: '' });
    setActionFiles([]);
    setActionError(null);
  };

  const handleAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!actionModal) return;
    setActionSubmitting(true);
    setActionError(null);
    try {
      if (actionModal.kind === 'complete') {
        if (actionFiles.length === 0 && !lenient) {
          throw new Error('At least one attachment is required to complete this task');
        }
        const leadId = [...myTasks, ...teamTasks].find((t) => t.id === actionModal.taskId)?.leadId;
        if (!leadId) throw new Error('Could not determine the lead for this task');
        const token = localStorage.getItem('crm_token') ?? '';
        const apiBase = (import.meta as any).env?.VITE_API_BASE ?? '/api';
        const attachments: { type: string; storagePath: string }[] = [];
        for (const file of actionFiles) {
          const formData = new FormData();
          formData.append('file', file);
          const resp = await fetch(`${apiBase}/leads/${leadId}/calls/upload-attachment`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error ?? 'Attachment upload failed');
          }
          const uploaded = await resp.json();
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
          dueDate: actionForm.dueDate, dueTime: actionForm.dueTime || undefined, reason: actionForm.reason.trim(),
        });
        toast.success('Task rescheduled');
      }
      setActionModal(null);
      await fetchTasks();
    } catch (e: any) {
      setActionError(e.message);
      toast.error(e.message);
    } finally {
      setActionSubmitting(false);
    }
  };

  const applyFilter = (tasks: FollowUpTask[]) => {
    if (filter === 'overdue') return tasks.filter((t) => t.isOverdue && t.status === 'PENDING');
    if (filter === 'completed') return tasks.filter((t) => t.status === 'COMPLETED');
    if (filter === 'not_done') return tasks.filter((t) => t.status === 'NOT_DONE');
    if (filter === 'upcoming') return tasks.filter((t) => t.status === 'PENDING' && !t.isOverdue);
    return tasks;
  };

  const activeTasks = applyFilter(tab === 'my' ? myTasks : teamTasks);
  const overdueCount = (tab === 'my' ? myTasks : teamTasks).filter((t) => t.isOverdue && t.status === 'PENDING').length;

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'overdue', label: `Overdue${overdueCount > 0 ? ` (${overdueCount})` : ''}` },
    { key: 'not_done', label: 'Not Done' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'completed', label: 'Completed' },
    { key: 'all', label: 'All' },
  ];

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">Tasks</h1>
          <p className="text-sm text-stone-400 mt-0.5">Tasks created by CREs across your leads</p>
        </div>
      </div>

      {isBLOrHead && (
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setTab('my')}
            className={`px-4 py-1.5 rounded-xl text-sm font-semibold transition-colors ${
              tab === 'my'
                ? 'bg-brand-500 text-white'
                : 'text-stone-500 hover:text-stone-800'
            }`}
            style={tab === 'my' ? {} : { border: '1px solid #EDE8E3' }}
          >
            My Tasks ({myTasks.length})
          </button>
          <button
            onClick={() => setTab('team')}
            className={`px-4 py-1.5 rounded-xl text-sm font-semibold transition-colors ${
              tab === 'team'
                ? 'bg-brand-500 text-white'
                : 'text-stone-500 hover:text-stone-800'
            }`}
            style={tab === 'team' ? {} : { border: '1px solid #EDE8E3' }}
          >
            Team Tasks ({teamTasks.length})
          </button>
        </div>
      )}

      <div className="flex gap-2 mb-4 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1 rounded-xl text-xs font-semibold transition-colors ${
              filter === f.key
                ? f.key === 'overdue'
                  ? 'bg-red-500 text-white'
                  : 'bg-brand-500 text-white'
                : 'text-stone-500 hover:text-stone-700'
            }`}
            style={filter === f.key ? {} : { border: '1px solid #EDE8E3' }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Action modal: mandatory outcome for complete/not-done, date+reason for reschedule */}
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
                  <input
                    type="file"
                    multiple
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      setActionFiles((prev) => [...prev, ...picked]);
                      e.target.value = '';
                    }}
                    className="block w-full text-sm text-gray-600"
                  />
                  {actionFiles.length === 0 ? (
                    lenient ? null : <p className="text-xs text-red-400 mt-1">At least one attachment is required</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {actionFiles.map((file, index) => (
                        <span key={`${file.name}-${index}`} className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                          {file.name}
                          <button
                            type="button"
                            onClick={() => setActionFiles((prev) => prev.filter((_, i) => i !== index))}
                            className="text-gray-400 hover:text-red-400"
                            aria-label={`Remove ${file.name}`}
                          >×</button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {actionModal.kind === 'reschedule' && (
                <>
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
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Time</label>
                      <TimeInput
                        value={actionForm.dueTime}
                        onChange={(v) => setActionForm({ ...actionForm, dueTime: v })}
                      />
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
                </>
              )}
              {actionError && <p className="text-sm text-red-500">{actionError}</p>}
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
        <div className="text-center text-stone-400 py-12 animate-pulse">Loading tasks…</div>
      ) : activeTasks.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-2xl mb-2">✓</p>
          <p className="text-stone-400 text-sm">No {filter !== 'all' ? filter.replace('_', ' ') : ''} tasks</p>
        </div>
      ) : (
        <div className="space-y-2">
          {activeTasks.map((task) => (
            <TaskCard key={task.id} task={task} onAction={openAction} />
          ))}
        </div>
      )}
    </div>
  );
}
