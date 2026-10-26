import { prisma } from './prisma.js';
import { createNotification } from './notifications.js';
import { getCrmSettings } from './crmSettings.js';
import { istDayBounds } from './istTime.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * In-app reminder, a set number of days before an On Hold lead's revival date
 * (Admin → CRM Settings → "Remind before an on-hold lead reopens"; 0 = off), to the
 * lead's designer and Business Lead. A person is told once per lead and revival date:
 * running this again, or moving the date, never repeats the same reminder.
 */
export async function sendOnHoldReminders(now = new Date()): Promise<{ reminded: number; details: string[] }> {
  const { onHoldReminderDaysBefore: days } = await getCrmSettings();
  const details: string[] = [];
  if (days <= 0) return { reminded: 0, details };

  const { start } = istDayBounds(now);
  const leads = await prisma.lead.findMany({
    where: {
      status: 'ON_HOLD',
      onHoldRevivalDate: { gt: start, lt: new Date(start.getTime() + (days + 1) * DAY_MS) },
    },
    select: { id: true, leadId: true, name: true, assignedBLId: true, assignedDesignerId: true, onHoldRevivalDate: true },
  });

  let reminded = 0;
  for (const lead of leads) {
    const revival = lead.onHoldRevivalDate!;
    const when = revival.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
    const message = `Lead ${lead.leadId} (${lead.name}) is due to reopen from On Hold on ${when}.`;
    const people = new Set([lead.assignedDesignerId, lead.assignedBLId].filter((x): x is string => !!x));
    let sent = 0;
    for (const userId of people) {
      const already = await prisma.notificationLog.findFirst({
        where: { userId, type: 'ON_HOLD_REOPEN', leadId: lead.id, eventAt: revival },
        select: { id: true },
      });
      if (already) continue;
      await createNotification(userId, 'ON_HOLD_REOPEN', message, lead.id, revival);
      reminded++;
      sent++;
    }
    if (sent) details.push(`onhold-reminder:${lead.leadId}`);
  }
  return { reminded, details };
}
