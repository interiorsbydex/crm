// Runs against the local test database (DATABASE_URL), never a shared one.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import { PERMISSIONS, defaultPermissions, hasPermission, permissionsConfig } from './permissions.js';
import { ConfigError } from './versionedConfig.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');

async function problemsOf(raw: unknown): Promise<string[]> {
  try { await permissionsConfig.spec.validate(raw); return []; } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}

describe.skipIf(!safeDb)('permissions', () => {
  beforeEach(async () => { await prisma.assignmentConfig.deleteMany({ where: { key: 'permissions_v1' } }); });
  afterAll(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: 'permissions_v1' } });
    await prisma.$disconnect();
  });

  it('with nothing saved, every role keeps exactly what it had', async () => {
    for (const p of PERMISSIONS) {
      for (const role of ['DESIGNER', 'CRE', 'BL', 'BRANCH_HEAD']) {
        expect(await hasPermission(role, p.key), `${role} ${p.key}`).toBe((p.defaultRoles ?? p.roles).includes(role as any) || (role === 'BRANCH_HEAD' && p.roles.includes('BRANCH_HEAD') && !p.branchHeadOptional));
      }
    }
  });

  it('a role can be switched off, and back on', async () => {
    const v = defaultPermissions();
    v.LEAD_PUSHBACK_MQL = ['BRANCH_HEAD'];
    expect(await hasPermission('BL', 'LEAD_PUSHBACK_MQL')).toBe(true);
    const merged = await permissionsConfig.spec.validate(v);
    await prisma.assignmentConfig.create({ data: { key: 'permissions_v1', value: { value: merged, revision: 1, updatedAt: new Date().toISOString(), updatedById: 'x' } as any } });
    expect(await hasPermission('BL', 'LEAD_PUSHBACK_MQL')).toBe(false);
    expect(await hasPermission('BRANCH_HEAD', 'LEAD_PUSHBACK_MQL')).toBe(true);
  });

  it('the Branch Head can never lose its own permissions, and never gains ones it never had', async () => {
    const v = await permissionsConfig.spec.validate({ OFFERS_MANAGE: [] });
    expect(v.OFFERS_MANAGE).toEqual(['BRANCH_HEAD']);
    expect(await hasPermission('BRANCH_HEAD', 'LEAD_ASSIGN_DIRECT')).toBe(false);
  });

  it('refuses roles an action wasn\'t built for', async () => {
    const p = (await problemsOf({ LEAD_ASSIGN_DIRECT: ['BL', 'DESIGNER'], NOPE: [] })).join('\n');
    expect(p).toMatch(/Assign a lead directly to a designer: this action wasn't built for the DESIGNER role/);
    expect(p).toMatch(/Unknown permission "NOPE"/);
  });
});
