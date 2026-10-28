import { describe, expect, it } from 'vitest';
import { designerAssignmentAgeDays, designerAssignmentDates } from './designerAssignmentAge.js';

const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00Z`);
describe('Designer age uses reliable assignment events, not lead origin', () => {
  it('starts from assignment and stops at DIP when recorded', () => {
    expect(designerAssignmentAgeDays(at(20), undefined, at(24))).toBe(4);
    expect(designerAssignmentAgeDays(at(20), at(22), at(24))).toBe(2);
  });
  it('does not invent an age when timing evidence is absent or contradictory', () => {
    expect(designerAssignmentAgeDays(undefined, undefined, at(24))).toBeNull();
    expect(designerAssignmentAgeDays(at(24), at(20), at(24))).toBeNull();
  });
  it('uses the latest verified reassignment to the current Designer', () => {
    const dates = designerAssignmentDates([
      { leadId: 'lead', createdAt: at(10), meta: { assignedDesignerId: 'one' } },
      { leadId: 'lead', createdAt: at(15), meta: { assignedDesignerId: 'two' } },
      { leadId: 'lead', createdAt: at(20), meta: { assignedDesignerId: 'one' } },
    ], 'one');
    expect(dates.get('lead')).toEqual(at(20));
  });
  it('counts a direct assignment from the Business Lead (it records the designer id)', () => {
    const dates = designerAssignmentDates([
      { leadId: 'lead', createdAt: at(10), meta: { assignedDesignerId: 'cre' } },
      { leadId: 'lead', createdAt: at(12), meta: { designerName: 'Test Designer 1', assignedById: 'bl', assignedDesignerId: 'one' } },
    ], 'one');
    expect(dates.get('lead')).toEqual(at(12));
  });
  it('does not reuse an old date across a later unidentifiable assignment', () => {
    const dates = designerAssignmentDates([
      { leadId: 'lead', createdAt: at(10), meta: { assignedDesignerId: 'one' } },
      { leadId: 'lead', createdAt: at(20), meta: { designerName: 'Legacy name-only event' } },
    ], 'one');
    expect(dates.has('lead')).toBe(false);
  });
});
