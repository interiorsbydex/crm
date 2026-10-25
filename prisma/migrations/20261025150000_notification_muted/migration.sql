-- In-app alerts switched off in Admin → In-app Alerts are kept but hidden. Existing rows stay visible.
ALTER TABLE "notification_logs" ADD COLUMN IF NOT EXISTS "muted" BOOLEAN NOT NULL DEFAULT false;
