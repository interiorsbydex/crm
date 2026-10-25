import { z } from 'zod';

export const DASHBOARD_CONTENT_PREFIX = 'dashboard_content:v1:';

const optionalHttpsUrl = z.preprocess(
  (value) => typeof value === 'string' ? value.trim() || null : value ?? null,
  z.string().url().max(2048).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch { return false; }
  }, 'Use an HTTPS URL without embedded credentials').nullable(),
);

export const dashboardContentDraft = z.object({
  kind: z.enum(['ANNOUNCEMENT', 'INSPIRATION']),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(5000),
  imageUrl: optionalHttpsUrl,
  linkUrl: optionalHttpsUrl,
}).strict();

export const dashboardContentUpdate = dashboardContentDraft.extend({
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

export const dashboardContentItem = dashboardContentDraft.extend({
  id: z.string().uuid(),
  revision: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strip();

export function contentKey(id: unknown) {
  return DASHBOARD_CONTENT_PREFIX + z.string().uuid().parse(id);
}

export function parseStoredContent(value: unknown) {
  const result = dashboardContentItem.safeParse(value);
  if (!result.success) throw new DashboardContentError(500, 'Stored dashboard content is invalid. Contact Admin.');
  return result.data;
}

export class DashboardContentError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
