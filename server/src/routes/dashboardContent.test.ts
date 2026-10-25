import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { DASHBOARD_CONTENT_PREFIX, dashboardContentDraft } from '../lib/dashboardContent.js';

const state = vi.hoisted(() => ({ rows: new Map<string, any>(), audits: [] as any[] }));
vi.mock('../lib/prisma.js', () => {
  const assignmentConfig = {
    findMany: async ({ where }: any) => [...state.rows.values()]
      .filter((r) => r.key.startsWith(where.key.startsWith)),
    findUnique: async ({ where }: any) => state.rows.get(where.key) ?? null,
    create: async ({ data }: any) => {
      const row = { ...data, id: data.key, updatedAt: new Date() };
      state.rows.set(data.key, row);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const row = state.rows.get(where.key);
      if (!row || row.value.revision !== where.value.equals) return { count: 0 };
      state.rows.set(where.key, { ...row, ...data, updatedAt: new Date() });
      return { count: 1 };
    },
    deleteMany: async ({ where }: any) => {
      const row = state.rows.get(where.key);
      if (!row || row.value.revision !== where.value.equals) return { count: 0 };
      state.rows.delete(where.key);
      return { count: 1 };
    },
  };
  const client = { assignmentConfig, activityLog: { create: async ({ data }: any) => { state.audits.push(data); return data; } } };
  return { prisma: { ...client, $transaction: async (fn: any) => fn(client) } };
});
vi.mock('../middleware/auth.js', () => ({
  verifyToken: (req: any, res: any, next: any) => {
    const token = req.headers.authorization;
    if (!token) { res.status(401).json({ error: 'Missing token' }); return; }
    const role = token === 'Bearer admin' ? 'BRANCH_HEAD' : token === 'Bearer bl' ? 'BL' : 'DESIGNER';
    req.user = { id: 'fixture-actor', role };
    next();
  },
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' }),
}));

import { adminDashboardContentRouter, dashboardContentRouter } from './dashboardContent.js';

let server: Server;
let origin: string;
const draft = { kind: 'ANNOUNCEMENT', title: 'Team update', body: 'Plain text <script>alert(1)</script>', imageUrl: null, linkUrl: null };
async function request(method: string, path: string, actor: string | null = 'admin', body?: unknown) {
  const response = await fetch(origin + path, {
    method, headers: { ...(actor ? { Authorization: `Bearer ${actor}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as any };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/content', dashboardContentRouter);
  app.use('/admin', adminDashboardContentRouter);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { state.rows.clear(); state.audits.length = 0; });

describe('dashboard content API', () => {
  it('requires sign-in and preserves the existing Admin permission boundary', async () => {
    expect((await request('GET', '/content', null)).status).toBe(401);
    expect((await request('GET', '/admin', 'bl')).status).toBe(403);
    for (const actor of ['bl', 'designer']) {
      expect((await request('POST', '/admin', actor, draft)).status).toBe(403);
      expect((await request('GET', '/content', actor)).data.items).toEqual([]);
    }
  });
  it('persists create/edit/clear/delete, audits actions and does not expose unrelated config/editor IDs', async () => {
    state.rows.set('existing_setting', { key: 'existing_setting', value: { private: true } });
    const created = await request('POST', '/admin', 'admin', { ...draft, imageUrl: 'https://example.org/photo.jpg' });
    expect(created.status).toBe(201);
    const id = created.data.item.id;
    let listed = await request('GET', '/content', 'bl');
    expect(listed.data.items).toHaveLength(1);
    expect(listed.data.items[0].createdById).toBeUndefined();
    const edited = await request('PUT', `/admin/${id}`, 'admin', { ...draft, title: 'Updated', imageUrl: '', revision: 1 });
    expect(edited.status).toBe(200);
    expect(edited.data.item).toMatchObject({ revision: 2, imageUrl: null, title: 'Updated', createdAt: created.data.item.createdAt });
    listed = await request('GET', '/content', 'designer');
    expect(listed.data.items[0].title).toBe('Updated');
    expect((await request('DELETE', `/admin/${id}?revision=2`)).status).toBe(200);
    expect((await request('GET', '/content')).data.items).toEqual([]);
    expect(state.rows.has('existing_setting')).toBe(true);
    expect(state.audits.map((a) => a.action)).toEqual(['DASHBOARD_CONTENT_CREATED', 'DASHBOARD_CONTENT_UPDATED', 'DASHBOARD_CONTENT_DELETED']);
  });
  it('rejects stale edits/deletions without changing another editor’s content', async () => {
    const { data } = await request('POST', '/admin', 'admin', draft);
    const path = `/admin/${data.item.id}`;
    await request('PUT', path, 'admin', { ...draft, title: 'New version', revision: 1 });
    expect((await request('PUT', path, 'admin', { ...draft, title: 'Stale version', revision: 1 })).status).toBe(409);
    expect((await request('DELETE', `${path}?revision=1`)).status).toBe(409);
    expect((await request('GET', '/content')).data.items[0].title).toBe('New version');
    expect(state.audits).toHaveLength(2);
  });
  it('rejects blank/oversized text, invalid kinds, protected fields and unsafe URLs', async () => {
    for (const invalid of [
      { ...draft, title: '  ' }, { ...draft, body: '' }, { ...draft, title: 'x'.repeat(161) },
      { ...draft, body: 'x'.repeat(5001) }, { ...draft, kind: 'CUSTOM' },
      { ...draft, createdById: 'someone-else' },
      ...['javascript:alert(1)', 'http://example.org', 'https://user:password@example.org', 'not a URL'].map((imageUrl) => ({ ...draft, imageUrl })),
    ]) expect((await request('POST', '/admin', 'admin', invalid)).status).toBe(400);
    expect(state.rows.size).toBe(0);
  });
  it('supports both kinds and returns 404 for a removed item', async () => {
    const created = await request('POST', '/admin', 'admin', { ...draft, kind: 'INSPIRATION', linkUrl: 'https://example.org/design' });
    expect(created.data.item.kind).toBe('INSPIRATION');
    await request('DELETE', `/admin/${created.data.item.id}?revision=1`);
    expect((await request('PUT', `/admin/${created.data.item.id}`, 'admin', { ...draft, revision: 1 })).status).toBe(404);
  });
  it('fails explicitly for corrupt stored content instead of hiding it', async () => {
    state.rows.set(DASHBOARD_CONTENT_PREFIX + 'bad', { key: DASHBOARD_CONTENT_PREFIX + 'bad', value: {} });
    expect((await request('GET', '/content')).status).toBe(500);
  });
  it('normalises optional cleared URLs and trims text', () => {
    expect(dashboardContentDraft.parse({ ...draft, title: ' title ', body: ' body ', imageUrl: ' ' }))
      .toMatchObject({ title: 'title', body: 'body', imageUrl: null, linkUrl: null });
  });
});
