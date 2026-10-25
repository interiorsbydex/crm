import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const state = vi.hoisted(() => ({ meetingQueries: [] as any[], logQueries: [] as any[] }));
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findMany: async ({ where }: any) => where.id === 'designer' || where.blId === 'bl'
      ? [{ id: 'designer', name: 'Owned fixture designer' }] : [] },
    lead: { findMany: async () => [] },
    meeting: { findMany: async (query: any) => {
      state.meetingQueries.push(query);
      return [
        { id: 'original', leadId: 'lead', type: 'DQL', status: 'RESCHEDULED', scheduledAt: new Date('2026-10-14T10:00Z'),
          rescheduledReason: 'Synthetic replan', lead: { id: 'lead', leadId: 'TEST-A', name: 'Synthetic' } },
        { id: 'replacement', leadId: 'lead', type: 'DQL', status: 'COMPLETED', scheduledAt: new Date('2026-10-17T10:00Z'),
          rescheduledReason: null, lead: { id: 'lead', leadId: 'TEST-A', name: 'Synthetic' } },
      ];
    } },
    activityLog: { findMany: async (query: any) => {
      state.logQueries.push(query);
      return [
        { leadId: 'lead', createdAt: new Date('2026-10-18T10:00Z'), meta: { meetingId: 'replacement' } },
        { leadId: 'lead', createdAt: new Date('2026-10-18T10:01Z'), meta: { meetingId: 'replacement' } },
      ];
    } },
  },
}));
vi.mock('../middleware/auth.js', () => ({
  verifyToken: (req: any, res: any, next: any) => {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    req.user = token === 'Bearer bl' ? { id: 'bl', role: 'BL' } : { id: 'designer', role: 'DESIGNER' };
    next();
  },
}));
import { designerReportsRouter } from './designerReports.js';

let server: Server;
let origin: string;
beforeAll(async () => {
  const app = express();
  app.use('/', designerReportsRouter);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { state.meetingQueries.length = 0; state.logQueries.length = 0; });
async function report(role: string | null, extra = '') {
  const response = await fetch(`${origin}/my-commitment?from=2026-09-16&to=2026-11-15${extra}`, {
    headers: role ? { Authorization: `Bearer ${role}` } : {},
  });
  return { status: response.status, body: await response.json() as any };
}

describe('My Commitment report read-only integration', () => {
  it('returns original commitment and completion in their separate cycles, using the existing response envelope', async () => {
    const { status, body } = await report('designer');
    expect(status).toBe(200);
    expect(body.type).toBe('my-commitment');
    expect(body.data.blocks[0].rows[0]).toMatchObject({ planned: 1, actual: 0, achievementPct: 0 });
    expect(body.data.blocks[1].rows[0]).toMatchObject({ planned: 1, actual: 1, achievementPct: 100 });
    expect(body.data.blocks[1].rows[2]).toMatchObject({ key: 'EXPECTED_BOOKING', planned: 0, actual: 0 });
    expect(state.meetingQueries).toHaveLength(1);
    expect(state.meetingQueries[0].where).toMatchObject({
      lead: { assignedDesignerId: { in: ['designer'] }, isTestLead: false },
      type: { in: ['DQL', 'PP'] },
      OR: [{ scheduledAt: expect.any(Object) }, { status: 'COMPLETED' }],
    });
    expect(state.logQueries[0].where).toEqual({ leadId: { in: ['lead'] }, action: 'MEETING_COMPLETED' });
  });
  it('keeps BL-selected and Designer self-scoped rows identical without widening access', async () => {
    const designer = await report('designer', '&designerId=foreign');
    const bl = await report('bl', '&designerId=designer');
    expect(bl.status).toBe(200);
    expect(bl.body.data.blocks).toEqual(designer.body.data.blocks);
    expect(designer.body.data.scope.selectedDesignerIds).toEqual(['designer']);
    expect((await report('bl', '&designerId=foreign')).status).toBe(403);
    expect(state.meetingQueries).toHaveLength(2);
  });
  it('retains authentication and rejects invalid dates before any meeting reads', async () => {
    expect((await report(null)).status).toBe(401);
    const response = await fetch(`${origin}/my-commitment?from=not-a-date`, { headers: { Authorization: 'Bearer designer' } });
    expect(response.status).toBe(400);
    expect(state.meetingQueries).toHaveLength(0);
  });
});
