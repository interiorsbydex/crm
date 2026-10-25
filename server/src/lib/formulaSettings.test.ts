import { describe, expect, it } from 'vitest';
import { blend, defaultFormulas, formulaSettingsConfig, medalFor } from './formulaSettings.js';
import { contactHealth } from './contactHealth.js';
import { ConfigError } from './versionedConfig.js';

async function problemsOf(raw: unknown): Promise<string[]> {
  try { await formulaSettingsConfig.spec.validate(raw); return []; } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}

describe('formulas', () => {
  it('defaults reproduce the original medals and averages', () => {
    const f = defaultFormulas();
    expect([100, 95, 90, 85, 80, 79].map((s) => medalFor(s, f))).toEqual(['GOLD', 'SILVER', 'SILVER', 'BRONZE', 'BRONZE', null]);
    expect(medalFor(null, f)).toBeNull();
    expect(blend(80, 100, f.salesPctBookingWeight)).toBe(90); // (80 + 100) / 2
  });

  it('custom levels and weights apply', () => {
    const f = { ...defaultFormulas(), medals: { gold: 120, silver: 100, bronze: 70 } };
    expect(medalFor(110, f)).toBe('SILVER');
    expect(medalFor(70, f)).toBe('BRONZE');
    expect(blend(80, 100, 75)).toBe(85);
  });

  it('contact health follows the configured days', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    const fiveDaysAgo = new Date('2026-10-20T12:00:00Z');
    expect(contactHealth([fiveDaysAgo], false, now).status).toBe('WARNING');
    expect(contactHealth([fiveDaysAgo], false, now, { warningDays: 6, highRiskDays: 10 }).status).toBe('RECENT');
    expect(contactHealth([fiveDaysAgo], false, now, { warningDays: 2, highRiskDays: 4 }).status).toBe('HIGH_RISK');
  });

  it('rejects settings that contradict themselves', async () => {
    const d = defaultFormulas();
    expect((await problemsOf({ ...d, medals: { gold: 80, silver: 90, bronze: 70 } }))[0]).toMatch(/Gold/);
    expect((await problemsOf({ ...d, intentTiers: { highFrom: 3, mediumFrom: 4 } }))[0]).toMatch(/medium/);
    expect((await problemsOf({ ...d, contactHealth: { warningDays: 7, highRiskDays: 3 } }))[0]).toMatch(/red/);
    expect((await problemsOf({ ...d, performanceWeights: { conversion: 0, targetAchievement: 0, averageBookingValue: 0 } }))[0]).toMatch(/at least one/);
    expect(await problemsOf(d)).toEqual([]);
  });
});
