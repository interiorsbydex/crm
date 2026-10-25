import { afterEach, describe, expect, it } from 'vitest';
import {
  FUNNEL_EDGES,
  defaultStageRules,
  isStageJumpAllowed,
  isWarnOnly,
  requirementsForMove,
  withLockedItems,
  type StageRulesConfig,
} from './stageRequirements.js';
import {
  isStageJumpAllowed as legacyIsStageJumpAllowed,
  legacyRequirementLabels,
} from './__fixtures__/stageRequirements.legacy.js';
import { isLenientForStage as legacyIsLenientForStage } from '../lib/lenientMode.js';

const STAGES = [
  'EFFECTIVE_LEAD', 'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION',
  'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER', 'ON_HOLD', 'INACTIVE',
];
const FLAG_COMBOS = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
  skippedDQL: !!(n & 1), skippedProposalReady: !!(n & 2), skippedProposalDiscussion: !!(n & 4),
}));

const labels = (lead: Record<string, any>, from: string, to: string, rules: StageRulesConfig) =>
  requirementsForMove(lead, from, to, rules).map((r) => r.label);

describe('default stage rules reproduce the original hardcoded gates exactly', () => {
  const rules = defaultStageRules();

  it('requires the same items for every stage pair and skip-flag combination', () => {
    let compared = 0;
    for (const from of STAGES) for (const to of STAGES) for (const lead of FLAG_COMBOS) {
      expect(labels(lead, from, to, rules), `${from} → ${to} ${JSON.stringify(lead)}`)
        .toEqual(legacyRequirementLabels(lead, from, to));
      compared++;
    }
    expect(compared).toBe(STAGES.length * STAGES.length * FLAG_COMBOS.length);
  });

  it('allows and refuses the same stage jumps', () => {
    for (const from of STAGES) for (const to of STAGES) {
      expect(isStageJumpAllowed(from, to, rules), `${from} → ${to}`).toBe(legacyIsStageJumpAllowed(from, to));
    }
  });

  describe('block vs warn matches the LENIENT_LAUNCH switch', () => {
    const saved = process.env.LENIENT_LAUNCH;
    afterEach(() => { if (saved === undefined) delete process.env.LENIENT_LAUNCH; else process.env.LENIENT_LAUNCH = saved; });
    for (const value of ['true', 'false']) {
      it(`LENIENT_LAUNCH=${value}`, () => {
        process.env.LENIENT_LAUNCH = value;
        const r = defaultStageRules();
        // Only target stages that can carry gate items matter: a move into MQL,
        // Effective Lead or an off-funnel stage never has any to warn about.
        for (const to of ['DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS']) {
          expect(isWarnOnly(to, r), to).toBe(legacyIsLenientForStage(to));
        }
      });
    }
  });
});

describe('admin edits change the gates', () => {
  it('a removed item is no longer required, an added one is', () => {
    const rules = defaultStageRules();
    rules.transitions['MQL->DQL'] = rules.transitions['MQL->DQL']
      .filter((r) => r.label !== 'Lifestyle capture sheet (Files → MQL)')
      .concat({ id: 'x', type: 'field', field: 'builder', label: 'Builder name', whenSkipped: 'required' });
    const got = labels({}, 'MQL', 'DQL', rules);
    expect(got).not.toContain('Lifestyle capture sheet (Files → MQL)');
    expect(got).toContain('Builder name');
  });

  it('turning off a skippable stage refuses the jump', () => {
    const rules = defaultStageRules();
    expect(isStageJumpAllowed('DQL', 'PROPOSAL_PRESENTED', rules)).toBe(true);
    rules.skippableStages = rules.skippableStages.filter((s) => s !== 'PROPOSAL_READY');
    expect(isStageJumpAllowed('DQL', 'PROPOSAL_PRESENTED', rules)).toBe(false);
  });

  it('the MQL → Onboarding shortcut can be switched off', () => {
    const rules = { ...defaultStageRules(), allowMqlToOnboarding: false };
    expect(isStageJumpAllowed('MQL', 'ONBOARDING', rules)).toBe(false);
  });

  it('whenSkipped decides what a jump still needs', () => {
    const rules = defaultStageRules();
    const dqlMeeting = 'DQL meeting completed';
    expect(labels({}, 'MQL', 'PROPOSAL_READY', rules)).not.toContain(dqlMeeting);
    rules.transitions['MQL->DQL'] = rules.transitions['MQL->DQL'].map((r) =>
      r.label === dqlMeeting ? { ...r, whenSkipped: 'required' as const } : r);
    expect(labels({}, 'MQL', 'PROPOSAL_READY', rules)).toContain(dqlMeeting);
  });

  it('owedLater items come back on later moves only for leads that skipped', () => {
    const rules = defaultStageRules();
    const pdItems = rules.transitions['PROPOSAL_PRESENTED->PROPOSAL_DISCUSSION'].map((r) => r.label);
    expect(labels({ skippedProposalDiscussion: false }, 'ONBOARDING', 'ONBOARDING_MEETING', rules)).not.toEqual(expect.arrayContaining(pdItems));
    expect(labels({ skippedProposalDiscussion: true }, 'ONBOARDING', 'ONBOARDING_MEETING', rules)).toEqual(expect.arrayContaining(pdItems));
  });

  it('checklist items cannot be removed from a saved copy', () => {
    const rules = defaultStageRules();
    for (const edge of FUNNEL_EDGES) rules.transitions[edge] = [];
    const restored = withLockedItems(rules);
    expect(restored.transitions['ONBOARDING->ONBOARDING_MEETING'].map((r) => r.type)).toEqual(['obObmChecklist']);
    expect(restored.transitions['PROPOSAL_DISCUSSION->ONBOARDING'].map((r) => r.type)).toEqual(['pdObChecklist']);
    expect(restored.transitions['ONBOARDING_MEETING->DESIGN_IN_PROGRESS'].map((r) => r.type)).toEqual(['dip']);
  });

  it('moves into Onboarding and later can never be set to warn', () => {
    const rules = defaultStageRules(true);
    rules.enforcement.ONBOARDING = 'warn';
    expect(isWarnOnly('ONBOARDING', rules)).toBe(false);
    expect(isWarnOnly('DQL', rules)).toBe(true);
  });
});

describe('regression: owed items never leak into other leads\' gates', () => {
  it('a skipped-PD lead moving OB → OBM does not change what the next lead needs', () => {
    const rules = defaultStageRules();
    const before = labels({}, 'ONBOARDING', 'ONBOARDING_MEETING', rules);
    labels({ skippedProposalDiscussion: true }, 'ONBOARDING', 'ONBOARDING_MEETING', rules);
    expect(labels({}, 'ONBOARDING', 'ONBOARDING_MEETING', rules)).toEqual(before);
  });
});
