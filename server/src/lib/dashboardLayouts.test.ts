import { describe, expect, it } from 'vitest';
import { dashboardLayoutsConfig, defaultDashboardLayouts } from './dashboardLayouts.js';
import { ConfigError } from './versionedConfig.js';

async function problemsOf(raw: unknown): Promise<string[]> {
  try { await dashboardLayoutsConfig.spec.validate(raw); return []; } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}

describe('dashboard layouts', () => {
  it('with nothing saved every dashboard shows all tiles as shipped', () => {
    for (const layout of Object.values(defaultDashboardLayouts())) expect(layout).toEqual({ order: [], hidden: [], labels: {} });
  });
  it('accepts a layout and fills in dashboards not mentioned', async () => {
    const v = await dashboardLayoutsConfig.spec.validate({ bh: { order: ['bh.npsScore'], hidden: ['bh.obProgress'], labels: { 'bh.salesPipeline': 'Total Pipeline' } } });
    expect(v.bh.labels['bh.salesPipeline']).toBe('Total Pipeline');
    expect(v.designer).toEqual({ order: [], hidden: [], labels: {} });
  });
  it('explains problems in plain words', async () => {
    const p = (await problemsOf({ bh: { order: [], hidden: [], labels: { 'bh.salesPipeline': ' ' } }, xyz: {} })).join('\n');
    expect(p).toMatch(/a tile name cannot be empty/);
    expect(p).toMatch(/xyz/);
  });
});
