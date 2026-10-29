/** Reports → Inactive leads shows the stage the lead stopped at and the reason the team gave. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    lead: {
      findMany: async () => [
        { leadId: 'X0201', name: 'Team reason', stage: 'PROPOSAL_PRESENTED', source: 'WALK_IN', inactiveReason: 'Budget too low',
          inactivationFeedback: null, assignedDesigner: { name: 'Fixture Designer' }, updatedAt: new Date('2026-10-28T10:00Z') },
        { leadId: 'X0202', name: 'Older record', stage: 'MQL', source: 'WALK_IN', inactiveReason: null,
          inactivationFeedback: { reason: 'Moved city', feedbackFormSentAt: null, clientResponse: null, respondedAt: null },
          assignedDesigner: null, updatedAt: new Date('2026-10-27T10:00Z') },
      ],
    },
  },
}));
vi.mock('../lib/leadScope.js', () => ({ buildLeadRoleWhere: async () => ({}) }));
vi.mock('../middleware/auth.js', () => ({
  verifyToken: (req: any, _res: any, next: any) => { req.user = { id: 'bh', role: 'BRANCH_HEAD' }; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
import { reportsRouter } from './reports.js';

let server: Server;
let origin: string;
beforeAll(async () => {
  const app = express(); app.use('/reports', reportsRouter);
  server = await new Promise<Server>((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  const a = server.address(); if (!a || typeof a === 'string') throw new Error('No port');
  origin = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

describe('GET /reports/inactive_leads', () => {
  it('returns the stage and the team reason, falling back to the feedback record', async () => {
    const body: any = await (await fetch(`${origin}/reports/inactive_leads`)).json();
    expect(body.data.rows.map((r: any) => [r.leadId, r.stage, r.reason])).toEqual([
      ['X0201', 'PROPOSAL_PRESENTED', 'Budget too low'],
      ['X0202', 'MQL', 'Moved city'],
    ]);
  });
});
