/** Pure report math: stage inventory and stage progression are deliberately separate. */
export type PipelineLead = {
  id: string;
  leadId: string;
  name: string;
  stage: string;
  status: string;
};

export function currentStageInventory<T extends PipelineLead>(leads: T[], stages: readonly string[]) {
  const row = (stage: string, members: T[]) => ({
    stage,
    total: members.length,
    active: members.filter((l) => l.status === 'ACTIVE'),
    onHold: members.filter((l) => l.status === 'ON_HOLD'),
    inactive: members.filter((l) => l.status === 'INACTIVE'),
    leads: members,
  });
  const cohort = leads.filter((l) => stages.includes(l.stage));
  return [
    ...stages.map((stage) => row(stage, cohort.filter((l) => l.stage === stage))),
    row('TOTAL', cohort),
  ];
}

/**
 * Progression counts use the furthest recorded/current stage, not how many leads
 * happen to sit in two different stages today. A moved-back lead retains its
 * history. Later stages imply earlier stages, matching the existing funnel.
 * Final conversion always requires the completed DIP checklist.
 */
export function stageProgression<T extends PipelineLead & { dipChecklist: { completedAt: Date | null } | null }>(
  leads: T[],
  stages: readonly string[],
  entries: Map<string, Map<string, Date>>,
) {
  const reached = new Map(leads.map((lead) => {
    let furthest = stages.indexOf(lead.stage);
    for (const stage of entries.get(lead.id)?.keys() ?? []) {
      furthest = Math.max(furthest, stages.indexOf(stage));
    }
    if (stages[furthest] === 'DESIGN_IN_PROGRESS' && !lead.dipChecklist?.completedAt) furthest--;
    return [lead.id, furthest];
  }));
  return stages.slice(0, -1).map((from, i) => {
    const source = leads.filter((lead) => reached.get(lead.id)! >= i);
    const converted = source.filter((lead) => reached.get(lead.id)! >= i + 1);
    return {
      from, to: stages[i + 1], source, converted,
      rate: source.length ? Math.round(converted.length / source.length * 1000) / 10 : null,
    };
  });
}
