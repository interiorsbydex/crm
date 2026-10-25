import { describe, it, expect } from 'vitest';
import {
  computeStageSlaStatus,
  computeDesignPipelineTimeline,
  SALES_STAGE_SLA,
  DESIGN_OVERALL_SLA_DAYS,
  daysBetween,
} from './slaConfig.js';

describe('computeStageSlaStatus', () => {
  it('returns "ok" for a stage with no defined SLA threshold', () => {
    expect(computeStageSlaStatus('EFFECTIVE_LEAD', 999)).toBe('ok');
  });

  it('returns "ok" while comfortably below the warning threshold', () => {
    // MQL: warning 7d, breach 15d
    expect(computeStageSlaStatus('MQL', 3)).toBe('ok');
  });

  it('flips to "warning" exactly at the warning-day boundary', () => {
    expect(computeStageSlaStatus('MQL', 7)).toBe('warning');
    expect(computeStageSlaStatus('MQL', 6)).toBe('ok');
  });

  it('flips to "breach" exactly at the breach-day boundary', () => {
    expect(computeStageSlaStatus('MQL', 15)).toBe('breach');
    expect(computeStageSlaStatus('MQL', 14)).toBe('warning');
  });

  it('treats a flat (single-number) threshold as immediate breach at that day, not a warning phase', () => {
    // DQL: warningDays === breachDays === 2 per founder spec — no yellow phase.
    const t = SALES_STAGE_SLA.DQL;
    expect(t.warningDays).toBe(t.breachDays);
    expect(computeStageSlaStatus('DQL', 1)).toBe('ok');
    expect(computeStageSlaStatus('DQL', 2)).toBe('breach');
  });

  it('uses admin-overridden thresholds when supplied instead of the hardcoded defaults', () => {
    const overrides = { MQL: { warningDays: 1, breachDays: 2, label: 'MQL → DQL' } };
    expect(computeStageSlaStatus('MQL', 1, overrides)).toBe('warning');
    expect(computeStageSlaStatus('MQL', 2, overrides)).toBe('breach');
    // Without overrides the same daysInStage is still "ok" under defaults.
    expect(computeStageSlaStatus('MQL', 2)).toBe('ok');
  });

  it('does not flag a lead sitting in ONBOARDING under a stale legacy breach as breached unless real days warrant it', () => {
    // Task #14 added a real ONBOARDING threshold (3d/3d); a lead only 1 day
    // into ONBOARDING must read "ok" regardless of any stale legacy flag
    // that display layers elsewhere are responsible for suppressing.
    expect(computeStageSlaStatus('ONBOARDING', 1)).toBe('ok');
    expect(computeStageSlaStatus('ONBOARDING', 3)).toBe('breach');
  });
});

describe('daysBetween', () => {
  it('never returns a negative number when "to" precedes "from"', () => {
    const from = new Date('2026-01-10T00:00:00Z');
    const to = new Date('2026-01-05T00:00:00Z');
    expect(daysBetween(from, to)).toBe(0);
  });

  it('floors partial days', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-03T12:00:00Z');
    expect(daysBetween(from, to)).toBe(2);
  });
});

describe('computeDesignPipelineTimeline', () => {
  const now = new Date('2026-03-01T00:00:00Z');

  it('handles no OBOBMChecklist dates recorded at all (nothing started yet)', () => {
    const fallback = new Date('2026-02-01T00:00:00Z');
    const timeline = computeDesignPipelineTimeline(null, fallback, now);
    expect(timeline.kickoffDate).toBeNull();
    expect(timeline.overallElapsedDays).toBeNull();
    expect(timeline.overallRemainingDays).toBeNull();
    expect(timeline.overallStatus).toBe('ok');
    expect(timeline.phases.every((p) => p.status === 'upcoming')).toBe(true);
  });

  it('handles partial OBOBMChecklist dates — only the first few phases recorded', () => {
    const obm = {
      siteDocumentationAt: new Date('2026-01-01T00:00:00Z'),
      initialSiteDiscussionAt: new Date('2026-01-05T00:00:00Z'),
      layoutFinalisationAt: null,
      designDiscussionAt: null,
      preSignOffAt: null,
      maskingAt: null,
      signOffAt: null,
    };
    const timeline = computeDesignPipelineTimeline(obm, new Date('2026-01-01T00:00:00Z'), now);
    const [siteDoc, siteDiscussion, layout] = timeline.phases;
    expect(siteDoc.status).toBe('done');
    expect(siteDoc.elapsedDays).toBe(4); // Jan 1 -> Jan 5
    expect(siteDiscussion.status).toBe('in_progress'); // no next date yet
    expect(layout.status).toBe('upcoming');
    expect(layout.startDate).toBeNull();
  });

  it('computes multiple stage changes across the full 7 dated phases, each measured against the next', () => {
    const obm = {
      siteDocumentationAt: new Date('2026-01-01T00:00:00Z'),
      initialSiteDiscussionAt: new Date('2026-01-04T00:00:00Z'),
      layoutFinalisationAt: new Date('2026-01-14T00:00:00Z'),
      designDiscussionAt: new Date('2026-01-21T00:00:00Z'),
      preSignOffAt: new Date('2026-01-28T00:00:00Z'),
      maskingAt: new Date('2026-02-04T00:00:00Z'),
      signOffAt: new Date('2026-02-08T00:00:00Z'),
    };
    const timeline = computeDesignPipelineTimeline(obm, new Date('2026-01-01T00:00:00Z'), now);
    const byKey = Object.fromEntries(timeline.phases.map((p) => [p.key, p]));
    expect(byKey.SITE_DOCUMENTATION.elapsedDays).toBe(3); // Jan1->Jan4
    expect(byKey.SITE_DOCUMENTATION.allocatedDays).toBe(3);
    expect(byKey.SITE_DOCUMENTATION.status).toBe('done');
    expect(byKey.SIGN_OFF.status).toBe('in_progress'); // last dated phase, no follow-on date yet
  });

  it('marks a phase "breach" only once elapsed strictly exceeds its allocated window', () => {
    const obm: any = {
      siteDocumentationAt: new Date('2026-01-01T00:00:00Z'),
      initialSiteDiscussionAt: new Date('2026-01-05T00:00:00Z'), // 4-day window
    };
    const exact = computeDesignPipelineTimeline(obm, new Date('2026-01-01T00:00:00Z'), now).phases[0];
    expect(exact.elapsedDays).toBe(4);
    expect(exact.allocatedDays).toBe(4);
    expect(exact.slaStatus).toBe('warning'); // elapsed(4) >= ceil(70% of 4)=3, but not > allocated(4)

    const overrun = { ...obm, initialSiteDiscussionAt: new Date('2026-01-08T00:00:00Z') }; // 7-day window
    const breached = computeDesignPipelineTimeline({ ...overrun, layoutFinalisationAt: new Date('2026-01-09T00:00:00Z') }, new Date('2026-01-01T00:00:00Z'), now).phases[0];
    expect(breached.elapsedDays).toBe(7);
    expect(breached.allocatedDays).toBe(7);
    expect(breached.slaStatus).toBe('warning'); // still elapsed === allocated, not strictly greater

    const strictOverrun = computeDesignPipelineTimeline({ siteDocumentationAt: new Date('2026-01-01T00:00:00Z'), initialSiteDiscussionAt: new Date('2026-01-10T00:00:00Z') }, new Date('2026-01-01T00:00:00Z'), now).phases[0];
    expect(strictOverrun.elapsedDays).toBe(9);
    expect(strictOverrun.allocatedDays).toBe(9);
  });

  it('regression guard: EIP begins once Sign Off is recorded rather than sitting "upcoming" forever', () => {
    // computeDesignPipelineTimeline previously had a bug where EIP's
    // dateField being null meant it never left "upcoming" even after Sign
    // Off — fixed to inherit Sign Off's date as its effective start.
    const obm: any = { signOffAt: new Date('2026-02-01T00:00:00Z') };
    const timeline = computeDesignPipelineTimeline(obm, new Date('2026-01-01T00:00:00Z'), now);
    const eip = timeline.phases.find((p) => p.key === 'EIP')!;
    expect(eip.status).toBe('in_progress');
    expect(eip.startDate).toBe(obm.signOffAt.toISOString());
    expect(eip.elapsedDays).toBe(28); // Feb 1 -> Mar 1
  });

  it('EIP stays "upcoming" when Sign Off has not been recorded yet', () => {
    const timeline = computeDesignPipelineTimeline(null, new Date('2026-01-01T00:00:00Z'), now);
    const eip = timeline.phases.find((p) => p.key === 'EIP')!;
    expect(eip.status).toBe('upcoming');
    expect(eip.startDate).toBeNull();
  });

  it('flags overall status "ok" comfortably inside the 45-day window and "breach" at/after day 45', () => {
    const kickoff = new Date('2026-01-01T00:00:00Z');
    const obm: any = { siteDocumentationAt: kickoff };

    const early = computeDesignPipelineTimeline(obm, kickoff, new Date('2026-01-10T00:00:00Z'));
    expect(early.overallStatus).toBe('ok');

    const boundary = computeDesignPipelineTimeline(obm, kickoff, new Date(kickoff.getTime() + DESIGN_OVERALL_SLA_DAYS * 86400000));
    expect(boundary.overallElapsedDays).toBe(DESIGN_OVERALL_SLA_DAYS);
    expect(boundary.overallStatus).toBe('breach');

    const justBefore = computeDesignPipelineTimeline(obm, kickoff, new Date(kickoff.getTime() + (DESIGN_OVERALL_SLA_DAYS - 1) * 86400000));
    expect(justBefore.overallStatus).not.toBe('breach');
  });
});
