import type { Queue } from 'bullmq';
import { getCrmSettings } from '../lib/crmSettings.js';

/**
 * The weekly digests run on the day chosen in Admin → CRM Settings (default
 * Tuesday). They are scheduled every day at 08:00 IST and each run checks
 * whether today is that day, so changing the setting needs no rescheduling.
 */
export const DAILY_0800_IST = '30 2 * * *'; // 08:00 IST = 02:30 UTC

/** Schedule `name` daily at 08:00 IST, removing any older schedule (e.g. the former Tuesday-only one). */
export async function scheduleDaily0800Ist(queue: Queue, name: string, jobId: string) {
  for (const job of await queue.getRepeatableJobs()) {
    if (job.pattern !== DAILY_0800_IST) await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(name, {}, { repeat: { pattern: DAILY_0800_IST }, jobId });
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function isWeeklyDigestDay(now: Date = new Date()): Promise<boolean> {
  const istWeekday = new Date(now.getTime() + IST_OFFSET_MS).getUTCDay();
  return istWeekday === (await getCrmSettings()).weeklyDigestDay;
}
