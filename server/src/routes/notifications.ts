import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';

export const notificationsRouter = Router();

// ── GET /api/notifications/my ─────────────────────────────────────────────────
// Cursor-paginated: pass `?cursor=<id of the oldest notification already
// loaded>` to fetch the next page of older notifications. Without a cursor,
// returns the most recent page. `hasMore` tells the client whether another
// "load older" page is available.
const NOTIFICATIONS_PAGE_SIZE = 50;

notificationsRouter.get('/my', verifyToken, async (req, res) => {
  const user = req.user!;
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

  const [notificationsPage, unreadCount] = await Promise.all([
    prisma.notificationLog.findMany({
      where: { userId: user.id },
      include: { lead: { select: { id: true, leadId: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: NOTIFICATIONS_PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
    // Unread count always reflects the full inbox, not just the loaded page.
    prisma.notificationLog.count({
      where: { userId: user.id, isRead: false },
    }),
  ]);

  const hasMore = notificationsPage.length > NOTIFICATIONS_PAGE_SIZE;
  const notifications = hasMore ? notificationsPage.slice(0, NOTIFICATIONS_PAGE_SIZE) : notificationsPage;

  res.json({ unreadCount, notifications, hasMore });
});

// ── PATCH /api/notifications/:id/read ────────────────────────────────────────
notificationsRouter.patch('/:id/read', verifyToken, async (req, res) => {
  const { id } = req.params;
  const user = req.user!;

  const notification = await prisma.notificationLog.findFirst({
    where: { id, userId: user.id },
  });
  if (!notification) {
    res.status(404).json({ error: 'Notification not found' });
    return;
  }

  const updated = await prisma.notificationLog.update({
    where: { id },
    data: { isRead: true },
  });

  res.json({ notification: updated });
});

// ── PATCH /api/notifications/read-all ────────────────────────────────────────
notificationsRouter.patch('/read-all', verifyToken, async (req, res) => {
  const user = req.user!;

  await prisma.notificationLog.updateMany({
    where: { userId: user.id, isRead: false },
    data: { isRead: true },
  });

  res.json({ message: 'All notifications marked as read' });
});
