import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const state = vi.hoisted(() => ({ rows: new Map<string, any>(), logs: [] as any[] }));
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findMany: async ({ where }: any) => (where.id ? [{ id: where.id, name: 'Own BL' }] : [{ id: 'bl1', name: 'BL One' }, { id: 'bl2', name: 'BL Two' }]),
      findUnique: async ({ where }: any) => (where.id.startsWith('bl') ? { role: 'BL' } : { role: 'DESIGNER' }),
    },
    incentiveConfig: {
      findUnique: async ({ where }: any) => state.rows.get(where.id) ?? null,
      findMany: async () => [...state.rows.entries()].filter(([id]) => id.startsWith('bl-target:')).map(([id, row]) => ({ id, ...row })),
      upsert: async ({ where, create }: any) => { state.rows.set(where.id, { config: create.config, updatedAt: new Date() }); },
    },
  },
}));
vi.mock('../middleware/auth.js', () => ({
  verifyToken: (req: any, _res: any, next: any) => {
    const [role, id] = String(req.headers['x-fixture']).split(':');
    req.user = { id, role };
    next();
  },
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) =>
    (roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'forbidden' })),
}));
vi.mock('../lib/activityLog.js', () => ({ logActivity: async (...args: any[]) => { state.logs.push(args); } }));
vi.mock('../lib/blCredits.js', async (original) => ({
  ...(await original<typeof import('../lib/blCredits.js')>()),
  calculateBlCredits: async (blId: string) => ({ bl: { id: blId, name: blId } }),
}));
vi.mock('../routes/designerReports.js', () => ({ loadFirstStageEntries: async () => new Map(), mqlReceived: () => ({}) }));

import { incentiveRouter } from './incentive.js';

let server: Server;
let origin: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/', incentiveRouter);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const call = (who: string, path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, {
  ...init, headers: { 'x-fixture': who, 'content-type': 'application/json', ...(init.headers ?? {}) },
});

describe('BL credits access', () => {
  it('a BL sees only their own credits', async () => {
    const own: any = await (await call('BL:bl1', '/bl-credits')).json();
    expect(own.result.bl.id).toBe('bl1');
    expect((await call('BL:bl1', '/bl-credits?blId=bl2')).status).toBe(403);
  });

  it('a Branch Head can open any BL', async () => {
    const res: any = await (await call('BRANCH_HEAD:bh', '/bl-credits?blId=bl2')).json();
    expect(res.result.bl.id).toBe('bl2');
    expect(res.bls).toHaveLength(2);
  });

  it('designers cannot see BL credits', async () => {
    expect((await call('DESIGNER:d1', '/bl-credits')).status).toBe(403);
  });
});

describe('BL settings, targets and approval are Branch Head only', () => {
  it('saves BL rules; a BL cannot', async () => {
    const body = JSON.stringify({ config: { sameDayPitchCredits: 4 } });
    expect((await call('BL:bl1', '/bl-config', { method: 'PUT', body })).status).toBe(403);
    expect((await call('BRANCH_HEAD:bh', '/bl-config', { method: 'PUT', body })).status).toBe(200);
    const read: any = await (await call('BL:bl1', '/bl-config')).json();
    expect(read.config.sameDayPitchCredits).toBe(4);
  });

  it('sets a BL target for the current cycle and lists it; past cycles are locked', async () => {
    expect((await call('BL:bl1', '/bl-targets', { method: 'POST', body: JSON.stringify({ blId: 'bl1', bookingTargetValue: 12000000 }) })).status).toBe(403);
    expect((await call('BRANCH_HEAD:bh', '/bl-targets', { method: 'POST', body: JSON.stringify({ blId: 'bl1', bookingTargetValue: 12000000 }) })).status).toBe(200);
    const list: any = await (await call('BRANCH_HEAD:bh', '/bl-targets')).json();
    expect(list.bls.find((b: any) => b.blId === 'bl1').bookingTargetValue).toBe(12000000);
    const past = await call('BRANCH_HEAD:bh', '/bl-targets', { method: 'POST', body: JSON.stringify({ blId: 'bl1', bookingTargetValue: 1, cycle: '2020-01-20' }) });
    expect(past.status).toBe(403);
    expect((await call('BRANCH_HEAD:bh', '/bl-targets', { method: 'POST', body: JSON.stringify({ blId: 'd1', bookingTargetValue: 1 }) })).status).toBe(404);
  });

  it('approves the pitch booster; a BL cannot approve their own', async () => {
    const body = JSON.stringify({ blId: 'bl1', approved: true });
    expect((await call('BL:bl1', '/bl-pitch-approval', { method: 'PUT', body })).status).toBe(403);
    const ok = await call('BRANCH_HEAD:bh', '/bl-pitch-approval', { method: 'PUT', body });
    expect(((await ok.json()) as any).approval).toMatchObject({ approved: true, byId: 'bh' });
  });
});
