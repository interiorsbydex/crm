import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { buildLeadRoleWhere } from '../lib/leadScope.js';

/**
 * Lenient-launch visibility (Batch 3):
 *  - GET /api/data-quality/bypasses     what the team moved past, who, when
 *  - GET /api/data-quality/completeness what is still blank on each lead, who owns it
 * Both are read-only and scoped to the leads the caller may already see.
 */
export const dataQualityRouter = Router();

const FUNNEL = [
  'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION',
  'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS',
] as const;
type Stage = (typeof FUNNEL)[number];

const stageIdx = (s: string) => FUNNEL.indexOf(s as Stage);
const DAY_MS = 86_400_000;

type OwnerRole = 'CRE' | 'DESIGNER_OR_BL';

interface Check {
  key: string;
  label: string;
  /** First funnel stage at which the item is expected to be filled. */
  from: Stage;
  /** Who is asked to fill it. CRE = qualification owner; otherwise the working owner. */
  owner: OwnerRole;
  kind: 'field' | 'file';
  field?: string;
  /** Alternative lead column that also counts as filled (e.g. floorPlanUrl for the floor-plan file). */
  altField?: string;
  fileTypes?: string[];
}

const QUOTES = ['QUOTATION', 'PR_QUOTATION', 'PP_QUOTATION', 'GENERATED_QUOTE', 'OB_QUOTE'];

export const COMPLETENESS_CHECKS: Check[] = [
  { key: 'email', label: 'Client email', from: 'MQL', owner: 'CRE', kind: 'field', field: 'email' },
  { key: 'source', label: 'Lead source', from: 'MQL', owner: 'CRE', kind: 'field', field: 'source' },
  { key: 'projectType', label: 'Project type', from: 'MQL', owner: 'CRE', kind: 'field', field: 'projectType' },
  { key: 'scope', label: 'Scope of work', from: 'MQL', owner: 'CRE', kind: 'field', field: 'scope' },
  { key: 'location', label: 'Location', from: 'MQL', owner: 'CRE', kind: 'field', field: 'location' },
  { key: 'possessionTimeline', label: 'Possession timeline', from: 'MQL', owner: 'CRE', kind: 'field', field: 'possessionTimeline' },
  { key: 'builder', label: 'Builder', from: 'MQL', owner: 'CRE', kind: 'field', field: 'builder' },
  { key: 'intentRating', label: 'Intent rating', from: 'MQL', owner: 'CRE', kind: 'field', field: 'intentRating' },
  { key: 'floorPlan', label: 'Floor plan / lifestyle capture file', from: 'DQL', owner: 'DESIGNER_OR_BL', kind: 'file', altField: 'floorPlanUrl', fileTypes: ['FLOOR_PLAN', 'LIFESTYLE_CAPTURE'] },
  { key: 'estimatedValue', label: 'Project value / budget', from: 'DQL', owner: 'DESIGNER_OR_BL', kind: 'field', field: 'estimatedValue' },
  { key: 'pitch', label: 'Pitch presentation file', from: 'PROPOSAL_READY', owner: 'DESIGNER_OR_BL', kind: 'file', fileTypes: ['PITCH_PRESENTATION', 'FINAL_PITCH_PRESENTATION'] },
  { key: 'quotation', label: 'Quotation file', from: 'PROPOSAL_READY', owner: 'DESIGNER_OR_BL', kind: 'file', fileTypes: QUOTES },
  { key: 'expectedObDate', label: 'Expected OB date', from: 'PROPOSAL_PRESENTED', owner: 'DESIGNER_OR_BL', kind: 'field', field: 'expectedObDate' },
  { key: 'paymentScreenshot', label: 'Payment screenshot', from: 'ONBOARDING', owner: 'DESIGNER_OR_BL', kind: 'file', fileTypes: ['PAYMENT_SCREENSHOT'] },
  { key: 'welcomeMailScreenshot', label: 'Client mail approval screenshot', from: 'ONBOARDING', owner: 'DESIGNER_OR_BL', kind: 'file', fileTypes: ['WELCOME_MAIL_SCREENSHOT'] },
];

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * Client "details" score (used by Client Health): share of the checks expected at the lead's
 * current stage that are filled. Later-than-funnel stages (e.g. HANDED_OVER) expect every check.
 */
export function detailsScore(
  lead: Record<string, unknown> & { stage: string },
  fileTypes: Set<string>,
): { expected: number; filled: number; pct: number; missing: string[] } {
  const idx = stageIdx(lead.stage);
  const expected = COMPLETENESS_CHECKS.filter((c) => idx < 0 || idx >= stageIdx(c.from));
  const missing = expected
    .filter((c) => !(c.kind === 'file' ? c.fileTypes!.some((t) => fileTypes.has(t)) || (!!c.altField && !isBlank(lead[c.altField])) : !isBlank(lead[c.field!])))
    .map((c) => c.label);
  const filled = expected.length - missing.length;
  return { expected: expected.length, filled, pct: expected.length ? Math.round((filled / expected.length) * 100) : 100, missing };
}

// ── GET /bypasses ─────────────────────────────────────────────────────────────
dataQualityRouter.get('/bypasses', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const { userId, stage, from, to, limit, includeTest } = req.query as Record<string, string | undefined>;
    const testFilter = includeTest === 'true' && ['ADMIN', 'BRANCH_HEAD'].includes(user.role) ? {} : { isTestLead: false };
    const scope = await buildLeadRoleWhere(user, prisma);

    const where: any = { action: 'GATE_BYPASSED', lead: { is: { ...testFilter, ...scope } } };
    if (userId) where.userId = userId;
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: new Date(`${from}T00:00:00+05:30`) } : {}),
        ...(to ? { lte: new Date(`${to}T23:59:59.999+05:30`) } : {}),
      };
    }

    const logs = await prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit ?? '2000') || 2000, 5000),
      include: {
        user: { select: { id: true, name: true, role: true } },
        lead: { select: { id: true, leadId: true, name: true, stage: true } },
      },
    });

    const rows = logs.flatMap((l) => {
      const m = (l.meta ?? {}) as { kind?: string; missing?: string[]; from?: string; to?: string };
      const stageAtBypass = m.to ?? l.lead?.stage ?? null;
      if (stage && stageAtBypass !== stage) return [];
      return (Array.isArray(m.missing) ? m.missing : []).map((item, i) => ({
        id: `${l.id}:${i}`,
        at: l.createdAt,
        item,
        kind: m.kind ?? null,
        fromStage: m.from ?? null,
        toStage: m.to ?? null,
        stage: stageAtBypass,
        by: l.user ? { id: l.user.id, name: l.user.name, role: l.user.role } : null,
        lead: l.lead ? { id: l.lead.id, leadId: l.lead.leadId, name: l.lead.name, currentStage: l.lead.stage } : null,
      }));
    });

    const byPerson = new Map<string, { id: string; name: string; role: string; count: number }>();
    for (const r of rows) {
      if (!r.by) continue;
      const e = byPerson.get(r.by.id) ?? { ...r.by, count: 0 };
      e.count++;
      byPerson.set(r.by.id, e);
    }
    res.json({
      rows,
      total: rows.length,
      byPerson: [...byPerson.values()].sort((a, b) => b.count - a.count),
    });
  } catch (err: any) {
    console.error('[data-quality:bypasses]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /completeness ─────────────────────────────────────────────────────────
dataQualityRouter.get('/completeness', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const { ownerId, stage, item, includeTest } = req.query as Record<string, string | undefined>;
    const testFilter = includeTest === 'true' && ['ADMIN', 'BRANCH_HEAD'].includes(user.role) ? {} : { isTestLead: false };
    const scope = await buildLeadRoleWhere(user, prisma);

    const leads = await prisma.lead.findMany({
      where: { ...testFilter, status: 'ACTIVE', stage: { in: [...FUNNEL] as any }, ...scope },
      select: {
        id: true, leadId: true, name: true, stage: true, createdAt: true, leadOriginDate: true,
        email: true, source: true, projectType: true, scope: true, location: true,
        possessionTimeline: true, builder: true, intentRating: true, estimatedValue: true,
        expectedObDate: true, floorPlanUrl: true, assignedCREId: true, assignedDesignerId: true, assignedBLId: true,
      },
    });
    const ids = leads.map((l) => l.id);

    const [files, stageLogs, users] = await Promise.all([
      prisma.leadFile.findMany({ where: { leadId: { in: ids } }, select: { leadId: true, fileType: true } }),
      prisma.activityLog.findMany({
        where: { leadId: { in: ids }, action: 'STAGE_CHANGED' },
        select: { leadId: true, meta: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.user.findMany({ select: { id: true, name: true, role: true } }),
    ]);

    const userMap = new Map(users.map((u) => [u.id, u]));
    const fileTypesByLead = new Map<string, Set<string>>();
    for (const f of files) {
      const s = fileTypesByLead.get(f.leadId) ?? new Set<string>();
      s.add(f.fileType as string);
      fileTypesByLead.set(f.leadId, s);
    }
    // First time each lead entered each stage (for "days outstanding").
    const firstEntry = new Map<string, Map<string, Date>>();
    for (const log of stageLogs) {
      const to = (log.meta as any)?.to as string | undefined;
      if (!log.leadId || !to) continue;
      const m = firstEntry.get(log.leadId) ?? new Map<string, Date>();
      if (!m.has(to)) m.set(to, log.createdAt);
      firstEntry.set(log.leadId, m);
    }

    const now = Date.now();
    const rows: any[] = [];
    for (const l of leads) {
      const idx = stageIdx(l.stage);
      const have = fileTypesByLead.get(l.id) ?? new Set<string>();
      for (const c of COMPLETENESS_CHECKS) {
        if (idx < stageIdx(c.from)) continue;
        const filled = c.kind === 'file'
          ? c.fileTypes!.some((t) => have.has(t)) || (!!c.altField && !isBlank((l as any)[c.altField]))
          : !isBlank((l as any)[c.field!]);
        if (filled) continue;

        const ownerId = c.owner === 'CRE'
          ? (l.assignedCREId ?? l.assignedDesignerId ?? l.assignedBLId)
          : (l.assignedDesignerId ?? l.assignedBLId ?? l.assignedCREId);
        const owner = ownerId ? userMap.get(ownerId) ?? null : null;
        const since =
          firstEntry.get(l.id)?.get(c.from) ?? (c.from === 'MQL' ? (l.leadOriginDate ?? l.createdAt) : l.createdAt);
        rows.push({
          id: `${l.id}:${c.key}`,
          lead: { id: l.id, leadId: l.leadId, name: l.name },
          stage: l.stage,
          itemKey: c.key,
          item: c.label,
          requiredFrom: c.from,
          owner: owner ? { id: owner.id, name: owner.name, role: owner.role } : null,
          since,
          daysOutstanding: Math.max(0, Math.floor((now - new Date(since).getTime()) / DAY_MS)),
        });
      }
    }

    const filtered = rows.filter((r) =>
      (!ownerId || (ownerId === 'unassigned' ? !r.owner : r.owner?.id === ownerId))
      && (!stage || r.stage === stage)
      && (!item || r.itemKey === item));
    filtered.sort((a, b) => b.daysOutstanding - a.daysOutstanding);

    const byOwner = new Map<string, { id: string | null; name: string; role: string | null; count: number; leads: Set<string> }>();
    for (const r of rows) {
      const k = r.owner?.id ?? 'unassigned';
      const e = byOwner.get(k) ?? { id: r.owner?.id ?? null, name: r.owner?.name ?? 'Unassigned', role: r.owner?.role ?? null, count: 0, leads: new Set<string>() };
      e.count++; e.leads.add(r.lead.id);
      byOwner.set(k, e);
    }

    res.json({
      rows: filtered,
      total: filtered.length,
      leadsChecked: leads.length,
      leadsWithGaps: new Set(rows.map((r) => r.lead.id)).size,
      byOwner: [...byOwner.values()].map((e) => ({ id: e.id, name: e.name, role: e.role, count: e.count, leads: e.leads.size })).sort((a, b) => b.count - a.count),
      items: COMPLETENESS_CHECKS.map((c) => ({ key: c.key, label: c.label })),
    });
  } catch (err: any) {
    console.error('[data-quality:completeness]', err.message);
    res.status(500).json({ error: err.message });
  }
});
