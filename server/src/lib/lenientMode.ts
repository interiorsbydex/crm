import { logActivity } from './activityLog.js';

/**
 * Lenient-launch switch. When ON (default), blueprint requirements that used to
 * block users (stage gates, checklist "send" gates, optional call/task extras)
 * become warnings: the action proceeds and the missing items are recorded as a
 * GATE_BYPASSED activity entry so we can see what the team skipped.
 *
 * The rules themselves are untouched — set LENIENT_LAUNCH=false to restore the
 * original strict behaviour.
 *
 * Never relaxed by this switch: lead basics at creation, meeting MOM, NPS at the
 * onboarding meeting, the client email needed to physically send a mail, and
 * the lock on inactive leads.
 */
export function isLenientLaunch(): boolean {
  return (process.env.LENIENT_LAUNCH ?? 'true').toLowerCase() !== 'false';
}

/**
 * Annie (Oct 2026): from Onboarding onward the full existing rules apply
 * (OB, OBM and DIP checklists, uploads, stage-move requirements), so the lenient
 * switch never relaxes a move INTO these stages or the checklists that guard them.
 */
const STRICT_TARGET_STAGES = new Set(['ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER']);
export function isStrictStage(targetStage: string): boolean {
  return STRICT_TARGET_STAGES.has(targetStage);
}

/** Lenient only for the pre-Onboarding part of the funnel. */
export function isLenientForStage(targetStage: string): boolean {
  return isLenientLaunch() && !isStrictStage(targetStage);
}

export async function logGateBypass(
  userId: string,
  leadId: string,
  kind: string,
  missing: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!missing.length) return;
  await logActivity(userId, 'GATE_BYPASSED', leadId, { kind, missing, ...extra }).catch((e) =>
    console.warn('[lenient] could not record bypass:', e.message),
  );
}
