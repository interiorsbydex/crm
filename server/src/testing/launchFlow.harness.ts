/**
 * Guarded, TEST-ONLY actual-route harness. Never import from app entrypoints or
 * ordinary Vitest. Health is served before credentials/fixtures are created;
 * a separate authenticated control call initializes the rollback transaction.
 */
import { vi, test, expect } from 'vitest';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';

const H = vi.hoisted(() => {
  const state: any = {
    tx: null,
    wrapDelegate: null,
    userIds: new Set<string>(),
    authIds: new Set<string>(),
    emails: new Set<string>(),
    leadIds: new Set<string>(),
    leadCodes: new Set<string>(),
    meetingIds: new Set<string>(),
    projectIds: new Set<string>(),
    leadCodeMap: new Map<string, string>(),
    projectCodeMap: new Map<string, string>(),
    leadCounter: 0,
    projectCounter: 0,
    runTag: '',
    outbound: [] as any[],
    storagePaths: [] as { bucket: string; path: string }[],
    rollback: null as null | (() => void),
    status: 'starting',
    initialized: false,
    failure: null as string | null,
  };
  const proxy: any = new Proxy({}, {
    get(_target, key: string | symbol) {
      if (key === '__harnessState') return state;
      if (key === '$transaction') {
        return async (arg: any) => {
          if (!state.tx) throw new Error('Harness transaction is not active');
          if (Array.isArray(arg)) return Promise.all(arg);
          if (typeof arg !== 'function') throw new Error('Unsupported nested transaction');
          return arg(proxy);
        };
      }
      if (!state.tx) throw new Error('Route attempted Prisma access outside the harness transaction');
      const delegate = state.tx[key as any];
      return delegate && state.wrapDelegate ? state.wrapDelegate(String(key), delegate) : delegate;
    },
  });
  state.proxy = proxy;
  return { state, proxy };
});

vi.mock('../lib/prisma.js', () => ({ prisma: H.proxy }));

// Preserve email template helpers, but capture every send/draft call in memory.
vi.mock('../lib/email.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, sendEmail: async (payload: any) => {
    H.state.outbound.push({ kind: 'email', payload });
  } };
});
vi.mock('../lib/emailService.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    saveDraft: (...payload: any[]) => H.state.outbound.push({ kind: 'email-draft', payload }),
    sendDraft: async (...payload: any[]) => {
      H.state.outbound.push({ kind: 'email-send-attempt-captured', payload });
      return { success: true, capturedByHarness: true };
    },
    sendEmailByType: async (...payload: any[]) => H.state.outbound.push({ kind: 'email-template', payload }),
  };
});
vi.mock('../lib/resendEmail.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, sendViaResend: async (payload: any) => {
    H.state.outbound.push({ kind: 'resend-email', payload });
    return { id: 'captured-by-test-harness' };
  } };
});
vi.mock('../lib/notifications.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    createNotification: async (...payload: any[]) => {
      H.state.outbound.push({ kind: 'notification', payload });
      return null;
    },
    notifyManagers: async (...payload: any[]) => H.state.outbound.push({ kind: 'manager-notification', payload }),
  };
});
vi.mock('../services/smsService.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, sendSms: async (...payload: any[]) => H.state.outbound.push({ kind: 'sms', payload }) };
});
vi.mock('../lib/whatsapp.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, sendWhatsAppMessage: async (...payload: any[]) => {
    H.state.outbound.push({ kind: 'whatsapp', payload });
    return 'captured-by-test-harness';
  } };
});

class RollbackHarness extends Error {}

const OPT_IN_FILE = '/tmp/launch_flow_harness.enable';
const CREDENTIALS_FILE = '/tmp/launch_flow_harness_credentials.json';
const MANIFEST_FILE = '/tmp/launch_flow_harness_manifest.json';
const ENDPOINT_FILE = '/tmp/launch_flow_harness_endpoint.json';
const OPT_IN_VALUE = 'LAUNCH_FLOW_HARNESS_ENABLE_V1';

function mergeWhere(where: any, guard: any) {
  return { AND: [where ?? {}, guard] };
}
function isWrite(method: string) {
  return ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'].includes(method);
}

test('isolated actual-route launch flow harness (explicit file opt-in)', async () => {
  const marker = await fs.readFile(OPT_IN_FILE, 'utf8').catch(() => '');
  if (marker.trim() !== OPT_IN_VALUE) throw new Error(`Create ${OPT_IN_FILE} with the documented nonsecret opt-in value to start the test harness`);
  await fs.unlink(OPT_IN_FILE); // one-shot guard is consumed before any setup

  config({ path: resolve(process.cwd(), '../.env'), override: false });
  for (const key of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']) {
    if (!process.env[key]) throw new Error(`Required runtime setting is unavailable: ${key}`);
  }

  const { PrismaClient } = await import('@prisma/client');
  const express = (await import('express')).default;
  const root = new PrismaClient({ log: ['error'] });
  const state = H.state;
  const runTag = randomBytes(6).toString('hex').toUpperCase();
  state.runTag = runTag;
  const controlToken = randomBytes(32).toString('base64url');
  let server: any;
  let initializePromise: Promise<void> | null = null;
  let doneResolve!: () => void;
  let doneReject!: (error: Error) => void;
  const donePromise = new Promise<void>((resolveDone, rejectDone) => {
    doneResolve = resolveDone;
    doneReject = rejectDone;
  });
  let rollbackResolve!: () => void;
  const rollbackPromise = new Promise<void>((resolveRollback) => { rollbackResolve = resolveRollback; });
  state.rollback = rollbackResolve;
  const readyResolveState: { resolve?: () => void; reject?: (e: Error) => void } = {};
  const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
    readyResolveState.resolve = resolveReady;
    readyResolveState.reject = rejectReady;
  });
  const adminHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
    'Content-Type': 'application/json',
  };
  const authBase = `${process.env.SUPABASE_URL!.replace(/\/+$/, '')}/auth/v1/admin/users`;
  const evidence: any = {
    status: 'health-ready-no-fixtures',
    createdAt: new Date().toISOString(),
    users: [],
    targets: [],
    leads: [],
    storagePaths: [],
    outboundCapturedCounts: {},
  };
  const persistManifest = async () => fs.writeFile(MANIFEST_FILE, JSON.stringify(evidence, null, 2), { mode: 0o600 });

  let supabaseAdmin: any = null;
  let authCreated: any[] = [];
  const createdStoragePaths: { bucket: string; path: string }[] = [];
  const cleanedAuth = new Set<string>();
  const cleanedPaths = new Set<string>();
  let transactionRolledBack = false;

  try {
    // Import actual routers only. Deliberately do not import index.ts, which
    // starts workers and scheduled jobs.
    const [
      { authRouter }, { importRouter }, { leadsRouter }, { filesRouter },
      { meetingsRouter, meetingStatusRouter }, { dipChecklistRouter },
      { pdObChecklistRouter }, { obObmChecklistRouter }, { dashboardRouter },
      { designerReportsRouter }, { blAdminReportsRouter }, { adminRouter },
      { notificationsRouter }, { dashboardContentRouter }, { incentiveRouter },
      { healthRouter }, supabaseModule,
    ] = await Promise.all([
      import('../routes/auth.js'), import('../routes/import.js'), import('../routes/leads.js'),
      import('../routes/files.js'), import('../routes/meetings.js'), import('../routes/dipChecklist.js'),
      import('../routes/pdObChecklist.js'), import('../routes/obObmChecklist.js'),
      import('../routes/dashboard.js'), import('../routes/designerReports.js'),
      import('../routes/blAdminReports.js'), import('../routes/admin.js'),
      import('../routes/notifications.js'), import('../routes/dashboardContent.js'),
      import('../routes/incentive.js'), import('../routes/health.js'), import('../lib/supabase.js'),
    ]);
    supabaseAdmin = (supabaseModule as any).supabaseAdmin;
    if (!supabaseAdmin) throw new Error('Supabase storage client unavailable; refusing to start');

    // Read-only bucket preflight; never create/alter bucket configuration.
    const bucketResponse = await fetch(`${process.env.SUPABASE_URL!.replace(/\/+$/, '')}/storage/v1/bucket`, { headers: adminHeaders });
    const buckets: any[] = bucketResponse.ok ? await bucketResponse.json() as any : [];
    if (!bucketResponse.ok || !buckets.some((b) => b.name === 'crm-lead-files')) {
      throw new Error('Existing private lead-file bucket unavailable; refusing bucket creation');
    }
    const storage: any = supabaseAdmin.storage;
    storage.createBucket = async (name: string) => {
      if (name !== 'crm-lead-files') throw new Error('Harness blocked unexpected bucket creation');
      return { data: null, error: null };
    };
    const originalFrom = storage.from.bind(storage);
    storage.from = (bucket: string) => {
      const client: any = originalFrom(bucket);
      return new Proxy(client, {
        get(target: any, prop: string | symbol) {
          const fn = Reflect.get(target, prop, target);
          if (prop === 'upload' && typeof fn === 'function') {
            return async (path: string, ...args: any[]) => {
              const result = await fn.call(target, path, ...args);
              if (!result?.error) {
                const item = { bucket, path };
                state.storagePaths.push(item);
                createdStoragePaths.push(item);
                evidence.storagePaths = [...state.storagePaths];
                await persistManifest();
              }
              return result;
            };
          }
          return typeof fn === 'function' ? fn.bind(target) : fn;
        },
      });
    };

    state.wrapDelegate = (model: string, delegate: any) => new Proxy(delegate, {
      get(target, key: string | symbol) {
        const original = Reflect.get(target, key, target);
        if (typeof key !== 'string' || typeof original !== 'function') return original;
        return async (...rawArgs: any[]) => {
          const args = rawArgs[0] ?? {};
          const users = [...state.userIds];
          const leads = [...state.leadIds];
          const operation = key;

          if (model === 'leadCounter') {
            if (operation === 'findUnique') return { id: 1, lastNum: state.leadCounter };
            if (operation === 'upsert') {
              const update = args.update?.lastNum;
              if (typeof update === 'number') state.leadCounter = update;
              else if (update && typeof update.increment === 'number') state.leadCounter += update.increment;
              else if (typeof args.create?.lastNum === 'number') state.leadCounter = args.create.lastNum;
              else state.leadCounter += 1;
              return { id: 1, lastNum: state.leadCounter };
            }
            throw new Error(`Blocked shared leadCounter.${operation}`);
          }
          if (model === 'projectCounter') {
            if (operation === 'upsert') {
              const update = args.update?.lastNum;
              if (typeof update === 'number') state.projectCounter = update;
              else if (update && typeof update.increment === 'number') state.projectCounter += update.increment;
              else if (typeof args.create?.lastNum === 'number') state.projectCounter = args.create.lastNum;
              else state.projectCounter += 1;
              return { id: 1, lastNum: state.projectCounter };
            }
            throw new Error(`Blocked shared projectCounter.${operation}`);
          }

          if (model === 'user') {
            if (['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy'].includes(operation)) {
              rawArgs[0] = { ...args, where: mergeWhere(args.where, { id: { in: users } }) };
            } else if (['findUnique', 'findUniqueOrThrow'].includes(operation)) {
              const w = args.where ?? {};
              const ok = (w.id && state.userIds.has(w.id))
                || (w.supabaseId && state.authIds.has(w.supabaseId))
                || (w.email && state.emails.has(w.email));
              if (!ok) {
                if (operation.endsWith('OrThrow')) throw new Error('User outside disposable scope');
                return null;
              }
            } else if (operation === 'update') {
              if (!state.userIds.has(args.where?.id)) throw new Error('Blocked non-fixture user update');
            } else if (operation === 'updateMany') {
              rawArgs[0] = { ...args, where: mergeWhere(args.where, { id: { in: users } }) };
            } else {
              throw new Error(`Blocked user.${operation}`);
            }
            return original.apply(target, rawArgs);
          }

          if (model === 'lead') {
            if (['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy'].includes(operation)) {
              const w = args.where ?? {};
              // Preserve the import route's narrowly selected read-only duplicate
              // checks against live phone/email/PID values; all other lead reads
              // are restricted to this transaction's fixture IDs.
              const duplicateSelect = args.select?.phone === true
                && args.select?.email === true
                && args.select?.leadId === true
                && Array.isArray(w.OR);
              const pidSelect = args.select?.leadId === true
                && Object.keys(args.select ?? {}).every((key) => key === 'leadId')
                && Array.isArray(w.leadId?.in);
              const importDuplicateRead = operation === 'findMany' && (duplicateSelect || pidSelect) && !args.data;
              if (!importDuplicateRead) rawArgs[0] = { ...args, where: mergeWhere(w, { id: { in: leads } }) };
            } else if (['findUnique', 'findUniqueOrThrow'].includes(operation)) {
              const w = args.where ?? {};
              const ok = (w.id && state.leadIds.has(w.id)) || (w.leadId && state.leadCodes.has(w.leadId));
              if (!ok) {
                if (operation.endsWith('OrThrow')) throw new Error('Lead outside disposable scope');
                return null;
              }
            } else if (operation === 'create') {
              const data = { ...args.data };
              for (const field of ['createdById', 'assignedDesignerId', 'assignedBLId', 'assignedCREId']) {
                if (data[field] && !state.userIds.has(data[field])) throw new Error(`Blocked non-fixture ${field}`);
              }
              const sourceCode = String(data.leadId ?? '');
              const testCode = state.leadCodeMap.get(sourceCode)
                ?? `TEST-${state.runTag}-L${String(state.leadCodeMap.size + 1).padStart(3, '0')}`;
              state.leadCodeMap.set(sourceCode, testCode);
              data.leadId = testCode;
              rawArgs[0] = { ...args, data };
              const row = await original.apply(target, rawArgs);
              state.leadIds.add(row.id);
              state.leadCodes.add(testCode);
              return row;
            } else if (operation === 'update') {
              if (!state.leadIds.has(args.where?.id)) throw new Error('Blocked non-fixture lead update');
              for (const field of ['assignedDesignerId', 'assignedBLId', 'assignedCREId']) {
                if (args.data?.[field] && !state.userIds.has(args.data[field])) throw new Error(`Blocked non-fixture ${field}`);
              }
            } else if (operation === 'updateMany') {
              rawArgs[0] = { ...args, where: mergeWhere(args.where, { id: { in: leads } }) };
            } else {
              throw new Error(`Blocked lead.${operation}`);
            }
            return original.apply(target, rawArgs);
          }

          if (model === 'activityLog') {
            if (['findMany', 'findFirst', 'findUnique', 'count', 'aggregate'].includes(operation)) {
              rawArgs[0] = { ...args, where: mergeWhere(args.where, { OR: [{ leadId: { in: leads } }, { userId: { in: users } }] }) };
            } else if (operation === 'create') {
              const data = { ...args.data };
              if (!state.userIds.has(data.userId) || (data.leadId && !state.leadIds.has(data.leadId))) {
                throw new Error('Blocked activity log outside fixture scope');
              }
              if (data.meta?.projectCode && state.projectCodeMap.has(data.meta.projectCode)) {
                data.meta = { ...data.meta, projectCode: state.projectCodeMap.get(data.meta.projectCode) };
              }
              rawArgs[0] = { ...args, data };
            } else {
              throw new Error(`Blocked activityLog.${operation}`);
            }
            return original.apply(target, rawArgs);
          }

          if (model === 'meeting') {
            if (['findMany', 'findFirst', 'findUnique', 'count', 'aggregate', 'groupBy'].includes(operation)) {
              rawArgs[0] = { ...args, where: mergeWhere(args.where, { leadId: { in: leads } }) };
            } else if (operation === 'create') {
              if (!state.leadIds.has(args.data?.leadId)) throw new Error('Blocked meeting outside fixture scope');
              const row = await original.apply(target, rawArgs);
              state.meetingIds.add(row.id);
              return row;
            } else if (operation === 'update') {
              if (!state.meetingIds.has(args.where?.id)) throw new Error('Blocked non-fixture meeting update');
            } else {
              throw new Error(`Blocked meeting.${operation}`);
            }
            return original.apply(target, rawArgs);
          }

          if (model === 'call' || model === 'followUpTask' || model === 'whatsAppMessage') {
            if (['findMany', 'findFirst', 'findUnique', 'count', 'aggregate', 'groupBy'].includes(operation)) {
              rawArgs[0] = { ...args, where: mergeWhere(args.where, { leadId: { in: leads } }) };
            } else {
              throw new Error(`Blocked ${model}.${operation}`);
            }
            return original.apply(target, rawArgs);
          }

          if (['leadFile', 'dIPChecklist', 'pDOBChecklist', 'oBOBMChecklist', 'intentRatingLog', 'nPSResponse', 'sLABreach'].includes(model)) {
            if (['findMany', 'findFirst', 'findUnique', 'count', 'aggregate'].includes(operation)) {
              rawArgs[0] = { ...args, where: mergeWhere(args.where, { leadId: { in: leads } }) };
            } else if (isWrite(operation)) {
              const data = args.data ?? args.create ?? {};
              const leadRef = data.leadId ?? args.where?.leadId ?? args.where?.leadId_stage?.leadId;
              if (!state.leadIds.has(leadRef)) throw new Error(`Blocked ${model}.${operation} outside fixture lead scope`);
            } else {
              throw new Error(`Blocked ${model}.${operation}`);
            }
            return original.apply(target, rawArgs);
          }

          if (model === 'project') {
            if (['findMany', 'findFirst', 'findUnique', 'count', 'aggregate'].includes(operation)) {
              rawArgs[0] = { ...args, where: mergeWhere(args.where, { leadId: { in: leads } }) };
            } else if (operation === 'create') {
              const data = { ...args.data };
              if (!state.leadIds.has(data.leadId) || (data.designerId && !state.userIds.has(data.designerId))) {
                throw new Error('Blocked project outside fixture scope');
              }
              const oldCode = String(data.projectCode ?? '');
              const newCode = state.projectCodeMap.get(oldCode)
                ?? `TEST-${state.runTag}-P${String(state.projectCodeMap.size + 1).padStart(3, '0')}`;
              state.projectCodeMap.set(oldCode, newCode);
              data.projectCode = newCode;
              rawArgs[0] = { ...args, data };
              const row = await original.apply(target, rawArgs);
              state.projectIds.add(row.id);
              return row;
            } else {
              throw new Error(`Blocked project.${operation}`);
            }
            return original.apply(target, rawArgs);
          }

          if (model === 'designerTarget') {
            if (['findMany', 'findFirst', 'findUnique', 'count', 'aggregate'].includes(operation)) {
              rawArgs[0] = { ...args, where: mergeWhere(args.where, { designerId: { in: users } }) };
              return original.apply(target, rawArgs);
            }
            throw new Error(`Blocked designerTarget.${operation}`);
          }

          if (isWrite(operation)) throw new Error(`Blocked unexpected write ${model}.${operation}`);
          return original.apply(target, rawArgs);
        };
      },
    });

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    app.get('/api/__harness/health', (_req: any, res: any) => {
      res.json({
        marker: 'launch-flow-transaction-harness',
        transactionOpen: !!state.tx,
        credentialsCreated: state.initialized,
        workersStarted: false,
      });
    });
    app.get('/__harness/status', (req: any, res: any) => {
      if (req.header('x-launch-harness-control') !== controlToken) { res.sendStatus(404); return; }
      res.json({
        status: state.status,
        initialized: state.initialized,
        users: evidence.users,
        targets: evidence.targets,
        leads: evidence.leads,
        outboundCapturedCounts: state.outbound.reduce((o: any, e: any) => (o[e.kind] = (o[e.kind] ?? 0) + 1, o), {}),
        storagePaths: state.storagePaths,
      });
    });
    app.post('/__harness/initialize', async (req: any, res: any) => {
      if (req.header('x-launch-harness-control') !== controlToken) { res.sendStatus(404); return; }
      if (state.initialized) { res.status(409).json({ error: 'Already initialized' }); return; }
      if (!initializePromise) {
        initializePromise = initializeFixtureTransaction();
        initializePromise.catch((e) => {
          state.failure = 'Initialization failed; see harness process stderr (no secrets logged)';
          readyResolveState.reject?.(new Error(state.failure));
          doneReject(new Error(state.failure));
        });
      }
      try {
        await readyPromise;
        res.json({ status: 'ready', transactionOpen: true });
      } catch {
        res.status(500).json({ error: 'Harness initialization failed safely' });
      }
    });
    app.post('/__harness/rollback', (req: any, res: any) => {
      if (req.header('x-launch-harness-control') !== controlToken) { res.sendStatus(404); return; }
      if (!state.tx) { res.status(409).json({ error: 'No active fixture transaction' }); return; }
      res.json({ rollback: 'requested' });
      setImmediate(() => rollbackResolve());
    });
    app.post('/__harness/stop', (req: any, res: any) => {
      if (req.header('x-launch-harness-control') !== controlToken) { res.sendStatus(404); return; }
      if (state.initialized) { res.status(409).json({ error: 'Use rollback after initialization' }); return; }
      res.json({ stopped: true, fixturesCreated: false });
      setImmediate(async () => {
        evidence.status = 'stopped-before-initialize';
        await persistManifest();
        await closeServer();
        doneResolve();
      });
    });

    // Rewrite dry-run/import response IDs to the same synthetic TEST IDs stored
    // by the lead.create proxy; only the test harness generator is replaced.
    app.use((req: any, res: any, next: any) => {
      const originalJson = res.json.bind(res);
      res.json = (body: any) => {
        if (req.originalUrl.startsWith('/api/leads/import') && Array.isArray(body?.preview)) {
          body.preview = body.preview.map((row: any) => {
            if (!row.leadId || !/^X\d+$/i.test(row.leadId)) return row;
            if (!state.leadCodeMap.has(row.leadId)) {
              state.leadCodeMap.set(row.leadId, `TEST-${state.runTag}-L${String(state.leadCodeMap.size + 1).padStart(3, '0')}`);
            }
            return { ...row, leadId: state.leadCodeMap.get(row.leadId) };
          });
        }
        return originalJson(body);
      };
      next();
    });

    // Actual router handlers only; never import app index/jobs.
    app.use('/api/auth', authRouter);
    app.use('/api', healthRouter);
    app.use('/api/leads/import', importRouter);
    app.use('/api/leads/:leadId/files', filesRouter);
    app.use('/api/leads/:leadId/meetings', meetingsRouter);
    app.use('/api/meetings', meetingStatusRouter);
    app.use('/api/leads/:leadId/dip-checklist', dipChecklistRouter);
    app.use('/api/leads/:leadId/pd-ob-checklist', pdObChecklistRouter);
    app.use('/api/leads/:leadId/ob-obm-checklist', obObmChecklistRouter);
    app.use('/api/leads', leadsRouter);
    app.use('/api/dashboard', dashboardRouter);
    app.use('/api/dashboard-content', dashboardContentRouter);
    app.use('/api/designer-reports', designerReportsRouter);
    app.use('/api/bl-admin-reports', blAdminReportsRouter);
    app.use('/api/admin', adminRouter);
    app.use('/api/notifications', notificationsRouter);
    app.use('/api/incentive', incentiveRouter);
    app.use((_req: any, res: any) => res.status(404).json({ error: 'Not mounted in test-only harness' }));

    server = await new Promise<any>((resolveServer) => {
      const listener = app.listen(0, '127.0.0.1', () => resolveServer(listener));
    });
    const port = server.address().port;
    await fs.writeFile(ENDPOINT_FILE, JSON.stringify({ port, controlToken }, null, 2), { mode: 0o600 });
    evidence.port = port;
    evidence.status = 'health-ready-no-fixtures';
    await persistManifest();

    await donePromise;
    if (state.failure) throw new Error(state.failure);
    expect(transactionRolledBack || evidence.status === 'stopped-before-initialize').toBe(true);

    async function initializeFixtureTransaction() {
      const createAuth = async (role: string, name: string) => {
        const email = `launch.${runTag.toLowerCase()}.${role.toLowerCase()}@example.com`;
        const password = `${randomBytes(24).toString('base64url')}Aa1!`;
        const response = await fetch(authBase, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name, launch_test_only: true } }),
        });
        const row: any = response.ok ? await response.json() : null;
        if (!response.ok || !row?.id) throw new Error(`Disposable Auth creation failed (${response.status})`);
        const item = { role, name, email, password, authId: row.id };
        authCreated.push(item);
        state.authIds.add(row.id);
        state.emails.add(email);
        return item;
      };

      const auth = {
        bh: await createAuth('BH', 'Launch Test Branch Head'),
        bl: await createAuth('BL', 'Launch Test Business Lead'),
        creA: await createAuth('CREA', 'Launch Test CRE A'),
        creB: await createAuth('CREB', 'Launch Test CRE B'),
        designerA: await createAuth('DESA', 'Launch Test Designer A'),
        designerB: await createAuth('DESB', 'Launch Test Designer B'),
      };
      await fs.writeFile(CREDENTIALS_FILE, JSON.stringify(authCreated, null, 2), { mode: 0o600 });

      await root.$transaction(async (tx: any) => {
        state.tx = tx;
        const live = await tx.user.findMany({
          where: { isActive: true, role: { in: ['BL', 'CRE'] } },
          select: { id: true, role: true, totalLeadsAssigned: true },
        });
        const liveMax = live.reduce((m: number, u: any) => Math.max(m, u.totalLeadsAssigned), -1);
        if (liveMax >= 2_147_480_000) throw new Error('Live active BL/CRE counter guard failed; aborting before activation');

        const { getCycleForDate } = await import('../lib/targetCycle.js');
        const cycle = getCycleForDate(new Date());
        const profiles: any[] = [
          { auth: auth.bh, role: 'BRANCH_HEAD', blId: null },
          { auth: auth.bl, role: 'BL', blId: null },
          { auth: auth.creA, role: 'CRE', blId: null },
          { auth: auth.creB, role: 'CRE', blId: null },
          { auth: auth.designerA, role: 'DESIGNER', blId: null },
          { auth: auth.designerB, role: 'DESIGNER', blId: null },
        ].map((p) => ({ ...p, id: randomUUID() }));
        const bl = profiles[1];
        for (const p of profiles) {
          if (p.role === 'CRE' || p.role === 'DESIGNER') p.blId = bl.id;
          state.userIds.add(p.id);
        }
        for (const p of profiles) {
          await tx.user.create({
            data: {
              id: p.id, supabaseId: p.auth.authId, name: p.auth.name, email: p.auth.email,
              role: p.role, blId: p.blId, isActive: false, totalLeadsAssigned: 2_147_480_000,
            },
          });
        }
        const initial = await tx.user.findMany({
          where: { id: { in: profiles.map((p) => p.id) } },
          select: { id: true, role: true, blId: true, isActive: true, totalLeadsAssigned: true, createdAt: true },
        });
        if (initial.length !== 6 || initial.some((u: any) => u.isActive || u.totalLeadsAssigned !== 2_147_480_000)) {
          throw new Error('Disposable profile initial counter/readback guard failed');
        }
        for (const p of profiles) await tx.user.update({ where: { id: p.id }, data: { isActive: true } });

        const targets: any[] = [];
        for (const p of profiles.filter((u) => u.role === 'DESIGNER')) {
          const target = await tx.designerTarget.create({
            data: {
              designerId: p.id, cycleStart: cycle.cycleStart, cycleEnd: cycle.cycleEnd,
              bookingTargetValue: 10_000_000, poTargetValue: 0, setById: bl.id,
            },
          });
          targets.push({ id: target.id, designerId: p.id, bookingTargetValue: '10000000' });
        }
        evidence.cycle = { start: cycle.cycleStart.toISOString(), end: cycle.cycleEnd.toISOString() };
        evidence.liveEligibleBeforeActivation = { count: live.length, maxCounter: liveMax };
        evidence.users = initial.map((u: any) => ({
          id: u.id, role: u.role, blId: u.blId, createdAt: u.createdAt.toISOString(),
          initialCounter: u.totalLeadsAssigned,
          authId: profiles.find((p) => p.id === u.id)?.auth.authId,
        }));
        evidence.targets = targets;
        evidence.status = 'transaction-ready';
        state.initialized = true;
        state.status = 'transaction-ready';
        await persistManifest();
        readyResolveState.resolve?.();

        await rollbackPromise;
        evidence.status = 'rolling-back';
        evidence.leads = await tx.lead.findMany({
          where: { id: { in: [...state.leadIds] } },
          select: {
            id: true, leadId: true, stage: true, status: true, isTestLead: true, estimatedValue: true,
            assignedCREId: true, assignedBLId: true, assignedDesignerId: true, createdAt: true, leadOriginDate: true,
          },
        });
        evidence.outboundCapturedCounts = state.outbound.reduce((o: any, e: any) => (o[e.kind] = (o[e.kind] ?? 0) + 1, o), {});
        evidence.storagePaths = [...state.storagePaths];
        await persistManifest();
        await closeServer();
        throw new RollbackHarness();
      }, { timeout: 1_100_000, maxWait: 15_000 }).catch((err: any) => {
        if (err instanceof RollbackHarness) { transactionRolledBack = true; return; }
        throw err;
      });

      state.tx = null;
      evidence.status = transactionRolledBack ? 'rolled-back' : 'transaction-failed';
      await persistManifest();
      if (transactionRolledBack) {
        const ids = evidence.users.map((u: any) => u.id);
        const [remainingUsers, remainingLeads] = await Promise.all([
          root.user.findMany({ where: { id: { in: ids } }, select: { id: true } }),
          root.lead.findMany({
            where: { leadId: { startsWith: `TEST-${runTag}-` } },
            select: { id: true, leadId: true },
          }),
        ]);
        evidence.cleanup = {
          ...(evidence.cleanup ?? {}),
          dbVisibility: { userRowsAfterRollback: remainingUsers.length, testLeadRowsAfterRollback: remainingLeads.length },
        };
        if (remainingUsers.length || remainingLeads.length) {
          throw new Error('Independent post-rollback DB visibility check found test fixtures');
        }
      }
      await cleanStorageAndAuth();
      state.status = transactionRolledBack ? 'cleaned' : 'failed-cleanup-attempted';
      evidence.status = state.status;
      await persistManifest();
      await fs.unlink(CREDENTIALS_FILE).catch(() => undefined);
      await fs.unlink(ENDPOINT_FILE).catch(() => undefined);
      doneResolve();
    }

    async function cleanStorageAndAuth() {
      const byBucket = new Map<string, string[]>();
      for (const item of createdStoragePaths) {
        const paths = byBucket.get(item.bucket) ?? [];
        paths.push(item.path);
        byBucket.set(item.bucket, paths);
      }
      evidence.cleanup ??= {};
      evidence.cleanup.storage = [];
      for (const [bucket, paths] of byBucket) {
        const result = await supabaseAdmin.storage.from(bucket).remove(paths);
        evidence.cleanup.storage.push({ bucket, count: paths.length, error: result?.error?.message ?? null });
        if (!result?.error) for (const path of paths) cleanedPaths.add(`${bucket}/${path}`);
      }
      evidence.cleanup.auth = [];
      for (const account of authCreated) {
        const del = await fetch(`${authBase}/${account.authId}`, { method: 'DELETE', headers: adminHeaders });
        const verify = await fetch(`${authBase}/${account.authId}`, { headers: adminHeaders });
        await verify.arrayBuffer();
        evidence.cleanup.auth.push({ id: account.authId, deleteStatus: del.status, verifyStatus: verify.status });
        if (del.status === 200 || verify.status === 404) cleanedAuth.add(account.authId);
      }
      await persistManifest();
    }

    async function closeServer() {
      if (!server) return;
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((err: any) => err ? rejectClose(err) : resolveClose());
      });
      server = null;
    }
  } catch (error: any) {
    state.failure = 'Harness setup or cleanup failed; no credentials or message bodies are logged';
    state.status = 'failed';
    evidence.status = 'failed';
    await persistManifest().catch(() => undefined);
    doneReject(error instanceof Error ? error : new Error('Harness failed'));
    throw error;
  } finally {
    if (server) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    if (state.tx) state.tx = null; // root connection close rolls back on runner failure
    await root.$disconnect();
    // Best-effort exact-ID cleanup if setup failed before its normal cleanup.
    for (const item of createdStoragePaths) {
      if (cleanedPaths.has(`${item.bucket}/${item.path}`)) continue;
      await supabaseAdmin?.storage.from(item.bucket).remove([item.path]).catch(() => undefined);
    }
    for (const account of authCreated) {
      if (cleanedAuth.has(account.authId)) continue;
      await fetch(`${authBase}/${account.authId}`, { method: 'DELETE', headers: adminHeaders }).catch(() => undefined);
    }
    await Promise.all([OPT_IN_FILE, CREDENTIALS_FILE, ENDPOINT_FILE].map((f) => fs.unlink(f).catch(() => undefined)));
  }
});
