// Runs against the local test database (DATABASE_URL), never a shared one.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import {
  CRM_SETTINGS_KEY, CrmSettingsError, DEFAULT_CRM_SETTINGS, crmSettingsHistory, getCrmSettings,
  resetCrmSettings, saveCrmSettings, validateCrmSettings, type CrmSettings,
} from './crmSettings.js';
import { hasAllMqlMandatoryFields, missingMqlMandatoryFields } from './leadMandatoryFields.js';
import { computeApprovalRouting } from '../routes/discounts.js';
import { isWeeklyDigestDay } from '../jobs/weeklyDigestDay.js';
import { computeDesignPipelineTimeline } from '../config/slaConfig.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
let userId = '';

function problemsOf(raw: unknown): string[] {
  try { validateCrmSettings(raw); return []; } catch (e) {
    if (e instanceof CrmSettingsError) return e.problems;
    throw e;
  }
}

describe('discount routing follows the configured limits', () => {
  const d = DEFAULT_CRM_SETTINGS.discount;
  it('reproduces the original 10 / 15 / 20 % and ₹5L rules', () => {
    expect(computeApprovalRouting(10, 2_000_000, d)).toEqual({ approverRole: 'SELF', isSpecialCase: false });
    expect(computeApprovalRouting(10.5, 2_000_000, d)).toEqual({ approverRole: 'BL', isSpecialCase: false });
    expect(computeApprovalRouting(15, 2_000_000, d)).toEqual({ approverRole: 'BL', isSpecialCase: false });
    expect(computeApprovalRouting(16, 2_000_000, d)).toEqual({ approverRole: 'BRANCH_HEAD', isSpecialCase: false });
    expect(computeApprovalRouting(20, 2_000_000, d)).toEqual({ approverRole: 'BRANCH_HEAD', isSpecialCase: false });
    expect(computeApprovalRouting(21, 2_000_000, d)).toEqual({ approverRole: 'BRANCH_HEAD', isSpecialCase: true });
    expect(computeApprovalRouting(5, 520_000, d)).toEqual({ approverRole: 'BRANCH_HEAD', isSpecialCase: true }); // 4.94L after discount
  });
  it('uses new limits when they change', () => {
    const limits = { selfApproveUpToPct: 5, blApproveUpToPct: 12, branchHeadUpToPct: 25, woodworkSpecialCaseBelow: 300_000 };
    expect(computeApprovalRouting(8, 2_000_000, limits).approverRole).toBe('BL');
    expect(computeApprovalRouting(22, 2_000_000, limits)).toEqual({ approverRole: 'BRANCH_HEAD', isSpecialCase: false });
    expect(computeApprovalRouting(5, 500_000, limits)).toEqual({ approverRole: 'SELF', isSpecialCase: false });
  });
});

describe('design timeline uses the configured days', () => {
  it('overall days drive the breach point', () => {
    const kickoff = new Date('2026-01-01T00:00:00Z');
    const obm = { siteDocumentationAt: kickoff };
    const at = new Date('2026-02-03T00:00:00Z'); // 33 days in (warning from day 32 = 70% of 45)
    expect(computeDesignPipelineTimeline(obm, kickoff, at).overallStatus).toBe('warning'); // default 45 days
    expect(computeDesignPipelineTimeline(obm, kickoff, at, { phaseDays: DEFAULT_CRM_SETTINGS.designPhaseDays, overallDays: 30 }).overallStatus).toBe('breach');
  });
});

describe.skipIf(!safeDb)('CRM settings store (local test DB)', () => {
  beforeAll(async () => {
    userId = (await prisma.user.create({
      data: { supabaseId: `test-crm-settings-${Date.now()}`, name: 'CRM Settings Test Admin', email: `crm-settings-${Date.now()}@crm.test`, role: 'BRANCH_HEAD' },
    })).id;
  });
  beforeEach(async () => { await prisma.assignmentConfig.deleteMany({ where: { key: CRM_SETTINGS_KEY } }); });
  afterAll(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: CRM_SETTINGS_KEY } });
    await prisma.activityLog.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('with nothing saved, the original values apply', async () => {
    expect(await getCrmSettings()).toEqual(DEFAULT_CRM_SETTINGS);
    expect(validateCrmSettings(DEFAULT_CRM_SETTINGS)).toEqual(DEFAULT_CRM_SETTINGS);
  });

  it('explains problems in plain words', () => {
    const bad = clone(DEFAULT_CRM_SETTINGS) as any;
    bad.discount.blApproveUpToPct = 5;
    bad.onHoldReasons = [];
    bad.inactiveReasons = ['A', 'a'];
    bad.leadSources = bad.leadSources.map((s: any) => (s.value === 'OTHER' ? { ...s, active: false } : s));
    bad.reminderMinutesBefore = 5;
    bad.stageLabels.DQL = ' ';
    const p = problemsOf(bad).join('\n');
    expect(p).toMatch(/Discount limits.*must go up/);
    expect(p).toMatch(/On-hold reasons: Keep at least one reason/);
    expect(p).toMatch(/Inactive reasons \(1\): "a" is listed twice/);
    expect(p).toMatch(/Keep the "Other" source switched on/);
    expect(p).toMatch(/Reminder timing: must be at least 15 minutes/);
    expect(p).toMatch(/Stage names \(DQL\): cannot be empty/);
  });

  it('saving is versioned, logged and refuses a stale save', async () => {
    const s: CrmSettings = clone(DEFAULT_CRM_SETTINGS);
    s.onHoldReasons = [...s.onHoldReasons, 'Vastu check'];
    const saved = await saveCrmSettings(s, 0, userId, 'Added Vastu check');
    expect(saved.revision).toBe(1);
    expect((await getCrmSettings()).onHoldReasons).toContain('Vastu check');
    expect((await crmSettingsHistory())[0]).toMatchObject({ revision: 1, note: 'Added Vastu check', byName: 'CRM Settings Test Admin' });
    await expect(saveCrmSettings(s, 0, userId)).rejects.toMatchObject({ status: 409 });
  });

  it('new-lead details follow the setting', async () => {
    const lead = { projectType: 'Villa', scope: 'Full', location: 'Adyar, Chennai', possessionTimeline: 'Ready' };
    expect(await hasAllMqlMandatoryFields(lead)).toBe(true);
    const s: CrmSettings = clone(DEFAULT_CRM_SETTINGS);
    s.leadCreateRequired = [...s.leadCreateRequired, 'email'];
    await saveCrmSettings(s, 0, userId);
    expect(await hasAllMqlMandatoryFields(lead)).toBe(false);
    expect(await missingMqlMandatoryFields(lead)).toEqual(['email']);
  });

  it('the weekly digest runs only on the chosen day (IST)', async () => {
    const tuesday0800Ist = new Date('2026-10-27T02:30:00Z');
    expect(await isWeeklyDigestDay(tuesday0800Ist)).toBe(true);
    const s: CrmSettings = clone(DEFAULT_CRM_SETTINGS);
    s.weeklyDigestDay = 1;
    await saveCrmSettings(s, 0, userId);
    expect(await isWeeklyDigestDay(tuesday0800Ist)).toBe(false);
    expect(await isWeeklyDigestDay(new Date('2026-10-26T02:30:00Z'))).toBe(true);
  });

  it('restoring keeps the previous version in history', async () => {
    const s: CrmSettings = clone(DEFAULT_CRM_SETTINGS);
    s.hiddenStages = ['PROPOSAL_READY'];
    await saveCrmSettings(s, 0, userId);
    await resetCrmSettings(userId);
    expect(await getCrmSettings()).toEqual(DEFAULT_CRM_SETTINGS);
    const [latest, previous] = await crmSettingsHistory();
    expect(latest.action).toBe('CRM_SETTINGS_RESET');
    expect(previous.settings?.hiddenStages).toEqual(['PROPOSAL_READY']);
  });
});
