// Runs against the local test database (DATABASE_URL), never a shared one.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import { BUILT_IN_ITEMS, checklistsConfig, defaultChecklists, evaluateChecklist, mergeCustomValues } from './checklists.js';
import { ConfigError } from './versionedConfig.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');
const LEAD = 'checklists-test-no-such-lead';

async function problemsOf(raw: unknown): Promise<string[]> {
  try { await checklistsConfig.spec.validate(raw); return []; } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}
async function saveConfig(raw: unknown) {
  const value = await checklistsConfig.spec.validate(raw);
  await prisma.assignmentConfig.create({ data: { key: 'checklists_v1', value: { value, revision: 1, updatedAt: new Date().toISOString(), updatedById: 'x' } as any } });
}

describe.skipIf(!safeDb)('checklists', () => {
  beforeEach(async () => { await prisma.assignmentConfig.deleteMany({ where: { key: 'checklists_v1' } }); });
  afterAll(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: 'checklists_v1' } });
    await prisma.$disconnect();
  });

  it('with nothing saved, every built-in item is required', async () => {
    const { items, missing } = await evaluateChecklist('dip', LEAD, {});
    expect(items.map((i) => i.key)).toEqual(BUILT_IN_ITEMS.dip.map((i) => i.key));
    expect(items.every((i) => i.required)).toBe(true);
    expect(missing).toHaveLength(BUILT_IN_ITEMS.dip.length);
  });

  it('done items drop off the missing list', async () => {
    const { missing } = await evaluateChecklist('dip', LEAD, { cxApprovalReceived: true, internalMailThreadCompleted: true });
    expect(missing).toEqual([expect.stringMatching(/^Payment screenshot/)]);
  });

  it('an optional item is shown but no longer missing', async () => {
    await saveConfig({ dip: { optional: ['internalMailThreadCompleted'], custom: [] } });
    const { items, missing } = await evaluateChecklist('dip', LEAD, { cxApprovalReceived: true });
    expect(items.find((i) => i.key === 'internalMailThreadCompleted')?.required).toBe(false);
    expect(missing).toEqual([expect.stringMatching(/^Payment screenshot/)]);
  });

  it('payment proof and NPS can never be made optional', async () => {
    expect((await problemsOf({ dip: { optional: ['paymentScreenshot'], custom: [] } }))[0]).toMatch(/can't be optional/);
    expect((await problemsOf({ pdOb: { optional: ['paymentScreenshot'], custom: [] } }))[0]).toMatch(/can't be optional/);
    expect((await problemsOf({ obObm: { optional: ['nps'], custom: [] } }))[0]).toMatch(/can't be optional/);
  });

  it('rejects unknown items, taken keys and documents without a type', async () => {
    expect(await problemsOf({ dip: { optional: ['nope'], custom: [] } })).toEqual([expect.stringMatching(/unknown item "nope"/)]);
    const dup = { key: 'site_visit', label: 'Site visit', kind: 'tick', required: true, active: true };
    expect((await problemsOf({ dip: { optional: [], custom: [dup, { ...dup, label: 'Again' }] } }))[0]).toMatch(/already taken/);
    expect((await problemsOf({ dip: { optional: [], custom: [{ ...dup, kind: 'document' }] } }))[0]).toMatch(/needs a document type/);
    expect((await problemsOf({ dip: { optional: [], custom: [{ ...dup, kind: 'document', docType: 'NOT_A_TYPE' }] } }))[0]).toMatch(/needs a document type/);
  });

  it('own items: required ones block, optional and unused ones do not', async () => {
    await saveConfig({ dip: { optional: [], custom: [
      { key: 'site_visit', label: 'Site visit done', kind: 'tick', required: true, active: true },
      { key: 'handover_date', label: 'Handover date', kind: 'date', required: false, active: true },
      { key: 'old_item', label: 'Old item', kind: 'text', required: true, active: false },
    ] } });
    const row = { cxApprovalReceived: true, internalMailThreadCompleted: true, customValues: {} };
    let r = await evaluateChecklist('dip', LEAD, row);
    expect(r.items.map((i) => i.key)).toEqual([...BUILT_IN_ITEMS.dip.map((i) => i.key), 'site_visit', 'handover_date']);
    expect(r.missing).toContain('Site visit done');
    expect(r.missing).not.toContain('Handover date');
    r = await evaluateChecklist('dip', LEAD, { ...row, customValues: { site_visit: true } });
    expect(r.missing).not.toContain('Site visit done');
    expect(r.items.find((i) => i.key === 'site_visit')?.custom?.value).toBe(true);
  });

  it('own document items are done only when that file is uploaded', async () => {
    await saveConfig({ dip: { optional: [], custom: [{ key: 'layout', label: 'Layout', kind: 'document', docType: 'PAYMENT_SCREENSHOT', required: true, active: true }] } });
    expect((await evaluateChecklist('dip', LEAD, {})).missing).toContain('Layout');
  });

  it('checks values sent for own items', async () => {
    await saveConfig({ pdOb: { optional: [], custom: [
      { key: 'site_visit', label: 'Site visit done', kind: 'tick', required: true, active: true },
      { key: 'visit_on', label: 'Visit date', kind: 'date', required: true, active: true },
      { key: 'layout', label: 'Layout', kind: 'document', docType: 'PAYMENT_SCREENSHOT', required: true, active: true },
    ] } });
    expect(await mergeCustomValues('pdOb', { visit_on: '2026-10-01' }, { site_visit: true })).toEqual({ visit_on: '2026-10-01', site_visit: true });
    expect(await mergeCustomValues('pdOb', { visit_on: '2026-10-01' }, { visit_on: null })).toEqual({});
    await expect(mergeCustomValues('pdOb', {}, { site_visit: 'yes' })).rejects.toThrow(/ticked/);
    await expect(mergeCustomValues('pdOb', {}, { visit_on: 'soon' })).rejects.toThrow(/date/);
    await expect(mergeCustomValues('pdOb', {}, { layout: true })).rejects.toThrow(/can fill in/);
    await expect(mergeCustomValues('pdOb', {}, { unknown: true })).rejects.toThrow(/can fill in/);
  });

  it('defaults cover all three checklists', () => {
    expect(Object.keys(defaultChecklists())).toEqual(['pdOb', 'obObm', 'dip']);
  });
});
