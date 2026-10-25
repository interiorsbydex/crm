import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const isTLS = REDIS_URL.startsWith('rediss://');

export const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  enableOfflineQueue: false,
  // Cap reconnect attempts to a slow, bounded backoff (5s → 60s) instead of
  // ioredis's aggressive default. When the provider is rejecting all requests
  // (e.g. a monthly quota is exhausted), hammering it every few ms just burns
  // through more of the quota and floods the logs without ever succeeding.
  retryStrategy: (times: number) => Math.min(5000 * times, 60_000),
  ...(isTLS && { tls: { rejectUnauthorized: false } }),
});

// Redis is optional in dev, but in any environment we don't want connection
// errors to flood the logs — log a single warning and then stay quiet until
// the connection actually recovers.
let lastErrorLoggedAt = 0;
let hasWarnedDown = false;
connection.on('error', (err: Error) => {
  const now = Date.now();
  if (!hasWarnedDown || now - lastErrorLoggedAt > 5 * 60_000) {
    console.error(
      `[redis] connection error, background jobs (SLA checks, emails, reminders, notifications) are degraded: ${err.message}`,
    );
    lastErrorLoggedAt = now;
    hasWarnedDown = true;
  }
});
connection.on('ready', () => {
  if (hasWarnedDown) {
    console.log('[redis] connection recovered — background jobs resuming');
    hasWarnedDown = false;
  }
});

export const queues = {
  reminders: new Queue('reminders', { connection }),
  slaChecks: new Queue('sla-checks', { connection }),
  emails: new Queue('emails', { connection }),
  notifications: new Queue('notifications', { connection }),
};

export { Queue, Worker };
