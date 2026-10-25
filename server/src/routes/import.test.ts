import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';

const state = vi.hoisted(() => ({
  leads: [] as any[], logs: [] as any[], staff: [] as any[],
  selections: 0, failCounter: false, failAudit: false, counter: 1000,
}));
vi.mock('../lib/prisma.js', () => {
  const db = {
    lead: {
      findMany: async ({ where }: any) => where.leadId
        ? state.leads.filter((l) => where.leadId.in.includes(l.leadId))
        : state.leads.filter((l) => where.OR.some((w: any) =>
          w.phone ? l.phone.endsWith(w.phone.endsWith) : w.email.in.includes(l.email))),
      create: async ({ data }: any) => {
        const lead = { id: `lead-${state.leads.length}`, ...data };
        state.leads.push(lead); return lead;
      },
    },
    user: {
      findMany: async () => state.staff,
      update: async ({ where }: any) => {
        if (state.failCounter) throw new Error('Synthetic counter failure');
        const u = state.staff.find((u) => u.id === where.id); u.totalLeadsAssigned++; return u;
      },
    },
    activityLog: { create: async ({ data }: any) => {
      if (state.failAudit && data.action === 'LEAD_IMPORTED') throw new Error('Synthetic audit failure');
      state.logs.push(data); return data;
    } },
    // Admin settings (e.g. Permissions): nothing saved, so defaults apply.
    assignmentConfig: { findUnique: async () => null },
    leadCounter: {
      findUnique: async () => ({ lastNum: state.counter }),
      upsert: async ({ update }: any) => { state.counter = update.lastNum; },
    },
  };
  return { prisma: { ...db, $transaction: async (fn: any) => {
    const snapshot = structuredClone({ leads: state.leads, logs: state.logs, staff: state.staff });
    try { return await fn(db); } catch (e) { Object.assign(state, snapshot); throw e; }
  } } };
});
vi.mock('../services/assignmentService.js', () => ({
  // Ad/import leads go to the next CRE in turn (Admin → Lead Routing & Access default).
  routeAdLead: async () => {
    state.selections++;
    return [...state.staff].filter((s) => s.role === 'CRE' && s.isActive)
      .sort((a, b) => a.totalLeadsAssigned - b.totalLeadsAssigned)[0] ?? null;
  },
}));
vi.mock('../middleware/auth.js', () => ({
  verifyToken: (req: any, res: any, next: any) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'Missing token' });
    req.user = { id: 'importer', role: req.headers.authorization.replace('Bearer ', '') }; next();
  },
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' }),
}));
import { importRouter } from './import.js';

let server: Server;
let origin: string;
beforeAll(async () => {
  const app = express(); app.use('/import', importRouter);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const a = server.address(); if (!a || typeof a === 'string') throw new Error('No port');
  origin = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  Object.assign(state, { leads: [], logs: [], selections: 0, failCounter: false, failAudit: false, counter: 1000 });
  state.staff = [
    { id: 'd', name: 'Fixture Designer', role: 'DESIGNER', isActive: true, totalLeadsAssigned: 4 },
    { id: 'b', name: 'Fixture BL', role: 'BL', isActive: true, totalLeadsAssigned: 4 },
    { id: 'c', name: 'Fixture CRE', role: 'CRE', isActive: true, totalLeadsAssigned: 0 },
    { id: 'c2', name: 'Second CRE', role: 'CRE', isActive: true, totalLeadsAssigned: 0 },
  ];
});
const headers = 'PID,Lead Name,Contact number,Lead Stage,Designer Name,BL Name,CRE Name,Owner Name';
async function upload(rows: string[], options: { dry?: boolean; status?: string; role?: string; xlsx?: boolean } = {}) {
  const form = new FormData();
  if (options.xlsx) {
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Leads');
    for (const row of [headers, ...rows]) sheet.addRow(row.split(','));
    const bytes = await workbook.xlsx.writeBuffer();
    form.append('file', new Blob([new Uint8Array(bytes)]), 'fixture.xlsx');
  } else form.append('file', new Blob([[headers, ...rows].join('\n')]), 'fixture.csv');
  form.append('status', options.status ?? 'ACTIVE');
  const response = await fetch(`${origin}/import${options.dry ? '?dryRun=true' : ''}`, {
    method: 'POST', headers: { Authorization: `Bearer ${options.role ?? 'BL'}` }, body: form,
  });
  return { status: response.status, body: await response.json() as any };
}
describe('bulk import ownership safety', () => {
  it('previews preserved and unresolved owners without writes or allocation queries', async () => {
    const { body } = await upload([
      'X1100,Owned,9990000101,Effective Lead,Fixture Designer,Fixture BL,Fixture CRE,',
      'X1101,Unknown,9990000102,Effective Lead,Missing,,,',
      'X1102,Ownerless,9990000103,Effective Lead,,,,',
    ], { dry: true });
    expect(body.preview.map((r: any) => r.assignmentOutcome)).toEqual(['PRESERVED', 'MANUAL_REVIEW', 'ALLOCATION_PENDING']);
    expect(state.leads).toHaveLength(0); expect(state.logs).toHaveLength(0);
    expect(state.selections).toBe(0); expect(state.counter).toBe(1000);
  });
  it('preserves named Designer, BL and CRE without increasing allocation counters', async () => {
    const { body } = await upload(['X1100,Owned,9990000101,DQL,Fixture Designer,Fixture BL,Fixture CRE,']);
    expect(body.imported).toBe(1);
    expect(state.leads[0]).toMatchObject({ assignedDesignerId: 'd', assignedBLId: 'b', assignedCREId: 'c' });
    expect(state.staff.map((s) => s.totalLeadsAssigned)).toEqual([4, 4, 0, 0]);
    expect(state.selections).toBe(0);
    expect(state.logs[0]).toMatchObject({ action: 'LEAD_IMPORTED', leadId: state.leads[0].id,
      meta: { assignmentOutcome: 'PRESERVED', historicalAssignmentDateVerified: false } });
  });
  it('keeps unknown designer ownership unassigned instead of silently allocating a CRE', async () => {
    const { body } = await upload(['X1100,Unknown,9990000101,Effective Lead,Missing,,,']);
    expect(body.assignmentCounts.manualReview).toBe(1);
    expect(state.leads[0].assignedDesignerId).toBeUndefined();
    expect(state.leads[0].assignedCREId).toBeUndefined();
    expect(state.selections).toBe(0);
    expect(body.preview[0].reason).toContain('manual review');
  });
  it('retains known ownership while flagging an unknown BL, never defaulting to the importer', async () => {
    await upload(['X1100,Partial,9990000101,Effective Lead,Fixture Designer,Missing,,']);
    expect(state.leads[0]).toMatchObject({ assignedDesignerId: 'd', assignedBLId: undefined });
    expect(state.selections).toBe(0);
    expect(state.logs[0].meta.assignmentOutcome).toBe('MANUAL_REVIEW');
  });
  it('preserves a CRE in either explicit or legacy columns', async () => {
    await upload([
      'X1100,Legacy,9990000101,Effective Lead,Fixture CRE,,,',
      'X1101,Explicit,9990000102,Effective Lead,,,Fixture CRE,',
    ]);
    expect(state.leads.map((l) => [l.assignedDesignerId, l.assignedCREId])).toEqual([['c', 'c'], ['c', 'c']]);
    expect(state.selections).toBe(0);
  });
  it('allocates ownerless Active Effective Leads once each, updating counters between rows', async () => {
    const { body } = await upload([
      'X1100,First,9990000101,Effective Lead,,,,',
      'X1101,Second,9990000102,Effective Lead,,,,',
    ]);
    expect(body.assignmentCounts.allocated).toBe(2);
    expect(state.leads.map((l) => l.assignedCREId)).toEqual(['c', 'c2']);
    expect(state.staff.slice(2).map((s) => s.totalLeadsAssigned)).toEqual([1, 1]);
  });
  it.each(['ON_HOLD', 'INACTIVE'])('does not allocate %s ownerless historical imports', async (status) => {
    const { body } = await upload(['X1100,Historical,9990000101,Effective Lead,,,,'], { status });
    expect(body.imported).toBe(1); expect(body.assignmentCounts.manualReview).toBe(1);
    expect(state.selections).toBe(0); expect(state.leads[0].assignedCREId).toBeUndefined();
  });
  it('leaves later-stage ownerless leads for review without inventing an allocation rule', async () => {
    const { body } = await upload(['X1100,Qualified,9990000101,MQL,,,,']);
    expect(body.preview[0].assignmentOutcome).toBe('MANUAL_REVIEW');
    expect(state.selections).toBe(0);
  });
  it('imports for review if no CRE is available', async () => {
    state.staff = state.staff.filter((s) => s.role !== 'CRE');
    const { body } = await upload(['X1100,Ownerless,9990000101,Effective Lead,,,,']);
    expect(body.assignmentCounts.manualReview).toBe(1);
    expect(body.preview[0].reason).toContain('no active CRE');
    expect(state.leads[0].assignedCREId).toBeUndefined();
  });
  it('leaves existing leads and their owners untouched on repeated or duplicate imports', async () => {
    const row = 'X1100,Owned,9990000101,DQL,Fixture Designer,Fixture BL,,';
    await upload([row]); const original = structuredClone(state.leads[0]);
    const { body } = await upload([row, row]);
    expect(body.imported).toBe(0); expect(body.skipped).toBe(2);
    expect(state.leads).toEqual([original]); expect(state.logs.filter((l) => l.action === 'LEAD_IMPORTED')).toHaveLength(1);
  });
  it.each(['failCounter', 'failAudit'] as const)('rolls back creation, counters and ownership audit on %s', async (failure) => {
    state[failure] = true;
    const { body } = await upload(['X1100,Ownerless,9990000101,Effective Lead,,,,']);
    expect(body.imported).toBe(0); expect(body.skipped).toBe(1);
    expect(body.preview[0].status).toBe('INVALID');
    expect(state.leads).toHaveLength(0); expect(state.logs).toHaveLength(0);
    expect(state.staff.slice(2).map((s) => s.totalLeadsAssigned)).toEqual([0, 0]);
  });
  it('rejects incomplete rows before any allocation', async () => {
    const { body } = await upload(['X1100,,9990000101,Effective Lead,,,,', 'X1101,Missing phone,,Effective Lead,,,,']);
    expect(body.imported).toBe(0); expect(body.skipped).toBe(2); expect(state.selections).toBe(0);
  });
  it('applies identical ownership protection to actual Excel uploads', async () => {
    const { body } = await upload(['X1100,Excel,9990000101,DQL,Fixture Designer,Fixture BL,Fixture CRE,'], { xlsx: true });
    expect(body.imported).toBe(1);
    expect(state.leads[0]).toMatchObject({ assignedDesignerId: 'd', assignedBLId: 'b', assignedCREId: 'c' });
  });
  it('keeps role restrictions and exposes optional ownership columns in the template', async () => {
    expect((await upload(['X1100,No access,9990000101,MQL,,,,'], { role: 'CRE' })).status).toBe(403);
    const response = await fetch(`${origin}/import/template`, { headers: { Authorization: 'Bearer BL' } });
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv).toContain('"Designer Name","BL Name","CRE Name"');
  });
});
