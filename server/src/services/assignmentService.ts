import { getLeadRouting, type QualifiedLeadRouting } from '../lib/leadRouting.js';
/**
 * Assignment Service — smart or round-robin lead-to-designer assignment.
 *
 * Feature flag: SMART_ASSIGNMENT_ENABLED (env var, default false).
 * When enabled, filters designers by performanceTier based on lead.estimatedValue.
 *
 * Tier thresholds are stored in AssignmentConfig model:
 *   key "premium_threshold_value"  → leads with estimatedValue >= this go to PREMIUM tier
 *   key "standard_threshold_value" → leads with estimatedValue >= this go to STANDARD tier
 *   (else BASIC tier)
 */

import { prisma } from '../lib/prisma.js';

type Tier = 'BASIC' | 'STANDARD' | 'PREMIUM';

async function getConfig(): Promise<{ premiumThreshold: number; standardThreshold: number }> {
  const rows = await prisma.assignmentConfig.findMany({
    where: { key: { in: ['premium_threshold_value', 'standard_threshold_value'] } },
  });
  const map: Record<string, number> = {};
  for (const r of rows) map[r.key] = Number((r.value as any));
  return {
    premiumThreshold: map['premium_threshold_value'] ?? 2000000,  // 20L default
    standardThreshold: map['standard_threshold_value'] ?? 500000, // 5L default
  };
}

function pickTierForLead(estimatedValue: number | null, config: ReturnType<typeof getConfig> extends Promise<infer T> ? T : never): Tier {
  if (estimatedValue == null) return 'BASIC';
  if (estimatedValue >= config.premiumThreshold) return 'PREMIUM';
  if (estimatedValue >= config.standardThreshold) return 'STANDARD';
  return 'BASIC';
}

/**
 * Returns the next designer to assign within a BL's team.
 * Respects SMART_ASSIGNMENT_ENABLED feature flag.
 */
export async function assignLeadToDesigner(
  leadEstimatedValue: number | null,
  blId: string,
): Promise<string | null> {
  const smartEnabled = process.env.SMART_ASSIGNMENT_ENABLED === 'true';

  let whereFilter: any = { blId, isActive: true, role: { in: ['DESIGNER', 'CRE'] } };

  if (smartEnabled) {
    const config = await getConfig();
    const tier = pickTierForLead(leadEstimatedValue, config);
    whereFilter.performanceTier = tier;
  }

  const designers = await prisma.user.findMany({
    where: whereFilter,
    select: { id: true, totalLeadsAssigned: true },
    orderBy: { totalLeadsAssigned: 'asc' }, // round-robin within tier
  });

  // If smart assignment filtered out all designers, fall back to any active designer
  if (designers.length === 0 && smartEnabled) {
    const fallback = await prisma.user.findFirst({
      where: { blId, isActive: true, role: { in: ['DESIGNER', 'CRE'] } },
      select: { id: true },
      orderBy: { totalLeadsAssigned: 'asc' },
    });
    return fallback?.id ?? null;
  }

  return designers[0]?.id ?? null;
}

/**
 * Returns the BL with the fewest assigned leads (round-robin across BLs).
 * Used when a CRE moves a lead to MQL and no BL is yet assigned.
 */
export async function selectBLForLead(): Promise<{ id: string } | null> {
  return prisma.user.findFirst({
    where: { role: 'BL', isActive: true },
    select: { id: true },
    orderBy: [{ totalLeadsAssigned: 'asc' }, { id: 'asc' }],
  });
}

/**
 * Returns the CRE with the fewest assigned leads (round-robin across CREs).
 * Used to route freshly-captured ad leads to a CRE for qualification before
 * they ever reach a Business Lead.
 */
export async function selectCREForLead(): Promise<{ id: string; name: string } | null> {
  const cres = await prisma.user.findMany({
    where: { role: 'CRE', isActive: true },
    select: { id: true, name: true, totalLeadsAssigned: true },
    orderBy: { totalLeadsAssigned: 'asc' },
  });
  return cres[0] ?? null;
}

/**
 * Increment totalLeadsAssigned for a user atomically.
 * Call after assigning a lead to a designer.
 */
export async function incrementAssigned(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { totalLeadsAssigned: { increment: 1 } },
  }).catch((e) => console.warn('[assignment] increment failed:', e.message));
}

/**
 * Where a lead from ads / agency / import goes first (Admin → Lead Routing & Access):
 * the next CRE in turn, or nobody (it waits to be allocated).
 */
export async function routeAdLead(): Promise<{ id: string; name: string } | null> {
  return (await getLeadRouting()).adLeads === 'CRE' ? selectCREForLead() : null;
}

/**
 * Who gets a lead once it is qualified (Admin → Lead Routing & Access): the next
 * BL in turn, optionally plus the next designer in that BL's team, or nobody.
 * `mode` lets callers tell "nobody, by choice" apart from "no BL available".
 */
export async function routeQualifiedLead(estimatedValue: number | null): Promise<{ mode: QualifiedLeadRouting; blId: string | null; designerId: string | null }> {
  const mode = (await getLeadRouting()).qualifiedLeads;
  if (mode === 'MANUAL') return { mode, blId: null, designerId: null };
  const bl = await selectBLForLead();
  if (!bl) return { mode, blId: null, designerId: null };
  const designerId = mode === 'BL_THEN_DESIGNER' ? await assignLeadToDesigner(estimatedValue, bl.id) : null;
  return { mode, blId: bl.id, designerId };
}
