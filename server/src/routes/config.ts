import { Router } from 'express';
import { verifyToken } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import {
  DESIGN_PHASES,
} from '../config/slaConfig.js';
import { getEffectiveStageSla } from '../lib/stageSla.js';
import { isLenientLaunch } from '../lib/lenientMode.js';
import { getDocumentTypes } from '../lib/documentTypes.js';
import { dashboardLayoutsConfig } from '../lib/dashboardLayouts.js';
import { PERMISSIONS, hasPermission } from '../lib/permissions.js';
import { getCrmSettings, describeCycles } from '../lib/crmSettings.js';
import { DEFAULT_CYCLE_SCHEDULE } from '../lib/targetCycle.js';

export const configRouter = Router();

// ── GET /api/config/flags — feature flags the client mirrors ──────────────────
configRouter.get('/flags', verifyToken, (_req, res) => {
  res.json({ lenientLaunch: isLenientLaunch() });
});

// ── GET /api/config/crm-settings — lists and labels every screen uses (Admin → CRM Settings) ──
configRouter.get('/crm-settings', verifyToken, async (_req, res) => {
  try {
    const settings = await getCrmSettings();
    res.json({ settings, cycles: describeCycles(settings.cycleSchedule ?? DEFAULT_CYCLE_SCHEDULE) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/config/dashboards — tile layout every dashboard follows (Admin → Dashboards) ──
configRouter.get('/dashboards', verifyToken, async (_req, res) => {
  try {
    res.json({ layouts: await dashboardLayoutsConfig.get() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/config/my-permissions — what the signed-in user may do (Admin → Permissions) ──
configRouter.get('/my-permissions', verifyToken, async (req, res) => {
  try {
    const entries = await Promise.all(PERMISSIONS.map(async (p) => [p.key, await hasPermission(req.user!.role, p.key)] as const));
    res.json({ permissions: Object.fromEntries(entries) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/config/document-types — Files-tab upload types (Admin → Document Types) ──
configRouter.get('/document-types', verifyToken, async (_req, res) => {
  try {
    res.json({ types: await getDocumentTypes() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/config/offers — active offer options for lead offer dropdowns ────
// Bug fix (found in e2e testing after task #133): this used to read from the
// legacy OfferOption table (Task #75's simple admin-managed label list), but
// POST /leads/:leadId/offer — which actually applies the selection — looks up
// the id against the real `Offer` table (managed on the Settings page,
// server/src/routes/offers.ts). The two tables have disjoint id spaces, so
// every selection failed with "Offer not found". Source the dropdown from the
// same `Offer` table the apply endpoint validates against.
configRouter.get('/offers', verifyToken, async (_req, res) => {
  try {
    const offers = await prisma.offer.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    res.json({ offers: offers.map((o) => ({ id: o.id, label: o.name })) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/config/sla — SLA thresholds shared by client + server ────────────
// Single source of truth (task #56): the client must consume these values
// rather than hardcoding its own copies of the day thresholds.
configRouter.get('/sla', verifyToken, async (_req, res) => {
  try {
    const [salesStageThresholds, crm] = await Promise.all([getEffectiveStageSla(), getCrmSettings()]);
    res.json({
      salesStageThresholds,
      designPhases: DESIGN_PHASES.map((p) => ({ key: p.key, label: p.label })),
      designPhaseDefaultDays: crm.designPhaseDays,
      designOverallSlaDays: crm.designOverallDays,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
