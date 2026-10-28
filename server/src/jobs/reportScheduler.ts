import { Worker, Queue } from 'bullmq';
import { queueOpts, workerOpts } from './index.js';
import { prisma } from '../lib/prisma.js';
import { sendEmailByType } from '../lib/emailService.js';

const QUEUE_NAME = 'report-scheduler';
export const reportQueue = new Queue(QUEUE_NAME, queueOpts);

export async function scheduleReportJobs() {
  // Weekly: every Monday at 8am IST (02:30 UTC)
  await reportQueue.add('weekly-report', { type: 'WEEKLY' }, {
    repeat: { pattern: '30 2 * * 1' },
    jobId: 'weekly-report-singleton',
  });
  // Monthly: 1st of month at 8am IST
  await reportQueue.add('monthly-report', { type: 'MONTHLY' }, {
    repeat: { pattern: '30 2 1 * *' },
    jobId: 'monthly-report-singleton',
  });
  console.log('[jobs] Report scheduler jobs registered (weekly Mon 8am IST, monthly 1st 8am IST)');
}

export const reportWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { type } = job.data as { type: 'WEEKLY' | 'MONTHLY' };
    console.log(`[reports] Generating ${type} report…`);

    const schedules = await prisma.reportSchedule.findMany({
      where: { type },
    });

    if (!schedules.length) {
      console.log(`[reports] No ${type} report schedules configured.`);
      return;
    }

    // Gather all unique recipient user IDs
    const recipientIds = [...new Set(schedules.flatMap((s) => s.recipients))];
    const recipients = await prisma.user.findMany({
      where: { id: { in: recipientIds }, isActive: true },
      select: { id: true, email: true, name: true },
    });

    const period = type === 'WEEKLY'
      ? `Week of ${new Date().toLocaleDateString('en-IN')}`
      : `Month of ${new Date().toLocaleString('en-IN', { month: 'long', year: 'numeric' })}`;

    // Get high-level stats for the email. "Onboardings" here means leads that
    // have converted — DESIGN_IN_PROGRESS is the funnel's terminal/incentive
    // stage, HANDED_OVER kept for legacy leads (see funnel-restructure memory).
    const [totalLeads, onboardings, slaBreaches] = await Promise.all([
      prisma.lead.count(),
      prisma.lead.count({ where: { stage: { in: ['DESIGN_IN_PROGRESS', 'HANDED_OVER'] } } }),
      prisma.sLABreach.count({ where: { resolvedAt: null } }),
    ]);

    // Send to each recipient
    for (const recipient of recipients) {
      await sendEmailByType(
        'MOM', // reusing MOM template as a general report email for now
        'system',
        {
          clientName: recipient.name,
          meetingType: `${type} CRM Report`,
          scheduledAt: period,
          mom: `Total Leads: ${totalLeads}\nOnboardings: ${onboardings}\nActive SLA Breaches: ${slaBreaches}\n\nLog in to the CRM for full details and export.`,
          designerName: 'FYX CRM',
        },
        recipient.email,
      );
    }

    // Update lastSentAt
    await prisma.reportSchedule.updateMany({
      where: { type },
      data: { lastSentAt: new Date() },
    });

    console.log(`[reports] ${type} report sent to ${recipients.length} recipient(s).`);
  },
  workerOpts,
);
