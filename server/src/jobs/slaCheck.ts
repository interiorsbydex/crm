import { Worker, Queue } from 'bullmq';
import { connection } from './index.js';
import { prisma } from '../lib/prisma.js';
import { createNotification } from '../lib/notifications.js';
import { logActivity } from '../lib/activityLog.js';

const QUEUE_NAME = 'sla-engine';

export const slaQueue = new Queue(QUEUE_NAME, { connection });

const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID ?? 'system';

async function resolveSystemUserId(): Promise<string> {
  if (SYSTEM_USER_ID !== 'system') return SYSTEM_USER_ID;
  const bh = await prisma.user.findFirst({ where: { role: 'BRANCH_HEAD', isActive: true }, select: { id: true } });
  return bh?.id ?? SYSTEM_USER_ID;
}

// ── Default thresholds (used when SLAConfig row is missing) ───────────────────
const DEFAULT_THRESHOLDS: Record<string, number> = {
  FIRST_CONTACT_24H: 24,
  LEAD_TO_MQL_5D: 120,
  MQL_TO_DQL_5D: 120,
  PROPOSAL_TO_PP_2D: 48,
};

// ── Load thresholds from DB (auto-seed defaults if missing) ───────────────────
async function loadThresholds(): Promise<Record<string, number>> {
  const configs = await prisma.sLAConfig.findMany();
  // Seed any missing defaults
  const missing = Object.entries(DEFAULT_THRESHOLDS).filter(
    ([rule]) => !configs.some((c) => c.rule === rule),
  );
  if (missing.length > 0) {
    await prisma.sLAConfig.createMany({
      data: missing.map(([rule, thresholdHours]) => ({ rule, thresholdHours })),
      skipDuplicates: true,
    });
  }
  const all = await prisma.sLAConfig.findMany();
  const map: Record<string, number> = {};
  for (const c of all) map[c.rule] = c.thresholdHours;
  return { ...DEFAULT_THRESHOLDS, ...map };
}

// ── Core logic — callable directly for on-demand triggers ─────────────────────
export async function runSLACheck(): Promise<{ totalBreaches: number; details: string[] }> {
  console.log('[sla] Running SLA check…');
  let totalBreaches = 0;
  const details: string[] = [];
  const systemUserId = await resolveSystemUserId();

  // Load configurable thresholds from DB
  const thresholds = await loadThresholds();

  const SLA_RULES = [
    {
      rule: 'FIRST_CONTACT',
      label: 'First call within 24 hours',
      check: async () => {
        const cutoff = new Date(Date.now() - thresholds.FIRST_CONTACT_24H * 60 * 60 * 1000);
        return prisma.lead.findMany({
          where: {
            createdAt: { lt: cutoff },
            calls: { none: {} },
            // DESIGN_IN_PROGRESS is the funnel's terminal stage (task #53) —
            // a lead that has already reached it is done, not overdue.
            status: 'ACTIVE',
            stage: { notIn: ['HANDED_OVER', 'DESIGN_IN_PROGRESS'] },
            isSLABreached: false,
          },
          select: { id: true, leadId: true, assignedBLId: true, assignedDesignerId: true },
        });
      },
    },
    {
      // EFFECTIVE_LEAD→MQL is off-funnel for new leads (which are created
      // directly at MQL as of task #53) — this rule only ever fires for
      // pre-restructure leads still sitting in the legacy EL stage, catching
      // ones that were never advanced into the active funnel.
      rule: 'LEAD_TO_MQL',
      label: 'Move to MQL within 5 days (legacy Effective Lead cleanup)',
      check: async () => {
        const cutoff = new Date(Date.now() - thresholds.LEAD_TO_MQL_5D * 60 * 60 * 1000);
        return prisma.lead.findMany({
          where: {
            stage: 'EFFECTIVE_LEAD',
            updatedAt: { lt: cutoff },
            isSLABreached: false,
          },
          select: { id: true, leadId: true, assignedBLId: true, assignedDesignerId: true },
        });
      },
    },
    {
      rule: 'MQL_TO_DQL',
      label: 'Schedule DQL within 5 days of MQL',
      check: async () => {
        const cutoff = new Date(Date.now() - thresholds.MQL_TO_DQL_5D * 60 * 60 * 1000);
        return prisma.lead.findMany({
          where: {
            stage: 'MQL',
            updatedAt: { lt: cutoff },
            meetings: { none: { type: 'DQL' } },
            isSLABreached: false,
          },
          select: { id: true, leadId: true, assignedBLId: true, assignedDesignerId: true },
        });
      },
    },
    {
      rule: 'PROPOSAL_TO_PP',
      label: 'Schedule PP within 2 days of Proposal Ready',
      check: async () => {
        const cutoff = new Date(Date.now() - thresholds.PROPOSAL_TO_PP_2D * 60 * 60 * 1000);
        return prisma.lead.findMany({
          where: {
            stage: 'PROPOSAL_READY',
            updatedAt: { lt: cutoff },
            meetings: { none: { type: 'PP' } },
            isSLABreached: false,
          },
          select: { id: true, leadId: true, assignedBLId: true, assignedDesignerId: true },
        });
      },
    },
  ];

  for (const { rule, label, check } of SLA_RULES) {
    const breachedLeads = await check();

    for (const lead of breachedLeads) {
      const existing = await prisma.sLABreach.findFirst({
        where: { leadId: lead.id, rule, resolvedAt: null },
      });
      if (existing) continue;

      await prisma.sLABreach.create({
        data: { leadId: lead.id, rule },
      });

      await prisma.lead.update({
        where: { id: lead.id },
        data: { isSLABreached: true },
      });

      const message = `SLA breach: "${label}" for lead ${lead.leadId}`;

      if (lead.assignedBLId) {
        await createNotification(lead.assignedBLId, 'SLA_BREACH', message, lead.id);
      }

      const branchHeads = await prisma.user.findMany({
        where: { role: 'BRANCH_HEAD', isActive: true },
        select: { id: true },
      });
      for (const bh of branchHeads) {
        await createNotification(bh.id, 'SLA_BREACH', message, lead.id);
      }

      await logActivity(systemUserId, 'SLA_BREACH', lead.id, { rule, label });
      details.push(`${lead.leadId}: ${rule}`);
      totalBreaches++;
    }
  }

  console.log(`[sla] Done. ${totalBreaches} new breach(es) created.`);
  return { totalBreaches, details };
}

// ── Schedule hourly job ───────────────────────────────────────────────────────
export async function scheduleSLACheck() {
  await slaQueue.add(
    'hourly-sla-check',
    {},
    {
      repeat: { pattern: '0 * * * *' }, // every hour at :00
      jobId: 'sla-check-singleton',
    },
  );
  console.log('[jobs] Hourly SLA check scheduled (0 * * * *)');
}

// ── SLA worker ────────────────────────────────────────────────────────────────
export const slaWorker = new Worker(
  QUEUE_NAME,
  async () => { await runSLACheck(); },
  { connection },
);
