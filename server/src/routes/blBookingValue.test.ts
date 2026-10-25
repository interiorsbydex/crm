import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const state = vi.hoisted(() => ({
  total: 1_000_000,
  aggregateQueries: [] as any[],
  heldQueries: [] as any[],
}));
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findMany: async ({ where }: any) => where.id === 'bl' || where.role === 'BL'
        ? [{ id: 'bl', name: 'Fixture BL' }]
        : [{ id: 'designer', name: 'Fixture Designer' }],
    },
    lead: {
      // A scope-isolated synthetic dataset. Booking totals are deliberately
      // separate from checklist furniture and pre-discount quote amounts.
      findMany: async (query: any) => {
        if (query.where.assignedBLId === 'bl' && query.where.assignedDesignerId === null) {
          state.heldQueries.push(query);
          return [{
            id: 'held', leadId: 'TEST-HELD', name: 'Owned BL-held fixture',
            status: 'ACTIVE', stage: 'MQL', leadOriginDate: new Date('2026-10-20T12:00Z'),
            dipChecklist: null, activityLogs: [],
          }];
        }
        return [];
      },
      count: async () => 1,
      aggregate: async (query: any) => {
        state.aggregateQueries.push(query);
        return { _sum: { estimatedValue: state.total }, _count: { id: 1 } };
      },
    },
    designerTarget: { findMany: async () => [{ designerId: 'designer', bookingTargetValue: 2_000_000 }] },
    nPSResponse: { findMany: async () => [] },
  },
}));
vi.mock('../middleware/auth.js', () => ({
  verifyToken: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!['Bearer fixture', 'Bearer fixture-admin'].includes(auth)) return res.status(401).json({ error: 'Missing token' });
    req.user = auth === 'Bearer fixture-admin' ? { id: 'bh', role: 'BRANCH_HEAD' } : { id: 'bl', role: 'BL' };
    next();
  },
}));
vi.mock('../lib/bookingCancellations.js', () => ({
  loadBookingCancellations: async () => ({ excludedLeadIds: [], pendingReview: [] }),
}));
vi.mock('../lib/completedPitches.js', () => ({
  loadCompletedPitches: async () => ({
    all: { missingCompletionDates: 0 },
    inPeriod: () => ({ pitches: [] }),
  }),
}));
import { blAdminReportsRouter } from './blAdminReports.js';
import { myPerformance } from './designerReports.js';

let server: Server;
let origin: string;
beforeAll(async () => {
  const app = express();
  app.use('/', blAdminReportsRouter);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture test port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  state.total = 1_000_000;
  state.aggregateQueries.length = 0;
  state.heldQueries.length = 0;
});

async function report(type = 'bl-performance', token = 'fixture') {
  const response = await fetch(`${origin}/${type}?from=2026-10-20&to=2026-10-21`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return await response.json() as any;
}

describe('Annie answer 4 — BL booking value', () => {
  it('adds only the actor BL own unassigned non-test inventory, without adding it to Designer targets', async () => {
    const data = await myPerformance({ id: 'bl', role: 'BL' }, { from: '2026-10-20', to: '2026-10-21' }, { source: 'Synthetic' });
    expect(data.blHeld?.statusCounts.total).toBe(1);
    expect(state.heldQueries[0].where).toEqual({
      assignedBLId: 'bl', assignedDesignerId: null, isTestLead: false, AND: [{ source: 'Synthetic' }],
    });
    expect(data.blocks[0].result.bookingValue).toBe(1_000_000);
    expect(data.blocks[0].target.monthlyTarget).toBe(2_000_000);
  });
  it('does not include BL-held leads in a Designer session or a selected Designer view', async () => {
    const dates = { from: '2026-10-20', to: '2026-10-21' };
    const designer = await myPerformance({ id: 'designer', role: 'DESIGNER' }, dates);
    const narrowed = await myPerformance({ id: 'bl', role: 'BL' }, { ...dates, designerId: 'designer' });
    expect(designer).not.toHaveProperty('blHeld');
    expect(narrowed).not.toHaveProperty('blHeld');
    expect(state.heldQueries).toHaveLength(0);
  });
  it('uses the recorded 10 lakh total directly and returns 50% against a 20 lakh target', async () => {
    const body = await report();
    expect(body.data.tables[0].rows.map((r: any) => r.cells.achieved)).toEqual([1_000_000, 1_000_000]);
    expect(body.data.tables[0].rows.map((r: any) => r.cells.pct)).toEqual([50, 50]);
    expect(body.data.notes.join(' ')).toContain('Furniture is a separate reporting breakdown');
    expect(state.aggregateQueries[0]).toMatchObject({
      _sum: { estimatedValue: true },
      where: { isTestLead: false, dipChecklist: { completedAt: { not: null } } },
    });
  });

  it('does not fetch checklist furniture or discount percentages to alter the recorded total', async () => {
    // No checklist/discount model is provided by this fixture: attempting a
    // second subtraction, addition or discount query must fail this route.
    await report();
    expect(state.aggregateQueries).toHaveLength(1);
    expect(state.aggregateQueries[0]._sum).toEqual({ estimatedValue: true });
  });

  it('keeps the all-BL performance presentation on the same basis', async () => {
    const body = await report('bl-performance-all', 'fixture-admin');
    expect(body.data.notes.join(' ')).toContain('does not apply another discount or recalculate GST');
    expect(JSON.stringify(body.data.tables)).toContain('1000000');
  });

  it('does not change the Designer performance calculation or amount precision', async () => {
    state.total = 1_000_000.25;
    const result = await myPerformance({ id: 'designer', role: 'DESIGNER' }, {
      from: '2026-10-20', to: '2026-10-21',
    });
    expect(result.blocks[0].result.bookingValue).toBe(1_000_000.25);
    const body = await report();
    expect(body.data.tables[0].rows[0].cells.achieved).toBe(1_000_000.25);
  });

  it('does not turn a recorded zero into furniture value or an invented amount', async () => {
    state.total = 0;
    const body = await report();
    expect(body.data.tables[0].rows[0].cells.achieved).toBe(0);
  });
});
