import { describe, expect, it } from 'vitest';
import { buildStageTimelineHistory } from './stageTimeline.js';

describe('buildStageTimelineHistory', () => {
  it('keeps each completed stage’s captured commercial context after later changes', () => {
    const history = buildStageTimelineHistory({
      leadStage: 'DQL',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      now: new Date('2026-08-06T00:00:00Z'),
      currentCommercialContext: { budget: 2_000_000, intent: 5, projectValue: 2_400_000 },
      stageLogs: [{
        createdAt: new Date('2026-08-03T00:00:00Z'),
        meta: {
          from: 'MQL',
          to: 'DQL',
          fromCommercialContext: { budget: 1_500_000, intent: 4, projectValue: 1_500_000 },
          toCommercialContext: { budget: 2_000_000, intent: 5, projectValue: 2_400_000 },
        },
      }],
    });

    expect(history).toEqual([
      expect.objectContaining({
        stage: 'MQL',
        tatDays: 2,
        commercialContext: { budget: 1_500_000, intent: 4, projectValue: 1_500_000 },
      }),
      expect.objectContaining({
        stage: 'DQL',
        tatDays: 3,
        commercialContext: { budget: 2_000_000, intent: 5, projectValue: 2_400_000 },
      }),
    ]);
  });

  it('uses current context only for a lead that has not yet moved stages', () => {
    const history = buildStageTimelineHistory({
      leadStage: 'MQL',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      now: new Date('2026-08-02T00:00:00Z'),
      currentCommercialContext: { budget: 1_500_000, intent: 4, projectValue: 1_800_000 },
      stageLogs: [],
    });

    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(expect.objectContaining({
      stage: 'MQL',
      commercialContext: { budget: 1_500_000, intent: 4, projectValue: 1_800_000 },
    }));
  });

  it('leaves legacy stages without snapshots blank instead of using later values', () => {
    const history = buildStageTimelineHistory({
      leadStage: 'DQL',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      now: new Date('2026-08-06T00:00:00Z'),
      currentCommercialContext: { budget: 2_000_000, intent: 5, projectValue: 2_400_000 },
      stageLogs: [{
        createdAt: new Date('2026-08-03T00:00:00Z'),
        meta: { from: 'MQL', to: 'DQL' },
      }],
    });

    expect(history[0].commercialContext).toBeUndefined();
    expect(history[1].commercialContext).toEqual({ budget: 2_000_000, intent: 5, projectValue: 2_400_000 });
  });

  it('retains the Onboarding snapshot through the automatic Onboarding Meeting transition', () => {
    const onboardingContext = { budget: 1_500_000, intent: 4, projectValue: 1_800_000 };
    const onboardingMeetingContext = { budget: 1_500_000, intent: 4, projectValue: 2_000_000 };
    const history = buildStageTimelineHistory({
      leadStage: 'ONBOARDING_MEETING',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      now: new Date('2026-08-07T00:00:00Z'),
      currentCommercialContext: onboardingMeetingContext,
      stageLogs: [
        {
          createdAt: new Date('2026-08-02T00:00:00Z'),
          meta: {
            from: 'PROPOSAL_DISCUSSION',
            to: 'ONBOARDING',
            fromCommercialContext: { budget: 1_500_000, intent: 4, projectValue: 1_500_000 },
            toCommercialContext: onboardingContext,
          },
        },
        {
          createdAt: new Date('2026-08-05T00:00:00Z'),
          meta: {
            from: 'ONBOARDING',
            to: 'ONBOARDING_MEETING',
            fromCommercialContext: onboardingContext,
            toCommercialContext: onboardingMeetingContext,
          },
        },
      ],
    });

    expect(history.find((visit) => visit.stage === 'ONBOARDING')).toEqual(
      expect.objectContaining({ commercialContext: onboardingContext }),
    );
  });

  it('records a pushback and requalification as distinct immutable stage visits', () => {
    const mqlContext = { budget: 1_500_000, intent: 4, projectValue: 1_500_000 };
    const returnedToCreContext = { budget: 1_300_000, intent: 3, projectValue: 1_300_000 };
    const requalifiedContext = { budget: 1_600_000, intent: 5, projectValue: 1_900_000 };
    const history = buildStageTimelineHistory({
      leadStage: 'MQL',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      now: new Date('2026-08-07T00:00:00Z'),
      currentCommercialContext: requalifiedContext,
      stageLogs: [
        {
          createdAt: new Date('2026-08-02T00:00:00Z'),
          meta: {
            from: 'MQL',
            to: 'EFFECTIVE_LEAD',
            fromCommercialContext: mqlContext,
            toCommercialContext: returnedToCreContext,
          },
        },
        {
          createdAt: new Date('2026-08-04T00:00:00Z'),
          meta: {
            from: 'EFFECTIVE_LEAD',
            to: 'MQL',
            fromCommercialContext: returnedToCreContext,
            toCommercialContext: requalifiedContext,
          },
        },
      ],
    });

    expect(history.map((visit) => visit.stage)).toEqual(['MQL', 'EFFECTIVE_LEAD', 'MQL']);
    expect(history[0].commercialContext).toEqual(mqlContext);
    expect(history[1].commercialContext).toEqual(returnedToCreContext);
    expect(history[2].commercialContext).toEqual(requalifiedContext);
  });
});