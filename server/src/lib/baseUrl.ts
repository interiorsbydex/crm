/**
 * Resolve the absolute public base URL from available environment variables.
 * Priority: BASE_URL (explicit config) → REPLIT_DEV_DOMAIN (Replit-injected dev URL).
 * Returns null only when no usable absolute URL exists — callers should warn
 * and skip sending a link rather than emitting a localhost URL that is
 * unreachable by anyone outside this container.
 */
export function resolveBaseUrl(): string | null {
  const explicit = (process.env.BASE_URL ?? '').trim().replace(/\/$/, '');
  if (explicit.startsWith('http://') || explicit.startsWith('https://')) return explicit;

  const devDomain = (process.env.REPLIT_DEV_DOMAIN ?? '').trim();
  if (devDomain) return `https://${devDomain}`;

  return null;
}
