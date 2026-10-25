// Runs against the local test database (DATABASE_URL), never a shared one.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import { defaultMeetingSettings, getModeRatings, meetingSettingsConfig } from './meetingSettings.js';
import { computeAutoRatingFromMode, computeSystemRating, MODE_TO_RATING } from '../services/intentScoring.js';
import { ConfigError } from './versionedConfig.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');

async function save(raw: unknown) {
  const value = await meetingSettingsConfig.spec.validate(raw);
  await prisma.assignmentConfig.create({ data: { key: 'meetings_v1', value: { value, revision: 1, updatedAt: new Date().toISOString(), updatedById: 'x' } as any } });
}
async function problemsOf(raw: unknown): Promise<string[]> {
  try { await meetingSettingsConfig.spec.validate(raw); return []; } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}

describe.skipIf(!safeDb)('meeting settings', () => {
  beforeEach(async () => { await prisma.assignmentConfig.deleteMany({ where: { key: 'meetings_v1' } }); });
  afterAll(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: 'meetings_v1' } });
    await prisma.$disconnect();
  });

  it('with nothing saved, stars match the original rules', async () => {
    expect(await getModeRatings()).toEqual(MODE_TO_RATING);
  });

  it('saved stars drive the automatic intent rating', async () => {
    const s = defaultMeetingSettings();
    s.modes.VIRTUAL.stars = 5;
    await save(s);
    const ratings = await getModeRatings();
    expect(computeAutoRatingFromMode('VIRTUAL', ratings)).toBe(5);
    expect(computeSystemRating({ meetings: [{ mode: 'VIRTUAL', status: 'SCHEDULED' }] }, ratings)).toBe(5);
    expect(computeSystemRating({ meetings: [] }, ratings)).toBe(1);
  });

  it('needs at least one type in use and stars from 1 to 5', async () => {
    const s = defaultMeetingSettings();
    for (const m of Object.values(s.modes)) m.active = false;
    expect(await problemsOf(s)).toEqual(['Keep at least one meeting type in use']);
    const t = defaultMeetingSettings();
    t.modes.EC_VISIT.stars = 6;
    expect((await problemsOf(t)).join()).toMatch(/1 to 5/);
  });
});
