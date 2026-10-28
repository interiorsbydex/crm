/** Nightly 03:00 — saves designer credits for BI/reporting (see lib/creditSnapshots.ts). */
import { Queue, Worker } from 'bullmq';
import { queueOpts, workerOpts } from './index.js';
import { refreshCreditSnapshots } from '../lib/creditSnapshots.js';

const QUEUE_NAME = 'credit-snapshots';
export const creditSnapshotsQueue = new Queue(QUEUE_NAME, queueOpts);

export async function scheduleCreditSnapshots() {
  await creditSnapshotsQueue.add('nightly-credit-snapshots', {}, {
    repeat: { pattern: '0 3 * * *' },
    jobId: 'credit-snapshots-singleton',
  });
  console.log('[jobs] Nightly credit snapshots scheduled (0 3 * * *)');
}

export const creditSnapshotsWorker = new Worker(
  QUEUE_NAME,
  async () => refreshCreditSnapshots(),
  workerOpts,
);
creditSnapshotsWorker.on('failed', (_job, err) => console.error('[credit-snapshots] failed:', err.message));
