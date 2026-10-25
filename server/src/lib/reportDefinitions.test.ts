// Runs against the local test database (DATABASE_URL), never a shared one.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import { defaultReportDefinitions, getWonStages, npsSurveyForStage, reportDefinitionsConfig } from './reportDefinitions.js';
import { ConfigError } from './versionedConfig.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');

async function problemsOf(raw: unknown): Promise<string[]> {
  try { await reportDefinitionsConfig.spec.validate(raw); return []; } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}
async function save(raw: unknown) {
  const value = await reportDefinitionsConfig.spec.validate(raw);
  await prisma.assignmentConfig.create({ data: { key: 'report_definitions_v1', value: { value, revision: 1, updatedAt: new Date().toISOString(), updatedById: 'x' } as any } });
}

describe.skipIf(!safeDb)('report definitions', () => {
  beforeEach(async () => { await prisma.assignmentConfig.deleteMany({ where: { key: 'report_definitions_v1' } }); });
  afterAll(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: 'report_definitions_v1' } });
    await prisma.$disconnect();
  });

  it('with nothing saved: onboarded = Design in Progress (+ legacy Handed Over), no automatic NPS', async () => {
    expect(await getWonStages()).toEqual(['DESIGN_IN_PROGRESS', 'HANDED_OVER']);
    for (const stage of ['ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER']) {
      expect(await npsSurveyForStage(stage)).toBeNull();
    }
  });

  it('saved choices apply', async () => {
    await save({ wonStages: ['ONBOARDING', 'DESIGN_IN_PROGRESS'], npsTriggers: { SALE: 'ONBOARDING', DESIGN_FREEZE: null, SIGN_OFF: 'HANDED_OVER' } });
    expect(await getWonStages()).toEqual(['ONBOARDING', 'DESIGN_IN_PROGRESS']);
    expect(await npsSurveyForStage('ONBOARDING')).toBe('SALE');
    expect(await npsSurveyForStage('HANDED_OVER')).toBe('SIGN_OFF');
    expect(await npsSurveyForStage('DESIGN_IN_PROGRESS')).toBeNull();
  });

  it('rejects empty onboarded stages, unknown stages and two surveys on one stage', async () => {
    const d = defaultReportDefinitions();
    expect((await problemsOf({ ...d, wonStages: [] }))[0]).toMatch(/at least one stage/);
    expect(await problemsOf({ ...d, wonStages: ['MQL'] })).not.toEqual([]);
    expect(await problemsOf({ ...d, npsTriggers: { ...d.npsTriggers, SALE: 'MQL' } })).not.toEqual([]);
    expect((await problemsOf({ ...d, npsTriggers: { SALE: 'ONBOARDING', DESIGN_FREEZE: 'ONBOARDING', SIGN_OFF: null } }))[0]).toMatch(/can't both start/);
    expect(await problemsOf({ ...d, npsTriggers: { ...d.npsTriggers, ONBOARDING: 'ONBOARDING' } })).not.toEqual([]);
  });
});
