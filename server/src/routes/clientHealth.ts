import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { detailsScore } from './dataQuality.js';
import { loadContactHealth } from '../lib/contactHealth.js';
import { getFormulas } from '../lib/formulaSettings.js';

const DETAIL_FIELDS = {
  email: true, source: true, projectType: true, scope: true, location: true, possessionTimeline: true,
  builder: true, intentRating: true, estimatedValue: true, expectedObDate: true, floorPlanUrl: true, stage: true, status: true,
} as const;
// Health = how complete the client's details are. >=80% Healthy, 50-79% At Risk, <50% Critical.
// Bands come from Admin → Formulas (Healthy 80%+, At Risk 50%+ by default).
const bucketOf = (pct: number, bands: { healthyFrom: number; atRiskFrom: number }): 'HEALTHY' | 'AT_RISK' | 'CRITICAL' =>
  (pct >= bands.healthyFrom ? 'HEALTHY' : pct >= bands.atRiskFrom ? 'AT_RISK' : 'CRITICAL');

/**
 * Designer "Client Health" drill-down. Returns every active client (no 30-row cap),
 * grouped Healthy / At Risk / Critical, so the dashboard tile and its own page
 * stay accurate at 100-150 leads. Population matches the dashboard tile:
 * pre-project leads (MQL..OBM) + active projects the designer owns / is approved on.
 */
export const clientHealthRouter = Router();

const PRE_PROJECT_STAGES = [
  'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING',
] as const;

type Bucket = 'HEALTHY' | 'AT_RISK' | 'CRITICAL';

clientHealthRouter.get('/', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const bands = (await getFormulas()).completeness;
    const bucketOfPct = (pct: number) => bucketOf(pct, bands);
    if (user.role !== 'DESIGNER') {
      res.status(403).json({ error: 'Client health is available to designers only' });
      return;
    }
    const approved = await prisma.projectTeamMember.findMany({
      where: { userId: user.id, status: 'APPROVED' },
      select: { projectId: true },
    });
    const ids = approved.map((a) => a.projectId);
    const projectWhere: Prisma.ProjectWhereInput = {
      ...(ids.length ? { OR: [{ designerId: user.id }, { id: { in: ids } }] } : { designerId: user.id }),
      phase: { notIn: ['COMPLETED'] },
    };

    const [leads, projects] = await Promise.all([
      prisma.lead.findMany({
        where: { assignedDesignerId: user.id, status: 'ACTIVE', isTestLead: false, stage: { in: [...PRE_PROJECT_STAGES] } },
        select: {
          id: true, leadId: true, name: true, ...DETAIL_FIELDS,
          slaBreaches: { where: { resolvedAt: null }, select: { id: true } },
          attentionFlags: { where: { resolvedAt: null }, select: { description: true } },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.project.findMany({
        where: projectWhere,
        select: {
          id: true, projectCode: true, health: true, phase: true,
          lead: { select: { id: true, leadId: true, name: true, isTestLead: true, ...DETAIL_FIELDS } },
          attentionFlags: { where: { resolvedAt: null }, select: { description: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const leadIds = [...leads.map((l) => l.id), ...projects.map((p) => p.lead.id)];
    const contacts = await loadContactHealth(leadIds);
    const contactOf = (lead: { id: string; status: string }) => {
      const contact = contacts.get(lead.id)!;
      return lead.status === 'ACTIVE' ? contact : {
        ...contact, status: 'UNKNOWN' as const, daysSinceContact: null,
        reason: 'Contact rating for non-active leads is pending agreed reactivation rules. Existing hold behaviour is unchanged.',
      };
    };
    const files = await prisma.leadFile.findMany({ where: { leadId: { in: leadIds } }, select: { leadId: true, fileType: true } });
    const filesBy = new Map<string, Set<string>>();
    for (const f of files) {
      const set = filesBy.get(f.leadId) ?? new Set<string>();
      set.add(f.fileType as string);
      filesBy.set(f.leadId, set);
    }
    const score = (l: any) => detailsScore(l, filesBy.get(l.id) ?? new Set());
    const reasonOf = (d: ReturnType<typeof detailsScore>) =>
      d.missing.length ? `${d.missing.length} detail(s) missing: ${d.missing.slice(0, 4).join(', ')}${d.missing.length > 4 ? '…' : ''}` : null;

    const items = [
      ...leads.map((l) => {
        const d = score(l);
        return {
          kind: 'LEAD' as const, id: l.id, leadDbId: l.id, leadId: l.leadId, clientName: l.name,
          stage: l.stage, health: bucketOfPct(d.pct), detailsPct: d.pct, missingDetails: d.missing,
          informationStatus: d.missing.length ? 'DATA_INCOMPLETE' : 'COMPLETE', contactHealth: contactOf(l),
          attentionCount: l.slaBreaches.length + l.attentionFlags.length, reason: reasonOf(d),
        };
      }),
      ...projects.filter((p) => !p.lead.isTestLead).map((p) => {
        const d = score(p.lead);
        return {
          kind: 'PROJECT' as const, id: p.id, leadDbId: p.lead.id, leadId: p.lead.leadId, clientName: p.lead.name,
          stage: p.phase as string, projectCode: p.projectCode, health: bucketOfPct(d.pct), detailsPct: d.pct,
          missingDetails: d.missing, attentionCount: p.attentionFlags.length, reason: reasonOf(d),
          informationStatus: d.missing.length ? 'DATA_INCOMPLETE' : 'COMPLETE', contactHealth: contactOf(p.lead),
        };
      }),
    ];
    const count = (b: Bucket) => items.filter((i) => i.health === b).length;
    res.json({
      counts: { total: items.length, healthy: count('HEALTHY'), atRisk: count('AT_RISK'), critical: count('CRITICAL') },
      contactCounts: {
        total: items.length,
        recent: items.filter((item) => item.contactHealth.status === 'RECENT').length,
        warning: items.filter((item) => item.contactHealth.status === 'WARNING').length,
        highRisk: items.filter((item) => item.contactHealth.status === 'HIGH_RISK').length,
        unknown: items.filter((item) => item.contactHealth.status === 'UNKNOWN').length,
      },
      items,
    });
  } catch (err: any) {
    console.error('[client-health]', err.message);
    res.status(500).json({ error: err.message });
  }
});
