export interface TaskWithCreatorEvidence {
  id: string;
  leadId: string;
  assignedToId: string;
  createdAt: Date;
  dueDate: Date;
  dueTime: string | null;
  taskType: string | null;
  callStageType: string | null;
  originatingCallId: string | null;
  originatingCall: { loggedBy: { role: string } } | null;
}

export interface TaskCreationActivity {
  leadId: string | null;
  action: string;
  createdAt: Date;
  meta: unknown;
  user: { role: string };
}

function details(meta: unknown): Record<string, unknown> | null {
  return meta !== null && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : null;
}

function creatorRole(activity: TaskCreationActivity, meta: Record<string, unknown>): string {
  return typeof meta.createdByRole === 'string' ? meta.createdByRole : activity.user.role;
}

// Legacy task-creation activity has no task ID. It was written immediately
// after the row; only accept an unambiguous match on lead, due date, details,
// and a short creation-time window. Unknown creators remain excluded.
function matchesLegacyCreation(task: TaskWithCreatorEvidence, activity: TaskCreationActivity, meta: Record<string, unknown>): boolean {
  if (task.leadId !== activity.leadId || task.originatingCallId !== null) return false;
  const elapsed = activity.createdAt.getTime() - task.createdAt.getTime();
  if (elapsed < 0 || elapsed > 10_000) return false;
  if (typeof meta.dueDate !== 'string') return false;
  const dueDate = new Date(meta.dueDate);
  if (Number.isNaN(dueDate.getTime()) || dueDate.getTime() !== task.dueDate.getTime()) return false;
  if (typeof meta.assignedToId === 'string' && meta.assignedToId !== task.assignedToId) return false;
  if (typeof meta.taskType === 'string' && meta.taskType !== task.taskType) return false;
  if (activity.action === 'TASK_CREATED') return task.callStageType === null;
  return activity.action === 'CALL_SCHEDULED'
    && typeof meta.stageType === 'string'
    && meta.stageType === task.callStageType
    && (typeof meta.dueTime !== 'string' || meta.dueTime === task.dueTime);
}

export function creCreatedTaskIds(tasks: TaskWithCreatorEvidence[], activities: TaskCreationActivity[]): Set<string> {
  const taskIds = new Set(tasks.map((task) => task.id));
  const rolesByTask = new Map<string, string>();
  const replacementIds = new Set<string>();

  // Exact task IDs take priority. A rescheduled task is created by the
  // rescheduler, even when it retains a link to an earlier call by someone else.
  for (const activity of activities) {
    const meta = details(activity.meta);
    if (!meta || activity.action === 'TASK_RESCHEDULED') continue;
    if (!['TASK_CREATED', 'CALL_SCHEDULED', 'CALL_LOGGED'].includes(activity.action)) continue;
    if (typeof meta.taskId === 'string' && taskIds.has(meta.taskId)) {
      rolesByTask.set(meta.taskId, creatorRole(activity, meta));
    }
  }
  for (const activity of activities) {
    if (activity.action !== 'TASK_RESCHEDULED') continue;
    const meta = details(activity.meta);
    if (typeof meta?.replacementTaskId !== 'string') continue;
    replacementIds.add(meta.replacementTaskId);
    if (taskIds.has(meta.replacementTaskId)) {
      rolesByTask.set(meta.replacementTaskId, creatorRole(activity, meta));
    }
  }

  const legacyMatches = new Map<string, string[]>();
  for (const activity of activities) {
    if (!['TASK_CREATED', 'CALL_SCHEDULED'].includes(activity.action)) continue;
    const meta = details(activity.meta);
    if (!meta || typeof meta.taskId === 'string') continue;
    const candidates = tasks.filter((task) =>
      !rolesByTask.has(task.id)
      && !replacementIds.has(task.id)
      && matchesLegacyCreation(task, activity, meta));
    if (candidates.length === 1) {
      const candidate = candidates[0];
      legacyMatches.set(candidate.id, [...(legacyMatches.get(candidate.id) ?? []), creatorRole(activity, meta)]);
    }
  }
  for (const [id, roles] of legacyMatches) {
    if (roles.length === 1) rolesByTask.set(id, roles[0]);
  }

  return new Set(tasks
    .filter((task) => (rolesByTask.get(task.id) ?? task.originatingCall?.loggedBy.role) === 'CRE')
    .map((task) => task.id));
}