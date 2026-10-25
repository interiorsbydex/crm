import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ queries: [] as any[], projectStatus: 'ACTIVE' }));
const complete = () => ({
  email: 'synthetic@example.invalid', source: 'Walk-in', projectType: 'Apartment', scope: 'Full',
  location: 'Synthetic', possessionTimeline: 'Ready', builder: 'Synthetic', intentRating: 4,
});
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    projectTeamMember: { findMany: async () => [{ projectId: 'approved' }] },
    lead: { findMany: async (query: any) => {
      state.queries.push({ kind: 'lead', query });
      return [
        { id: 'a', leadId: 'TEST-A', name: 'Synthetic complete', stage: 'MQL', status: 'ACTIVE', ...complete(), slaBreaches: [], attentionFlags: [] },
        { id: 'b', leadId: 'TEST-B', name: 'Synthetic incomplete', stage: 'MQL', status: 'ACTIVE', slaBreaches: [], attentionFlags: [] },
      ];
    } },
    project: { findMany: async (query: any) => {
      state.queries.push({ kind: 'project', query });
      return [{
        id: 'p', projectCode: 'TEST-P', health: 'ON_TRACK', phase: 'WORKING_DRAWINGS', attentionFlags: [],
        lead: { id: 'c', leadId: 'TEST-C', name: 'Synthetic project', stage: 'DESIGN_IN_PROGRESS', status: state.projectStatus, isTestLead: false },
      }];
    } },
    leadFile: { findMany: async () => [] },
    call: { findMany: async () => [
      { leadId: 'a', outcome: 'ANSWERED', calledAt: new Date(Date.now() - 3 * 86_400_000) },
      { leadId: 'b', outcome: 'ANSWERED', calledAt: new Date() },
    ] },
    meeting: { findMany: async () => [] },
    activityLog: { findMany: async () => [] },
  },
}));
vi.mock('../middleware/auth.js', () => ({
  verifyToken: (req: any, res: any, next: any) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'Missing token' });
    req.user = { id: 'designer', role: req.headers.authorization === 'Bearer designer' ? 'DESIGNER' : 'BL' };
    next();
  },
}));
import { clientHealthRouter } from './clientHealth.js';

let server: Server;
let origin: string;
beforeAll(async () => {
  const app = express();
  app.use('/', clientHealthRouter);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { state.queries.length = 0; state.projectStatus = 'ACTIVE'; });
async function get(role: string | null = 'designer') {
  const response = await fetch(origin, { headers: role ? { Authorization: `Bearer ${role}` } : {} });
  return { status: response.status, body: await response.json() as any };
}

describe('Client health separates information completeness from verified contact', () => {
  it('preserves existing completeness counts while returning independent contact counts', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.counts).toEqual({ total: 3, healthy: 1, atRisk: 0, critical: 2 });
    expect(body.contactCounts).toEqual({ total: 3, recent: 1, warning: 1, highRisk: 0, unknown: 1 });
    expect(body.items[0]).toMatchObject({ health: 'HEALTHY', informationStatus: 'COMPLETE', contactHealth: { status: 'WARNING' } });
    expect(body.items[1]).toMatchObject({ health: 'CRITICAL', informationStatus: 'DATA_INCOMPLETE', contactHealth: { status: 'RECENT' } });
  });
  it('preserves Designer and approved-project scopes, ACTIVE non-test lead filters and uncapped population', async () => {
    await get();
    const lead = state.queries.find((q) => q.kind === 'lead').query;
    expect(lead.where).toMatchObject({ assignedDesignerId: 'designer', status: 'ACTIVE', isTestLead: false });
    expect(lead).not.toHaveProperty('take');
    expect(state.queries.find((q) => q.kind === 'project').query.where.OR).toEqual([
      { designerId: 'designer' }, { id: { in: ['approved'] } },
    ]);
  });
  it('does not activate or reinterpret On Hold reactivation rules', async () => {
    state.projectStatus = 'ON_HOLD';
    const { body } = await get();
    expect(body.items.find((item: any) => item.leadDbId === 'c').contactHealth).toMatchObject({
      status: 'UNKNOWN', daysSinceContact: null,
    });
  });
  it('keeps unauthenticated and other-role access denied without reading client data', async () => {
    expect((await get(null)).status).toBe(401);
    expect((await get('bl')).status).toBe(403);
    expect(state.queries).toHaveLength(0);
  });
});
