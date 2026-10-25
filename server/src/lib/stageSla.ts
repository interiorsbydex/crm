import { prisma } from './prisma.js';
import {
  SALES_STAGE_SLA,
  computeStageSlaStatus,
  daysBetween,
  type SlaStatus,
  type StageSlaThreshold,
} from '../config/slaConfig.js';

const STAGE_SLA_CONFIG_KEY = 'stage_sla_thresholds';

/**
 * Effective stage SLA thresholds = hardcoded defaults (slaConfig.ts) with any
 * admin-edited overrides layered on top (task #14, GET/PATCH
 * /api/admin/stage-sla-config). Stored as a single JSON blob in the existing
 * key-value `AssignmentConfig` table rather than a new model.
 */
export async function getEffectiveStageSla(): Promise<Record<string, StageSlaThreshold>> {
  const row = await prisma.assignmentConfig.findUnique({ where: { key: STAGE_SLA_CONFIG_KEY } });
  const overrides = (row?.value as Record<string, Partial<StageSlaThreshold>> | undefined) ?? {};
  const effective: Record<string, StageSlaThreshold> = {};
  for (const [stage, def] of Object.entries(SALES_STAGE_SLA)) {
    effective[stage] = { ...def, ...(overrides[stage] ?? {}) };
  }
  return effective;
}

interface StageChangeMeta {
  from?: string;
  to?: string;
}

/**
 * Derive when a lead entered its CURRENT stage from its STAGE_CHANGED
 * activity log, walking chronologically forward. Falls back to the lead's
 * createdAt if it has never changed stage. Mirrors the reconstruction logic
 * used by GET /api/leads/:id/stage-history.
 */
function deriveCurrentStageEnteredAt(
  logs: { createdAt: Date; meta: unknown }[],
  leadCreatedAt: Date,
): Date {
  let enteredAt = leadCreatedAt;
  for (const log of logs) {
    const meta = log.meta as StageChangeMeta | null;
    if (meta?.to) enteredAt = log.createdAt;
  }
  return enteredAt;
}

export interface LeadSlaInfo {
  daysInCurrentStage: number;
  slaStatus: SlaStatus;
}

/**
 * Batch-compute `daysInCurrentStage` + `slaStatus` for a set of leads.
 * Returns a map keyed by lead id.
 */
export async function computeSlaInfoForLeads(
  leads: { id: string; stage: string; createdAt: Date }[],
): Promise<Record<string, LeadSlaInfo>> {
  const result: Record<string, LeadSlaInfo> = {};
  if (leads.length === 0) return result;

  const leadIds = leads.map((l) => l.id);
  const logs = await prisma.activityLog.findMany({
    where: { leadId: { in: leadIds }, action: 'STAGE_CHANGED' },
    orderBy: { createdAt: 'asc' },
    select: { leadId: true, createdAt: true, meta: true },
  });

  const logsByLead = new Map<string, { createdAt: Date; meta: unknown }[]>();
  for (const log of logs) {
    if (!log.leadId) continue;
    if (!logsByLead.has(log.leadId)) logsByLead.set(log.leadId, []);
    logsByLead.get(log.leadId)!.push({ createdAt: log.createdAt, meta: log.meta });
  }

  const thresholds = await getEffectiveStageSla();
  const now = new Date();
  for (const lead of leads) {
    const enteredAt = deriveCurrentStageEnteredAt(logsByLead.get(lead.id) ?? [], lead.createdAt);
    const daysInCurrentStage = daysBetween(enteredAt, now);
    result[lead.id] = {
      daysInCurrentStage,
      slaStatus: computeStageSlaStatus(lead.stage, daysInCurrentStage, thresholds),
    };
  }
  return result;
}

/** Convenience single-lead variant for detail endpoints. */
export async function computeSlaInfoForLead(lead: { id: string; stage: string; createdAt: Date }): Promise<LeadSlaInfo> {
  const map = await computeSlaInfoForLeads([lead]);
  return map[lead.id];
}
