import { describe, it, expect } from 'vitest';
import { possessionWhere } from './possessionFilter.js';
import { PERMISSIONS, defaultPermissions, permissionsConfig } from './permissions.js';

// Mirrors the text comparisons Postgres does for the conditions possessionWhere builds.
function matches(cond: any, value: string | null): boolean {
  if (!cond) return true;
  if (cond.AND) return cond.AND.every((c: any) => matches(c, value));
  const f = cond.possessionTimeline;
  if (value == null) return false;
  if (f.contains !== undefined) return f.mode === 'insensitive' ? value.toLowerCase().includes(f.contains.toLowerCase()) : value.includes(f.contains);
  if (f.gte !== undefined) return value >= f.gte;
  if (f.lte !== undefined) return value <= f.lte;
  return false;
}

const values = ['Possession Received', '2026-11-15', '2027-03-01', '3 months', null];

describe('Possession filter', () => {
  it('no filter → no condition', () => {
    expect(possessionWhere('', '', '')).toBeNull();
  });
  it('"Possession Received" finds only received leads', () => {
    const c = possessionWhere('received', '2026-01-01', '2026-12-31');
    expect(values.filter((v) => matches(c, v))).toEqual(['Possession Received']);
  });
  it('"Possession date given" finds only leads with a date', () => {
    const c = possessionWhere('date');
    expect(values.filter((v) => matches(c, v))).toEqual(['2026-11-15', '2027-03-01']);
  });
  it('a date range keeps both end days and leaves out received / free text', () => {
    const c = possessionWhere('', '2026-11-15', '2026-12-31');
    expect(values.filter((v) => matches(c, v))).toEqual(['2026-11-15']);
    const c2 = possessionWhere('', '2026-01-01', '2027-03-01');
    expect(values.filter((v) => matches(c2, v))).toEqual(['2026-11-15', '2027-03-01']);
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
