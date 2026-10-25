import { describe, expect, it } from 'vitest';
import { currentStageInventory, stageProgression } from './reportPipeline.js';

const stages = ['MQL', 'DQL', 'PROPOSAL_PRESENTED', 'DESIGN_IN_PROGRESS'];
const lead = (id: string, stage: string, status = 'ACTIVE', completed = false) => ({
  id, leadId: id, name: 'Report fixture', stage, status,
  dipChecklist: completed ? { completedAt: new Date('2026-10-15') } : null,
});

describe('current stage inventory', () => {
  it('counts each lead once, not cumulatively, including every status', () => {
    const rows = currentStageInventory([
      lead('a', 'MQL'), lead('b', 'DQL', 'ON_HOLD'), lead('c', 'DQL', 'INACTIVE'),
      lead('d', 'DESIGN_IN_PROGRESS'), lead('legacy', 'HANDED_OVER'),
    ], stages);
    expect(rows.map((r) => r.total)).toEqual([1, 2, 0, 1, 4]);
    for (const r of rows) expect(r.total).toBe(r.active.length + r.onHold.length + r.inactive.length);
    expect(rows[1].onHold.map((l) => l.id)).toEqual(['b']);
    expect(rows[1].inactive.map((l) => l.id)).toEqual(['c']);
  });
  it('returns zero rows and a zero total for an empty scope', () => {
    expect(currentStageInventory([], stages).map((r) => r.total)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('stage progression', () => {
  it('uses the source-stage population as the denominator', () => {
    const rows = stageProgression([
      lead('a', 'MQL'), lead('b', 'DQL'), lead('c', 'PROPOSAL_PRESENTED'),
      lead('d', 'DESIGN_IN_PROGRESS', 'ACTIVE', true),
    ], stages, new Map());
    expect(rows.map((r) => [r.source.length, r.converted.length, r.rate])).toEqual([
      [4, 3, 75], [3, 2, 66.7], [2, 1, 50],
    ]);
  });
  it('keeps the furthest recorded stage for a lead moved backwards', () => {
    const rows = stageProgression([lead('a', 'MQL', 'ON_HOLD')], stages,
      new Map([['a', new Map([['PROPOSAL_PRESENTED', new Date()]])]]));
    expect(rows[1].converted).toHaveLength(1);
  });
  it('requires the DIP checklist for terminal conversion', () => {
    const rows = stageProgression([lead('a', 'DESIGN_IN_PROGRESS')], stages, new Map());
    expect(rows[2].source).toHaveLength(1);
    expect(rows[2].converted).toHaveLength(0);
    expect(rows[2].rate).toBe(0);
  });
  it('returns N/A (null), not a misleading percentage, for no source leads', () => {
    expect(stageProgression([], stages, new Map()).every((r) => r.rate === null)).toBe(true);
  });
});
