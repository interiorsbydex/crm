import { prisma } from './prisma.js';
import { sendEmail, slaBreachEmail } from './email.js';
import { resolveBaseUrl } from './baseUrl.js';
import { isAutomationOn } from './automations.js';

/**
 * Email a new SLA breach to the lead's Business Lead and every active Branch Head (once each).
 * Called only when the breach is first recorded, so it is never repeated by the hourly check.
 * Admin → Automations → "SLA breach" switches it off; the in-app alert is separate and always on.
 */
export async function emailSlaBreach(lead: { id: string; leadId: string; assignedBLId: string | null }, ruleLabel: string): Promise<string[]> {
  if (!(await isAutomationOn('TEAM_SLA_BREACH', 'email'))) return [];
  const full = await prisma.lead.findUnique({ where: { id: lead.id }, select: { name: true } });
  const recipients = await prisma.user.findMany({
    where: { isActive: true, OR: [{ role: 'BRANCH_HEAD' }, ...(lead.assignedBLId ? [{ id: lead.assignedBLId }] : [])] },
    select: { name: true, email: true },
  });
  const sent: string[] = [];
  for (const r of new Map(recipients.map((x) => [x.email, x])).values()) {
    if (!r.email) continue;
    const base = resolveBaseUrl();
    const payload = slaBreachEmail({ recipientName: r.name, leadId: lead.leadId, leadName: full?.name ?? '', ruleLabel, link: base ? `${base}/leads/${lead.id}` : undefined });
    payload.to = r.email;
    try {
      await sendEmail(payload);
      await prisma.emailLog.create({ data: { leadId: lead.id, type: 'SLA_BREACH', sentTo: r.email, subject: payload.subject } });
      sent.push(r.email);
    } catch (e) {
      console.warn(`[sla] Could not email ${r.email} about ${lead.leadId}:`, e);
    }
  }
  return sent;
}
