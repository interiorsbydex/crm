import { describe, expect, it } from 'vitest';
import { boxRoleFor, computeBox, customBoxesConfig, type BoxLead, type CustomBox } from './customBoxes.js';

const day = 86_400_000;
const now = new Date('2026-10-28T00:00:00Z');
const lead = (over: Partial<BoxLead>): BoxLead => ({ stage: 'MQL', status: 'ACTIVE', source: 'WEBSITE', estimatedValue: 1_000_000, createdAt: new Date(now.getTime() - 10 * day), designerName: 'Asha', ...over });
const box = (over: Partial<CustomBox>): CustomBox => ({ id: 'b1', title: 'Box', measure: 'count', split: 'none', stages: [], statuses: [], sources: [], createdWithinDays: null, roles: ['BRANCH_HEAD'], ...over });
const leads = [
  lead({}),
  lead({ stage: 'DQL', source: 'REFERRAL', estimatedValue: 3_000_000, designerName: 'Ravi', createdAt: new Date(now.getTime() - 40 * day) }),
  lead({ stage: 'DQL', status: 'ON_HOLD', estimatedValue: null, designerName: null }),
];

describe('custom boxes', () => {
  it('counts, totals and averages leads that match the filters', () => {
    expect(computeBox(box({}), leads, now)).toMatchObject({ value: 3 });
    expect(computeBox(box({ stages: ['DQL'] }), leads, now)).toMatchObject({ value: 2 });
    expect(computeBox(box({ measure: 'totalValue', stages: ['DQL'] }), leads, now)).toMatchObject({ value: 3_000_000 });
    expect(computeBox(box({ measure: 'avgValue' }), leads, now)).toMatchObject({ value: 2_000_000 });
    expect(computeBox(box({ statuses: ['ON_HOLD'] }), leads, now)).toMatchObject({ value: 1 });
    expect(computeBox(box({ sources: ['REFERRAL'] }), leads, now)).toMatchObject({ value: 1 });
  });
  it('only counts leads created inside the chosen number of days', () => {
    expect(computeBox(box({ createdWithinDays: 30 }), leads, now)).toMatchObject({ value: 2 });
  });
  it('shows no average when nothing matches', () => {
    expect(computeBox(box({ measure: 'avgValue', stages: ['HANDED_OVER'] }), leads, now)).toMatchObject({ value: null });
  });
  it('splits into rows, biggest first', () => {
    const r = computeBox(box({ split: 'stage' }), leads, now);
    expect(r).toMatchObject({ split: 'stage', rows: [{ key: 'DQL', value: 2, leads: 2 }, { key: 'MQL', value: 1, leads: 1 }] });
    const d = computeBox(box({ split: 'designer', measure: 'totalValue' }), leads, now);
    expect((d as any).rows.map((x: any) => x.key)).toEqual(['Ravi', 'Asha', 'Not assigned']);
  });
  it('works out whose dashboard a role sees', () => {
    expect(boxRoleFor('ADMIN')).toBe('BRANCH_HEAD');
    expect(boxRoleFor('BL')).toBe('BL');
    expect(boxRoleFor('SOMEONE')).toBeNull();
  });
  it('refuses boxes that do not make sense, in plain words', async () => {
    const v = async (x: unknown) => customBoxesConfig.spec.validate(x);
    await expect(v({ boxes: [{ ...box({}), title: ' ' }] })).rejects.toThrow(/could not be saved/);
    await expect(v({ boxes: [box({ roles: [] })] })).rejects.toMatchObject({ problems: expect.arrayContaining([expect.stringMatching(/pick at least one dashboard/)]) });
    await expect(v({ boxes: [box({ createdWithinDays: 0 })] })).rejects.toMatchObject({ problems: expect.arrayContaining([expect.stringMatching(/at least 1/)]) });
    await expect(v({ boxes: [box({ id: 'a1', title: 'Same' }), box({ id: 'a2', title: 'same' })] })).rejects.toMatchObject({ problems: [expect.stringMatching(/used by two boxes/)] });
    await expect(v({ boxes: [box({ stages: ['NOPE' as any] })] })).rejects.toThrow();
    expect((await v({ boxes: [box({})] })).boxes).toHaveLength(1);
  });
});
