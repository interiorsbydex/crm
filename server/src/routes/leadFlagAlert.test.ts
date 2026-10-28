/** Flagging a lead alerts its designer, its BL and every Branch Head — never the person who raised it. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const state = vi.hoisted(() => ({ alerts: [] as { userId: string; type: string; message: string }[] }));
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    lead: { findUnique: async () => ({ id: 'L1', leadId: 'X0101', name: 'Fixture Client', assignedDesignerId: 'designer', assignedBLId: 'bl', status: 'ACTIVE' }) },
    leadAttentionFlag: { create: async ({ data }: any) => ({ id: 'F1', ...data }) },
    user: { findMany: async () => [{ id: 'bh1' }, { id: 'bh2' }] },
  },
}));
vi.mock('../lib/supabase.js', () => ({ supabaseAdmin: {} }));
vi.mock('../lib/activityLog.js', () => ({ logActivity: async () => {} }));
vi.mock('../lib/leadAuth.js', () => ({ isAuthorizedForLead: async () => true }));
vi.mock('../lib/notifications.js', () => ({
  createNotification: async (userId: string, type: string, message: string) => { state.alerts.push({ userId, type, message }); },
}));
vi.mock('../middleware/auth.js', () => ({
  verifyToken: (req: any, _res: any, next: any) => { req.user = { id: req.headers['x-user'], role: 'DESIGNER' }; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
import { leadsRouter } from './leads.js';

let server: Server;
let origin: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/leads', leadsRouter);
  server = await new Promise<Server>((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  const a = server.address(); if (!a || typeof a === 'string') throw new Error('No port');
  origin = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { state.alerts = []; });

const flag = (by: string) => fetch(`${origin}/leads/L1/attention-flag`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': by },
  body: JSON.stringify({ category: 'CLIENT_ISSUE', description: 'Client unhappy with layout' }),
});

describe('POST /leads/:id/attention-flag alerts', () => {
  it('alerts the BL and Branch Heads when the designer flags', async () => {
    expect((await flag('designer')).status).toBe(201);
    expect(state.alerts.map((a) => a.userId).sort()).toEqual(['bh1', 'bh2', 'bl']);
    expect(state.alerts.every((a) => a.type === 'LEAD_FLAGGED')).toBe(true);
    expect(state.alerts[0].message).toBe('Lead X0101 — Fixture Client was flagged (CLIENT_ISSUE): Client unhappy with layout');
  });

  it('alerts the designer when a Branch Head flags', async () => {
    await flag('bh1');
    expect(state.alerts.map((a) => a.userId).sort()).toEqual(['bh2', 'bl', 'designer']);
  });
});
