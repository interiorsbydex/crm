import { describe, expect, it } from 'vitest';
import { creCreatedTaskIds, type TaskCreationActivity, type TaskWithCreatorEvidence } from './creTaskScope.js';

const createdAt = new Date('2026-09-29T10:00:00.000Z');
const dueDate = new Date('2026-09-30T00:00:00.000Z');

function task(id: string, overrides: Partial<TaskWithCreatorEvidence> = {}): TaskWithCreatorEvidence {
  return {
    id, leadId: 'lead', assignedToId: 'assignee', createdAt, dueDate,
    dueTime: '11:30', taskType: 'INTERNAL', callStageType: null,
    originatingCallId: null, originatingCall: null, ...overrides,
  };
}

function activity(action: string, meta: unknown, role: string, overrides: Partial<TaskCreationActivity> = {}): TaskCreationActivity {
  return {
    action, meta, leadId: 'lead', createdAt: new Date(createdAt.getTime() + 5),
    user: { role }, ...overrides,
  };
}

describe('CRE-created tasks', () => {
  it('uses the creator role recorded at creation, not the assignee or the user’s current role', () => {
    const tasks = [task('from-cre'), task('from-bl'), task('unknown')];
    const activities = [
      activity('TASK_CREATED', { taskId: 'from-cre', createdByRole: 'CRE' }, 'BL'),
      activity('TASK_CREATED', { taskId: 'from-bl', createdByRole: 'BL' }, 'CRE'),
    ];
    expect([...creCreatedTaskIds(tasks, activities)]).toEqual(['from-cre']);
  });

  it('matches old task and scheduled-call creation events only when the evidence is unique', () => {
    const tasks = [
      task('old-cre-task'),
      task('old-cre-call', { createdAt: new Date(createdAt.getTime() + 20_000), taskType: 'EXTERNAL', callStageType: 'PP' }),
      task('other-lead', { leadId: 'elsewhere' }),
    ];
    const activities = [
      activity('TASK_CREATED', { dueDate: dueDate.toISOString(), taskType: 'INTERNAL', assignedToId: 'assignee' }, 'CRE'),
      activity('CALL_SCHEDULED', { dueDate: dueDate.toISOString(), dueTime: '11:30', taskType: 'EXTERNAL', stageType: 'PP' }, 'CRE', {
        createdAt: new Date(createdAt.getTime() + 20_005),
      }),
    ];
    expect([...creCreatedTaskIds(tasks, activities)]).toEqual(['old-cre-task', 'old-cre-call']);

    const indistinguishable = [task('first'), task('second')];
    expect(creCreatedTaskIds(indistinguishable, [activities[0]]).size).toBe(0);
  });

  it('attributes call-created tasks to the caller but rescheduled replacements to their own creator', () => {
    const fromCall = { originatingCallId: 'call', originatingCall: { loggedBy: { role: 'CRE' } } };
    const tasks = [task('original', fromCall), task('replacement', fromCall)];
    const activities = [activity('TASK_RESCHEDULED', { replacementTaskId: 'replacement', createdByRole: 'BL' }, 'CRE')];
    expect([...creCreatedTaskIds(tasks, activities)]).toEqual(['original']);
  });

  it('includes a meeting next-plan task with explicit creation evidence', () => {
    expect([...creCreatedTaskIds(
      [task('next-plan')],
      [activity('TASK_CREATED', { taskId: 'next-plan', createdByRole: 'CRE', source: 'NEXT_PLAN' }, 'CRE')],
    )]).toEqual(['next-plan']);
  });
});