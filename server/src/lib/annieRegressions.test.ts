/**
 * Annie's 9 reported issues (fixed on Replit, Oct 2026), each pinned by a test
 * so it can't quietly come back. Several live in their own test files; this
 * file covers the rest and lists where each one is guarded.
 *
 * 1. Booking Forecast removed from the dashboard ............ here
 * 2. Lead Progression shows time in readable days ............ here
 * 3. Designer ageing counts from assignment, no invented dates  designerAssignmentAge.test.ts
 * 4. Onboarding value = agreed value after discount, excl. GST  onboardingTargetValue.test.ts
 * 5. DIP checklist wording; Google review optional ............ here
 * 6. Welcome documents attached, maintained in Admin ......... mailTemplateAttachments.test.ts
 * 7. No repeated NPS prompt after the survey was sent ........ npsLifecycle.test.ts
 * 8. NPS "draft prepared" is not shown as "sent" ............. npsLifecycle.test.ts
 * 9. Onboarding email keeps its date table when sent ......... emailDraftFormatting.test.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_ITEMS } from './checklists.js';

const clientFile = (path: string) => readFileSync(fileURLToPath(new URL(`../../../client/src/${path}`, import.meta.url)), 'utf8');

describe("Annie's reported issues stay fixed", () => {
  it('#1 the dashboards have no Booking Forecast tile', () => {
    expect(clientFile('lib/dashboardTiles.ts')).not.toMatch(/booking ?forecast/i);
  });

  it('#2 Lead Progression shows time in readable days', async () => {
    // Loaded at run time so the server build never compiles client files.
    const clientLib = new URL('../../../client/src/lib/leadProgression.ts', import.meta.url).href;
    const { formatLeadProgressionTat } = await import(/* @vite-ignore */ clientLib) as { formatLeadProgressionTat: (d: number | null) => string };
    expect(formatLeadProgressionTat(null)).toBe('—');
    expect(formatLeadProgressionTat(0)).toBe('0 days');
    expect(formatLeadProgressionTat(0.4)).toBe('Less than 1 day');
    expect(formatLeadProgressionTat(1.2)).toBe('1 day');
    expect(formatLeadProgressionTat(6.6)).toBe('7 days');
  });

  it("#5 the DIP checklist uses Annie's wording and keeps Google review optional", () => {
    const labels = Object.fromEntries(BUILT_IN_ITEMS.dip.map((i) => [i.key, i.label]));
    expect(labels.cxApprovalReceived).toBe('Client mail approval');
    expect(labels.internalMailThreadCompleted).toBe('Internal mail trigger');
    expect(Object.keys(labels)).not.toContain('googleReviewReceived'); // never required
    expect(clientFile('components/DIPChecklistPanel.tsx')).toContain("{ key: 'googleReviewReceived', label: 'Google review received' }");
  });
});
