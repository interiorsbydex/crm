import { prisma } from './prisma.js';
import { logActivity } from './activityLog.js';
import { createNotification } from './notifications.js';

/** Phone numbers are compared on their last 10 digits, so "+91 98765 43210" equals "9876543210". */
export function phoneKey(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '').slice(-10);
}

export type DuplicateMatch = {
  id: string;
  leadId: string;
  name: string;
  matchedOn: 'phone' | 'email';
  assignedDesignerId: string | null;
  assignedBLId: string | null;
  assignedCREId: string | null;
};

/** Finds an existing lead with the same phone (last 10 digits) or the same email (ignoring case). */
export async function findDuplicateLead(input: { phone?: string | null; email?: string | null }): Promise<DuplicateMatch | null> {
  const key = phoneKey(input.phone);
  const select = { id: true, leadId: true, name: true, assignedDesignerId: true, assignedBLId: true, assignedCREId: true } as const;
  if (key.length >= 7) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM leads
      WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ${key}
         OR right(regexp_replace(coalesce(phone2, ''), '[^0-9]', '', 'g'), 10) = ${key}
      ORDER BY "createdAt" ASC LIMIT 1`;
    if (rows[0]) {
      const lead = await prisma.lead.findUnique({ where: { id: rows[0].id }, select });
      if (lead) return { ...lead, matchedOn: 'phone' };
    }
  }
  const email = input.email?.trim();
  if (email) {
    const lead = await prisma.lead.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, orderBy: { createdAt: 'asc' }, select });
    if (lead) return { ...lead, matchedOn: 'email' };
  }
  return null;
}

/** Plain-English message for the new-lead form. */
export function duplicateMessage(match: Pick<DuplicateMatch, 'leadId' | 'matchedOn'>): string {
  return `This ${match.matchedOn === 'phone' ? 'phone number' : 'email'} already belongs to lead ${match.leadId}. Open that lead instead of creating a new one.`;
}

/**
 * An enquiry arrived by webhook for someone we already have. No new lead is made (no
 * double counting); instead the existing lead gets a history entry and its team is alerted.
 */
export async function recordDuplicateEnquiry(
  existing: DuplicateMatch,
  actorUserId: string,
  info: { source: string; name?: string; phone?: string; email?: string },
): Promise<void> {
  await logActivity(actorUserId, 'DUPLICATE_ENQUIRY', existing.id, {
    source: info.source, name: info.name, phone: info.phone, email: info.email, matchedOn: existing.matchedOn,
  });
  const people = new Set([existing.assignedDesignerId, existing.assignedBLId, existing.assignedCREId].filter((x): x is string => !!x));
  const message = `${existing.leadId} (${existing.name}) enquired again via ${info.source.replace(/_/g, ' ').toLowerCase()}. No new lead was made.`;
  for (const uid of people) await createNotification(uid, 'DUPLICATE_ENQUIRY', message, existing.id);
}
