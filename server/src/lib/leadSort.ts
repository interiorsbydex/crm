import type { Prisma } from '@prisma/client';

/** Columns of the Leads list that can be sorted, and what each one sorts on. */
export const LEAD_SORT_COLUMNS = ['leadId', 'name', 'stage', 'status', 'value', 'designer', 'source', 'intent', 'created', 'updated'] as const;
export type LeadSortColumn = (typeof LEAD_SORT_COLUMNS)[number];

const NEWEST_FIRST: Prisma.LeadOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'asc' }];

/**
 * Order for the Leads list and its export. Anything unrecognised falls back to
 * newest first (the order before sorting existed). Ties and empty values always
 * resolve newest first so pages never shuffle between requests.
 */
export function leadOrderBy(sort?: string, dir?: string): Prisma.LeadOrderByWithRelationInput[] {
  if (!sort || !(LEAD_SORT_COLUMNS as readonly string[]).includes(sort)) return NEWEST_FIRST;
  const d: 'asc' | 'desc' = dir === 'asc' ? 'asc' : 'desc';
  const nullsLast = { sort: d, nulls: 'last' as const };
  const primary: Prisma.LeadOrderByWithRelationInput =
    sort === 'leadId' ? { leadId: d }
    : sort === 'name' ? { name: d }
    : sort === 'stage' ? { stage: d }
    : sort === 'status' ? { status: d }
    : sort === 'value' ? { estimatedValue: nullsLast }
    : sort === 'designer' ? { assignedDesigner: { name: d } }
    : sort === 'source' ? { source: nullsLast }
    : sort === 'intent' ? { intentRating: nullsLast }
    : sort === 'created' ? { createdAt: d }
    : { updatedAt: d };
  return [primary, ...NEWEST_FIRST];
}
