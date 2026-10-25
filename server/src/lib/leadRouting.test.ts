// Runs against the local test database (DATABASE_URL), never a shared one.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma.js';
import { leadRoutingConfig, defaultLeadRouting } from './leadRouting.js';
import { buildLeadRoleWhere } from './leadScope.js';
import { isAuthorizedForLead } from './leadAuth.js';
import { routeAdLead, routeQualifiedLead } from '../services/assignmentService.js';
import { ConfigError } from './versionedConfig.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');

async function save(patch: Record<string, unknown>) {
  const value = await leadRoutingConfig.spec.validate({ ...defaultLeadRouting(), ...patch });
  await prisma.assignmentConfig.create({ data: { key: 'lead_routing_v1', value: { value, revision: 1, updatedAt: new Date().toISOString(), updatedById: 'x' } as any } });
}

describe.skipIf(!safeDb)('lead routing & access', () => {
  beforeEach(async () => { await prisma.assignmentConfig.deleteMany({ where: { key: 'lead_routing_v1' } }); });
  afterAll(async () => {
    await prisma.assignmentConfig.deleteMany({ where: { key: 'lead_routing_v1' } });
    await prisma.$disconnect();
  });

  it('with nothing saved, access is exactly as before', async () => {
    expect(await buildLeadRoleWhere({ id: 'd1', role: 'DESIGNER' }, prisma)).toEqual({ assignedDesignerId: 'd1' });
    expect(await isAuthorizedForLead({ assignedDesignerId: 'someone', assignedBLId: 'bl' }, { id: 'd1', role: 'DESIGNER' })).toBe(false);
    expect(await buildLeadRoleWhere({ id: 'bh', role: 'BRANCH_HEAD' }, prisma)).toEqual({});
  });

  it('"all leads" opens every lead for that role only', async () => {
    await save({ visibility: { DESIGNER: 'all', CRE: 'own', BL: 'team' } });
    expect(await buildLeadRoleWhere({ id: 'd1', role: 'DESIGNER' }, prisma)).toEqual({});
    expect(await isAuthorizedForLead({ assignedDesignerId: 'someone', assignedBLId: 'bl' }, { id: 'd1', role: 'DESIGNER' })).toBe(true);
    expect(await buildLeadRoleWhere({ id: 'c1', role: 'CRE' }, prisma)).not.toEqual({});
  });

  it('"team" for a designer without a BL stays on their own leads', async () => {
    await save({ visibility: { DESIGNER: 'team', CRE: 'own', BL: 'team' } });
    expect(await buildLeadRoleWhere({ id: 'no-such-user', role: 'DESIGNER' }, prisma)).toEqual({ assignedDesignerId: 'no-such-user' });
  });

  it('manual routing assigns nobody', async () => {
    await save({ adLeads: 'MANUAL', qualifiedLeads: 'MANUAL' });
    expect(await routeAdLead()).toBeNull();
    expect(await routeQualifiedLead(null)).toEqual({ mode: 'MANUAL', blId: null, designerId: null });
  });

  it('rejects unknown choices', async () => {
    const fails = async (raw: unknown) => { try { await leadRoutingConfig.spec.validate(raw); return false; } catch (e) { return e instanceof ConfigError; } };
    expect(await fails({ ...defaultLeadRouting(), qualifiedLeads: 'DESIGNER' })).toBe(true);
    expect(await fails({ ...defaultLeadRouting(), visibility: { DESIGNER: 'own', CRE: 'team', BL: 'team' } })).toBe(true);
  });
});
