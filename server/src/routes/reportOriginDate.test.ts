import { describe, expect, it } from 'vitest';
import { buildLeadWhere } from './reports.js';

// Reports count a lead on the day it came in (leadOriginDate), never the day it was imported (createdAt).
describe('report date basis', () => {
  it('filters by leadOriginDate, in IST days', async () => {
    const w = await buildLeadWhere({ startDate: '2026-07-01', endDate: '2026-07-31' });
    expect(w.createdAt).toBeUndefined();
    expect(w.leadOriginDate.gte.toISOString()).toBe('2026-06-30T18:30:00.000Z');
    expect(w.leadOriginDate.lte.toISOString()).toBe('2026-07-31T18:29:59.999Z');
    expect(w.isTestLead).toBe(false);
  });

  it('groups the project-type filter by first word and keeps it next to the role scope', async () => {
    const w = await buildLeadWhere({ projectType: 'Apartment' }, 'DESIGNER', 'd1');
    expect(w.projectType).toBeUndefined();
    expect(w.AND).toEqual([
      { projectType: { startsWith: 'Apartment', mode: 'insensitive' } },
      { assignedDesignerId: 'd1' },
    ]);
  });
});
