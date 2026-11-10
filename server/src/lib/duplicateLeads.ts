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

/**
 * Finds an existing lead with the same phone (last 10 digits, either of its two
 * numbers) or the same email (ignoring case, either of its two emails).
 * `excludeId` leaves out the lead being edited, so it doesn't match itself.
 */
export async function findDuplicateLead(input: {
  phone?: string | null; phone2?: string | null; email?: string | null; email2?: string | null; excludeId?: string;
}): Promise<DuplicateMatch | null> {
  const select = { id: true, leadId: true, name: true, assignedDesignerId: true, assignedBLId: true, assignedCREId: true } as const;
  const exclude = input.excludeId ?? '';
  for (const key of [phoneKey(input.phone), phoneKey(input.phone2)]) {
    if (key.length < 7) continue;
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM leads
      WHERE id <> ${exclude}
        AND (right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ${key}
          OR right(regexp_replace(coalesce(phone2, ''), '[^0-9]', '', 'g'), 10) = ${key})
      ORDER BY "createdAt" ASC LIMIT 1`;
    if (rows[0]) {
      const lead = await prisma.lead.findUnique({ where: { id: rows[0].id }, select });
      if (lead) return { ...lead, matchedOn: 'phone' };
    }
  }
  for (const raw of [input.email, input.email2]) {
    const email = raw?.trim();
    if (!email) continue;
    const lead = await prisma.lead.findFirst({
      where: {
        ...(exclude && { id: { not: exclude } }),
        OR: [{ email: { equals: email, mode: 'insensitive' } }, { email2: { equals: email, mode: 'insensitive' } }],
      },
      orderBy: { createdAt: 'asc' },
      select,
    });
    if (lead) return { ...lead, matchedOn: 'email' };
  }
  return null;
}

/** Plain-English message for the new-lead form. */
export function duplicateMessage(match: Pick<DuplicateMatch, 'leadId' | 'matchedOn'>): string {
  return `This ${match.matchedOn === 'phone' ? 'phone number' : 'email'} already belongs to lead ${match.leadId}. Open that lead instead of creating a new one.`;
}

/** Plain-English message for editing a lead's contact details. */
export function duplicateEditMessage(match: Pick<DuplicateMatch, 'leadId' | 'name' | 'matchedOn'>): string {
  return `This ${match.matchedOn === 'phone' ? 'phone number' : 'email'} already belongs to lead ${match.leadId} (${match.name}). Each client should have only one lead.`;
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
