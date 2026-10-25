-- Task 116: NotificationLog.eventAt — the task due date/time or meeting
-- scheduled date/time a notification is about, distinct from createdAt
-- (when the notification itself was generated).
ALTER TABLE "notification_logs" ADD COLUMN IF NOT EXISTS "eventAt" TIMESTAMP(3);
