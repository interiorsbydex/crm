import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const state = vi.hoisted(() => ({ review: true, calculatedFor: [] as string[] }));
vi.mock('../lib/prisma.js', () => ({ prisma: {
  user: { findMany: async ({ where }: any) =>
    where.id ? [{ id: where.id, name: 'Own designer' }] : [{ id: 'd1', name: 'Own designer' }],
  },
} }));
vi.mock('../middleware/auth.js', () => ({
  verifyToken: (req: any, _res: any, next: any) => {
    req.user = req.headers.authorization === 'Bearer bl'
      ? { id: 'bl', role: 'BL' } : { id: 'd1', role: 'DESIGNER' };
    next();
  },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../lib/incentiveCredits.js', () => ({
  calculateDesignerCredits: async (designerId: string, cycle: any) => {
    state.calculatedFor.push(designerId);
    if (state.review) throw new CancellationReviewRequired([
      { id: 'owned-lead', leadId: 'SYNTHETIC', name: 'Own booking', reason: 'Original award requires review' },
    ], cycle);
    return { designer: { id: designerId }, totalCredits: 5 };
  },
  getCycleForDate: () => ({
    cycleStart: new Date('2026-10-15T18:30:00Z'), cycleEnd: new Date('2026-11-15T18:29:59.999Z'),
    label: '16 Oct – 15 Nov 2026',
  }),
  loadIncentiveConfig: async () => ({ config: {}, isDefault: true }),
  parseIncentiveConfig: () => ({}), DEFAULT_INCENTIVE_CONFIG: {},
}));

import { CancellationReviewRequired } from '../lib/bookingCancellations.js';
import { incentiveRouter } from './incentive.js';
let server: Server;
let origin: string;
beforeAll(async () => {
  const app = express();
  app.use('/incentive', incentiveRouter);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { state.review = true; state.calculatedFor = []; });

async function credits(query = '', actor = 'designer') {
  const response = await fetch(`${origin}/incentive/credits${query}`, { headers: { Authorization: `Bearer ${actor}` } });
  return { status: response.status, data: await response.json() as any };
}

describe('historical cancellation review response', () => {
  it('returns explicit review, not a zero, partial total or generic server error', async () => {
    const result = await credits();
    expect(result.status).toBe(200);
    expect(result.data.result).toBeNull();
    expect(result.data.review.status).toBe('PENDING_REVIEW');
    expect(result.data.review.reason).toContain('Unavailable pending review');
    expect(result.data.review.leads.map((lead: any) => lead.id)).toEqual(['owned-lead']);
    expect(result.data.review).not.toHaveProperty('totalCredits');
  });
  it('keeps designers self-scoped even with a forged designer filter', async () => {
    const result = await credits('?designerId=outside');
    expect(result.data.review.designerId).toBe('d1');
    expect(state.calculatedFor).toEqual(['d1']);
  });
  it('allows the BL to inspect the owned designer review', async () => {
    expect((await credits('?designerId=d1', 'bl')).data.review.designerId).toBe('d1');
  });
  it('blocks foreign designers before loading cancellation evidence', async () => {
    expect((await credits('?designerId=outside', 'bl')).status).toBe(403);
    expect(state.calculatedFor).toEqual([]);
  });
  it('does not hide ordinary calculated totals for unaffected designers', async () => {
    state.review = false;
    const result = await credits();
    expect(result.data.result.totalCredits).toBe(5);
    expect(result.data.review).toBeUndefined();
  });
});
