import { Worker } from 'bullmq';
import { connection } from './index.js';
import { sendEmail, type EmailPayload } from '../lib/email.js';

export const emailWorker = new Worker(
  'emails',
  async (job) => {
    const { emailPayload } = job.data as { emailPayload: EmailPayload };
    await sendEmail(emailPayload);
    console.log(`[emailWorker] Sent: "${emailPayload.subject}" → ${emailPayload.to}`);
  },
  { connection },
);
