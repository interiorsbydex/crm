import { describe, it, expect } from 'vitest';
import { possessionDate, possessionWhere } from './possessionFilter.js';
import { PERMISSIONS, defaultPermissions, permissionsConfig } from './permissions.js';

// Values as they appear on Annie's live leads.
const leads = [
  { id: 'rec', possessionTimeline: 'Possession Received' },
  { id: 'iso', possessionTimeline: '2026-11-15' },
  { id: 'dmy', possessionTimeline: '01-12-2026' },
  { id: 'dmy27', possessionTimeline: '01-09-2027' },
  { id: 'range', possessionTimeline: '3-6 months' },
  { id: 'range2', possessionTimeline: '6-12 months' },
  { id: 'text', possessionTimeline: 'Dec 2026' },
  { id: 'year', possessionTimeline: '2027' },
];
const db = { lead: { findMany: async () => leads } };
const run = async (p?: string, from?: string, to?: string) => {
  const c = await possessionWhere(db, p, from, to);
  if (!c) return null;
  if (c.id) return c.id.in.sort();
  return leads.filter((l) => l.possessionTimeline.toLowerCase().includes(c.possessionTimeline.contains)).map((l) => l.id);
};

describe('Possession filter', () => {
  it('reads both date styles, and nothing that is not a full date', () => {
    expect(possessionDate('2026-11-15')).toBe('2026-11-15');
    expect(possessionDate('01-12-2026')).toBe('2026-12-01');
    expect(possessionDate('3-6 months')).toBeNull();
    expect(possessionDate('Dec 2026')).toBeNull();
    expect(possessionDate('2027')).toBeNull();
  });
  it('no filter → no condition', async () => {
    expect(await run('', '', '')).toBeNull();
  });
  it('"Possession Received" finds only received leads', async () => {
    expect(await run('received', '2026-01-01', '2026-12-31')).toEqual(['rec']);
  });
  it('"Possession date given" finds leads with a date in either style, not "3-6 months"', async () => {
    expect(await run('date')).toEqual(['dmy', 'dmy27', 'iso']);
  });
  it('a date range keeps both end days and compares real dates', async () => {
    expect(await run('', '2026-11-15', '2026-12-01')).toEqual(['dmy', 'iso']);
    expect(await run('', '2027-01-01', '')).toEqual(['dmy27']);
  });
});

describe('Export permission', () => {
  it('is in Admin → Permissions, off for everyone (Branch Head too) until Annie switches it on', () => {
    const def = PERMISSIONS.find((p) => p.key === 'LEAD_EXPORT')!;
    expect(def.roles).toEqual(['BL', 'BRANCH_HEAD']);
    expect(defaultPermissions().LEAD_EXPORT).toEqual([]);
  });
  it('the Branch Head can switch it off for itself, and back on', async () => {
    expect((await permissionsConfig.spec.validate({ LEAD_EXPORT: [] })).LEAD_EXPORT).toEqual([]);
    expect((await permissionsConfig.spec.validate({ LEAD_EXPORT: ['BRANCH_HEAD'] })).LEAD_EXPORT).toEqual(['BRANCH_HEAD']);
  });
  it('every other permission stays locked on for the Branch Head', async () => {
    expect(PERMISSIONS.filter((p) => p.branchHeadOptional).map((p) => p.key)).toEqual(['LEAD_EXPORT']);
    expect((await permissionsConfig.spec.validate({ OFFERS_MANAGE: [] })).OFFERS_MANAGE).toEqual(['BRANCH_HEAD']);
  });
});
