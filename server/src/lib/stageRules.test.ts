// Runs against the local test database (DATABASE_URL), never a shared one.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import {
  StageRulesError, loadStageRulesState, previewStageRulesImpact, resetStageRules, saveStageRules,
  stageRulesHistory, validateStageRules,
} from './stageRules.js';
import { DOCUMENT_TYPES_CONFIG_KEY } from './documentTypes.js';
import {
  STAGE_RULES_CONFIG_KEY, checkStageRequirements, defaultStageRules, getEffectiveStageRules,
} from '../config/stageRequirements.js';

const dbUrl = process.env.DATABASE_URL ?? '';
const safeDb = /@localhost:\d+\//.test(dbUrl);

let userId = '';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

async function problemsOf(raw: unknown): Promise<string[]> {
  try { await validateStageRules(raw); return []; } catch (e) {
    if (e instanceof StageRulesError) return e.problems;
    throw e;
  }
}

describe.skipIf(!safeDb)('stage rules admin (local test DB)', () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { supabaseId: `test-stage-rules-${Date.now()}`, name: 'Stage Rules Test Admin', email: `stage-rules-${Date.now()}@crm.test`, role: 'BRANCH_HEAD' },
    });
    userId = u.id;
  });
  beforeEach(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: { in: [STAGE_RULES_CONFIG_KEY, DOCUMENT_TYPES_CONFIG_KEY] } } });
  });
  afterAll(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: { in: [STAGE_RULES_CONFIG_KEY, DOCUMENT_TYPES_CONFIG_KEY] } } });
    await prisma.lead.deleteMany({ where: { leadId: { startsWith: 'TSR-' } } });
    await prisma.activityLog.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('the original rules pass validation unchanged', async () => {
    const cleaned = await validateStageRules(defaultStageRules());
    expect(cleaned).toEqual(defaultStageRules());
  });

  it('explains every problem in plain words', async () => {
    const bad = clone(defaultStageRules());
    bad.transitions['MQL->DQL'].push({ id: 'a', type: 'file', fileType: 'NOT_A_TYPE', stages: [], label: 'Mystery doc', whenSkipped: 'required' } as any);
    bad.transitions['MQL->DQL'].push({ id: 'b', type: 'field', field: 'builder', label: 'Tentative project value', whenSkipped: 'required' } as any);
    bad.transitions['PROPOSAL_READY->PROPOSAL_PRESENTED'].push({ id: 'c', type: 'field', field: 'builder', label: 'Builder', whenSkipped: 'owedLater' } as any);
    bad.transitions['DQL->PROPOSAL_READY'].push({ id: 'd', type: 'field', field: 'builder', label: '   ', whenSkipped: 'required' } as any);
    (bad.transitions as any)['MQL->ONBOARDING'] = [];
    const problems = await problemsOf(bad);
    expect(problems.join('\n')).toMatch(/unknown or switched-off document type "NOT_A_TYPE"/);
    expect(problems.join('\n')).toMatch(/"Tentative project value" is used twice/);
    expect(problems.join('\n')).toMatch(/only possible on moves into DQL, Proposal Ready or PD/);
    expect(problems.join('\n')).toMatch(/needs a message for the designer/);
    expect(problems.join('\n')).toMatch(/Unknown stage move "MQL->ONBOARDING"/);
  });

  it('checklist steps cannot be removed or changed', async () => {
    const cfg = clone(defaultStageRules());
    cfg.transitions['ONBOARDING->ONBOARDING_MEETING'] = [];
    cfg.transitions['PROPOSAL_DISCUSSION->ONBOARDING'] = cfg.transitions['PROPOSAL_DISCUSSION->ONBOARDING']
      .map((r) => (r.locked ? { ...r, label: 'renamed' } : r));
    const cleaned = await validateStageRules(cfg);
    expect(cleaned.transitions['ONBOARDING->ONBOARDING_MEETING']).toEqual(defaultStageRules().transitions['ONBOARDING->ONBOARDING_MEETING']);
    expect(cleaned.transitions['PROPOSAL_DISCUSSION->ONBOARDING'].find((r) => r.locked)?.label).toBe('Completed PD→OB checklist (welcome mail sent)');
  });

  it('saving applies to the next stage check, is versioned and logged', async () => {
    const cfg = clone(defaultStageRules());
    cfg.transitions['MQL->DQL'] = [{ id: 'only', type: 'field', field: 'builder', label: 'Builder name needed', whenSkipped: 'required' }];
    const saved = await saveStageRules(cfg, 0, userId, 'Only builder for now');
    expect(saved.revision).toBe(1);

    const lead = await prisma.lead.create({ data: { leadId: `TSR-${Date.now()}`, name: 'Stage rules test', phone: '+919800000001', isTestLead: true } });
    const gate = await checkStageRequirements(lead, 'MQL', 'DQL');
    expect(gate.missing).toEqual(['Builder name needed']);

    const history = await stageRulesHistory();
    expect(history[0]).toMatchObject({ action: 'STAGE_RULES_UPDATED', revision: 1, note: 'Only builder for now', byName: 'Stage Rules Test Admin' });
    expect((await loadStageRulesState()).isDefault).toBe(false);
  });

  it('refuses to overwrite someone else\'s newer save', async () => {
    await saveStageRules(defaultStageRules(), 0, userId);
    await expect(saveStageRules(defaultStageRules(), 0, userId)).rejects.toMatchObject({ status: 409 });
  });

  it('restoring the original rules keeps the old version in history', async () => {
    const cfg = clone(defaultStageRules());
    cfg.skippableStages = [];
    await saveStageRules(cfg, 0, userId);
    await resetStageRules(userId);
    expect(await getEffectiveStageRules()).toEqual(defaultStageRules());
    const [latest, previous] = await stageRulesHistory();
    expect(latest.action).toBe('STAGE_RULES_RESET');
    expect(previous.config?.skippableStages).toEqual([]);
  });

  it('preview reports leads whose next move would newly be held up', async () => {
    const lead = await prisma.lead.create({
      data: { leadId: `TSR-P${Date.now()}`, name: 'Preview test', phone: '+919800000002', stage: 'DQL', estimatedValue: 500000 },
    });
    const cfg = clone(defaultStageRules());
    cfg.transitions['DQL->PROPOSAL_READY'] = [{ id: 'x', type: 'field', field: 'builder', label: 'Builder', whenSkipped: 'required' }];
    const before = await previewStageRulesImpact(defaultStageRules());
    expect(before.rows.find((r) => r.stage === 'DQL')?.newlyHeldUp ?? 0).toBe(0);
    // Default rules: the lead lacks the pitch file + quote, so it is held up now
    // and would be held up by "Builder" too — no change either way.
    const after = await previewStageRulesImpact(cfg);
    const row = after.rows.find((r) => r.stage === 'DQL')!;
    expect(row.leads).toBeGreaterThanOrEqual(1);
    expect(row.newlyHeldUp).toBe(0);

    await prisma.lead.update({ where: { id: lead.id }, data: { builder: 'Prestige' } });
    const cleared = await previewStageRulesImpact(cfg);
    expect(cleared.rows.find((r) => r.stage === 'DQL')!.newlyClear).toBeGreaterThanOrEqual(1);
  });
});
