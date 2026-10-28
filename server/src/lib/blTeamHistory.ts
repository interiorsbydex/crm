// Which Business Lead a designer reported to on a given date (Annie, item 7B:
// history stays with the BL the designer belonged to when the activity or
// booking happened). There is no history table: every change of a designer's
// BL, and every switch-off / switch-on, is written to the activity log as
// DESIGNER_TEAM_CHANGED { designerId, fromBlId, toBlId }. Before a designer's
// first such entry they belonged to that entry's fromBlId (or, with no entry
// at all, to their current BL).
import { prisma } from './prisma.js';
import { logActivity } from './activityLog.js';

export const TEAM_CHANGE_ACTION = 'DESIGNER_TEAM_CHANGED';

export type TeamChange = { designerId: string; fromBlId: string | null; toBlId: string | null; at: Date };
export type DesignerNow = { id: string; blId: string | null; isActive: boolean };
/** A stretch of time a designer spent in one BL's team. `blId` null = no team / switched off. */
export type TeamInterval = { blId: string | null; from: Date; to: Date };

const BEGINNING = new Date(0);
const FOREVER = new Date(8.64e15);

export function teamIntervals(designer: DesignerNow, changes: TeamChange[]): TeamInterval[] {
  const own = changes.filter((c) => c.designerId === designer.id).sort((a, b) => a.at.getTime() - b.at.getTime());
  // A switched-off designer with no recorded switch-off: we cannot date when
  // they left, so they count for their BL's history but not for team size
  // (see membershipDays). Recorded switch-offs show up as toBlId null.
  const intervals: TeamInterval[] = [];
  let blId = own.length ? own[0].fromBlId : designer.blId;
  let from = BEGINNING;
  for (const c of own) {
    intervals.push({ blId, from, to: c.at });
    blId = c.toBlId;
    from = c.at;
  }
  intervals.push({ blId, from, to: FOREVER });
  return intervals;
}

export function blAt(intervals: TeamInterval[], at: Date): string | null {
  return intervals.find((i) => at >= i.from && at < i.to)?.blId ?? null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Share of the cycle (0–1) the designer spent in this BL's team. */
export function membershipShare(
  designer: DesignerNow, intervals: TeamInterval[], blId: string, cycle: { cycleStart: Date; cycleEnd: Date },
): number {
  const ownChanges = intervals.length > 1;
  if (!designer.isActive && !ownChanges) return 0;
  const length = cycle.cycleEnd.getTime() + 1 - cycle.cycleStart.getTime();
  let inTeam = 0;
  for (const i of intervals) {
    if (i.blId !== blId) continue;
    const from = Math.max(i.from.getTime(), cycle.cycleStart.getTime());
    const to = Math.min(i.to.getTime(), cycle.cycleEnd.getTime() + 1);
    if (to > from) inTeam += to - from;
  }
  // Whole days only, so a change made at 10 am does not produce 0.4166 designers.
  const days = Math.round(inTeam / DAY_MS);
  return days / Math.round(length / DAY_MS);
}

export async function loadTeamChanges(): Promise<TeamChange[]> {
  const logs = await prisma.activityLog.findMany({
    where: { action: TEAM_CHANGE_ACTION },
    select: { createdAt: true, meta: true },
    orderBy: { createdAt: 'asc' },
  });
  return logs.flatMap((log) => {
    const m = (log.meta ?? {}) as { designerId?: unknown; fromBlId?: unknown; toBlId?: unknown };
    if (typeof m.designerId !== 'string') return [];
    const id = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return [{ designerId: m.designerId, fromBlId: id(m.fromBlId), toBlId: id(m.toBlId), at: log.createdAt }];
  });
}

/** Call after any change to a user's BL, role or active flag. Records only real team changes of designers. */
export async function recordTeamChange(
  actorId: string,
  before: { id: string; role: string; blId: string | null; isActive: boolean },
  after: { role: string; blId: string | null; isActive: boolean },
) {
  const team = (u: { role: string; blId: string | null; isActive: boolean }) =>
    (u.role === 'DESIGNER' && u.isActive ? u.blId : null);
  const fromBlId = team(before);
  const toBlId = team(after);
  if (fromBlId === toBlId) return;
  await logActivity(actorId, TEAM_CHANGE_ACTION, undefined, { designerId: before.id, fromBlId, toBlId });
}
