import { describe, expect, it } from 'vitest';
import { leadOrderBy, LEAD_SORT_COLUMNS } from './leadSort.js';

describe('leadOrderBy', () => {
  it('is newest first when nothing (or something unknown) is asked for', () => {
    expect(leadOrderBy()).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
    expect(leadOrderBy('password', 'asc')).toEqual(leadOrderBy());
  });
  it('sorts on the chosen column and direction, with newest first as the tie-break', () => {
    expect(leadOrderBy('name', 'asc')[0]).toEqual({ name: 'asc' });
    expect(leadOrderBy('name', 'desc')[0]).toEqual({ name: 'desc' });
    expect(leadOrderBy('name', 'sideways')[0]).toEqual({ name: 'desc' });
    expect(leadOrderBy('designer', 'asc')[0]).toEqual({ assignedDesigner: { name: 'asc' } });
    expect(leadOrderBy('updated', 'asc').slice(1)).toEqual(leadOrderBy());
  });
  it('puts leads with no value / intent / source last in either direction', () => {
    for (const col of ['value', 'intent', 'source']) {
      for (const d of ['asc', 'desc']) expect(JSON.stringify(leadOrderBy(col, d)[0])).toContain('"nulls":"last"');
    }
  });
  it('every sortable column produces an order', () => {
    for (const c of LEAD_SORT_COLUMNS) expect(leadOrderBy(c, 'asc').length).toBe(3);
  });
});
