import { randomUUID } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import {
  contentKey, DASHBOARD_CONTENT_PREFIX, DashboardContentError,
  dashboardContentDraft, dashboardContentUpdate, parseStoredContent,
} from '../lib/dashboardContent.js';

export const dashboardContentRouter = Router();
export const adminDashboardContentRouter = Router();

dashboardContentRouter.use(verifyToken);
// Keep exactly the existing Admin role boundary. No lead/project permissions change.
adminDashboardContentRouter.use(verifyToken, requireRole('BRANCH_HEAD'));

function handleError(res: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: error.issues.map((i) => `${i.path.join('.') || 'Content'}: ${i.message}`).join('; ') });
  } else if (error instanceof DashboardContentError) {
    res.status(error.status).json({ error: error.message });
  } else {
    res.status(500).json({ error: 'Dashboard content could not be loaded or saved. Please retry.' });
  }
}

async function list(res: Response) {
  try {
    const rows = await prisma.assignmentConfig.findMany({
      where: { key: { startsWith: DASHBOARD_CONTENT_PREFIX } },
      orderBy: [{ updatedAt: 'desc' }, { key: 'asc' }],
    });
    // Strip internal editor IDs; never return unrelated assignment/configuration data.
    res.json({ items: rows.map((row) => parseStoredContent(row.value)) });
  } catch (error) { handleError(res, error); }
}

dashboardContentRouter.get('/', (_req, res) => list(res));
adminDashboardContentRouter.get('/', (_req, res) => list(res));

adminDashboardContentRouter.post('/', async (req, res) => {
  try {
    const draft = dashboardContentDraft.parse(req.body);
    const now = new Date().toISOString();
    const item = { ...draft, id: randomUUID(), revision: 1, createdAt: now, updatedAt: now };
    await prisma.$transaction(async (tx) => {
      await tx.assignmentConfig.create({
        data: { key: contentKey(item.id), value: { ...item, createdById: req.user!.id, updatedById: req.user!.id } },
      });
      await tx.activityLog.create({
        data: { userId: req.user!.id, action: 'DASHBOARD_CONTENT_CREATED', meta: { contentId: item.id, kind: item.kind, revision: 1 } },
      });
    });
    res.status(201).json({ item });
  } catch (error) { handleError(res, error); }
});

adminDashboardContentRouter.put('/:id', async (req, res) => {
  try {
    const key = contentKey(req.params.id);
    const { revision, ...draft } = dashboardContentUpdate.parse(req.body);
    const item = await prisma.$transaction(async (tx) => {
      const row = await tx.assignmentConfig.findUnique({ where: { key } });
      if (!row) throw new DashboardContentError(404, 'This content has been removed. Refresh the list.');
      const previous = parseStoredContent(row.value);
      const next = { ...previous, ...draft, revision: revision + 1, updatedAt: new Date().toISOString() };
      const result = await tx.assignmentConfig.updateMany({
        where: { key, value: { path: ['revision'], equals: revision } },
        data: { value: {
          ...next,
          createdById: (row.value as Record<string, unknown>).createdById as string ?? req.user!.id,
          updatedById: req.user!.id,
        } },
      });
      if (!result.count) throw new DashboardContentError(409, 'Edit conflict: this content changed elsewhere. Refresh the list and reopen it before saving.');
      await tx.activityLog.create({
        data: { userId: req.user!.id, action: 'DASHBOARD_CONTENT_UPDATED', meta: { contentId: next.id, kind: next.kind, revision: next.revision } },
      });
      return next;
    });
    res.json({ item });
  } catch (error) { handleError(res, error); }
});

adminDashboardContentRouter.delete('/:id', async (req, res) => {
  try {
    const key = contentKey(req.params.id);
    const revision = z.coerce.number().int().min(1).parse(req.query.revision);
    await prisma.$transaction(async (tx) => {
      const row = await tx.assignmentConfig.findUnique({ where: { key } });
      if (!row) throw new DashboardContentError(404, 'This content has already been removed. Refresh the list.');
      const previous = parseStoredContent(row.value);
      const result = await tx.assignmentConfig.deleteMany({ where: { key, value: { path: ['revision'], equals: revision } } });
      if (!result.count) throw new DashboardContentError(409, 'Delete conflict: this content changed elsewhere. Refresh the list before deleting.');
      await tx.activityLog.create({
        data: { userId: req.user!.id, action: 'DASHBOARD_CONTENT_DELETED', meta: { contentId: previous.id, kind: previous.kind, revision } },
      });
    });
    res.json({ deleted: true });
  } catch (error) { handleError(res, error); }
});
