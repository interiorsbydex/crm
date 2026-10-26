import { describe, expect, it } from 'vitest';
import { diffLeadDetails } from './leadChanges.js';

describe('diffLeadDetails', () => {
  const before = { name: 'A', phone: '+919800000001', email: 'a@x.com', estimatedValue: '1500000.00', location: 'Chennai', projectType: '2BHK', scope: null, notes: 'secret', pan: 'ABCDE1234F' };
  it('records nothing when nothing changed (blank vs empty, 1500000 vs 1500000.00 are the same)', () => {
    expect(diffLeadDetails(before, { ...before, estimatedValue: 1500000, scope: '', email: ' a@x.com ' })).toEqual([]);
  });
  it('records each changed field old → new with plain labels', () => {
    const d = diffLeadDetails(before, { ...before, estimatedValue: 2000000, location: 'Madurai', scope: 'FHD' });
    expect(d.map((c) => c.field).sort()).toEqual(['estimatedValue', 'location', 'scope']);
    expect(d.find((c) => c.field === 'estimatedValue')).toMatchObject({ from: '1500000', to: '2000000' });
  });
  it('says ID numbers and notes changed without copying them', () => {
    const d = diffLeadDetails(before, { ...before, pan: 'ZZZZZ9999Z', notes: 'new note' });
    expect(d.map((c) => [c.field, c.from, c.to])).toEqual([['pan', null, null], ['notes', null, null]]);
  });
});
