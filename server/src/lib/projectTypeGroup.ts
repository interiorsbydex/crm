// Project type is typed free-hand ("Apartment - 3bhk", "Villa 4BHK", "5bhk"). Reports and filters group it by its
// first word, the way the team's sheet does, without touching what is stored on the lead.

export const BLANK_PROJECT_TYPE = '(blank)';

/** "Apartment - 3bhk" → "Apartment"; "independent house 4bhk" → "Independent House"; "5bhk", "" or null → "" (blank). */
export function projectTypeGroup(raw: string | null | undefined): string {
  const words = (raw ?? '').trim().split(/[\s\-–—,/]+/).filter(Boolean);
  const first = words[0];
  if (!first || !/^[A-Za-z]+$/.test(first)) return '';
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  if (first.toLowerCase() === 'independent' && /^[A-Za-z]+$/.test(words[1] ?? '')) return `${cap(first)} ${cap(words[1])}`;
  return cap(first);
}

/** Display name for a group ('' → "(blank)"). */
export const projectTypeGroupLabel = (group: string): string => group || BLANK_PROJECT_TYPE;

/**
 * Prisma `where` fragment for a project-type filter. A plain word (or "(blank)") matches every lead whose project type
 * starts with it, so "Apartment" finds "Apartment - 3bhk"; anything else (e.g. "2BHK") stays a case-insensitive exact match.
 * The caller AND-s the fragment in.
 */
export function projectTypeWhere(value: string): Record<string, unknown> {
  const v = value.trim();
  if (v.toLowerCase() === BLANK_PROJECT_TYPE) {
    return {
      OR: [
        { projectType: null },
        { projectType: '' },
        ...'0123456789'.split('').map((d) => ({ projectType: { startsWith: d } })),
      ],
    };
  }
  if (/^[A-Za-z]+( [A-Za-z]+)?$/.test(v)) return { projectType: { startsWith: v, mode: 'insensitive' } };
  return { projectType: { equals: v, mode: 'insensitive' } };
}
