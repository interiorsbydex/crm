/**
 * Helpers for leads sent by the agency's True Pulse platform through the
 * agency intake link (POST /api/leads/webhook/agency). Agreed with the agency
 * on 18–20 Nov 2026:
 * - the CRE's project details arrive in `notes` as
 *   "Possession: Ready | Type: 3BHK | Scope: Full home | Location: Adyar, Chennai";
 * - `source` is open text (google, facebook, email…);
 * - `landingPageUrl` carries the UTM tags.
 */
import { POSSESSION_RECEIVED, isPossessionReceived, possessionDate } from './possessionFilter.js';

export type NotesDetails = {
  possessionTimeline?: string;
  projectType?: string;
  scope?: string;
  location?: string;
};

// Words the CRE may use for each detail (compared without case, spaces or punctuation).
const NOTE_KEYS: Record<string, keyof NotesDetails> = {
  possession: 'possessionTimeline', possessiondate: 'possessionTimeline', possessiontimeline: 'possessionTimeline',
  type: 'projectType', projecttype: 'projectType', propertytype: 'projectType',
  scope: 'scope', scopeofwork: 'scope',
  location: 'location', area: 'location', city: 'location',
};

const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** "3 bhk" → "3BHK" (the CRM's existing way of writing flat sizes); anything else is kept as typed. */
export function normaliseProjectType(value: string): string {
  const v = value.trim();
  return /^\d+(\.\d+)?\s*bhk$/i.test(v) ? v.replace(/\s+/g, '').toUpperCase() : v;
}

/** "Ready"/"RTMI" → "Possession Received"; a date → YYYY-MM-DD; anything else kept as typed. */
export function normalisePossession(value: string): string {
  const v = value.trim();
  if (isPossessionReceived(v)) return POSSESSION_RECEIVED;
  return possessionDate(v) ?? v;
}

/** Reads the four project details out of the agreed Notes format. Unknown parts are ignored (the full note is kept on the lead). */
export function parseNotesDetails(notes: string | null | undefined): NotesDetails {
  const out: NotesDetails = {};
  for (const part of (notes ?? '').split('|')) {
    const i = part.indexOf(':');
    if (i < 1) continue;
    const field = NOTE_KEYS[keyOf(part.slice(0, i))];
    const value = part.slice(i + 1).trim();
    if (!field || !value || out[field]) continue;
    out[field] = field === 'projectType' ? normaliseProjectType(value)
      : field === 'possessionTimeline' ? normalisePossession(value)
      : value;
  }
  return out;
}

export type UtmTags = { source?: string; medium?: string; campaign?: string; term?: string; content?: string };

/** The utm_* tags in a landing page link. Tolerates extra leading underscores ("__utm_source"). */
export function utmFromUrl(url: string | null | undefined): UtmTags {
  const out: UtmTags = {};
  if (!url) return out;
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0] : '';
  for (const pair of query.split('&')) {
    const [rawKey, ...rest] = pair.split('=');
    const key = rawKey.replace(/^_+/, '').toLowerCase();
    if (!key.startsWith('utm_')) continue;
    let value = rest.join('=');
    try { value = decodeURIComponent(value.replace(/\+/g, ' ')); } catch { /* keep as sent */ }
    value = value.trim();
    const name = key.slice(4) as keyof UtmTags;
    if (value && ['source', 'medium', 'campaign', 'term', 'content'].includes(name) && !out[name]) out[name] = value;
  }
  return out;
}

// Common words for sources the CRM already has.
const SOURCE_ALIASES: Record<string, string> = {
  google: 'GOOGLE_ADS', googleads: 'GOOGLE_ADS', adwords: 'GOOGLE_ADS', gads: 'GOOGLE_ADS',
  facebook: 'META_ADS', fb: 'META_ADS', meta: 'META_ADS', metaads: 'META_ADS', facebookads: 'META_ADS',
  ig: 'INSTAGRAM', insta: 'INSTAGRAM',
  web: 'WEBSITE', site: 'WEBSITE',
};

/**
 * The CRM source code for an open-text source from the agency. A known source
 * (by code, name or a common word) keeps its code; anything else is "OTHER"
 * and the caller keeps the agency's own word.
 */
export function matchSource(raw: string, sources: { value: string; label: string }[]): { code: string; known: boolean } {
  const k = keyOf(raw);
  if (!k) return { code: 'OTHER', known: false };
  const direct = sources.find((s) => keyOf(s.value) === k || keyOf(s.label) === k);
  if (direct) return { code: direct.value, known: true };
  const alias = SOURCE_ALIASES[k];
  if (alias && sources.some((s) => s.value === alias)) return { code: alias, known: true };
  return { code: 'OTHER', known: false };
}
